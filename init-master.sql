-- Create replication user
CREATE ROLE repl_user WITH REPLICATION PASSWORD 'repl_password' LOGIN;

-- Create users table
CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(50) PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  elo INT DEFAULT 1000
);
