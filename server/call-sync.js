const http = require('http');
const db = require('./db');
const { calcAdminToken, now } = require('./utils');
const { recordInterfaceLog } = require('./interface-log');
const logger = require('./logger');

let timer = null;
let draining = false;

function responseCode(code) {
  if (typeof code === 'number' && Number.isFinite(code)) return code;
  if (typeof code === 'string' && code.trim() !== '' && Number.isFinite(Number(code))) return Number(code);
  return null;
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 15000 }, (response) => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error('Invalid JSON response from device')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Call sync timed out')); });
  });
}

async function syncCallsFromDevice(devId, slot = 0) {
  const device = db.prepare('SELECT * FROM devices WHERE dev_id = ?').get(devId);
  if (!device) throw new Error('Device not found');
  if (!device.wifi_ip) throw new Error('Device has no known IP address');
  if (![0, 1, 2].includes(slot)) throw new Error('Invalid slot');

  let offset = 1;
  let pageSize = 20;
  const records = [];
  try {
    const token = calcAdminToken(device.admin_password);
    while (records.length < 50) {
      let response;
      let usedSize;
      for (const size of new Set([pageSize, 10, 5, 1])) {
        const params = new URLSearchParams({ token, cmd: 'querytel', p1: String(offset), p2: String(size) });
        if (slot) params.set('p5', String(slot));
        response = await httpGet(`http://${device.wifi_ip}/ctrl?${params}`);
        usedSize = size;
        if (responseCode(response?.code) !== null) break;
      }
      if (responseCode(response?.code) !== 0 || !Array.isArray(response.results)) {
        throw new Error(`querytel failed (code ${response?.code ?? 'unknown'}): ${response?.note || 'Empty or malformed response'}`);
      }
      records.push(...response.results.slice(0, Math.min(usedSize, 50 - records.length)));
      if (response.results.length <= usedSize) break;
      offset += usedSize;
      pageSize = usedSize;
    }

    const insert = db.prepare(`
      INSERT OR IGNORE INTO call_records
        (dev_id, slot, direction, phone, started_at, ended_at, connected, raw_json, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const ts = now();
    let saved = 0;
    db.transaction(() => {
      for (const record of records) {
        const startedAt = Number(record.telStartTs);
        if (!Number.isSafeInteger(startedAt) || startedAt <= 0) continue;
        saved += insert.run(
          devId, Number(record.slot || 0), Number(record.dir || 0), String(record.phNum || ''),
          startedAt, Number(record.telEndTs || 0), Number(record.conn || 0) ? 1 : 0,
          JSON.stringify(record), ts
        ).changes;
      }
    })();
    recordInterfaceLog({
      dev_id: devId, protocol: 'device-http', direction: 'out', endpoint: '/ctrl', method: 'GET',
      status: 'ok', request_summary: `cmd=querytel slot=${slot || 'all'}`,
      response_summary: `pulled=${records.length} saved=${saved}`, request_raw: { cmd: 'querytel', slot },
      response_raw: { total_pulled: records.length, saved }, remote_addr: device.wifi_ip
    });
    return { success: true, total_pulled: records.length, saved, skipped: records.length - saved };
  } catch (err) {
    recordInterfaceLog({
      dev_id: devId, protocol: 'device-http', direction: 'out', endpoint: '/ctrl', method: 'GET',
      status: 'failed', request_summary: `cmd=querytel offset=${offset}`,
      response_summary: err.message, request_raw: { cmd: 'querytel', offset, slot }, remote_addr: device.wifi_ip
    });
    throw err;
  }
}

function scheduleCallSync(devId) {
  if (!devId) return;
  const dueAt = now() + 20;
  db.prepare(`
    INSERT INTO call_sync_jobs (dev_id, due_at) VALUES (?, ?)
    ON CONFLICT(dev_id) DO UPDATE SET due_at = MIN(call_sync_jobs.due_at, excluded.due_at)
  `).run(devId, dueAt);
}

async function drainCallSyncJobs() {
  if (draining) return;
  draining = true;
  try {
    const jobs = db.prepare('SELECT * FROM call_sync_jobs WHERE due_at <= ? ORDER BY due_at LIMIT 3').all(now());
    for (const job of jobs) {
      try {
        const result = await syncCallsFromDevice(job.dev_id);
        db.prepare('DELETE FROM call_sync_jobs WHERE dev_id = ?').run(job.dev_id);
        logger.info('call-sync', 'Automatic call sync completed', { devId: job.dev_id, pulled: result.total_pulled, saved: result.saved });
      } catch (err) {
        const attempts = job.attempts + 1;
        const delay = Math.min(3600, 30 * 2 ** Math.min(attempts, 7));
        db.prepare('UPDATE call_sync_jobs SET attempts = ?, due_at = ?, last_error = ? WHERE dev_id = ?')
          .run(attempts, now() + delay, String(err.message).slice(0, 500), job.dev_id);
        logger.warn('call-sync', 'Automatic call sync will retry', { devId: job.dev_id, attempts, retryInSeconds: delay, error: err.message });
      }
    }
  } finally {
    draining = false;
  }
}

function startCallSyncWorker() {
  if (timer) return;
  timer = setInterval(() => drainCallSyncJobs().catch(err => logger.error('call-sync', 'Worker failed', { error: err.message })), 10000);
  setImmediate(() => drainCallSyncJobs().catch(err => logger.error('call-sync', 'Worker failed', { error: err.message })));
}

function stopCallSyncWorker() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

module.exports = { syncCallsFromDevice, scheduleCallSync, drainCallSyncJobs, startCallSyncWorker, stopCallSyncWorker };
