import { useState, useEffect, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api';
import { subscribe } from '../ws';
import CommandPanel from '../components/CommandPanel';
import MessageTable from '../components/MessageTable';
import { useLang } from '../i18n.jsx';

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

function isActiveCall(messages) {
  const activeTypes = new Set([601, 602, 620, 621, 622]);
  const endTypes = new Set([603, 623]);

  for (const m of messages || []) {
    const t = Number(m.type);
    if (activeTypes.has(t)) return true;
    if (endTypes.has(t)) return false;
  }

  return false;
}

function parseSmsStorageEnabled(val) {
  if (!val || typeof val !== 'string') return null;
  const parts = val.split(';').map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const states = parts
    .map(part => part.split(':')[1]?.trim().toLowerCase())
    .filter(Boolean);
  if (states.length === 0) return null;
  return states.some(s => s === 'on' || s === '1' || s === 'true');
}

export default function DeviceDetail() {
  const { devId } = useParams();
  const [device, setDevice] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editName, setEditName] = useState(false);
  const [newName, setNewName] = useState('');
  const [editPassword, setEditPassword] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  const [cmdLoading, setCmdLoading] = useState(false);
  const [cmdResult, setCmdResult] = useState(null);
  const [slotRestartDelay, setSlotRestartDelay] = useState({ 1: 5, 2: 5 });
  // WiFi state
  const [addSsid, setAddSsid] = useState('');
  const [addPassword, setAddPassword] = useState('');
  const [delSsid, setDelSsid] = useState('');
  const [savedWifi, setSavedWifi] = useState([]);
  const [wifiStoreLoading, setWifiStoreLoading] = useState(false);
  // OTA state
  const [otaDelay, setOtaDelay] = useState(10);
  // SMS Management state
  const [smsLoading, setSmsLoading] = useState(false);
  const [smsResult, setSmsResult] = useState(null);
  const [smsStorageStatus, setSmsStorageStatus] = useState('unknown');
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(() => {
    const stored = localStorage.getItem('gm-device-auto-refresh-enabled');
    return stored === null ? true : stored === '1';
  });
  const [autoRefreshSeconds, setAutoRefreshSeconds] = useState(() => {
    const stored = Number(localStorage.getItem('gm-device-auto-refresh-seconds') || 10);
    return [5, 10, 30, 60].includes(stored) ? stored : 10;
  });
  const autoRefreshBusyRef = useRef(false);
  const { t } = useLang();

  useEffect(() => {
    loadDevice();
    loadMessages();
    querySmsStorageStatus();
    pingDeviceOnce();

    const unsub = subscribe((msg) => {
      if (msg.type === 'device_update' && msg.data?.dev_id === devId) {
        loadDevice();
      }
      if (msg.type === 'message' && msg.data?.dev_id === devId) {
        loadMessages();
        showToast(t('deviceDetail.newMessage'));
      }
    });

    return () => { unsub(); clearTimeout(toastTimer.current); };
  }, [devId]);

  useEffect(() => {
    localStorage.setItem('gm-device-auto-refresh-enabled', autoRefreshEnabled ? '1' : '0');
  }, [autoRefreshEnabled]);

  useEffect(() => {
    localStorage.setItem('gm-device-auto-refresh-seconds', String(autoRefreshSeconds));
  }, [autoRefreshSeconds]);

  useEffect(() => {
    if (!autoRefreshEnabled) return;

    const timer = setInterval(() => {
      refreshOverview();
    }, autoRefreshSeconds * 1000);

    return () => clearInterval(timer);
  }, [autoRefreshEnabled, autoRefreshSeconds, devId]);

  function showToast(text) {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }

  async function loadDevice() {
    try {
      const data = await api.getDevice(devId);
      setDevice(data.device);
      setNewName(data.device.name || '');
    } catch (err) {
      console.error('Failed to load device:', err);
    }
    setLoading(false);
  }

  async function loadMessages() {
    try {
      const data = await api.getMessages({ dev_id: devId, limit: 50 });
      setMessages(data.messages || []);
    } catch (err) {
      console.error('Failed to load messages:', err);
    }
  }

  async function pingDeviceOnce() {
    try {
      await api.quickCommand(devId, 'ping');
      loadDevice();
    } catch (err) {
      console.error('Failed to ping device on entry:', err);
    }
  }

  async function refreshOverview() {
    if (autoRefreshBusyRef.current) return;
    autoRefreshBusyRef.current = true;
    try {
      await Promise.all([loadDevice(), loadMessages()]);
    } finally {
      autoRefreshBusyRef.current = false;
    }
  }

  async function saveName() {
    await api.updateDevice(devId, { name: newName });
    setEditName(false);
    loadDevice();
  }

  async function savePassword() {
    if (newPassword.length < 4) {
      alert(t('deviceDetail.passwordMinLength'));
      return;
    }
    await api.updateDevice(devId, { admin_password: newPassword });
    setEditPassword(false);
    setNewPassword('');
    loadDevice();
  }

  function handleCommandResult() {
    loadDevice();
    loadMessages();
  }

  async function sendCmd(cmd, params = {}) {
    setCmdLoading(true);
    setCmdResult(null);
    try {
      const res = await api.sendCommand(devId, cmd, params);
      setCmdResult(res);
      loadDevice();
      loadMessages();
    } catch (err) {
      setCmdResult({ error: err.message });
    }
    setCmdLoading(false);
  }

  function handleWifiOff() {
    if (confirm(t('deviceDetail.wifiOffConfirm'))) {
      sendCmd('wf', { p1: 'off' });
    }
  }

  function handleAddWifi() {
    if (!addSsid) return;
    sendCmd('addwf', { p1: addSsid, p2: addPassword });
    setAddSsid('');
    setAddPassword('');
  }

  function handleDelWifi() {
    if (!delSsid) return;
    if (confirm(t('deviceDetail.deleteWiFiConfirm', { ssid: delSsid }))) {
      sendCmd('delwf', { p1: delSsid });
      setDelSsid('');
    }
  }

  function handleSlotPwr(slot, on) {
    if (!on && !confirm(t('deviceDetail.slotPowerOffConfirm', { slot }))) return;
    sendCmd('slotpwr', { p1: slot, p2: on ? 'on' : 'off' });
  }

  function handleSlotRst(slot) {
    if (!confirm(t('deviceDetail.slotRestartConfirm', { slot }))) return;
    sendCmd('slotrst', { p1: slot, p2: slotRestartDelay[slot] || 5 });
  }

  function handleSlotNet(slot, on) {
    sendCmd('slotnet', { p1: slot, p2: on ? 'on' : 'off' });
  }

  function handleOta() {
    if (!confirm('Device will restart after OTA. Ensure stable power supply. Continue?')) return;
    sendCmd('otanow', { p1: otaDelay });
  }

  function openAdminBackend() {
    if (!device?.wifi_ip) {
      alert('Device IP is not available.');
      return;
    }
    window.open(`http://${device.wifi_ip}/mgr`, '_blank', 'noopener,noreferrer');
  }

  async function handleEnableSmsStorage() {
    setSmsLoading(true);
    setSmsResult(null);
    try {
      const data = await api.sendCommand(devId, 'storesmsen', { p1: 0, p2: 'on' });
      const payload = data?.result || data;
      const enabled = parseSmsStorageEnabled(payload?.val);
      setSmsStorageStatus(enabled === null ? 'unknown' : (enabled ? 'on' : 'off'));
      setSmsResult({
        error: payload?.code === 0 ? null : (payload?.note || 'Failed to enable SMS storage'),
        note: payload?.code === 0
          ? `SMS storage enabled (${payload?.val || ''}). Restart device to apply.`
          : payload?.note
      });
      loadDevice();
    } catch (err) {
      setSmsResult({ error: err.message });
    }
    setSmsLoading(false);
  }

  async function handleDisableSmsStorage() {
    setSmsLoading(true);
    setSmsResult(null);
    try {
      const data = await api.sendCommand(devId, 'storesmsen', { p1: 0, p2: 'off' });
      const payload = data?.result || data;
      const enabled = parseSmsStorageEnabled(payload?.val);
      setSmsStorageStatus(enabled === null ? 'unknown' : (enabled ? 'on' : 'off'));
      setSmsResult({
        error: payload?.code === 0 ? null : (payload?.note || 'Failed to disable SMS storage'),
        note: payload?.code === 0
          ? `SMS storage disabled (${payload?.val || ''}). Restart device to apply.`
          : payload?.note
      });
      loadDevice();
    } catch (err) {
      setSmsResult({ error: err.message });
    }
    setSmsLoading(false);
  }

  async function querySmsStorageStatus() {
    try {
      const data = await api.sendCommand(devId, 'storesmsen');
      const payload = data?.result || data;
      const enabled = parseSmsStorageEnabled(payload?.val);
      setSmsStorageStatus(enabled === null ? 'unknown' : (enabled ? 'on' : 'off'));
      if (payload?.code === 0) {
        setSmsResult({ note: `Current SMS storage: ${payload?.val || 'unknown'}` });
      }
    } catch {
      setSmsStorageStatus('unknown');
    }
  }

  async function handleLoadSavedWifi() {
    setWifiStoreLoading(true);
    try {
      const data = await api.sendCommand(devId, 'askwfstore');
      const payload = data?.result || data;
      let parsed = [];
      try {
        parsed = JSON.parse(payload?.val || '[]');
      } catch {
        parsed = [];
      }
      setSavedWifi(Array.isArray(parsed) ? parsed : []);
      setCmdResult(data);
    } catch (err) {
      setCmdResult({ error: err.message });
      setSavedWifi([]);
    }
    setWifiStoreLoading(false);
  }

  async function handleSyncSms() {
    setSmsLoading(true);
    setSmsResult(null);
    try {
      const data = await api.syncSms(devId);
      setSmsResult(data);
      loadDevice();
      loadMessages();
    } catch (err) {
      setSmsResult({ error: err.message });
    }
    setSmsLoading(false);
  }

  if (loading) return <div className="text-gray-500">{t('common.loading')}</div>;
  if (!device) return <div className="text-red-500">{t('deviceDetail.deviceNotFound')}</div>;

  const callActive = isActiveCall(messages);

  return (
    <div>
      {/* Toast notification */}
      {toast && (
        <div className="fixed top-4 right-4 bg-green-600 text-white px-4 py-2 rounded shadow-lg z-50 animate-pulse text-sm">
          {toast}
        </div>
      )}

      <Link to="/devices" className="text-blue-600 hover:underline text-sm mb-4 inline-block">
        {t('deviceDetail.backToDevices')}
      </Link>

      {/* Device header */}
      <div className="bg-white rounded-lg shadow p-6 mb-6">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <span className={`w-4 h-4 rounded-full ${device.is_online ? 'bg-green-500' : 'bg-red-500'}`} />
              {editName ? (
                <div className="flex gap-2 items-center">
                  <input
                    type="text" value={newName}
                    onChange={e => setNewName(e.target.value)}
                    className="border rounded px-2 py-1 text-lg"
                    placeholder={t('deviceDetail.deviceName')}
                    autoFocus
                  />
                  <button onClick={saveName} className="text-sm bg-blue-600 text-white px-3 py-1 rounded">{t('common.save')}</button>
                  <button onClick={() => setEditName(false)} className="text-sm text-gray-500">{t('common.cancel')}</button>
                </div>
              ) : (
                <h2 className="text-2xl font-bold text-gray-800 cursor-pointer hover:text-blue-600" onClick={() => setEditName(true)}>
                  {device.name || device.dev_id}
                  {!device.name && <span className="text-sm text-gray-400 ml-2">{t('deviceDetail.clickToName')}</span>}
                </h2>
              )}
            </div>
            <div className="text-sm text-gray-500 font-mono">ID: {device.dev_id}</div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <label className="inline-flex items-center gap-1.5 text-gray-600">
                <input
                  type="checkbox"
                  checked={autoRefreshEnabled}
                  onChange={e => setAutoRefreshEnabled(e.target.checked)}
                />
                {t('deviceDetail.autoRefresh')}
              </label>
              <select
                value={autoRefreshSeconds}
                onChange={e => setAutoRefreshSeconds(Number(e.target.value))}
                disabled={!autoRefreshEnabled}
                className="border rounded px-2 py-0.5 text-xs disabled:opacity-50"
              >
                {[5, 10, 30, 60].map(sec => (
                  <option key={sec} value={sec}>{t('deviceDetail.refreshEverySeconds', { seconds: sec })}</option>
                ))}
              </select>
              <button
                onClick={refreshOverview}
                className="px-2 py-0.5 rounded bg-gray-200 text-gray-700 hover:bg-gray-300"
              >
                {t('deviceDetail.refreshNow')}
              </button>
            </div>
          </div>
          <div className={`px-3 py-1 rounded-full text-sm font-medium ${device.is_online ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
            {device.is_online ? t('common.online') : t('common.offline')}
          </div>
        </div>

        {/* Device info grid */}
        <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <InfoItem label={t('deviceDetail.hardwareVersion')} value={device.hw_ver} />
          <InfoItem label={t('deviceDetail.wifiIP')} value={device.wifi_ip} />
          <InfoItem label={t('deviceDetail.wifiSSID')} value={device.wifi_ssid} />
          <InfoItem label={t('deviceDetail.wifiSignal')} value={device.wifi_dbm ? `${device.wifi_dbm}%` : '-'} />
          <InfoItem label={t('deviceDetail.pingInterval')} value={device.ping_intvl ? `${device.ping_intvl}s` : '-'} />
          <InfoItem label={t('deviceDetail.lastPing')} value={timeAgo(device.last_ping_at, t)} />
          <InfoItem label={t('deviceDetail.lastStat')} value={timeAgo(device.last_stat_at, t)} />
          <InfoItem label={t('deviceDetail.created')} value={formatTime(device.created_at, t)} />
        </div>

        {/* SIM info */}
        {(device.sim1_icc_id || device.sim2_icc_id) && (
          <div className="mt-4 border-t pt-4">
            <h3 className="text-sm font-semibold text-gray-700 mb-2">{t('deviceDetail.simCards')}</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {device.sim1_icc_id && (
                <div className="bg-gray-50 rounded p-3 text-sm">
                  <div className="font-medium text-gray-700 mb-1">{t('deviceDetail.sim1')}</div>
                  <div className="text-gray-600">{t('deviceDetail.simPhone')}: {device.sim1_phone || '-'}</div>
                  <div className="text-gray-600">{t('deviceDetail.simOperator')}: {device.sim1_sc_name || device.sim1_plmn || '-'}</div>
                  <div className="text-gray-400 text-xs font-mono">ICCID: {device.sim1_icc_id}</div>
                  <div className="text-gray-400 text-xs font-mono">IMSI: {device.sim1_imsi || '-'}</div>
                </div>
              )}
              {device.sim2_icc_id && (
                <div className="bg-gray-50 rounded p-3 text-sm">
                  <div className="font-medium text-gray-700 mb-1">{t('deviceDetail.sim2')}</div>
                  <div className="text-gray-600">{t('deviceDetail.simPhone')}: {device.sim2_phone || '-'}</div>
                  <div className="text-gray-600">{t('deviceDetail.simOperator')}: {device.sim2_sc_name || device.sim2_plmn || '-'}</div>
                  <div className="text-gray-400 text-xs font-mono">ICCID: {device.sim2_icc_id}</div>
                  <div className="text-gray-400 text-xs font-mono">IMSI: {device.sim2_imsi || '-'}</div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Admin token & password */}
        <div className="mt-4 border-t pt-4">
          <div className="flex items-center gap-4 text-sm">
            <div>
              <span className="text-gray-500">{t('deviceDetail.adminToken')}:</span>
              <code className="ml-2 bg-gray-100 px-2 py-0.5 rounded text-xs font-mono">{device.admin_token}</code>
            </div>
            <button
              onClick={openAdminBackend}
              disabled={!device.wifi_ip}
              className="px-3 py-1 rounded bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
            >
              打开设备管理后台
            </button>
            <div className="flex items-center gap-2">
              {editPassword ? (
                <>
                  <input
                    type="text" value={newPassword}
                    onChange={e => setNewPassword(e.target.value)}
                    className="border rounded px-2 py-0.5 text-sm w-28"
                    placeholder={t('deviceDetail.newPassword')}
                  />
                  <button onClick={savePassword} className="text-sm bg-blue-600 text-white px-2 py-0.5 rounded">{t('common.save')}</button>
                  <button onClick={() => { setEditPassword(false); setNewPassword(''); }} className="text-sm text-gray-500">{t('common.cancel')}</button>
                </>
              ) : (
                <button onClick={() => setEditPassword(true)} className="text-blue-600 hover:underline text-sm">
                  {t('deviceDetail.changePassword')}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Command Panel */}
      <div className="bg-white rounded-lg shadow p-6 mb-6">
        <h3 className="text-lg font-semibold text-gray-700 mb-4">{t('deviceDetail.controlCommands')}</h3>
        <CommandPanel device={device} onResult={handleCommandResult} isCallActive={callActive} />
      </div>

      {/* WiFi Management */}
      <div className="bg-white rounded-lg shadow p-6 mb-6">
        <h3 className="text-lg font-semibold text-gray-700 mb-4">{t('deviceDetail.wifiManagement')}</h3>
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <button onClick={() => sendCmd('wf', { p1: 'on' })} disabled={cmdLoading}
              className="px-3 py-1.5 text-sm rounded font-medium bg-green-600 text-white hover:bg-green-700 disabled:opacity-50">
              {t('deviceDetail.wifiON')}
            </button>
            <button onClick={handleWifiOff} disabled={cmdLoading}
              className="px-3 py-1.5 text-sm rounded font-medium bg-red-600 text-white hover:bg-red-700 disabled:opacity-50">
              {t('deviceDetail.wifiOFF')}
            </button>
            <button onClick={() => sendCmd('wf', { p1: 'ap' })} disabled={cmdLoading}
              className="px-3 py-1.5 text-sm rounded font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
              {t('deviceDetail.wifiAP')}
            </button>
            <button onClick={handleLoadSavedWifi} disabled={cmdLoading || wifiStoreLoading}
              className="px-3 py-1.5 text-sm rounded font-medium bg-gray-700 text-white hover:bg-gray-800 disabled:opacity-50">
              {wifiStoreLoading ? 'Loading WiFi...' : 'Saved WiFi'}
            </button>
          </div>
          {savedWifi.length > 0 && (
            <div className="border rounded p-3 bg-gray-50">
              <h4 className="text-sm font-medium text-gray-700 mb-2">Saved WiFi List</h4>
              <div className="space-y-1 text-sm">
                {savedWifi.map((item, idx) => (
                  <div key={`${item.ssid || 'ssid'}-${idx}`} className="flex justify-between border-b last:border-b-0 py-1">
                    <span className="text-gray-700">{item.ssid || '-'}</span>
                    <span className="text-gray-500 font-mono">{item.pwd || '-'}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {savedWifi.length === 0 && !wifiStoreLoading && (
            <div className="text-xs text-gray-500">No saved WiFi loaded yet. Click "Saved WiFi" to query device.</div>
          )}
          <div className="border-t pt-4">
            <h4 className="text-sm font-medium text-gray-600 mb-2">{t('deviceDetail.addWiFiNetwork')}</h4>
            <div className="flex flex-wrap gap-2 items-end">
              <div>
                <label className="text-xs text-gray-500">{t('deviceDetail.ssidLabel')}</label>
                <input type="text" value={addSsid} onChange={e => setAddSsid(e.target.value)}
                  placeholder={t('deviceDetail.ssidPlaceholder')} className="block border rounded px-2 py-1 text-sm w-40" />
              </div>
              <div>
                <label className="text-xs text-gray-500">{t('deviceDetail.passwordLabel')}</label>
                <input type="password" value={addPassword} onChange={e => setAddPassword(e.target.value)}
                  placeholder={t('deviceDetail.passwordPlaceholder')} className="block border rounded px-2 py-1 text-sm w-40" />
              </div>
              <button onClick={handleAddWifi} disabled={cmdLoading || !addSsid}
                className="px-3 py-1.5 text-sm rounded font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
                {t('common.add')}
              </button>
            </div>
          </div>
          <div className="border-t pt-4">
            <h4 className="text-sm font-medium text-gray-600 mb-2">{t('deviceDetail.deleteWiFiNetwork')}</h4>
            <div className="flex flex-wrap gap-2 items-end">
              <div className="flex-1">
                <label className="text-xs text-gray-500">{t('deviceDetail.ssidLabel')}</label>
                <input type="text" value={delSsid} onChange={e => setDelSsid(e.target.value)}
                  placeholder={t('deviceDetail.deleteSSIDPlaceholder')} className="block border rounded px-2 py-1 text-sm w-full max-w-xs" />
              </div>
              <button onClick={handleDelWifi} disabled={cmdLoading || !delSsid}
                className="px-3 py-1.5 text-sm rounded font-medium bg-red-600 text-white hover:bg-red-700 disabled:opacity-50">
                {t('common.delete')}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* SIM Slot Management */}
      <div className="bg-white rounded-lg shadow p-6 mb-6">
        <h3 className="text-lg font-semibold text-gray-700 mb-4">{t('deviceDetail.simSlotManagement')}</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {[1, 2].map(slot => (
            <div key={slot} className="bg-gray-50 rounded p-4">
              <h4 className="text-sm font-semibold text-gray-700 mb-3">{t('common.slot')} {slot}</h4>
              <div className="space-y-3">
                <div>
                  <span className="text-xs text-gray-500 block mb-1">{t('deviceDetail.power')}</span>
                  <div className="flex gap-2">
                    <button onClick={() => handleSlotPwr(slot, true)} disabled={cmdLoading}
                      className="px-3 py-1 text-xs rounded font-medium bg-green-600 text-white hover:bg-green-700 disabled:opacity-50">
                      {t('deviceDetail.powerON')}
                    </button>
                    <button onClick={() => handleSlotPwr(slot, false)} disabled={cmdLoading}
                      className="px-3 py-1 text-xs rounded font-medium bg-red-600 text-white hover:bg-red-700 disabled:opacity-50">
                      {t('deviceDetail.powerOFF')}
                    </button>
                  </div>
                </div>
                <div>
                  <span className="text-xs text-gray-500 block mb-1">{t('deviceDetail.slotRestart')}</span>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={1}
                      max={30}
                      value={slotRestartDelay[slot] || 5}
                      onChange={e => setSlotRestartDelay(prev => ({
                        ...prev,
                        [slot]: Math.max(1, Math.min(30, Number(e.target.value) || 1))
                      }))}
                      className="border rounded px-2 py-1 text-xs w-16"
                    />
                    <button onClick={() => handleSlotRst(slot)} disabled={cmdLoading}
                      className="px-3 py-1 text-xs rounded font-medium bg-yellow-600 text-white hover:bg-yellow-700 disabled:opacity-50">
                      {t('deviceDetail.slotRestart')}
                    </button>
                  </div>
                </div>
                <div>
                  <span className="text-xs text-gray-500 block mb-1">{t('deviceDetail.network')}</span>
                  <div className="flex gap-2">
                    <button onClick={() => handleSlotNet(slot, true)} disabled={cmdLoading}
                      className="px-3 py-1 text-xs rounded font-medium bg-green-600 text-white hover:bg-green-700 disabled:opacity-50">
                      {t('deviceDetail.netON')}
                    </button>
                    <button onClick={() => handleSlotNet(slot, false)} disabled={cmdLoading}
                      className="px-3 py-1 text-xs rounded font-medium bg-red-600 text-white hover:bg-red-700 disabled:opacity-50">
                      {t('deviceDetail.netOFF')}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* OTA Upgrade */}
      <div className="bg-white rounded-lg shadow p-6 mb-6">
        <h3 className="text-lg font-semibold text-gray-700 mb-4">{t('deviceDetail.otaUpgrade')}</h3>
        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="text-xs text-gray-500">{t('deviceDetail.delaySeconds')}</label>
            <input type="number" min={1} max={30} value={otaDelay}
              onChange={e => setOtaDelay(Number(e.target.value))}
              className="block border rounded px-2 py-1 text-sm w-20" />
          </div>
          <button onClick={handleOta} disabled={cmdLoading}
            className="px-4 py-1.5 text-sm rounded font-medium bg-orange-600 text-white hover:bg-orange-700 disabled:opacity-50">
            {t('deviceDetail.startOTA')}
          </button>
        </div>
      </div>

      {/* SMS Management */}
      <div className="bg-white rounded-lg shadow p-6 mb-6">
        <h3 className="text-lg font-semibold text-gray-700 mb-4">SMS Management</h3>
        <div className="mb-3 flex items-center gap-2 text-sm">
          <span className="text-gray-500">SMS Storage Status:</span>
          <span className={`px-2 py-0.5 rounded font-medium ${
            smsStorageStatus === 'on' ? 'bg-green-100 text-green-700' :
            smsStorageStatus === 'off' ? 'bg-red-100 text-red-700' :
            'bg-gray-100 text-gray-700'
          }`}>
            {smsStorageStatus === 'on' ? 'ON' : smsStorageStatus === 'off' ? 'OFF' : 'UNKNOWN'}
          </span>
          <button
            onClick={querySmsStorageStatus}
            disabled={smsLoading}
            className="px-2 py-1 text-xs rounded bg-gray-200 text-gray-700 hover:bg-gray-300 disabled:opacity-50"
          >
            Refresh Status
          </button>
        </div>
        <div className="flex flex-wrap gap-3 items-start">
          <button onClick={handleEnableSmsStorage} disabled={smsLoading}
            className="px-4 py-1.5 text-sm rounded font-medium bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-50">
            {smsLoading ? 'Processing...' : 'Enable SMS Storage'}
          </button>
          <button onClick={handleDisableSmsStorage} disabled={smsLoading}
            className="px-4 py-1.5 text-sm rounded font-medium bg-gray-700 text-white hover:bg-gray-800 disabled:opacity-50">
            {smsLoading ? 'Processing...' : 'Disable SMS Storage'}
          </button>
          <button onClick={handleSyncSms} disabled={smsLoading || !device.wifi_ip}
            className="px-4 py-1.5 text-sm rounded font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
            {smsLoading ? 'Syncing...' : 'Sync SMS'}
          </button>
          <p className="text-xs text-gray-400 self-center">
            SMS are stored in device local storage (not SIM). Restart is required after changing storesmsen.
          </p>
        </div>
        {smsResult && (
          <div className={`mt-3 p-2 rounded text-sm ${smsResult.error ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'}`}>
            {smsResult.error || smsResult.note}
          </div>
        )}
      </div>

      {/* Command result display */}
      {cmdResult && (
        <div className={`mb-6 p-3 rounded text-sm font-mono ${cmdResult.error ? 'bg-red-50 text-red-800' : 'bg-green-50 text-green-800'}`}>
          <pre className="whitespace-pre-wrap overflow-auto max-h-48">{JSON.stringify(cmdResult, null, 2)}</pre>
        </div>
      )}

      {/* Recent messages */}
      <div className="bg-white rounded-lg shadow p-6">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-semibold text-gray-700">{t('deviceDetail.recentMessages')}</h3>
          <Link to={`/messages?dev_id=${device.dev_id}`} className="text-blue-600 hover:underline text-sm">
            {t('deviceDetail.viewAll')}
          </Link>
        </div>
        <MessageTable messages={messages} showDevice={false} />
      </div>
    </div>
  );
}

function InfoItem({ label, value }) {
  return (
    <div>
      <div className="text-gray-400 text-xs">{label}</div>
      <div className="text-gray-700">{value || '-'}</div>
    </div>
  );
}
