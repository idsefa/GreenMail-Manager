const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const http = require('http');

const { now, isDeviceOnline, calcAdminToken } = require('./utils');
const db = require('./db');
const webhookRouter = require('./webhook');
const devicesRouter = require('./routes/devices');
const messagesRouter = require('./routes/messages');
const commandsRouter = require('./routes/commands');
const pushRulesRouter = require('./routes/push-routes');
const interfaceLogsRouter = require('./routes/interface-logs');
const batchRouter = require('./routes/batch');
const deviceOpsRouter = require('./routes/device-ops');
const { createTcpServer } = require('./tcp-server');
const { initWebSocket, broadcast } = require('./ws');

const app = express();
const HTTP_PORT = parseInt(process.env.PORT || '3000');
const TCP_PORT = parseInt(process.env.TCP_PORT || '3888');
const PING_POLL_INTERVAL = parseInt(process.env.PING_POLL_INTERVAL || '30000');

// Middleware
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: now() });
});

// API Routes
app.use('/api/webhook', webhookRouter);
app.use('/api/devices', devicesRouter);
app.use('/api/messages', messagesRouter);
app.use('/api/commands', commandsRouter);
app.use('/api/push-rules', pushRulesRouter);
app.use('/api/interface-logs', interfaceLogsRouter);
app.use('/api/batch', batchRouter);
app.use('/api/devices', deviceOpsRouter);

// Serve static frontend files (built React app)
const staticDir = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(staticDir));

// SPA fallback - serve index.html for all non-API routes
app.get('*', (req, res) => {
  res.sendFile(path.join(staticDir, 'index.html'));
});

// Background task: Check device online status every 30 seconds
function checkOnlineStatus() {
  try {
    const ts = now();
    const devices = db.prepare('SELECT dev_id, ping_intvl, last_ping_at, is_online FROM devices').all();

    const stmt = db.prepare('UPDATE devices SET is_online = 0, updated_at = ? WHERE dev_id = ?');

    for (const d of devices) {
      if (d.is_online && !isDeviceOnline(d.last_ping_at, d.ping_intvl)) {
        stmt.run(ts, d.dev_id);
        broadcast('device_update', { dev_id: d.dev_id, is_online: false });
      }
    }

    // Also broadcast current device stats
    const totalDevices = devices.length;
    const onlineCount = devices.filter(d => d.is_online).length;
    broadcast('device_stats', { totalDevices, onlineCount });
  } catch (err) {
    console.error('Error checking online status:', err.message);
  }
}

setInterval(checkOnlineStatus, 30000);

// Active polling: management side periodically sends ping to devices
function httpGet(url, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout }, (response) => {
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve({ raw: data });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

let pollingInProgress = false;
async function pollDevicesPing() {
  if (pollingInProgress) return;
  pollingInProgress = true;

  try {
    const ts = now();
    const devices = db.prepare('SELECT dev_id, wifi_ip, admin_password, ping_intvl, last_ping_at, is_online FROM devices').all();

    for (const d of devices) {
      if (!d.wifi_ip) continue;

      // Avoid over-polling: poll roughly by the device heartbeat interval
      const expectedIntvl = Math.max(20, Math.min(300, Number(d.ping_intvl || 110)));
      if (d.last_ping_at && (ts - d.last_ping_at) < expectedIntvl) continue;

      const token = calcAdminToken(d.admin_password || 'admin');
      const url = `http://${d.wifi_ip}/ctrl?token=${token}&cmd=ping`;

      try {
        const result = await httpGet(url, 8000);
        if (result && Number(result.code) === 0) {
          db.prepare('UPDATE devices SET last_ping_at = ?, is_online = 1, updated_at = ? WHERE dev_id = ?')
            .run(ts, ts, d.dev_id);
          if (!d.is_online) {
            broadcast('device_update', { dev_id: d.dev_id, is_online: true });
          }
        } else {
          db.prepare('UPDATE devices SET is_online = 0, updated_at = ? WHERE dev_id = ?')
            .run(ts, d.dev_id);
          if (d.is_online) {
            broadcast('device_update', { dev_id: d.dev_id, is_online: false });
          }
        }
      } catch {
        db.prepare('UPDATE devices SET is_online = 0, updated_at = ? WHERE dev_id = ?')
          .run(ts, d.dev_id);
        if (d.is_online) {
          broadcast('device_update', { dev_id: d.dev_id, is_online: false });
        }
      }
    }
  } catch (err) {
    console.error('Error polling device ping:', err.message);
  } finally {
    pollingInProgress = false;
  }
}

setInterval(() => {
  pollDevicesPing();
}, PING_POLL_INTERVAL);

// Start servers
const httpServer = app.listen(HTTP_PORT, () => {
  console.log(`HTTP server listening on port ${HTTP_PORT}`);
  console.log(`Web UI: http://localhost:${HTTP_PORT}`);
});

// Attach WebSocket to HTTP server
initWebSocket(httpServer);

const tcpServer = createTcpServer(TCP_PORT);

// Graceful shutdown
function shutdown(signal) {
  console.log(`\n${signal} received, shutting down...`);
  httpServer.close(() => console.log('HTTP server closed'));
  tcpServer.close(() => console.log('TCP server closed'));
  db.close();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

console.log('GreenMail Manager started successfully');
