const { Client, GatewayIntentBits, PermissionsBitField } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus } = require('@discordjs/voice');
const ytSearch = require('yt-search');
const SpotifyWebApi = require('spotify-web-api-node');
const { spawn } = require('child_process');
const NodeCache = require('node-cache');
require('dotenv').config();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ],
});

const queue = new Map();
const TOKEN = process.env.DISCORD_BOT_TOKEN;
const IDLE_TIMEOUT = 30 * 60 * 1000; // 30 minutos
const MAX_CONCURRENT_SEARCHES = 5; // Límite de búsquedas simultáneas
const INITIAL_BATCH_SIZE = 5; // Lote inicial para playlists
const MAX_PLAYLIST_ITEMS = 50; // Límite de canciones por playlist
const CACHE_TTL_STREAM = 3600; // 1 hora para streams
const CACHE_TTL_SEARCH = 24 * 3600; // 24 horas para búsquedas
const YTDLP_TIMEOUT = 30 * 1000; // 30 segundos de timeout para yt-dlp

// Caché optimizado
const streamCache = new NodeCache({ stdTTL: CACHE_TTL_STREAM, checkperiod: 600, maxKeys: 1000 });
const searchCache = new NodeCache({ stdTTL: CACHE_TTL_SEARCH, checkperiod: 600, maxKeys: 5000 });

// Configurar Spotify API
const spotifyApi = new SpotifyWebApi({
    clientId: process.env.SPOTIFY_CLIENT_ID,
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET
});

// Cola de tareas
const taskQueue = new Map();

// Normalizar títulos para comparar similitud
function normalizeTitle(title) {
    return title.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

// Calcular similitud entre dos títulos
function titleSimilarity(title1, title2) {
    const words1 = normalizeTitle(title1).split(' ');
    const words2 = normalizeTitle(title2).split(' ');
    const commonWords = words1.filter(word => words2.includes(word));
    return commonWords.length / Math.max(words1.length, words2.length);
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

function removeDuplicates(songs) {
    const seen = new Set();
    const uniqueSongs = [];
    for (const song of songs) {
        const normalizedTitle = normalizeTitle(song.title);
        if (!seen.has(song.url) && !uniqueSongs.some(s => titleSimilarity(normalizedTitle, normalizeTitle(s.title)) > 0.8)) {
            seen.add(song.url);
            uniqueSongs.push(song);
        }
    }
    return uniqueSongs;
}

function cleanYouTubeURL(url) {
    try {
        const urlObj = new URL(url);
        const cleanURL = `${urlObj.origin}${urlObj.pathname}?v=${urlObj.searchParams.get('v')}`;
        return cleanURL;
    } catch (error) {
        console.error(`Error al limpiar URL ${url}: ${error.message}`);
        return url;
    }
}

function getYouTubeIds(url) {
    try {
        const urlObj = new URL(url);
        return {
            videoId: urlObj.searchParams.get('v') || null,
            playlistId: urlObj.searchParams.get('list') || null
        };
    } catch (error) {
        console.error(`Error al extraer IDs de ${url}: ${error.message}`);
        return { videoId: null, playlistId: null };
    }
}

async function getRelatedSongs(videoTitle, limit = 5) {
    try {
        const searchResults = await ytSearch(videoTitle);
        if (searchResults.videos.length) {
            const normalizedTargetTitle = normalizeTitle(videoTitle);
            const songs = searchResults.videos
                .filter(video => {
                    const normalizedVideoTitle = normalizeTitle(video.title);
                    return !normalizedVideoTitle.includes('cover') &&
                           !normalizedVideoTitle.includes('remix') &&
                           !normalizedVideoTitle.includes('live') &&
                           titleSimilarity(normalizedVideoTitle, normalizedTargetTitle) < 0.8;
                })
                .slice(0, Math.min(limit, MAX_PLAYLIST_ITEMS))
                .map(video => ({
                    title: video.title,
                    url: video.url
                }));
            return removeDuplicates(shuffleArray(songs));
        }
        return [];
    } catch (error) {
        console.error(`Error al buscar canciones relacionadas para "${videoTitle}": ${error.message}`);
        return [];
    }
}

function runYTDLP(args, url) {
    return new Promise((resolve, reject) => {
        const ytdlp = spawn('yt-dlp', [...args, url], { shell: false });
        let output = '';
        let errorOutput = '';

        const timeout = setTimeout(() => {
            ytdlp.kill();
            reject(new Error('yt-dlp timeout después de 30 segundos'));
        }, YTDLP_TIMEOUT);

        ytdlp.stdout.on('data', (data) => {
            output += data.toString();
        });

        ytdlp.stderr.on('data', (data) => {
            errorOutput += data.toString();
        });

        ytdlp.on('close', (code) => {
            clearTimeout(timeout);
            if (code === 0) {
                resolve(output.trim());
            } else {
                reject(new Error(`yt-dlp falló con código ${code}: ${errorOutput}`));
            }
        });

        ytdlp.on('error', (error) => {
            clearTimeout(timeout);
            reject(new Error(`Error al ejecutar yt-dlp: ${error.message}`));
        });
    });
}

async function getStreamURL(url) {
    const cleanedURL = cleanYouTubeURL(url);
    const cacheKey = `stream:${cleanedURL}`;
    if (streamCache.has(cacheKey)) {
        return streamCache.get(cacheKey);
    }
    try {
        const streamURL = await runYTDLP([
            '--no-warnings',
            '-f', 'bestaudio[ext=opus]/bestaudio[acodec=opus]/bestaudio',
            '--no-playlist',
            '--get-url',
            '--http-chunk-size', '10M',
            '--retries', '3',
            '--retry-sleep', '5'
        ], cleanedURL);
        streamCache.set(cacheKey, streamURL);
        return streamURL;
    } catch (error) {
        console.error(`Error al obtener stream URL para ${cleanedURL}: ${error.message}`);
        return null;
    }
}

async function getSongInfo(url, isPlaylist = false) {
    const cleanedURL = isPlaylist ? url : cleanYouTubeURL(url);
    const cacheKey = `info:${cleanedURL}`;
    if (streamCache.has(cacheKey)) {
        return streamCache.get(cacheKey);
    }
    try {
        const args = isPlaylist
            ? ['--no-warnings', '--dump-json', '--playlist-end', MAX_PLAYLIST_ITEMS.toString()]
            : ['--no-warnings', '--no-playlist', '--dump-json'];

        const output = await runYTDLP(args, cleanedURL);
        const lines = output.split('\n').filter(line => line.trim());
        const infos = lines.map(line => {
            try {
                return JSON.parse(line);
            } catch (e) {
                console.error(`Error al parsear JSON para ${cleanedURL}: ${e.message}`);
                return null;
            }
        }).filter(info => info);

        if (infos.length === 0) {
            throw new Error('No se obtuvo información válida de yt-dlp');
        }

        let songs = infos.map(info => ({
            title: info.title || 'Canción sin título',
            url: info.webpage_url || `https://www.youtube.com/watch?v=${info.id}`
        }));

        if (isPlaylist) {
            songs = removeDuplicates(shuffleArray(songs));
        }

        streamCache.set(cacheKey, songs);
        return songs;
    } catch (error) {
        console.error(`Error al obtener información para ${cleanedURL}: ${error.message}`);
        return null;
    }
}

async function getSpotifyToken() {
    try {
        const data = await spotifyApi.clientCredentialsGrant();
        spotifyApi.setAccessToken(data.body['access_token']);
        return true;
    } catch (error) {
        console.error(`Error al obtener token de Spotify: ${error.message}`);
        return false;
    }
}

async function getAllPlaylistTracks(playlistId) {
    try {
        const playlistInfo = await spotifyApi.getPlaylist(playlistId, { fields: 'tracks(total)' });
        const totalTracks = Math.min(playlistInfo.body.tracks.total, MAX_PLAYLIST_ITEMS);
        const limit = 50;
        const pages = Math.ceil(totalTracks / limit);

        const pagePromises = [];
        for (let offset = 0; offset < totalTracks; offset += limit) {
            pagePromises.push(spotifyApi.getPlaylistTracks(playlistId, { offset, limit }));
        }

        const responses = await Promise.all(pagePromises);
        let tracks = responses.flatMap(response => response.body.items);
        tracks = tracks.slice(0, MAX_PLAYLIST_ITEMS);
        return shuffleArray(tracks);
    } catch (error) {
        console.error(`Error al obtener canciones de la lista ${playlistId}: ${error.message}`);
        if (error.statusCode === 404) {
            throw new Error('Lista de reproducción no encontrada o no accesible.');
        }
        throw error;
    }
}

async function searchYouTube(query) {
    const cacheKey = `search:${query}`;
    if (searchCache.has(cacheKey)) {
        return searchCache.get(cacheKey);
    }
    try {
        const searchResults = await ytSearch(query);
        if (searchResults.videos.length) {
            const song = { title: searchResults.videos[0].title, url: searchResults.videos[0].url };
            searchCache.set(cacheKey, song);
            return song;
        }
        return null;
    } catch (error) {
        console.error(`Error al buscar en YouTube: ${query}`, error.message);
        return null;
    }
}

async function processSpotifyPlaylistTracks(guildId, tracks, textChannel, startIndex = 0) {
    const serverQueue = queue.get(guildId);
    if (!serverQueue) return;

    for (let i = startIndex; i < tracks.length; i += MAX_CONCURRENT_SEARCHES) {
        const batch = tracks.slice(i, i + MAX_CONCURRENT_SEARCHES).map(item => {
            if (item.track && item.track.name && item.track.artists.length) {
                const searchQuery = `${item.track.name} ${item.track.artists[0].name}`;
                return searchYouTube(searchQuery);
            }
            return Promise.resolve(null);
        });
        const batchResults = await Promise.all(batch);
        let validSongs = batchResults.filter(song => song);
        validSongs = removeDuplicates(validSongs);
        if (validSongs.length) {
            serverQueue.songs.push(...validSongs);
            if (i >= INITIAL_BATCH_SIZE && validSongs.length) {
                textChannel.send(`🎉 **¡Más ritmo!** Se añadieron **${validSongs.length} canciones** a la cola desde tu lista de Spotify 🎧✨`);
            }
            if (serverQueue.songs.length <= 2) {
                preloadNextSong(guildId);
            }
        }
    }
}

async function preloadNextSong(guildId) {
    const serverQueue = queue.get(guildId);
    if (!serverQueue || serverQueue.songs.length < 2) return;

    const nextSong = serverQueue.songs[1];
    try {
        const streamURL = await getStreamURL(nextSong.url);
        if (streamURL) {
            serverQueue.preloadedStream = streamURL;
        }
    } catch (error) {
        console.error(`Error al precargar stream para ${nextSong.url}: ${error.message}`);
    }
}

function addTask(guildId, task) {
    if (!taskQueue.has(guildId)) {
        taskQueue.set(guildId, []);
    }
    taskQueue.get(guildId).push(task);
    if (taskQueue.get(guildId).length === 1) {
        processNextTask(guildId);
    }
}

async function processNextTask(guildId) {
    const tasks = taskQueue.get(guildId);
    if (!tasks || tasks.length === 0) return;

    const task = tasks[0];
    try {
        await task();
    } catch (error) {
        console.error(`Error al procesar tarea para guild ${guildId}: ${error.message}`);
    } finally {
        tasks.shift();
        if (tasks.length > 0) {
            processNextTask(guildId);
        } else {
            taskQueue.delete(guildId);
        }
    }
}

client.once('ready', async () => {
    console.log(`✅ Bot conectado como ${client.user.tag}`);
    const tokenSuccess = await getSpotifyToken();
    if (!tokenSuccess) {
        console.error(`No se pudo iniciar la integración con Spotify. El bot seguirá funcionando para YouTube.`);
    }
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isCommand()) return;

    try {
        const { commandName, guild, member, channel } = interaction;
        const voiceChannel = member?.voice?.channel;

        const serverQueue = queue.get(guild.id);

        if (commandName === 'play') {
            if (!voiceChannel) {
                return interaction.reply({ content: '🎤 **¡Ups!** Necesitas estar en un canal de voz para rockear con este comando 😎', ephemeral: true });
            }

            const permissions = voiceChannel.permissionsFor(client.user);
            if (!permissions.has(PermissionsBitField.Flags.Connect) || !permissions.has(PermissionsBitField.Flags.Speak)) {
                return interaction.reply({ content: '🚫 **¡Oh no!** No tengo permisos para unirme o hablar en tu canal de voz 😢', ephemeral: true });
            }

            await interaction.deferReply();
            const songQuery = interaction.options.getString('cancion');
            if (!songQuery) {
                return interaction.followUp({ content: '🔍 **¡Falta algo!** Escribe el nombre de una canción, una URL de YouTube o una lista de Spotify 🎶', ephemeral: true });
            }

            addTask(guild.id, async () => {
                let songs = [];
                let isSpotifyPlaylist = false;
                let totalTracks = 0;

                try {
                    if (songQuery.includes('spotify.com')) {
                        if (songQuery.includes('track/')) {
                            const trackId = songQuery.match(/track\/([a-zA-Z0-9]+)/)?.[1];
                            if (!trackId) throw new Error('URL de canción de Spotify inválida.');
                            const trackData = await spotifyApi.getTrack(trackId);
                            const track = trackData.body;
                            const searchQuery = `${track.name} ${track.artists[0].name}`;
                            const song = await searchYouTube(searchQuery);
                            if (!song) {
                                throw new Error('No se encontraron resultados en YouTube para la canción de Spotify.');
                            }
                            songs = [song];
                            await interaction.followUp(`🎵 **¡Listo para el show!** Reproduciendo: **${songs[0].title}** 🎤🔥`);
                        } else if (songQuery.includes('playlist/')) {
                            const playlistIdMatch = songQuery.match(/playlist\/([a-zA-Z0-9]+)/);
                            if (!playlistIdMatch) throw new Error('URL de lista de reproducción de Spotify inválida.');
                            const playlistId = playlistIdMatch[1];
                            console.log(`Procesando lista de Spotify con ID: ${playlistId}`);
                            const tracks = await getAllPlaylistTracks(playlistId);
                            if (!tracks.length) {
                                throw new Error('No se encontraron canciones en la lista de reproducción de Spotify.');
                            }
                            totalTracks = tracks.length;
                            isSpotifyPlaylist = true;

                            const initialBatch = tracks.slice(0, INITIAL_BATCH_SIZE).map(item => {
                                if (item.track && item.track.name && item.track.artists.length) {
                                    const searchQuery = `${item.track.name} ${item.track.artists[0].name}`;
                                    return searchYouTube(searchQuery);
                                }
                                return Promise.resolve(null);
                            });
                            const initialResults = await Promise.all(initialBatch);
                            songs = removeDuplicates(initialResults.filter(song => song));
                            if (!songs.length) {
                                throw new Error('No se encontraron equivalentes en YouTube para las canciones iniciales de la lista.');
                            }

                            if (tracks.length > INITIAL_BATCH_SIZE) {
                                addTask(guild.id, () => processSpotifyPlaylistTracks(guild.id, tracks, channel, INITIAL_BATCH_SIZE));
                            }
                            await interaction.followUp(`🎉 **¡Fiesta en marcha!** Reproduciendo **${songs.length} canciones** de tu lista de Spotify 🎧 ${isSpotifyPlaylist && totalTracks > INITIAL_BATCH_SIZE ? '¡Más por venir! ✨' : ''}`);
                        } else {
                            throw new Error('URL de Spotify no reconocida. Usa una URL de canción o lista de reproducción.');
                        }
                    } else if (songQuery.includes('youtube.com') || songQuery.includes('youtu.be')) {
                        const { videoId, playlistId } = getYouTubeIds(songQuery);
                        if (playlistId && playlistId.startsWith('RD')) {
                            // Ignorar listas dinámicas (RD) y reproducir solo la canción
                            if (!videoId) throw new Error('No se encontró un ID de video válido en la URL.');
                            const singleSongInfo = await getSongInfo(`https://www.youtube.com/watch?v=${videoId}`, false);
                            if (!singleSongInfo) {
                                throw new Error('No se pudo obtener información del video inicial.');
                            }
                            songs = singleSongInfo;
                            await interaction.followUp(`🎵 **¡A darle caña!** Reproduciendo solo: **${songs[0].title}** 🎸🔥`);
                        } else if (playlistId) {
                            // Procesar listas de reproducción estándar
                            const playlistURL = `https://www.youtube.com/playlist?list=${playlistId}`;
                            const songInfo = await getSongInfo(playlistURL, true);
                            if (!songInfo) {
                                throw new Error('No se encontraron resultados para la lista de reproducción de YouTube.');
                            }
                            songs = songInfo;
                            await interaction.followUp(`🎉 **¡Lista activada!** Reproduciendo **${songs.length} temazos** de tu lista de YouTube 📻✨`);
                        } else {
                            // Solo una canción
                            const songInfo = await getSongInfo(songQuery, false);
                            if (!songInfo) {
                                throw new Error('No se encontraron resultados para la URL de YouTube.');
                            }
                            songs = songInfo;
                            await interaction.followUp(`🎵 **¡A rockear!** Reproduciendo: **${songs[0].title}** 🎤🔥`);
                        }
                    } else {
                        const song = await searchYouTube(songQuery);
                        if (!song) {
                            throw new Error('No se encontraron resultados para tu búsqueda.');
                        }
                        songs = [song];
                        await interaction.followUp(`🎵 **¡Toma ritmo!** Reproduciendo: **${songs[0].title}** 🎧✨`);
                    }
                } catch (error) {
                    console.error(`Error al buscar la canción o lista de reproducción: ${error.message}`);
                    await interaction.followUp({ content: `😓 **¡Ups, algo salió mal!** ${error.message || 'No pude encontrar la canción o lista. Prueba con otra URL o búsqueda.'} 🔍`, ephemeral: true });
                    return;
                }

                if (serverQueue) {
                    const existingURLs = new Set(serverQueue.songs.map(song => song.url));
                    songs = songs.filter(song => !existingURLs.has(song.url));
                }

                if (!songs.length) {
                    await interaction.followUp({ content: '😢 **¡Vaya!** No se añadieron canciones nuevas, podrían estar duplicadas o no disponibles 😕', ephemeral: true });
                    return;
                }

                if (!serverQueue) {
                    const queueConstruct = {
                        textChannel: channel,
                        voiceChannel: voiceChannel,
                        connection: null,
                        songs: [],
                        player: createAudioPlayer({ behaviors: { noSubscriber: 'pause' } }),
                        idleTimeout: null,
                        preloadedStream: null
                    };
                    queue.set(guild.id, queueConstruct);
                    queueConstruct.songs.push(...songs);

                    try {
                        const connection = joinVoiceChannel({
                            channelId: voiceChannel.id,
                            guildId: guild.id,
                            adapterCreator: guild.voiceAdapterCreator,
                        });
                        queueConstruct.connection = connection;

                        connection.on(VoiceConnectionStatus.Disconnected, async () => {
                            try {
                                await Promise.race([
                                    connection.reconnect(),
                                    new Promise((_, reject) => setTimeout(() => reject(new Error('Reconexión fallida')), 5000))
                                ]);
                                console.log(`Reconectado al canal de voz en ${guild.id}`);
                            } catch {
                                connection.destroy();
                                queue.delete(guild.id);
                                channel.send('😿 **¡Nos desconectaron!** Usa **/play** para volver al escenario 🎤');
                            }
                        });

                        connection.on('error', (error) => {
                            console.error(`Error en la conexión de voz: ${error.message}`);
                            queueConstruct.textChannel.send('😓 **¡Problema técnico!** Error en la conexión de voz. ¡Intenta de nuevo! 🔧');
                            queue.delete(guild.id);
                        });

                        await playSong(guild.id, queueConstruct.songs[0]);
                        let message = `🎶 **¡Sonando ahora!** **${songs[0].title}** 🎸🔥`;
                        if (songs.length > 1 || isSpotifyPlaylist) {
                            message += ` (+**${songs.length - 1} temazos** en la lista`;
                            if (isSpotifyPlaylist && totalTracks > INITIAL_BATCH_SIZE) {
                                message += ', ¡y más por llegar! 🚀)';
                            } else {
                                message += ' 🎉)';
                            }
                        }
                        await interaction.followUp(message);
                    } catch (error) {
                        console.error(`Error al unirse al canal de voz: ${error.message}`);
                        queue.delete(guild.id);
                        await interaction.followUp({ content: '😵 **¡Algo falló!** No pude unirme al canal de voz. ¡Revisa y prueba otra vez! 🔧', ephemeral: true });
                    }
                } else {
                    serverQueue.songs.push(...songs);
                    if (serverQueue.player.state.status === AudioPlayerStatus.Idle) {
                        await playSong(guild.id, serverQueue.songs[0]);
                    } else if (serverQueue.songs.length <= 2) {
                        preloadNextSong(guild.id);
                    }
                    if (serverQueue.idleTimeout) {
                        clearTimeout(serverQueue.idleTimeout);
                        serverQueue.idleTimeout = null;
                    }
                    let message = '🎵 **¡Más música en camino!** ';
                    if (songs.length > 1 || isSpotifyPlaylist) {
                        message += `Se añadieron **${songs.length} temazos** a la cola 🎉`;
                        if (isSpotifyPlaylist && totalTracks > INITIAL_BATCH_SIZE) {
                            message += ', ¡y más se están preparando en segundo plano! 🚀';
                        } else {
                            message += '!';
                        }
                    } else {
                        message += `**${songs[0].title}** añadido a la cola 🎧✨`;
                    }
                    await interaction.followUp(message);
                }
            });
        } else if (commandName === 'skip') {
            if (!serverQueue) {
                return interaction.reply({ content: '😕 **¡No hay nada que saltar!** La cola está vacía 📭', ephemeral: true });
            }
            serverQueue.player.stop(true);
            if (serverQueue.connection) {
                serverQueue.connection.removeAllListeners('subscription');
                serverQueue.connection.subscribe(serverQueue.player);
            }
            await interaction.reply('⏭️ **¡Zas!** Canción saltada, ¡vamos con la siguiente! 🚀🎶');
        } else if (commandName === 'stop') {
            if (!serverQueue) {
                return interaction.reply({ content: '😴 **¡Sin música en el escenario!** No hay nada que detener 🎧', ephemeral: true });
            }
            serverQueue.songs = [];
            serverQueue.player.stop(true);
            if (serverQueue.connection && serverQueue.connection.state.status !== 'destroyed') {
                serverQueue.connection.destroy();
            }
            if (serverQueue.idleTimeout) {
                clearTimeout(serverQueue.idleTimeout);
                serverQueue.idleTimeout = null;
            }
            queue.delete(guild.id);
            taskQueue.delete(guild.id);
            await interaction.reply('⏹️ **¡Silencio en la sala!** La música se detuvo y la cola está vacía 😎👋');
        } else if (commandName === 'queue') {
            if (!serverQueue || !serverQueue.songs.length) {
                return interaction.reply({ content: '📭 **¡Cola vacía!** No hay canciones en la lista, ¡añade algo con /play! 🎵', ephemeral: true });
            }

            let queueMessage = '🎉 **¡Tu lista de reproducción!** 🎸\n\n';
            const maxDisplay = 10;

            queueMessage += `🎵 **Sonando ahora**: **${serverQueue.songs[0].title}** 🎤🔥\n\n`;

            if (serverQueue.songs.length > 1) {
                queueMessage += '**Próximos temazos:** 📜\n';
                for (let i = 1; i < Math.min(serverQueue.songs.length, maxDisplay + 1); i++) {
                    queueMessage += `**${i}.** 🎧 ${serverQueue.songs[i].title}\n`;
                }
                if (serverQueue.songs.length > maxDisplay + 1) {
                    queueMessage += `...y **${serverQueue.songs.length - maxDisplay - 1} temazos más** en la cola! 🎉\n`;
                }
            }

            queueMessage += `\n**Total en la cola**: **${serverQueue.songs.length} canciones** 🎶✨`;
            await interaction.reply(queueMessage);
        }
    } catch (error) {
        console.error(`Error en la interacción: ${error.message}`);
        await interaction.reply({ content: '😱 **¡Ay, ay, ay!** Algo salió mal, ¡intenta de nuevo por favor! 🔧', ephemeral: true }).catch(console.error);
    }
});

async function playSong(guildId, song) {
    const serverQueue = queue.get(guildId);
    if (!serverQueue) return;

    if (!song) {
        serverQueue.idleTimeout = setTimeout(() => {
            if (serverQueue.connection && serverQueue.connection.state.status !== 'destroyed') {
                serverQueue.connection.destroy();
            }
            queue.delete(guildId);
            taskQueue.delete(guildId);
            serverQueue.textChannel.send('😴 **¡Hora de descansar!** Me desconecté tras 30 minutos de silencio. ¡Vuelve a llamarme con /play! 👋🎶');
        }, IDLE_TIMEOUT);
        return;
    }

    try {
        serverQueue.player.stop(true);
        if (serverQueue.connection) {
            serverQueue.connection.removeAllListeners('subscription');
            serverQueue.connection.subscribe(serverQueue.player);
        }

        const streamURL = serverQueue.preloadedStream && serverQueue.songs[0].url === song.url ? serverQueue.preloadedStream : await getStreamURL(song.url);
        serverQueue.preloadedStream = null;
        if (!streamURL) {
            serverQueue.textChannel.send('😓 **¡Ups!** No pude cargar esta canción, ¡vamos con la siguiente! ⏭️');
            serverQueue.songs.shift();
            return playSong(guildId, serverQueue.songs[0]);
        }

        const resource = createAudioResource(streamURL, {
            inlineVolume: true,
            metadata: { title: song.title },
            inputType: 'opus',
            silencePaddingFrames: 5,
            bufferingTimeout: 1000
        });
        resource.volume.setVolume(1.0);

        await new Promise(resolve => setTimeout(resolve, 200));

        serverQueue.player.play(resource);

        serverQueue.player.once(AudioPlayerStatus.Idle, () => {
            console.log(`Canción terminada: ${song.title}`);
            serverQueue.songs.shift();
            playSong(guildId, serverQueue.songs[0]);
        });

        serverQueue.player.on('error', (error) => {
            console.error(`Error en el reproductor: ${error.message}`);
            serverQueue.textChannel.send(`😵 **¡Fallo en el escenario!** Error al reproducir: ${error.message}. ¡Pasamos a la siguiente! ⏭️`);
            serverQueue.songs.shift();
            playSong(guildId, serverQueue.songs[0]);
        });

        serverQueue.textChannel.send(`🎶 **¡Sonando ahora!** **${song.title}** 🎸🔥`);
        if (serverQueue.songs.length <= 2) {
            preloadNextSong(guildId);
        }
    } catch (error) {
        console.error(`Error al reproducir la canción: ${error.message}`);
        serverQueue.textChannel.send('😓 **¡Algo falló!** No pude reproducir esta canción, ¡vamos con la siguiente! ⏭️');
        serverQueue.songs.shift();
        playSong(guildId, serverQueue.songs[0]);
    }
}

client.on('error', (error) => {
    console.error(`Error en la conexión de voz del cliente: ${error.message}`);
});

client.on('voiceStateUpdate', (oldState, newState) => {
    const serverQueue = queue.get(oldState.guild.id);
    if (!serverQueue) return;

    if (oldState.channelId && !newState.channelId && newState.id === client.user.id) {
        if (serverQueue.idleTimeout) {
            clearTimeout(serverQueue.idleTimeout);
        }
        queue.delete(oldState.guild.id);
        taskQueue.delete(oldState.guild.id);
        serverQueue.textChannel.send('😿 **¡Me echaron del escenario!** Desconectado del canal de voz. ¡Vuelve a llamarme con /play! 🎤👋');
    }
});

client.login(TOKEN).catch((error) => {
    console.error(`❌ Error al iniciar sesión: ${error.message}`);
    process.exit(1);
});