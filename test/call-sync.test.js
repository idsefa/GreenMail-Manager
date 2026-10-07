const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'greenmail-call-sync-test-'));
const db = require('../server/db');
const { scheduleCallSync, drainCallSyncJobs, syncCallsFromDevice } = require('../server/call-sync');

test('call sync job persists and deduplicates paginated device history', async (t) => {
  const records = Array.from({ length: 25 }, (_, i) => ({
    slot: 1, dir: i % 2, phNum: '13800138000',
    telStartTs: 1791000000 + i, telEndTs: 1791000060 + i, conn: 1
  }));
  const mock = http.createServer((req, res) => {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const offset = Number(params.get('p1'));
    const limit = Number(params.get('p2'));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ code: 0, results: records.slice(offset - 1, offset + limit) }));
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => mock.close(resolve)));
  db.prepare('INSERT INTO devices (dev_id, wifi_ip) VALUES (?, ?)')
    .run('call-sync-test', `127.0.0.1:${mock.address().port}`);

  scheduleCallSync('call-sync-test');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM call_sync_jobs').get().count, 1);
  db.prepare('UPDATE call_sync_jobs SET due_at = 0').run();
  await drainCallSyncJobs();
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM call_sync_jobs').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM call_records').get().count, 25);

  const repeated = await syncCallsFromDevice('call-sync-test');
  assert.equal(repeated.saved, 0);
  assert.equal(repeated.skipped, 25);
});
