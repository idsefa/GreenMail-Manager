import { Fragment, useEffect, useState } from 'react';
import { api } from '../api';
import { useLang } from '../i18n.jsx';

function formatTime(value) {
  return value ? new Date(value * 1000).toLocaleString() : '-';
}

function formatContext(value) {
  if (!value) return '-';
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

export default function SystemLogs() {
  const { lang } = useLang();
  const text = lang === 'zh'
    ? { title: '系统日志', pending: '待处理', retry: '重试中', dead: '死信', capacity: '队列容量', refresh: '刷新', clear: '清空日志', level: '级别', all: '全部', search: '搜索', loading: '加载中...', empty: '暂无系统日志', time: '时间', scope: '范围', message: '消息', context: '上下文', failed: '加载失败', confirm: '确定清空当前筛选的系统日志吗？' }
    : { title: 'System Logs', pending: 'Pending', retry: 'Retrying', dead: 'Dead letters', capacity: 'Queue capacity', refresh: 'Refresh', clear: 'Clear logs', level: 'Level', all: 'All', search: 'Search', loading: 'Loading...', empty: 'No system logs', time: 'Time', scope: 'Scope', message: 'Message', context: 'Context', failed: 'Failed to load logs', confirm: 'Clear the currently filtered system logs?' };
  const [logs, setLogs] = useState([]);
  const [queue, setQueue] = useState({ pending: 0, retry: 0, dead: 0, maxSize: 0 });
  const [level, setLevel] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(null);

  async function load() {
    setLoading(true);
    try {
      const params = { limit: 100 };
      if (level) params.level = level;
      if (search) params.search = search;
      const [logData, queueData] = await Promise.all([api.getSystemLogs(params), api.getQueueStatus()]);
      setLogs(logData.logs || []);
      setQueue(queueData.queue || {});
    } catch (err) {
      console.error(text.failed, err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function clearLogs() {
    if (!confirm(text.confirm)) return;
    const params = {};
    if (level) params.level = level;
    if (search) params.search = search;
    await api.clearSystemLogs(params);
    load();
  }

  return (
    <div>
      <div className="mb-6 flex items-center gap-3">
        <h2 className="text-2xl font-bold text-gray-800">{text.title}</h2>
        <button onClick={load} className="px-3 py-1.5 text-sm rounded bg-gray-200 text-gray-700 hover:bg-gray-300">{text.refresh}</button>
        <button onClick={clearLogs} className="ml-auto px-3 py-1.5 text-sm rounded bg-red-600 text-white hover:bg-red-700">{text.clear}</button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        {[[text.pending, queue.pending, 'text-blue-700'], [text.retry, queue.retry, 'text-amber-700'], [text.dead, queue.dead, 'text-red-700'], [text.capacity, `${queue.pending || 0}/${queue.maxSize || 0}`, 'text-gray-700']].map(([label, value, color]) => (
          <div key={label} className="bg-white rounded-lg shadow p-4">
            <div className="text-xs text-gray-500">{label}</div>
            <div className={`mt-1 text-xl font-semibold ${color}`}>{value || 0}</div>
          </div>
        ))}
      </div>

      <form onSubmit={(event) => { event.preventDefault(); load(); }} className="bg-white rounded-lg shadow p-4 mb-5 flex flex-wrap gap-3 items-end">
        <label className="text-sm text-gray-600">
          {text.level}
          <select value={level} onChange={(event) => setLevel(event.target.value)} className="block mt-1 border rounded px-2 py-1.5">
            <option value="">{text.all}</option>
            <option value="error">error</option>
            <option value="warn">warn</option>
            <option value="info">info</option>
            <option value="debug">debug</option>
          </select>
        </label>
        <label className="text-sm text-gray-600 flex-1 min-w-48">
          {text.search}
          <input value={search} onChange={(event) => setSearch(event.target.value)} className="block mt-1 w-full border rounded px-2 py-1.5" />
        </label>
        <button className="px-4 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-700">{text.search}</button>
      </form>

      <div className="bg-white rounded-lg shadow overflow-hidden">
        {loading ? <div className="p-8 text-center text-gray-500">{text.loading}</div> : logs.length === 0 ? <div className="p-8 text-center text-gray-500">{text.empty}</div> : (
          <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="bg-gray-50 text-left text-gray-600"><tr><th className="px-3 py-2">{text.time}</th><th className="px-3 py-2">{text.level}</th><th className="px-3 py-2">{text.scope}</th><th className="px-3 py-2">{text.message}</th></tr></thead>
            <tbody className="divide-y divide-gray-100">{logs.map((log) => <Fragment key={log.id}>
              <tr key={log.id} onClick={() => setExpanded(expanded === log.id ? null : log.id)} className="hover:bg-gray-50 cursor-pointer"><td className="px-3 py-2 whitespace-nowrap text-gray-600">{formatTime(log.created_at)}</td><td className="px-3 py-2"><span className={`text-xs font-medium ${log.level === 'error' ? 'text-red-700' : log.level === 'warn' ? 'text-amber-700' : 'text-gray-700'}`}>{log.level}</span></td><td className="px-3 py-2 font-mono text-xs">{log.scope}</td><td className="px-3 py-2">{log.message}</td></tr>
              {expanded === log.id && <tr key={`${log.id}-context`}><td colSpan="4" className="px-3 pb-3 bg-gray-50"><div className="text-xs font-medium text-gray-600 mb-1">{text.context}</div><pre className="text-xs bg-gray-900 text-green-300 p-3 rounded overflow-auto max-h-52 whitespace-pre-wrap">{formatContext(log.context)}</pre></td></tr>}
            </Fragment>)}</tbody></table></div>
        )}
      </div>
    </div>
  );
}
