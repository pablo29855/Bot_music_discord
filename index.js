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
const { getTracks, getPreview } = require('spotify-url-info')(fetch);
const NodeCache = require('node-cache');
const { spawn } = require('child_process');
const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const globalLogs = [];
const logLimit = 100;
function addLog(type, args) {
    const message = args.map(a => {
        if (a instanceof Error) return a.stack || a.message;
        return typeof a === 'object' ? JSON.stringify(a) : String(a);
    }).join(' ');
    const timestamp = new Date().toLocaleTimeString('es-ES', { hour12: false });
    globalLogs.push(`[${timestamp}] [${type}] ${message}`);
    if (globalLogs.length > logLimit) globalLogs.shift();
}

const originalLog = console.log;
const originalError = console.error;

console.log = function(...args) { addLog('INFO', args); originalLog.apply(console, args); };
console.error = function(...args) { addLog('ERROR', args); originalError.apply(console, args); };

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

// Spotify API official token is no longer used due to 2026 Developer Policy changes blocking Playlist reads for App Tokens.
async function initSpotify() {
    console.log("INFO: Spotify Web API Node descartado en favor de Scanner (spotify-url-info) debido a bloqueos 403 de Spotify.");
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
    try {
        // Obtenemos los tracks mediante scraping web nativo gracias a spotify-url-info
        // (Esto saltea por completo el Error 403 Forbidden de las APIs Oficiales).
        const spTracks = await getTracks(url);
        
        for (const t of spTracks) {
            if (!t) break;
            const titleStr = t.name ? t.name : '';
            const artistStr = (t.artists && t.artists[0]) ? t.artists[0].name : '';
            
            tracks.push({
                title: `${titleStr} - ${artistStr}`,
                query: `${titleStr} ${artistStr}`,
                url: t.external_urls?.spotify || url,
                isLazy: true
            });
        }
    } catch (e) {
        console.error("Scanner fallback failed:", e.message);
        throw e;
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
    try {
        const serverQueue = queue.get(guildId);
        if (!serverQueue || !song) return;

        if (serverQueue.currentFFmpeg) {
            serverQueue.currentFFmpeg.kill('SIGKILL');
            serverQueue.currentFFmpeg = null;
        }

        let streamUrl = null;

        if (song.isLazy) {
            const ytSong = await searchYouTube(song.query);
            if (ytSong) {
                streamUrl = await getStreamURL(ytSong.url);
                song.url = ytSong.url; // Refresh to Youtube URL
                song.isLazy = false;
            }
        } else {
            streamUrl = await getStreamURL(song.url);
        }

        if (!streamUrl) {
            console.log(`WARN: No se pudo obtener stream para ${song.title}. Saltando...`);
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
    } catch (err) {
        console.error("CRITICAL error en playSong:", err.message);
    }
}

client.once('ready', async () => {
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
            try {
                const tracks = await getSpotifyTracks(query);
                for (const t of tracks) {
                    songsToAdd.push(t);
                }
            } catch (err) {
                console.error("Error obteniendo Spotify (probablemente una lista Privada o Token vencido):", err.message);
                return interaction.followUp("❌ No pudimos acceder a este enlace de Spotify. ¿Es posible que la Playlist sea privada?");
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

            interaction.followUp(`➕ Añadido ${songsToAdd.length} canción(es) a la cola. ${songsToAdd.length === 100 ? '(Nota: Spotify restringe nuevas apps a 100 max)' : ''}`);
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
app.use(express.static(path.join(__dirname, 'dashboard')));

app.get('/api/status', (req, res) => {
    try {
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
                nextSongs: q.songs.slice(1, 4).map(s => s ? s.title : 'Unknown') 
            };
        });

        res.json({
            botName: client.user ? client.user.tag : 'Bot iniciando...',
            botAvatar: client.user ? client.user.displayAvatarURL() : '',
            ping: client.ws ? client.ws.ping : 0,
            totalGuilds: client.guilds.cache ? client.guilds.cache.size : 0,
            activeStreams: activeStreams
        });
    } catch (err) {
        console.error("Dashboard API Error:", err.stack);
        res.status(500).json({ error: 'Internal Dashboard Error' });
    }
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

app.get('/api/logs', (req, res) => {
    res.json(globalLogs);
});

app.post('/api/shutdown', (req, res) => {
    res.json({ message: 'El bot se está apagando...' });
    console.log('Recibida señal de apagado desde el Dashboard.');
    setTimeout(() => process.exit(0), 1000);
});

app.listen(3000, () => {
    console.log('🌐 Dashboard API corriendo en http://localhost:3000/api/status');
});
// ----------------------

client.login(TOKEN);