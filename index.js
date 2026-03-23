const { Client, GatewayIntentBits } = require('discord.js');
const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    VoiceConnectionStatus,
    entersState,
    StreamType
} = require('@discordjs/voice');

const youtubedl = require('youtube-dl-exec');
const SpotifyWebApi = require('spotify-web-api-node');
const NodeCache = require('node-cache');
const { spawn } = require('child_process');
require('dotenv').config();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ],
});

const TOKEN = process.env.DISCORD_BOT_TOKEN;

const queue = new Map();
const IDLE_TIMEOUT = 30 * 60 * 1000;

const searchCache = new NodeCache({
    stdTTL: 86400,
    checkperiod: 600
});

const spotifyApi = new SpotifyWebApi({
    clientId: process.env.SPOTIFY_CLIENT_ID,
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET
});



function createFFmpegStream(url) {

    const args = [
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',

        '-i', url,

        '-vn',
        '-loglevel', '0',

        '-acodec', 'pcm_s16le',
        '-ar', '48000',
        '-ac', '2',

        '-f', 's16le',
        'pipe:1'
    ];

    const process = spawn('ffmpeg', args, {
        stdio: ['ignore', 'pipe', 'ignore']
    });

    return process;
}



async function getStreamURL(url) {

    try {

        const info = await youtubedl(url, {
            dumpSingleJson: true,
            format: 'bestaudio[acodec=opus]/bestaudio/best',
            noPlaylist: true,
            noWarnings: true
        });

        if (info.url) return info.url;

        const best = info.formats
            ?.filter(f => f.acodec !== 'none')
            ?.sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];

        return best?.url || null;

    } catch {

        return null;

    }

}



async function searchYouTube(query) {

    if (searchCache.has(query))
        return searchCache.get(query);

    const results = await youtubedl(`ytsearch1:${query}`, {
        dumpSingleJson: true,
        noWarnings: true,
        preferFreeFormats: true
    });

    if (results.entries?.length) {

        const video = results.entries[0];

        const song = {
            title: video.title,
            url: video.webpage_url
        };

        searchCache.set(query, song);

        return song;
    }

    return null;

}



function setupPlayer(guildId, player) {

    player.on(AudioPlayerStatus.Idle, () => {

        const serverQueue = queue.get(guildId);

        if (!serverQueue) return;

        if (serverQueue.currentFFmpeg) {

            serverQueue.currentFFmpeg.kill('SIGKILL');
            serverQueue.currentFFmpeg = null;

        }

        serverQueue.songs.shift();

        if (serverQueue.songs.length > 0) {

            playSong(guildId, serverQueue.songs[0]);

        } else {

            serverQueue.idleTimeout = setTimeout(() => {

                serverQueue.connection.destroy();
                queue.delete(guildId);

            }, IDLE_TIMEOUT);

        }

    });


    player.on('error', err => {

        console.error('Player error:', err.message);

    });

}



async function playSong(guildId, song) {

    const serverQueue = queue.get(guildId);

    if (!serverQueue || !song) return;

    if (serverQueue.currentFFmpeg) {

        serverQueue.currentFFmpeg.kill('SIGKILL');
        serverQueue.currentFFmpeg = null;

    }

    const streamUrl = await getStreamURL(song.url);

    if (!streamUrl) {

        serverQueue.songs.shift();
        return playSong(guildId, serverQueue.songs[0]);

    }

    const ffmpeg = createFFmpegStream(streamUrl);

    serverQueue.currentFFmpeg = ffmpeg;

    const resource = createAudioResource(ffmpeg.stdout, {
        inputType: StreamType.Raw,
        inlineVolume: true
    });

    resource.volume.setVolumeLogarithmic(1.0);

    serverQueue.player.play(resource);

}



client.once('clientReady', () => {

    console.log(`✅ Bot conectado como ${client.user.tag}`);

});



client.on('interactionCreate', async interaction => {

    if (!interaction.isChatInputCommand()) return;

    const { commandName, guild, member } = interaction;

    const voiceChannel = member.voice.channel;

    const serverQueue = queue.get(guild.id);



    if (commandName === 'play') {

        if (!voiceChannel)

            return interaction.reply({
                content: 'Debes estar en un canal de voz.',
                ephemeral: true
            });

        await interaction.deferReply();

        const query = interaction.options.getString('cancion');

        const song = await searchYouTube(query);

        if (!song)
            return interaction.followUp('No se encontró resultado.');



        if (!serverQueue) {

            const player = createAudioPlayer({
                behaviors: {
                    noSubscriber: 'play',
                    maxMissedFrames: 5
                }
            });

            const connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: guild.id,
                adapterCreator: guild.voiceAdapterCreator
            });

            try {

                await entersState(connection, VoiceConnectionStatus.Ready, 30000);

            } catch (error) {

                console.error("Error conectando al canal de voz:", error);

                connection.destroy();

                return interaction.followUp("❌ No pude conectarme al canal de voz.");

            }

            connection.subscribe(player);

            const queueConstruct = {

                textChannel: interaction.channel,
                voiceChannel,
                connection,
                songs: [song],
                player,
                currentFFmpeg: null

            };

            queue.set(guild.id, queueConstruct);

            setupPlayer(guild.id, player);

            await playSong(guild.id, song);

            interaction.followUp(`🎶 Sonando: **${song.title}**`);

        } else {

            serverQueue.songs.push(song);

            interaction.followUp(`➕ Añadido a la cola: **${song.title}**`);

        }

    }



    if (commandName === 'skip') {

        if (!serverQueue)
            return interaction.reply('Nada que saltar.');

        serverQueue.player.stop();

        interaction.reply('⏭ Saltado.');

    }



    if (commandName === 'stop') {

        if (!serverQueue)
            return interaction.reply('Nada que detener.');

        serverQueue.connection.destroy();

        queue.delete(guild.id);

        interaction.reply('⏹ Detenido.');

    }

});



client.login(TOKEN);