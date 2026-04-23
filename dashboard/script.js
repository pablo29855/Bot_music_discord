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

async function addSong(guildId, inputEl, wrapperEl) {
    const query = inputEl.value.trim();
    if (!query) return;

    // UI Feedback: Loading
    wrapperEl.classList.add('loading');
    inputEl.disabled = true;
    const btn = wrapperEl.querySelector('.btn-add-song');
    btn.disabled = true;

    try {
        const response = await fetch(`http://localhost:3000/api/play/${guildId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query })
        });

        const result = await response.json();

        if (response.ok) {
            inputEl.value = '';
            // Toast notify could be added here, but refreshing status is usually enough
            fetchStatus(); 
        } else {
            alert(result.error || 'Error al agregar canción');
        }
    } catch (error) {
        console.error('Error adding song:', error);
        alert('Error de conexión al agregar canción');
    } finally {
        wrapperEl.classList.remove('loading');
        inputEl.disabled = false;
        btn.disabled = false;
        inputEl.focus();
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

    // Limpiar mensaje de carga si existe
    if (container.querySelector('.loading-state')) {
        container.innerHTML = '';
    }

    const template = document.getElementById('streamTemplate');
    const existingCards = Array.from(container.querySelectorAll('.stream-card'));
    const activeGuildIds = data.activeStreams.map(s => s.guildId);

    // Eliminar tarjetas de servidores que ya no están activos
    existingCards.forEach(card => {
        if (!activeGuildIds.includes(card.dataset.guildId)) {
            card.remove();
        }
    });

    data.activeStreams.forEach(stream => {
        let card = container.querySelector(`.stream-card[data-guild-id="${stream.guildId}"]`);
        
        if (!card) {
            // Crear nueva tarjeta si no existe
            const clone = template.content.cloneNode(true);
            const cardInner = clone.querySelector('.stream-card');
            cardInner.dataset.guildId = stream.guildId;
            container.appendChild(clone);
            card = container.querySelector(`.stream-card[data-guild-id="${stream.guildId}"]`);
            
            // Bindings iniciales para la nueva tarjeta
            const pauseBtn = card.querySelector('.action-pause');
            const shuffleBtn = card.querySelector('.action-shuffle');
            const skipBtn = card.querySelector('.action-skip');
            const stopBtn = card.querySelector('.action-stop');
            const addBtn = card.querySelector('.btn-add-song');
            const addInput = card.querySelector('.add-song-input');
            const searchWrapper = card.querySelector('.search-input-wrapper');

            shuffleBtn.onclick = () => sendAction(stream.guildId, 'shuffle');
            skipBtn.onclick = () => sendAction(stream.guildId, 'skip');
            stopBtn.onclick = () => sendAction(stream.guildId, 'stop');
            addBtn.onclick = () => addSong(stream.guildId, addInput, searchWrapper);
            addInput.onkeypress = (e) => { if (e.key === 'Enter') addSong(stream.guildId, addInput, searchWrapper); };
        }

        // Actualizar contenido de la tarjeta existente o recién creada
        card.querySelector('.guild-name').innerText = stream.guildName;
        card.querySelector('.channel-name').innerText = stream.voiceChannel;
        
        const nowPlayingLabel = card.querySelector('.now-playing-label');
        const pauseBtn = card.querySelector('.action-pause');

        if (stream.isPaused) {
            pauseBtn.innerHTML = '<i class="fas fa-play"></i>';
            pauseBtn.onclick = () => sendAction(stream.guildId, 'resume');
            nowPlayingLabel.innerText = 'Pausado';
            nowPlayingLabel.style.color = '#fee75c';
        } else {
            pauseBtn.innerHTML = '<i class="fas fa-pause"></i>';
            pauseBtn.onclick = () => sendAction(stream.guildId, 'pause');
            nowPlayingLabel.innerText = 'Reproduciendo ahora';
            nowPlayingLabel.style.color = 'var(--text-muted)';
        }

        if (stream.currentSong) {
            const titleEl = card.querySelector('.track-title');
            const titleWrapper = card.querySelector('.track-title-wrapper');
            
            // Solo actualizar si el título cambió para no reiniciar la marquesina
            if (titleEl.innerText !== stream.currentSong) {
                titleEl.innerText = stream.currentSong;
                titleEl.title = stream.currentSong;
                card.querySelector('.track-url').href = stream.songUrl;
                card.querySelector('.track-url').style.display = 'block';

                if(stream.songUrl && stream.songUrl.includes('spotify')) {
                    card.querySelector('.track-icon i').className = 'fab fa-spotify';
                    card.querySelector('.track-icon').style.background = '#1DB954';
                    card.querySelector('.track-icon').style.boxShadow = '0 5px 15px rgba(29, 185, 84, 0.3)';
                } else {
                    card.querySelector('.track-icon i').className = 'fab fa-youtube';
                    card.querySelector('.track-icon').style.background = '#FF0000';
                    card.querySelector('.track-icon').style.boxShadow = '0 5px 15px rgba(255, 0, 0, 0.3)';
                }

                // Reiniciar marquesina si es necesario
                titleEl.style.animation = 'none';
                void titleEl.offsetWidth; // Force reflow
                if (titleEl.scrollWidth > titleWrapper.clientWidth) {
                    const diff = titleEl.scrollWidth - titleWrapper.clientWidth + 50; 
                    titleEl.style.setProperty('--scroll-dist', `-${diff}px`);
                    titleEl.style.animation = `marquee 8s linear infinite alternate`;
                }
            }
        }

        card.querySelector('.queue-length').innerText = stream.queueLength;

        const ul = card.querySelector('.upcoming-tracks');
        // Solo actualizar la cola si cambió (comparación simple de longitud o nombres)
        const currentNextSongs = Array.from(ul.querySelectorAll('li')).map(li => li.innerText);
        const newNextSongs = stream.nextSongs;

        if (JSON.stringify(currentNextSongs) !== JSON.stringify(newNextSongs)) {
            ul.innerHTML = '';
            if (newNextSongs.length > 0) {
                newNextSongs.forEach(song => {
                    const li = document.createElement('li');
                    li.innerText = song;
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
