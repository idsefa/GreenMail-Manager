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

function getDeviceResponseCode(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function getCommandError(command, payload) {
  const code = payload?.code ?? 'unknown';
  const note = payload?.note || payload?.msg || 'No error details returned';
  return `${command} failed (code ${code}): ${note}`;
}

function watchdogStatusLabel(status, lang) {
  const labels = {
    awaiting_heartbeat: ['等待心跳', 'Awaiting heartbeat'],
    heartbeat_timeout: ['心跳超时', 'Heartbeat timed out'],
    healthy: ['正常', 'Healthy'],
    verifying: ['正在核验', 'Verifying'],
    reporting_stale: ['可连接，心跳未恢复', 'Reachable, heartbeat stale'],
    unreachable: ['无法连接', 'Unreachable'],
    restart_scheduled: ['已安排重启', 'Restart scheduled'],
    restart_waiting: ['等待重启后心跳', 'Awaiting post-restart heartbeat'],
    restart_failed: ['重启失败', 'Restart failed'],
    restart_cooldown: ['重启冷却中', 'Restart cooldown'],
    restart_limit_reached: ['达到每日上限', 'Daily limit reached'],
    recovery_disabled: ['自动恢复已关闭', 'Recovery disabled'],
    call_active: ['通话中，暂缓重启', 'Call active, restart deferred'],
    online: ['正常', 'Online'],
    ready: ['就绪', 'Ready'],
    initializing: ['初始化中', 'Initializing'],
    ejected: ['未插卡', 'No SIM'],
    error: ['异常', 'Error'],
    modem_error: ['通信模组异常', 'Modem error'],
    recovering: ['恢复中', 'Recovering'],
    waiting_for_device: ['等待设备在线', 'Waiting for device'],
    manual_attention: ['需要人工处理', 'Manual attention'],
  };
  return labels[status]?.[lang === 'zh' ? 0 : 1] || (lang === 'zh' ? '未收到状态事件' : 'No status event');
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
  const [wifiStoreError, setWifiStoreError] = useState('');
  const [simCardInfo, setSimCardInfo] = useState({});
  const [simCardLoading, setSimCardLoading] = useState({});
  const [statusRefreshing, setStatusRefreshing] = useState(false);
  const [watchdog, setWatchdog] = useState(null);
  const [watchdogLogs, setWatchdogLogs] = useState([]);
  const [watchdogBusy, setWatchdogBusy] = useState(false);
  const [watchdogError, setWatchdogError] = useState('');
  const [recordingUrl, setRecordingUrl] = useState('');
  const [recordingUrlBusy, setRecordingUrlBusy] = useState(false);
  const [recordingUrlError, setRecordingUrlError] = useState('');
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
  const { t, lang } = useLang();

  useEffect(() => {
    loadDevice();
    loadMessages();
    querySmsStorageStatus();
    loadSavedWifi();
    loadWatchdog();

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
      const data = await api.getMessages({ dev_id: devId, limit: 10 });
      setMessages(data.messages || []);
    } catch (err) {
      console.error('Failed to load messages:', err);
    }
  }

  async function refreshOverview() {
    if (autoRefreshBusyRef.current) return;
    autoRefreshBusyRef.current = true;
    try {
      await Promise.all([loadDevice(), loadMessages(), loadWatchdog()]);
    } finally {
      autoRefreshBusyRef.current = false;
    }
  }

  async function loadWatchdog() {
    try {
      const [status, logs] = await Promise.all([
        api.getWatchdog(devId),
        api.getSystemLogs({ scope: 'watchdog', search: devId, limit: 5 })
      ]);
      setWatchdog(status);
      setWatchdogLogs(logs.logs || []);
      setWatchdogError('');
    } catch (err) {
      setWatchdogError(err.message);
    }
  }

  async function changeWatchdog(patch) {
    setWatchdogBusy(true);
    setWatchdogError('');
    try {
      const status = await api.updateWatchdog(devId, patch);
      setWatchdog(status);
      await loadWatchdog();
    } catch (err) {
      setWatchdogError(err.message);
    } finally {
      setWatchdogBusy(false);
    }
  }

  async function manageRecordingUrl(command) {
    setRecordingUrlBusy(true);
    setRecordingUrlError('');
    try {
      const data = await api.sendCommand(devId, command, command === 'setamrurl' ? { p1: recordingUrl } : {});
      const result = data?.result || data;
      if (getDeviceResponseCode(result?.code) !== 0) throw new Error(getCommandError(command, result));
      if (command === 'askamrurl') setRecordingUrl(String(result?.val || ''));
      setCmdResult({ result });
    } catch (err) {
      setRecordingUrlError(err.message);
    } finally {
      setRecordingUrlBusy(false);
    }
  }

  async function refreshDeviceStatus() {
    if (statusRefreshing) return;
    setStatusRefreshing(true);
    try {
      const data = await api.quickCommand(devId, 'stat');
      const payload = data?.result || data;
      if (getDeviceResponseCode(payload?.code) !== 0) {
        throw new Error(getCommandError('stat', payload));
      }
      await Promise.all([loadDevice(), loadMessages()]);
    } catch (err) {
      setCmdResult({ error: err.message });
    } finally {
      setStatusRefreshing(false);
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
      return res;
    } catch (err) {
      setCmdResult({ error: err.message });
      return null;
    } finally {
      setCmdLoading(false);
    }
  }

  function handleWifiOff() {
    if (confirm(t('deviceDetail.wifiOffConfirm'))) {
      sendCmd('wf', { p1: 'off' });
    }
  }

  async function handleAddWifi() {
    if (!addSsid) return;
    const result = await sendCmd('addwf', { p1: addSsid, p2: addPassword });
    const payload = result?.result || result;
    if (getDeviceResponseCode(payload?.code) === 0) {
      setAddSsid('');
      setAddPassword('');
      await loadSavedWifi();
    }
  }

  async function handleDelWifi() {
    if (!delSsid) return;
    if (confirm(t('deviceDetail.deleteWiFiConfirm', { ssid: delSsid }))) {
      const result = await sendCmd('delwf', { p1: delSsid });
      const payload = result?.result || result;
      if (getDeviceResponseCode(payload?.code) === 0) {
        setDelSsid('');
        await loadSavedWifi();
      }
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
        error: getDeviceResponseCode(payload?.code) === 0 ? null : (payload?.note || 'Failed to enable SMS storage'),
        note: getDeviceResponseCode(payload?.code) === 0
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
        error: getDeviceResponseCode(payload?.code) === 0 ? null : (payload?.note || 'Failed to disable SMS storage'),
        note: getDeviceResponseCode(payload?.code) === 0
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
      if (getDeviceResponseCode(payload?.code) === 0) {
        setSmsResult({ note: `Current SMS storage: ${payload?.val || 'unknown'}` });
      }
    } catch {
      setSmsStorageStatus('unknown');
    }
  }

  async function loadSavedWifi() {
    setWifiStoreLoading(true);
    setWifiStoreError('');
    try {
      const data = await api.sendCommand(devId, 'askwfstore');
      const payload = data?.result || data;
      if (getDeviceResponseCode(payload?.code) !== 0) {
        throw new Error(getCommandError('askwfstore', payload));
      }

      let parsed;
      try {
        parsed = JSON.parse(payload?.val || '[]');
      } catch {
        throw new Error('askwfstore returned an invalid WiFi list');
      }
      if (!Array.isArray(parsed)) {
        throw new Error('askwfstore returned an invalid WiFi list');
      }

      const saved = parsed
        .filter(item => item && typeof item === 'object' && String(item.ssid || '').trim())
        .map(item => ({ ssid: String(item.ssid).trim(), pwd: String(item.pwd || '') }));
      setSavedWifi(saved);
      setDelSsid(current => saved.some(item => item.ssid === current) ? current : '');
    } catch (err) {
      setWifiStoreError(err.message);
      setSavedWifi([]);
      setDelSsid('');
    } finally {
      setWifiStoreLoading(false);
    }
  }

  function handleLoadSavedWifi() {
    loadSavedWifi();
  }

  async function handleReadCard(slot) {
    setSimCardLoading(previous => ({ ...previous, [slot]: true }));
    try {
      const data = await api.sendCommand(devId, 'readcard', { p1: slot });
      const payload = data?.result || data;
      if (getDeviceResponseCode(payload?.code) !== 0) {
        throw new Error(getCommandError('readcard', payload));
      }
      setSimCardInfo(previous => ({ ...previous, [slot]: payload }));
      loadDevice();
    } catch (err) {
      setCmdResult({ error: err.message });
    } finally {
      setSimCardLoading(previous => ({ ...previous, [slot]: false }));
    }
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

  const deletableWifi = savedWifi.filter(item => item.ssid.toLowerCase() !== 'lzwifi');

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
                onClick={refreshDeviceStatus}
                disabled={statusRefreshing || !device.wifi_ip}
                className="px-2 py-0.5 rounded bg-gray-200 text-gray-700 hover:bg-gray-300 disabled:opacity-50"
              >
                {statusRefreshing ? 'Refreshing status...' : t('deviceDetail.refreshNow')}
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

      <section className="mb-6 rounded-lg bg-white p-6 shadow">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-lg font-semibold text-gray-700">{lang === 'zh' ? '设备与 SIM 看门狗' : 'Device and SIM Watchdog'}</h3>
          <button type="button" onClick={loadWatchdog} className="rounded border border-gray-300 px-3 py-1 text-sm text-gray-700 hover:bg-gray-50">{lang === 'zh' ? '刷新' : 'Refresh'}</button>
        </div>
        {watchdogError && <p role="alert" className="mb-3 text-sm text-red-700">{watchdogError}</p>}
        {watchdog && <>
          <div className="grid gap-3 text-sm md:grid-cols-3">
            <label className="flex items-center gap-2 text-gray-700"><input type="checkbox" disabled={watchdogBusy} checked={Boolean(watchdog.settings.enabled)} onChange={e => changeWatchdog({ enabled: e.target.checked })} />{lang === 'zh' ? '启用看门狗' : 'Enable watchdog'}</label>
            <label className="flex items-center gap-2 text-gray-700"><input type="checkbox" disabled={watchdogBusy || !watchdog.settings.enabled} checked={Boolean(watchdog.settings.auto_device_restart)} onChange={e => changeWatchdog({ auto_device_restart: e.target.checked })} />{lang === 'zh' ? '设备异常自动重启' : 'Restart device on fault'}</label>
            <label className="flex items-center gap-2 text-gray-700"><input type="checkbox" disabled={watchdogBusy || !watchdog.settings.enabled} checked={Boolean(watchdog.settings.auto_sim_restart)} onChange={e => changeWatchdog({ auto_sim_restart: e.target.checked })} />{lang === 'zh' ? 'SIM 注册超时自动重启卡槽' : 'Restart SIM slot on registration timeout'}</label>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-4 border-t border-gray-200 pt-4 text-sm md:grid-cols-4">
            <InfoItem label={lang === 'zh' ? '设备状态' : 'Device status'} value={watchdogStatusLabel(watchdog.deviceStatus, lang)} />
            <InfoItem label={lang === 'zh' ? '最近心跳' : 'Last heartbeat'} value={timeAgo(watchdog.lastHeartbeatAt, t)} />
            <InfoItem label={lang === 'zh' ? '最后自动重启' : 'Last restart'} value={formatTime(watchdog.settings.last_device_restart_at, t)} />
            <InfoItem label={lang === 'zh' ? '每日恢复上限' : 'Daily recovery limit'} value={watchdog.policy.maxRecoveriesPerDay} />
            {[1, 2].map(slot => {
              const health = watchdog.slots.find(item => item.slot === slot);
              const value = `${watchdogStatusLabel(health?.status, lang)}${health?.error_code ? ` (${health.error_code})` : ''}`;
              return <InfoItem key={slot} label={`SIM ${slot}`} value={value} />;
            })}
          </div>
          {watchdogLogs.length > 0 && <div className="mt-4 border-t border-gray-200 pt-3 text-sm text-gray-600">
            {watchdogLogs.map(log => <div key={log.id} className="flex flex-wrap gap-x-3 py-1"><span className="text-gray-400">{formatTime(log.created_at, t)}</span><span>{lang === 'zh' && log.message === 'Watchdog settings updated' ? '看门狗设置已更新' : log.message}</span></div>)}
          </div>}
        </>}
      </section>

      {/* Command Panel */}
      <div className="bg-white rounded-lg shadow p-6 mb-6">
        <h3 className="text-lg font-semibold text-gray-700 mb-4">{t('deviceDetail.controlCommands')}</h3>
        <CommandPanel device={device} onResult={handleCommandResult} />
      </div>

      <section className="mb-6 border-y border-gray-200 bg-white py-5">
        <h3 className="mb-3 text-lg font-semibold text-gray-700">{lang === 'zh' ? '通话录音上报地址' : 'Recording Upload URL'}</h3>
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-64 flex-1 text-sm text-gray-600">URL
            <input value={recordingUrl} onChange={e => setRecordingUrl(e.target.value)} placeholder="https://example.com/api/recordings/upload" className="mt-1 block w-full rounded border px-2 py-1.5 text-sm" />
          </label>
          <button type="button" disabled={recordingUrlBusy} onClick={() => manageRecordingUrl('askamrurl')} className="rounded border px-3 py-1.5 text-sm disabled:opacity-50">{lang === 'zh' ? '读取' : 'Read'}</button>
          <button type="button" disabled={recordingUrlBusy || !recordingUrl.trim()} onClick={() => manageRecordingUrl('setamrurl')} className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-50">{lang === 'zh' ? '保存' : 'Save'}</button>
        </div>
        {recordingUrlError && <p role="alert" className="mt-2 text-sm text-red-700">{recordingUrlError}</p>}
      </section>

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
              {wifiStoreLoading ? 'Loading WiFi...' : 'Refresh Saved WiFi'}
            </button>
          </div>
          {wifiStoreError && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 p-2 rounded">
              {wifiStoreError}
            </div>
          )}
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
          {savedWifi.length === 0 && !wifiStoreLoading && !wifiStoreError && (
            <div className="text-xs text-gray-500">No saved WiFi networks are configured on this device.</div>
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
                <select value={delSsid} onChange={e => setDelSsid(e.target.value)}
                  disabled={wifiStoreLoading || deletableWifi.length === 0}
                  className="block border rounded px-2 py-1 text-sm w-full max-w-xs disabled:opacity-50">
                  <option value="">{deletableWifi.length ? 'Select a saved WiFi network' : 'No deletable WiFi networks'}</option>
                  {deletableWifi.map(item => (
                    <option key={item.ssid} value={item.ssid}>{item.ssid}</option>
                  ))}
                </select>
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
                <div className="border-t pt-3">
                  <button onClick={() => handleReadCard(slot)} disabled={cmdLoading || simCardLoading[slot]}
                    className="px-3 py-1 text-xs rounded font-medium bg-gray-700 text-white hover:bg-gray-800 disabled:opacity-50">
                    {simCardLoading[slot] ? 'Reading SIM...' : 'Read SIM Info'}
                  </button>
                  {simCardInfo[slot] && (
                    <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-gray-600">
                      <div>Phone: {simCardInfo[slot].msIsdn || '-'}</div>
                      <div>Name: {simCardInfo[slot].scName || '-'}</div>
                      <div>Network: {simCardInfo[slot].simNet ? 'ON' : 'OFF'}</div>
                      <div>Data: {Math.round(Number(simCardInfo[slot].trafficConsumedKB || 0) / 1024)} MB / {simCardInfo[slot].trafficTotalMB ?? 0} MB</div>
                      <div className="col-span-2 font-mono break-all">ICCID: {simCardInfo[slot].iccId || '-'}</div>
                      <div className="col-span-2 font-mono break-all">IMSI: {simCardInfo[slot].imsi || '-'}</div>
                      <div>Incoming: {simCardInfo[slot].callInCount ?? 0} / {simCardInfo[slot].callInMinutes ?? 0} min</div>
                      <div>Outgoing: {simCardInfo[slot].callOutCount ?? 0} / {simCardInfo[slot].callOutMinutes ?? 0} min</div>
                    </div>
                  )}
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
