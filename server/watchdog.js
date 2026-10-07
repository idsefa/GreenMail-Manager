const http = require('http');
const db = require('./db');
const { calcAdminToken, now, isDeviceOnline } = require('./utils');
const { recordInterfaceLog } = require('./interface-log');
const logger = require('./logger');

const DAY_SECONDS = 86400;
const POLICY = {
  intervalMs: clamp(process.env.WATCHDOG_INTERVAL_MS, 10000, 300000, 30000),
  verifyGraceSeconds: clamp(process.env.WATCHDOG_VERIFY_GRACE_SECONDS, 30, 3600, 120),
  restartGraceSeconds: clamp(process.env.WATCHDOG_RESTART_GRACE_SECONDS, 30, 3600, 180),
  deviceRestartCooldownSeconds: clamp(process.env.WATCHDOG_DEVICE_RESTART_COOLDOWN_SECONDS, 300, DAY_SECONDS, 900),
  simRecoveryCooldownSeconds: clamp(process.env.WATCHDOG_SIM_RECOVERY_COOLDOWN_SECONDS, 300, DAY_SECONDS, 900),
  maxRecoveriesPerDay: clamp(process.env.WATCHDOG_MAX_RECOVERIES_PER_DAY, 1, 20, 2),
};

let timer = null;
let tickInProgress = false;

function clamp(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.floor(parsed))) : fallback;
}

function getResponseCode(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isSuccess(result) {
  return getResponseCode(result?.code) === 0;
}

function normalizeBoolean(value, field) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === 0 || value === 1) return value;
  if (typeof value === 'string') {
    if (value === 'true' || value === '1') return 1;
    if (value === 'false' || value === '0') return 0;
  }
  throw new Error(`${field} must be a boolean`);
}

function ensureSettings(devId, ts = now()) {
  db.prepare(`
    INSERT OR IGNORE INTO device_watchdog (dev_id, updated_at)
    VALUES (?, ?)
  `).run(devId, ts);
}

function getDeviceWatchdog(devId) {
  const device = db.prepare('SELECT last_ping_at, ping_intvl FROM devices WHERE dev_id = ?').get(devId);
  const settings = db.prepare('SELECT * FROM device_watchdog WHERE dev_id = ?').get(devId) || {
    dev_id: devId,
    enabled: 0,
    auto_device_restart: 1,
    auto_sim_restart: 1,
    last_ping_timeout_at: 0,
    last_verified_at: 0,
    last_device_restart_at: 0,
    device_restart_count: 0,
    device_restart_window_started_at: 0,
    last_device_status: 'unknown',
    last_device_reason: '',
    updated_at: 0,
  };
  const slots = db.prepare(`
    SELECT * FROM sim_slot_health WHERE dev_id = ? ORDER BY slot ASC
  `).all(devId);

  const heartbeatStatus = !device?.last_ping_at
    ? 'awaiting_heartbeat'
    : isDeviceOnline(device.last_ping_at, device.ping_intvl) ? 'healthy' : 'heartbeat_timeout';
  const deviceStatus = !settings.enabled || settings.last_device_status === 'unknown' || settings.last_device_status === 'healthy'
    ? heartbeatStatus
    : settings.last_device_status;

  return { settings, slots, deviceStatus, lastHeartbeatAt: device?.last_ping_at || 0, policy: getPublicPolicy() };
}

function updateDeviceWatchdog(devId, patch = {}) {
  const fields = ['enabled', 'auto_device_restart', 'auto_sim_restart'];
  const values = {};
  for (const field of fields) {
    if (patch[field] !== undefined) values[field] = normalizeBoolean(patch[field], field);
  }
  if (Object.keys(values).length === 0) {
    throw new Error('No watchdog setting provided');
  }

  const ts = now();
  ensureSettings(devId, ts);
  const assignments = Object.keys(values).map((field) => `${field} = ?`);
  const statement = db.prepare(`
    UPDATE device_watchdog
    SET ${assignments.join(', ')}, updated_at = ?
    WHERE dev_id = ?
  `);
  statement.run(...Object.values(values), ts, devId);

  const settings = db.prepare('SELECT * FROM device_watchdog WHERE dev_id = ?').get(devId);
  logger.info('watchdog', 'Watchdog settings updated', {
    devId,
    enabled: Boolean(settings.enabled),
    autoDeviceRestart: Boolean(settings.auto_device_restart),
    autoSimRestart: Boolean(settings.auto_sim_restart),
  });
  return getDeviceWatchdog(devId);
}

function getPublicPolicy() {
  return {
    verifyGraceSeconds: POLICY.verifyGraceSeconds,
    restartGraceSeconds: POLICY.restartGraceSeconds,
    deviceRestartCooldownSeconds: POLICY.deviceRestartCooldownSeconds,
    simRecoveryCooldownSeconds: POLICY.simRecoveryCooldownSeconds,
    maxRecoveriesPerDay: POLICY.maxRecoveriesPerDay,
  };
}

function updateDeviceState(devId, patch = {}) {
  const allowed = new Set([
    'last_ping_timeout_at',
    'last_verified_at',
    'last_device_restart_at',
    'device_restart_count',
    'device_restart_window_started_at',
    'last_device_status',
    'last_device_reason',
  ]);
  const entries = Object.entries(patch).filter(([key]) => allowed.has(key));
  if (entries.length === 0) return;

  const ts = now();
  const assignments = entries.map(([key]) => `${key} = ?`);
  const values = entries.map(([, value]) => value);
  db.prepare(`
    UPDATE device_watchdog
    SET ${assignments.join(', ')}, updated_at = ?
    WHERE dev_id = ?
  `).run(...values, ts, devId);
}

function logDeviceTransition(device, status, reason, level, message, context = {}) {
  if (device.last_device_status === status && device.last_device_reason === reason) return;
  updateDeviceState(device.dev_id, { last_device_status: status, last_device_reason: reason });
  logger[level]('watchdog', message, {
    devId: device.dev_id,
    status,
    reason,
    ...context,
  });
}

function getSlotForEvent(message, type) {
  const supplied = Number(message.slot || 0);
  if (supplied === 1 || supplied === 2) return supplied;
  if (type === 101) return 1;
  if (type === 102) return 2;
  return 0;
}

function updateSimHealth(message, type, duplicate) {
  if (duplicate) return;
  const devId = String(message.devId || '');
  const slot = getSlotForEvent(message, type);
  if (!devId || !slot) return;

  const transitions = {
    101: 'online',
    102: 'online',
    202: 'initializing',
    203: 'initializing',
    204: 'ready',
    205: 'ejected',
    209: 'error',
    301: 'modem_error',
  };
  let status = transitions[type];
  if (!status) return;

  const ts = now();
  const previous = db.prepare('SELECT * FROM sim_slot_health WHERE dev_id = ? AND slot = ?').get(devId, slot);
  if (previous?.status === 'recovering' && [202, 203, 205].includes(type)) status = 'recovering';
  const errorCode = type === 209 ? Number(message.note || 0) || 0 : 0;
  const nextErrorCount = type === 209 && !duplicate ? Number(previous?.error_count || 0) + 1 : Number(previous?.error_count || 0);
  const resetErrors = status === 'ready' || status === 'online';

  db.prepare(`
    INSERT INTO sim_slot_health (
      dev_id, slot, status, last_event_type, last_event_at, error_code,
      error_count, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(dev_id, slot) DO UPDATE SET
      status = excluded.status,
      last_event_type = excluded.last_event_type,
      last_event_at = excluded.last_event_at,
      error_code = excluded.error_code,
      error_count = excluded.error_count,
      updated_at = excluded.updated_at
  `).run(
    devId,
    slot,
    status,
    type,
    ts,
    resetErrors ? 0 : errorCode,
    resetErrors ? 0 : nextErrorCount,
    ts
  );

  if (duplicate || previous?.status === status && previous?.error_code === errorCode) return;
  const level = status === 'error' || status === 'modem_error' ? 'warn' : 'info';
  logger[level]('watchdog', 'SIM health changed', {
    devId,
    slot,
    status,
    eventType: type,
    errorCode: errorCode || undefined,
  });
}

function recordIncomingMessage(message, duplicate = false) {
  const type = Number(message?.type);
  const devId = String(message?.devId || '');
  if (!devId || !Number.isFinite(type)) return;

  if (type === 998) {
    const current = db.prepare('SELECT * FROM device_watchdog WHERE dev_id = ?').get(devId);
    if (current && current.last_device_status !== 'healthy') {
      updateDeviceState(devId, {
        last_ping_timeout_at: 0,
        last_verified_at: 0,
        last_device_status: 'healthy',
        last_device_reason: '',
      });
      logger.info('watchdog', 'Device heartbeat recovered', { devId });
    }
    return;
  }

  updateSimHealth(message, type, duplicate);
}

function httpGet(url, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error('Invalid JSON response from device'));
        }
      });
    });
    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy();
      reject(new Error('Device command timed out'));
    });
  });
}

async function sendDeviceCommand(device, command, params = {}) {
  const query = new URLSearchParams({
    token: calcAdminToken(device.admin_password || 'admin'),
    cmd: command,
  });
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) query.set(key, String(value));
  }
  const url = `http://${device.wifi_ip}/ctrl?${query.toString()}`;
  return httpGet(url);
}

function recordDeviceCommand(device, command, params, result, error) {
  recordInterfaceLog({
    dev_id: device.dev_id,
    protocol: 'watchdog',
    direction: 'out',
    endpoint: '/ctrl',
    method: 'GET',
    status: error || !isSuccess(result) ? 'failed' : 'ok',
    request_summary: `cmd=${command} (watchdog)`,
    response_summary: error ? error.message : `code=${result?.code ?? ''}`,
    request_raw: { cmd: command, ...params },
    response_raw: result || '',
    remote_addr: device.wifi_ip,
  });
}

function updateDeviceFromStat(device, result, ts) {
  db.prepare(`
    UPDATE devices SET
      hw_ver = COALESCE(NULLIF(?, ''), hw_ver),
      wifi_ip = COALESCE(NULLIF(NULLIF(?, ''), '0.0.0.0'), wifi_ip),
      wifi_ssid = COALESCE(NULLIF(?, ''), wifi_ssid),
      wifi_dbm = CASE WHEN ? > 0 THEN ? ELSE wifi_dbm END,
      ping_intvl = CASE WHEN ? > 0 THEN ? ELSE ping_intvl END,
      last_stat_at = ?,
      is_online = 1,
      updated_at = ?
    WHERE dev_id = ?
  `).run(
    result.hwVer || '',
    result.wifi?.ip || '',
    result.wifi?.ssid || '',
    Number(result.wifi?.dbm || 0), Number(result.wifi?.dbm || 0),
    Number(result.pingIntvl || 0), Number(result.pingIntvl || 0),
    ts, ts, device.dev_id
  );
}

function currentRestartCount(startedAt, count, ts) {
  if (!startedAt || ts - startedAt >= DAY_SECONDS) return { startedAt: ts, count: 0 };
  return { startedAt, count };
}

function hasActiveCall(devId, slot = 0) {
  const latest = db.prepare(`
    SELECT type FROM messages
    WHERE dev_id = ? AND received_at >= ? AND type IN (601, 602, 603, 620, 621, 622, 623)
      AND (? = 0 OR slot = ?)
    ORDER BY received_at DESC, id DESC LIMIT 1
  `).get(devId, now() - 7200, slot, slot);
  return latest && [601, 602, 620, 621, 622].includes(Number(latest.type));
}

async function verifyTimedOutDevice(device, ts) {
  updateDeviceState(device.dev_id, {
    last_ping_timeout_at: device.last_ping_at,
    last_verified_at: 0,
    last_device_status: 'verifying',
    last_device_reason: 'heartbeat_timeout',
  });
  logger.warn('watchdog', 'Heartbeat timed out; verifying device once', {
    devId: device.dev_id,
    lastPingAt: device.last_ping_at,
    timeoutSeconds: Number(device.ping_intvl || 110) * 3 + 8,
  });

  try {
    const result = await sendDeviceCommand(device, 'stat');
    recordDeviceCommand(device, 'stat', {}, result);
    if (!isSuccess(result) || result.devId !== device.dev_id) {
      logDeviceTransition(device, 'unreachable', isSuccess(result) ? 'device_id_mismatch' : `stat_code_${result?.code ?? 'unknown'}`, 'warn', 'Heartbeat verification did not succeed');
      return;
    }
    updateDeviceFromStat(device, result, ts);
    updateDeviceState(device.dev_id, {
      last_verified_at: ts,
      last_device_status: 'reporting_stale',
      last_device_reason: 'stat_reachable_waiting_for_ping',
    });
    logger.warn('watchdog', 'Device responds to stat but heartbeat remains stale', { devId: device.dev_id });
  } catch (err) {
    recordDeviceCommand(device, 'stat', {}, null, err);
    logDeviceTransition(device, 'unreachable', String(err.message || err).slice(0, 500), 'warn', 'Heartbeat verification could not reach device');
  }
}

async function restartReportingStaleDevice(device, ts) {
  const rolling = currentRestartCount(
    Number(device.device_restart_window_started_at || 0),
    Number(device.device_restart_count || 0),
    ts
  );
  if (rolling.count >= POLICY.maxRecoveriesPerDay) {
    logDeviceTransition(device, 'restart_limit_reached', 'daily_restart_limit', 'warn', 'Automatic device restart limit reached');
    return;
  }
  if (device.last_device_restart_at && ts - device.last_device_restart_at < POLICY.deviceRestartCooldownSeconds) {
    logDeviceTransition(device, 'restart_cooldown', 'device_restart_cooldown', 'warn', 'Automatic device restart is in cooldown');
    return;
  }
  if (hasActiveCall(device.dev_id)) {
    logDeviceTransition(device, 'call_active', 'device_restart_waiting_for_call', 'warn', 'Device restart deferred during active call');
    return;
  }

  updateDeviceState(device.dev_id, {
    last_device_restart_at: ts,
    device_restart_count: rolling.count + 1,
    device_restart_window_started_at: rolling.startedAt,
    last_device_status: 'restart_scheduled',
    last_device_reason: 'heartbeat_not_recovered_after_verification',
  });

  try {
    const result = await sendDeviceCommand(device, 'restart', { p1: 5 });
    recordDeviceCommand(device, 'restart', { p1: 5 }, result);
    if (!isSuccess(result)) {
      updateDeviceState(device.dev_id, { last_device_status: 'restart_failed', last_device_reason: `restart_code_${result?.code ?? 'unknown'}` });
      logger.error('watchdog', 'Automatic device restart was rejected', { devId: device.dev_id, code: result?.code, note: result?.note || '' });
      return;
    }
    logger.warn('watchdog', 'Automatic device restart scheduled', { devId: device.dev_id, delaySeconds: 5 });
  } catch (err) {
    recordDeviceCommand(device, 'restart', { p1: 5 }, null, err);
    updateDeviceState(device.dev_id, { last_device_status: 'restart_failed', last_device_reason: String(err.message || err).slice(0, 500) });
    logger.error('watchdog', 'Automatic device restart request failed', { devId: device.dev_id, error: err.message });
  }
}

async function inspectDevice(device, ts) {
  if (!device.last_ping_at) return;
  if (isDeviceOnline(device.last_ping_at, device.ping_intvl)) {
    if (device.last_device_status !== 'healthy') {
      updateDeviceState(device.dev_id, {
        last_ping_timeout_at: 0,
        last_verified_at: 0,
        last_device_status: 'healthy',
        last_device_reason: '',
      });
    }
    return;
  }

  if (!device.wifi_ip) {
    logDeviceTransition(device, 'unreachable', 'no_wifi_ip', 'warn', 'Heartbeat timed out and no LAN address is available');
    return;
  }

  if (device.last_device_restart_at && ts - device.last_device_restart_at < POLICY.restartGraceSeconds) {
    logDeviceTransition(device, 'restart_waiting', 'waiting_for_post_restart_ping', 'info', 'Waiting for heartbeat after automatic restart');
    return;
  }

  if (Number(device.last_ping_timeout_at || 0) !== Number(device.last_ping_at || 0)) {
    await verifyTimedOutDevice(device, ts);
    return;
  }

  if (!device.last_verified_at) return;
  if (ts - device.last_verified_at < POLICY.verifyGraceSeconds) return;
  if (Number(device.last_ping_at || 0) > Number(device.last_verified_at || 0)) return;
  if (!device.auto_device_restart) {
    logDeviceTransition(device, 'recovery_disabled', 'automatic_device_restart_disabled', 'warn', 'Heartbeat remains stale; automatic device restart is disabled');
    return;
  }
  await restartReportingStaleDevice(device, ts);
}

async function recoverSimSlot(slotHealth, ts) {
  const rolling = currentRestartCount(
    Number(slotHealth.recovery_window_started_at || 0),
    Number(slotHealth.recovery_count || 0),
    ts
  );
  if (rolling.count >= POLICY.maxRecoveriesPerDay) {
    db.prepare("UPDATE sim_slot_health SET status = 'manual_attention', updated_at = ? WHERE dev_id = ? AND slot = ?")
      .run(ts, slotHealth.dev_id, slotHealth.slot);
    logger.warn('watchdog', 'SIM automatic recovery limit reached', { devId: slotHealth.dev_id, slot: slotHealth.slot });
    return;
  }
  if (slotHealth.last_recovery_at && ts - slotHealth.last_recovery_at < POLICY.simRecoveryCooldownSeconds) return;
  if (hasActiveCall(slotHealth.dev_id, slotHealth.slot)) return;

  const device = db.prepare('SELECT * FROM devices WHERE dev_id = ?').get(slotHealth.dev_id);
  if (!device?.wifi_ip || !isDeviceOnline(device.last_ping_at, device.ping_intvl)) {
    if (slotHealth.status !== 'waiting_for_device') {
      db.prepare("UPDATE sim_slot_health SET status = 'waiting_for_device', updated_at = ? WHERE dev_id = ? AND slot = ?")
        .run(ts, slotHealth.dev_id, slotHealth.slot);
      logger.warn('watchdog', 'SIM recovery deferred while device is offline', { devId: slotHealth.dev_id, slot: slotHealth.slot });
    }
    return;
  }

  db.prepare(`
    UPDATE sim_slot_health SET
      status = 'recovering',
      last_recovery_at = ?,
      recovery_count = ?,
      recovery_window_started_at = ?,
      updated_at = ?
    WHERE dev_id = ? AND slot = ?
  `).run(ts, rolling.count + 1, rolling.startedAt, ts, slotHealth.dev_id, slotHealth.slot);

  try {
    const result = await sendDeviceCommand(device, 'slotrst', { p1: slotHealth.slot, p2: 5 });
    recordDeviceCommand(device, 'slotrst', { p1: slotHealth.slot, p2: 5 }, result);
    if (!isSuccess(result)) {
      db.prepare("UPDATE sim_slot_health SET status = 'error', updated_at = ? WHERE dev_id = ? AND slot = ?")
        .run(now(), slotHealth.dev_id, slotHealth.slot);
      logger.error('watchdog', 'Automatic SIM slot restart was rejected', {
        devId: slotHealth.dev_id, slot: slotHealth.slot, code: result?.code, note: result?.note || '',
      });
      return;
    }
    logger.warn('watchdog', 'Automatic SIM slot restart scheduled', { devId: slotHealth.dev_id, slot: slotHealth.slot, delaySeconds: 5 });
  } catch (err) {
    recordDeviceCommand(device, 'slotrst', { p1: slotHealth.slot, p2: 5 }, null, err);
    db.prepare("UPDATE sim_slot_health SET status = 'error', updated_at = ? WHERE dev_id = ? AND slot = ?")
      .run(now(), slotHealth.dev_id, slotHealth.slot);
    logger.error('watchdog', 'Automatic SIM slot restart request failed', { devId: slotHealth.dev_id, slot: slotHealth.slot, error: err.message });
  }
}

async function runWatchdogOnce() {
  if (tickInProgress) return;
  tickInProgress = true;
  try {
    const ts = now();
    const devices = db.prepare(`
      SELECT d.*, w.*
      FROM device_watchdog w
      JOIN devices d ON d.dev_id = w.dev_id
      WHERE w.enabled = 1
      ORDER BY d.id ASC
    `).all();
    for (const device of devices) {
      await inspectDevice(device, ts);
    }

    const slots = db.prepare(`
      SELECT s.*, w.auto_sim_restart
      FROM sim_slot_health s
      JOIN device_watchdog w ON w.dev_id = s.dev_id
      WHERE w.enabled = 1
        AND w.auto_sim_restart = 1
        AND s.status IN ('error', 'waiting_for_device')
        AND s.error_code = 3
      ORDER BY s.updated_at ASC
    `).all();
    for (const slot of slots) {
      await recoverSimSlot(slot, ts);
    }

    const recovering = db.prepare(`
      SELECT dev_id, slot, last_recovery_at FROM sim_slot_health
      WHERE status = 'recovering' AND last_recovery_at <= ?
    `).all(ts - 90);
    for (const slot of recovering) {
      db.prepare("UPDATE sim_slot_health SET status = 'error', updated_at = ? WHERE dev_id = ? AND slot = ?")
        .run(ts, slot.dev_id, slot.slot);
      logger.warn('watchdog', 'SIM did not report ready after slot restart', { devId: slot.dev_id, slot: slot.slot });
    }
  } catch (err) {
    logger.error('watchdog', 'Watchdog inspection failed', { error: err.message });
  } finally {
    tickInProgress = false;
  }
}

function startWatchdog() {
  if (timer) return;
  timer = setInterval(runWatchdogOnce, POLICY.intervalMs);
  timer.unref();
  setImmediate(runWatchdogOnce);
  logger.info('watchdog', 'Watchdog monitor started', getPublicPolicy());
}

function stopWatchdog() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

module.exports = {
  getDeviceWatchdog,
  updateDeviceWatchdog,
  recordIncomingMessage,
  runWatchdogOnce,
  startWatchdog,
  stopWatchdog,
  getPublicPolicy,
};
