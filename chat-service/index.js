const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 4004;
const JWT_SECRET = process.env.JWT_SECRET || 'supersecretkey_wordduel';
const USER_SERVICE_URL = process.env.USER_SERVICE_URL || 'http://localhost:4002';

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// ============================================================
// WORD LIST — 5-huruf bahasa Indonesia / universal
// ============================================================
const WORD_LIST = [
  'BESAR','BUKAN','CEPAT','DALAM','ENAK','FAKTA','GELAP','HEBAT',
  'IDEAL','JALAN','KECIL','LEBAR','MAKAN','NYATA','OBYEK','PEDAS',
  'PUTIH','RAJIN','SALAH','TEBAL','UJUNG','VIRAL','WAJAH','KERAS',
  'BEBAS','TEMAN','PASAR','BUNGA','MALAM','RIANG','PADAT','LURUS',
  'TEPAT','MANIS','CERIA','DAMAI','KERAS','BAWAH','ATASN','DEPAN',
  'BELAH','PISAU','RUANG','BATAS','TIMUR','BARAT','UTARA','MUDAH',
  'SUSAH','RAMAI','SEHAT','SAKIT','HIDUP','MANDI','TIDUR','BANTU',
  'TUGAS','KERJA','LIBUR','PESTA','KABAR','BENAR','BOHONG','ANGKA',
  'HURUF','NILAI','TANDA','WARNA','HITAM','MERAH','HIJAU','BIRU',
  'KUNING','PUTIH','COKLAT','EMAS','PERAK','PERLU','SUDAH','MASIH',
  'AKAN','HARUS','BOLEH','DAPAT','TAHU','INGIN','SUKA','BENCI',
  'TAKUT','BERANI','MAJU','MUNDUR','NAIK','TURUN','BUKA','TUTUP',
  // fallback English 5-letter words
  'WORLD','WATCH','BRAVE','CHEER','FLAME','GRACE','HEART','IMAGE',
  'JEWEL','KNIFE','LEARN','MAGIC','NIGHT','OCEAN','PRIDE','QUEEN',
  'RADIO','SMILE','TIGER','ULTRA','VOICE','WITCH','XENON','YACHT','ZEBRA'
].map(w => w.toUpperCase()).filter(w => w.length === 5);

function pickRandomWord() {
  return WORD_LIST[Math.floor(Math.random() * WORD_LIST.length)];
}

// ============================================================
// WORDLE FEEDBACK — correct algorithm (handles duplicate letters)
// ============================================================
function calcFeedback(guess, secret) {
  const feedback = Array(5).fill('X');
  const secretChars = secret.split('');
  const guessChars  = guess.split('');

  // Pass 1 — mark exact matches (Green)
  for (let i = 0; i < 5; i++) {
    if (guessChars[i] === secretChars[i]) {
      feedback[i] = 'G';
      secretChars[i] = null;  // consume
      guessChars[i] = null;
    }
  }

  // Pass 2 — mark present-but-wrong-position (Yellow)
  for (let i = 0; i < 5; i++) {
    if (guessChars[i] === null) continue; // already matched
    const idx = secretChars.indexOf(guessChars[i]);
    if (idx !== -1) {
      feedback[i] = 'Y';
      secretChars[idx] = null; // consume
    }
  }

  return feedback.join('');
}

// ============================================================
// ACTIVE ROOMS
// Structure: matchId -> { secretWord, players: [{userId, username, socketId}], guessCount: {userId: n} }
// ============================================================
const activeRooms = {};

// ============================================================
// SOCKET.IO AUTH MIDDLEWARE
// ============================================================
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication error: Token required'));

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return next(new Error('Authentication error: Invalid token'));
    socket.user = decoded;
    next();
  });
});

// ============================================================
// SOCKET.IO CONNECTION
// ============================================================
io.on('connection', (socket) => {
  const { userId, username } = socket.user;
  console.log(`[WS] Connected: ${username} (${userId})`);

  // --- JOIN ROOM ---
  socket.on('join_room', ({ matchId }) => {
    socket.join(matchId);
    console.log(`[WS] ${username} joined room ${matchId}`);

    if (!activeRooms[matchId]) {
      const word = pickRandomWord();
      console.log(`[WS] Room ${matchId} created. Secret word: ${word}`);
      activeRooms[matchId] = {
        secretWord:  word,
        players:     [],
        guessCount:  {}  // userId -> number of guesses
      };
    }

    const room = activeRooms[matchId];

    // Add player if not already in room
    if (!room.players.find(p => p.userId === userId)) {
      room.players.push({ userId, username, socketId: socket.id });
      room.guessCount[userId] = 0;
    }

    io.to(matchId).emit('player_ready', { userId, username });
  });

  // --- CHAT MESSAGE ---
  socket.on('send_message', ({ matchId, message }) => {
    // Broadcast only to the OTHER player in the room
    socket.to(matchId).emit('receive_message', {
      sender: username,
      message,
      timestamp: new Date().toISOString()
    });
  });

  // --- SUBMIT GUESS ---
  socket.on('submit_guess', async ({ matchId, guess }) => {
    const room = activeRooms[matchId];
    if (!room) return socket.emit('error', 'Game room not found');

    const cleanGuess = (guess || '').toUpperCase().trim();
    if (cleanGuess.length !== 5) {
      return socket.emit('error', 'Guess must be exactly 5 letters');
    }

    const secret = room.secretWord;

    // Increment guess count
    room.guessCount[userId] = (room.guessCount[userId] || 0) + 1;

    const feedbackStr = calcFeedback(cleanGuess, secret);

    console.log(`[WS] Guess in ${matchId} by ${username}: ${cleanGuess} → ${feedbackStr} (secret: ${secret})`);

    // Broadcast guess result to both players
    io.to(matchId).emit('guess_result', {
      userId,
      username,
      guess:    cleanGuess,
      feedback: feedbackStr
    });

    // Check win condition
    if (feedbackStr === 'GGGGG') {
      console.log(`[WS] ${username} guessed the word! Triggering Saga...`);

      const winner = room.players.find(p => p.userId === userId);
      const loser  = room.players.find(p => p.userId !== userId);

      if (winner && loser) {
        await triggerEloSaga(socket, matchId, winner, loser, secret);
      } else if (winner && !loser) {
        // Solo / opponent disconnected — still emit game_over
        io.to(matchId).emit('game_over', {
          winnerId:       winner.userId,
          winnerUsername: winner.username,
          secretWord:     secret,
          error:          'Opponent not found (may have disconnected)'
        });
      }

      delete activeRooms[matchId];
      return;
    }

    // Check max guesses for this player (6 guesses)
    if (room.guessCount[userId] >= 6) {
      console.log(`[WS] ${username} exhausted all guesses in room ${matchId}`);

      // If opponent already exhausted too — game over as draw
      const allExhausted = room.players.every(p => (room.guessCount[p.userId] || 0) >= 6);
      if (allExhausted) {
        io.to(matchId).emit('game_over', {
          winnerId:       null,
          winnerUsername: null,
          secretWord:     secret,
          draw:           true
        });
        delete activeRooms[matchId];
      } else {
        // Notify just this player they're out of guesses (do not reveal secretWord yet to prevent cheating)
        socket.emit('out_of_guesses');
        // Also notify the opponent
        socket.to(matchId).emit('opponent_out_of_guesses', { username });
      }
    }
  });

  // --- DISCONNECT ---
  socket.on('disconnect', () => {
    console.log(`[WS] Disconnected: ${username}`);
    // Notify rooms this player was in
    for (const [matchId, room] of Object.entries(activeRooms)) {
      if (room.players.find(p => p.userId === userId)) {
        socket.to(matchId).emit('opponent_disconnected', { username });
      }
    }
  });
});

// ============================================================
// ELO SAGA TRANSACTION
// ============================================================
async function triggerEloSaga(socket, matchId, winner, loser, secretWord) {
  try {
    const token = socket.handshake.auth.token;
    const resp = await fetch(`${USER_SERVICE_URL}/matches/complete`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        matchId,
        winnerId: winner.userId,
        loserId:  loser.userId
      })
    });

    const data = await resp.json();

    if (resp.ok) {
      console.log(`[WS] Saga success for match ${matchId}`);
      io.to(matchId).emit('game_over', {
        winnerId:       winner.userId,
        winnerUsername: winner.username,
        newWinnerElo:   data.winner.elo,
        newLoserElo:    data.loser.elo,
        secretWord
      });
    } else {
      throw new Error(data.error || 'Saga transaction failed');
    }
  } catch (err) {
    console.error(`[WS] Saga error for match ${matchId}:`, err.message);
    io.to(matchId).emit('game_over', {
      winnerId:       winner.userId,
      winnerUsername: winner.username,
      secretWord,
      error:          'ELO update failed (saga rolled back)'
    });
  }
}

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/health', (_, res) => res.json({ status: 'ok', service: 'chat-service' }));

server.listen(PORT, () => {
  console.log(`[Chat+Game Service] Running on port ${PORT}`);
});
