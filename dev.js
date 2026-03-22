const { spawn } = require('child_process');
const path = require('path');

// Start backend — inherits stdio so all console.log output shows in this terminal
const backend = spawn('node', ['src/backend/server.js'], {
  cwd: __dirname,
  stdio: 'inherit'
});

// Give backend a moment to start, then launch NW.js frontend
setTimeout(() => {
  const frontend = spawn('npx', ['nw', 'src/frontend'], {
    cwd: __dirname,
    stdio: ['ignore', 'ignore', 'inherit'],  // only inherit stderr from NW.js
    shell: true
  });

  frontend.on('close', (code) => {
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
