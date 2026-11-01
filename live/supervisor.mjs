// Chánh Điện Tịnh Tâm — Background Supervisor & Watchdog Service
// Ensures server.mjs runs continuously, restarts on crash, auto-recovers after sleep,
// prevents duplicate instances, and logs all events cleanly.

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

const SUPERVISOR_LOG = path.join(LOG_DIR, 'supervisor.log');
const SERVER_LOG = path.join(LOG_DIR, 'server.log');
const PID_FILE = path.join(LOG_DIR, 'supervisor.pid');
const PORT = +process.env.PORT || 3000;
const HEALTH_URL = `http://127.0.0.1:${PORT}/live/overlay.html`;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    fs.appendFileSync(SUPERVISOR_LOG, line, 'utf8');
  } catch {}
  process.stdout.write(line);
}

// Ensure single supervisor instance
try {
  if (fs.existsSync(PID_FILE)) {
    const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf8'), 10);
    if (!isNaN(oldPid) && oldPid !== process.pid) {
      try {
        process.kill(oldPid, 0); // Check if process is still alive
        log(`Another supervisor instance is already running (PID: ${oldPid}). Exiting.`);
        process.exit(0);
      } catch (e) {
        // Process is dead, proceed
      }
    }
  }
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
} catch (e) {
  log(`Warning: Failed to write PID file: ${e.message}`);
}

process.on('exit', () => {
  try {
    if (fs.existsSync(PID_FILE) && fs.readFileSync(PID_FILE, 'utf8') === String(process.pid)) {
      fs.unlinkSync(PID_FILE);
    }
  } catch {}
});

let child = null;
let restartHistory = [];
let isShuttingDown = false;

function checkHealth() {
  return new Promise((resolve) => {
    const req = http.get(HEALTH_URL, { timeout: 4000 }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 400);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

function startServer() {
  if (isShuttingDown) return;

  const now = Date.now();
  restartHistory = restartHistory.filter((t) => now - t < 60000);
  if (restartHistory.length >= 8) {
    log(`[WATCHDOG] Too many restarts (${restartHistory.length} in 60s). Throttling 20s before retry...`);
    setTimeout(startServer, 20000);
    return;
  }
  restartHistory.push(now);

  log(`[SUPERVISOR] Starting server.mjs (port ${PORT})...`);

  // Open log stream for server output
  const out = fs.openSync(SERVER_LOG, 'a');
  const err = fs.openSync(SERVER_LOG, 'a');

  child = spawn(process.execPath, ['server.mjs'], {
    cwd: __dirname,
    env: { ...process.env, NODE_ENV: 'production', PORT: String(PORT) },
    stdio: ['ignore', out, err],
    windowsHide: true
  });

  log(`[SUPERVISOR] Spawned server.mjs with PID: ${child.pid}`);

  child.on('exit', (code, signal) => {
    log(`[SUPERVISOR] server.mjs exited with code ${code}, signal ${signal}.`);
    child = null;
    try {
      fs.closeSync(out);
      fs.closeSync(err);
    } catch {}

    if (!isShuttingDown) {
      log(`[WATCHDOG] Restarting server in 2.5s...`);
      setTimeout(startServer, 2500);
    }
  });

  child.on('error', (err) => {
    log(`[ERROR] Failed to start server.mjs: ${err.message}`);
  });
}

// Watchdog periodic health-check
let consecutiveFailures = 0;
setInterval(async () => {
  if (isShuttingDown || !child) return;

  const ok = await checkHealth();
  if (ok) {
    if (consecutiveFailures > 0) {
      log(`[WATCHDOG] Server recovered and healthy.`);
    }
    consecutiveFailures = 0;
  } else {
    consecutiveFailures++;
    log(`[WATCHDOG] Health check failed (${consecutiveFailures}/3) at ${HEALTH_URL}`);
    if (consecutiveFailures >= 3) {
      log(`[WATCHDOG] Server unresponsive for 3 consecutive checks. Terminating PID ${child.pid}...`);
      consecutiveFailures = 0;
      try {
        child.kill('SIGTERM');
        setTimeout(() => {
          if (child) {
            try { child.kill('SIGKILL'); } catch {}
          }
        }, 3000);
      } catch (e) {
        log(`[ERROR] Failed killing child: ${e.message}`);
      }
    }
  }
}, 15000);

// Sleep & Wake resilience detection
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const delta = now - lastTick;
  lastTick = now;

  // If clock jumped forward > 12 seconds in a 4-second interval, computer was in sleep/hibernation
  if (delta > 12000) {
    log(`[SLEEP/RESUME] System resume detected (clock delta: ${delta}ms). Verifying server status...`);
    checkHealth().then((healthy) => {
      if (!healthy) {
        log(`[SLEEP/RESUME] Server did not survive sleep. Restarting immediately...`);
        if (child) {
          try { child.kill('SIGKILL'); } catch {}
        } else {
          startServer();
        }
      } else {
        log(`[SLEEP/RESUME] Server is running normally after system wake.`);
      }
    });
  }
}, 4000);

function shutdown() {
  isShuttingDown = true;
  log(`[SUPERVISOR] Shutting down supervisor...`);
  if (child) {
    try {
      child.kill('SIGTERM');
    } catch {}
  }
  setTimeout(() => process.exit(0), 1000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

log(`=== Chanh Dien Tinh Tam Supervisor Started (PID: ${process.pid}) ===`);
startServer();
