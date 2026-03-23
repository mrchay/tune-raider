const { spawn } = require('child_process');
const path = require('path');

// Start backend — pipe output and strip null bytes
const backend = spawn('node', ['src/backend/server.js'], {
  cwd: __dirname,
  stdio: ['ignore', 'pipe', 'pipe']
});

backend.stdout.on('data', (chunk) => {
  const clean = chunk.toString().replace(/\0/g, '').trim();
  if (clean) process.stdout.write(clean + '\n');
});
backend.stderr.on('data', (chunk) => {
  const clean = chunk.toString().replace(/\0/g, '').trim();
  if (clean) process.stderr.write(clean + '\n');
});

// Give backend a moment to start, then launch NW.js frontend
setTimeout(async () => {
  // Resolve NW.js binary path directly — avoids npx/shell inheriting console
  const { findpath } = await import('nw');
  const nwPath = await findpath();
  const frontendPath = path.join(__dirname, 'src', 'frontend');

  const frontend = spawn(nwPath, [frontendPath], {
    cwd: __dirname,
    stdio: 'ignore',
    detached: true
  });

  frontend.unref();

  frontend.on('exit', (code) => {
    console.log(`[dev] Frontend closed (code ${code}), shutting down.`);
    backend.kill();
    process.exit(0);
  });
}, 1000);

backend.on('close', (code) => {
  console.log(`[dev] Backend exited (code ${code})`);
});

process.on('SIGINT', () => {
  backend.kill();
  process.exit(0);
});
