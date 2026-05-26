const express = require('express');
const db = require('../db');
const { now, startOfLocalDay } = require('../utils');

const router = express.Router();

// GET /api/messages - List messages with filters
router.get('/', (req, res) => {
  try {
    const { dev_id, type, phone, search, start_date, end_date, page = 1, limit = 50 } = req.query;

    let where = [];
    let params = [];

    if (dev_id) {
      where.push('m.dev_id = ?');
      params.push(dev_id);
    }
    if (type) {
      // Support comma-separated type list
      const types = String(type).split(',').map(Number).filter(n => !isNaN(n));
      if (types.length > 0) {
        where.push(`m.type IN (${types.map(() => '?').join(',')})`);
        params.push(...types);
      }
    }
    if (phone) {
      where.push('m.phone LIKE ?');
      params.push(`%${phone}%`);
    }
    if (search) {
      where.push('(m.content LIKE ? OR m.phone LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }
    if (start_date) {
      where.push('m.received_at >= ?');
      params.push(Number(start_date));
    }
    if (end_date) {
      where.push('m.received_at <= ?');
      params.push(Number(end_date));
    }

    const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(200, Math.max(1, parseInt(limit)));
    const offset = (pageNum - 1) * limitNum;

    const countRow = db.prepare(`SELECT COUNT(*) as total FROM messages m ${whereClause}`).get(...params);
    const total = countRow ? countRow.total : 0;

    const rows = db.prepare(`
      SELECT m.*, d.name as device_name
      FROM messages m
      LEFT JOIN devices d ON d.dev_id = m.dev_id
      ${whereClause}
      ORDER BY m.received_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limitNum, offset);

    res.json({
      messages: rows,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum)
      }
    });
  } catch (err) {
    console.error('Error listing messages:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/messages/export - Export messages as CSV
router.get('/export', (req, res) => {
  try {
    const { dev_id, type, start_date, end_date } = req.query;
    let where = [];
    let params = [];

    if (dev_id) { where.push('dev_id = ?'); params.push(dev_id); }
    if (type) {
      const types = String(type).split(',').map(Number).filter(n => !isNaN(n));
      if (types.length > 0) {
        where.push(`type IN (${types.map(() => '?').join(',')})`);
        params.push(...types);
      }
    }
    if (start_date) { where.push('received_at >= ?'); params.push(Number(start_date)); }
    if (end_date) { where.push('received_at <= ?'); params.push(Number(end_date)); }

    const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
    const rows = db.prepare(`
      SELECT id, dev_id, type, slot, phone, content, received_at, msg_ts FROM messages ${whereClause}
      ORDER BY received_at DESC LIMIT 10000
    `).all(...params);

    // Build CSV
    let csv = 'id,dev_id,type,slot,phone,content,received_at,msg_ts\n';
    for (const r of rows) {
      csv += `${r.id},"${r.dev_id}",${r.type},${r.slot},"${(r.phone || '').replace(/"/g, '""')}","${(r.content || '').replace(/"/g, '""')}",${r.received_at},${r.msg_ts}\n`;
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=messages.csv');
    res.send(csv);
  } catch (err) {
    console.error('Error exporting messages:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/messages/stats - Dashboard stats
router.get('/stats', (req, res) => {
  try {
    const ts = now();
    const todayStart = startOfLocalDay(ts);

    const totalDevices = db.prepare('SELECT COUNT(*) as count FROM devices').get().count;
    const messagesToday = db.prepare('SELECT COUNT(*) as count FROM messages WHERE received_at >= ?').get(todayStart).count;

    // Count online devices
    const devices = db.prepare('SELECT ping_intvl, last_ping_at FROM devices').all();
    let onlineCount = 0;
    for (const d of devices) {
      if (isDeviceOnline(d.last_ping_at, d.ping_intvl)) onlineCount++;
    }

    const recentMessages = db.prepare(`
      SELECT m.*, d.name as device_name FROM messages m
      LEFT JOIN devices d ON m.dev_id = d.dev_id
      ORDER BY m.received_at DESC LIMIT 20
    `).all();

    res.json({
      totalDevices,
      onlineCount,
      offlineCount: totalDevices - onlineCount,
      messagesToday,
      recentMessages
    });
  } catch (err) {
    console.error('Error getting stats:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

function isDeviceOnline(lastPingAt, pingIntvl) {
  if (!lastPingAt) return false;
  const ts = now();
  const threshold = pingIntvl * 3 + 8;
  return (ts - lastPingAt) <= threshold;
}

module.exports = router;
