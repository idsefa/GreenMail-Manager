const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'greenmail-recordings-test-'));
const db = require('../server/db');
const recordings = require('../server/routes/recordings');

test('recording upload and download work without a management session or upload key', async (t) => {
  const app = express();
  app.use('/api/recordings', recordings);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/recordings`;

  const bytes = Buffer.from('#!AMR\nrecording-data');
  const form = new FormData();
  form.append('media', new Blob([bytes], { type: 'audio/amr' }), 'call.amr');
  const upload = await fetch(`${base}/upload?devId=test-device`, { method: 'POST', body: form });
  assert.equal(upload.status, 200);
  const result = await upload.json();
  assert.equal(result.errcode, 0);
  assert.equal(db.prepare('SELECT dev_id FROM recordings WHERE media_id = ?').get(result.media_id).dev_id, 'test-device');

  const download = await fetch(`${base}/${encodeURIComponent(result.media_id)}/file`);
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
});
