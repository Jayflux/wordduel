const express = require('express');
const cors = require('cors');
const { createClient } = require('redis');

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 4003;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// Setup Redis Client
const redisClient = createClient({ url: REDIS_URL });

redisClient.on('error', (err) => console.error('Redis Client Error', err));

async function connectRedis() {
  try {
    await redisClient.connect();
    console.log('Connected to Redis Cache');
  } catch (err) {
    console.error('Error connecting to Redis, retrying in 5s...', err.message);
    setTimeout(connectRedis, 5000);
  }
}
connectRedis();

const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'supersecretkey_wordduel';

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

// POST /leaderboard: Update a player's rating on the leaderboard (Protected)
app.post('/leaderboard', authenticateToken, async (req, res) => {
  const { username, elo } = req.body;
  if (!username || elo === undefined) {
    return res.status(400).json({ error: 'username and elo are required' });
  }

  try {
    // Redis ZADD: Add or update the member's score
    await redisClient.zAdd('leaderboard', {
      score: parseInt(elo, 10),
      value: username
    });
    console.log(`Leaderboard updated: ${username} -> ${elo}`);
    res.json({ message: 'Leaderboard updated successfully' });
  } catch (err) {
    console.error('Error updating Redis leaderboard:', err);
    res.status(500).json({ error: 'Internal cache error' });
  }
});

// GET /leaderboard: Get the top players from the leaderboard
app.get('/leaderboard', async (req, res) => {
  try {
    // Redis ZRANGE with REV option: Get top 10 elements (index 0 to 9) sorted descending
    const leaderboard = await redisClient.zRangeWithScores('leaderboard', 0, 9, {
      REV: true
    });

    const formattedLeaderboard = leaderboard.map((item, index) => ({
      rank: index + 1,
      username: item.value,
      elo: item.score
    }));

    res.json(formattedLeaderboard);
  } catch (err) {
    console.error('Error reading Redis leaderboard:', err);
    res.status(500).json({ error: 'Internal cache error' });
  }
});

app.listen(PORT, () => {
  console.log(`Ranking Service running on port ${PORT}`);
});
