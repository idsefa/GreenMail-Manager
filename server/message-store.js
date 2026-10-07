const crypto = require('crypto');
const db = require('./db');
const { now } = require('./utils');
const { isBetterSmsContent, areLikelySameSms } = require('./sms-quality');

const insertMessage = db.prepare(`
  INSERT INTO messages (dev_id, type, slot, phone, content, raw_json, received_at, msg_ts, dedupe_key)
  VALUES (@devId, @type, @slot, @phone, @content, @rawJson, @receivedAt, @msgTs, @dedupeKey)
`);
const findDedup = db.prepare('SELECT message_id FROM message_dedup WHERE dedupe_key = ?');
const findSms = db.prepare(`
  SELECT id, content FROM messages
  WHERE dev_id = ? AND type = ? AND slot = ? AND phone = ? AND msg_ts = ? AND msg_ts > 0
`);
const insertDedup = db.prepare(`
  INSERT INTO message_dedup (dedupe_key, dev_id, message_id, first_seen_at, last_seen_at)
  VALUES (?, ?, ?, ?, ?)
`);
const touchDedup = db.prepare(`
  UPDATE message_dedup
  SET last_seen_at = ?, duplicate_count = duplicate_count + 1
  WHERE dedupe_key = ?
`);
const improveSms = db.prepare('UPDATE messages SET content = ?, raw_json = ? WHERE id = ?');

function improveSmsIfUseful(id, record) {
  if (record.type !== 501 && record.type !== 502) return false;
  const existing = db.prepare('SELECT content FROM messages WHERE id = ?').get(id);
  if (existing && isBetterSmsContent(existing.content, record.content)) {
    improveSms.run(record.content, record.rawJson, id);
    return true;
  }
  return false;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizePhone(value) {
  return String(value || '').trim().replace(/[\s\-()]/g, '');
}

function getExternalId(message = {}) {
  return message.msgId || message.messageId || message.eventId || message.event_id || message.smsId || message.smsIndex || '';
}

function createDedupeKey(record) {
  const { devId, type, slot, phone, msgTs, message = {} } = record;
  if ((type === 501 || type === 502) && msgTs > 0) {
    return `sms2:${hash([devId, type, slot, normalizePhone(phone), msgTs, record.content].join('|'))}`;
  }
  const externalId = getExternalId(message);
  if (externalId !== '') {
    return `event:${hash([devId, type, externalId].join('|'))}`;
  }
  return `payload:${hash(stableStringify(message))}`;
}

function normalizeRecord(record = {}) {
  const message = record.message || {};
  const rawJson = typeof record.rawJson === 'string' ? record.rawJson : stableStringify(record.rawJson || message);
  const normalized = {
    devId: String(record.devId || message.devId || ''),
    type: Number(record.type),
    slot: Number(record.slot || 0),
    phone: String(record.phone || ''),
    content: String(record.content || ''),
    rawJson,
    receivedAt: Number(record.receivedAt || now()),
    msgTs: Number(record.msgTs || 0),
    message,
  };
  normalized.dedupeKey = record.dedupeKey || createDedupeKey(normalized);
  return normalized;
}

const storeMessageTransaction = db.transaction((input) => {
  const record = normalizeRecord(input);
  const ts = now();
  const known = findDedup.get(record.dedupeKey);
  if (known) {
    touchDedup.run(ts, record.dedupeKey);
    const improved = improveSmsIfUseful(known.message_id, record);
    return { id: Number(known.message_id), duplicate: true, improved, dedupeKey: record.dedupeKey };
  }

  // Databases created before the dedup table may already contain this SMS.
  if ((record.type === 501 || record.type === 502) && record.msgTs > 0) {
    const existingSms = findSms.all(record.devId, record.type, record.slot, record.phone, record.msgTs)
      .find((candidate) => areLikelySameSms(candidate.content, record.content));
    if (existingSms) {
      const improved = improveSmsIfUseful(existingSms.id, record);
      insertDedup.run(record.dedupeKey, record.devId, existingSms.id, ts, ts);
      return { id: Number(existingSms.id), duplicate: true, improved, dedupeKey: record.dedupeKey };
    }
  }

  const result = insertMessage.run(record);
  const id = Number(result.lastInsertRowid);
  insertDedup.run(record.dedupeKey, record.devId, id, ts, ts);
  return { id, duplicate: false, dedupeKey: record.dedupeKey };
});

function storeMessage(record) {
  return storeMessageTransaction(record);
}

function deleteDeviceMessageData(devId) {
  const remove = db.transaction((id) => {
    db.prepare('DELETE FROM inbound_queue WHERE dev_id = ?').run(id);
    db.prepare('DELETE FROM message_dedup WHERE dev_id = ?').run(id);
    return db.prepare('DELETE FROM messages WHERE dev_id = ?').run(id).changes;
  });
  return remove(devId);
}

module.exports = { storeMessage, createDedupeKey, deleteDeviceMessageData };
