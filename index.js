const { Client, GatewayIntentBits, PermissionsBitField } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const ytdl = require('@distube/ytdl-core');
const ytSearch = require('yt-search');
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

client.once('ready', () => {
    console.log(`✅ Bot conectado como ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isCommand()) return;

    try {
        const { commandName, options, guild, member, channel } = interaction;
        const voiceChannel = member?.voice?.channel;

        if (!voiceChannel) {
            return interaction.reply({ content: '¡Debes estar en un canal de voz para usar este comando!', ephemeral: true });
        }

        const permissions = voiceChannel.permissionsFor(client.user);
        if (!permissions.has(PermissionsBitField.Flags.Connect) || !permissions.has(PermissionsBitField.Flags.Speak)) {
            return interaction.reply({ content: 'No tengo permisos para unirme o hablar en tu canal de voz.', ephemeral: true });
        }

        const serverQueue = queue.get(guild.id);

        if (commandName === 'play') {
            await interaction.deferReply();
            const songQuery = options.getString('cancion');
            if (!songQuery) {
                return interaction.followUp({ content: 'Debes proporcionar el nombre o URL de una canción.', ephemeral: true });
            }

            let song;
            try {
                if (ytdl.validateURL(songQuery)) {
                    const info = await ytdl.getInfo(songQuery);
                    song = { title: info.videoDetails.title, url: songQuery };
                } else {
                    const searchResults = await ytSearch(songQuery);
                    if (!searchResults.videos.length) {
                        return interaction.followUp({ content: 'No se encontraron resultados para tu búsqueda.', ephemeral: true });
                    }
                    const firstResult = searchResults.videos[0];
                    song = { title: firstResult.title, url: firstResult.url };
                }
            } catch (error) {
                console.error('Error al buscar la canción:', error);
                return interaction.followUp({ content: 'Hubo un error al buscar la canción.', ephemeral: true });
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
                queueConstruct.songs.push(song);

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
                    await interaction.followUp(`🎶 Reproduciendo: **${song.title}**`);
                } catch (error) {
                    console.error('Error al unirse al canal de voz:', error);
                    queue.delete(guild.id);
                    return interaction.followUp({ content: 'Hubo un error al unirme al canal de voz.', ephemeral: true });
                }
            } else {
                serverQueue.songs.push(song);
                if (serverQueue.player.state.status === AudioPlayerStatus.Idle) {
                    await playSong(guild, serverQueue.songs[0]);
                }
                // Limpiar cualquier temporizador de inactividad cuando se agrega una nueva canción
                if (serverQueue.idleTimeout) {
                    clearTimeout(serverQueue.idleTimeout);
                    serverQueue.idleTimeout = null;
                }
                await interaction.followUp(`🎵 \`${song.title}\` añadida a la cola.`);
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
    } catch (error) {
        console.error('Error en la interacción:', error);
        await interaction.reply({ content: 'Ocurrió un error inesperado.', ephemeral: true }).catch(console.error);
    }
});

async function playSong(guild, song) {
    const serverQueue = queue.get(guild.id);
    if (!serverQueue) return;

    if (!song) {
        // Establecer temporizador de inactividad en lugar de desconectar inmediatamente
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
            highWaterMark: 1 << 25,
            requestOptions: {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                }
            }
        });

        stream.on('error', (error) => {
            console.error('Error en el stream:', error);
            serverQueue.textChannel.send('⚠️ Error al transmitir la canción. Pasando a la siguiente...');
            serverQueue.songs.shift();
            playSong(guild, serverQueue.songs[0]);
        });

        const resource = createAudioResource(stream);
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

// Manejar desconexión del bot
client.on('voiceStateUpdate', (oldState, newState) => {
    const serverQueue = queue.get(oldState.guild.id);
    if (!serverQueue) return;

    // Verificar si el bot fue desconectado
    if (oldState.channelId && !newState.channelId && newState.id === client.user.id) {
        if (serverQueue.idleTimeout) {
            clearTimeout(serverQueue.idleTimeout);
        }
        queue.delete(oldState.guild.id);
        serverQueue.textChannel.send('👋 El bot fue desconectado del canal de voz.');
    }
});

// Manejar errores durante el inicio de sesión
client.login(TOKEN).catch((error) => {
    console.error('❌ Error al iniciar sesión:', error);
    process.exit(1);
});