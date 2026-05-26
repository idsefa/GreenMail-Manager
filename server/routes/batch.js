const express = require('express');
const http = require('http');
const db = require('../db');
const { calcAdminToken } = require('../utils');
const { recordInterfaceLog } = require('../interface-log');

const router = express.Router();
const MAX_BATCH = 20;

/**
 * HTTP GET helper with timeout
 */
function httpGet(url, timeout = 15000) {
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

/**
 * POST /api/batch/execute
 * Body: { dev_ids: [...], cmd: "stat", params: {} }
 * Max 20 devices per batch
 */
router.post('/execute', async (req, res) => {
  try {
    const { dev_ids, cmd, params = {} } = req.body;

    if (!cmd) {
      return res.status(400).json({ error: 'Missing cmd parameter' });
    }
    if (!Array.isArray(dev_ids) || dev_ids.length === 0) {
      return res.status(400).json({ error: 'dev_ids must be a non-empty array' });
    }
    if (dev_ids.length > MAX_BATCH) {
      return res.status(400).json({ error: `Maximum ${MAX_BATCH} devices per batch` });
    }

    // Fetch all devices in one query
    const placeholders = dev_ids.map(() => '?').join(',');
    const devices = db.prepare(`SELECT * FROM devices WHERE dev_id IN (${placeholders})`).all(...dev_ids);

    const deviceMap = {};
    for (const d of devices) {
      deviceMap[d.dev_id] = d;
    }

    // Execute commands in parallel
    const promises = dev_ids.map(async (devId) => {
      const device = deviceMap[devId];
      if (!device) {
        return { dev_id: devId, device_name: '', success: false, error: 'Device not found' };
      }
      if (!device.wifi_ip) {
        return { dev_id: devId, device_name: device.name || '', success: false, error: 'Device has no known IP address' };
      }

      try {
        const token = calcAdminToken(device.admin_password);
        const urlParams = new URLSearchParams();
        urlParams.set('token', token);
        urlParams.set('cmd', cmd);
        for (const [key, value] of Object.entries(params)) {
          if (value !== undefined && value !== null) {
            urlParams.set(key, String(value));
          }
        }
        const url = `http://${device.wifi_ip}/ctrl?${urlParams.toString()}`;
        const result = await httpGet(url, 15000);
        recordInterfaceLog({
          dev_id: devId,
          protocol: 'device-http',
          direction: 'out',
          endpoint: '/ctrl',
          method: 'GET',
          status: 'ok',
          request_summary: `cmd=${cmd} (batch)`,
          response_summary: `code=${result.code ?? ''}`,
          request_raw: { cmd, params },
          response_raw: result,
          remote_addr: device.wifi_ip
        });
        return { dev_id: devId, device_name: device.name || '', success: true, result };
      } catch (err) {
        recordInterfaceLog({
          dev_id: devId,
          protocol: 'device-http',
          direction: 'out',
          endpoint: '/ctrl',
          method: 'GET',
          status: 'failed',
          request_summary: `cmd=${cmd} (batch)`,
          response_summary: err.message,
          request_raw: { cmd, params },
          response_raw: '',
          remote_addr: device.wifi_ip
        });
        return { dev_id: devId, device_name: device.name || '', success: false, error: err.message };
      }
    });

    const results = await Promise.all(promises);
    res.json({ results });
  } catch (err) {
    console.error('Batch execute error:', err.message);
    res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
});

module.exports = router;
