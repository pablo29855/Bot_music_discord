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
const express = require('express');
const cors = require('cors');
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

async function initSpotify() {
    const data = await spotifyApi.clientCredentialsGrant();
    spotifyApi.setAccessToken(data.body['access_token']);
}

function isYouTubeURL(url) {
    return /(youtube\.com|youtu\.be)/.test(url);
}

function isSpotifyURL(url) {
    return /(open\.spotify\.com)/.test(url);
}

function createFFmpegStream(url) {
    const args = [
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        '-multiple_requests', '1',
        '-i', url,
        '-vn',
        '-loglevel', '0',
        '-acodec', 'pcm_s16le',
        '-ar', '48000',
        '-ac', '2',
        '-f', 's16le',
        '-b:a', '192k',
        '-bufsize', '4000k',
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

async function getSpotifyTracks(url) {
    const tracks = [];

    if (url.includes('/track/')) {
        const id = url.split('/track/')[1].split('?')[0];
        const track = await spotifyApi.getTrack(id);
        tracks.push(`${track.body.name} ${track.body.artists[0].name}`);
    }

    if (url.includes('/playlist/')) {
        const id = url.split('/playlist/')[1].split('?')[0];
        const data = await spotifyApi.getPlaylistTracks(id);

        for (const item of data.body.items) {
            const t = item.track;
            tracks.push(`${t.name} ${t.artists[0].name}`);
        }
    }

    return tracks;
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

client.once('clientReady', async () => {
    await initSpotify();
    console.log(`✅ Bot conectado como ${client.user.tag}`);
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, guild, member } = interaction;
    const voiceChannel = member.voice.channel;
    let serverQueue = queue.get(guild.id);

    if (commandName === 'play') {
        if (!voiceChannel)
            return interaction.reply({
                content: 'Debes estar en un canal de voz.',
                ephemeral: true
            });

        await interaction.deferReply();

        const query = interaction.options.getString('cancion');
        let songsToAdd = [];

        if (isYouTubeURL(query)) {
            try {
                const info = await youtubedl(query, { dumpSingleJson: true, noPlaylist: true, noWarnings: true });
                songsToAdd.push({ title: info.title || query, url: query });
            } catch {
                songsToAdd.push({ title: 'Youtube Link', url: query });
            }
        } else if (isSpotifyURL(query)) {
            const tracks = await getSpotifyTracks(query);
            for (const t of tracks) {
                const song = await searchYouTube(t);
                if (song) songsToAdd.push(song);
            }
        } else {
            const song = await searchYouTube(query);
            if (song) songsToAdd.push(song);
        }

        if (!songsToAdd.length)
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
                connection.destroy();
                return interaction.followUp("❌ No pude conectarme al canal de voz.");
            }

            connection.subscribe(player);

            const queueConstruct = {
                textChannel: interaction.channel,
                voiceChannel,
                connection,
                songs: songsToAdd,
                player,
                currentFFmpeg: null
            };

            queue.set(guild.id, queueConstruct);

            setupPlayer(guild.id, player);

            await playSong(guild.id, songsToAdd[0]);

            interaction.followUp(`🎶 Sonando: **${songsToAdd[0].title}**`);
        } else {
            for (const s of songsToAdd) {
                serverQueue.songs.push(s);
            }

            if (serverQueue.player.state.status === AudioPlayerStatus.Idle) {
                playSong(guild.id, serverQueue.songs[0]);
            }

            interaction.followUp(`➕ Añadido ${songsToAdd.length} canción(es) a la cola`);
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

// --- API DASHBOARD ---
const app = express();
app.use(cors());

app.get('/api/status', (req, res) => {
    const activeStreams = Array.from(queue.keys()).map(guildId => {
        const q = queue.get(guildId);
        const guild = client.guilds.cache.get(guildId);
        return {
            guildId: guildId,
            guildName: guild ? guild.name : 'Unknown Server',
            currentSong: q.songs[0] ? q.songs[0].title : null,
            songUrl: q.songs[0] ? q.songs[0].url : null,
            queueLength: q.songs.length > 0 ? q.songs.length - 1 : 0,
            voiceChannel: q.voiceChannel ? q.voiceChannel.name : 'Unknown Channel',
            isPaused: q.player ? q.player.state.status === AudioPlayerStatus.Paused : false,
            nextSongs: q.songs.slice(1, 4).map(s => s.title) // Hasta 3 canciones siguientes
        };
    });

    res.json({
        botName: client.user ? client.user.tag : 'Bot desconectado',
        botAvatar: client.user ? client.user.displayAvatarURL() : '',
        ping: client.ws.ping,
        totalGuilds: client.guilds.cache.size,
        activeStreams: activeStreams
    });
});

app.post('/api/action/:guildId/:action', (req, res) => {
    const { guildId, action } = req.params;
    const q = queue.get(guildId);

    if (!q) return res.status(404).json({ error: 'Queue not found' });

    try {
        if (action === 'pause') {
            q.player.pause();
        } else if (action === 'resume') {
            q.player.unpause();
        } else if (action === 'skip') {
            q.player.stop(); // Stop triggers idle, which plays next sonq
        } else if (action === 'stop') {
            q.connection.destroy();
            queue.delete(guildId);
        }
        res.json({ success: true, action });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(3000, () => {
    console.log('🌐 Dashboard API corriendo en http://localhost:3000/api/status');
});
// ----------------------

client.login(TOKEN);