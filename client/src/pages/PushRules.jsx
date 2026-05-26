import { useState, useEffect } from 'react';
import { api } from '../api';
import { useLang } from '../i18n.jsx';
import { formatDeviceIdList } from '../utils/device-label';

const PRESETS = {
  default: '',
  dingtalk: '{"msgtype":"text","text":{"content":"[{{device_label}}] {{event_label}}\\n{{phone}}: {{content}}"}}',
  feishu: '{"msg_type":"text","content":{"text":"[{{device_label}}] {{event_label}}\\n{{phone}}: {{content}}"}}',
  bark: '{"device_key":"YOUR_KEY","title":"{{device_label}}","body":"{{event_label}}\\n{{phone}}: {{content}}","group":"GreenMail"}',
  serverchan: 'title={{device_label}}&desp={{event_label}}%0A{{phone}}: {{content}}',
  wecom: '{"msgtype":"text","text":{"content":"[{{device_label}}] {{event_label}}\\n{{phone}}: {{content}}"}}',
  telegram: '{"chat_id":"CHAT_ID","text":"[{{device_label}}] {{event_label}}\\n{{phone}}: {{content}}"}',
  slack: '{"text":"[{{device_label}}] {{event_label}}\\n{{phone}}: {{content}}"}',
  custom: '{"dev_id":"{{dev_id}}","device_name":"{{device_name}}","device_label":"{{device_label}}","event_label":"{{event_label}}","type":{{type}},"phone":"{{phone}}","msIsdn":"{{msIsdn}}","content":"{{content}}","time":"{{received_at}}"}'
};

const PRESET_HINTS = {
  default:   { method: 'POST', urlPlaceholder: 'https://example.com/webhook', headers: '{}' },
  dingtalk:  { method: 'POST', urlPlaceholder: 'https://oapi.dingtalk.com/robot/send?access_token=xxx', headers: '{"Content-Type":"application/json"}' },
  feishu:    { method: 'POST', urlPlaceholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/xxx', headers: '{"Content-Type":"application/json"}' },
  bark:      { method: 'POST', urlPlaceholder: 'https://api.day.app/push', headers: '{"Content-Type":"application/json"}' },
  serverchan:{ method: 'POST', urlPlaceholder: 'https://sctapi.ftqq.com/SENDKEY.send', headers: '{"Content-Type":"application/x-www-form-urlencoded"}' },
  wecom:     { method: 'POST', urlPlaceholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=YOUR_KEY', headers: '{"Content-Type":"application/json"}' },
  telegram:  { method: 'POST', urlPlaceholder: 'https://api.telegram.org/botTOKEN/sendMessage', headers: '{"Content-Type":"application/json"}' },
  slack:     { method: 'POST', urlPlaceholder: 'https://hooks.slack.com/services/xxx/xxx/xxx', headers: '{"Content-Type":"application/json"}' },
  custom:    { method: 'POST', urlPlaceholder: 'https://example.com/webhook', headers: '{}' },
};

export default function PushRules() {
  const [rules, setRules] = useState([]);
  const [devicesById, setDevicesById] = useState({});
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [logs, setLogs] = useState(null);
  const [logsRuleId, setLogsRuleId] = useState(null);
  const { t } = useLang();

  useEffect(() => {
    loadRules();
    loadDevices();
  }, []);

  async function loadRules() {
    try {
      const data = await api.getPushRules();
      setRules(data.rules || []);
    } catch (err) {
      console.error('Failed to load push rules:', err);
    }
    setLoading(false);
  }

  async function loadDevices() {
    try {
      const data = await api.getDevices();
      setDevicesById(
        Object.fromEntries((data.devices || []).map(device => [device.dev_id, device.name || '']))
      );
    } catch (err) {
      console.error('Failed to load devices for push rules:', err);
    }
  }

  async function toggleEnabled(rule) {
    try {
      await api.updatePushRule(rule.id, { enabled: rule.enabled ? 0 : 1 });
      loadRules();
    } catch (err) {
      alert(t('pushRules.toggleFailed') + ': ' + err.message);
    }
  }

  async function deleteRule(id) {
    if (!confirm(t('pushRules.deleteConfirm'))) return;
    try {
      await api.deletePushRule(id);
      loadRules();
    } catch (err) {
      alert(t('pushRules.deleteFailed') + ': ' + err.message);
    }
  }

  async function testRule(id) {
    try {
      const result = await api.testPushRule(id);
      const lines = [
        `${t('pushRules.testResult')}: ${result.status}`,
        `HTTP ${result.http_status || 'N/A'}`
      ];
      if (result.url_sent) lines.push(`URL ${result.url_sent}`);
      if (result.error || result.response) lines.push(result.error || result.response);
      alert(lines.join('\n'));
    } catch (err) {
      alert(t('pushRules.testFailed') + ': ' + err.message);
    }
  }

  async function viewLogs(ruleId) {
    try {
      const data = await api.getPushLogs(ruleId);
      setLogs(data.logs || []);
      setLogsRuleId(ruleId);
    } catch (err) {
      alert(t('pushRules.loadLogsFailed') + ': ' + err.message);
    }
  }

  if (loading) return <div className="text-gray-500">{t('common.loading')}</div>;

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-bold text-gray-800">{t('pushRules.title')}</h2>
        <button
          onClick={() => setEditing({ name: '', url: '', method: 'POST', headers: '{}', body_template: '', trigger_types: '', trigger_devices: '', trigger_msisdn: '' })}
          className="bg-green-600 text-white px-4 py-2 rounded text-sm hover:bg-green-700"
        >
          {t('pushRules.newRule')}
        </button>
      </div>

      {/* Rules list */}
      {rules.length === 0 && !editing ? (
        <div className="bg-white rounded-lg shadow p-8 text-center text-gray-500">
          <p>{t('pushRules.noRules')}</p>
          <p className="text-sm mt-2">{t('pushRules.noRulesHint')}</p>
        </div>
      ) : (
        <div className="grid gap-4 mb-6">
          {rules.map((rule) => (
            <div key={rule.id} className="bg-white rounded-lg shadow p-4">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-1">
                    <button
                      onClick={() => toggleEnabled(rule)}
                      className={`w-10 h-5 rounded-full relative transition-colors ${rule.enabled ? 'bg-green-500' : 'bg-gray-300'}`}
                    >
                      <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${rule.enabled ? 'left-5' : 'left-0.5'}`} />
                    </button>
                    <h3 className="text-lg font-semibold text-gray-800">{rule.name || `${t('pushRules.ruleName')} #${rule.id}`}</h3>
                  </div>
                  <div className="text-sm text-gray-600 ml-13">
                    <div><span className="text-gray-400">{rule.method} </span>{rule.url}</div>
                    <div className="flex gap-4 mt-1">
                      <span className="text-gray-400">{t('common.type')}: {rule.trigger_types || t('common.all')}</span>
                      <span className="text-gray-400">{t('common.device')}: {formatDeviceIdList(rule.trigger_devices, devicesById) || t('common.all')}</span>
                      <span className="text-gray-400">MSISDN: {rule.trigger_msisdn || t('common.all')}</span>
                    </div>
                  </div>
                </div>
                <div className="flex gap-2 ml-4">
                  <button onClick={() => testRule(rule.id)} className="text-blue-600 hover:underline text-sm px-2 py-1">{t('pushRules.test')}</button>
                  <button onClick={() => viewLogs(rule.id)} className="text-gray-600 hover:underline text-sm px-2 py-1">{t('pushRules.logs')}</button>
                  <button onClick={() => setEditing({ ...rule })} className="text-gray-600 hover:underline text-sm px-2 py-1">{t('pushRules.edit')}</button>
                  <button onClick={() => deleteRule(rule.id)} className="text-red-400 hover:text-red-600 text-sm px-2 py-1">{t('pushRules.delete')}</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Edit/Create form */}
      {editing && <RuleForm rule={editing} onClose={() => { setEditing(null); loadRules(); }} />}

      {/* Logs modal */}
      {logs && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50" onClick={() => setLogs(null)}>
          <div className="bg-white rounded-lg shadow-lg p-6 max-w-3xl w-full max-h-[80vh] overflow-auto" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-semibold">{t('pushRules.pushLogs', { ruleId: logsRuleId })}</h3>
              <button onClick={() => setLogs(null)} className="text-gray-400 hover:text-gray-600 text-xl">&times;</button>
            </div>
            {logs.length === 0 ? (
              <p className="text-gray-500 text-center py-4">{t('pushRules.noLogs')}</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-gray-500">
                    <th className="py-2">{t('pushRules.logTime')}</th>
                    <th className="py-2">{t('pushRules.logStatus')}</th>
                    <th className="py-2">{t('pushRules.logHTTPCode')}</th>
                    <th className="py-2">{t('pushRules.logError')}</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log) => (
                    <tr key={log.id} className="border-b">
                      <td className="py-2 text-gray-600">{new Date(log.created_at * 1000).toLocaleString()}</td>
                      <td className="py-2">
                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                          log.status === 'success' ? 'bg-green-100 text-green-700' :
                          log.status === 'failed' ? 'bg-red-100 text-red-700' :
                          'bg-yellow-100 text-yellow-700'
                        }`}>{log.status}</span>
                      </td>
                      <td className="py-2">{log.response_code || '-'}</td>
                      <td className="py-2 text-red-500 truncate max-w-xs">{log.error || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function RuleForm({ rule, onClose }) {
  const isEdit = !!rule.id;
  const [form, setForm] = useState({
    name: rule.name || '',
    url: rule.url || '',
    method: rule.method || 'POST',
    headers: rule.headers || '{}',
    body_template: rule.body_template || '',
    trigger_types: rule.trigger_types || '',
    trigger_devices: rule.trigger_devices || '',
    trigger_msisdn: rule.trigger_msisdn || ''
  });
  const [preset, setPreset] = useState('default');
  const [saving, setSaving] = useState(false);
  const [urlPlaceholder, setUrlPlaceholder] = useState(PRESET_HINTS.default.urlPlaceholder);
  const { t } = useLang();

  function update(key, val) {
    setForm(prev => ({ ...prev, [key]: val }));
  }

  function applyPreset(key) {
    setPreset(key);
    const hints = PRESET_HINTS[key];
    if (hints) {
      update('method', hints.method);
      update('headers', hints.headers);
      setUrlPlaceholder(hints.urlPlaceholder);
    }
    if (PRESETS[key]) {
      update('body_template', PRESETS[key]);
    } else {
      update('body_template', '');
    }
  }

  async function save() {
    if (!form.url) { alert(t('pushRules.urlRequired')); return; }
    setSaving(true);
    try {
      if (isEdit) {
        await api.updatePushRule(rule.id, form);
      } else {
        await api.createPushRule(form);
      }
      onClose();
    } catch (err) {
      alert(t('pushRules.saveFailed') + ': ' + err.message);
    }
    setSaving(false);
  }

  return (
    <div className="bg-white rounded-lg shadow p-6 mb-6">
      <h3 className="text-lg font-semibold text-gray-700 mb-4">{isEdit ? t('pushRules.editRule') : t('pushRules.createRule')}</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        <div>
          <label className="block text-sm text-gray-500 mb-1">{t('pushRules.nameLabel')}</label>
          <input type="text" value={form.name} onChange={e => update('name', e.target.value)}
            className="w-full border rounded px-3 py-2 text-sm" placeholder={t('pushRules.namePlaceholder')} />
        </div>
        <div>
          <label className="block text-sm text-gray-500 mb-1">{t('pushRules.urlLabel')}</label>
          <input type="text" value={form.url} onChange={e => update('url', e.target.value)}
            className="w-full border rounded px-3 py-2 text-sm" placeholder={urlPlaceholder} />
        </div>
        <div>
          <label className="block text-sm text-gray-500 mb-1">{t('pushRules.methodLabel')}</label>
          <select value={form.method} onChange={e => update('method', e.target.value)}
            className="w-full border rounded px-3 py-2 text-sm">
            <option value="POST">POST</option>
            <option value="PUT">PUT</option>
            <option value="GET">GET</option>
          </select>
        </div>
        <div>
          <label className="block text-sm text-gray-500 mb-1">{t('pushRules.headersLabel')}</label>
          <input type="text" value={form.headers} onChange={e => update('headers', e.target.value)}
            className="w-full border rounded px-3 py-2 text-sm" placeholder={t('pushRules.headersPlaceholder')} />
        </div>
        <div>
          <label className="block text-sm text-gray-500 mb-1">{t('pushRules.triggerTypesLabel')}</label>
          <input type="text" value={form.trigger_types} onChange={e => update('trigger_types', e.target.value)}
            className="w-full border rounded px-3 py-2 text-sm" placeholder={t('pushRules.triggerTypesPlaceholder')} />
        </div>
        <div>
          <label className="block text-sm text-gray-500 mb-1">{t('pushRules.triggerDevicesLabel')}</label>
          <input type="text" value={form.trigger_devices} onChange={e => update('trigger_devices', e.target.value)}
            className="w-full border rounded px-3 py-2 text-sm" placeholder={t('pushRules.triggerDevicesPlaceholder')} />
        </div>
        <div>
          <label className="block text-sm text-gray-500 mb-1">{t('pushRules.triggerMsisdnLabel')}</label>
          <input type="text" value={form.trigger_msisdn} onChange={e => update('trigger_msisdn', e.target.value)}
            className="w-full border rounded px-3 py-2 text-sm" placeholder={t('pushRules.triggerMsisdnPlaceholder')} />
        </div>
      </div>

      <div className="mb-4">
        <div className="flex items-center justify-between mb-1">
          <label className="text-sm text-gray-500">{t('pushRules.bodyTemplate')}</label>
          <div className="flex gap-2 flex-wrap">
            {Object.keys(PRESETS).map(key => (
              <button key={key} onClick={() => applyPreset(key)}
                className={`text-xs px-2 py-1 rounded ${preset === key ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                {t(`pushRules.presets.${key}`)}
              </button>
            ))}
          </div>
        </div>
        <textarea value={form.body_template} onChange={e => update('body_template', e.target.value)}
          className="w-full border rounded px-3 py-2 text-sm font-mono h-32" placeholder={t('pushRules.bodyTemplatePlaceholder')} />
        <div className="text-xs text-gray-400 mt-1">
          {t('pushRules.templateVariables')}: {'{{dev_id}}'}, {'{{device_name}}'}, {'{{device_label}}'}, {'{{event_label}}'}, {'{{type}}'}, {'{{slot}}'}, {'{{phone}}'}, {'{{msIsdn}}'}, {'{{content}}'}, {'{{received_at}}'}, {'{{raw_json}}'}
        </div>
      </div>

      <div className="flex gap-2">
        <button onClick={save} disabled={saving}
          className="bg-green-600 text-white px-4 py-2 rounded text-sm hover:bg-green-700 disabled:opacity-50">
          {saving ? t('common.saving') : (isEdit ? t('common.update') : t('common.create'))}
        </button>
        <button onClick={onClose} className="bg-gray-200 text-gray-700 px-4 py-2 rounded text-sm hover:bg-gray-300">
          {t('common.cancel')}
        </button>
      </div>
    </div>
  );
}
