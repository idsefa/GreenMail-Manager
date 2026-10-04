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
const systemLogsRouter = require('./routes/system-logs');
const batchRouter = require('./routes/batch');
const deviceOpsRouter = require('./routes/device-ops');
const { createTcpServer } = require('./tcp-server');
const { initWebSocket, broadcast } = require('./ws');
const { startMessageQueue, stopMessageQueue, cleanupDeadLetters, getQueueStats } = require('./message-queue');
const logger = require('./logger');

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
  res.json({ status: 'ok', time: now(), queue: getQueueStats() });
});

// API Routes
app.use('/api/webhook', webhookRouter);
app.use('/api/devices', devicesRouter);
app.use('/api/messages', messagesRouter);
app.use('/api/commands', commandsRouter);
app.use('/api/push-rules', pushRulesRouter);
app.use('/api/interface-logs', interfaceLogsRouter);
app.use('/api/system-logs', systemLogsRouter);
app.use('/api/batch', batchRouter);
app.use('/api/devices', deviceOpsRouter);

// Serve static frontend files (built React app)
const staticDir = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(staticDir));

// SPA fallback - serve index.html for all non-API routes
app.get('*', (req, res) => {
  res.sendFile(path.join(staticDir, 'index.html'));
});

const RETENTION_DAYS = Math.max(1, Number(process.env.LOG_RETENTION_DAYS || 30));

function runMaintenance() {
  try {
    const application = logger.cleanupLogs();
    const interfaceLogs = db.prepare('DELETE FROM interface_logs WHERE created_at < ?').run(now() - RETENTION_DAYS * 86400).changes;
    const deadLetters = cleanupDeadLetters(process.env.DEAD_LETTER_RETENTION_DAYS || RETENTION_DAYS);
    if (application || interfaceLogs || deadLetters) {
      logger.info('maintenance', 'Expired operational records removed', { application, interfaceLogs, deadLetters });
    }
  } catch (err) {
    logger.error('maintenance', 'Retention cleanup failed', { error: err.message });
  }
}

runMaintenance();
setInterval(runMaintenance, 86400000).unref();

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
    logger.error('monitor', 'Online status check failed', { error: err.message });
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
    logger.error('monitor', 'Device ping polling failed', { error: err.message });
  } finally {
    pollingInProgress = false;
  }
}

setInterval(() => {
  pollDevicesPing();
}, PING_POLL_INTERVAL);

// Start servers
startMessageQueue();

const httpServer = app.listen(HTTP_PORT, () => {
  logger.info('server', 'HTTP server listening', { port: HTTP_PORT });
  logger.info('server', 'Web UI available', { url: `http://localhost:${HTTP_PORT}` });
});

// Attach WebSocket to HTTP server
initWebSocket(httpServer);

const tcpServer = createTcpServer(TCP_PORT);

// Graceful shutdown
let shutdownStarted = false;
function shutdown(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  logger.info('server', 'Shutdown started', { signal });
  stopMessageQueue();
  let remaining = 2;
  const finish = () => {
    remaining -= 1;
    if (remaining === 0) {
      logger.info('server', 'Shutdown completed');
      db.close();
      process.exit(0);
    }
  };
  httpServer.close(finish);
  tcpServer.close(finish);
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

logger.info('server', 'GreenMail Manager started successfully');
