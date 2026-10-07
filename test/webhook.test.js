const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'greenmail-webhook-test-'));
const db = require('../server/db');
const webhook = require('../server/webhook');

test('webhook rejects invalid events and preserves literal percent escapes', async (t) => {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use('/api/webhook', webhook);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/webhook`;

  assert.equal((await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 400);
  assert.equal((await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ devId: 'test-device', type: '' }) })).status, 400);
  assert.equal((await fetch(`${base}?devId=test-device`)).status, 400);
  const valid = await fetch(base, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ devId: 'test-device', type: '501', smsBd: 'Literal %E4 text' })
  });
  assert.equal(valid.status, 200);
  let row;
  for (let i = 0; i < 50; i++) {
    row = db.prepare("SELECT raw_json FROM messages WHERE dev_id = 'test-device' LIMIT 1").get();
    if (row) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(row, 'valid webhook event should be persisted');
  const payload = JSON.parse(row.raw_json);
  assert.equal(payload.smsBd, 'Literal %E4 text');
});
