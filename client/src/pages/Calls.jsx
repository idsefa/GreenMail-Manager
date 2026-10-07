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
  const [tab, setTab] = useState('records');
  const [records, setRecords] = useState([]);
  const [recordings, setRecordings] = useState([]);
  const [syncDevId, setSyncDevId] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState(null);
  const [storageStatus, setStorageStatus] = useState('');
  const [storageBusy, setStorageBusy] = useState(false);
  const [storageError, setStorageError] = useState('');
  const { t } = useLang();

  // Call types: 601-603 incoming, 620-623 outgoing, 641-642 DTMF
  const callTypes = '601,602,603,620,621,622,623,641,642';

  useEffect(() => {
    api.getDevices().then(d => setDevices(d.devices || [])).catch(console.error);
  }, []);

  useEffect(() => {
    setPage(1);
  }, [filterDevId, tab]);

  useEffect(() => {
    loadMessages();
  }, [page, filterDevId, tab]);

  async function loadMessages() {
    setLoading(true);
    try {
      if (tab === 'recordings') {
        const data = await api.getRecordings(filterDevId ? { dev_id: filterDevId, limit: 100 } : { limit: 100 });
        setRecordings(data.recordings || []);
        setPagination({ page: 1, pages: 1, total: (data.recordings || []).length });
        return;
      }
      const params = {
        page,
        limit: 50
      };
      if (tab === 'events') params.type = `${callTypes},695,696`;
      if (filterDevId) params.dev_id = filterDevId;
      if (filterStartDate) {
        const start = new Date(filterStartDate + 'T00:00:00');
        params.start_date = Math.floor(start.getTime() / 1000);
      }
      if (filterEndDate) {
        const end = new Date(filterEndDate + 'T23:59:59');
        params.end_date = Math.floor(end.getTime() / 1000);
      }

      const data = tab === 'records' ? await api.getCallRecords(params) : await api.getMessages(params);
      if (tab === 'records') setRecords(data.records || []);
      else setMessages(data.messages || []);
      setPagination(data.pagination || { page: 1, pages: 1, total: 0 });
    } catch (err) {
      console.error('Failed to load calls:', err);
    } finally {
      setLoading(false);
    }
  }

  async function syncCalls() {
    if (!syncDevId) return;
    setSyncing(true);
    setSyncResult(null);
    try {
      const result = await api.syncCalls(syncDevId);
      setSyncResult(result);
      if (tab === 'records') await loadMessages();
    } catch (err) {
      setSyncResult({ error: err.message });
    } finally {
      setSyncing(false);
    }
  }

  async function manageCallStorage(mode) {
    if (!syncDevId) return;
    setStorageBusy(true);
    setStorageError('');
    try {
      const params = mode === 'query' ? {} : { p1: 0, p2: mode };
      const response = await api.sendCommand(syncDevId, 'storetelen', params);
      const result = response?.result || response;
      if (!(result?.code === 0 || result?.code === '0')) throw new Error(result?.note || `storetelen failed (code ${result?.code ?? 'unknown'})`);
      setStorageStatus(String(result.val || ''));
      if (mode !== 'query') setStorageError('设置已保存，重启设备后生效。');
    } catch (err) {
      setStorageError(err.message);
    } finally {
      setStorageBusy(false);
    }
  }

  function handleSearch(e) {
    e.preventDefault();
    setPage(1);
    loadMessages();
  }

  function handleExport() {
    const params = { type: `${callTypes},695,696` };
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

      <div className="mb-4 flex flex-wrap items-end gap-3 border-b border-gray-200 pb-4">
        <label className="text-sm text-gray-600">{t('common.device')}
          <select value={syncDevId} onChange={e => { setSyncDevId(e.target.value); setStorageStatus(''); setStorageError(''); }} className="mt-1 block max-w-full rounded border px-2 py-1.5 text-sm">
            <option value="">{t('calls.allDevices')}</option>
            {devices.filter(d => d.wifi_ip).map(d => <option key={d.dev_id} value={d.dev_id}>{formatDeviceInline(d)}</option>)}
          </select>
        </label>
        <button onClick={syncCalls} disabled={!syncDevId || syncing} className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-50">
          {syncing ? '同步中...' : '从设备同步通话记录'}
        </button>
        <button onClick={() => manageCallStorage('query')} disabled={!syncDevId || storageBusy} className="rounded border px-3 py-1.5 text-sm disabled:opacity-50">查询存储状态</button>
        <button onClick={() => manageCallStorage('on')} disabled={!syncDevId || storageBusy} className="rounded border px-3 py-1.5 text-sm disabled:opacity-50">启用通话存储</button>
        <button onClick={() => manageCallStorage('off')} disabled={!syncDevId || storageBusy} className="rounded border px-3 py-1.5 text-sm disabled:opacity-50">关闭通话存储</button>
        {storageStatus && <span className="text-sm text-gray-700">{storageStatus}</span>}
        {storageError && <span role="status" className="text-sm text-amber-700">{storageError}</span>}
        {syncResult && <span className={`text-sm ${syncResult.error ? 'text-red-700' : 'text-green-700'}`}>{syncResult.error || `拉取 ${syncResult.total_pulled} 条，新增 ${syncResult.saved} 条，跳过 ${syncResult.skipped} 条`}</span>}
      </div>

      <div className="mb-5 flex gap-1 border-b border-gray-200" role="tablist">
        {[["records", "通话记录"], ["events", "通话事件"], ["recordings", "录音文件"]].map(([value, label]) => (
          <button key={value} role="tab" aria-selected={tab === value} onClick={() => setTab(value)} className={`border-b-2 px-4 py-2 text-sm ${tab === value ? 'border-blue-600 font-medium text-blue-700' : 'border-transparent text-gray-600 hover:text-gray-900'}`}>{label}</button>
        ))}
      </div>

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
            {tab === 'events' && <button type="button" onClick={handleExport} className="px-4 py-1.5 bg-gray-200 text-gray-700 rounded text-sm font-medium hover:bg-gray-300">
              {t('common.exportCSV')}
            </button>}
          </div>
        </div>
      </form>

      {/* Call type legend */}
      {tab === 'events' && <div className="bg-white rounded-lg shadow p-4 mb-6">
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
        <div className="mt-2 text-xs text-gray-600">695 录音上传成功 · 696 录音上传失败</div>
      </div>}

      {/* Results */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        {loading ? (
          <div className="text-gray-500 p-8 text-center">{t('common.loading')}</div>
        ) : (
          <>
            <div className="px-4 py-2 text-sm text-gray-500 border-b">
              {t('calls.recordsFound', { total: pagination.total, page: pagination.page, pages: pagination.pages })}
            </div>
            {tab === 'events' && <MessageTable messages={messages} />}
            {tab === 'records' && (
              <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="bg-gray-50 text-left text-gray-600"><tr><th className="px-3 py-2">开始</th><th className="px-3 py-2">设备</th><th className="px-3 py-2">卡槽</th><th className="px-3 py-2">方向</th><th className="px-3 py-2">号码</th><th className="px-3 py-2">状态</th><th className="px-3 py-2">时长</th></tr></thead><tbody className="divide-y">{records.map(record => <tr key={record.id}><td className="whitespace-nowrap px-3 py-2">{new Date(record.started_at * 1000).toLocaleString()}</td><td className="px-3 py-2">{record.device_name || record.dev_id}</td><td className="px-3 py-2">{record.slot}</td><td className="px-3 py-2">{record.direction === 0 ? '来电' : '去电'}</td><td className="px-3 py-2 font-mono">{record.phone || '-'}</td><td className="px-3 py-2">{record.connected ? '已接通' : '未接通'}</td><td className="px-3 py-2">{Math.max(0, record.ended_at - record.started_at)}s</td></tr>)}</tbody></table>{records.length === 0 && <div className="p-8 text-center text-gray-500">暂无通话记录</div>}</div>
            )}
            {tab === 'recordings' && (
              <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="bg-gray-50 text-left text-gray-600"><tr><th className="px-3 py-2">上传时间</th><th className="px-3 py-2">设备</th><th className="px-3 py-2">卡槽</th><th className="px-3 py-2">号码</th><th className="px-3 py-2">文件</th><th className="px-3 py-2">大小</th><th className="px-3 py-2">操作</th></tr></thead><tbody className="divide-y">{recordings.map(recording => <tr key={recording.id}><td className="whitespace-nowrap px-3 py-2">{new Date(recording.created_at * 1000).toLocaleString()}</td><td className="px-3 py-2">{recording.dev_id || '-'}</td><td className="px-3 py-2">{recording.slot || '-'}</td><td className="px-3 py-2">{recording.phone || '-'}</td><td className="px-3 py-2 break-all">{recording.filename}</td><td className="px-3 py-2">{(recording.size_bytes / 1024).toFixed(1)} KB</td><td className="px-3 py-2"><a href={api.getRecordingUrl(recording.media_id)} className="text-blue-700 hover:underline" download={recording.filename}>下载</a></td></tr>)}</tbody></table>{recordings.length === 0 && <div className="p-8 text-center text-gray-500">暂无录音文件</div>}</div>
            )}
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
