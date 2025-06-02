const { Client, GatewayIntentBits, PermissionsBitField } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const ytdl = require('@distube/ytdl-core');
const ytSearch = require('yt-search');
const SpotifyWebApi = require('spotify-web-api-node');
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
const IDLE_TIMEOUT = 30 * 60 * 1000; // 30 minutos en milisegundos
const MAX_CONCURRENT_SEARCHES = 10; // Límite de búsquedas concurrentes en YouTube

// Configurar Spotify API
const spotifyApi = new SpotifyWebApi({
    clientId: process.env.SPOTIFY_CLIENT_ID,
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET
});

// Obtener token de acceso para Spotify
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

// Obtener todas las canciones de una lista de reproducción con paginación paralela
async function getAllPlaylistTracks(playlistId) {
    try {
        const playlistInfo = await spotifyApi.getPlaylist(playlistId, { fields: 'tracks(total)' });
        const totalTracks = playlistInfo.body.tracks.total;
        const limit = 100;
        const pages = Math.ceil(totalTracks / limit);

        const pagePromises = [];
        for (let offset = 0; offset < totalTracks; offset += limit) {
            pagePromises.push(spotifyApi.getPlaylistTracks(playlistId, { offset, limit }));
        }

        const responses = await Promise.all(pagePromises);
        const tracks = responses.flatMap(response => response.body.items);
        return tracks;
    } catch (error) {
        console.error(`Error al obtener canciones de la lista ${playlistId}:`, error);
        if (error.statusCode === 404) {
            throw new Error('Lista de reproducción no encontrada o no accesible. Verifica que la URL sea correcta y que la lista sea pública.');
        }
        throw error;
    }
}

// Buscar una canción en YouTube
async function searchYouTube(query) {
    try {
        const searchResults = await ytSearch(query);
        if (searchResults.videos.length) {
            return { title: searchResults.videos[0].title, url: searchResults.videos[0].url };
        }
        return null;
    } catch (error) {
        console.error(`Error al buscar en YouTube: ${query}`, error);
        return null;
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

            let songs = [];
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
                            return interaction.followUp({ content: 'No se encontraron resultados en YouTube para la canción de Spotify.', ephemeral: true });
                        }
                        songs = [song];
                    } else if (songQuery.includes('playlist/')) {
                        const playlistIdMatch = songQuery.match(/playlist\/([a-zA-Z0-9]+)/);
                        if (!playlistIdMatch) throw new Error('URL de lista de reproducción de Spotify inválida.');
                        const playlistId = playlistIdMatch[1];
                        console.log(`Procesando lista de Spotify con ID: ${playlistId}`);
                        const tracks = await getAllPlaylistTracks(playlistId);
                        if (!tracks.length) {
                            return interaction.followUp({ content: 'No se encontraron canciones en la lista de reproducción de Spotify.', ephemeral: true });
                        }

                        const searchPromises = [];
                        for (let i = 0; i < tracks.length; i += MAX_CONCURRENT_SEARCHES) {
                            const batch = tracks.slice(i, i + MAX_CONCURRENT_SEARCHES).map(item => {
                                if (item.track && item.track.name && item.track.artists.length) {
                                    const searchQuery = `${item.track.name} ${item.track.artists[0].name}`;
                                    return searchYouTube(searchQuery);
                                }
                                return Promise.resolve(null);
                            });
                            const batchResults = await Promise.all(batch);
                            songs.push(...batchResults.filter(song => song));
                        }

                        if (!songs.length) {
                            return interaction.followUp({ content: 'No se encontraron equivalentes en YouTube para las canciones de la lista de reproducción.', ephemeral: true });
                        }
                    } else {
                        throw new Error('URL de Spotify no reconocida. Usa una URL de canción o lista de reproducción.');
                    }
                } else if (ytdl.validateURL(songQuery)) {
                    if (songQuery.includes('list=')) {
                        const playlistInfo = await ytdl.getInfo(songQuery);
                        const playlistVideos = playlistInfo.related_videos || [];
                        if (!playlistVideos.length) {
                            return interaction.followUp({ content: 'No se encontraron videos en la lista de reproducción de YouTube.', ephemeral: true });
                        }
                        songs = playlistVideos
                            .filter(video => video && video.id && video.title)
                            .map(video => ({
                                title: video.title,
                                url: `https://www.youtube.com/watch?v=${video.id}`
                            }));
                    } else {
                        const info = await ytdl.getInfo(songQuery);
                        songs = [{ title: info.videoDetails.title, url: songQuery }];
                    }
                } else {
                    const searchResults = await ytSearch(songQuery);
                    if (!searchResults.videos.length) {
                        return interaction.followUp({ content: 'No se encontraron resultados para tu búsqueda.', ephemeral: true });
                    }
                    const firstResult = searchResults.videos[0];
                    songs = [{ title: firstResult.title, url: firstResult.url }];
                }
            } catch (error) {
                console.error('Error al buscar la canción o lista de reproducción:', error);
                return interaction.followUp({ content: error.message || 'Hubo un error al buscar la canción o lista de reproducción.', ephemeral: true });
            }

            if (!serverQueue) {
                const queueConstruct = {
                    textChannel: channel,
                    voiceChannel: voiceChannel,
                    connection: null,
                    songs: [],
                    player: createAudioPlayer(),
                    idleTimeout: null
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
                    await playSong(guild, queueConstruct.songs[0]);
                    await interaction.followUp(`🎶 Reproduciendo: **${songs[0].title}**${songs.length > 1 ? ` (+${songs.length - 1} canciones de la lista)` : ''}`);
                } catch (error) {
                    console.error('Error al unirse al canal de voz:', error);
                    queue.delete(guild.id);
                    return interaction.followUp({ content: 'Hubo un error al unirme al canal de voz.', ephemeral: true });
                }
            } else {
                serverQueue.songs.push(...songs);
                if (serverQueue.player.state.status === AudioPlayerStatus.Idle) {
                    await playSong(guild, serverQueue.songs[0]);
                }
                if (serverQueue.idleTimeout) {
                    clearTimeout(serverQueue.idleTimeout);
                    serverQueue.idleTimeout = null;
                }
                await interaction.followUp(`🎵 ${songs.length > 1 ? `${songs.length} canciones añadidas a la cola desde la lista.` : `\`${songs[0].title}\` añadida a la cola.`}`);
            }
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
            await interaction.reply('⏹️ Música detenida y cola vaciada.');
        }

        if (commandName === 'queue') {
            if (!serverQueue || !serverQueue.songs.length) {
                return interaction.reply({ content: '📭 La cola está vacía.', ephemeral: true });
            }

            let queueMessage = '**📜 Cola de canciones:**\n';
            const maxDisplay = 10; // Mostrar hasta 10 canciones para evitar mensajes largos

            // Canción actual
            queueMessage += `🎵 **Ahora suena**: \`${serverQueue.songs[0].title}\`\n\n`;

            // Canciones siguientes
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

async function playSong(guild, song) {
    const serverQueue = queue.get(guild.id);
    if (!serverQueue) return;

    if (!song) {
        serverQueue.idleTimeout = setTimeout(() => {
            if (serverQueue.connection && serverQueue.connection.state.status !== 'destroyed') {
                serverQueue.connection.destroy();
            }
            queue.delete(guild.id);
            serverQueue.textChannel.send('👋 Bot desconectado tras 30 minutos de inactividad.');
        }, IDLE_TIMEOUT);
        return;
    }

    try {
        const stream = ytdl(song.url, {
            filter: 'audioonly',
            quality: 'highestaudio',
            highWaterMark: 1 << 26,
            requestOptions: {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                }
            },
            liveBuffer: 10000
        });

        stream.on('error', (error) => {
            console.error('Error en el stream:', error);
            serverQueue.textChannel.send('⚠️ Error al transmitir la canción. Pasando a la siguiente...');
            serverQueue.songs.shift();
            playSong(guild, serverQueue.songs[0]);
        });

        const resource = createAudioResource(stream, {
            inlineVolume: true,
            metadata: {
                title: song.title
            }
        });
        resource.volume.setVolume(1.0);
        serverQueue.player.play(resource);
        serverQueue.connection.subscribe(serverQueue.player);

        serverQueue.player.once(AudioPlayerStatus.Idle, () => {
            serverQueue.songs.shift();
            playSong(guild, serverQueue.songs[0]);
        });

        serverQueue.player.on('error', (error) => {
            console.error('Error en el reproductor:', error);
            serverQueue.textChannel.send(`⚠️ Error de reproducción: ${error.message}. Pasando a la siguiente...`);
            serverQueue.songs.shift();
            playSong(guild, serverQueue.songs[0]);
        });

        serverQueue.textChannel.send(`🎶 Reproduciendo: **${song.title}**`);
    } catch (error) {
        console.error('Error al reproducir la canción:', error);
        serverQueue.textChannel.send('⚠️ Error al procesar la canción. Pasando a la siguiente...');
        serverQueue.songs.shift();
        playSong(guild, serverQueue.songs[0]);
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
        serverQueue.textChannel.send('👋 El bot fue desconectado del canal de voz.');
    }
});

client.login(TOKEN).catch((error) => {
    console.error('❌ Error al iniciar sesión:', error);
    process.exit(1);
});