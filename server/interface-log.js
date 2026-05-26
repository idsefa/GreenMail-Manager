const db = require('./db');
const { now } = require('./utils');

const insertLog = db.prepare(`
  INSERT INTO interface_logs (
    dev_id, protocol, direction, endpoint, method, status,
    request_summary, response_summary, request_raw, response_raw,
    remote_addr, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

function normalizeText(value, maxLength = 4000) {
  if (value === undefined || value === null) return '';

  let text;
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }

  if (text.length > maxLength) {
    return text.slice(0, maxLength);
  }
  return text;
}

function recordInterfaceLog(entry = {}) {
  try {
    insertLog.run(
      normalizeText(entry.dev_id),
      normalizeText(entry.protocol),
      normalizeText(entry.direction),
      normalizeText(entry.endpoint),
      normalizeText(entry.method),
      normalizeText(entry.status || 'ok'),
      normalizeText(entry.request_summary),
      normalizeText(entry.response_summary),
      normalizeText(entry.request_raw),
      normalizeText(entry.response_raw),
      normalizeText(entry.remote_addr),
      entry.created_at || now()
    );
  } catch (err) {
    console.error('Error recording interface log:', err.message);
  }
}

module.exports = { recordInterfaceLog, normalizeText };