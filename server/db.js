const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const dbPath = path.join(DATA_DIR, 'greenmail.db');
const db = new Database(dbPath);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dev_id TEXT UNIQUE NOT NULL,
    name TEXT DEFAULT '',
    hw_ver TEXT DEFAULT '',
    wifi_ip TEXT DEFAULT '',
    wifi_ssid TEXT DEFAULT '',
    wifi_dbm INTEGER DEFAULT 0,
    sim1_icc_id TEXT DEFAULT '',
    sim1_imsi TEXT DEFAULT '',
    sim1_phone TEXT DEFAULT '',
    sim1_plmn TEXT DEFAULT '',
    sim1_sc_name TEXT DEFAULT '',
    sim2_icc_id TEXT DEFAULT '',
    sim2_imsi TEXT DEFAULT '',
    sim2_phone TEXT DEFAULT '',
    sim2_plmn TEXT DEFAULT '',
    sim2_sc_name TEXT DEFAULT '',
    ping_intvl INTEGER DEFAULT 110,
    last_ping_at INTEGER DEFAULT 0,
    last_stat_at INTEGER DEFAULT 0,
    admin_token TEXT DEFAULT '',
    admin_password TEXT DEFAULT 'admin',
    is_online INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    updated_at INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dev_id TEXT NOT NULL,
    type INTEGER NOT NULL,
    slot INTEGER DEFAULT 0,
    phone TEXT DEFAULT '',
    content TEXT DEFAULT '',
    raw_json TEXT NOT NULL,
    received_at INTEGER DEFAULT (strftime('%s','now')),
    msg_ts INTEGER DEFAULT 0,
    dedupe_key TEXT DEFAULT ''
  );

  CREATE INDEX IF NOT EXISTS idx_messages_dev_id ON messages(dev_id);
  CREATE INDEX IF NOT EXISTS idx_messages_type ON messages(type);
  CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages(phone);
  CREATE INDEX IF NOT EXISTS idx_messages_received_at ON messages(received_at);
  CREATE INDEX IF NOT EXISTS idx_messages_content ON messages(content);


  CREATE TABLE IF NOT EXISTS message_dedup (
    dedupe_key TEXT PRIMARY KEY,
    dev_id TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    duplicate_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_message_dedup_dev_id ON message_dedup(dev_id);

  CREATE TABLE IF NOT EXISTS inbound_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dev_id TEXT DEFAULT '',
    transport TEXT NOT NULL DEFAULT '',
    remote_addr TEXT DEFAULT '',
    payload TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    available_at INTEGER NOT NULL,
    last_error TEXT DEFAULT ''
  );

  CREATE INDEX IF NOT EXISTS idx_inbound_queue_ready
    ON inbound_queue(status, available_at, id);
  CREATE INDEX IF NOT EXISTS idx_inbound_queue_dev_id ON inbound_queue(dev_id);

  CREATE TABLE IF NOT EXISTS application_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    level TEXT NOT NULL,
    scope TEXT NOT NULL,
    message TEXT NOT NULL,
    context TEXT DEFAULT '',
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_application_logs_created_at ON application_logs(created_at);
  CREATE INDEX IF NOT EXISTS idx_application_logs_level ON application_logs(level);
  CREATE INDEX IF NOT EXISTS idx_application_logs_scope ON application_logs(scope);

  CREATE TABLE IF NOT EXISTS push_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL DEFAULT '',
    enabled INTEGER DEFAULT 1,
    url TEXT NOT NULL,
    method TEXT DEFAULT 'POST',
    headers TEXT DEFAULT '{}',
    body_template TEXT DEFAULT '',
    trigger_types TEXT DEFAULT '501,601,602',
    trigger_devices TEXT DEFAULT '',
    trigger_msisdn TEXT DEFAULT '',
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS push_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    status TEXT DEFAULT 'pending',
    response_code INTEGER DEFAULT 0,
    response_body TEXT DEFAULT '',
    error TEXT DEFAULT '',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS interface_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dev_id TEXT DEFAULT '',
    protocol TEXT NOT NULL DEFAULT '',
    direction TEXT NOT NULL DEFAULT '',
    endpoint TEXT DEFAULT '',
    method TEXT DEFAULT '',
    status TEXT DEFAULT 'ok',
    request_summary TEXT DEFAULT '',
    response_summary TEXT DEFAULT '',
    request_raw TEXT DEFAULT '',
    response_raw TEXT DEFAULT '',
    remote_addr TEXT DEFAULT '',
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE INDEX IF NOT EXISTS idx_interface_logs_dev_id ON interface_logs(dev_id);
  CREATE INDEX IF NOT EXISTS idx_interface_logs_protocol ON interface_logs(protocol);
  CREATE INDEX IF NOT EXISTS idx_interface_logs_direction ON interface_logs(direction);
  CREATE INDEX IF NOT EXISTS idx_interface_logs_status ON interface_logs(status);
  CREATE INDEX IF NOT EXISTS idx_interface_logs_created_at ON interface_logs(created_at);

  CREATE TABLE IF NOT EXISTS device_watchdog (
    dev_id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    auto_device_restart INTEGER NOT NULL DEFAULT 1,
    auto_sim_restart INTEGER NOT NULL DEFAULT 1,
    last_ping_timeout_at INTEGER NOT NULL DEFAULT 0,
    last_verified_at INTEGER NOT NULL DEFAULT 0,
    last_device_restart_at INTEGER NOT NULL DEFAULT 0,
    device_restart_count INTEGER NOT NULL DEFAULT 0,
    device_restart_window_started_at INTEGER NOT NULL DEFAULT 0,
    last_device_status TEXT NOT NULL DEFAULT 'unknown',
    last_device_reason TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS sim_slot_health (
    dev_id TEXT NOT NULL,
    slot INTEGER NOT NULL CHECK (slot IN (1, 2)),
    status TEXT NOT NULL DEFAULT 'unknown',
    last_event_type INTEGER NOT NULL DEFAULT 0,
    last_event_at INTEGER NOT NULL DEFAULT 0,
    error_code INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0,
    last_recovery_at INTEGER NOT NULL DEFAULT 0,
    recovery_count INTEGER NOT NULL DEFAULT 0,
    recovery_window_started_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    PRIMARY KEY (dev_id, slot)
  );

  CREATE INDEX IF NOT EXISTS idx_sim_slot_health_status
    ON sim_slot_health(status, updated_at);

  CREATE TABLE IF NOT EXISTS call_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dev_id TEXT NOT NULL,
    slot INTEGER NOT NULL,
    direction INTEGER NOT NULL,
    phone TEXT NOT NULL DEFAULT '',
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL DEFAULT 0,
    connected INTEGER NOT NULL DEFAULT 0,
    raw_json TEXT NOT NULL,
    synced_at INTEGER NOT NULL,
    UNIQUE (dev_id, slot, direction, phone, started_at, ended_at)
  );
  CREATE INDEX IF NOT EXISTS idx_call_records_started_at ON call_records(started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_call_records_dev_id ON call_records(dev_id, started_at DESC);

  CREATE TABLE IF NOT EXISTS call_sync_jobs (
    dev_id TEXT PRIMARY KEY,
    due_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_call_sync_jobs_due ON call_sync_jobs(due_at);

  CREATE TABLE IF NOT EXISTS recordings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id TEXT NOT NULL UNIQUE,
    filename TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    dev_id TEXT NOT NULL DEFAULT '',
    slot INTEGER NOT NULL DEFAULT 0,
    phone TEXT NOT NULL DEFAULT '',
    call_started_at INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_recordings_dev_id ON recordings(dev_id, created_at DESC);
`);

// Lightweight schema migration for existing databases.
const pushRuleColumns = db.prepare("PRAGMA table_info(push_rules)").all().map((c) => c.name);
if (!pushRuleColumns.includes('trigger_msisdn')) {
  db.exec("ALTER TABLE push_rules ADD COLUMN trigger_msisdn TEXT DEFAULT ''");
}

const pushLogColumns = db.prepare('PRAGMA table_info(push_logs)').all().map((c) => c.name);
if (!pushLogColumns.includes('attempts')) db.exec('ALTER TABLE push_logs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
if (!pushLogColumns.includes('next_attempt_at')) db.exec('ALTER TABLE push_logs ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0');
db.exec('CREATE INDEX IF NOT EXISTS idx_push_logs_due ON push_logs(status, next_attempt_at, id)');

const messageColumns = db.prepare("PRAGMA table_info(messages)").all().map((c) => c.name);
if (!messageColumns.includes('dedupe_key')) {
  db.exec("ALTER TABLE messages ADD COLUMN dedupe_key TEXT DEFAULT ''");
}
db.exec('CREATE INDEX IF NOT EXISTS idx_messages_dedupe_key ON messages(dedupe_key)');

// Multiple distinct SMS may share the same sender and second-level timestamp.
db.exec('DROP INDEX IF EXISTS idx_messages_sms_identity');
db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_sms_candidates
  ON messages(dev_id, type, slot, phone, msg_ts)
  WHERE type IN (501, 502) AND msg_ts > 0`);

module.exports = db;
