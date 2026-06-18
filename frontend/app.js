/* ============================================================
   WORD DUEL — Frontend Application Logic
   ============================================================ */

// --- CONFIGURATION ---
// All paths match nginx.conf proxy rules:
//   /api/auth/      → login-service   (strips /api/auth prefix)
//   /api/users/     → user-service    (strips /api/users prefix)
//   /api/leaderboard/ → ranking-service
//   /api/matchmaking/ → matchmaking-service
const API_URL         = window.location.origin;
const AUTH_URL        = `${API_URL}/api/auth`;
const USER_URL        = `${API_URL}/api/users`;    // user-service root
const LEADERBOARD_URL = `${API_URL}/api/leaderboard`;
const MATCHMAKING_URL = `${API_URL}/api/matchmaking`;

// --- STATE ---
let currentUser      = null; // { token, userId, username, elo }
let activeSocket     = null;
let currentMatchId   = null;
let opponentUser     = null; // { userId, username, elo }
let currentRow       = 0;
let currentTile      = 0;
let gameActive       = false;
const MAX_GUESSES    = 6;
const WORD_LENGTH    = 5;

// --- ELO TIER UTILITY ---
function getEloTier(elo) {
    if (elo >= 2000) return '🏆 Grand Master';
    if (elo >= 1600) return '💎 Diamond';
    if (elo >= 1400) return '🥇 Gold';
    if (elo >= 1200) return '🥈 Silver';
    if (elo >= 1000) return '🔰 Beginner';
    return '🥉 Bronze';
}

// ============================================================
// DOM ELEMENT REFERENCES
// ============================================================
const loginScreen     = document.getElementById('login-screen');
const lobbyScreen     = document.getElementById('lobby-screen');
const gameScreen      = document.getElementById('game-screen');

const authForm        = document.getElementById('auth-form');
const authSubmitBtn   = document.getElementById('auth-submit-btn');
const tabLogin        = document.getElementById('tab-login');
const tabRegister     = document.getElementById('tab-register');
const authError       = document.getElementById('auth-error');

const lobbyUsername   = document.getElementById('lobby-username');
const lobbyElo        = document.getElementById('lobby-elo');
const lobbyTier       = document.getElementById('lobby-tier');
const lobbyAvatar     = document.getElementById('lobby-avatar');
const statWins        = document.getElementById('stat-wins');
const statGames       = document.getElementById('stat-games');
const findMatchBtn    = document.getElementById('find-match-btn');
const leaderboardBody = document.getElementById('leaderboard-body');
const logoutBtn       = document.getElementById('logout-btn');

const matchmakingOverlay   = document.getElementById('matchmaking-overlay');
const cancelMatchmakingBtn = document.getElementById('cancel-matchmaking-btn');

const gameMyName     = document.getElementById('game-my-name');
const gameMyElo      = document.getElementById('game-my-elo');
const gameOppName    = document.getElementById('game-opp-name');
const gameOppElo     = document.getElementById('game-opp-elo');
const matchIdDisplay = document.getElementById('match-id-display');

const myBoard        = document.getElementById('my-board');
const oppBoard       = document.getElementById('opp-board');
const chatMessages   = document.getElementById('chat-messages');
const chatForm       = document.getElementById('chat-form');
const chatInput      = document.getElementById('chat-input');
const keyboardEl     = document.getElementById('keyboard');

const gameOverOverlay  = document.getElementById('game-over-overlay');
const gameOverIcon     = document.getElementById('game-over-icon');
const gameOverTitle    = document.getElementById('game-over-title');
const gameOverDesc     = document.getElementById('game-over-desc');
const goMyUsername     = document.getElementById('go-my-username');
const goMyEloChange    = document.getElementById('go-my-elo-change');
const returnLobbyBtn   = document.getElementById('return-lobby-btn');

// ============================================================
// SCREEN TRANSITIONS
// ============================================================
function showScreen(screenEl) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    screenEl.classList.add('active');
}

// ============================================================
// AUTH TABS
// ============================================================
let isRegisterMode = false;

tabLogin.addEventListener('click', () => {
    isRegisterMode = false;
    tabLogin.classList.add('active');
    tabRegister.classList.remove('active');
    tabLogin.setAttribute('aria-selected', 'true');
    tabRegister.setAttribute('aria-selected', 'false');
    authSubmitBtn.textContent = 'Masuk ke Game';
    hideAuthError();
});

tabRegister.addEventListener('click', () => {
    isRegisterMode = true;
    tabRegister.classList.add('active');
    tabLogin.classList.remove('active');
    tabRegister.setAttribute('aria-selected', 'true');
    tabLogin.setAttribute('aria-selected', 'false');
    authSubmitBtn.textContent = 'Daftar Akun Baru';
    hideAuthError();
});

function showAuthError(msg) {
    authError.textContent = msg;
    authError.classList.remove('hidden');
}

function hideAuthError() {
    authError.classList.add('hidden');
    authError.textContent = '';
}

// ============================================================
// AUTH SUBMIT
// ============================================================
authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideAuthError();

    const usernameVal = document.getElementById('username').value.trim();
    const passwordVal = document.getElementById('password').value;

    if (!usernameVal || !passwordVal) {
        showAuthError('Username dan password tidak boleh kosong.');
        return;
    }

    authSubmitBtn.disabled = true;
    authSubmitBtn.textContent = isRegisterMode ? 'Mendaftar...' : 'Masuk...';

    const endpoint = isRegisterMode ? `${AUTH_URL}/register` : `${AUTH_URL}/login`;

    try {
        const res  = await fetch(endpoint, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ username: usernameVal, password: passwordVal }),
        });
        const data = await res.json();

        if (!res.ok) {
            throw new Error(data.error || 'Terjadi kesalahan. Coba lagi.');
        }

        if (isRegisterMode) {
            showToast('✅ Pendaftaran berhasil! Silakan masuk.', 'success');
            tabLogin.click();
        } else {
            currentUser = {
                token:    data.token,
                userId:   data.userId,
                username: usernameVal,
                elo:      1000,
                wins:     0,
                games:    0,
            };
            localStorage.setItem('wordduel_token',    data.token);
            localStorage.setItem('wordduel_userId',   data.userId);
            localStorage.setItem('wordduel_username', usernameVal);
            await enterLobby();
        }
    } catch (err) {
        showAuthError(err.message);
    } finally {
        authSubmitBtn.disabled = false;
        authSubmitBtn.textContent = isRegisterMode ? 'Daftar Akun Baru' : 'Masuk ke Game';
    }
});

// ============================================================
// LOBBY
// ============================================================
async function fetchUserProfile() {
    try {
        // nginx strips /api/users → user-service receives /users/:id
        const res = await fetch(`${USER_URL}/users/${currentUser.userId}`);
        if (res.ok) {
            const data = await res.json();
            currentUser.elo   = data.elo   ?? currentUser.elo;
            currentUser.wins  = data.wins  ?? 0;
            currentUser.games = data.games ?? 0;
        }
    } catch (err) {
        console.error('[Profile] Fetch failed:', err);
    }
}

async function fetchLeaderboard() {
    try {
        const res = await fetch(`${LEADERBOARD_URL}/leaderboard`);
        if (!res.ok) return;
        const data = await res.json();

        leaderboardBody.innerHTML = '';

        if (!data.length) {
            leaderboardBody.innerHTML = `
                <tr><td colspan="3" class="sys-msg" style="padding:20px;text-align:center;">
                    Belum ada data peringkat.
                </td></tr>`;
            return;
        }

        data.forEach((item, i) => {
            const rank = i + 1;
            const cls  = rank <= 3 ? `rank-${rank}` : 'rank-other';
            const initial = (item.username || '?').charAt(0).toUpperCase();
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><span class="rank-badge ${cls}">${rank}</span></td>
                <td>
                    <div class="lb-player">
                        <div class="lb-avatar">${initial}</div>
                        ${escapeHTML(item.username)}
                    </div>
                </td>
                <td style="text-align:right;" class="lb-elo">${item.elo}</td>
            `;
            leaderboardBody.appendChild(tr);
        });
    } catch (err) {
        console.error('[Leaderboard] Fetch failed:', err);
    }
}

async function enterLobby() {
    showScreen(lobbyScreen);
    gameOverOverlay.classList.remove('active');

    await fetchUserProfile();

    lobbyUsername.textContent = currentUser.username;
    lobbyElo.textContent      = currentUser.elo;
    lobbyTier.textContent     = getEloTier(currentUser.elo);
    statWins.textContent      = currentUser.wins  ?? 0;
    statGames.textContent     = currentUser.games ?? 0;

    await fetchLeaderboard();
}

// Logout
logoutBtn.addEventListener('click', () => {
    currentUser = null;
    localStorage.clear();
    if (activeSocket) { activeSocket.disconnect(); activeSocket = null; }
    showScreen(loginScreen);
    showToast('👋 Anda telah keluar.');
});

// ============================================================
// MATCHMAKING — ELO-based with live queue status polling
// ============================================================
let matchmakingAborted = false;
let mmTimerInterval    = null;
let mmStatusInterval   = null;
let mmStartTime        = null;

// ELO window phases (must mirror server config)
const MM_PHASES = [
    { afterSec:  0, window:  100, label: 'Fase 1 — Mencari pemain ELO serupa',     cls: '' },
    { afterSec: 10, window:  250, label: 'Fase 2 — Memperluas rentang pencarian',   cls: 'phase-2' },
    { afterSec: 25, window:  500, label: 'Fase 3 — Rentang diperluas ke ±500 ELO', cls: 'phase-3' },
    { afterSec: 45, window: Infinity, label: 'Fase 4 — Semua level diperbolehkan', cls: 'phase-4' },
];

// DOM refs for matchmaking overlay
const mmEloWindowLabel = document.getElementById('mm-elo-window-label');
const mmMyElo          = document.getElementById('mm-my-elo');
const mmRangeText      = document.getElementById('mm-range-text');
const mmProgressFill   = document.getElementById('mm-progress-fill');
const mmWaitTime       = document.getElementById('mm-wait-time');
const mmQueueCount     = document.getElementById('mm-queue-count');
const mmPhaseEl        = document.getElementById('mm-phase-label');
const mmPhaseText      = document.getElementById('mm-phase-text');
const mmMilestones     = document.querySelectorAll('.mm-ms');

function startMatchmakingUI() {
    mmStartTime = Date.now();

    // Seed player ELO
    const myElo = currentUser.elo ?? 1000;
    mmMyElo.textContent  = myElo;
    mmRangeText.textContent = '±100';
    mmEloWindowLabel.textContent = '±100';
    mmProgressFill.style.width = '0%';

    // Tick every second — update timer + phase + progress bar
    mmTimerInterval = setInterval(() => {
        const elapsed = (Date.now() - mmStartTime) / 1000;

        // --- Timer display ---
        const mins = Math.floor(elapsed / 60);
        const secs = Math.floor(elapsed % 60);
        mmWaitTime.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;

        // --- Progress bar (0 → 100% over 60s) ---
        const pct = Math.min((elapsed / 60) * 100, 100);
        mmProgressFill.style.width = `${pct}%`;

        // --- Phase detection ---
        let currentPhase = MM_PHASES[0];
        for (const p of MM_PHASES) {
            if (elapsed >= p.afterSec) currentPhase = p;
        }
        const windowLabel = currentPhase.window === Infinity ? '∞' : `±${currentPhase.window}`;
        mmRangeText.textContent      = windowLabel;
        mmEloWindowLabel.textContent = windowLabel;
        mmPhaseText.textContent      = currentPhase.label;
        mmPhaseEl.className          = `mm-phase ${currentPhase.cls}`;

        // --- Highlight passed milestones ---
        const milestoneSeconds = [0, 10, 25, 45];
        mmMilestones.forEach((el, i) => {
            el.classList.toggle('passed', elapsed >= milestoneSeconds[i]);
        });

    }, 1000);

    // Poll queue status every 3 seconds
    mmStatusInterval = setInterval(async () => {
        if (matchmakingAborted) return;
        try {
            const res = await fetch(`${MATCHMAKING_URL}/queue/status`);
            if (!res.ok) return;
            const data = await res.json();
            mmQueueCount.textContent = data.playersInQueue ?? '—';
        } catch (_) { /* silent */ }
    }, 3000);

    // Initial status fetch
    fetch(`${MATCHMAKING_URL}/queue/status`)
        .then(r => r.ok ? r.json() : null)
        .then(data => { if (data) mmQueueCount.textContent = data.playersInQueue ?? '—'; })
        .catch(() => {});
}

function stopMatchmakingUI() {
    clearInterval(mmTimerInterval);
    clearInterval(mmStatusInterval);
    mmTimerInterval  = null;
    mmStatusInterval = null;
}

findMatchBtn.addEventListener('click', async () => {
    matchmakingOverlay.classList.add('active');
    matchmakingAborted = false;
    startMatchmakingUI();

    try {
        const res = await fetch(`${MATCHMAKING_URL}/join`, {
            method:  'POST',
            headers: {
                'Content-Type':  'application/json',
                'Authorization': `Bearer ${currentUser.token}`,
            },
        });

        stopMatchmakingUI();
        if (matchmakingAborted) return;

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Gagal masuk antrean matchmaking.');

        opponentUser = {
            userId:   data.opponentId,
            username: data.opponentUsername,
            elo:      data.opponentElo,
        };
        currentMatchId = data.matchId;

        // Brief "Match found!" flash before transition
        matchmakingOverlay.querySelector('.mm-title').textContent = '✅ Lawan Ditemukan!';
        matchmakingOverlay.querySelector('.mm-title').style.color = 'var(--success)';
        await new Promise(r => setTimeout(r, 700));

        matchmakingOverlay.classList.remove('active');
        matchmakingOverlay.querySelector('.mm-title').textContent = 'Mencari Lawan...';
        matchmakingOverlay.querySelector('.mm-title').style.color = '';
        initArena();

    } catch (err) {
        stopMatchmakingUI();
        if (!matchmakingAborted) {
            showToast(`❌ ${err.message}`, 'error');
            matchmakingOverlay.classList.remove('active');
        }
    }
});

cancelMatchmakingBtn.addEventListener('click', async () => {
    matchmakingAborted = true;
    stopMatchmakingUI();
    matchmakingOverlay.classList.remove('active');

    // Notify server to remove player from queue
    try {
        await fetch(`${MATCHMAKING_URL}/leave`, {
            method:  'POST',
            headers: { 'Authorization': `Bearer ${currentUser.token}` },
        });
    } catch (_) { /* silent — server will timeout anyway */ }

    showToast('Antrean dibatalkan.', 'info');
});



// ============================================================
// GAME ARENA
// ============================================================
function initArena() {
    showScreen(gameScreen);

    // Fill arena bar
    gameMyName.textContent  = currentUser.username;
    gameMyElo.textContent   = `${currentUser.elo} ELO`;
    gameOppName.textContent = opponentUser.username;
    gameOppElo.textContent  = `${opponentUser.elo} ELO`;
    matchIdDisplay.textContent = currentMatchId.toString().slice(-8).toUpperCase();

    // Reset state
    currentRow  = 0;
    currentTile = 0;
    gameActive  = true;

    buildBoards();
    buildKeyboard();

    chatMessages.innerHTML = `<div class="sys-msg">⚔️ Pertandingan dimulai! Tebak kata 5 huruf.</div>`;

    connectWebSocket();
}

function buildBoards() {
    myBoard.innerHTML  = '';
    oppBoard.innerHTML = '';

    for (let r = 0; r < MAX_GUESSES; r++) {
        // My board row
        const myRow = document.createElement('div');
        myRow.className = 'wordle-row';
        myRow.id = `my-row-${r}`;
        myRow.setAttribute('role', 'row');
        for (let c = 0; c < WORD_LENGTH; c++) {
            const tile = document.createElement('div');
            tile.className = 'tile';
            tile.id = `my-tile-${r}-${c}`;
            tile.setAttribute('role', 'gridcell');
            myRow.appendChild(tile);
        }
        myBoard.appendChild(myRow);

        // Opp board row
        const oppRow = document.createElement('div');
        oppRow.className = 'wordle-row';
        oppRow.id = `opp-row-${r}`;
        oppRow.setAttribute('role', 'row');
        for (let c = 0; c < WORD_LENGTH; c++) {
            const tile = document.createElement('div');
            tile.className = 'opp-tile';
            tile.id = `opp-tile-${r}-${c}`;
            tile.setAttribute('role', 'gridcell');
            oppRow.appendChild(tile);
        }
        oppBoard.appendChild(oppRow);
    }
}

function buildKeyboard() {
    const layout = [
        ['Q','W','E','R','T','Y','U','I','O','P'],
        ['A','S','D','F','G','H','J','K','L'],
        ['ENTER','Z','X','C','V','B','N','M','⌫'],
    ];

    keyboardEl.innerHTML = '';

    layout.forEach(rowKeys => {
        const row = document.createElement('div');
        row.className = 'keyboard-row';

        rowKeys.forEach(k => {
            const btn = document.createElement('button');
            btn.textContent = k;
            btn.type = 'button';
            const isWide = k === 'ENTER' || k === '⌫';
            btn.className = `key${isWide ? ' wide' : ''}`;
            btn.id = `key-${k.toLowerCase()}`;
            btn.setAttribute('aria-label', k);
            btn.addEventListener('click', () => handleKey(k === '⌫' ? 'DELETE' : k));
            row.appendChild(btn);
        });

        keyboardEl.appendChild(row);
    });
}

// Physical keyboard
window.addEventListener('keydown', (e) => {
    if (!gameActive || !gameScreen.classList.contains('active') || gameOverOverlay.classList.contains('active')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const k = e.key.toUpperCase();
    if (k === 'ENTER')                        handleKey('ENTER');
    else if (k === 'BACKSPACE' || k === 'DELETE') handleKey('DELETE');
    else if (/^[A-Z]$/.test(k))              handleKey(k);
});

function handleKey(key) {
    if (!gameActive || currentRow >= MAX_GUESSES) return;

    if (key === 'DELETE') {
        if (currentTile > 0) {
            currentTile--;
            const tile = getTile(currentRow, currentTile);
            tile.textContent = '';
            tile.classList.remove('filled');
        }
    } else if (key === 'ENTER') {
        if (currentTile === WORD_LENGTH) {
            submitGuess();
        } else {
            shakeRow(currentRow);
            showToast('Tebakan harus terdiri dari 5 huruf!', 'warning');
        }
    } else {
        if (currentTile < WORD_LENGTH) {
            const tile = getTile(currentRow, currentTile);
            tile.textContent = key;
            tile.classList.add('filled');
            tile.classList.add('pop');
            tile.addEventListener('animationend', () => tile.classList.remove('pop'), { once: true });
            currentTile++;
        }
    }
}

function getTile(row, col) {
    return document.getElementById(`my-tile-${row}-${col}`);
}

function shakeRow(row) {
    const tiles = [...document.querySelectorAll(`#my-row-${row} .tile`)];
    tiles.forEach(t => {
        t.classList.add('shake');
        t.addEventListener('animationend', () => t.classList.remove('shake'), { once: true });
    });
}

function submitGuess() {
    let guess = '';
    for (let c = 0; c < WORD_LENGTH; c++) {
        guess += getTile(currentRow, c).textContent;
    }
    if (activeSocket) {
        activeSocket.emit('submit_guess', { matchId: currentMatchId, guess });
    }
}

// ============================================================
// WEBSOCKET
// ============================================================
function connectWebSocket() {
    if (activeSocket) activeSocket.disconnect();

    activeSocket = io(API_URL, { auth: { token: currentUser.token } });

    activeSocket.on('connect', () => {
        console.log('[Socket] Connected:', activeSocket.id);
        activeSocket.emit('join_room', { matchId: currentMatchId });
    });

    activeSocket.on('receive_message', ({ sender, message }) => {
        appendChat(sender, message, sender !== currentUser.username);
    });

    activeSocket.on('guess_result', (data) => {
        const isMe = data.userId === currentUser.userId;
        renderGuessFeedback(isMe, data.guess, data.feedback);
    });

    activeSocket.on('game_over', (data) => {
        gameActive = false;
        showGameOver(data);
    });

    // Fired when current player runs out of guesses but opponent hasn't yet
    activeSocket.on('out_of_guesses', () => {
        gameActive = false; // Disable guessing inputs
        appendSystemMsg(`😔 Tebakan Anda telah habis. Menunggu lawan menyelesaikan permainan...`);
        showToast(`😔 Tebakan Anda habis! Menunggu lawan...`, 'error');
    });

    // Fired when opponent runs out of guesses but current player is still playing
    activeSocket.on('opponent_out_of_guesses', (data) => {
        appendSystemMsg(`📢 ${data.username || 'Lawan'} telah kehabisan tebakan!`);
        showToast(`📢 Lawan kehabisan tebakan! Selesaikan permainan Anda.`, 'warning');
    });

    // Fired when opponent disconnects mid-game
    activeSocket.on('opponent_disconnected', (data) => {
        appendSystemMsg(`⚠ ${data.username || 'Lawan'} terputus dari permainan.`);
        showToast(`⚠ Lawan terputus koneksi!`, 'warning');
    });

    activeSocket.on('error', (msg) => {
        showToast(`⚠ Server: ${msg}`, 'error');
    });

    activeSocket.on('disconnect', () => {
        console.log('[Socket] Disconnected.');
        if (gameActive) showToast('⚠ Koneksi terputus!', 'error');
    });
}

// ============================================================
// GUESS FEEDBACK RENDERING
// ============================================================
let oppGuessRow = 0;

function renderGuessFeedback(isMe, guess, feedback) {
    const row    = isMe ? currentRow : oppGuessRow;
    const prefix = isMe ? 'my' : 'opp';
    const delay  = 80; // ms stagger per tile

    for (let c = 0; c < WORD_LENGTH; c++) {
        const tile = document.getElementById(`${prefix}-tile-${row}-${c}`);
        if (!tile) continue;

        const colorClass =
            feedback[c] === 'G' ? 'correct' :
            feedback[c] === 'Y' ? 'present' : 'absent';

        setTimeout(() => {
            tile.classList.add('flip');
            tile.addEventListener('animationend', () => {
                tile.classList.remove('flip');
                tile.classList.add(colorClass);
            }, { once: true });

            // Update keyboard colour (my board only)
            if (isMe) {
                const letter = guess[c]?.toLowerCase();
                const keyEl  = document.getElementById(`key-${letter}`);
                if (keyEl) {
                    const priority = { correct: 3, present: 2, absent: 1 };
                    const cur      = priority[colorClass] ?? 0;
                    const existing = priority[keyEl.dataset.state] ?? 0;
                    if (cur > existing) {
                        keyEl.classList.remove('correct', 'present', 'absent');
                        keyEl.classList.add(colorClass);
                        keyEl.dataset.state = colorClass;
                    }
                }
            }
        }, c * delay);
    }

    if (isMe) {
        currentRow++;
        currentTile = 0;
    } else {
        oppGuessRow++;
    }
}

// ============================================================
// CHAT
// ============================================================
chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const msg = chatInput.value.trim();
    if (!msg || !activeSocket) return;
    activeSocket.emit('send_message', { matchId: currentMatchId, message: msg });
    appendChat(currentUser.username, msg, false);
    chatInput.value = '';
});

function appendChat(sender, message, isOpp = false) {
    const div = document.createElement('div');
    div.className = 'msg-item';
    const senderClass = isOpp ? 'msg-sender opp' : 'msg-sender';
    div.innerHTML = `<span class="${senderClass}">${escapeHTML(sender)}:</span><span>${escapeHTML(message)}</span>`;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function appendSystemMsg(msg) {
    const div = document.createElement('div');
    div.className = 'sys-msg';
    div.textContent = msg;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ============================================================
// GAME OVER
// ============================================================
function showGameOver(data) {
    gameOverOverlay.classList.add('active');
    gameActive = false;

    // Draw or out-of-guesses case
    if (data.draw || data.outOfGuesses) {
        gameOverIcon.textContent  = '🤝';
        gameOverTitle.textContent = data.draw ? 'Imbang!' : 'Kehabisan Tebakan';
        gameOverDesc.textContent  = `Kata rahasianya adalah: ${data.secretWord || '?'}`;
        goMyUsername.textContent  = currentUser.username;
        goMyEloChange.textContent = '±0 ELO';
        goMyEloChange.className   = 'elo-result-value';
        if (activeSocket) { activeSocket.disconnect(); activeSocket = null; }
        return;
    }

    const isWin = data.winnerId === currentUser.userId;

    if (isWin) {
        gameOverIcon.textContent  = '🏆';
        gameOverTitle.textContent = 'Kemenangan!';
        gameOverDesc.textContent  = `Selamat! Anda berhasil menebak kata rahasia terlebih dahulu! (Kata: ${data.secretWord || '?'})`;
        gameOverOverlay.querySelector('.overlay-card').style.borderColor = 'rgba(16,185,129,0.4)';
    } else {
        gameOverIcon.textContent  = '💥';
        gameOverTitle.textContent = 'Kekalahan';
        gameOverDesc.textContent  = `${escapeHTML(data.winnerUsername || 'Lawan')} berhasil menebak kata rahasia terlebih dahulu! (Kata: ${data.secretWord || '?'})`;
        gameOverOverlay.querySelector('.overlay-card').style.borderColor = 'rgba(244,63,94,0.4)';
    }

    goMyUsername.textContent = currentUser.username;

    if (data.error) {
        goMyEloChange.textContent  = 'Gagal memproses poin ELO';
        goMyEloChange.className = 'elo-result-value elo-down';
    } else {
        const oldElo = currentUser.elo;
        const newElo = isWin ? (data.newWinnerElo ?? oldElo) : (data.newLoserElo ?? oldElo);
        const diff   = newElo - oldElo;
        currentUser.elo = newElo;

        const sign = diff >= 0 ? '+' : '';
        goMyEloChange.textContent = `${sign}${diff} ELO (${newElo})`;
        goMyEloChange.className = `elo-result-value ${diff >= 0 ? 'elo-up' : 'elo-down'}`;
    }

    if (activeSocket) { activeSocket.disconnect(); activeSocket = null; }
}

returnLobbyBtn.addEventListener('click', () => {
    gameOverOverlay.querySelector('.overlay-card').style.borderColor = '';
    oppGuessRow = 0;
    enterLobby();
});

// ============================================================
// TOAST NOTIFICATION
// ============================================================
function showToast(msg, type = 'info') {
    const existing = document.querySelector('.toast-notification');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'toast-notification';

    const colors = {
        success: { bg: 'rgba(16,185,129,0.15)', border: 'rgba(16,185,129,0.4)', text: '#6ee7b7' },
        error:   { bg: 'rgba(244,63,94,0.15)',  border: 'rgba(244,63,94,0.4)',  text: '#fda4af' },
        warning: { bg: 'rgba(245,158,11,0.15)', border: 'rgba(245,158,11,0.4)', text: '#fcd34d' },
        info:    { bg: 'rgba(124,58,237,0.15)', border: 'rgba(124,58,237,0.4)', text: '#c4b5fd' },
    };

    const c = colors[type] || colors.info;
    Object.assign(toast.style, {
        position:     'fixed',
        top:          '20px',
        left:         '50%',
        transform:    'translateX(-50%)',
        background:   c.bg,
        border:       `1px solid ${c.border}`,
        color:        c.text,
        padding:      '12px 24px',
        borderRadius: '12px',
        backdropFilter: 'blur(12px)',
        zIndex:       '9999',
        fontWeight:   '600',
        fontSize:     '0.875rem',
        whiteSpace:   'nowrap',
        animation:    'toast-in 0.3s ease',
        fontFamily:   "'Outfit', sans-serif",
    });

    // Add keyframe dynamically once
    if (!document.getElementById('toast-keyframes')) {
        const style = document.createElement('style');
        style.id = 'toast-keyframes';
        style.textContent = `
            @keyframes toast-in {
                from { opacity: 0; transform: translateX(-50%) translateY(-10px); }
                to   { opacity: 1; transform: translateX(-50%) translateY(0); }
            }
        `;
        document.head.appendChild(style);
    }

    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3500);
}

// ============================================================
// HELPERS
// ============================================================
function escapeHTML(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ============================================================
// AUTO-LOGIN ON PAGE LOAD
// ============================================================
window.addEventListener('DOMContentLoaded', async () => {
    const token    = localStorage.getItem('wordduel_token');
    const userId   = localStorage.getItem('wordduel_userId');
    const username = localStorage.getItem('wordduel_username');

    if (token && userId && username) {
        currentUser = { token, userId, username, elo: 1000, wins: 0, games: 0 };
        await enterLobby();
    }
});
