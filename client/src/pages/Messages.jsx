import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import MessageTable from '../components/MessageTable';
import { useLang } from '../i18n.jsx';
import { formatDeviceInline } from '../utils/device-label';

export default function Messages() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [messages, setMessages] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, pages: 1, total: 0 });
  const [loading, setLoading] = useState(true);
  const [devices, setDevices] = useState([]);

  const [filterDevId, setFilterDevId] = useState(searchParams.get('dev_id') || '');
  const [filterType, setFilterType] = useState('');
  const [filterPhone, setFilterPhone] = useState('');
  const [filterSearch, setFilterSearch] = useState('');
  const [filterStartDate, setFilterStartDate] = useState('');
  const [filterEndDate, setFilterEndDate] = useState('');
  const [page, setPage] = useState(1);
  const { t } = useLang();

  useEffect(() => {
    api.getDevices().then(d => setDevices(d.devices || [])).catch(console.error);
  }, []);

  useEffect(() => {
    loadMessages();
  }, [page, filterDevId]);

  async function loadMessages() {
    setLoading(true);
    try {
      const params = { page, limit: 50 };
      if (filterDevId) params.dev_id = filterDevId;
      if (filterType) params.type = filterType;
      if (filterPhone) params.phone = filterPhone;
      if (filterSearch) params.search = filterSearch;
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
      console.error('Failed to load messages:', err);
    }
    setLoading(false);
  }

  function handleSearch(e) {
    e.preventDefault();
    setPage(1);
    loadMessages();
  }

  function handleExport() {
    const params = {};
    if (filterDevId) params.dev_id = filterDevId;
    if (filterType) params.type = filterType;
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
      <h2 className="text-2xl font-bold text-gray-800 mb-6">{t('messages.title')}</h2>

      {/* Filters */}
      <form onSubmit={handleSearch} className="bg-white rounded-lg shadow p-4 mb-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-7 gap-3">
          <div>
            <label className="text-xs text-gray-500">{t('messages.deviceFilter')}</label>
            <select value={filterDevId} onChange={e => { setFilterDevId(e.target.value); setPage(1); }}
              className="block w-full border rounded px-2 py-1.5 text-sm">
              <option value="">{t('messages.allDevices')}</option>
              {devices.map(d => (
                <option key={d.dev_id} value={d.dev_id}>
                  {formatDeviceInline(d)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-500">{t('messages.type')}</label>
            <input type="text" value={filterType} onChange={e => setFilterType(e.target.value)}
              placeholder={t('messages.typePlaceholder')} className="block w-full border rounded px-2 py-1.5 text-sm" />
          </div>
          <div>
            <label className="text-xs text-gray-500">{t('messages.phone')}</label>
            <input type="text" value={filterPhone} onChange={e => setFilterPhone(e.target.value)}
              placeholder={t('messages.phonePlaceholder')} className="block w-full border rounded px-2 py-1.5 text-sm" />
          </div>
          <div>
            <label className="text-xs text-gray-500">{t('messages.search')}</label>
            <input type="text" value={filterSearch} onChange={e => setFilterSearch(e.target.value)}
              placeholder={t('messages.searchPlaceholder')} className="block w-full border rounded px-2 py-1.5 text-sm" />
          </div>
          <div>
            <label className="text-xs text-gray-500">{t('messages.startDate')}</label>
            <input type="date" value={filterStartDate} onChange={e => setFilterStartDate(e.target.value)}
              className="block w-full border rounded px-2 py-1.5 text-sm" />
          </div>
          <div>
            <label className="text-xs text-gray-500">{t('messages.endDate')}</label>
            <input type="date" value={filterEndDate} onChange={e => setFilterEndDate(e.target.value)}
              className="block w-full border rounded px-2 py-1.5 text-sm" />
          </div>
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
              {t('messages.messagesFound', { total: pagination.total, page: pagination.page, pages: pagination.pages })}
            </div>
            <MessageTable messages={messages} />
          </>
        )}

        {/* Pagination */}
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
