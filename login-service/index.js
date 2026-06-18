const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 4001;
const JWT_SECRET = process.env.JWT_SECRET || 'supersecretkey_wordduel';
const USER_SERVICE_URL = process.env.USER_SERVICE_URL || 'http://localhost:4002';

// Register Endpoint
app.post('/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  try {
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // Call User Service to create the user
    const response = await fetch(`${USER_SERVICE_URL}/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, passwordHash })
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: data.error || 'Failed to create user' });
    }

    res.status(201).json({ message: 'User registered successfully', userId: data.id });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Login Endpoint
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  try {
    // Call User Service to get user by username
    const response = await fetch(`${USER_SERVICE_URL}/users/by-username?username=${encodeURIComponent(username)}`);
    if (!response.ok) {
      if (response.status === 404) {
        return res.status(401).json({ error: 'Invalid username or password' });
      }
      return res.status(500).json({ error: 'Failed to fetch user credentials' });
    }

    const user = await response.json();
    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '1h' });

    res.json({ message: 'Login successful', token, userId: user.id });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Verify JWT Token Endpoint (Internal use or Client side)
app.post('/verify', (req, res) => {
  const { token } = req.body;
  if (!token) {
    return res.status(400).json({ error: 'Token is required' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    res.json({ valid: true, decoded });
  } catch (error) {
    res.status(401).json({ valid: false, error: 'Invalid or expired token' });
  }
});

app.listen(PORT, () => {
  console.log(`Login Service running on port ${PORT}`);
});
