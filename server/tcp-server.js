const net = require('net');
const { now } = require('./utils');
const { recordInterfaceLog } = require('./interface-log');
const { enqueueMessage } = require('./message-queue');
const logger = require('./logger');

const DELIMITER = Buffer.from([0x11, 0x12]);
const MAX_TCP_BUFFER_BYTES = Math.max(1024, Number(process.env.TCP_MAX_BUFFER_BYTES || 1024 * 1024));

function createTcpServer(port = 3888) {
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    const remoteAddr = socket.remoteAddress + ':' + socket.remotePort;

    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      if (buffer.length > MAX_TCP_BUFFER_BYTES) {
        logger.error('tcp', 'TCP frame buffer limit exceeded', {
          remoteAddr, bytes: buffer.length, limit: MAX_TCP_BUFFER_BYTES
        });
        socket.destroy();
        return;
      }

      // Split messages on 0x11 0x12 delimiter
      let pos;
      while ((pos = buffer.indexOf(DELIMITER)) !== -1) {
        const messageBuf = buffer.slice(0, pos);
        buffer = buffer.slice(pos + 2); // skip 2-byte delimiter

        if (messageBuf.length === 0) continue;

        try {
          const jsonStr = messageBuf.toString('utf8');
          const msg = JSON.parse(jsonStr);

          try {
            enqueueMessage(msg, { transport: 'tcp', remoteAddr });
          } catch (err) {
            recordInterfaceLog({
              dev_id: msg.devId || '', protocol: 'tcp', direction: 'in', endpoint: `tcp:${port}`,
              method: 'SEND', status: 'failed', request_summary: `type=${msg.type || ''} devId=${msg.devId || ''}`,
              response_summary: `queue rejected: ${err.message}`, request_raw: msg, response_raw: '', remote_addr: remoteAddr
            });
            logger.error('tcp', 'Message was not accepted by the persistent queue', {
              error: err.message, remoteAddr, devId: msg.devId || ''
            });
            socket.destroy();
            break;
          }

          // Check if this is message type 100 (first WiFi connected) - respond with time sync
          if (Number(msg.type) === 100) {
            // Build time sync response
            const ts = new Date();
            const y = String(ts.getFullYear()).padStart(4, '0');
            const M = String(ts.getMonth() + 1).padStart(2, '0');
            const d = String(ts.getDate()).padStart(2, '0');
            const h = String(ts.getHours()).padStart(2, '0');
            const m = String(ts.getMinutes()).padStart(2, '0');
            const s = String(ts.getSeconds()).padStart(2, '0');
            const timeStr = `${y}${M}${d}${h}${m}${s}`;
            const response = JSON.stringify({
              cmd: 'now',
              p1: timeStr,
              tid: String(now())
            });

            recordInterfaceLog({
              dev_id: msg.devId || '',
              protocol: 'tcp',
              direction: 'in',
              endpoint: `tcp:${port}`,
              method: 'SEND',
              status: 'ok',
              request_summary: `type=${msg.type} devId=${msg.devId || ''}`,
              response_summary: `timeSync=${timeStr}`,
              request_raw: msg,
              response_raw: response,
              remote_addr: remoteAddr
            });

            // Per spec: "建议延迟100ms以上再发送应答"
            setTimeout(() => {
              if (!socket.destroyed) {
                socket.write(Buffer.concat([
                  Buffer.from(response, 'utf8'),
                  DELIMITER
                ]));
              }
            }, 150);
          } else {
            recordInterfaceLog({
              dev_id: msg.devId || '',
              protocol: 'tcp',
              direction: 'in',
              endpoint: `tcp:${port}`,
              method: 'SEND',
              status: 'ok',
              request_summary: `type=${msg.type || ''} devId=${msg.devId || ''}`,
              response_summary: 'ok',
              request_raw: msg,
              response_raw: '',
              remote_addr: remoteAddr
            });
          }
        } catch (err) {
          logger.warn('tcp', 'TCP frame was not valid JSON', {
            remoteAddr, error: err.message
          });
        }
      }
    });

    socket.on('error', (err) => {
      if (err.code !== 'ECONNRESET') {
        logger.warn('tcp', 'TCP socket error', {
          remoteAddr, error: err.message, code: err.code
        });
      }
    });

    socket.on('close', () => {
      buffer = Buffer.alloc(0);
    });
  });

  server.on('error', (err) => {
    logger.error('tcp', 'TCP server error', { error: err.message, code: err.code });
  });

  server.listen(port, () => {
    logger.info('tcp', 'TCP server listening', { port });
  });

  return server;
}

module.exports = { createTcpServer };
