const express = require('express');
const cors = require('cors');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');
const { Pool } = require('pg');

// --- PostgreSQL connection pools ---
const masterPool = new Pool({
  connectionString: process.env.DATABASE_MASTER_URL || 'postgresql://postgres:postgres_password@localhost:5432/wordduel'
});

const slavePool = new Pool({
  connectionString: process.env.DATABASE_SLAVE_URL || 'postgresql://postgres:postgres_password@localhost:5433/wordduel'
});

// Initialize schema on master
async function initDb() {
  const createTableQuery = `
    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(50) PRIMARY KEY,
      username VARCHAR(50) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      elo INT DEFAULT 1000,
      wins INT DEFAULT 0,
      games INT DEFAULT 0
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS wins INT DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS games INT DEFAULT 0;
  `;
  try {
    await masterPool.query(createTableQuery);
    console.log('Database schema initialized on master (with wins & games columns)');
  } catch (err) {
    console.error('Error initializing database, retrying in 5s...', err.message);
    setTimeout(initDb, 5000);
  }
}
initDb();

// --- REST Express Setup ---
const app = express();
app.use(express.json());
app.use(cors());

const REST_PORT = process.env.REST_PORT || 4002;

// REST: Create user (Writes go to Master Pool)
app.post('/users', async (req, res) => {
  const { username, passwordHash } = req.body;
  if (!username || !passwordHash) {
    return res.status(400).json({ error: 'Username and passwordHash are required' });
  }

  const userId = `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  try {
    const query = 'INSERT INTO users(id, username, password_hash, elo) VALUES($1, $2, $3, $4) RETURNING id, username';
    const result = await masterPool.query(query, [userId, username, passwordHash, 1000]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') { // Unique constraint violation
      return res.status(400).json({ error: 'Username already exists' });
    }
    console.error('Error inserting user:', err);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// REST: Get user credentials (Reads go to Slave Pool)
app.get('/users/by-username', async (req, res) => {
  const { username } = req.query;
  if (!username) {
    return res.status(400).json({ error: 'Username query parameter is required' });
  }

  try {
    const query = 'SELECT id, username, password_hash AS "passwordHash", elo, wins, games FROM users WHERE LOWER(username) = LOWER($1)';
    const result = await slavePool.query(query, [username]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching user by username:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// REST: Get user profile info (Reads go to Slave Pool)
app.get('/users/:id', async (req, res) => {
  try {
    const query = 'SELECT id, username, elo, wins, games FROM users WHERE id = $1';
    const result = await slavePool.query(query, [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching user by id:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'supersecretkey_wordduel';
const RANKING_SERVICE_URL = process.env.RANKING_SERVICE_URL || 'http://localhost:4003';

// JWT Verification Middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required' });

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = decoded;
    next();
  });
}

// POST /matches/complete: Saga Orchestrator for match completion ELO transactions
app.post('/matches/complete', authenticateToken, async (req, res) => {
  const { matchId, winnerId, loserId, forceFailRedis } = req.body;
  if (!matchId || !winnerId || !loserId) {
    return res.status(400).json({ error: 'matchId, winnerId, and loserId are required' });
  }

  console.log(`[Saga] Starting ELO transaction for match ${matchId}`);
  
  // Track state for rollback (compensating actions)
  let stepsCompleted = [];
  let originalWinnerElo = null;
  let originalLoserElo = null;
  let winnerUsername = null;
  let loserUsername = null;
  let newWinnerElo = null;
  let newLoserElo = null;

  try {
    // Get current ELOs from master db to save original values
    const originalWinnerResult = await masterPool.query('SELECT elo, username FROM users WHERE id = $1', [winnerId]);
    const originalLoserResult = await masterPool.query('SELECT elo, username FROM users WHERE id = $1', [loserId]);

    if (originalWinnerResult.rows.length === 0 || originalLoserResult.rows.length === 0) {
      throw new Error('Winner or Loser user not found');
    }

    originalWinnerElo = originalWinnerResult.rows[0].elo;
    winnerUsername = originalWinnerResult.rows[0].username;
    originalLoserElo = originalLoserResult.rows[0].elo;
    loserUsername = originalLoserResult.rows[0].username;

    // Step 1: Update Winner ELO (+25), Wins (+1), Games (+1)
    console.log(`[Saga Step 1] Adding ELO +25, Wins +1, Games +1 to Winner (${winnerUsername})`);
    const winnerUpdate = await masterPool.query(
      'UPDATE users SET elo = elo + 25, wins = wins + 1, games = games + 1 WHERE id = $1 RETURNING elo',
      [winnerId]
    );
    newWinnerElo = winnerUpdate.rows[0].elo;
    stepsCompleted.push('step1_update_winner');

    // Step 2: Update Loser ELO (-25), Games (+1)
    console.log(`[Saga Step 2] Deducting ELO -25, adding Games +1 for Loser (${loserUsername})`);
    const loserUpdate = await masterPool.query(
      'UPDATE users SET elo = elo - 25, games = games + 1 WHERE id = $1 RETURNING elo',
      [loserId]
    );
    newLoserElo = loserUpdate.rows[0].elo;
    stepsCompleted.push('step2_update_loser');

    // Step 3: Update Leaderboard in Redis
    console.log(`[Saga Step 3] Updating Redis Cache leaderboard for both players`);
    
    if (forceFailRedis) {
      throw new Error('Forced Redis failure simulation');
    }

    const token = req.headers['authorization'].split(' ')[1];

    // Call Ranking Service /leaderboard via REST for winner
    const winResponse = await fetch(`${RANKING_SERVICE_URL}/leaderboard`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ username: winnerUsername, elo: newWinnerElo })
    });
    if (!winResponse.ok) throw new Error('Failed to update winner on Redis leaderboard');

    // Call Ranking Service /leaderboard via REST for loser
    const loseResponse = await fetch(`${RANKING_SERVICE_URL}/leaderboard`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ username: loserUsername, elo: newLoserElo })
    });
    if (!loseResponse.ok) throw new Error('Failed to update loser on Redis leaderboard');

    stepsCompleted.push('step3_update_redis');

    console.log(`[Saga] Transaction completed successfully for match ${matchId}`);
    res.json({
      success: true,
      matchId,
      winner: { id: winnerId, elo: newWinnerElo },
      loser: { id: loserId, elo: newLoserElo }
    });

  } catch (error) {
    console.error(`[Saga Error] Transaction failed: ${error.message}. Starting compensating rollback transactions...`);

    // Perform Compensating (Rollback) Actions in reverse order
    for (let i = stepsCompleted.length - 1; i >= 0; i--) {
      const step = stepsCompleted[i];
      if (step === 'step2_update_loser') {
        console.log(`[Saga Rollback] Reverting Loser ELO back to ${originalLoserElo} and decrementing games`);
        await masterPool.query('UPDATE users SET elo = $1, games = games - 1 WHERE id = $2', [originalLoserElo, loserId]);
      } else if (step === 'step1_update_winner') {
        console.log(`[Saga Rollback] Reverting Winner ELO back to ${originalWinnerElo}, decrementing wins and games`);
        await masterPool.query('UPDATE users SET elo = $1, wins = wins - 1, games = games - 1 WHERE id = $2', [originalWinnerElo, winnerId]);
      }
    }

    console.log(`[Saga Rollback] Rollback completed. System state consistent.`);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Transaction failed and successfully rolled back.'
    });
  }
});

app.listen(REST_PORT, () => {
  console.log(`User REST Service running on port ${REST_PORT}`);
});

// --- gRPC Server Setup ---
const PROTO_PATH = path.join(__dirname, '../proto/user.proto');
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true
});
const userProto = grpc.loadPackageDefinition(packageDefinition).user;

// Reads go to Slave Pool for gRPC ELO query
async function getUserElo(call, callback) {
  const { userId } = call.request;
  try {
    const query = 'SELECT id, username, elo FROM users WHERE id = $1';
    const result = await slavePool.query(query, [userId]);
    if (result.rows.length === 0) {
      return callback({
        code: grpc.status.NOT_FOUND,
        details: "User not found"
      });
    }
    const user = result.rows[0];
    callback(null, {
      userId: user.id,
      username: user.username,
      elo: user.elo
    });
  } catch (err) {
    console.error('Error fetching ELO via gRPC:', err);
    callback({
      code: grpc.status.INTERNAL,
      details: "Internal database error"
    });
  }
}

const grpcServer = new grpc.Server();
grpcServer.addService(userProto.UserService.service, {
  getUserElo: getUserElo
});

const GRPC_PORT = process.env.GRPC_PORT || 50061;
grpcServer.bindAsync(`0.0.0.0:${GRPC_PORT}`, grpc.ServerCredentials.createInsecure(), (err, port) => {
  if (err) {
    console.error('Failed to bind gRPC server:', err);
    return;
  }
  console.log(`User gRPC Server running on port ${port}`);
});
