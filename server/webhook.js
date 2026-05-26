const express = require('express');
const { processMessage } = require('./message-handler');
const { recordInterfaceLog } = require('./interface-log');

const router = express.Router();

/**
 * Build a 14-digit time string yyyyMMddHHmmss for device time sync.
 * Used in HTTP response when device sends type=100 (WiFi connected).
 */
function buildTimeSyncString() {
  const ts = new Date();
  const y = String(ts.getFullYear()).padStart(4, '0');
  const M = String(ts.getMonth() + 1).padStart(2, '0');
  const d = String(ts.getDate()).padStart(2, '0');
  const h = String(ts.getHours()).padStart(2, '0');
  const m = String(ts.getMinutes()).padStart(2, '0');
  const s = String(ts.getSeconds()).padStart(2, '0');
  return `${y}${M}${d}${h}${m}${s}`;
}

/**
 * Parse a device push message from various formats into a plain object.
 *
 * Supported formats per spec:
 * - GET + FORM: query params as key=value
 * - GET + JSON: JSON string in query param "p"
 * - POST + FORM: URL-encoded body (application/x-www-form-urlencoded)
 * - POST + JSON: JSON body (application/json)
 *
 * FORM values may be URL-encoded; JSON values are raw UTF-8.
 */
function parseMessage(req) {
  const method = req.method.toUpperCase();
  const contentType = (req.headers['content-type'] || '').toLowerCase();

  if (method === 'GET') {
    // GET + JSON or key-value string in "p" parameter
    if (req.query.p) {
      const msg = parseEmbeddedPayload(req.query.p, req.query);
      if (msg) return msg;
    }
    // GET + FORM: query params as key=value
    if (req.query && hasDeviceId(req.query)) {
      return normalizeFormValues(req.query);
    }
    return null;
  }

  // POST
  if (contentType.includes('application/json')) {
    // POST + JSON
    if (req.body && typeof req.body === 'object') {
      if (req.body.p) {
        const msg = parseEmbeddedPayload(req.body.p, req.body);
        if (msg) return msg;
      }
      return normalizeFormValues(req.body);
    }
    return null;
  }

  // POST + FORM (application/x-www-form-urlencoded or form-data)
  if (req.body && typeof req.body === 'object') {
    if (req.body.p) {
      const msg = parseEmbeddedPayload(req.body.p, req.body);
      if (msg) return msg;
    }
    return normalizeFormValues(req.body);
  }

  return null;
}

function hasDeviceId(obj) {
  return !!(obj && (obj.devId || obj.deviceId || obj.dev_id || obj.device_id));
}

function parseEmbeddedPayload(raw, outer = {}) {
  if (typeof raw !== 'string') return null;

  const text = raw.trim();
  if (!text) return null;

  try {
    const msg = JSON.parse(text);
    if (msg && typeof msg === 'object') {
      return normalizeFormValues({ ...outer, ...msg });
    }
  } catch {
    // fall through to key-value parsing
  }

  if (!text.includes('=')) return null;

  const params = new URLSearchParams(text.startsWith('?') ? text.slice(1) : text);
  const parsed = {};
  let hasPairs = false;

  for (const [key, val] of params.entries()) {
    parsed[key] = val;
    hasPairs = true;
  }

  if (!hasPairs) return null;

  return normalizeFormValues({ ...outer, ...parsed });
}

/**
 * Normalize FORM values: decode URL-encoded strings, convert numeric-looking strings.
 * FORM format has all values as strings per spec; we keep them as-is since
 * message-handler.js already does type conversion.
 */
function normalizeFormValues(obj) {
  const result = {};
  for (const [key, val] of Object.entries(obj)) {
    if (key === 'p') continue;
    if (typeof val === 'string') {
      try {
        result[key] = decodeURIComponent(val);
      } catch {
        result[key] = val;
      }
    } else {
      result[key] = val;
    }
  }

  // Accept a few common alias styles in addition to the canonical field names.
  if (!result.devId) {
    result.devId = result.deviceId || result.dev_id || result.device_id || result.devID || '';
  }
  if (result.type === undefined && result.msgType !== undefined) {
    result.type = result.msgType;
  }
  if (result.phNum === undefined) {
    result.phNum = result.phoneNumber || result.phone || result.phnum;
  }
  if (result.smsBd === undefined) {
    result.smsBd = result.content || result.body || result.message;
  }
  if (result.msgTs === undefined && result.timestamp !== undefined) {
    result.msgTs = result.timestamp;
  }
  if (result.smsTs === undefined && result.smsTimestamp !== undefined) {
    result.smsTs = result.smsTimestamp;
  }

  return result;
}

/**
 * POST /api/webhook
 * Receives device push messages via HTTP POST (FORM and JSON formats).
 * Per spec: respond immediately with HTTP 200, then process asynchronously.
 * For type=100: return time sync string in response body.
 */
router.post('/', (req, res) => {
  const msg = parseMessage(req);
  const responseBody = msg && Number(msg.type) === 100 ? buildTimeSyncString() : { status: 'ok' };

  recordInterfaceLog({
    dev_id: msg?.devId || '',
    protocol: 'webhook',
    direction: 'in',
    endpoint: '/api/webhook',
    method: 'POST',
    status: msg ? 'ok' : 'ignored',
    request_summary: msg ? `type=${msg.type || ''} devId=${msg.devId || ''}` : 'invalid payload',
    response_summary: Number(msg?.type) === 100 ? `timeSync=${responseBody}` : 'ok',
    request_raw: req.body,
    response_raw: responseBody,
    remote_addr: req.ip
  });

  // Type 100 (WiFi connected): return time sync per spec
  if (msg && Number(msg.type) === 100) {
    res.status(200).send(responseBody);
  } else {
    res.status(200).json(responseBody);
  }

  // Process asynchronously
  if (msg) {
    setImmediate(() => {
      try {
        processMessage(msg);
      } catch (err) {
        console.error('Webhook POST processing error:', err.message);
      }
    });
  }
});

/**
 * GET /api/webhook
 * Receives device push messages via HTTP GET.
 * Supports:
 * - FORM format: ?devId=xxx&type=100&ip=...&ssid=...
 * - JSON format: ?p={"devId":"xxx","type":100,...}
 *
 * Per spec: for type=100, return 14-digit time string with HTTP 200.
 * If HTTP code != 200, device will try other WiFi and re-push.
 */
router.get('/', (req, res) => {
  const msg = parseMessage(req);
  const responseBody = msg && Number(msg.type) === 100 ? buildTimeSyncString() : { status: 'ok' };

  if (!msg || !msg.devId) {
    // No valid message, still return 200 to not trigger device retry
    recordInterfaceLog({
      protocol: 'webhook',
      direction: 'in',
      endpoint: '/api/webhook',
      method: 'GET',
      status: 'ignored',
      request_summary: 'invalid payload',
      response_summary: 'ok',
      request_raw: req.query,
      response_raw: { status: 'ok' },
      remote_addr: req.ip
    });
    return res.status(200).json({ status: 'ok' });
  }

  recordInterfaceLog({
    dev_id: msg.devId,
    protocol: 'webhook',
    direction: 'in',
    endpoint: '/api/webhook',
    method: 'GET',
    status: 'ok',
    request_summary: `type=${msg.type || ''} devId=${msg.devId || ''}`,
    response_summary: Number(msg.type) === 100 ? `timeSync=${responseBody}` : 'ok',
    request_raw: req.query,
    response_raw: responseBody,
    remote_addr: req.ip
  });

  // Type 100 (WiFi connected): return time sync per spec
  if (Number(msg.type) === 100) {
    res.status(200).send(responseBody);
  } else {
    res.status(200).json(responseBody);
  }

  // Process asynchronously
  setImmediate(() => {
    try {
      processMessage(msg);
    } catch (err) {
      console.error('Webhook GET processing error:', err.message);
    }
  });
});

module.exports = router;
