import { Fragment, useEffect, useState } from 'react';
import { api } from '../api';
import { useLang } from '../i18n.jsx';
import { formatDeviceInline, getDeviceDisplayParts } from '../utils/device-label';

function formatTime(ts) {
  if (!ts) return '-';
  return new Date(ts * 1000).toLocaleString();
}

function safePretty(value) {
  if (value === null || value === undefined || value === '') return '-';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export default function InterfaceLogs() {
  const [logs, setLogs] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, pages: 1, total: 0 });
  const [loading, setLoading] = useState(true);
  const [devices, setDevices] = useState([]);
  const [expanded, setExpanded] = useState(null);

  const [filterDevId, setFilterDevId] = useState('');
  const [filterProtocol, setFilterProtocol] = useState('');
  const [filterDirection, setFilterDirection] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterSearch, setFilterSearch] = useState('');
  const [filterStartDate, setFilterStartDate] = useState('');
  const [filterEndDate, setFilterEndDate] = useState('');
  const [recentHours, setRecentHours] = useState(0);
  const [clearing, setClearing] = useState(false);
  const [page, setPage] = useState(1);
  const { t } = useLang();

  useEffect(() => {
    api.getDevices().then(d => setDevices(d.devices || [])).catch(console.error);
  }, []);

  useEffect(() => {
    loadLogs();
  }, [page]);

  function getParams(targetPage = page, overrides = {}) {
    const params = { page: targetPage, limit: 50 };
    const next = {
      filterDevId,
      filterProtocol,
      filterDirection,
      filterStatus,
      filterSearch,
      filterStartDate,
      filterEndDate,
      recentHours,
      ...overrides
    };

    if (next.filterDevId) params.dev_id = next.filterDevId;
    if (next.filterProtocol) params.protocol = next.filterProtocol;
    if (next.filterDirection) params.direction = next.filterDirection;
    if (next.filterStatus) params.status = next.filterStatus;
    if (next.filterSearch) params.search = next.filterSearch;
    if (next.recentHours) params.recent_hours = next.recentHours;
    if (next.filterStartDate) {
      const start = new Date(next.filterStartDate + 'T00:00:00');
      params.start_date = Math.floor(start.getTime() / 1000);
    }
    if (next.filterEndDate) {
      const end = new Date(next.filterEndDate + 'T23:59:59');
      params.end_date = Math.floor(end.getTime() / 1000);
    }

    return params;
  }

  async function loadLogs(overrides = {}, targetPage = page) {
    setLoading(true);
    try {
      const params = getParams(targetPage, overrides);
      const data = await api.getInterfaceLogs(params);
      setLogs(data.logs || []);
      setPagination(data.pagination || { page: 1, pages: 1, total: 0 });
    } catch (err) {
      console.error('Failed to load interface logs:', err);
    }
    setLoading(false);
  }

  function handleSearch(e) {
    e.preventDefault();
    setPage(1);
    loadLogs({}, 1);
  }

  function toggleExpanded(id) {
    setExpanded(prev => (prev === id ? null : id));
  }

  function applySelectFilters(patch) {
    if (patch.filterDevId !== undefined) setFilterDevId(patch.filterDevId);
    if (patch.filterProtocol !== undefined) setFilterProtocol(patch.filterProtocol);
    if (patch.filterDirection !== undefined) setFilterDirection(patch.filterDirection);
    if (patch.filterStatus !== undefined) setFilterStatus(patch.filterStatus);
    if (patch.recentHours !== undefined) setRecentHours(patch.recentHours);
    setPage(1);
    loadLogs(patch, 1);
  }

  function applyRecent24h() {
    setFilterStartDate('');
    setFilterEndDate('');
    applySelectFilters({ filterStartDate: '', filterEndDate: '', recentHours: 24 });
  }

  function resetFilters() {
    setFilterDevId('');
    setFilterProtocol('');
    setFilterDirection('');
    setFilterStatus('');
    setFilterSearch('');
    setFilterStartDate('');
    setFilterEndDate('');
    setRecentHours(0);
    setPage(1);
    loadLogs({
      filterDevId: '',
      filterProtocol: '',
      filterDirection: '',
      filterStatus: '',
      filterSearch: '',
      filterStartDate: '',
      filterEndDate: '',
      recentHours: 0
    }, 1);
  }

  async function clearLogs() {
    if (!confirm(t('interfaceLogs.clearConfirm'))) return;
    setClearing(true);
    try {
      const params = getParams(1);
      delete params.page;
      delete params.limit;
      await api.clearInterfaceLogs(params);
      setExpanded(null);
      setPage(1);
      await loadLogs({}, 1);
    } catch (err) {
      alert(`${t('interfaceLogs.clearFailed')}: ${err.message}`);
    } finally {
      setClearing(false);
    }
  }

  const protocolLabels = {
    webhook: t('interfaceLogs.protocolWebhook'),
    tcp: t('interfaceLogs.protocolTcp'),
    'device-http': t('interfaceLogs.protocolDeviceHttp')
  };

  const directionLabels = {
    in: t('interfaceLogs.incoming'),
    out: t('interfaceLogs.outgoing')
  };

  const statusLabels = {
    ok: t('interfaceLogs.statusOk'),
    failed: t('interfaceLogs.statusFailed'),
    ignored: t('interfaceLogs.statusIgnored')
  };

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-800">{t('interfaceLogs.title')}</h2>
        <p className="text-sm text-gray-500 mt-1">{t('interfaceLogs.description')}</p>
      </div>

      <div className="bg-white rounded-lg shadow p-4 mb-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={applyRecent24h}
          className={`px-3 py-1.5 rounded text-sm font-medium ${recentHours === 24 ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'}`}
        >
          {t('interfaceLogs.recent24h')}
        </button>
        <button
          type="button"
          onClick={() => applySelectFilters({ filterStatus: filterStatus === 'failed' ? '' : 'failed', recentHours: recentHours })}
          className={`px-3 py-1.5 rounded text-sm font-medium ${filterStatus === 'failed' ? 'bg-red-600 text-white' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'}`}
        >
          {t('interfaceLogs.failedOnly')}
        </button>
        <button
          type="button"
          onClick={resetFilters}
          className="px-3 py-1.5 rounded text-sm font-medium bg-gray-200 text-gray-700 hover:bg-gray-300"
        >
          {t('interfaceLogs.resetFilters')}
        </button>
        <button
          type="button"
          onClick={clearLogs}
          disabled={clearing}
          className="ml-auto px-3 py-1.5 rounded text-sm font-medium bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
        >
          {clearing ? t('common.loading') : t('interfaceLogs.clearLogs')}
        </button>
      </div>

      <form onSubmit={handleSearch} className="bg-white rounded-lg shadow p-4 mb-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-7 gap-3">
          <div>
            <label className="text-xs text-gray-500">{t('interfaceLogs.deviceFilter')}</label>
            <select value={filterDevId} onChange={e => applySelectFilters({ filterDevId: e.target.value })} className="block w-full border rounded px-2 py-1.5 text-sm">
              <option value="">{t('interfaceLogs.allDevices')}</option>
              {devices.map(d => (
                <option key={d.dev_id} value={d.dev_id}>{formatDeviceInline(d)}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-500">{t('interfaceLogs.protocol')}</label>
            <select value={filterProtocol} onChange={e => applySelectFilters({ filterProtocol: e.target.value })} className="block w-full border rounded px-2 py-1.5 text-sm">
              <option value="">{t('interfaceLogs.allProtocols')}</option>
              <option value="webhook">{t('interfaceLogs.protocolWebhook')}</option>
              <option value="tcp">{t('interfaceLogs.protocolTcp')}</option>
              <option value="device-http">{t('interfaceLogs.protocolDeviceHttp')}</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-500">{t('interfaceLogs.direction')}</label>
            <select value={filterDirection} onChange={e => applySelectFilters({ filterDirection: e.target.value })} className="block w-full border rounded px-2 py-1.5 text-sm">
              <option value="">{t('interfaceLogs.allDirections')}</option>
              <option value="in">{t('interfaceLogs.incoming')}</option>
              <option value="out">{t('interfaceLogs.outgoing')}</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-500">{t('interfaceLogs.status')}</label>
            <select value={filterStatus} onChange={e => applySelectFilters({ filterStatus: e.target.value })} className="block w-full border rounded px-2 py-1.5 text-sm">
              <option value="">{t('interfaceLogs.allStatuses')}</option>
              <option value="ok">{t('interfaceLogs.statusOk')}</option>
              <option value="failed">{t('interfaceLogs.statusFailed')}</option>
              <option value="ignored">{t('interfaceLogs.statusIgnored')}</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-500">{t('common.search')}</label>
            <input type="text" value={filterSearch} onChange={e => setFilterSearch(e.target.value)} placeholder={t('interfaceLogs.searchPlaceholder')} className="block w-full border rounded px-2 py-1.5 text-sm" />
          </div>
          <div>
            <label className="text-xs text-gray-500">{t('interfaceLogs.startDate')}</label>
            <input type="date" value={filterStartDate} onChange={e => setFilterStartDate(e.target.value)} className="block w-full border rounded px-2 py-1.5 text-sm" />
          </div>
          <div>
            <label className="text-xs text-gray-500">{t('interfaceLogs.endDate')}</label>
            <input type="date" value={filterEndDate} onChange={e => setFilterEndDate(e.target.value)} className="block w-full border rounded px-2 py-1.5 text-sm" />
          </div>
          <div className="flex items-end gap-2">
            <button type="submit" className="px-4 py-1.5 bg-blue-600 text-white rounded text-sm font-medium hover:bg-blue-700">
              {t('common.search')}
            </button>
          </div>
        </div>
      </form>

      <div className="bg-white rounded-lg shadow overflow-hidden">
        {loading ? (
          <div className="text-gray-500 p-8 text-center">{t('common.loading')}</div>
        ) : (
          <>
            <div className="px-4 py-2 text-sm text-gray-500 border-b">
              {t('interfaceLogs.logsFound', { total: pagination.total, page: pagination.page, pages: pagination.pages })}
            </div>
            {logs.length === 0 ? (
              <div className="p-8 text-center text-gray-500">{t('interfaceLogs.noLogs')}</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-left text-gray-600">
                    <tr>
                      <th className="px-3 py-2 font-medium">{t('common.time')}</th>
                      <th className="px-3 py-2 font-medium">{t('interfaceLogs.deviceFilter')}</th>
                      <th className="px-3 py-2 font-medium">{t('interfaceLogs.protocol')}</th>
                      <th className="px-3 py-2 font-medium">{t('interfaceLogs.direction')}</th>
                      <th className="px-3 py-2 font-medium">{t('interfaceLogs.endpoint')}</th>
                      <th className="px-3 py-2 font-medium">{t('interfaceLogs.status')}</th>
                      <th className="px-3 py-2 font-medium">{t('interfaceLogs.requestSummary')}</th>
                      <th className="px-3 py-2 font-medium">{t('interfaceLogs.responseSummary')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {logs.map((log) => {
                      const deviceDisplay = getDeviceDisplayParts(log, { preferName: true });
                      return (
                        <Fragment key={log.id}>
                          <tr className="hover:bg-gray-50 cursor-pointer" onClick={() => toggleExpanded(log.id)}>
                            <td className="px-3 py-2 whitespace-nowrap text-gray-600">{formatTime(log.created_at)}</td>
                            <td className="px-3 py-2">
                              <div className="text-sm text-gray-800">{deviceDisplay.primary}</div>
                              {deviceDisplay.secondary && (
                                <div className="font-mono text-xs text-gray-400">{deviceDisplay.secondary}</div>
                              )}
                            </td>
                            <td className="px-3 py-2">
                              <span className="inline-block px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-700">{protocolLabels[log.protocol] || log.protocol || '-'}</span>
                            </td>
                            <td className="px-3 py-2">
                              <span className="inline-block px-2 py-0.5 rounded text-xs bg-blue-50 text-blue-700">{directionLabels[log.direction] || log.direction || '-'}</span>
                            </td>
                            <td className="px-3 py-2 font-mono text-xs">{log.endpoint || '-'}</td>
                            <td className="px-3 py-2">
                              <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${log.status === 'ok' ? 'bg-green-100 text-green-700' : log.status === 'failed' ? 'bg-red-100 text-red-700' : 'bg-yellow-100 text-yellow-700'}`}>
                                {statusLabels[log.status] || log.status || '-'}
                              </span>
                            </td>
                            <td className="px-3 py-2 max-w-xs truncate" title={log.request_summary}>{log.request_summary || '-'}</td>
                            <td className="px-3 py-2 max-w-xs truncate" title={log.response_summary}>{log.response_summary || '-'}</td>
                          </tr>
                          {expanded === log.id && (
                            <tr>
                              <td colSpan="8" className="px-4 pb-4 bg-gray-50">
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-3 text-xs">
                                  <div>
                                    <div className="font-semibold text-gray-600 mb-1">{t('interfaceLogs.requestRaw')}</div>
                                    <pre className="bg-gray-900 text-green-300 rounded p-3 overflow-auto max-h-64 whitespace-pre-wrap">{safePretty(log.request_raw)}</pre>
                                  </div>
                                  <div>
                                    <div className="font-semibold text-gray-600 mb-1">{t('interfaceLogs.responseRaw')}</div>
                                    <pre className="bg-gray-900 text-green-300 rounded p-3 overflow-auto max-h-64 whitespace-pre-wrap">{safePretty(log.response_raw)}</pre>
                                  </div>
                                  <div className="md:col-span-2 text-gray-600 flex flex-wrap gap-4">
                                    <span><span className="font-semibold">{t('interfaceLogs.remoteAddr')}:</span> {log.remote_addr || '-'}</span>
                                    <span><span className="font-semibold">{t('common.time')}:</span> {formatTime(log.created_at)}</span>
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {pagination.pages > 1 && (
          <div className="px-4 py-3 border-t flex justify-center gap-2">
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1} className="px-3 py-1 border rounded text-sm disabled:opacity-50">
              {t('common.previous')}
            </button>
            <span className="px-3 py-1 text-sm text-gray-600">
              Page {page} of {pagination.pages}
            </span>
            <button onClick={() => setPage(p => Math.min(pagination.pages, p + 1))} disabled={page >= pagination.pages} className="px-3 py-1 border rounded text-sm disabled:opacity-50">
              {t('common.next')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
