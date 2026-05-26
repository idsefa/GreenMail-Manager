const db = require('./db');
const { now } = require('./utils');

const RETRY_DELAYS = [5000, 15000, 30000]; // 5s, 15s, 30s
const getDeviceNameStmt = db.prepare('SELECT name FROM devices WHERE dev_id = ?');

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function resolveMsIsdn(rawObj, slot, fallback) {
  const slotNum = Number(slot || 0);
  const slotMsisdn =
    slotNum === 1
      ? (rawObj?.sim1_msIsdn || rawObj?.slotInfo?.sim1_msIsdn || '')
      : (slotNum === 2
          ? (rawObj?.sim2_msIsdn || rawObj?.slotInfo?.sim2_msIsdn || '')
          : '');

  return String(rawObj?.msIsdn || rawObj?.msisdn || slotMsisdn || fallback || '').trim();
}

function normalizePhone(value) {
  return String(value || '').trim().replace(/[\s\-()]/g, '');
}

function phoneVariants(value) {
  const normalized = normalizePhone(value);
  if (!normalized) return [];

  const variants = new Set([normalized]);
  if (normalized.startsWith('+') && normalized.length > 1) {
    variants.add(normalized.slice(1));
  }

  const digitsOnly = normalized.replace(/\D/g, '');
  if (digitsOnly) {
    variants.add(digitsOnly);
  }

  return Array.from(variants);
}

function renderTemplate(template, vars) {
  if (!template) {
    return JSON.stringify({
      dev_id: vars.dev_id,
      device_name: vars.device_name,
      device_label: vars.device_label,
      event_label: vars.event_label,
      type: vars.type,
      phone: vars.phone,
      content: vars.content,
      time: vars.received_at
    });
  }
  let result = template;
  for (const [key, val] of Object.entries(vars)) {
    result = result.replaceAll('{{' + key + '}}', String(val == null ? '' : val));
  }
  return result;
}

function parseHeaders(rawHeaders) {
  let headers = {};
  try {
    if (rawHeaders) {
      headers = JSON.parse(rawHeaders);
    }
  } catch {
    headers = {};
  }

  if (!headers['Content-Type'] && !headers['content-type']) {
    headers['Content-Type'] = 'application/json';
  }

  return headers;
}

function getEventLabel(type) {
  const typeNum = Number(type);
  const labels = {
    100: 'WiFi Connected',
    101: 'SIM1 Online',
    102: 'SIM2 Online',
    202: 'SIM Registered',
    203: 'SIM IMSI',
    204: 'SIM Ready',
    205: 'SIM Ejected',
    209: 'SIM Error',
    301: 'Modem Error',
    401: 'Command Ack',
    402: 'Command Done',
    501: '新短信',
    502: '短信已发送',
    601: '来电振铃',
    602: '来电接通',
    603: '来电挂断',
    620: '去电拨号',
    621: '去电振铃',
    622: '去电接通',
    623: '去电挂断',
    641: '本地按键',
    642: '远端按键',
    998: 'PING',
    999: 'Command',
  };

  return labels[typeNum] || `Type ${type}`;
}

function getDeviceName(devId) {
  try {
    return String(getDeviceNameStmt.get(devId)?.name || '').trim();
  } catch {
    return '';
  }
}

function getDeviceLabel(devId, deviceName) {
  const sn = String(devId || '').trim();
  const name = String(deviceName || '').trim();
  if (name && name !== sn) {
    return `${name} (${sn})`;
  }
  return name || sn;
}

function formatFetchError(err, url = '') {
  const parts = [];

  function pushPart(value) {
    const normalized = String(value || '').trim();
    if (!normalized || parts.includes(normalized)) return;
    parts.push(normalized);
  }

  if (url) {
    pushPart(`url=${url}`);
  }
  if (err?.message) {
    pushPart(err.message);
  }

  let cause = err?.cause;
  let depth = 0;
  while (cause && depth < 4) {
    if (cause.code) pushPart(`code=${cause.code}`);
    if (cause.errno && cause.errno !== cause.code) pushPart(`errno=${cause.errno}`);
    if (cause.syscall) pushPart(`syscall=${cause.syscall}`);
    if (cause.hostname || cause.host) pushPart(`host=${cause.hostname || cause.host}`);
    if (cause.address) pushPart(`address=${cause.address}`);
    if (cause.port) pushPart(`port=${cause.port}`);
    if (cause.message) pushPart(cause.message);
    cause = cause.cause;
    depth += 1;
  }

  return parts.join(' | ') || 'Unknown fetch error';
}

function applyBarkCompatibility(url, method, headers, body) {
  if (method !== 'POST') {
    return { url, headers, body };
  }

  const contentType = String(headers['Content-Type'] || headers['content-type'] || '').toLowerCase();
  if (!contentType.includes('application/json')) {
    return { url, headers, body };
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return { url, headers, body };
  }

  // Backward compatibility for the old Bark preset:
  // POST https://api.day.app/YOUR_KEY with JSON body lacking device_key.
  // Convert it to the official POST /push format.
  if (!parsedUrl.hostname.endsWith('day.app')) {
    return { url, headers, body };
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return { url, headers, body };
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.device_key) {
    return { url, headers, body };
  }

  const pathParts = parsedUrl.pathname.split('/').filter(Boolean);
  if (pathParts.length !== 1 || pathParts[0] === 'push') {
    return { url, headers, body };
  }

  payload.device_key = decodeURIComponent(pathParts[0]);
  parsedUrl.pathname = '/push';

  return {
    url: parsedUrl.toString(),
    headers,
    body: JSON.stringify(payload),
  };
}

function buildPushRequest(rule, vars) {
  const headers = parseHeaders(rule.headers);
  const method = (rule.method || 'POST').toUpperCase();
  let url = rule.url;
  let body = renderTemplate(rule.body_template, vars);

  if (method !== 'GET' && method !== 'HEAD') {
    const adapted = applyBarkCompatibility(url, method, headers, body);
    url = adapted.url;
    body = adapted.body;
  }

  const fetchOpts = { method, headers };
  if (method !== 'GET' && method !== 'HEAD') {
    fetchOpts.body = body;
  }

  return { url, fetchOpts, body };
}

function getMatchingRules(type, devId, msIsdn = '') {
  const rules = db.prepare('SELECT * FROM push_rules WHERE enabled = 1').all();
  return rules.filter((rule) => {
    // Check trigger types
    if (rule.trigger_types && rule.trigger_types.trim()) {
      const types = rule.trigger_types.split(',').map(t => t.trim()).filter(Boolean);
      if (types.length > 0 && !types.includes(String(type))) {
        return false;
      }
    }
    // Check trigger devices
    if (rule.trigger_devices && rule.trigger_devices.trim()) {
      const devices = rule.trigger_devices.split(',').map(d => d.trim()).filter(Boolean);
      if (devices.length > 0 && !devices.includes(devId)) {
        return false;
      }
    }

    // Check trigger MSISDN / phone list
    if (rule.trigger_msisdn && rule.trigger_msisdn.trim()) {
      const ruleNumbers = rule.trigger_msisdn
        .split(',')
        .map(n => n.trim())
        .filter(Boolean)
        .flatMap(phoneVariants);
      const incomingNumbers = phoneVariants(msIsdn);

      if (incomingNumbers.length === 0 || ruleNumbers.length === 0) {
        return false;
      }

      const ruleSet = new Set(ruleNumbers);
      const matched = incomingNumbers.some(n => ruleSet.has(n));
      if (!matched) {
        return false;
      }
    }

    return true;
  });
}

async function sendPush(rule, vars, messageId) {
  const { url, fetchOpts } = buildPushRequest(rule, vars);

  const ts = now();

  // Insert pending log
  const logStmt = db.prepare(`
    INSERT INTO push_logs (rule_id, message_id, status, created_at)
    VALUES (?, ?, 'pending', ?)
  `);
  const logResult = logStmt.run(rule.id, messageId, ts);
  const logId = logResult.lastInsertRowid;

  await attemptSend(logId, url, fetchOpts, 0);
}

async function attemptSend(logId, url, fetchOpts, attempt) {
  try {
    const response = await fetch(url, fetchOpts);
    const responseBody = await response.text().catch(() => '');

    db.prepare(`
      UPDATE push_logs SET status = ?, response_code = ?, response_body = ? WHERE id = ?
    `).run(
      response.ok ? 'success' : 'failed',
      response.status,
      responseBody.substring(0, 2000),
      logId
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
  } catch (err) {
    const errorMessage = formatFetchError(err, url);
    if (attempt < RETRY_DELAYS.length) {
      // Schedule retry
      setTimeout(() => {
        attemptSend(logId, url, fetchOpts, attempt + 1);
      }, RETRY_DELAYS[attempt]);
      // Mark as pending for retry
      db.prepare(`UPDATE push_logs SET error = ? WHERE id = ?`)
        .run(`Retry ${attempt + 1}/${RETRY_DELAYS.length}: ${errorMessage}`, logId);
    } else {
      db.prepare(`UPDATE push_logs SET status = 'failed', error = ? WHERE id = ?`)
        .run(errorMessage, logId);
    }
  }
}

function processPushRules(message) {
  try {
    const { id: messageId, dev_id, type, slot, phone, msIsdn, msisdn, content, received_at, raw_json } = message;
    const rawObj = safeJsonParse(raw_json);
    const resolvedMsIsdn = resolveMsIsdn(rawObj, slot, msIsdn || msisdn || phone);
    const rules = getMatchingRules(type, dev_id, resolvedMsIsdn || phone);
    const device_name = getDeviceName(dev_id);
    const device_label = getDeviceLabel(dev_id, device_name);
    const event_label = getEventLabel(type);

    const vars = {
      dev_id,
      device_name,
      device_label,
      event_label,
      type,
      slot,
      phone,
      msIsdn: resolvedMsIsdn,
      msisdn: resolvedMsIsdn,
      content,
      received_at: new Date(received_at * 1000).toISOString(),
      raw_json
    };

    for (const rule of rules) {
      sendPush(rule, vars, messageId);
    }
  } catch (err) {
    console.error('Error in push engine:', err.message);
  }
}

module.exports = { processPushRules, getMatchingRules, renderTemplate, buildPushRequest, formatFetchError };
