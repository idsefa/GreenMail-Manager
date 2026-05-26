import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { subscribe } from '../ws';
import { useLang } from '../i18n.jsx';
import { getDeviceDisplayParts } from '../utils/device-label';

function mergeDevicesPreservingOrder(prevDevices, nextDevices) {
  if (prevDevices.length === 0) {
    return nextDevices;
  }

  const nextMap = new Map(nextDevices.map(device => [device.dev_id, device]));
  const seen = new Set();

  const merged = [];
  for (const device of prevDevices) {
    if (!nextMap.has(device.dev_id)) continue;
    merged.push(nextMap.get(device.dev_id));
    seen.add(device.dev_id);
  }

  for (const device of nextDevices) {
    if (seen.has(device.dev_id)) continue;
    merged.push(device);
  }

  return merged;
}

function formatTime(ts, t) {
  if (!ts) return t('common.never');
  return new Date(ts * 1000).toLocaleString();
}

function timeAgo(ts, t) {
  if (!ts) return t('common.never');
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default function Devices() {
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [batchLoading, setBatchLoading] = useState(false);
  const [resultsModal, setResultsModal] = useState(null);
  const [smsPhone, setSmsPhone] = useState('');
  const [smsContent, setSmsContent] = useState('');
  // Add device state
  const [showAddForm, setShowAddForm] = useState(false);
  const [addDevId, setAddDevId] = useState('');
  const [addDevIp, setAddDevIp] = useState('');
  const [addDevName, setAddDevName] = useState('');
  const [addDevPassword, setAddDevPassword] = useState('admin');
  const [addLoading, setAddLoading] = useState(false);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(() => {
    const stored = localStorage.getItem('gm-devices-auto-refresh-enabled');
    return stored === null ? true : stored === '1';
  });
  const [autoRefreshSeconds, setAutoRefreshSeconds] = useState(() => {
    const stored = Number(localStorage.getItem('gm-devices-auto-refresh-seconds') || 10);
    return [5, 10, 30, 60].includes(stored) ? stored : 10;
  });
  const autoRefreshBusyRef = useRef(false);
  const { t } = useLang();

  useEffect(() => {
    loadDevices();

    const unsub = subscribe((msg) => {
      if (msg.type === 'device_update') {
        setDevices(prev => prev.map(d =>
          d.dev_id === msg.data.dev_id ? { ...d, is_online: msg.data.is_online ? 1 : 0 } : d
        ));
      }
    });

    return unsub;
  }, []);

  useEffect(() => {
    localStorage.setItem('gm-devices-auto-refresh-enabled', autoRefreshEnabled ? '1' : '0');
  }, [autoRefreshEnabled]);

  useEffect(() => {
    localStorage.setItem('gm-devices-auto-refresh-seconds', String(autoRefreshSeconds));
  }, [autoRefreshSeconds]);

  useEffect(() => {
    if (!autoRefreshEnabled) return;

    const timer = setInterval(() => {
      refreshDevices();
    }, autoRefreshSeconds * 1000);

    return () => clearInterval(timer);
  }, [autoRefreshEnabled, autoRefreshSeconds]);

  async function loadDevices() {
    try {
      const data = await api.getDevices();
      setDevices(prev => mergeDevicesPreservingOrder(prev, data.devices || []));
    } catch (err) {
      console.error('Failed to load devices:', err);
    }
    setLoading(false);
  }

  async function refreshDevices() {
    if (autoRefreshBusyRef.current) return;
    autoRefreshBusyRef.current = true;
    try {
      await loadDevices();
    } finally {
      autoRefreshBusyRef.current = false;
    }
  }

  async function handleDelete(e, devId) {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm(t('devices.deleteConfirm', { devId }))) return;
    await api.deleteDevice(devId);
    loadDevices();
  }

  function toggleSelect(devId) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(devId)) next.delete(devId);
      else next.add(devId);
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(devices.map(d => d.dev_id)));
  }

  function deselectAll() {
    setSelected(new Set());
  }

  async function handleBatchStat() {
    const devIds = [...selected];
    setBatchLoading(true);
    try {
      const data = await api.batchExecute(devIds, 'stat');
      setResultsModal({ title: t('devices.batchStatResults'), results: data.results });
    } catch (err) {
      setResultsModal({ title: t('devices.batchStatError'), results: [{ dev_id: '-', success: false, error: err.message }] });
    }
    setBatchLoading(false);
  }

  async function handleBatchRestart() {
    if (!confirm(t('devices.batchRestartConfirm', { count: selected.size }))) return;
    const devIds = [...selected];
    setBatchLoading(true);
    try {
      const data = await api.batchExecute(devIds, 'restart');
      setResultsModal({ title: t('devices.batchRestartResults'), results: data.results });
    } catch (err) {
      setResultsModal({ title: t('devices.batchRestartError'), results: [{ dev_id: '-', success: false, error: err.message }] });
    }
    setBatchLoading(false);
  }

  async function handleBatchSms(e) {
    e.preventDefault();
    if (!smsPhone || !smsContent) return;
    const devIds = [...selected];
    setBatchLoading(true);
    try {
      const data = await api.batchExecute(devIds, 'sendsms', { p1: smsPhone, p2: smsContent });
      setResultsModal({ title: t('devices.batchSMSResults'), results: data.results });
      setSmsPhone('');
      setSmsContent('');
    } catch (err) {
      setResultsModal({ title: t('devices.batchSMSError'), results: [{ dev_id: '-', success: false, error: err.message }] });
    }
    setBatchLoading(false);
  }

  async function handleAddDevice(e) {
    e.preventDefault();
    if (!addDevIp.trim()) return;
    setAddLoading(true);
    try {
      const data = await api.createDevice({
        dev_id: addDevId.trim() || undefined,
        wifi_ip: addDevIp.trim(),
        name: addDevName.trim(),
        admin_password: addDevPassword || 'admin'
      });
      setAddDevId('');
      setAddDevIp('');
      setAddDevName('');
      setAddDevPassword('admin');
      setShowAddForm(false);
      loadDevices();
      if (data.auto_detected) {
        alert('Device detected! ID: ' + data.device.dev_id + ' (online)');
      }
    } catch (err) {
      alert('Failed to add device: ' + err.message);
    }
    setAddLoading(false);
  }

  if (loading) return <div className="text-gray-500">{t('common.loading')}</div>;

  const selectedCount = selected.size;
  const deviceMap = new Map(devices.map(device => [device.dev_id, device]));

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-bold text-gray-800">{t('devices.title')}</h2>
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-500">{t('devices.deviceCount', { count: devices.length })}</span>
          <label className="inline-flex items-center gap-1.5 text-xs text-gray-600">
            <input
              type="checkbox"
              checked={autoRefreshEnabled}
              onChange={e => setAutoRefreshEnabled(e.target.checked)}
            />
            {t('devices.autoRefresh')}
          </label>
          <select
            value={autoRefreshSeconds}
            onChange={e => setAutoRefreshSeconds(Number(e.target.value))}
            disabled={!autoRefreshEnabled}
            className="border rounded px-2 py-1 text-xs disabled:opacity-50"
          >
            {[5, 10, 30, 60].map(sec => (
              <option key={sec} value={sec}>{t('devices.refreshEverySeconds', { seconds: sec })}</option>
            ))}
          </select>
          <button
            onClick={refreshDevices}
            className="px-2 py-1 rounded text-xs bg-gray-200 text-gray-700 hover:bg-gray-300"
          >
            {t('devices.refreshNow')}
          </button>
          <button
            onClick={() => setShowAddForm(!showAddForm)}
            className={`px-3 py-1.5 rounded text-sm font-medium ${showAddForm ? 'bg-gray-300 text-gray-700' : 'bg-green-600 text-white hover:bg-green-700'}`}
          >
            {showAddForm ? t('common.cancel') : t('devices.addDevice')}
          </button>
          <button
            onClick={() => { setSelectMode(!selectMode); if (selectMode) deselectAll(); }}
            className={`px-3 py-1.5 rounded text-sm font-medium ${selectMode ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'}`}
          >
            {selectMode ? t('common.cancel') : t('common.select')}
          </button>
        </div>
      </div>

      {/* Add Device Form */}
      {showAddForm && (
        <form onSubmit={handleAddDevice} className="bg-white rounded-lg shadow p-4 mb-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">{t('devices.addDeviceForm')}</h3>
          <div className="grid grid-cols-1 sm:grid-cols-5 gap-3 items-end">
            <div>
              <label className="text-xs text-gray-500">{t('devices.ipAddress')}</label>
              <input type="text" value={addDevIp} onChange={e => setAddDevIp(e.target.value)}
                placeholder={t('devices.ipAddressPlaceholder')} required
                className="block w-full border rounded px-2 py-1.5 text-sm" />
            </div>
            <div>
              <label className="text-xs text-gray-500">{t('devices.adminPassword')}</label>
              <input type="text" value={addDevPassword} onChange={e => setAddDevPassword(e.target.value)}
                placeholder={t('devices.adminPasswordPlaceholder')}
                className="block w-full border rounded px-2 py-1.5 text-sm" />
            </div>
            <div>
              <label className="text-xs text-gray-500">{t('devices.deviceId')}</label>
              <input type="text" value={addDevId} onChange={e => setAddDevId(e.target.value)}
                placeholder={t('devices.deviceIdPlaceholder')}
                className="block w-full border rounded px-2 py-1.5 text-sm" />
            </div>
            <div>
              <label className="text-xs text-gray-500">{t('devices.deviceName')}</label>
              <input type="text" value={addDevName} onChange={e => setAddDevName(e.target.value)}
                placeholder={t('devices.deviceNamePlaceholder')}
                className="block w-full border rounded px-2 py-1.5 text-sm" />
            </div>
            <button type="submit" disabled={addLoading || !addDevIp.trim()}
              className="px-4 py-1.5 bg-green-600 text-white rounded text-sm font-medium hover:bg-green-700 disabled:opacity-50">
              {addLoading ? t('common.connectingDevice') : t('devices.addDevice')}
            </button>
          </div>
          <p className="text-xs text-gray-400 mt-2">
            {t('devices.addDeviceHint')}
          </p>
        </form>
      )}

      {selectMode && (
        <div className="bg-white rounded-lg shadow p-4 mb-4 flex flex-wrap items-center gap-3">
          <span className="text-sm text-gray-600">{t('devices.selectedCount', { count: selectedCount })}</span>
          <button onClick={selectAll} className="px-3 py-1 bg-gray-200 text-gray-700 rounded text-sm hover:bg-gray-300">{t('devices.selectAll')}</button>
          <button onClick={deselectAll} className="px-3 py-1 bg-gray-200 text-gray-700 rounded text-sm hover:bg-gray-300">{t('devices.deselectAll')}</button>
        </div>
      )}

      {selectMode && selectedCount >= 2 && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4">
          <h3 className="text-sm font-semibold text-blue-800 mb-3">{t('devices.batchActions', { count: selectedCount })}</h3>
          <div className="flex flex-wrap gap-3 items-start">
            <button
              onClick={handleBatchStat}
              disabled={batchLoading}
              className="px-4 py-2 bg-blue-600 text-white rounded text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              {batchLoading ? t('common.running') : t('devices.batchStat')}
            </button>
            <button
              onClick={handleBatchRestart}
              disabled={batchLoading}
              className="px-4 py-2 bg-orange-600 text-white rounded text-sm font-medium hover:bg-orange-700 disabled:opacity-50"
            >
              {batchLoading ? t('common.running') : t('devices.batchRestart')}
            </button>
          </div>
          <form onSubmit={handleBatchSms} className="mt-3 flex flex-wrap gap-2 items-end">
            <div>
              <label className="text-xs text-gray-500">{t('common.phone')}</label>
              <input
                type="text"
                value={smsPhone}
                onChange={e => setSmsPhone(e.target.value)}
                placeholder="+123****7890"
                className="block border rounded px-2 py-1.5 text-sm w-40"
              />
            </div>
            <div>
              <label className="text-xs text-gray-500">{t('common.content')}</label>
              <input
                type="text"
                value={smsContent}
                onChange={e => setSmsContent(e.target.value)}
                placeholder={t('devices.smsContentPlaceholder')}
                className="block border rounded px-2 py-1.5 text-sm w-64"
              />
            </div>
            <button
              type="submit"
              disabled={batchLoading || !smsPhone || !smsContent}
              className="px-4 py-2 bg-green-600 text-white rounded text-sm font-medium hover:bg-green-700 disabled:opacity-50"
            >
              {t('devices.sendToAll')}
            </button>
          </form>
        </div>
      )}

      {devices.length === 0 ? (
        <div className="bg-white rounded-lg shadow p-8 text-center text-gray-500">
          <p className="text-lg mb-2">{t('devices.noDevices')}</p>
          <p className="text-sm">{t('devices.noDevicesHint')}</p>
        </div>
      ) : (
        <div className="grid gap-4">
          {devices.map((d) => {
            const deviceDisplay = getDeviceDisplayParts(d, { preferName: true });
            return (
              <div key={d.dev_id} className="bg-white rounded-lg shadow p-4 hover:shadow-md transition-shadow">
                <div className="flex items-start gap-3">
                  {selectMode && (
                    <input
                      type="checkbox"
                      checked={selected.has(d.dev_id)}
                      onChange={() => toggleSelect(d.dev_id)}
                      className="mt-1 w-4 h-4 rounded border-gray-300 flex-shrink-0"
                    />
                  )}
                  <Link to={`/devices/${d.dev_id}`} className="block flex-1">
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-3">
                          <span className={`w-3 h-3 rounded-full flex-shrink-0 ${d.is_online ? 'bg-green-500' : 'bg-red-500'}`} />
                          <h3 className="text-lg font-semibold text-gray-800">
                            {deviceDisplay.primary}
                          </h3>
                          {deviceDisplay.secondary && (
                            <span className="text-sm text-gray-400 font-mono">{deviceDisplay.secondary}</span>
                          )}
                        </div>
                        <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-2 text-sm text-gray-600">
                          <div>
                            <span className="text-gray-400">{t('devices.ip')}:</span> {d.wifi_ip || '-'}
                          </div>
                          <div>
                            <span className="text-gray-400">{t('devices.ssid')}:</span> {d.wifi_ssid || '-'}
                          </div>
                          <div>
                            <span className="text-gray-400">{t('devices.hw')}:</span> {d.hw_ver || '-'}
                          </div>
                          <div>
                            <span className="text-gray-400">{t('devices.lastPing')}:</span> {timeAgo(d.last_ping_at, t)}
                          </div>
                          {d.sim1_icc_id && (
                            <div>
                              <span className="text-gray-400">{t('devices.sim1')}:</span> {d.sim1_phone || d.sim1_icc_id.slice(-4)}
                            </div>
                          )}
                          {d.sim2_icc_id && (
                            <div>
                              <span className="text-gray-400">{t('devices.sim2')}:</span> {d.sim2_phone || d.sim2_icc_id.slice(-4)}
                            </div>
                          )}
                        </div>
                      </div>
                      <button
                        onClick={(e) => handleDelete(e, d.dev_id)}
                        className="text-red-400 hover:text-red-600 text-sm ml-4 px-2 py-1"
                        title={t('devices.deleteDevice')}
                      >
                        {t('common.delete')}
                      </button>
                    </div>
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Results Modal */}
      {resultsModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[80vh] flex flex-col">
            <div className="flex justify-between items-center px-6 py-4 border-b">
              <h3 className="text-lg font-semibold text-gray-800">{resultsModal.title}</h3>
              <button
                onClick={() => setResultsModal(null)}
                className="text-gray-400 hover:text-gray-600 text-xl"
              >
                &times;
              </button>
            </div>
            <div className="p-6 overflow-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-2 px-2 text-gray-500">{t('devices.deviceHeader')}</th>
                    <th className="text-left py-2 px-2 text-gray-500">{t('devices.statusHeader')}</th>
                    <th className="text-left py-2 px-2 text-gray-500">{t('devices.resultHeader')}</th>
                  </tr>
                </thead>
                <tbody>
                  {resultsModal.results.map((r, i) => (
                    <tr key={i} className="border-b last:border-0">
                      <td className="py-2 px-2">
                        {(() => {
                          const deviceDisplay = getDeviceDisplayParts(deviceMap.get(r.dev_id) || r, { preferName: true });
                          return (
                            <>
                              <div className="text-sm text-gray-800">{deviceDisplay.primary}</div>
                              {deviceDisplay.secondary && (
                                <div className="font-mono text-xs text-gray-400">{deviceDisplay.secondary}</div>
                              )}
                            </>
                          );
                        })()}
                      </td>
                      <td className="py-2 px-2">
                        {r.success ? (
                          <span className="text-green-600 font-medium">{t('devices.ok')}</span>
                        ) : (
                          <span className="text-red-600 font-medium">{t('devices.failed')}</span>
                        )}
                      </td>
                      <td className="py-2 px-2 text-xs text-gray-600 max-w-xs truncate">
                        {r.success
                          ? (typeof r.result === 'object' ? JSON.stringify(r.result).slice(0, 100) : String(r.result))
                          : r.error}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
