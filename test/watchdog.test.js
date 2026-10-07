const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'greenmail-watchdog-test-'));
const db = require('../server/db');
const { now } = require('../server/utils');
const { getDeviceWatchdog, updateDeviceWatchdog, recordIncomingMessage, runWatchdogOnce } = require('../server/watchdog');

test('watchdog reports heartbeat availability before its first recovery event', () => {
  db.prepare('INSERT INTO devices (dev_id, ping_intvl) VALUES (?, ?)').run('status-test', 110);
  assert.equal(getDeviceWatchdog('status-test').deviceStatus, 'awaiting_heartbeat');

  db.prepare('UPDATE devices SET last_ping_at = ? WHERE dev_id = ?').run(now(), 'status-test');
  assert.equal(getDeviceWatchdog('status-test').deviceStatus, 'healthy');

  db.prepare('UPDATE devices SET last_ping_at = ? WHERE dev_id = ?').run(now() - 400, 'status-test');
  assert.equal(getDeviceWatchdog('status-test').deviceStatus, 'heartbeat_timeout');
});

test('manual stat does not replace the last device heartbeat', async (t) => {
  const mock = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ code: 0, devId: 'stat-test', wifi: {}, slotInfo: {} }));
  });
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => mock.close(resolve)));

  const lastPing = now() - 400;
  db.prepare('INSERT INTO devices (dev_id, wifi_ip, last_ping_at, ping_intvl) VALUES (?, ?, ?, ?)')
    .run('stat-test', `127.0.0.1:${mock.address().port}`, lastPing, 110);
  const app = express();
  app.use('/api/commands', require('../server/routes/commands'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/commands/stat-test/quick/stat`, { method: 'POST' });
  assert.equal(response.status, 200);
  assert.equal(db.prepare('SELECT last_ping_at FROM devices WHERE dev_id = ?').get('stat-test').last_ping_at, lastPing);
});

test('watchdog verifies stale heartbeat once and only restarts recoverable SIM errors', async (t) => {
  const commands = [];
  const mock = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const cmd = url.searchParams.get('cmd');
    commands.push(cmd);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ code: 0, devId: 'watchdog-test' }));
  });
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => mock.close(resolve)));

  const ip = `127.0.0.1:${mock.address().port}`;
  db.prepare('INSERT INTO devices (dev_id, wifi_ip, last_ping_at, ping_intvl) VALUES (?, ?, ?, ?)')
    .run('watchdog-test', ip, now() - 400, 110);
  updateDeviceWatchdog('watchdog-test', { enabled: true, auto_device_restart: true, auto_sim_restart: true });

  await runWatchdogOnce();
  await runWatchdogOnce();
  assert.deepEqual(commands, ['stat']);
  assert.equal(db.prepare('SELECT last_verified_at FROM device_watchdog WHERE dev_id = ?').get('watchdog-test').last_verified_at > 0, true);

  db.prepare('UPDATE device_watchdog SET last_verified_at = ? WHERE dev_id = ?')
    .run(now() - 121, 'watchdog-test');
  await runWatchdogOnce();
  await runWatchdogOnce();
  assert.deepEqual(commands, ['stat', 'restart']);

  db.prepare('UPDATE devices SET last_ping_at = ? WHERE dev_id = ?').run(now(), 'watchdog-test');
  recordIncomingMessage({ devId: 'watchdog-test', type: 209, slot: 1, note: 1 });
  await runWatchdogOnce();
  assert.deepEqual(commands, ['stat', 'restart']);

  recordIncomingMessage({ devId: 'watchdog-test', type: 209, slot: 1, note: 3 });
  await runWatchdogOnce();
  await runWatchdogOnce();
  assert.deepEqual(commands, ['stat', 'restart', 'slotrst']);
  assert.equal(db.prepare('SELECT status FROM sim_slot_health WHERE dev_id = ? AND slot = 1').get('watchdog-test').status, 'recovering');

  recordIncomingMessage({ devId: 'watchdog-test', type: 204, slot: 1 });
  assert.equal(db.prepare('SELECT status FROM sim_slot_health WHERE dev_id = ? AND slot = 1').get('watchdog-test').status, 'ready');
});
