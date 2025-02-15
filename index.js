const { Client, GatewayIntentBits, PermissionsBitField, REST, Routes } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, getVoiceConnection, AudioPlayerStatus } = require('@discordjs/voice');
const ytdl = require('@distube/ytdl-core');
const ytSearch = require('yt-search');
require('dotenv').config();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates
    ],
});

const queue = new Map();
const TOKEN = process.env.DISCORD_BOT_TOKEN;

client.once('ready', () => {
    console.log(`✅ Bot conectado como ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isCommand()) return;

    const { commandName, options, guild, member, channel } = interaction;
    const voiceChannel = member.voice.channel;
    
    if (!voiceChannel) return interaction.reply({ content: '¡Debes estar en un canal de voz para usar este comando!', ephemeral: true });

    const permissions = voiceChannel.permissionsFor(client.user);
    if (!permissions.has(PermissionsBitField.Flags.Connect) || !permissions.has(PermissionsBitField.Flags.Speak)) {
        return interaction.reply({ content: 'No tengo permisos para unirme y hablar en tu canal de voz.', ephemeral: true });
    }

    const serverQueue = queue.get(guild.id);

    if (commandName === 'play') {
        const songQuery = options.getString('cancion');
        if (!songQuery) return interaction.reply({ content: 'Debes proporcionar el nombre o URL de una canción.', ephemeral: true });

        let song;
        if (ytdl.validateURL(songQuery)) {
            song = { title: songQuery, url: songQuery };
        } else {
            try {
                const searchResults = await ytSearch(songQuery);
                if (!searchResults.videos.length) return interaction.reply({ content: 'No encontré resultados para tu búsqueda.', ephemeral: true });
                const firstResult = searchResults.videos[0];
                song = { title: firstResult.title, url: firstResult.url };
            } catch (error) {
                console.error('Error en la búsqueda:', error);
                return interaction.reply({ content: 'Hubo un error al buscar la canción.', ephemeral: true });
            }
        }

        if (!serverQueue) {
            const queueConstruct = {
                textChannel: channel,
                voiceChannel: voiceChannel,
                connection: null,
                songs: [],
                player: createAudioPlayer(),
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
                playSong(guild, queueConstruct.songs[0]);
                return interaction.reply(`🎶 Reproduciendo: **${song.title}**`);
            } catch (error) {
                console.error('Error al unirse al canal de voz:', error);
                queue.delete(guild.id);
                return interaction.reply({ content: 'Hubo un error al intentar unirme al canal de voz.', ephemeral: true });
            }
        } else {
            serverQueue.songs.push(song);
            if (serverQueue.player.state.status === AudioPlayerStatus.Idle) {
                playSong(guild, serverQueue.songs[0]);
            }
            return interaction.reply(`🎵 \`${song.title}\` ha sido añadida a la cola.`);
        }
    }

    if (commandName === 'skip') {
        if (!serverQueue) return interaction.reply({ content: 'No hay canciones en la cola para saltar.', ephemeral: true });
        serverQueue.player.stop();
        return interaction.reply('⏭️ Canción saltada.');
    }

    if (commandName === 'stop') {
        if (serverQueue) {
            serverQueue.songs = [];
            serverQueue.player.stop();
            serverQueue.connection.destroy();
            queue.delete(guild.id);
            return interaction.reply('⏹️ Música detenida y bot desconectado.');
        }
        return interaction.reply({ content: 'No hay música en reproducción.', ephemeral: true });
    }
});

function playSong(guild, song) {
    const serverQueue = queue.get(guild.id);
    if (!serverQueue) return;

    if (!song) {
        if (!serverQueue.idleMessageSent) {
            serverQueue.textChannel.send('🎵 Esperando más canciones... Usa `/play` para agregar otra.');
            serverQueue.idleMessageSent = true;
        }
        return;
    }

    const stream = ytdl(song.url, {
        filter: 'audioonly',
        quality: 'highestaudio',
        highWaterMark: 1 << 26,
    });

    const resource = createAudioResource(stream);
    serverQueue.player.play(resource);
    serverQueue.connection.subscribe(serverQueue.player);
    serverQueue.textChannel.send(`🎶 Reproduciendo: **${song.title}**`);

    serverQueue.player.on(AudioPlayerStatus.Idle, () => {
        serverQueue.songs.shift();
        serverQueue.idleMessageSent = false; // Restablecer para la siguiente espera
        playSong(guild, serverQueue.songs[0]);
    });

    serverQueue.player.on('error', (error) => {
        console.error('Error en el reproductor:', error);
        serverQueue.songs.shift();
        serverQueue.idleMessageSent = false;
        playSong(guild, serverQueue.songs[0]);
    });
}

client.login(TOKEN);
