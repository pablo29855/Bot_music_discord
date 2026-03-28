const API_URL = 'http://localhost:3000/api/status';
const ACTION_URL = 'http://localhost:3000/api/action';

async function fetchStatus() {
    try {
        const response = await fetch(API_URL);
        if (!response.ok) throw new Error('API Offline');
        const data = await response.json();
        updateDashboard(data);
    } catch (error) {
        console.error('Error fetching data:', error);
        document.getElementById('botName').innerText = 'Bot Desconectado';
        document.querySelector('.status-badge').innerHTML = '<i class="fas fa-circle status-icon" style="color: #ed4245;"></i> Offline';
        document.querySelector('.status-badge').style.color = '#ed4245';
        document.querySelector('.status-badge').style.background = 'rgba(237, 66, 69, 0.15)';
        document.getElementById('botPing').innerText = '-- ms';
        document.getElementById('botGuilds').innerText = '--';
        
        const container = document.getElementById('streamsContainer');
        container.innerHTML = `
            <div class="loading-state">
                <i class="fas fa-exclamation-triangle" style="color:#ed4245"></i>
                <p>No se pudo conectar con el bot. Asegúrate de que el bot esté funcionando y la API responda.</p>
            </div>
        `;
    }
}

async function sendAction(guildId, action) {
    try {
        const response = await fetch(`${ACTION_URL}/${guildId}/${action}`, { method: 'POST' });
        if (response.ok) {
            // Refrescar al instante para mostrar ui actualizada
            fetchStatus(); 
        }
    } catch (error) {
        console.error('Error enviando accion', error);
    }
}

function updateDashboard(data) {
    document.getElementById('botName').innerText = data.botName;
    if (data.botAvatar) {
        document.getElementById('botAvatar').src = data.botAvatar;
    }
    
    document.querySelector('.status-badge').innerHTML = '<i class="fas fa-circle status-icon"></i> Online';
    document.querySelector('.status-badge').style.color = '#2ecc71';
    document.querySelector('.status-badge').style.background = 'rgba(46, 204, 113, 0.15)';
    
    document.getElementById('botPing').innerText = `${data.ping} ms`;
    document.getElementById('botGuilds').innerText = data.totalGuilds;

    const container = document.getElementById('streamsContainer');
    
    if (data.activeStreams.length === 0) {
        container.innerHTML = `
            <div class="loading-state">
                <i class="fas fa-bed"></i>
                <p>El bot no está reproduciendo música en ningún servidor actualmente.</p>
            </div>
        `;
        return;
    }

    container.innerHTML = ''; // Limpiar contenedor principal
    const template = document.getElementById('streamTemplate');

    data.activeStreams.forEach(stream => {
        const clone = template.content.cloneNode(true);
        
        clone.querySelector('.guild-name').innerText = stream.guildName;
        clone.querySelector('.channel-name').innerText = stream.voiceChannel;
        
        if (stream.currentSong) {
            clone.querySelector('.track-title').innerText = stream.currentSong;
            clone.querySelector('.track-title').title = stream.currentSong;
            clone.querySelector('.track-url').href = stream.songUrl;
            
            if(stream.songUrl && stream.songUrl.includes('spotify')) {
                clone.querySelector('.track-icon i').className = 'fab fa-spotify';
                clone.querySelector('.track-icon').style.background = '#1DB954';
                clone.querySelector('.track-icon').style.boxShadow = '0 5px 15px rgba(29, 185, 84, 0.3)';
            }
        } else {
            clone.querySelector('.track-title').innerText = 'Cargando stream...';
            clone.querySelector('.track-url').style.display = 'none';
        }

        clone.querySelector('.queue-length').innerText = stream.queueLength;

        // Configurar botones de control
        const pauseBtn = clone.querySelector('.action-pause');
        const skipBtn = clone.querySelector('.action-skip');
        const stopBtn = clone.querySelector('.action-stop');

        // Lógica de Pause/Resume
        if (stream.isPaused) {
            pauseBtn.innerHTML = '<i class="fas fa-play"></i>';
            pauseBtn.onclick = () => sendAction(stream.guildId, 'resume');
            clone.querySelector('.now-playing-label').innerText = 'Pausado';
            clone.querySelector('.now-playing-label').style.color = '#fee75c';
        } else {
            pauseBtn.innerHTML = '<i class="fas fa-pause"></i>';
            pauseBtn.onclick = () => sendAction(stream.guildId, 'pause');
        }

        skipBtn.onclick = () => sendAction(stream.guildId, 'skip');
        stopBtn.onclick = () => sendAction(stream.guildId, 'stop');

        const ul = clone.querySelector('.upcoming-tracks');
        if (stream.nextSongs.length > 0) {
            stream.nextSongs.forEach(song => {
                const li = document.createElement('li');
                li.innerText = song.length > 50 ? song.substring(0, 47) + '...' : song;
                ul.appendChild(li);
            });
        } else {
             const li = document.createElement('li');
             li.innerText = 'No hay más canciones en la cola.';
             li.style.color = 'var(--text-muted)';
             li.style.background = 'transparent';
             li.style.padding = '0';
             li.style.setProperty('--bullet-display', 'none'); 
             ul.appendChild(li);
        }

        container.appendChild(clone);

        // Activar marquesina si el titulo es muy largo
        const addedCard = container.lastElementChild;
        if (addedCard) {
            const titleWrapper = addedCard.querySelector('.track-title-wrapper');
            const titleEl = addedCard.querySelector('.track-title');
            
            if (titleWrapper && titleEl && titleEl.scrollWidth > titleWrapper.clientWidth) {
                // Calcular la diferencia para animar
                const diff = titleEl.scrollWidth - titleWrapper.clientWidth + 50; 
                titleEl.style.setProperty('--scroll-dist', `-${diff}px`);
                titleEl.style.animation = `marquee 8s linear infinite alternate`;
            }
        }
    });
}

// Polling cada 3 segundos
setInterval(fetchStatus, 3000);
fetchStatus();

// --- Lógica del Sistema ---
const logsModal = document.getElementById('logsModal');
const btnLogs = document.getElementById('btnLogs');
const btnCloseLogs = document.getElementById('btnCloseLogs');
const logsContainer = document.getElementById('logsContainer');
let logsInterval = null;

btnLogs.addEventListener('click', () => {
    logsModal.classList.add('active');
    fetchLogs();
    logsInterval = setInterval(fetchLogs, 2000);
});

btnCloseLogs.addEventListener('click', () => {
    logsModal.classList.remove('active');
    clearInterval(logsInterval);
});

// Cerrar clickeando fuera del modal
logsModal.addEventListener('click', (e) => {
    if (e.target === logsModal) {
        logsModal.classList.remove('active');
        clearInterval(logsInterval);
    }
});

async function fetchLogs() {
    try {
        const res = await fetch('http://localhost:3000/api/logs');
        if (!res.ok) throw new Error('Cargando...');
        const logs = await res.json();
        
        logsContainer.innerHTML = '';
        if (logs.length === 0) {
            logsContainer.innerHTML = '<div class="log-line">No hay logs recientes...</div>';
            return;
        }

        logs.forEach(log => {
            const isError = log.includes('[ERROR]');
            const div = document.createElement('div');
            div.className = `log-line ${isError ? 'log-error' : 'log-info'}`;
            
            // Format Timestamp
            const logParts = log.match(/^(\[\d{2}:\d{2}:\d{2}\])(.*)/);
            if (logParts) {
                div.innerHTML = `<span class="log-timestamp">${logParts[1]}</span>${logParts[2]}`;
            } else {
                div.innerText = log;
            }
            logsContainer.appendChild(div);
        });

        // AutoScroll to bottom
        logsContainer.scrollTop = logsContainer.scrollHeight;

    } catch (err) {
        logsContainer.innerHTML = `<div class="log-line log-error">Error al conectar con la consola del Bot.</div>`;
    }
}

document.getElementById('btnShutdown').addEventListener('click', async () => {
    if(confirm("¿Estás seguro de que deseas apagar el bot por completo? (Tendrás que encenderlo manualmente desde Start_Bot.bat)")) {
        try {
            await fetch('http://localhost:3000/api/shutdown', { method: 'POST' });
            alert("El bot se ha apagado. Puedes cerrar esta ventana.");
            window.close(); // Intenta cerrar la pestaña
        } catch(e) {
            alert("Error enviando orden de apagado.");
        }
    }
});
