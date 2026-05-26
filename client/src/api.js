const BASE = '/api';

async function request(path, options = {}) {
  const url = BASE + path;
  const config = {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  };
  if (config.body && typeof config.body === 'object') {
    config.body = JSON.stringify(config.body);
  }
  const res = await fetch(url, config);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

export const api = {
  // Health
  health: () => request('/health'),

  // Devices
  getDevices: () => request('/devices'),
  getDevice: (devId) => request(`/devices/${devId}`),
  createDevice: (data) => request('/devices', { method: 'POST', body: data }),
  updateDevice: (devId, data) => request(`/devices/${devId}`, { method: 'PUT', body: data }),
  deleteDevice: (devId) => request(`/devices/${devId}`, { method: 'DELETE' }),

  // Messages
  getMessages: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/messages${qs ? '?' + qs : ''}`);
  },
  getStats: () => request('/messages/stats'),
  getExportUrl: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return `${BASE}/messages/export${qs ? '?' + qs : ''}`;
  },

  // Commands
  sendCommand: (devId, cmd, params = {}) =>
    request(`/commands/${devId}/send`, { method: 'POST', body: { cmd, ...params } }),
  quickCommand: (devId, cmd) =>
    request(`/commands/${devId}/quick/${cmd}`, { method: 'POST' }),

  // Push Rules
  getPushRules: () => request('/push-rules'),
  createPushRule: (data) => request('/push-rules', { method: 'POST', body: data }),
  updatePushRule: (id, data) => request(`/push-rules/${id}`, { method: 'PUT', body: data }),
  deletePushRule: (id) => request(`/push-rules/${id}`, { method: 'DELETE' }),
  testPushRule: (id) => request(`/push-rules/${id}/test`, { method: 'POST' }),
  getPushLogs: (id, limit = 50) => request(`/push-rules/${id}/logs?limit=${limit}`),

  // Interface Logs
  getInterfaceLogs: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/interface-logs${qs ? '?' + qs : ''}`);
  },
  clearInterfaceLogs: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/interface-logs${qs ? '?' + qs : ''}`, { method: 'DELETE' });
  },

  // Batch Operations
  batchExecute: (devIds, cmd, params = {}) =>
    request('/batch/execute', { method: 'POST', body: { dev_ids: devIds, cmd, params } }),

  // Device Operations (active pull from device)
  enableSmsStorage: (devId, slot = 0) =>
    request(`/devices/${devId}/enable-sms-storage`, { method: 'POST', body: { slot } }),
  syncSms: (devId, slot = 0) =>
    request(`/devices/${devId}/sync-sms`, { method: 'POST', body: { slot } }),
};
