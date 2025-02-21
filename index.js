const { Client, GatewayIntentBits } = require("discord.js");
const { Player } = require("discord-player");
require("dotenv").config();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
    ],
});

// Configuración de Lavalink
const player = new Player(client, {
    connectionOptions: {
        host: "localhost",
        port: 2333,
        password: "youshallnotpass",
        secure: false
    }
});


client.player = player;

client.once("ready", () => {
    console.log(`✅ Bot conectado como ${client.user.tag}`);
});

client.on("interactionCreate", async (interaction) => {
    if (!interaction.isCommand()) return;

    const { commandName, options, guild, member } = interaction;
    const voiceChannel = member.voice.channel;

    if (!voiceChannel) return interaction.reply({ content: "¡Debes estar en un canal de voz para usar este comando!", ephemeral: true });

    if (commandName === "play") {
        const songQuery = options.getString("cancion");
        if (!songQuery) return interaction.reply({ content: "Debes proporcionar el nombre o URL de una canción.", ephemeral: true });

        const queue = client.player.nodes.create(guild, {
            metadata: { channel: interaction.channel }
        });

        if (!queue.connection) await queue.connect(voiceChannel);

        const searchResult = await client.player.search(songQuery, {
            requestedBy: interaction.user
        }).then(x => x.tracks[0]);

        if (!searchResult) return interaction.reply({ content: "No encontré resultados para tu búsqueda.", ephemeral: true });

        await queue.addTrack(searchResult);
        if (!queue.isPlaying()) await queue.play();

        return interaction.reply(`🎶 Reproduciendo: **${searchResult.title}**`);
    }

    if (commandName === "skip") {
        const queue = client.player.nodes.get(guild.id);
        if (!queue || !queue.currentTrack) return interaction.reply({ content: "No hay canciones en la cola para saltar.", ephemeral: true });

        await queue.node.skip();
        return interaction.reply("⏭️ Canción saltada.");
    }

    if (commandName === "stop") {
        const queue = client.player.nodes.get(guild.id);
        if (!queue) return interaction.reply({ content: "No hay música en reproducción.", ephemeral: true });

        queue.delete();
        return interaction.reply("⏹️ Música detenida y bot desconectado.");
    }
});

client.login(process.env.DISCORD_BOT_TOKEN);
