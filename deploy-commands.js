const { REST, Routes } = require('discord.js');
require('dotenv').config();

const commands = [
    {
        name: 'play',
        description: 'Reproduce una canción en tu canal de voz',
        options: [
            {
                name: 'cancion',
                type: 3,
                description: 'Nombre o URL de la canción',
                required: true
            }
        ]
    },
    {
        name: 'skip',
        description: 'Salta la canción actual'
    },
    {
        name: 'stop',
        description: 'Detiene la música y desconecta el bot'
    }
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);

(async () => {
    try {
        console.log('Registrando comandos slash...');
        await rest.put(
            Routes.applicationCommands(process.env.CLIENT_ID),
            { body: commands }
        );
        console.log('✅ ¡Comandos slash registrados correctamente!');
    } catch (error) {
        console.error('Error al registrar comandos:', error);
    }
})();
