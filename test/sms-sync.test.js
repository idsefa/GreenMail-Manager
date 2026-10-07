const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'greenmail-sms-sync-test-'));
const db = require('../server/db');
const deviceOps = require('../server/routes/device-ops');

test('querysms reads all 100 device records without repeating page boundaries', async (t) => {
  const offsets = [];
  const sms = Array.from({ length: 100 }, (_, i) => ({
    slot: 1, dir: 0, phNum: '10010', smsBd: `Message ${i + 1}`, smsTs: 1791000000 + i
  }));
  const mock = http.createServer((req, res) => {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const offset = Number(params.get('p1'));
    const limit = Number(params.get('p2'));
    offsets.push(offset);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ code: 0, results: sms.slice(offset - 1, offset + limit) }));
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => mock.close(resolve)));

  db.prepare('INSERT INTO devices (dev_id, wifi_ip) VALUES (?, ?)')
    .run('sms-sync-test', `127.0.0.1:${mock.address().port}`);
  const app = express();
  app.use(express.json());
  app.use('/api/devices', deviceOps);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/devices/sms-sync-test/sync-sms`;

  const first = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).saved, 100);
  assert.deepEqual(offsets, [1, 21, 41, 61, 81]);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 100);
  assert.equal(db.prepare('SELECT content FROM messages WHERE msg_ts = ?').get(1791000099).content, 'Message 100');

  const second = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal((await second.json()).saved, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 100);
});
