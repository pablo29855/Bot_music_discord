const { Client, GatewayIntentBits, PermissionsBitField } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
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
const MAX_CONCURRENT_SEARCHES = 10; // Límite de búsquedas simultáneas
const INITIAL_BATCH_SIZE = 10; // Lote inicial para playlists
const MAX_PLAYLIST_ITEMS = 50; // Límite de canciones por playlist
const CACHE_TTL = 3600; // 1 hora en segundos para caché

// Caché para resultados de yt-dlp y búsquedas de YouTube
const streamCache = new NodeCache({ stdTTL: CACHE_TTL, checkperiod: 600 });
const searchCache = new NodeCache({ stdTTL: CACHE_TTL, checkperiod: 600 });

// Configurar Spotify API
const spotifyApi = new SpotifyWebApi({
    clientId: process.env.SPOTIFY_CLIENT_ID,
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET
});

// Cola de tareas para procesar canciones en segundo plano
const taskQueue = new Map();

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

function removeDuplicates(songs) {
    const seen = new Set();
    return songs.filter(song => {
        if (seen.has(song.url)) return false;
        seen.add(song.url);
        return true;
    });
}

function runYTDLP(args, url) {
    return new Promise((resolve, reject) => {
        const ytdlp = spawn('yt-dlp', [...args, url], { shell: true });
        let output = '';
        let errorOutput = '';

        ytdlp.stdout.on('data', (data) => {
            output += data.toString();
        });

        ytdlp.stderr.on('data', (data) => {
            errorOutput += data.toString();
        });

        ytdlp.on('close', (code) => {
            if (code === 0) {
                resolve(output.trim());
            } else {
                reject(new Error(`yt-dlp falló con código ${code}: ${errorOutput}`));
            }
        });

        ytdlp.on('error', (error) => {
            reject(new Error(`Error al ejecutar yt-dlp: ${error.message}`));
        });
    });
}

async function getStreamURL(url) {
    const cacheKey = `stream:${url}`;
    if (streamCache.has(cacheKey)) {
        return streamCache.get(cacheKey);
    }
    try {
        const streamURL = await runYTDLP(['--no-warnings', '-f', 'bestaudio', '--get-url'], url);
        streamCache.set(cacheKey, streamURL);
        return streamURL;
    } catch (error) {
        console.error(`Error al obtener stream URL para ${url}:`, error);
        return null;
    }
}

async function getSongInfo(url) {
    const cacheKey = `info:${url}`;
    if (streamCache.has(cacheKey)) {
        return streamCache.get(cacheKey);
    }
    try {
        const isPlaylist = url.includes('list=') || url.includes('playlist?');
        const args = isPlaylist
            ? ['--no-warnings', '--dump-json', '--playlist-end', MAX_PLAYLIST_ITEMS.toString()]
            : ['--no-warnings', '--dump-json'];

        const output = await runYTDLP(args, url);
        const lines = output.split('\n').filter(line => line.trim());
        const infos = lines.map(line => {
            try {
                return JSON.parse(line);
            } catch (e) {
                console.error(`Error al parsear JSON para ${url}:`, e);
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
        console.error(`Error al obtener información para ${url}:`, error);
        return null;
    }
}

async function getSpotifyToken() {
    try {
        const data = await spotifyApi.clientCredentialsGrant();
        spotifyApi.setAccessToken(data.body['access_token']);
        return true;
    } catch (error) {
        console.error('Error al obtener token de Spotify:', error);
        return false;
    }
}

async function getAllPlaylistTracks(playlistId) {
    try {
        const playlistInfo = await spotifyApi.getPlaylist(playlistId, { fields: 'tracks(total)' });
        const totalTracks = Math.min(playlistInfo.body.tracks.total, MAX_PLAYLIST_ITEMS);
        const limit = 100;
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
        console.error(`Error al obtener canciones de la lista ${playlistId}:`, error);
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
        console.error(`Error al buscar en YouTube: ${query}`, error);
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
                textChannel.send(`🎵 Añadidas ${validSongs.length} canciones más a la cola desde la lista de Spotify.`);
            }
            if (serverQueue.songs.length === validSongs.length + 1) {
                preloadNextSong(guildId); // Preload para la primera canción añadida
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
        console.error(`Error al precargar stream para ${nextSong.url}:`, error);
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
        console.error(`Error al procesar tarea para guild ${guildId}:`, error);
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
        console.error('No se pudo iniciar la integración con Spotify. El bot seguirá funcionando para YouTube.');
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
                return interaction.reply({ content: '¡Debes estar en un canal de voz para usar este comando!', ephemeral: true });
            }

            const permissions = voiceChannel.permissionsFor(client.user);
            if (!permissions.has(PermissionsBitField.Flags.Connect) || !permissions.has(PermissionsBitField.Flags.Speak)) {
                return interaction.reply({ content: 'No tengo permisos para unirme o hablar en tu canal de voz.', ephemeral: true });
            }

            await interaction.deferReply();
            const songQuery = interaction.options.getString('cancion');
            if (!songQuery) {
                return interaction.followUp({ content: 'Debes proporcionar el nombre, URL de una canción o URL de una lista de reproducción.', ephemeral: true });
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
                        } else {
                            throw new Error('URL de Spotify no reconocida. Usa una URL de canción o lista de reproducción.');
                        }
                    } else if (songQuery.includes('youtube.com') || songQuery.includes('youtu.be')) {
                        const songInfo = await getSongInfo(songQuery);
                        if (!songInfo) {
                            throw new Error('No se encontraron resultados para la URL de YouTube.');
                        }
                        songs = songInfo;
                    } else {
                        const song = await searchYouTube(songQuery);
                        if (!song) {
                            throw new Error('No se encontraron resultados para tu búsqueda.');
                        }
                        songs = [song];
                    }
                } catch (error) {
                    console.error('Error al buscar la canción o lista de reproducción:', error);
                    await interaction.followUp({ content: error.message || 'Hubo un error al buscar la canción o lista de reproducción.', ephemeral: true });
                    return;
                }

                if (serverQueue) {
                    const existingURLs = new Set(serverQueue.songs.map(song => song.url));
                    songs = songs.filter(song => !existingURLs.has(song.url));
                }

                if (!songs.length) {
                    await interaction.followUp({ content: 'No se añadieron canciones nuevas (posiblemente duplicadas).', ephemeral: true });
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
                        connection.on('error', (error) => {
                            console.error('Error en la conexión de voz:', error);
                            queueConstruct.textChannel.send('⚠️ Error en la conexión de voz. Por favor, intenta de nuevo.');
                            queue.delete(guild.id);
                        });
                        await playSong(guild.id, queueConstruct.songs[0]);
                        await interaction.followUp(`🎶 Reproduciendo: **${songs[0].title}**${songs.length > 1 || isSpotifyPlaylist ? ` (+${songs.length - 1}${isSpotifyPlaylist && totalTracks > INITIAL_BATCH_SIZE ? ' y más en procesamiento' : ''} canciones de la lista)` : ''}`);
                    } catch (error) {
                        console.error('Error al unirse al canal de voz:', error);
                        queue.delete(guild.id);
                        await interaction.followUp({ content: 'Hubo un error al unirme al canal de voz.', ephemeral: true });
                    }
                } else {
                    serverQueue.songs.push(...songs);
                    if (serverQueue.player.state.status === AudioPlayerStatus.Idle) {
                        await playSong(guild.id, serverQueue.songs[0]);
                    } else {
                        preloadNextSong(guild.id);
                    }
                    if (serverQueue.idleTimeout) {
                        clearTimeout(serverQueue.idleTimeout);
                        serverQueue.idleTimeout = null;
                    }
                    await interaction.followUp(`🎵 ${songs.length > 1 || isSpotifyPlaylist ? `${songs.length} canciones añadidas a la cola${isSpotifyPlaylist && totalTracks > INITIAL_BATCH_SIZE ? ', procesando más en segundo plano.' : '.'}` : `\`${songs[0].title}\` añadida a la cola.`}`);
                }
            });
        }

        if (commandName === 'skip') {
            if (!serverQueue) {
                return interaction.reply({ content: 'No hay canciones en la cola para saltar.', ephemeral: true });
            }
            serverQueue.player.stop();
            await interaction.reply('⏭️ Canción saltada.');
        }

        if (commandName === 'stop') {
            if (!serverQueue) {
                return interaction.reply({ content: 'No hay música en reproducción.', ephemeral: true });
            }
            serverQueue.songs = [];
            serverQueue.player.stop();
            if (serverQueue.connection && serverQueue.connection.state.status !== 'destroyed') {
                serverQueue.connection.destroy();
            }
            if (serverQueue.idleTimeout) {
                clearTimeout(serverQueue.idleTimeout);
                serverQueue.idleTimeout = null;
            }
            queue.delete(guild.id);
            taskQueue.delete(guild.id);
            await interaction.reply('⏹️ Música detenida y cola vaciada.');
        }

        if (commandName === 'queue') {
            if (!serverQueue || !serverQueue.songs.length) {
                return interaction.reply({ content: '📭 La cola está vacía.', ephemeral: true });
            }

            let queueMessage = '**📜 Cola de canciones:**\n';
            const maxDisplay = 10;

            queueMessage += `🎵 **Ahora suena**: \`${serverQueue.songs[0].title}\`\n\n`;

            if (serverQueue.songs.length > 1) {
                queueMessage += '**Siguientes en la cola:**\n';
                for (let i = 1; i < Math.min(serverQueue.songs.length, maxDisplay + 1); i++) {
                    queueMessage += `${i}. \`${serverQueue.songs[i].title}\`\n`;
                }
                if (serverQueue.songs.length > maxDisplay + 1) {
                    queueMessage += `...y ${serverQueue.songs.length - maxDisplay - 1} canciones más.\n`;
                }
            }

            queueMessage += `\n**Total en la cola**: ${serverQueue.songs.length} canciones.`;
            await interaction.reply(queueMessage);
        }
    } catch (error) {
        console.error('Error en la interacción:', error);
        await interaction.reply({ content: 'Ocurrió un error inesperado.', ephemeral: true }).catch(console.error);
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
            serverQueue.textChannel.send('👋 Bot desconectado tras 30 minutos de inactividad.');
        }, IDLE_TIMEOUT);
        return;
    }

    try {
        const streamURL = serverQueue.preloadedStream && serverQueue.songs[0].url === song.url ? serverQueue.preloadedStream : await getStreamURL(song.url);
        serverQueue.preloadedStream = null; // Limpiar precarga
        if (!streamURL) {
            serverQueue.textChannel.send('⚠️ Error al obtener el stream de la canción. Pasando a la siguiente...');
            serverQueue.songs.shift();
            return playSong(guildId, serverQueue.songs[0]);
        }

        const resource = createAudioResource(streamURL, {
            inlineVolume: true,
            metadata: { title: song.title },
            inputType: 'opus',
            silencePaddingFrames: 5
        });
        resource.volume.setVolume(1.0);

        serverQueue.player.play(resource);
        serverQueue.connection.subscribe(serverQueue.player);

        serverQueue.player.once(AudioPlayerStatus.Idle, () => {
            console.log(`Canción terminada: ${song.title}`);
            serverQueue.songs.shift();
            playSong(guildId, serverQueue.songs[0]);
        });

        serverQueue.player.on('error', (error) => {
            console.error('Error en el reproductor:', error);
            serverQueue.textChannel.send(`⚠️ Error de reproducción: ${error.message}. Pasando a la siguiente...`);
            serverQueue.songs.shift();
            playSong(guildId, serverQueue.songs[0]);
        });

        serverQueue.textChannel.send(`🎶 Reproduciendo: **${song.title}**`);
        preloadNextSong(guildId); // Precargar la siguiente canción
    } catch (error) {
        console.error('Error al reproducir la canción:', error);
        serverQueue.textChannel.send('⚠️ Error al procesar la canción. Pasando a la siguiente...');
        serverQueue.songs.shift();
        playSong(guildId, serverQueue.songs[0]);
    }
}

client.on('voiceStateUpdate', (oldState, newState) => {
    const serverQueue = queue.get(oldState.guild.id);
    if (!serverQueue) return;

    if (oldState.channelId && !newState.channelId && newState.id === client.user.id) {
        if (serverQueue.idleTimeout) {
            clearTimeout(serverQueue.idleTimeout);
        }
        queue.delete(oldState.guild.id);
        taskQueue.delete(oldState.guild.id);
        serverQueue.textChannel.send('👋 El bot fue desconectado del canal de voz.');
    }
});

client.login(TOKEN).catch((error) => {
    console.error('❌ Error al iniciar sesión:', error);
    process.exit(1);
});