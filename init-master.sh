#!/bin/sh
set -e

# Add replication permission to pg_hba.conf
echo "host replication repl_user 0.0.0.0/0 md5" >> "$PGDATA/pg_hba.conf"

# Create the replication role and schema
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<EOSQL
CREATE ROLE repl_user WITH REPLICATION PASSWORD 'repl_password' LOGIN;
CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(50) PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  elo INT DEFAULT 1000
);
EOSQL

