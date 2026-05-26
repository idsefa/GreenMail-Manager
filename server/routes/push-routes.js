const express = require('express');
const db = require('../db');
const { buildPushRequest, formatFetchError } = require('../push-engine');

const router = express.Router();

// GET /api/push-rules - List all rules
router.get('/', (req, res) => {
  try {
    const rules = db.prepare('SELECT * FROM push_rules ORDER BY id DESC').all();
    res.json({ rules });
  } catch (err) {
    console.error('Error listing push rules:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/push-rules - Create rule
router.post('/', (req, res) => {
  try {
    const { name, url, method, headers, body_template, trigger_types, trigger_devices, trigger_msisdn } = req.body;
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    const stmt = db.prepare(`
      INSERT INTO push_rules (name, url, method, headers, body_template, trigger_types, trigger_devices, trigger_msisdn)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      name || '',
      url,
      method || 'POST',
      headers || '{}',
      body_template || '',
      trigger_types || '',
      trigger_devices || '',
      trigger_msisdn || ''
    );

    const rule = db.prepare('SELECT * FROM push_rules WHERE id = ?').get(result.lastInsertRowid);
    res.json({ rule });
  } catch (err) {
    console.error('Error creating push rule:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/push-rules/:id - Update rule
router.put('/:id', (req, res) => {
  try {
    const rule = db.prepare('SELECT * FROM push_rules WHERE id = ?').get(req.params.id);
    if (!rule) {
      return res.status(404).json({ error: 'Rule not found' });
    }

    const { name, enabled, url, method, headers, body_template, trigger_types, trigger_devices, trigger_msisdn } = req.body;

    db.prepare(`
      UPDATE push_rules SET
        name = COALESCE(?, name),
        enabled = COALESCE(?, enabled),
        url = COALESCE(?, url),
        method = COALESCE(?, method),
        headers = COALESCE(?, headers),
        body_template = COALESCE(?, body_template),
        trigger_types = COALESCE(?, trigger_types),
        trigger_devices = COALESCE(?, trigger_devices),
        trigger_msisdn = COALESCE(?, trigger_msisdn)
      WHERE id = ?
    `).run(
      name !== undefined ? name : null,
      enabled !== undefined ? (enabled ? 1 : 0) : null,
      url || null,
      method || null,
      headers || null,
      body_template !== undefined ? body_template : null,
      trigger_types !== undefined ? trigger_types : null,
      trigger_devices !== undefined ? trigger_devices : null,
      trigger_msisdn !== undefined ? trigger_msisdn : null,
      req.params.id
    );

    const updated = db.prepare('SELECT * FROM push_rules WHERE id = ?').get(req.params.id);
    res.json({ rule: updated });
  } catch (err) {
    console.error('Error updating push rule:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/push-rules/:id - Delete rule
router.delete('/:id', (req, res) => {
  try {
    const rule = db.prepare('SELECT * FROM push_rules WHERE id = ?').get(req.params.id);
    if (!rule) {
      return res.status(404).json({ error: 'Rule not found' });
    }
    db.prepare('DELETE FROM push_rules WHERE id = ?').run(req.params.id);
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('Error deleting push rule:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/push-rules/:id/test - Send test push
router.post('/:id/test', async (req, res) => {
  let url = '';
  let body = '';
  try {
    const rule = db.prepare('SELECT * FROM push_rules WHERE id = ?').get(req.params.id);
    if (!rule) {
      return res.status(404).json({ error: 'Rule not found' });
    }

    const vars = {
      dev_id: 'test-device',
      device_name: '测试设备',
      device_label: '测试设备 (test-device)',
      event_label: '新短信',
      type: 501,
      slot: 1,
      phone: '+1234567890',
      msIsdn: '+1234567890',
      content: 'This is a test message from GreenMail Manager',
      received_at: new Date().toISOString(),
      raw_json: '{"test": true}'
    };

    const request = buildPushRequest(rule, vars);
    url = request.url;
    body = request.body;
    const response = await fetch(url, request.fetchOpts);
    const responseBody = await response.text().catch(() => '');

    res.json({
      status: response.ok ? 'success' : 'failed',
      http_status: response.status,
      response: responseBody.substring(0, 2000),
      url_sent: url,
      body_sent: body
    });
  } catch (err) {
    console.error('Error testing push rule:', err);
    res.json({
      status: 'failed',
      http_status: null,
      error: formatFetchError(err, url),
      url_sent: url || null,
      body_sent: body || null
    });
  }
});

// GET /api/push-rules/:id/logs - Get push logs for a rule
router.get('/:id/logs', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const logs = db.prepare('SELECT * FROM push_logs WHERE rule_id = ? ORDER BY id DESC LIMIT ?')
      .all(req.params.id, limit);
    res.json({ logs });
  } catch (err) {
    console.error('Error getting push logs:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
