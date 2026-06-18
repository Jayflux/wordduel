const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');
const { io } = require('socket.io-client');
const { execSync } = require('child_process');

// Nginx API Gateway endpoints
const GATEWAY_URL = 'http://localhost:8081';
const LOGIN_SERVICE_URL = `${GATEWAY_URL}/api/auth`;
const USER_SERVICE_URL = `${GATEWAY_URL}/api/users`;
const RANKING_SERVICE_URL = `${GATEWAY_URL}/api/leaderboard`;

// Setup gRPC client for Matchmaking (Direct connection to matchmaking-service port mapped to host)
const MATCH_PROTO_PATH = path.join(__dirname, './proto/matchmaking.proto');
const matchPackageDef = protoLoader.loadSync(MATCH_PROTO_PATH, { keepCase: true });
const matchProto = grpc.loadPackageDefinition(matchPackageDef).matchmaking;

const matchmakingClient = new matchProto.MatchmakingService(
  'localhost:50062',
  grpc.credentials.createInsecure()
);

async function registerAndLogin(username, password) {
  console.log(`[Test] Registering user: ${username} via Nginx Gateway...`);
  let res = await fetch(`${LOGIN_SERVICE_URL}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  let data = await res.json();
  console.log(`[Test] Register response for ${username}:`, data);

  console.log(`[Test] Logging in user: ${username} via Nginx Gateway...`);
  res = await fetch(`${LOGIN_SERVICE_URL}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  data = await res.json();
  console.log(`[Test] Login response for ${username}:`, data);
  return data; // { token, userId }
}

function joinQueue(userId, username) {
  return new Promise((resolve, reject) => {
    console.log(`[Test] ${username} joining matchmaking queue via gRPC...`);
    matchmakingClient.joinQueue({ userId }, (err, response) => {
      if (err) {
        console.error(`[Test] Error for ${username}:`, err.message);
        reject(err);
      } else {
        console.log(`[Test] Match success for ${username}! Opponent: ${response.opponentUsername} (ELO: ${response.opponentElo}), Match ID: ${response.matchId}`);
        resolve(response);
      }
    });
  });
}

function setupSocketConnection(token, username, matchId) {
  return new Promise((resolve) => {
    console.log(`[Test] Connecting ${username} to WebSocket via Nginx...`);
    const socket = io(GATEWAY_URL, {
      auth: { token }
    });

    socket.on('connect', () => {
      console.log(`[Test] ${username} connected to WebSocket!`);
      socket.emit('join_room', { matchId });
    });

    socket.on('player_ready', (data) => {
      console.log(`[WebSocket Notification] Player ${data.username} is ready in room ${matchId}`);
    });

    resolve(socket);
  });
}

async function testWebSocketGameplay(alice, bob, matchId) {
  console.log(`\n--- Starting WebSocket Real-time Chat & Gameplay Test ---`);

  const aliceSocket = await setupSocketConnection(alice.token, 'alice', matchId);
  const bobSocket = await setupSocketConnection(bob.token, 'bob', matchId);

  // Sleep 500ms to allow room join registration on socket server
  await new Promise(r => setTimeout(r, 500));

  // 1. Test Chat Communication
  await new Promise((resolve) => {
    bobSocket.on('receive_message', (data) => {
      console.log(`[WebSocket Chat received by bob] ${data.sender}: ${data.message}`);
      resolve();
    });

    console.log(`[Test] Alice sending chat message: 'Good luck!'...`);
    aliceSocket.emit('send_message', { matchId, message: 'Good luck!' });
  });

  // 2. Test Wordle Gameplay: Submit wrong guess
  await new Promise((resolve) => {
    bobSocket.on('guess_result', (data) => {
      console.log(`[WebSocket Guess feedback] ${data.username} guessed '${data.guess}' -> Result: ${data.feedback} (G=Green, Y=Yellow, X=Gray)`);
      resolve();
    });

    console.log(`[Test] Alice guessing 'PLANT' (wrong word)...`);
    aliceSocket.emit('submit_guess', { matchId, guess: 'PLANT' });
  });

  // 3. Test Wordle Gameplay: Submit correct guess (WORLD) & trigger Saga + Game Over
  const gameOverPromise = new Promise((resolve) => {
    aliceSocket.on('game_over', (data) => {
      console.log(`[WebSocket Game Over Notification] Winner: ${data.winnerUsername}, Winner ELO: ${data.newWinnerElo}, Loser ELO: ${data.newLoserElo}`);
      resolve();
    });
  });

  console.log(`[Test] Alice guessing 'WORLD' (correct word!)...`);
  aliceSocket.emit('submit_guess', { matchId, guess: 'WORLD' });

  await gameOverPromise;

  // Disconnect sockets
  aliceSocket.disconnect();
  bobSocket.disconnect();
  console.log(`[Test] Sockets disconnected cleanly.`);
}

async function testFaultTolerance(username, password) {
  console.log(`\n--- Starting Nginx Fault Tolerance (Failover) Test ---`);
  
  // 1. Verify Login works
  console.log(`[Test] Verifying Login works initially...`);
  let loginRes = await fetch(`${LOGIN_SERVICE_URL}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  if (loginRes.ok) console.log(`[Test] Initial login succeeded.`);

  // 2. Stop login-service-1 container
  console.log(`[Test] Stopping container login-service-1 to simulate server crash...`);
  execSync('docker stop login-service-1', { stdio: 'inherit' });

  // 3. Verify Login STILL works (Nginx failover to login-service-2)
  console.log(`[Test] Testing login again while login-service-1 is dead...`);
  loginRes = await fetch(`${LOGIN_SERVICE_URL}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });

  if (loginRes.ok) {
    const data = await loginRes.json();
    console.log(`[Test] FAILOVER SUCCESS! Login succeeded through active backup server! User ELO: ${data.userId}`);
  } else {
    throw new Error('Failover failed: Login service is completely unreachable');
  }

  // 4. Restart login-service-1
  console.log(`[Test] Starting container login-service-1 back up...`);
  execSync('docker start login-service-1', { stdio: 'inherit' });
  console.log(`[Test] Cluster is back to fully healthy.`);
}

async function run() {
  console.log('--- Word Duel Integration Test - Phase 4 (Full Dockerized) ---');
  try {
    // 1. Register & Login Alice & Bob
    const alice = await registerAndLogin('alice', 'password123');
    const bob = await registerAndLogin('bob', 'password456');

    // 2. Matchmaking
    console.log('\n--- Starting Matchmaking Test ---');
    const matchData = await new Promise((resolve, reject) => {
      // Both join the queue concurrently
      Promise.all([
        joinQueue(alice.userId, 'alice'),
        joinQueue(bob.userId, 'bob')
      ]).then(results => resolve(results[0])).catch(reject);
    });

    // 3. Test WebSocket chat & gameplay + Saga ELO update
    await testWebSocketGameplay(alice, bob, matchData.matchId);

    // 4. Test Fault Tolerance (Simulating node failure)
    await testFaultTolerance('alice', 'password123');

    console.log('\n[Test] Monorepo verification completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('[Test] Test failed:', error);
    process.exit(1);
  }
}

// Run test
run();
