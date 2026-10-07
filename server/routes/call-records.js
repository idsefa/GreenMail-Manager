const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/', (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const where = [];
    const args = [];
    if (req.query.dev_id) { where.push('c.dev_id = ?'); args.push(String(req.query.dev_id)); }
    if (req.query.start_date) { where.push('c.started_at >= ?'); args.push(Number(req.query.start_date)); }
    if (req.query.end_date) { where.push('c.started_at <= ?'); args.push(Number(req.query.end_date)); }
    const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS count FROM call_records c ${filter}`).get(...args).count;
    const records = db.prepare(`
      SELECT c.*, d.name AS device_name FROM call_records c
      LEFT JOIN devices d ON d.dev_id = c.dev_id
      ${filter} ORDER BY c.started_at DESC, c.id DESC LIMIT ? OFFSET ?
    `).all(...args, limit, (page - 1) * limit);
    res.json({ records, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list call records' });
  }
});

module.exports = router;
