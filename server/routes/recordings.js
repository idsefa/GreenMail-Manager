const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { now } = require('../utils');
const logger = require('../logger');

const router = express.Router();
const maxBytes = 10 * 1024 * 1024;
const recordingDir = path.join(process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data'), 'recordings');

router.post('/upload', async (req, res) => {
  if (!String(req.headers['content-type'] || '').startsWith('multipart/form-data;')) {
    return res.status(400).json({ errcode: 400, errmsg: 'Expected multipart/form-data' });
  }

  let size = 0;
  const chunks = [];
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBytes) return res.status(413).json({ errcode: 413, errmsg: 'Recording exceeds 10 MB' });
      chunks.push(chunk);
    }
    const request = new Request('http://localhost/upload', {
      method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body: Buffer.concat(chunks)
    });
    const form = await request.formData();
    const file = form.get('media');
    if (!file || typeof file.arrayBuffer !== 'function' || !/\.amr$/i.test(file.name || '')) {
      return res.status(400).json({ errcode: 400, errmsg: 'AMR media file is required' });
    }
    const data = Buffer.from(await file.arrayBuffer());
    if (!data.length || !(data.subarray(0, 6).toString() === '#!AMR\n' || data.subarray(0, 9).toString() === '#!AMR-WB\n')) {
      return res.status(400).json({ errcode: 400, errmsg: 'Invalid AMR recording' });
    }

    const mediaId = `${crypto.randomUUID()}.amr`;
    fs.mkdirSync(recordingDir, { recursive: true });
    fs.writeFileSync(path.join(recordingDir, mediaId), data, { flag: 'wx', mode: 0o600 });
    const ts = now();
    try {
      db.prepare(`
        INSERT INTO recordings (media_id, filename, size_bytes, sha256, dev_id, slot, phone, call_started_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        mediaId, path.basename(file.name), data.length,
        crypto.createHash('sha256').update(data).digest('hex'),
        String(req.query.devId || ''), Number(req.query.slot || 0),
        String(req.query.phNum || ''), Number(req.query.telStartTs || 0), ts
      );
    } catch (err) {
      fs.unlinkSync(path.join(recordingDir, mediaId));
      throw err;
    }
    logger.info('recording', 'Recording received', { mediaId, devId: String(req.query.devId || ''), bytes: data.length });
    res.json({ errcode: 0, errmsg: 'success', type: 'amr', media_id: mediaId, created_at: ts });
  } catch (err) {
    logger.error('recording', 'Recording upload failed', { error: err.message });
    res.status(500).json({ errcode: 500, errmsg: 'Recording upload failed', type: '', media_id: '', created_at: 0 });
  }
});

router.get('/', (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const rows = req.query.dev_id
      ? db.prepare('SELECT * FROM recordings WHERE dev_id = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(String(req.query.dev_id), limit)
      : db.prepare('SELECT * FROM recordings ORDER BY created_at DESC, id DESC LIMIT ?').all(limit);
    res.json({ recordings: rows });
  } catch {
    res.status(500).json({ error: 'Failed to list recordings' });
  }
});

router.get('/:mediaId/file', (req, res) => {
  const mediaId = String(req.params.mediaId);
  const record = db.prepare('SELECT media_id FROM recordings WHERE media_id = ?').get(mediaId);
  if (!record) return res.status(404).json({ error: 'Recording not found' });
  res.type('audio/amr').sendFile(path.join(recordingDir, record.media_id));
});

module.exports = router;
