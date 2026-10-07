const express = require('express');
const helmet = require('helmet');
const path = require('path');
const { now, isDeviceOnline } = require('./utils');
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
const callRecordsRouter = require('./routes/call-records');
const recordingsRouter = require('./routes/recordings');
const { createTcpServer } = require('./tcp-server');
const { initWebSocket, broadcast } = require('./ws');
const { startMessageQueue, stopMessageQueue, cleanupDeadLetters, getQueueStats } = require('./message-queue');
const { startWatchdog, stopWatchdog } = require('./watchdog');
const logger = require('./logger');
const { startPushWorker, stopPushWorker } = require('./push-engine');
const { startCallSyncWorker, stopCallSyncWorker } = require('./call-sync');

const app = express();
const HTTP_PORT = parseInt(process.env.PORT || '3000');
const HTTP_HOST = process.env.HTTP_HOST || '0.0.0.0';
const TCP_PORT = parseInt(process.env.TCP_PORT || '3888');

// Middleware
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
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
app.use('/api/call-records', callRecordsRouter);
app.use('/api/recordings', recordingsRouter);
app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint not found' }));

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
    const onlineCount = devices.filter(d => isDeviceOnline(d.last_ping_at, d.ping_intvl)).length;
    broadcast('device_stats', { totalDevices, onlineCount });
  } catch (err) {
    logger.error('monitor', 'Online status check failed', { error: err.message });
  }
}

setInterval(checkOnlineStatus, 30000);

startMessageQueue();
startPushWorker();
startCallSyncWorker();
startWatchdog();

const httpServer = app.listen(HTTP_PORT, HTTP_HOST, () => {
  logger.info('server', 'HTTP server listening', { host: HTTP_HOST, port: HTTP_PORT });
  logger.info('server', 'Web UI available', { url: `http://${HTTP_HOST}:${HTTP_PORT}` });
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
  stopPushWorker();
  stopCallSyncWorker();
  stopWatchdog();
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
