const { Client, GatewayIntentBits } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, getVoiceConnection, AudioPlayerStatus } = require('@discordjs/voice');
const ytdl = require('@distube/ytdl-core');
const ytSearch = require('yt-search'); // Importamos yt-search
require('dotenv').config();


const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.MessageContent,
    ],
});

const TOKEN = process.env.DISCORD_BOT_TOKEN;


// Creamos una cola para las canciones por servidor
const queue = new Map();

client.once('ready', () => {
    console.log(`Bot conectado como ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
    if (!message.content.startsWith('!play') || message.author.bot) return;

    const args = message.content.split(' ');
    const query = args.slice(1).join(' '); // Obtenemos todo lo que venga después de "!play"
    const voiceChannel = message.member.voice.channel;

    if (!voiceChannel) {
        return message.reply('¡Debes estar en un canal de voz para usar este comando!');
    }

    const permissions = voiceChannel.permissionsFor(message.client.user);
    if (!permissions.has('Connect') || !permissions.has('Speak')) {
        return message.reply('No tengo permisos para unirme y hablar en tu canal de voz.');
    }

    if (!query) {
        return message.reply('Por favor, proporciona el nombre de una canción o una URL de YouTube.');
    }

    let song;

    if (ytdl.validateURL(query)) {
        // Si es una URL válida de YouTube, no necesitamos buscar
        song = { title: query, url: query };
    } else {
        // Si no es una URL, buscamos la canción por su nombre
        const searchResults = await ytSearch(query);

        if (searchResults && searchResults.videos.length > 0) {
            const firstResult = searchResults.videos[0];
            song = { title: firstResult.title, url: firstResult.url };
        } else {
            return message.reply('No encontré resultados para tu búsqueda.');
        }
    }

    const serverQueue = queue.get(message.guild.id);

    if (!serverQueue) {
        // Si no existe una cola, creamos una
        const queueConstruct = {
            textChannel: message.channel,
            voiceChannel: voiceChannel,
            connection: null,
            songs: [],
            player: createAudioPlayer(),
        };

        queue.set(message.guild.id, queueConstruct);
        queueConstruct.songs.push(song);

        try {
            // Conectamos al canal de voz
            const connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: message.guild.id,
                adapterCreator: message.guild.voiceAdapterCreator,
            });

            queueConstruct.connection = connection;

            // Comenzamos a reproducir canciones
            playSong(message.guild, queueConstruct.songs[0]);
        } catch (error) {
            console.error('Error al unirse al canal de voz:', error);
            queue.delete(message.guild.id);
            return message.reply('Hubo un error al intentar unirme al canal de voz.');
        }
    } else {
        // Si ya existe una cola, añadimos la canción
        serverQueue.songs.push(song);
        return message.reply(`\`${song.title}\` ha sido añadida a la cola.`);
    }
});

client.on('messageCreate', async (message) => {
    if (!message.content.startsWith('!skip') || message.author.bot) return;

    const voiceChannel = message.member.voice.channel;

    if (!voiceChannel) {
        return message.reply('¡Debes estar en un canal de voz para usar este comando!');
    }

    const serverQueue = queue.get(message.guild.id);

    if (!serverQueue) {
        return message.reply('No hay canciones en la cola para saltar.');
    }

    // Verificamos si hay más canciones en la cola
    if (serverQueue.songs.length > 1) {
        serverQueue.player.stop(); // Esto activará el evento `AudioPlayerStatus.Idle` y saltará a la siguiente canción
        message.reply('⏭️ Canción saltada. Reproduciendo la siguiente en la cola.');
    } else {
        serverQueue.player.stop();
        serverQueue.connection.destroy(); // Desconecta el bot si no hay más canciones
        queue.delete(message.guild.id);
        message.reply('⏭️ Canción saltada. No hay más canciones en la cola.');
    }
});

function playSong(guild, song) {
    const serverQueue = queue.get(guild.id);

    if (!song) {
        serverQueue.connection.destroy();
        queue.delete(guild.id);
        return;
    }

    const stream = ytdl(song.url, {
        filter: 'audioonly',
        quality: 'highestaudio',
        highWaterMark: 1 << 25,
    });

    const resource = createAudioResource(stream);
    serverQueue.player.play(resource);

    serverQueue.connection.subscribe(serverQueue.player);

    serverQueue.textChannel.send(`🎶 Reproduciendo: **${song.title}**`);

    serverQueue.player.on(AudioPlayerStatus.Idle, () => {
        serverQueue.songs.shift();
        setTimeout(() => {
            playSong(guild, serverQueue.songs[0]);
        }, 3000); 
    });

    serverQueue.player.on('error', (error) => {
        console.error('Error en el reproductor:', error);
        if (serverQueue.songs.length > 1) {
            serverQueue.songs.shift();
            playSong(guild, serverQueue.songs[0]);
        } else {
            serverQueue.connection.destroy(); 
            queue.delete(guild.id);
        }
    });
    
}

client.on('messageCreate', async (message) => {
    if (!message.content.startsWith('!stop') || message.author.bot) return;

    const voiceChannel = message.member.voice.channel;

    if (!voiceChannel) {
        return message.reply('¡Debes estar en un canal de voz para usar este comando!');
    }

    const serverQueue = queue.get(message.guild.id);

    if (serverQueue) {
        serverQueue.songs = [];
        serverQueue.player.stop();
        serverQueue.connection.destroy();
        queue.delete(message.guild.id);
        message.reply('La música ha sido detenida y el bot ha sido desconectado del canal de voz.');
    } else {
        message.reply('No hay música en reproducción.');
    }
});

client.login(TOKEN);
