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
    msg_ts INTEGER DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_messages_dev_id ON messages(dev_id);
  CREATE INDEX IF NOT EXISTS idx_messages_type ON messages(type);
  CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages(phone);
  CREATE INDEX IF NOT EXISTS idx_messages_received_at ON messages(received_at);
  CREATE INDEX IF NOT EXISTS idx_messages_content ON messages(content);

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
`);

// Lightweight schema migration for existing databases.
const pushRuleColumns = db.prepare("PRAGMA table_info(push_rules)").all().map((c) => c.name);
if (!pushRuleColumns.includes('trigger_msisdn')) {
  db.exec("ALTER TABLE push_rules ADD COLUMN trigger_msisdn TEXT DEFAULT ''");
}

module.exports = db;
