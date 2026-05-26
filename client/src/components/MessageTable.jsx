import { useState } from 'react';
import { getDeviceDisplayParts } from '../utils/device-label';

const typeLabels = {
  100: 'WiFi Connected',
  101: 'SIM1 Online',
  102: 'SIM2 Online',
  202: 'SIM Registered',
  203: 'SIM IMSI',
  204: 'SIM Ready',
  205: 'SIM Ejected',
  209: 'SIM Error',
  301: 'Modem Error',
  401: 'Cmd Ack',
  402: 'Cmd Done',
  501: 'New SMS',
  502: 'SMS Sent',
  601: 'Incoming Ring',
  602: 'Incoming Answer',
  603: 'Incoming Hangup',
  620: 'Dial Out',
  621: 'Out Ring',
  622: 'Out Answer',
  623: 'Out Hangup',
  641: 'Local DTMF',
  642: 'Remote DTMF',
  998: 'PING',
  999: 'Command',
};

const typeColors = {
  100: 'bg-blue-100 text-blue-800',
  101: 'bg-blue-100 text-blue-800',
  102: 'bg-blue-100 text-blue-800',
  501: 'bg-green-100 text-green-800',
  502: 'bg-green-100 text-green-800',
  601: 'bg-yellow-100 text-yellow-800',
  602: 'bg-yellow-100 text-yellow-800',
  603: 'bg-yellow-100 text-yellow-800',
  620: 'bg-orange-100 text-orange-800',
  621: 'bg-orange-100 text-orange-800',
  622: 'bg-orange-100 text-orange-800',
  623: 'bg-orange-100 text-orange-800',
  998: 'bg-gray-100 text-gray-600',
  999: 'bg-purple-100 text-purple-800',
};

function formatTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts * 1000);
  return d.toLocaleString();
}

export default function MessageTable({ messages = [], showDevice = true, deviceNameFirst = false }) {
  const [expanded, setExpanded] = useState(null);

  if (messages.length === 0) {
    return <div className="text-gray-500 text-center py-8">No messages</div>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-gray-600 text-left">
          <tr>
            <th className="px-3 py-2 font-medium">Time</th>
            {showDevice && <th className="px-3 py-2 font-medium">Device</th>}
            <th className="px-3 py-2 font-medium">Type</th>
            <th className="px-3 py-2 font-medium">Slot</th>
            <th className="px-3 py-2 font-medium">Phone</th>
            <th className="px-3 py-2 font-medium">Content</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {messages.map((msg) => {
            const deviceDisplay = getDeviceDisplayParts(msg, { preferName: deviceNameFirst });
            return (
              <tr
                key={msg.id}
                className="hover:bg-gray-50 cursor-pointer"
                onClick={() => setExpanded(expanded === msg.id ? null : msg.id)}
              >
                <td className="px-3 py-2 whitespace-nowrap text-gray-600">
                  {formatTime(msg.received_at)}
                </td>
                {showDevice && (
                  <td className="px-3 py-2">
                    <div className="text-sm text-gray-800">{deviceDisplay.primary}</div>
                    {deviceDisplay.secondary && (
                      <div className="font-mono text-xs text-gray-400">{deviceDisplay.secondary}</div>
                    )}
                  </td>
                )}
                <td className="px-3 py-2">
                  <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${typeColors[msg.type] || 'bg-gray-100 text-gray-800'}`}>
                    {msg.type} {typeLabels[msg.type] || ''}
                  </span>
                </td>
                <td className="px-3 py-2">{msg.slot || '-'}</td>
                <td className="px-3 py-2 font-mono">{msg.phone || '-'}</td>
                <td className="px-3 py-2 max-w-xs truncate" title={msg.content}>
                  {msg.content || '-'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* Expanded JSON view */}
      {expanded && (
        <div className="p-4 bg-gray-800 text-green-400 text-xs font-mono overflow-auto max-h-64">
          <pre>{JSON.stringify(messages.find(m => m.id === expanded), null, 2)}</pre>
        </div>
      )}
    </div>
  );
}
