const { spawn } = require('child_process');
const path = require('path');

const services = [
  { name: 'User Service', dir: './user-service', cmd: 'node', args: ['index.js'], env: { REST_PORT: '4002', GRPC_PORT: '50061' } },
  { name: 'Login Service 1', dir: './login-service', cmd: 'node', args: ['index.js'], env: { PORT: '4001' } },
  { name: 'Login Service 2', dir: './login-service', cmd: 'node', args: ['index.js'], env: { PORT: '4011' } },
  { name: 'Matchmaking Service', dir: './matchmaking-service', cmd: 'node', args: ['index.js'], env: { PORT: '50062' } },
  { name: 'Ranking Service', dir: './ranking-service', cmd: 'node', args: ['index.js'], env: { PORT: '4003' } }
];

const processes = [];

services.forEach(service => {
  console.log(`Starting ${service.name}...`);
  const proc = spawn(service.cmd, service.args, {
    cwd: path.resolve(__dirname, service.dir),
    shell: true,
    env: { ...process.env, ...service.env } // Merge custom environment variables
  });

  proc.stdout.on('data', (data) => {
    console.log(`[${service.name}] ${data.toString().trim()}`);
  });

  proc.stderr.on('data', (data) => {
    console.error(`[${service.name} ERROR] ${data.toString().trim()}`);
  });

  proc.on('close', (code) => {
    console.log(`[${service.name}] process exited with code ${code}`);
  });

  processes.push(proc);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down all services...');
  processes.forEach(proc => proc.kill());
  process.exit(0);
});
