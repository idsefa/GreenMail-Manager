import { useState, useEffect } from 'react';
import { api } from '../api';
import MessageTable from '../components/MessageTable';
import { useLang } from '../i18n.jsx';
import { formatDeviceInline } from '../utils/device-label';

export default function Calls() {
  const [messages, setMessages] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, pages: 1, total: 0 });
  const [loading, setLoading] = useState(true);
  const [devices, setDevices] = useState([]);
  const [filterDevId, setFilterDevId] = useState('');
  const [filterStartDate, setFilterStartDate] = useState('');
  const [filterEndDate, setFilterEndDate] = useState('');
  const [page, setPage] = useState(1);
  const { t } = useLang();

  // Call types: 601-603 incoming, 620-623 outgoing, 641-642 DTMF
  const callTypes = '601,602,603,620,621,622,623,641,642';

  useEffect(() => {
    api.getDevices().then(d => setDevices(d.devices || [])).catch(console.error);
  }, []);

  useEffect(() => {
    setPage(1);
    loadMessages();
  }, [filterDevId]);

  useEffect(() => {
    loadMessages();
  }, [page]);

  async function loadMessages() {
    setLoading(true);
    try {
      const params = {
        type: callTypes,
        page,
        limit: 50
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
      console.error('Failed to load calls:', err);
    }
    setLoading(false);
  }

  function handleSearch(e) {
    e.preventDefault();
    setPage(1);
    loadMessages();
  }

  function handleExport() {
    const params = { type: callTypes };
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

  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-800 mb-6">{t('calls.title')}</h2>

      {/* Filters */}
      <form onSubmit={handleSearch} className="bg-white rounded-lg shadow p-4 mb-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <div>
            <label className="text-xs text-gray-500">{t('calls.deviceFilter')}</label>
            <select value={filterDevId} onChange={e => setFilterDevId(e.target.value)}
              className="block w-full border rounded px-2 py-1.5 text-sm">
              <option value="">{t('calls.allDevices')}</option>
              {devices.map(d => (
                <option key={d.dev_id} value={d.dev_id}>{formatDeviceInline(d)}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-500">{t('calls.startDate')}</label>
            <input type="date" value={filterStartDate} onChange={e => setFilterStartDate(e.target.value)}
              className="block w-full border rounded px-2 py-1.5 text-sm" />
          </div>
          <div>
            <label className="text-xs text-gray-500">{t('calls.endDate')}</label>
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

      {/* Call type legend */}
      <div className="bg-white rounded-lg shadow p-4 mb-6">
        <h3 className="text-sm font-semibold text-gray-700 mb-2">{t('calls.callEventTypes')}</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs text-gray-600">
          <div><span className="font-mono bg-yellow-50 px-1 rounded">601</span> {t('calls.incomingRing')}</div>
          <div><span className="font-mono bg-yellow-50 px-1 rounded">602</span> {t('calls.incomingAnswer')}</div>
          <div><span className="font-mono bg-yellow-50 px-1 rounded">603</span> {t('calls.incomingHangup')}</div>
          <div><span className="font-mono bg-orange-50 px-1 rounded">620</span> {t('calls.dialOut')}</div>
          <div><span className="font-mono bg-orange-50 px-1 rounded">621</span> {t('calls.outRing')}</div>
          <div><span className="font-mono bg-orange-50 px-1 rounded">622</span> {t('calls.outAnswer')}</div>
          <div><span className="font-mono bg-orange-50 px-1 rounded">623</span> {t('calls.outHangup')}</div>
          <div><span className="font-mono bg-purple-50 px-1 rounded">641</span> {t('calls.localDTMF')}</div>
          <div><span className="font-mono bg-purple-50 px-1 rounded">642</span> {t('calls.remoteDTMF')}</div>
        </div>
      </div>

      {/* Results */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        {loading ? (
          <div className="text-gray-500 p-8 text-center">{t('common.loading')}</div>
        ) : (
          <>
            <div className="px-4 py-2 text-sm text-gray-500 border-b">
              {t('calls.recordsFound', { total: pagination.total, page: pagination.page, pages: pagination.pages })}
            </div>
            <MessageTable messages={messages} />
          </>
        )}

        {pagination.pages > 1 && (
          <div className="px-4 py-3 border-t flex justify-center gap-2">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="px-3 py-1 border rounded text-sm disabled:opacity-50"
            >
              {t('common.previous')}
            </button>
            <span className="px-3 py-1 text-sm text-gray-600">
              Page {page} of {pagination.pages}
            </span>
            <button
              onClick={() => setPage(p => Math.min(pagination.pages, p + 1))}
              disabled={page >= pagination.pages}
              className="px-3 py-1 border rounded text-sm disabled:opacity-50"
            >
              {t('common.next')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
