const express = require('express');
const db = require('../db');

const router = express.Router();

function buildFilters(query = {}, tableAlias = 'l') {
  const { dev_id, protocol, direction, status, search, start_date, end_date, recent_hours } = query;
  const prefix = tableAlias ? `${tableAlias}.` : '';

  const where = [];
  const params = [];

  if (dev_id) {
    where.push(`${prefix}dev_id = ?`);
    params.push(dev_id);
  }
  if (protocol) {
    where.push(`${prefix}protocol = ?`);
    params.push(protocol);
  }
  if (direction) {
    where.push(`${prefix}direction = ?`);
    params.push(direction);
  }
  if (status) {
    where.push(`${prefix}status = ?`);
    params.push(status);
  }
  if (search) {
    const q = `%${search}%`;
    where.push(`(${prefix}endpoint LIKE ? OR ${prefix}request_summary LIKE ? OR ${prefix}response_summary LIKE ? OR ${prefix}request_raw LIKE ? OR ${prefix}response_raw LIKE ? OR ${prefix}dev_id LIKE ?)`);
    params.push(q, q, q, q, q, q);
  }
  if (start_date) {
    where.push(`${prefix}created_at >= ?`);
    params.push(Number(start_date));
  }
  if (end_date) {
    where.push(`${prefix}created_at <= ?`);
    params.push(Number(end_date));
  }
  if (recent_hours) {
    const hours = Math.max(1, Math.min(168, Number(recent_hours) || 0));
    if (hours > 0) {
      where.push(`${prefix}created_at >= ?`);
      params.push(Math.floor(Date.now() / 1000) - hours * 3600);
    }
  }

  return {
    whereClause: where.length > 0 ? 'WHERE ' + where.join(' AND ') : '',
    params
  };
}

// GET /api/interface-logs - List interface logs with filters
router.get('/', (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const { whereClause, params } = buildFilters(req.query, '');
    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(200, Math.max(1, parseInt(limit) || 50));
    const offset = (pageNum - 1) * limitNum;

    const countRow = db.prepare(`SELECT COUNT(*) as total FROM interface_logs l ${whereClause}`).get(...params);
    const total = countRow ? countRow.total : 0;

    const rows = db.prepare(`
      SELECT l.*, d.name as device_name
      FROM interface_logs l
      LEFT JOIN devices d ON d.dev_id = l.dev_id
      ${whereClause}
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT ? OFFSET ?
    `).all(...params, limitNum, offset);

    res.json({
      logs: rows,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum)
      }
    });
  } catch (err) {
    console.error('Error listing interface logs:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/interface-logs - Clear interface logs, optionally by current filters
router.delete('/', (req, res) => {
  try {
    const { whereClause, params } = buildFilters(req.query);
    const sql = `DELETE FROM interface_logs l ${whereClause}`;
    const info = db.prepare(sql).run(...params);
    res.json({ success: true, deleted: info.changes });
  } catch (err) {
    console.error('Error clearing interface logs:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
