const express = require('express');
const db = require('../db');
const { calcAdminToken, now, isDeviceOnline } = require('../utils');
const { recordInterfaceLog } = require('../interface-log');

const router = express.Router();

// GET /api/devices - List all devices
router.get('/', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT * FROM devices
      ORDER BY id ASC, dev_id ASC
    `).all();

    const ts = now();
    const devices = rows.map(d => {
      const online = isDeviceOnline(d.last_ping_at, d.ping_intvl);
      return { ...d, is_online: online ? 1 : 0, admin_token: calcAdminToken(d.admin_password) };
    });

    res.json({ devices });
  } catch (err) {
    console.error('Error listing devices:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/devices/:devId - Get single device
router.get('/:devId', (req, res) => {
  try {
    const device = db.prepare('SELECT * FROM devices WHERE dev_id = ?').get(req.params.devId);
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }

    const online = isDeviceOnline(device.last_ping_at, device.ping_intvl);
    device.is_online = online ? 1 : 0;
    device.admin_token = calcAdminToken(device.admin_password);

    res.json({ device });
  } catch (err) {
    console.error('Error getting device:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/devices/:devId - Update device (name, password)
router.put('/:devId', (req, res) => {
  try {
    const { name, admin_password } = req.body;
    const ts = now();

    if (name !== undefined) {
      db.prepare('UPDATE devices SET name = ?, updated_at = ? WHERE dev_id = ?')
        .run(String(name), ts, req.params.devId);
    }
    if (admin_password !== undefined) {
      if (String(admin_password).length < 4) {
        return res.status(400).json({ error: 'Password must be at least 4 characters' });
      }
      db.prepare('UPDATE devices SET admin_password = ?, updated_at = ? WHERE dev_id = ?')
        .run(String(admin_password), ts, req.params.devId);
    }

    const device = db.prepare('SELECT * FROM devices WHERE dev_id = ?').get(req.params.devId);
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }
    device.admin_token = calcAdminToken(device.admin_password);
    const online = isDeviceOnline(device.last_ping_at, device.ping_intvl);
    device.is_online = online ? 1 : 0;

    res.json({ device });
  } catch (err) {
    console.error('Error updating device:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/devices - Manually create a device
router.post('/', async (req, res) => {
  try {
    const { dev_id, wifi_ip, name, admin_password } = req.body;

    // IP is required for LAN control
    if (!wifi_ip || String(wifi_ip).trim().length === 0) {
      return res.status(400).json({ error: 'wifi_ip is required for LAN device control' });
    }
    const ip = String(wifi_ip).trim();
    const password = admin_password || 'admin';

    let devId = dev_id ? String(dev_id).trim() : '';

    // If no dev_id provided, try to fetch from device via stat command
    if (!devId) {
      const token = require('../utils').calcAdminToken(password);
      const http = require('http');
      const url = `http://${ip}/ctrl?token=${token}&cmd=stat`;

      try {
        const result = await new Promise((resolve, reject) => {
          const r = http.get(url, { timeout: 10000 }, (response) => {
            let data = '';
            response.on('data', chunk => data += chunk);
            response.on('end', () => {
              try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid response from device')); }
            });
          });
          r.on('error', reject);
          r.on('timeout', () => { r.destroy(); reject(new Error('Device unreachable')); });
        });

        if (result.code !== 0 || !result.devId) {
          return res.status(400).json({ error: 'Device responded but devId not found in stat response', detail: result });
        }
        devId = result.devId;

        recordInterfaceLog({
          dev_id: devId,
          protocol: 'device-http',
          direction: 'out',
          endpoint: '/ctrl',
          method: 'GET',
          status: 'ok',
          request_summary: 'cmd=stat (auto-detect)',
          response_summary: `code=${result.code ?? ''}`,
          request_raw: { cmd: 'stat' },
          response_raw: result,
          remote_addr: ip
        });

        // Check if device already exists
        const existing = db.prepare('SELECT id FROM devices WHERE dev_id = ?').get(devId);
        if (existing) {
          // Update IP and mark online
          const ts = now();
          db.prepare('UPDATE devices SET wifi_ip = ?, last_ping_at = ?, is_online = 1, updated_at = ? WHERE dev_id = ?')
            .run(ip, ts, ts, devId);
          const device = db.prepare('SELECT * FROM devices WHERE dev_id = ?').get(devId);
          device.admin_token = calcAdminToken(device.admin_password);
          device.is_online = 1;
          return res.json({ device, auto_detected: true });
        }

        // Create device with info from stat response
        const ts = now();
        db.prepare(`
          INSERT INTO devices (dev_id, wifi_ip, name, hw_ver, wifi_ssid, wifi_dbm, ping_intvl,
            sim1_icc_id, sim1_imsi, sim1_phone, sim1_plmn, sim1_sc_name,
            sim2_icc_id, sim2_imsi, sim2_phone, sim2_plmn, sim2_sc_name,
            admin_password, last_ping_at, is_online, last_stat_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
        `).run(
          devId, ip, name || '',
          result.hwVer || '', result.wifi?.ssid || '', Number(result.wifi?.dbm || 0), Number(result.pingIntvl || 0),
          result.slotInfo?.sim1_iccId || '', result.slotInfo?.sim1_imsi || '', result.slotInfo?.sim1_msIsdn || '',
          result.slotInfo?.sim1_plmn || '', result.slotInfo?.sim1_scName || '',
          result.slotInfo?.sim2_iccId || '', result.slotInfo?.sim2_imsi || '', result.slotInfo?.sim2_msIsdn || '',
          result.slotInfo?.sim2_plmn || '', result.slotInfo?.sim2_scName || '',
          password, ts, ts, ts, ts
        );

        const device = db.prepare('SELECT * FROM devices WHERE dev_id = ?').get(devId);
        device.admin_token = calcAdminToken(device.admin_password);
        device.is_online = 1;
        return res.json({ device, auto_detected: true });

      } catch (fetchErr) {
        recordInterfaceLog({
          dev_id: devId || '',
          protocol: 'device-http',
          direction: 'out',
          endpoint: '/ctrl',
          method: 'GET',
          status: 'failed',
          request_summary: 'cmd=stat (auto-detect)',
          response_summary: fetchErr.message,
          request_raw: { cmd: 'stat' },
          response_raw: '',
          remote_addr: ip
        });
        return res.status(502).json({ error: 'Cannot reach device at ' + ip, detail: fetchErr.message });
      }
    }

    // dev_id provided manually
    const existing = db.prepare('SELECT id FROM devices WHERE dev_id = ?').get(devId);
    if (existing) {
      return res.status(409).json({ error: 'Device already exists' });
    }

    const ts = now();
    db.prepare(`
      INSERT INTO devices (dev_id, wifi_ip, name, admin_password, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(devId, ip, name || '', password, ts, ts);

    const device = db.prepare('SELECT * FROM devices WHERE dev_id = ?').get(devId);
    device.admin_token = calcAdminToken(device.admin_password);
    device.is_online = 0;

    res.json({ device });
  } catch (err) {
    console.error('Error creating device:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/devices/:devId - Delete a device and its messages
router.delete('/:devId', (req, res) => {
  try {
    db.prepare('DELETE FROM messages WHERE dev_id = ?').run(req.params.devId);
    db.prepare('DELETE FROM devices WHERE dev_id = ?').run(req.params.devId);
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('Error deleting device:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
