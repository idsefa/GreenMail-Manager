const crypto = require('crypto');

/**
 * Calculate admin token for device control commands.
 * token = MD5("admin|" + password).toLowerCase()
 */
function calcAdminToken(password) {
  return crypto.createHash('md5').update('admin|' + password).digest('hex');
}

/**
 * Get current Unix timestamp in seconds
 */
function now() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Get the Unix timestamp for the start of the current local day.
 * Respects the server process timezone, for example TZ=Asia/Shanghai.
 */
function startOfLocalDay(ts = now()) {
  const date = new Date(ts * 1000);
  date.setHours(0, 0, 0, 0);
  return Math.floor(date.getTime() / 1000);
}

/**
 * Check if a device is online based on last PING time.
 * Online if: (now - last_ping_at) <= (ping_intvl * 3 + 8)
 */
function isDeviceOnline(lastPingAt, pingIntvl) {
  if (!lastPingAt) return false;
  const threshold = pingIntvl * 3 + 8;
  return (now() - lastPingAt) <= threshold;
}

module.exports = { calcAdminToken, now, startOfLocalDay, isDeviceOnline };
