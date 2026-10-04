const db = require('./db');
const { now } = require('./utils');
const logger = require('./logger');

const BATCH_SIZE = clamp(process.env.MESSAGE_QUEUE_BATCH_SIZE, 1, 500, 50);
const MAX_QUEUE_SIZE = clamp(process.env.MESSAGE_QUEUE_MAX_SIZE, 100, 100000, 10000);
const MAX_ATTEMPTS = clamp(process.env.MESSAGE_QUEUE_MAX_ATTEMPTS, 1, 100, 8);
const POLL_INTERVAL = clamp(process.env.MESSAGE_QUEUE_POLL_INTERVAL, 100, 60000, 1000);

let draining = false;
let poller = null;
let scheduled = false;

const insertQueueItem = db.prepare(`
  INSERT INTO inbound_queue (dev_id, transport, remote_addr, payload, received_at, available_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);

class QueueFullError extends Error {
  constructor() {
    super('Inbound queue is full');
    this.name = 'QueueFullError';
  }
}

function clamp(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.floor(parsed))) : fallback;
}

function pendingCount() {
  return db.prepare("SELECT COUNT(*) AS count FROM inbound_queue WHERE status IN ('pending', 'retry')").get().count;
}

function enqueueMessage(message, metadata = {}) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new TypeError('Inbound payload must be an object');
  }
  if (pendingCount() >= MAX_QUEUE_SIZE) {
    throw new QueueFullError();
  }

  const ts = now();
  const result = insertQueueItem.run(
    String(message.devId || ''),
    String(metadata.transport || ''),
    String(metadata.remoteAddr || ''),
    JSON.stringify(message),
    ts,
    ts
  );
  scheduleDrain();
  return Number(result.lastInsertRowid);
}

function scheduleDrain() {
  if (scheduled || draining) return;
  scheduled = true;
  setImmediate(() => {
    scheduled = false;
    drainQueue();
  });
}

function retryDelay(attempts) {
  return Math.min(300, Math.pow(2, Math.min(attempts, 8)) * 2);
}

function drainQueue() {
  if (draining) return;
  draining = true;

  try {
    const rows = db.prepare(`
      SELECT id, payload, attempts, transport, remote_addr
      FROM inbound_queue
      WHERE status IN ('pending', 'retry') AND available_at <= ?
      ORDER BY id ASC
      LIMIT ?
    `).all(now(), BATCH_SIZE);

    const { processMessage } = require('./message-handler');
    for (const row of rows) {
      try {
        const result = processMessage(JSON.parse(row.payload));
        db.prepare('DELETE FROM inbound_queue WHERE id = ?').run(row.id);
        if (result.duplicate) {
          logger.debug('queue', 'Duplicate message consumed', { queueId: row.id, transport: row.transport });
        }
      } catch (err) {
        const attempts = row.attempts + 1;
        const permanent = Boolean(err && err.permanent);
        if (permanent || attempts >= MAX_ATTEMPTS) {
          db.prepare("UPDATE inbound_queue SET attempts = ?, status = 'dead', last_error = ? WHERE id = ?")
            .run(attempts, String(err.message || err).slice(0, 2000), row.id);
          logger.error('queue', 'Message moved to dead letter queue', {
            queueId: row.id, attempts, transport: row.transport, remoteAddr: row.remote_addr, error: err.message
          });
        } else {
          const delay = retryDelay(attempts);
          db.prepare("UPDATE inbound_queue SET attempts = ?, status = 'retry', available_at = ?, last_error = ? WHERE id = ?")
            .run(attempts, now() + delay, String(err.message || err).slice(0, 2000), row.id);
          logger.warn('queue', 'Message processing failed; retry scheduled', {
            queueId: row.id, attempts, retryInSeconds: delay, error: err.message
          });
        }
      }
    }
  } finally {
    draining = false;
  }

  const ready = db.prepare("SELECT COUNT(*) AS count FROM inbound_queue WHERE status IN ('pending', 'retry') AND available_at <= ?").get(now()).count;
  if (ready > 0) scheduleDrain();
}

function startMessageQueue() {
  if (poller) return;
  poller = setInterval(drainQueue, POLL_INTERVAL);
  scheduleDrain();
  logger.info('queue', 'Persistent message queue started', { batchSize: BATCH_SIZE, maxSize: MAX_QUEUE_SIZE });
}

function stopMessageQueue() {
  if (!poller) return;
  clearInterval(poller);
  poller = null;
}

function getQueueStats() {
  const rows = db.prepare('SELECT status, COUNT(*) AS count FROM inbound_queue GROUP BY status').all();
  const counts = { pending: 0, retry: 0, dead: 0 };
  for (const row of rows) counts[row.status] = row.count;
  const oldest = db.prepare("SELECT received_at FROM inbound_queue WHERE status IN ('pending', 'retry') ORDER BY id ASC LIMIT 1").get();
  return { ...counts, maxSize: MAX_QUEUE_SIZE, oldestPendingAt: oldest?.received_at || 0 };
}

function cleanupDeadLetters(retentionDays = 30) {
  const cutoff = now() - Math.max(1, Number(retentionDays) || 30) * 86400;
  return db.prepare("DELETE FROM inbound_queue WHERE status = 'dead' AND received_at < ?").run(cutoff).changes;
}

module.exports = {
  enqueueMessage,
  startMessageQueue,
  stopMessageQueue,
  getQueueStats,
  cleanupDeadLetters,
  QueueFullError,
};
