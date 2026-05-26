import { useState } from 'react';
import { api } from '../api';
import { useLang } from '../i18n.jsx';

export default function CommandPanel({ device, onResult, isCallActive = false }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [smsSlot, setSmsSlot] = useState(1);
  const [smsPhone, setSmsPhone] = useState('');
  const [smsContent, setSmsContent] = useState('');
  const [callSlot, setCallSlot] = useState(1);
  const [callPhone, setCallPhone] = useState('');
  const [callDuration, setCallDuration] = useState('');
  const [callTTS, setCallTTS] = useState('');
  const [customCmd, setCustomCmd] = useState('');
  const [customParams, setCustomParams] = useState('');
  // Recording state
  const [recSlot, setRecSlot] = useState(1);
  const [recDuration, setRecDuration] = useState(15);
  const [recFilename, setRecFilename] = useState('');
  const [recUpload, setRecUpload] = useState(true);
  const [stopRecSlot, setStopRecSlot] = useState(1);
  const [stopRecUpload, setStopRecUpload] = useState(true);
  const [uploadFilename, setUploadFilename] = useState('');
  const { t } = useLang();

  async function runQuick(cmd) {
    setLoading(true);
    setResult(null);
    try {
      const res = await api.quickCommand(device.dev_id, cmd);
      setResult(res);
      if (onResult) onResult(res);
    } catch (err) {
      setResult({ error: err.message });
    }
    setLoading(false);
  }

  async function sendSMS() {
    if (!smsPhone || !smsContent) return;
    setLoading(true);
    setResult(null);
    try {
      const tid = String(Date.now());
      const res = await api.sendCommand(device.dev_id, 'sendsms', {
        p1: smsSlot, p2: smsPhone, p3: smsContent, tid
      });
      setResult(res);
      if (onResult) onResult(res);
    } catch (err) {
      setResult({ error: err.message });
    }
    setLoading(false);
  }

  async function dialCall() {
    if (!callPhone) return;
    setLoading(true);
    setResult(null);
    try {
      const params = { p1: callSlot, p2: callPhone };
      if (callDuration) params.p3 = Number(callDuration);
      if (callTTS) params.p4 = callTTS;
      const res = await api.sendCommand(device.dev_id, 'teldial', params);
      setResult(res);
      if (onResult) onResult(res);
    } catch (err) {
      setResult({ error: err.message });
    }
    setLoading(false);
  }

  async function sendCustom() {
    if (!customCmd) return;
    setLoading(true);
    setResult(null);
    try {
      const params = {};
      if (customParams) {
        customParams.split('&').forEach(pair => {
          const [key, val] = pair.split('=');
          if (key && val !== undefined) params[key.trim()] = val.trim();
        });
      }
      const res = await api.sendCommand(device.dev_id, customCmd, params);
      setResult(res);
      if (onResult) onResult(res);
    } catch (err) {
      setResult({ error: err.message });
    }
    setLoading(false);
  }

  async function startRecording() {
    setLoading(true);
    setResult(null);
    try {
      const params = { p1: recSlot, p2: recDuration, p4: recUpload ? 1 : 0 };
      if (recFilename) params.p3 = recFilename;
      const res = await api.sendCommand(device.dev_id, 'telstartrecord', params);
      setResult(res);
      if (onResult) onResult(res);
    } catch (err) {
      setResult({ error: err.message });
    }
    setLoading(false);
  }

  async function stopRecording() {
    setLoading(true);
    setResult(null);
    try {
      const res = await api.sendCommand(device.dev_id, 'telstoprecord', {
        p1: stopRecSlot, p2: stopRecUpload ? 1 : 0
      });
      setResult(res);
      if (onResult) onResult(res);
    } catch (err) {
      setResult({ error: err.message });
    }
    setLoading(false);
  }

  async function uploadRecording() {
    if (!uploadFilename) return;
    setLoading(true);
    setResult(null);
    try {
      const res = await api.sendCommand(device.dev_id, 'telrecordupload', { p1: uploadFilename });
      setResult(res);
      if (onResult) onResult(res);
    } catch (err) {
      setResult({ error: err.message });
    }
    setLoading(false);
  }

  const btnClass = "px-3 py-1.5 text-sm rounded font-medium transition-colors disabled:opacity-50";
  const primaryBtn = btnClass + " bg-blue-600 text-white hover:bg-blue-700";
  const dangerBtn = btnClass + " bg-red-600 text-white hover:bg-red-700";

  return (
    <div className="space-y-6">
      {/* Quick commands */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 mb-2">{t('deviceDetail.quickCommands')}</h3>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => runQuick('stat')} disabled={loading} className={primaryBtn}>{t('deviceDetail.stat')}</button>
          <button onClick={() => runQuick('ping')} disabled={loading} className={primaryBtn}>{t('deviceDetail.ping')}</button>
          <button onClick={() => runQuick('restart')} disabled={loading} className={dangerBtn}>{t('deviceDetail.restart')}</button>
          <button onClick={() => runQuick('factreset')} disabled={loading} className={dangerBtn}>{t('deviceDetail.factreset')}</button>
        </div>
      </div>

      {/* Send SMS */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 mb-2">{t('deviceDetail.sendSMS')}</h3>
        <div className="flex flex-wrap gap-2 items-end">
          <div>
            <label className="text-xs text-gray-500">{t('deviceDetail.smsSlot')}</label>
            <select value={smsSlot} onChange={e => setSmsSlot(Number(e.target.value))}
              className="block border rounded px-2 py-1 text-sm">
              <option value={1}>{t('common.slot')} 1</option>
              <option value={2}>{t('common.slot')} 2</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-500">{t('common.phone')}</label>
            <input type="text" value={smsPhone} onChange={e => setSmsPhone(e.target.value)}
              placeholder={t('deviceDetail.smsPhonePlaceholder')} className="block border rounded px-2 py-1 text-sm w-36" />
          </div>
          <div className="flex-1">
            <label className="text-xs text-gray-500">{t('common.content')}</label>
            <input type="text" value={smsContent} onChange={e => setSmsContent(e.target.value)}
              placeholder={t('deviceDetail.smsContentPlaceholder')} className="block border rounded px-2 py-1 text-sm w-full" />
          </div>
          <button onClick={sendSMS} disabled={loading || !smsPhone || !smsContent} className={primaryBtn}>
            {t('common.send')}
          </button>
        </div>
      </div>

      {/* Dial Call */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 mb-2">{t('deviceDetail.dialCall')}</h3>
        <div className="flex flex-wrap gap-2 items-end">
          <div>
            <label className="text-xs text-gray-500">{t('deviceDetail.callSlot')}</label>
            <select value={callSlot} onChange={e => setCallSlot(Number(e.target.value))}
              className="block border rounded px-2 py-1 text-sm">
              <option value={1}>{t('common.slot')} 1</option>
              <option value={2}>{t('common.slot')} 2</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-500">{t('common.phone')}</label>
            <input type="text" value={callPhone} onChange={e => setCallPhone(e.target.value)}
              placeholder={t('deviceDetail.callPhonePlaceholder')} className="block border rounded px-2 py-1 text-sm w-36" />
          </div>
          <div>
            <label className="text-xs text-gray-500">{t('deviceDetail.callDuration')}</label>
            <input type="number" value={callDuration} onChange={e => setCallDuration(e.target.value)}
              placeholder={t('deviceDetail.callDurationPlaceholder')} className="block border rounded px-2 py-1 text-sm w-20" />
          </div>
          <div className="flex-1">
            <label className="text-xs text-gray-500">{t('deviceDetail.callTTS')}</label>
            <input type="text" value={callTTS} onChange={e => setCallTTS(e.target.value)}
              placeholder={t('deviceDetail.callTTSPlaceholder')} className="block border rounded px-2 py-1 text-sm w-full" />
          </div>
          <button onClick={dialCall} disabled={loading || !callPhone} className={primaryBtn}>
            {t('deviceDetail.dial')}
          </button>
        </div>
      </div>

      {isCallActive ? (
        <>
          {/* Start Recording */}
          <div>
            <h3 className="text-sm font-semibold text-gray-700 mb-2">{t('deviceDetail.startRecording')}</h3>
            <div className="flex flex-wrap gap-2 items-end">
              <div>
                <label className="text-xs text-gray-500">{t('deviceDetail.recSlot')}</label>
                <select value={recSlot} onChange={e => setRecSlot(Number(e.target.value))}
                  className="block border rounded px-2 py-1 text-sm">
                  <option value={1}>{t('common.slot')} 1</option>
                  <option value={2}>{t('common.slot')} 2</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-500">{t('deviceDetail.recDuration')}</label>
                <input type="number" min={1} max={60} value={recDuration}
                  onChange={e => setRecDuration(Number(e.target.value))}
                  className="block border rounded px-2 py-1 text-sm w-20" />
              </div>
              <div className="flex-1">
                <label className="text-xs text-gray-500">{t('deviceDetail.filename')} ({t('common.optional')})</label>
                <input type="text" value={recFilename} onChange={e => setRecFilename(e.target.value)}
                  placeholder={t('deviceDetail.recFilenamePlaceholder')} className="block border rounded px-2 py-1 text-sm w-full" />
              </div>
              <label className="flex items-center gap-1 text-sm text-gray-600">
                <input type="checkbox" checked={recUpload} onChange={e => setRecUpload(e.target.checked)} />
                {t('deviceDetail.recUpload')}
              </label>
              <button onClick={startRecording} disabled={loading} className={primaryBtn}>
                {t('deviceDetail.startRecording')}
              </button>
            </div>
          </div>

          {/* Stop Recording */}
          <div>
            <h3 className="text-sm font-semibold text-gray-700 mb-2">{t('deviceDetail.stopRecording')}</h3>
            <div className="flex flex-wrap gap-2 items-end">
              <div>
                <label className="text-xs text-gray-500">{t('deviceDetail.stopRecSlot')}</label>
                <select value={stopRecSlot} onChange={e => setStopRecSlot(Number(e.target.value))}
                  className="block border rounded px-2 py-1 text-sm">
                  <option value={1}>{t('common.slot')} 1</option>
                  <option value={2}>{t('common.slot')} 2</option>
                </select>
              </div>
              <label className="flex items-center gap-1 text-sm text-gray-600">
                <input type="checkbox" checked={stopRecUpload} onChange={e => setStopRecUpload(e.target.checked)} />
                {t('deviceDetail.stopRecAutoUpload')}
              </label>
              <button onClick={stopRecording} disabled={loading} className={dangerBtn}>
                {t('deviceDetail.stopRecording')}
              </button>
            </div>
          </div>

          {/* Upload Recording */}
          <div>
            <h3 className="text-sm font-semibold text-gray-700 mb-2">{t('deviceDetail.uploadRecording')}</h3>
            <div className="flex flex-wrap gap-2 items-end">
              <div className="flex-1">
                <label className="text-xs text-gray-500">{t('deviceDetail.filename')}</label>
                <input type="text" value={uploadFilename} onChange={e => setUploadFilename(e.target.value)}
                  placeholder={t('deviceDetail.uploadFilenamePlaceholder')} className="block border rounded px-2 py-1 text-sm w-full" />
              </div>
              <button onClick={uploadRecording} disabled={loading || !uploadFilename} className={primaryBtn}>
                {t('deviceDetail.upload')}
              </button>
            </div>
          </div>
        </>
      ) : (
        <div className="text-sm text-gray-500 bg-gray-50 border border-gray-200 rounded p-3">
          Call recording controls are shown only during an active call.
        </div>
      )}

      {/* Custom Command */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 mb-2">{t('deviceDetail.customCommand')}</h3>
        <div className="flex flex-wrap gap-2 items-end">
          <div>
            <label className="text-xs text-gray-500">{t('deviceDetail.command')}</label>
            <input type="text" value={customCmd} onChange={e => setCustomCmd(e.target.value)}
              placeholder={t('deviceDetail.commandPlaceholder')} className="block border rounded px-2 py-1 text-sm w-32" />
          </div>
          <div className="flex-1">
            <label className="text-xs text-gray-500">{t('deviceDetail.parameters')}</label>
            <input type="text" value={customParams} onChange={e => setCustomParams(e.target.value)}
              placeholder={t('deviceDetail.parametersPlaceholder')} className="block border rounded px-2 py-1 text-sm w-full" />
          </div>
          <button onClick={sendCustom} disabled={loading || !customCmd} className={primaryBtn}>
            {t('common.send')}
          </button>
        </div>
      </div>

      {/* Result */}
      {result && (
        <div className={`p-3 rounded text-sm font-mono ${result.error ? 'bg-red-50 text-red-800' : 'bg-green-50 text-green-800'}`}>
          <pre className="whitespace-pre-wrap overflow-auto max-h-48">{JSON.stringify(result, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}
