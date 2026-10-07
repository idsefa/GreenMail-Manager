const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'greenmail-push-test-'));
const db = require('../server/db');
const { now } = require('../server/utils');
const { buildPushRequest, drainPushQueue } = require('../server/push-engine');

test('JSON push templates escape SMS content', () => {
  const request = buildPushRequest(
    { url: 'http://localhost/', method: 'POST', headers: '{"Content-Type":"application/json"}', body_template: '{"content":"{{content}}","type":{{type}}}' },
    { content: 'Say "hi"\n再见', type: 501 }
  );
  assert.deepEqual(JSON.parse(request.body), { content: 'Say "hi"\n再见', type: 501 });
});

test('pending push retries with a fresh request and can be drained after restart', async (t) => {
  let requests = 0;
  const mock = http.createServer((req, res) => {
    requests++;
    res.statusCode = requests === 1 ? 500 : 200;
    res.end('ok');
  });
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => mock.close(resolve)));

  const ts = now();
  const rule = db.prepare('INSERT INTO push_rules (name, url, body_template) VALUES (?, ?, ?)')
    .run('test', `http://127.0.0.1:${mock.address().port}/`, '{"content":"{{content}}"}');
  const message = db.prepare(`
    INSERT INTO messages (dev_id, type, slot, phone, content, raw_json, received_at, msg_ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('push-test', 501, 1, '10010', 'Say "hi"', '{}', ts, ts);
  const log = db.prepare(`
    INSERT INTO push_logs (rule_id, message_id, status, attempts, next_attempt_at, created_at)
    VALUES (?, ?, 'pending', 0, 0, ?)
  `).run(rule.lastInsertRowid, message.lastInsertRowid, ts);

  await drainPushQueue();
  assert.equal(db.prepare('SELECT attempts, status FROM push_logs WHERE id = ?').get(log.lastInsertRowid).attempts, 1);
  db.prepare('UPDATE push_logs SET next_attempt_at = 0 WHERE id = ?').run(log.lastInsertRowid);
  await drainPushQueue();
  assert.deepEqual(db.prepare('SELECT attempts, status FROM push_logs WHERE id = ?').get(log.lastInsertRowid), { attempts: 2, status: 'success' });
  assert.equal(requests, 2);
});
