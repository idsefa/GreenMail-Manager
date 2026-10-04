const express = require('express');
const db = require('../db');
const { getQueueStats } = require('../message-queue');

const router = express.Router();

function buildFilters(query = {}) {
  const where = [];
  const params = [];

  if (query.level) {
    where.push('level = ?');
    params.push(String(query.level));
  }
  if (query.scope) {
    where.push('scope = ?');
    params.push(String(query.scope));
  }
  if (query.search) {
    const value = `%${String(query.search)}%`;
    where.push('(message LIKE ? OR context LIKE ? OR scope LIKE ?)');
    params.push(value, value, value);
  }
  if (query.start_date) {
    where.push('created_at >= ?');
    params.push(Number(query.start_date));
  }
  if (query.end_date) {
    where.push('created_at <= ?');
    params.push(Number(query.end_date));
  }

  return { whereClause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

router.get('/queue', (req, res) => {
  try {
    res.json({ queue: getQueueStats() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get queue status' });
  }
});

router.get('/', (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const { whereClause, params } = buildFilters(req.query);
    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.min(200, Math.max(1, Number(limit) || 50));
    const offset = (pageNum - 1) * limitNum;
    const total = db.prepare(`SELECT COUNT(*) AS count FROM application_logs ${whereClause}`).get(...params).count;
    const logs = db.prepare(`
      SELECT * FROM application_logs
      ${whereClause}
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(...params, limitNum, offset);

    res.json({
      logs,
      pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) }
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list system logs' });
  }
});

router.delete('/', (req, res) => {
  try {
    const { whereClause, params } = buildFilters(req.query);
    const result = db.prepare(`DELETE FROM application_logs ${whereClause}`).run(...params);
    res.json({ success: true, deleted: result.changes });
  } catch (err) {
    res.status(500).json({ error: 'Failed to clear system logs' });
  }
});

module.exports = router;
