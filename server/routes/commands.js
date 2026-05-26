const express = require('express');
const http = require('http');
const db = require('../db');
const { calcAdminToken, now, isDeviceOnline } = require('../utils');
const { recordInterfaceLog } = require('../interface-log');

const router = express.Router();

/**
 * Send a control command to a device via HTTP GET.
 * URL: http://<device-ip>/ctrl?token=<token>&cmd=<command>&p1=<p1>&p2=<p2>...
 */
router.post('/:devId/send', async (req, res) => {
  try {
    const { devId } = req.params;
    const { cmd, p1, p2, p3, p4, p5, p6, p7, p8, p9, p10, p11, tid } = req.body;

    if (!cmd) {
      return res.status(400).json({ error: 'Missing cmd parameter' });
    }

    // Get device info
    const device = db.prepare('SELECT * FROM devices WHERE dev_id = ?').get(devId);
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }
    if (!device.wifi_ip) {
      return res.status(400).json({ error: 'Device has no known IP address' });
    }

    const token = calcAdminToken(device.admin_password);

    // Build URL with parameters
    const params = new URLSearchParams();
    params.set('token', token);
    params.set('cmd', cmd);
    if (p1 !== undefined) params.set('p1', p1);
    if (p2 !== undefined) params.set('p2', p2);
    if (p3 !== undefined) params.set('p3', p3);
    if (p4 !== undefined) params.set('p4', p4);
    if (p5 !== undefined) params.set('p5', p5);
    if (p6 !== undefined) params.set('p6', p6);
    if (p7 !== undefined) params.set('p7', p7);
    if (p8 !== undefined) params.set('p8', p8);
    if (p9 !== undefined) params.set('p9', p9);
    if (p10 !== undefined) params.set('p10', p10);
    if (p11 !== undefined) params.set('p11', p11);
    if (tid) params.set('tid', tid);

    const url = `http://${device.wifi_ip}/ctrl?${params.toString()}`;

    // Send HTTP GET to device
    const result = await httpGet(url, 15000);
    recordInterfaceLog({
      dev_id: devId,
      protocol: 'device-http',
      direction: 'out',
      endpoint: '/ctrl',
      method: 'GET',
      status: 'ok',
      request_summary: `cmd=${cmd}${p1 !== undefined ? ` p1=${p1}` : ''}${p2 !== undefined ? ` p2=${p2}` : ''}`,
      response_summary: `code=${result.code ?? ''}`,
      request_raw: { cmd, p1, p2, p3, p4, p5, p6, p7, p8, p9, p10, p11, tid },
      response_raw: result,
      remote_addr: device.wifi_ip
    });

    // Command succeeded - mark device as online
    const ts = now();
    db.prepare('UPDATE devices SET last_ping_at = ?, is_online = 1, updated_at = ? WHERE dev_id = ?')
      .run(ts, ts, devId);

    // Store command result as a message
    try {
      db.prepare(`
        INSERT INTO messages (dev_id, type, slot, phone, content, raw_json, received_at, msg_ts)
        VALUES (?, 999, 0, '', ?, ?, ?, ?)
      `).run(
        devId,
        JSON.stringify(result),
        JSON.stringify({ ...result, _cmd: cmd, _direction: 'response' }),
        now(),
        now()
      );
    } catch (e) {
      console.error('Error storing command result:', e.message);
    }

    res.json({ result, url });
  } catch (err) {
    console.error('Command error:', err.message);
    recordInterfaceLog({
      dev_id: req.params.devId,
      protocol: 'device-http',
      direction: 'out',
      endpoint: '/ctrl',
      method: 'GET',
      status: 'failed',
      request_summary: `cmd=${req.body?.cmd || ''}`,
      response_summary: err.message,
      request_raw: req.body,
      response_raw: '',
      remote_addr: ''
    });
    // Command failed - device unreachable, mark as offline
    try {
      db.prepare('UPDATE devices SET is_online = 0, updated_at = ? WHERE dev_id = ?')
        .run(now(), req.params.devId);
    } catch (e) { /* ignore */ }
    res.status(502).json({ error: 'Failed to reach device', detail: err.message });
  }
});

/**
 * Quick commands: stat, ping, restart, factreset
 */
router.post('/:devId/quick/:cmd', async (req, res) => {
  try {
    const { devId, cmd } = req.params;
    const validCmds = ['stat', 'ping', 'restart', 'factreset'];
    if (!validCmds.includes(cmd)) {
      return res.status(400).json({ error: `Invalid quick command. Valid: ${validCmds.join(', ')}` });
    }

    const device = db.prepare('SELECT * FROM devices WHERE dev_id = ?').get(devId);
    if (!device) return res.status(404).json({ error: 'Device not found' });
    if (!device.wifi_ip) return res.status(400).json({ error: 'Device has no known IP' });

    const token = calcAdminToken(device.admin_password);
    const url = `http://${device.wifi_ip}/ctrl?token=${token}&cmd=${cmd}`;

    const result = await httpGet(url, 15000);

    // If stat command succeeded, update device info and mark as online
    if (cmd === 'stat' && result && result.code === 0) {
      const ts = now();
      db.prepare(`
        UPDATE devices SET
          hw_ver = COALESCE(NULLIF(?, ''), hw_ver),
          wifi_ip = COALESCE(NULLIF(?, ''), wifi_ip),
          wifi_ssid = COALESCE(NULLIF(?, ''), wifi_ssid),
          wifi_dbm = CASE WHEN ? > 0 THEN ? ELSE wifi_dbm END,
          ping_intvl = CASE WHEN ? > 0 THEN ? ELSE ping_intvl END,
          sim1_icc_id = COALESCE(NULLIF(?, ''), sim1_icc_id),
          sim1_imsi = COALESCE(NULLIF(?, ''), sim1_imsi),
          sim1_phone = COALESCE(NULLIF(?, ''), sim1_phone),
          sim1_plmn = COALESCE(NULLIF(?, ''), sim1_plmn),
          sim1_sc_name = COALESCE(NULLIF(?, ''), sim1_sc_name),
          sim2_icc_id = COALESCE(NULLIF(?, ''), sim2_icc_id),
          sim2_imsi = COALESCE(NULLIF(?, ''), sim2_imsi),
          sim2_phone = COALESCE(NULLIF(?, ''), sim2_phone),
          sim2_plmn = COALESCE(NULLIF(?, ''), sim2_plmn),
          sim2_sc_name = COALESCE(NULLIF(?, ''), sim2_sc_name),
          last_stat_at = ?,
          last_ping_at = ?,
          is_online = 1,
          updated_at = ?
        WHERE dev_id = ?
      `).run(
        result.hwVer || '',
        result.wifi?.ip || '',
        result.wifi?.ssid || '',
        Number(result.wifi?.dbm || 0), Number(result.wifi?.dbm || 0),
        Number(result.pingIntvl || 0), Number(result.pingIntvl || 0),
        result.slotInfo?.sim1_iccId || '',
        result.slotInfo?.sim1_imsi || '',
        result.slotInfo?.sim1_msIsdn || '',
        result.slotInfo?.sim1_plmn || '',
        result.slotInfo?.sim1_scName || '',
        result.slotInfo?.sim2_iccId || '',
        result.slotInfo?.sim2_imsi || '',
        result.slotInfo?.sim2_msIsdn || '',
        result.slotInfo?.sim2_plmn || '',
        result.slotInfo?.sim2_scName || '',
        ts, ts, ts,
        devId
      );
    }

    // If ping command succeeded, mark device as online
    if (cmd === 'ping' && result && result.code === 0) {
      const ts = now();
      db.prepare('UPDATE devices SET last_ping_at = ?, is_online = 1, updated_at = ? WHERE dev_id = ?')
        .run(ts, ts, devId);
    }

    recordInterfaceLog({
      dev_id: devId,
      protocol: 'device-http',
      direction: 'out',
      endpoint: '/ctrl',
      method: 'GET',
      status: 'ok',
      request_summary: `cmd=${cmd}`,
      response_summary: `code=${result.code ?? ''}`,
      request_raw: { cmd },
      response_raw: result,
      remote_addr: device.wifi_ip
    });

    res.json({ result });
  } catch (err) {
    console.error('Quick command error:', err.message);
    recordInterfaceLog({
      dev_id: req.params.devId,
      protocol: 'device-http',
      direction: 'out',
      endpoint: '/ctrl',
      method: 'GET',
      status: 'failed',
      request_summary: `cmd=${req.params.cmd || ''}`,
      response_summary: err.message,
      request_raw: { cmd: req.params.cmd },
      response_raw: '',
      remote_addr: ''
    });
    // Command failed - device unreachable, mark as offline
    try {
      db.prepare('UPDATE devices SET is_online = 0, updated_at = ? WHERE dev_id = ?')
        .run(now(), devId);
    } catch (e) { /* ignore */ }
    res.status(502).json({ error: 'Failed to reach device', detail: err.message });
  }
});

/**
 * HTTP GET helper with timeout
 */
function httpGet(url, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout }, (response) => {
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve({ raw: data });
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

module.exports = router;
