const db = require('./db');
const { now } = require('./utils');

const MAX_CONTEXT_LENGTH = 8000;
const LOG_RETENTION_DAYS = Math.max(1, Number(process.env.LOG_RETENTION_DAYS || 30));

const insertLog = db.prepare(`
  INSERT INTO application_logs (level, scope, message, context, created_at)
  VALUES (?, ?, ?, ?, ?)
`);

function toContext(value) {
  if (value === undefined || value === null) return '';
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return text.length > MAX_CONTEXT_LENGTH ? text.slice(0, MAX_CONTEXT_LENGTH) : text;
}

function write(level, scope, message, context) {
  const normalizedLevel = ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info';
  const normalizedScope = String(scope || 'app').slice(0, 100);
  const normalizedMessage = String(message || '').slice(0, 2000);
  const serializedContext = toContext(context);

  try {
    insertLog.run(normalizedLevel, normalizedScope, normalizedMessage, serializedContext, now());
  } catch (err) {
    // Logging must never prevent ingestion; retain a process-level fallback.
    console.error(`[${normalizedScope}] unable to persist log: ${err.message}`);
  }

  const output = `[${normalizedScope}] ${normalizedMessage}`;
  if (normalizedLevel === 'error') console.error(output);
  else if (normalizedLevel === 'warn') console.warn(output);
  else console.log(output);
}

function cleanupLogs() {
  const cutoff = now() - Math.floor(LOG_RETENTION_DAYS * 86400);
  return db.prepare('DELETE FROM application_logs WHERE created_at < ?').run(cutoff).changes;
}

module.exports = {
  debug: (scope, message, context) => write('debug', scope, message, context),
  info: (scope, message, context) => write('info', scope, message, context),
  warn: (scope, message, context) => write('warn', scope, message, context),
  error: (scope, message, context) => write('error', scope, message, context),
  cleanupLogs,
};
