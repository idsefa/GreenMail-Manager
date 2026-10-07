const express = require('express');
const http = require('http');
const db = require('../db');
const { calcAdminToken, now } = require('../utils');
const { recordInterfaceLog } = require('../interface-log');
const { getDeviceWatchdog, updateDeviceWatchdog } = require('../watchdog');
const { storeMessage } = require('../message-store');
const { syncCallsFromDevice } = require('../call-sync');

const router = express.Router();

/**
 * HTTP GET helper with timeout
 */
function httpGet(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout }, (response) => {
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON response')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

function getDeviceResponseCode(code) {
  if (typeof code === 'number') return Number.isFinite(code) ? code : null;
  if (typeof code === 'string' && code.trim() !== '') {
    const parsed = Number(code);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * POST /api/devices/:devId/enable-sms-storage
 * Enable SMS storage on device via storesmsen command.
 * Body: { slot: 0|1|2 } (0 = all slots, default)
 */
router.post('/:devId/enable-sms-storage', async (req, res) => {
  try {
    const { devId } = req.params;
    const slot = Number(req.body.slot || 0);

    const device = db.prepare('SELECT * FROM devices WHERE dev_id = ?').get(devId);
    if (!device) return res.status(404).json({ error: 'Device not found' });
    if (!device.wifi_ip) return res.status(400).json({ error: 'Device has no known IP address' });

    const token = calcAdminToken(device.admin_password);
    const url = `http://${device.wifi_ip}/ctrl?token=${token}&cmd=storesmsen&p1=${slot}&p2=on`;

    const result = await httpGet(url, 10000);

    recordInterfaceLog({
      dev_id: devId,
      protocol: 'device-http',
      direction: 'out',
      endpoint: '/ctrl',
      method: 'GET',
      status: 'ok',
      request_summary: `cmd=storesmsen p1=${slot} p2=on`,
      response_summary: `code=${result.code ?? ''}`,
      request_raw: { cmd: 'storesmsen', p1: slot, p2: 'on' },
      response_raw: result,
      remote_addr: device.wifi_ip
    });

    res.json({
      result,
      note: result.note || '',
      requires_restart: getDeviceResponseCode(result?.code) === 0
    });
  } catch (err) {
    console.error('Enable SMS storage error:', err.message);
    recordInterfaceLog({
      dev_id: req.params.devId,
      protocol: 'device-http',
      direction: 'out',
      endpoint: '/ctrl',
      method: 'GET',
      status: 'failed',
      request_summary: 'cmd=storesmsen',
      response_summary: err.message,
      request_raw: { cmd: 'storesmsen', slot: req.body?.slot || 0, p2: 'on' },
      response_raw: '',
      remote_addr: ''
    });
    try {
      db.prepare('UPDATE devices SET is_online = 0, updated_at = ? WHERE dev_id = ?')
        .run(now(), req.params.devId);
    } catch (e) { /* ignore */ }
    res.status(502).json({ error: 'Failed to reach device', detail: err.message });
  }
});

/**
 * POST /api/devices/:devId/sync-sms
 * Pull SMS records from device via querysms command and save to database.
 * Body: { slot: 0|1|2 } (0 = all slots, default)
 *
 * querysms returns:
 *   results: [{ slot, dir (0=recv,1=sent), phNum, smsBd, smsTs }]
 */
router.post('/:devId/sync-sms', async (req, res) => {
  try {
    const { devId } = req.params;
    const slotFilter = Number(req.body.slot || 0);

    const device = db.prepare('SELECT * FROM devices WHERE dev_id = ?').get(devId);
    if (!device) return res.status(404).json({ error: 'Device not found' });
    if (!device.wifi_ip) return res.status(400).json({ error: 'Device has no known IP address' });

    const token = calcAdminToken(device.admin_password);
    const ts = now();

    // Some device firmware returns JSON null for a 50-record page. Start
    // conservatively and shrink the page only when a response is empty.
    let allSms = [];
    let offset = 1;
    let limit = 20;
    let hasMore = true;

    while (hasMore) {
      let result = null;
      let responseCode = null;
      let pageLimit = limit;

      for (const candidateLimit of new Set([limit, 10, 5, 1])) {
        let url = `http://${device.wifi_ip}/ctrl?token=${token}&cmd=querysms&p1=${offset}&p2=${candidateLimit}`;
        if (slotFilter === 1 || slotFilter === 2) {
          url += `&p4=${slotFilter}`;
        }

        result = await httpGet(url, 15000);
        responseCode = getDeviceResponseCode(result?.code);
        pageLimit = candidateLimit;

        // A real device error must be reported. Only a missing code is retried
        // with a smaller page because that is a known firmware buffer failure.
        if (responseCode !== null) break;
      }

      if (responseCode !== 0) {
        const note = String(result?.note || result?.val || result?.raw || 'Device returned an empty or malformed response').slice(0, 500);
        const error = `querysms failed (code ${result?.code ?? 'unknown'}): ${note}`;
        recordInterfaceLog({
          dev_id: devId,
          protocol: 'device-http',
          direction: 'out',
          endpoint: '/ctrl',
          method: 'GET',
          status: 'failed',
          request_summary: `cmd=querysms offset=${offset} limit=${pageLimit} slot=${slotFilter || 'all'}`,
          response_summary: error,
          request_raw: { cmd: 'querysms', p1: offset, p2: pageLimit, p4: slotFilter || undefined },
          response_raw: result,
          remote_addr: device.wifi_ip
        });
        return res.status(responseCode === 100 ? 401 : 400).json({
          error,
          code: result?.code,
          note,
          device_response: result
        });
      }

      if (!Array.isArray(result.results)) throw new Error('querysms returned malformed results');
      const records = result.results;
      allSms = allSms.concat(records);
      limit = pageLimit;

      // Pagination: if we got limit+1 records, there are more
      hasMore = records.length > limit;
      if (hasMore) {
        // Remove the extra record used for pagination detection
        allSms.pop();
        offset += limit;
      }

      // Device SMS storage is limited to 100 records.
      if (allSms.length >= 100) break;
    }

    let savedCount = 0;
    let skippedCount = 0;
    let improvedCount = 0;
    for (const sms of allSms) {
      const msgTs = Number(sms.smsTs || 0);
      const stored = storeMessage({
        devId,
        type: Number(sms.dir) === 0 ? 501 : 502,
        slot: Number(sms.slot || 0),
        phone: String(sms.phNum || ''),
        content: String(sms.smsBd || ''),
        rawJson: JSON.stringify(sms),
        receivedAt: msgTs || ts,
        msgTs,
        message: sms
      });
      if (stored.duplicate) skippedCount++;
      else savedCount++;
      if (stored.improved) improvedCount++;
    }

    recordInterfaceLog({
      dev_id: devId,
      protocol: 'device-http',
      direction: 'out',
      endpoint: '/ctrl',
      method: 'GET',
      status: 'ok',
      request_summary: `cmd=querysms slot=${slotFilter || 'all'}`,
      response_summary: `pulled=${allSms.length} saved=${savedCount} skipped=${skippedCount} improved=${improvedCount}`,
      request_raw: { cmd: 'querysms', slot: slotFilter || 0, page_size: limit },
      response_raw: { total_pulled: allSms.length, saved: savedCount, skipped: skippedCount, improved: improvedCount },
      remote_addr: device.wifi_ip
    });

    res.json({
      success: true,
      total_pulled: allSms.length,
      saved: savedCount,
      skipped: skippedCount,
      improved: improvedCount,
      note: `Pulled ${allSms.length} SMS from device, saved ${savedCount} new records`
    });
  } catch (err) {
    console.error('Sync SMS error:', err.message);
    recordInterfaceLog({
      dev_id: req.params.devId,
      protocol: 'device-http',
      direction: 'out',
      endpoint: '/ctrl',
      method: 'GET',
      status: 'failed',
      request_summary: 'cmd=querysms',
      response_summary: err.message,
      request_raw: { cmd: 'querysms', slot: req.body?.slot || 0 },
      response_raw: '',
      remote_addr: ''
    });
    try {
      db.prepare('UPDATE devices SET is_online = 0, updated_at = ? WHERE dev_id = ?')
        .run(now(), req.params.devId);
    } catch (e) { /* ignore */ }
    res.status(502).json({ error: 'Failed to reach device', detail: err.message });
  }
});

// POST /api/devices/:devId/sync-calls - Pull device-local call records
router.post('/:devId/sync-calls', async (req, res) => {
  const { devId } = req.params;
  const device = db.prepare('SELECT * FROM devices WHERE dev_id = ?').get(devId);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  if (!device.wifi_ip) return res.status(400).json({ error: 'Device has no known IP address' });

  const slot = Number(req.body?.slot || 0);
  if (![0, 1, 2].includes(slot)) return res.status(400).json({ error: 'Invalid slot' });

  try {
    res.json(await syncCallsFromDevice(devId, slot));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// GET /api/devices/:devId/watchdog - Device watchdog settings and SIM health
router.get('/:devId/watchdog', (req, res) => {
  try {
    const device = db.prepare('SELECT dev_id FROM devices WHERE dev_id = ?').get(req.params.devId);
    if (!device) return res.status(404).json({ error: 'Device not found' });
    res.json(getDeviceWatchdog(req.params.devId));
  } catch (err) {
    console.error('Get watchdog status error:', err.message);
    res.status(500).json({ error: 'Failed to load watchdog status' });
  }
});

// PUT /api/devices/:devId/watchdog - Enable/disable bounded automatic recovery
router.put('/:devId/watchdog', (req, res) => {
  try {
    const device = db.prepare('SELECT dev_id FROM devices WHERE dev_id = ?').get(req.params.devId);
    if (!device) return res.status(404).json({ error: 'Device not found' });
    res.json(updateDeviceWatchdog(req.params.devId, req.body || {}));
  } catch (err) {
    const isValidationError = /must be a boolean|No watchdog setting/.test(err.message);
    res.status(isValidationError ? 400 : 500).json({ error: err.message || 'Failed to update watchdog settings' });
  }
});

module.exports = router;
