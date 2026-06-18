const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');

const JWT_SECRET       = process.env.JWT_SECRET       || 'supersecretkey_wordduel';
const USER_SERVICE_ADDR = process.env.USER_SERVICE_ADDR || 'localhost:50061';
const REST_PORT        = parseInt(process.env.REST_PORT) || 4005;
const GRPC_PORT        = parseInt(process.env.PORT)      || 50062;

// ============================================================
// gRPC CLIENT — User Service
// ============================================================
const USER_PROTO_PATH = path.join(__dirname, '../proto/user.proto');
const userProto = grpc.loadPackageDefinition(
  protoLoader.loadSync(USER_PROTO_PATH, { keepCase: true })
).user;

const userClient = new userProto.UserService(
  USER_SERVICE_ADDR,
  grpc.credentials.createInsecure()
);

// ============================================================
// gRPC SERVER — Matchmaking Service (for internal use)
// ============================================================
const MATCH_PROTO_PATH = path.join(__dirname, '../proto/matchmaking.proto');
const matchProto = grpc.loadPackageDefinition(
  protoLoader.loadSync(MATCH_PROTO_PATH, { keepCase: true })
).matchmaking;

// ============================================================
// QUEUE DATA STRUCTURE
// Entry: { userId, username, elo, resolve, reject, joinedAt, timeoutId }
// ============================================================
const queue = [];

// ============================================================
// ELO MATCHING CONFIG
// Window expands the longer a player waits
// ============================================================
const ELO_WINDOWS = [
  { afterSec:  0, window:  100 },  // 0-10s:  ±100 ELO
  { afterSec: 10, window:  250 },  // 10-25s: ±250 ELO
  { afterSec: 25, window:  500 },  // 25-45s: ±500 ELO
  { afterSec: 45, window: Infinity }, // 45s+: any ELO
];
const QUEUE_TIMEOUT_SEC = 60; // Kick player after 60s with no match

function getEloWindow(player) {
  const waited = (Date.now() - player.joinedAt) / 1000;
  for (let i = ELO_WINDOWS.length - 1; i >= 0; i--) {
    if (waited >= ELO_WINDOWS[i].afterSec) return ELO_WINDOWS[i].window;
  }
  return ELO_WINDOWS[0].window;
}

function getCurrentWindowLabel(player) {
  const w = getEloWindow(player);
  return w === Infinity ? '∞' : `±${w}`;
}

// ============================================================
// CORE MATCHING ALGORITHM (runs every 1.5s)
// Strategy: find the closest ELO pair where BOTH players'
//           windows overlap each other.
// ============================================================
function runMatchingPass() {
  if (queue.length < 2) return;

  let matched = new Set();

  for (let i = 0; i < queue.length; i++) {
    if (matched.has(i)) continue;
    const p1 = queue[i];
    const w1 = getEloWindow(p1);

    let bestJ = -1;
    let bestDiff = Infinity;

    for (let j = i + 1; j < queue.length; j++) {
      if (matched.has(j)) continue;
      const p2 = queue[j];
      const w2 = getEloWindow(p2);
      const diff = Math.abs(p1.elo - p2.elo);

      // Both players must accept each other within their window
      if (diff <= w1 && diff <= w2 && diff < bestDiff) {
        bestJ = j;
        bestDiff = diff;
      }
    }

    if (bestJ !== -1) {
      matched.add(i);
      matched.add(bestJ);
      createMatch(p1, queue[bestJ]);
    }
  }

  // Remove matched players from queue (in reverse index order)
  const toRemove = [...matched].sort((a, b) => b - a);
  toRemove.forEach(idx => queue.splice(idx, 1));
}

function createMatch(p1, p2) {
  const matchId = `match_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  const eloDiff = Math.abs(p1.elo - p2.elo);

  console.log(`[Match] ${p1.username}(${p1.elo}) vs ${p2.username}(${p2.elo}) | diff=${eloDiff} | ${matchId}`);

  clearTimeout(p1.timeoutId);
  clearTimeout(p2.timeoutId);

  p1.resolve({
    matchId,
    opponentId:       p2.userId,
    opponentUsername: p2.username,
    opponentElo:      p2.elo,
    eloDifference:    eloDiff,
    waitSeconds:      Math.floor((Date.now() - p1.joinedAt) / 1000),
  });

  p2.resolve({
    matchId,
    opponentId:       p1.userId,
    opponentUsername: p1.username,
    opponentElo:      p1.elo,
    eloDifference:    eloDiff,
    waitSeconds:      Math.floor((Date.now() - p2.joinedAt) / 1000),
  });
}

// Run matching loop every 1.5 seconds
setInterval(runMatchingPass, 1500);

// ============================================================
// gRPC JOIN QUEUE HANDLER (legacy internal use)
// ============================================================
function joinQueueGrpc(call, callback) {
  const { userId } = call.request;
  userClient.getUserElo({ userId }, (err, userInfo) => {
    if (err) return callback({ code: grpc.status.INTERNAL, details: 'Could not retrieve user info' });
    enqueuePlayer(userInfo.userId || userId, userInfo.username, userInfo.elo)
      .then(result => callback(null, result))
      .catch(e  => callback({ code: grpc.status.DEADLINE_EXCEEDED, details: e.message }));
  });
}

const grpcServer = new grpc.Server();
grpcServer.addService(matchProto.MatchmakingService.service, { joinQueue: joinQueueGrpc });
grpcServer.bindAsync(`0.0.0.0:${GRPC_PORT}`, grpc.ServerCredentials.createInsecure(), (err, port) => {
  if (err) { console.error('gRPC bind error:', err); return; }
  console.log(`[Matchmaking] gRPC Server running on port ${port}`);
});

// ============================================================
// QUEUE MANAGEMENT
// ============================================================
function enqueuePlayer(userId, username, elo) {
  // Remove any duplicate entry for this user
  removeFromQueue(userId, 'duplicate');

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      removeFromQueue(userId, 'timeout');
      reject(new Error('Waktu pencarian lawan habis (60 detik). Coba lagi.'));
    }, QUEUE_TIMEOUT_SEC * 1000);

    queue.push({ userId, username, elo, resolve, reject, joinedAt: Date.now(), timeoutId });
    console.log(`[Queue] ${username}(${elo}) joined. Queue size: ${queue.length}`);
  });
}

function removeFromQueue(userId, reason = 'manual') {
  const idx = queue.findIndex(p => p.userId === userId);
  if (idx === -1) return false;
  const player = queue[idx];
  clearTimeout(player.timeoutId);
  queue.splice(idx, 1);
  console.log(`[Queue] ${player.username} removed (${reason}). Queue size: ${queue.length}`);
  return true;
}

// ============================================================
// REST API
// ============================================================
const restApp = express();
restApp.use(express.json());
restApp.use(cors());

// JWT middleware
function auth(req, res, next) {
  const header = req.headers['authorization'];
  const token  = header && header.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token required' });
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = decoded;
    next();
  });
}

// ── POST /join ───────────────────────────────────────────────
// Browser long-polls this until a match is found or timeout.
restApp.post('/join', auth, async (req, res) => {
  const { userId, username } = req.user;
  console.log(`[REST] /join from ${username}`);

  try {
    // Fetch latest ELO from User Service via gRPC
    const userInfo = await new Promise((resolve, reject) => {
      userClient.getUserElo({ userId }, (err, info) => {
        if (err) reject(err); else resolve(info);
      });
    });

    const elo = userInfo.elo ?? 1000;
    const result = await enqueuePlayer(userId, username, elo);
    res.json(result);
  } catch (err) {
    console.error(`[REST] /join error for ${username}:`, err.message);
    res.status(504).json({ error: err.message || 'Matchmaking failed' });
  }
});

// ── POST /leave ──────────────────────────────────────────────
// Explicit cancel from client.
restApp.post('/leave', auth, (req, res) => {
  const { userId, username } = req.user;
  const removed = removeFromQueue(userId, 'cancel');
  console.log(`[REST] /leave from ${username} — removed: ${removed}`);
  res.json({ success: true, removed });
});

// ── GET /queue/status ────────────────────────────────────────
// Returns live queue stats (used by frontend overlay).
restApp.get('/queue/status', (req, res) => {
  const now = Date.now();
  const players = queue.map(p => ({
    username:    p.username,
    elo:         p.elo,
    waitSeconds: Math.floor((now - p.joinedAt) / 1000),
    eloWindow:   getCurrentWindowLabel(p),
  }));

  res.json({
    playersInQueue:  queue.length,
    players,
    estimatedWaitMs: queue.length >= 1 ? 3000 : null,
  });
});

// ── GET /health ──────────────────────────────────────────────
restApp.get('/health', (_, res) =>
  res.json({ status: 'ok', service: 'matchmaking-service', queueSize: queue.length })
);

restApp.listen(REST_PORT, () => {
  console.log(`[Matchmaking] REST Server running on port ${REST_PORT}`);
});
