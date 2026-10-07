const db = require('./db');
const { now } = require('./utils');
const logger = require('./logger');

const RETRY_DELAYS = [5000, 15000, 30000]; // 5s, 15s, 30s
const getDeviceNameStmt = db.prepare('SELECT name FROM devices WHERE dev_id = ?');
let pushWorker = null;
let drainingPushes = false;

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

function renderTemplate(template, vars, format = 'text') {
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
  let result = String(template)
    // Update the original built-in presets without changing arbitrary custom titles.
    .replace('"title":"{{device_label}}"', '"title":"{{notification_title}}"')
    .replace('title={{device_label}}&desp=', 'title={{notification_title}}&desp=')
    .replaceAll(
      '[{{device_label}}] {{event_label}}\\n',
      '{{notification_title}} · {{event_label}}\\n{{device_label}}\\n'
    );
  result = result.replace(/{{([a-zA-Z_][a-zA-Z0-9_]*)}}/g, (placeholder, key) => {
    if (!Object.hasOwn(vars, key)) return placeholder;
    const val = vars[key];
    const value = String(val == null ? '' : val);
    return format === 'json' && key !== 'type'
      ? JSON.stringify(value).slice(1, -1)
      : format === 'form' ? encodeURIComponent(value) : value;
  });
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
    695: '录音上传成功',
    696: '录音上传失败',
    998: 'PING',
    999: 'Command',
  };

  return labels[typeNum] || `Type ${type}`;
}

function getNotificationTitle(type) {
  const typeNum = Number(type);
  if ([501, 502, 503].includes(typeNum)) return '短信';
  if ([601, 602, 603].includes(typeNum)) return '来电';
  if ([620, 621, 622, 623].includes(typeNum)) return '通话';
  return getEventLabel(type);
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
  const contentType = String(headers['Content-Type'] || headers['content-type'] || '').toLowerCase();
  const format = contentType.includes('application/json') ? 'json'
    : contentType.includes('application/x-www-form-urlencoded') ? 'form' : 'text';
  let body = renderTemplate(rule.body_template, vars, format);
  if (format === 'json') JSON.parse(body);

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

function buildPushVars(message) {
  const { dev_id, type, slot, phone, msIsdn, msisdn, content, received_at, raw_json } = message;
  const rawObj = safeJsonParse(raw_json);
  const resolvedMsIsdn = resolveMsIsdn(rawObj, slot, msIsdn || msisdn || phone);
  const device_name = getDeviceName(dev_id);
  const device_label = getDeviceLabel(dev_id, device_name);
  return {
    dev_id, device_name, device_label,
    event_label: getEventLabel(type),
    notification_title: getNotificationTitle(type),
    type, slot, phone, msIsdn: resolvedMsIsdn, msisdn: resolvedMsIsdn,
    content, received_at: new Date(received_at * 1000).toISOString(), raw_json
  };
}

async function attemptSend(job) {
  const attempt = job.attempts + 1;
  const claimed = db.prepare(`
    UPDATE push_logs SET attempts = ?, next_attempt_at = ?
    WHERE id = ? AND status = 'pending' AND attempts = ?
  `).run(attempt, now() + 30, job.id, job.attempts).changes;
  if (!claimed) return;

  const rule = db.prepare('SELECT * FROM push_rules WHERE id = ?').get(job.rule_id);
  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(job.message_id);
  if (!rule || !message) {
    db.prepare("UPDATE push_logs SET status = 'failed', error = ? WHERE id = ?")
      .run('Push rule or source message no longer exists', job.id);
    logger.error('push', 'Push delivery source is missing', { logId: job.id, ruleId: job.rule_id, messageId: job.message_id });
    return;
  }

  let responseCode = 0;
  let responseBody = '';
  try {
    const { url, fetchOpts } = buildPushRequest(rule, buildPushVars(message));
    const response = await fetch(url, { ...fetchOpts, signal: AbortSignal.timeout(10000) });
    responseCode = response.status;
    responseBody = (await response.text().catch(() => '')).slice(0, 2000);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    db.prepare(`UPDATE push_logs SET status = 'success', response_code = ?, response_body = ?, error = '' WHERE id = ?`)
      .run(responseCode, responseBody, job.id);
    logger.info('push', 'Push delivery succeeded', { logId: job.id, ruleId: job.rule_id, messageId: job.message_id, attempt, httpStatus: responseCode });
  } catch (err) {
    const errorMessage = formatFetchError(err);
    if (attempt <= RETRY_DELAYS.length) {
      db.prepare(`
        UPDATE push_logs SET status = 'pending', next_attempt_at = ?, response_code = ?, response_body = ?, error = ? WHERE id = ?
      `).run(now() + Math.ceil(RETRY_DELAYS[attempt - 1] / 1000), responseCode, responseBody, errorMessage, job.id);
      logger.warn('push', 'Push delivery retry scheduled', { logId: job.id, ruleId: job.rule_id, messageId: job.message_id, attempt, error: err.message });
    } else {
      db.prepare(`UPDATE push_logs SET status = 'failed', response_code = ?, response_body = ?, error = ? WHERE id = ?`)
        .run(responseCode, responseBody, errorMessage, job.id);
      logger.error('push', 'Push delivery failed', { logId: job.id, ruleId: job.rule_id, messageId: job.message_id, attempts: attempt, error: err.message });
    }
  }
}

async function drainPushQueue() {
  if (drainingPushes) return;
  drainingPushes = true;
  try {
    const jobs = db.prepare(`
      SELECT id, rule_id, message_id, attempts FROM push_logs
      WHERE status = 'pending' AND next_attempt_at <= ?
      ORDER BY id ASC LIMIT 10
    `).all(now());
    await Promise.all(jobs.map(attemptSend));
  } catch (err) {
    logger.error('push', 'Push queue drain failed', { error: err.message });
  } finally {
    drainingPushes = false;
  }
}

function startPushWorker() {
  if (pushWorker) return;
  pushWorker = setInterval(drainPushQueue, 1000);
  setImmediate(drainPushQueue);
}

function stopPushWorker() {
  if (!pushWorker) return;
  clearInterval(pushWorker);
  pushWorker = null;
}

function processPushRules(message) {
  try {
    const vars = buildPushVars(message);
    const rules = getMatchingRules(message.type, message.dev_id, vars.msIsdn || message.phone);
    for (const rule of rules) {
      const result = db.prepare(`
        INSERT INTO push_logs (rule_id, message_id, status, attempts, next_attempt_at, created_at)
        VALUES (?, ?, 'pending', 0, ?, ?)
      `).run(rule.id, message.id, now(), now());
      logger.info('push', 'Push delivery queued', { ruleId: rule.id, messageId: message.id, logId: result.lastInsertRowid });
    }
    if (rules.length) setImmediate(drainPushQueue);
  } catch (err) {
    logger.error('push', 'Push rule processing failed', { messageId: message?.id, error: err.message });
  }
}

module.exports = {
  processPushRules,
  startPushWorker,
  stopPushWorker,
  drainPushQueue,
  getMatchingRules,
  renderTemplate,
  buildPushRequest,
  formatFetchError,
  getNotificationTitle
};
