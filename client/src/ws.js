const listeners = new Set();
let ws = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
let shouldConnect = false;
const MAX_DELAY = 30000;

function getWsUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}`;
}

function connect() {
  if (!shouldConnect) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const url = getWsUrl();
  const socket = new WebSocket(url);
  ws = socket;

  socket.onopen = () => {
    if (!shouldConnect) return socket.close();
    reconnectDelay = 1000;
  };

  socket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      for (const fn of listeners) {
        try { fn(msg); } catch (e) { console.error('WS listener error:', e); }
      }
    } catch (e) {
      console.error('WS parse error:', e);
    }
  };

  socket.onclose = () => {
    if (shouldConnect) scheduleReconnect();
  };

  socket.onerror = () => {
    // onclose will fire after this
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_DELAY);
    connect();
  }, reconnectDelay);
}

export function subscribe(callback) {
  listeners.add(callback);
  shouldConnect = true;
  if (!ws || ws.readyState === WebSocket.CLOSED) {
    connect();
  }
  return () => listeners.delete(callback);
}

export function unsubscribe(callback) {
  listeners.delete(callback);
}
