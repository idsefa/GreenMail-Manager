import { useState, useEffect, useRef } from 'react';
import { api } from '../api';
import { subscribe } from '../ws';
import MessageTable from '../components/MessageTable';
import { useLang } from '../i18n.jsx';
import { formatDeviceInline } from '../utils/device-label';

export default function Dashboard() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const deviceNamesByIdRef = useRef({});
  const toastTimer = useRef(null);
  const { t } = useLang();

  useEffect(() => {
    loadStats();
    loadDeviceNames();

    const unsub = subscribe((msg) => {
      if (msg.type === 'message') {
        // Refresh stats on any new message
        loadStats();
        showToast(t('dashboard.newMessageFrom', {
          device: formatDeviceInline({
            dev_id: msg.data?.dev_id,
            name: deviceNamesByIdRef.current[msg.data?.dev_id] || msg.data?.device_name || ''
          }, { empty: 'device' })
        }));
      }
      if (msg.type === 'device_stats') {
        setStats(prev => prev ? { ...prev, totalDevices: msg.data.totalDevices, onlineCount: msg.data.onlineCount, offlineCount: msg.data.totalDevices - msg.data.onlineCount } : prev);
      }
    });

    return () => { unsub(); clearTimeout(toastTimer.current); };
  }, [t]);

  function showToast(text) {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }

  async function loadStats() {
    try {
      const data = await api.getStats();
      setStats(data);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  }

  async function loadDeviceNames() {
    try {
      const data = await api.getDevices();
      deviceNamesByIdRef.current = Object.fromEntries(
        (data.devices || []).map(device => [device.dev_id, device.name || ''])
      );
    } catch (err) {
      console.error('Failed to load device names:', err);
    }
  }

  if (loading) return <div className="text-gray-500">{t('common.loading')}</div>;
  if (error) return <div className="text-red-500">{t('common.error')}: {error}</div>;
  if (!stats) return null;

  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-800 mb-6">{t('dashboard.title')}</h2>

      {/* Toast notification */}
      {toast && (
        <div className="fixed top-4 right-4 bg-green-600 text-white px-4 py-2 rounded shadow-lg z-50 animate-pulse text-sm">
          {toast}
        </div>
      )}

      {/* Stats cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard label={t('dashboard.totalDevices')} value={stats.totalDevices} color="blue" />
        <StatCard label={t('dashboard.online')} value={stats.onlineCount} color="green" />
        <StatCard label={t('dashboard.offline')} value={stats.offlineCount} color="red" />
        <StatCard label={t('dashboard.messagesToday')} value={stats.messagesToday} color="purple" />
      </div>

      {/* Recent messages */}
      <div className="bg-white rounded-lg shadow p-4">
        <h3 className="text-lg font-semibold text-gray-700 mb-4">{t('dashboard.recentMessages')}</h3>
        <MessageTable messages={stats.recentMessages || []} />
      </div>
    </div>
  );
}

function StatCard({ label, value, color }) {
  const colors = {
    blue: 'border-blue-500 text-blue-600',
    green: 'border-green-500 text-green-600',
    red: 'border-red-500 text-red-600',
    purple: 'border-purple-500 text-purple-600',
  };

  return (
    <div className={`bg-white rounded-lg shadow p-4 border-l-4 ${colors[color]}`}>
      <div className="text-sm text-gray-500">{label}</div>
      <div className={`text-3xl font-bold ${colors[color]}`}>{value}</div>
    </div>
  );
}
