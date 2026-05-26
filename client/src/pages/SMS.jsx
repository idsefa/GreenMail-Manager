import { useState, useEffect } from 'react';
import { api } from '../api';
import MessageTable from '../components/MessageTable';
import { useLang } from '../i18n.jsx';
import { formatDeviceInline } from '../utils/device-label';

function buildPageNumbers(page, pages) {
  if (pages <= 7) {
    return Array.from({ length: pages }, (_, i) => i + 1);
  }

  const nums = new Set([1, pages, page - 1, page, page + 1]);
  if (page <= 3) nums.add(2), nums.add(3), nums.add(4);
  if (page >= pages - 2) nums.add(pages - 1), nums.add(pages - 2), nums.add(pages - 3);

  return Array.from(nums)
    .filter(n => n >= 1 && n <= pages)
    .sort((a, b) => a - b);
}

export default function SMS() {
  const [tab, setTab] = useState('inbox'); // 'inbox' or 'sent'
  const [messages, setMessages] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, pages: 1, total: 0 });
  const [loading, setLoading] = useState(true);
  const [devices, setDevices] = useState([]);
  const [filterDevId, setFilterDevId] = useState('');
  const [filterStartDate, setFilterStartDate] = useState('');
  const [filterEndDate, setFilterEndDate] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const { t } = useLang();
  // Sync state
  const [syncDevId, setSyncDevId] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState(null);

  useEffect(() => {
    api.getDevices().then(d => setDevices(d.devices || [])).catch(console.error);
  }, []);

  async function handleSyncSms() {
    if (!syncDevId) return;
    setSyncing(true);
    setSyncResult(null);
    try {
      const data = await api.syncSms(syncDevId);
      setSyncResult(data);
      // Reload messages after sync
      loadMessages();
    } catch (err) {
      setSyncResult({ error: err.message });
    }
    setSyncing(false);
  }

  useEffect(() => {
    setPage(1);
    loadMessages();
  }, [tab, filterDevId, pageSize]);

  useEffect(() => {
    loadMessages();
  }, [page]);

  async function loadMessages() {
    setLoading(true);
    try {
      const params = {
        type: tab === 'inbox' ? '501' : '502',
        page,
        limit: pageSize
      };
      if (filterDevId) params.dev_id = filterDevId;
      if (filterStartDate) {
        const start = new Date(filterStartDate + 'T00:00:00');
        params.start_date = Math.floor(start.getTime() / 1000);
      }
      if (filterEndDate) {
        const end = new Date(filterEndDate + 'T23:59:59');
        params.end_date = Math.floor(end.getTime() / 1000);
      }

      const data = await api.getMessages(params);
      setMessages(data.messages || []);
      setPagination(data.pagination || { page: 1, pages: 1, total: 0 });
    } catch (err) {
      console.error('Failed to load SMS:', err);
    }
    setLoading(false);
  }

  function handleSearch(e) {
    e.preventDefault();
    setPage(1);
    loadMessages();
  }

  function handleExport() {
    const params = { type: tab === 'inbox' ? '501' : '502' };
    if (filterDevId) params.dev_id = filterDevId;
    if (filterStartDate) {
      const start = new Date(filterStartDate + 'T00:00:00');
      params.start_date = Math.floor(start.getTime() / 1000);
    }
    if (filterEndDate) {
      const end = new Date(filterEndDate + 'T23:59:59');
      params.end_date = Math.floor(end.getTime() / 1000);
    }
    window.open(api.getExportUrl(params), '_blank');
  }

  const pageNumbers = buildPageNumbers(page, pagination.pages);

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-bold text-gray-800">{t('sms.title')}</h2>
      </div>

      {/* Sync from Device */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4">
        <h3 className="text-sm font-semibold text-blue-800 mb-2">Sync SMS from Device</h3>
        <div className="flex flex-wrap gap-2 items-end">
          <div>
            <label className="text-xs text-blue-600">Device</label>
            <select value={syncDevId} onChange={e => setSyncDevId(e.target.value)}
              className="block border border-blue-300 rounded px-2 py-1.5 text-sm bg-white">
              <option value="">Select device...</option>
              {devices.filter(d => d.wifi_ip).map(d => (
                <option key={d.dev_id} value={d.dev_id}>
                  {formatDeviceInline(d)} · {d.wifi_ip} {d.is_online ? '🟢' : '🔴'}
                </option>
              ))}
            </select>
          </div>
          <button onClick={handleSyncSms} disabled={syncing || !syncDevId}
            className="px-4 py-1.5 bg-blue-600 text-white rounded text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
            {syncing ? 'Syncing...' : 'Pull SMS'}
          </button>
          <p className="text-xs text-blue-500 self-center ml-2">
            Actively pull SMS records from device via querysms command
          </p>
        </div>
        {syncResult && (
          <div className={`mt-2 text-sm ${syncResult.error ? 'text-red-600' : 'text-green-700'}`}>
            {syncResult.error || syncResult.note}
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-2 mb-4">
        <button
          onClick={() => setTab('inbox')}
          className={`px-4 py-2 rounded text-sm font-medium ${tab === 'inbox' ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'}`}
        >
          {t('sms.inbox')}
        </button>
        <button
          onClick={() => setTab('sent')}
          className={`px-4 py-2 rounded text-sm font-medium ${tab === 'sent' ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'}`}
        >
          {t('sms.sent')}
        </button>
      </div>

      {/* Filters */}
      <form onSubmit={handleSearch} className="bg-white rounded-lg shadow p-4 mb-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <div>
            <label className="text-xs text-gray-500">{t('sms.deviceFilter')}</label>
            <select value={filterDevId} onChange={e => setFilterDevId(e.target.value)}
              className="block w-full border rounded px-2 py-1.5 text-sm">
              <option value="">{t('sms.allDevices')}</option>
              {devices.map(d => (
                <option key={d.dev_id} value={d.dev_id}>{formatDeviceInline(d)}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-500">{t('sms.startDate')}</label>
            <input type="date" value={filterStartDate} onChange={e => setFilterStartDate(e.target.value)}
              className="block w-full border rounded px-2 py-1.5 text-sm" />
          </div>
          <div>
            <label className="text-xs text-gray-500">{t('sms.endDate')}</label>
            <input type="date" value={filterEndDate} onChange={e => setFilterEndDate(e.target.value)}
              className="block w-full border rounded px-2 py-1.5 text-sm" />
          </div>
          <div></div>
          <div className="flex items-end gap-2">
            <button type="submit" className="px-4 py-1.5 bg-blue-600 text-white rounded text-sm font-medium hover:bg-blue-700">
              {t('common.search')}
            </button>
            <button type="button" onClick={handleExport} className="px-4 py-1.5 bg-gray-200 text-gray-700 rounded text-sm font-medium hover:bg-gray-300">
              {t('common.exportCSV')}
            </button>
          </div>
        </div>
      </form>

      {/* Results */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        {loading ? (
          <div className="text-gray-500 p-8 text-center">{t('common.loading')}</div>
        ) : (
          <>
            <div className="px-4 py-2 text-sm text-gray-500 border-b">
              {tab === 'inbox' 
                ? t('sms.receivedCount', { total: pagination.total, page: pagination.page, pages: pagination.pages })
                : t('sms.sentCount', { total: pagination.total, page: pagination.page, pages: pagination.pages })
              }
            </div>
            <MessageTable messages={messages} deviceNameFirst />
          </>
        )}

        {pagination.pages > 1 && (
          <div className="px-4 py-3 border-t flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2 text-sm text-gray-600">
              <span>每页</span>
              <select
                value={pageSize}
                onChange={e => setPageSize(Number(e.target.value))}
                className="border rounded px-2 py-1 text-sm"
              >
                {[20, 50, 100].map(size => (
                  <option key={size} value={size}>{size}</option>
                ))}
              </select>
              <span>条</span>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              <button
                onClick={() => setPage(1)}
                disabled={page <= 1}
                className="px-3 py-1 border rounded text-sm disabled:opacity-50"
              >
                «
              </button>
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="px-3 py-1 border rounded text-sm disabled:opacity-50"
              >
                {t('common.previous')}
              </button>
              {pageNumbers.map((pageNo, index) => {
                const prev = pageNumbers[index - 1];
                const showGap = prev && pageNo - prev > 1;
                return (
                  <div key={pageNo} className="contents">
                    {showGap && <span className="px-2 py-1 text-sm text-gray-400">...</span>}
                    <button
                      onClick={() => setPage(pageNo)}
                      className={`px-3 py-1 border rounded text-sm ${
                        pageNo === page
                          ? 'bg-blue-600 text-white border-blue-600'
                          : 'hover:bg-gray-50'
                      }`}
                    >
                      {pageNo}
                    </button>
                  </div>
                );
              })}
              <button
                onClick={() => setPage(p => Math.min(pagination.pages, p + 1))}
                disabled={page >= pagination.pages}
                className="px-3 py-1 border rounded text-sm disabled:opacity-50"
              >
                {t('common.next')}
              </button>
              <button
                onClick={() => setPage(pagination.pages)}
                disabled={page >= pagination.pages}
                className="px-3 py-1 border rounded text-sm disabled:opacity-50"
              >
                »
              </button>
            </div>
            <span className="text-sm text-gray-600 text-center sm:text-right">
              Page {page} of {pagination.pages}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
