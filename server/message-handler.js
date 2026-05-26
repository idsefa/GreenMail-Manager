const db = require('./db');
const { now } = require('./utils');
const { broadcast } = require('./ws');
const { processPushRules } = require('./push-engine');

// Prepared statements for performance
const upsertDevice = db.prepare(`
  INSERT INTO devices (dev_id, hw_ver, wifi_ip, wifi_ssid, wifi_dbm, ping_intvl, updated_at)
  VALUES (@devId, @hwVer, @ip, @ssid, @dbm, @pingIntvl, @updatedAt)
  ON CONFLICT(dev_id) DO UPDATE SET
    wifi_ip = COALESCE(NULLIF(@ip, ''), wifi_ip),
    wifi_ssid = COALESCE(NULLIF(@ssid, ''), wifi_ssid),
    wifi_dbm = CASE WHEN @dbm > 0 THEN @dbm ELSE wifi_dbm END,
    ping_intvl = CASE WHEN @pingIntvl > 0 THEN @pingIntvl ELSE ping_intvl END,
    updated_at = @updatedAt
`);

const updateDeviceSimInfo = db.prepare(`
  UPDATE devices SET
    sim1_icc_id = COALESCE(NULLIF(@sim1_icc_id, ''), sim1_icc_id),
    sim1_imsi = COALESCE(NULLIF(@sim1_imsi, ''), sim1_imsi),
    sim1_phone = COALESCE(NULLIF(@sim1_phone, ''), sim1_phone),
    sim1_plmn = COALESCE(NULLIF(@sim1_plmn, ''), sim1_plmn),
    sim1_sc_name = COALESCE(NULLIF(@sim1_sc_name, ''), sim1_sc_name),
    sim2_icc_id = COALESCE(NULLIF(@sim2_icc_id, ''), sim2_icc_id),
    sim2_imsi = COALESCE(NULLIF(@sim2_imsi, ''), sim2_imsi),
    sim2_phone = COALESCE(NULLIF(@sim2_phone, ''), sim2_phone),
    sim2_plmn = COALESCE(NULLIF(@sim2_plmn, ''), sim2_plmn),
    sim2_sc_name = COALESCE(NULLIF(@sim2_sc_name, ''), sim2_sc_name),
    updated_at = @updatedAt
  WHERE dev_id = @devId
`);

const updatePing = db.prepare(`
  UPDATE devices SET last_ping_at = @ts, is_online = 1, updated_at = @ts WHERE dev_id = @devId
`);

const insertMessage = db.prepare(`
  INSERT INTO messages (dev_id, type, slot, phone, content, raw_json, received_at, msg_ts)
  VALUES (@devId, @type, @slot, @phone, @content, @rawJson, @receivedAt, @msgTs)
`);

const updateDeviceFromStat = db.prepare(`
  UPDATE devices SET
    hw_ver = COALESCE(NULLIF(@hwVer, ''), hw_ver),
    wifi_ip = COALESCE(NULLIF(@ip, ''), wifi_ip),
    wifi_ssid = COALESCE(NULLIF(@ssid, ''), wifi_ssid),
    wifi_dbm = CASE WHEN @dbm > 0 THEN @dbm ELSE wifi_dbm END,
    ping_intvl = CASE WHEN @pingIntvl > 0 THEN @pingIntvl ELSE ping_intvl END,
    sim1_icc_id = COALESCE(NULLIF(@sim1_icc_id, ''), sim1_icc_id),
    sim1_imsi = COALESCE(NULLIF(@sim1_imsi, ''), sim1_imsi),
    sim1_phone = COALESCE(NULLIF(@sim1_phone, ''), sim1_phone),
    sim1_plmn = COALESCE(NULLIF(@sim1_plmn, ''), sim1_plmn),
    sim1_sc_name = COALESCE(NULLIF(@sim1_sc_name, ''), sim1_sc_name),
    sim2_icc_id = COALESCE(NULLIF(@sim2_icc_id, ''), sim2_icc_id),
    sim2_imsi = COALESCE(NULLIF(@sim2_imsi, ''), sim2_imsi),
    sim2_phone = COALESCE(NULLIF(@sim2_phone, ''), sim2_phone),
    sim2_plmn = COALESCE(NULLIF(@sim2_plmn, ''), sim2_plmn),
    sim2_sc_name = COALESCE(NULLIF(@sim2_sc_name, ''), sim2_sc_name),
    last_stat_at = @ts,
    updated_at = @ts
  WHERE dev_id = @devId
`);

/**
 * Process a received message (from HTTP webhook or TCP server).
 * Stores the raw message and updates device state.
 */
function processMessage(msg) {
  try {
    const devId = msg.devId;
    if (!devId) {
      console.warn('Message missing devId:', JSON.stringify(msg).substring(0, 200));
      return;
    }

    const type = Number(msg.type);
    const ts = now();
    const msgTs = Number(msg.msgTs || msg.ts || 0);

    // Extract common fields
    const slot = Number(msg.slot || 0);
    const phone = String(msg.phNum || msg.phone || '');
    const msIsdn = String(
      msg.msIsdn ||
      msg.msisdn ||
      (slot === 1 ? (msg.sim1_msIsdn || msg.slotInfo?.sim1_msIsdn || '') : '') ||
      (slot === 2 ? (msg.sim2_msIsdn || msg.slotInfo?.sim2_msIsdn || '') : '')
    );
    const content = String(msg.smsBd || msg.content || msg.val || msg.note || '');

    // Store message in database
    const result = insertMessage.run({
      devId,
      type,
      slot,
      phone,
      content,
      rawJson: JSON.stringify(msg),
      receivedAt: ts,
      msgTs
    });

    // Broadcast message via WebSocket
    broadcast('message', { dev_id: devId, msg_type: type, slot, phone, content });

    // Process push rules
    const messageId = result.lastInsertRowid;
    processPushRules({
      id: messageId,
      dev_id: devId,
      type,
      slot,
      phone,
      msIsdn,
      content,
      received_at: ts,
      raw_json: JSON.stringify(msg)
    });

    // Extract SIM info
    const sim1_icc_id = msg.sim1_iccId || (msg.slot == 1 ? (msg.iccId || '') : '');
    const sim1_imsi = msg.sim1_imsi || (msg.slot == 1 ? (msg.imsi || '') : '');
    const sim1_phone = msg.sim1_msIsdn || (msg.slot == 1 ? (msg.msIsdn || '') : '');
    const sim1_plmn = msg.sim1_plmn || '';
    const sim1_sc_name = msg.sim1_scName || (msg.slot == 1 ? (msg.scName || '') : '');
    const sim2_icc_id = msg.sim2_iccId || (msg.slot == 2 ? (msg.iccId || '') : '');
    const sim2_imsi = msg.sim2_imsi || (msg.slot == 2 ? (msg.imsi || '') : '');
    const sim2_phone = msg.sim2_msIsdn || (msg.slot == 2 ? (msg.msIsdn || '') : '');
    const sim2_plmn = msg.sim2_plmn || '';
    const sim2_sc_name = msg.sim2_scName || (msg.slot == 2 ? (msg.scName || '') : '');

    // Handle specific message types
    switch (type) {
      case 100: // WiFi connected - first message, auto-register device
        upsertDevice.run({
          devId,
          hwVer: msg.hwVer || '',
          ip: msg.ip || '',
          ssid: msg.ssid || '',
          dbm: Number(msg.dbm || 0),
          pingIntvl: Number(msg.pingIntvl || 0),
          updatedAt: ts
        });
        // Update SIM info from slotInfo if present
        if (msg.slotInfo || sim1_icc_id || sim2_icc_id) {
          updateDeviceSimInfo.run({
            devId,
            sim1_icc_id, sim1_imsi, sim1_phone, sim1_plmn, sim1_sc_name,
            sim2_icc_id, sim2_imsi, sim2_phone, sim2_plmn, sim2_sc_name,
            updatedAt: ts
          });
        }
        break;

      case 998: // PING - update last_ping_at and online status
        updatePing.run({ devId, ts });
        broadcast('device_update', { dev_id: devId, is_online: true });
        break;

      case 999: // Command result - also treat as stat update if contains status info
        if (msg.code === 0 && msg.devId) {
          updateDeviceFromStat.run({
            devId,
            hwVer: msg.hwVer || '',
            ip: msg.wifi?.ip || '',
            ssid: msg.wifi?.ssid || '',
            dbm: Number(msg.wifi?.dbm || 0),
            pingIntvl: Number(msg.pingIntvl || 0),
            sim1_icc_id: msg.slotInfo?.sim1_iccId || '',
            sim1_imsi: msg.slotInfo?.sim1_imsi || '',
            sim1_phone: msg.slotInfo?.sim1_msIsdn || '',
            sim1_plmn: msg.slotInfo?.sim1_plmn || '',
            sim1_sc_name: msg.slotInfo?.sim1_scName || '',
            sim2_icc_id: msg.slotInfo?.sim2_iccId || '',
            sim2_imsi: msg.slotInfo?.sim2_imsi || '',
            sim2_phone: msg.slotInfo?.sim2_msIsdn || '',
            sim2_plmn: msg.slotInfo?.sim2_plmn || '',
            sim2_sc_name: msg.slotInfo?.sim2_scName || '',
            ts
          });
        }
        break;

      case 101: // SIM1 online
      case 102: // SIM2 online
      case 202: // SIM registered
      case 203: // SIM IMSI reported
      case 204: // SIM ready
      case 205: // SIM ejected
      case 209: // SIM error
      case 301: // Modem error
      case 501: // New SMS
      case 502: // SMS sent
      case 601: // Incoming ring
      case 602: // Incoming answer
      case 603: // Incoming hangup
      case 620: // Outgoing dial
      case 621: // Outgoing ring
      case 622: // Outgoing answer
      case 623: // Outgoing hangup
      case 641: // Local DTMF
      case 642: // Remote DTMF
        // Ensure device exists and update SIM info
        upsertDevice.run({
          devId,
          hwVer: '',
          ip: '',
          ssid: '',
          dbm: 0,
          pingIntvl: 0,
          updatedAt: ts
        });
        if (sim1_icc_id || sim2_icc_id || sim1_imsi || sim2_imsi) {
          updateDeviceSimInfo.run({
            devId,
            sim1_icc_id, sim1_imsi, sim1_phone, sim1_plmn, sim1_sc_name,
            sim2_icc_id, sim2_imsi, sim2_phone, sim2_plmn, sim2_sc_name,
            updatedAt: ts
          });
        }
        break;

      default:
        // Unknown message type - still ensure device exists
        upsertDevice.run({
          devId,
          hwVer: '',
          ip: '',
          ssid: '',
          dbm: 0,
          pingIntvl: 0,
          updatedAt: ts
        });
        break;
    }
  } catch (err) {
    console.error('Error processing message:', err.message, err.stack);
  }
}

module.exports = { processMessage };
