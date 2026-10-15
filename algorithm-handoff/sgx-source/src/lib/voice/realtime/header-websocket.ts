import crypto from 'crypto';
import tls from 'tls';

type WebSocketOpcode = 0x0 | 0x1 | 0x2 | 0x8 | 0x9 | 0xa;

const WEBSOCKET_ACCEPT_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_SERVER_FRAME_BYTES = 8 * 1024 * 1024;

interface HeaderWebSocketOptions {
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  onMessage?: (data: Buffer, opcode: WebSocketOpcode) => void;
  onClose?: () => void;
  onError?: (error: Error) => void;
}

export interface HeaderWebSocketConnection {
  send(data: Buffer | string, opcode?: WebSocketOpcode): void;
  close(): void;
  connected: boolean;
}

function encodeClientFrame(data: Buffer, opcode: WebSocketOpcode = 0x2): Buffer {
  const payloadLength = data.length;
  const lengthBytes = payloadLength < 126 ? 0 : payloadLength <= 0xffff ? 2 : 8;
  const headerLength = 2 + lengthBytes + 4;
  const frame = Buffer.alloc(headerLength + payloadLength);

  frame[0] = 0x80 | opcode;
  if (payloadLength < 126) {
    frame[1] = 0x80 | payloadLength;
  } else if (payloadLength <= 0xffff) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(payloadLength, 2);
  } else {
    frame[1] = 0x80 | 127;
    frame.writeBigUInt64BE(BigInt(payloadLength), 2);
  }

  const maskOffset = 2 + lengthBytes;
  const payloadOffset = maskOffset + 4;
  const mask = crypto.randomBytes(4);
  mask.copy(frame, maskOffset);

  for (let index = 0; index < payloadLength; index += 1) {
    frame[payloadOffset + index] = data[index] ^ mask[index % 4];
  }

  return frame;
}

function tryReadServerFrame(buffer: Buffer): { frame?: { opcode: WebSocketOpcode; payload: Buffer }; rest: Buffer } {
  if (buffer.length < 2) return { rest: buffer };

  const fin = Boolean(buffer[0] & 0x80);
  const opcode = (buffer[0] & 0x0f) as WebSocketOpcode;
  if (!fin || opcode === 0x0) {
    throw new Error('Realtime provider continuation frames are not supported');
  }
  const masked = Boolean(buffer[1] & 0x80);
  let payloadLength = buffer[1] & 0x7f;
  let offset = 2;

  if (payloadLength === 126) {
    if (buffer.length < offset + 2) return { rest: buffer };
    payloadLength = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (payloadLength === 127) {
    if (buffer.length < offset + 8) return { rest: buffer };
    const longLength = buffer.readBigUInt64BE(offset);
    if (longLength > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('WebSocket frame is too large');
    }
    payloadLength = Number(longLength);
    offset += 8;
  }

  if (payloadLength > MAX_SERVER_FRAME_BYTES) {
    throw new Error('Realtime provider WebSocket frame exceeds maximum size');
  }

  let mask: Buffer | undefined;
  if (masked) {
    if (buffer.length < offset + 4) return { rest: buffer };
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + payloadLength) return { rest: buffer };

  const payload = Buffer.from(buffer.subarray(offset, offset + payloadLength));
  if (mask) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = payload[index] ^ mask[index % 4];
    }
  }

  return {
    frame: { opcode, payload },
    rest: buffer.subarray(offset + payloadLength),
  };
}

function expectedAcceptKey(websocketKey: string): string {
  return crypto
    .createHash('sha1')
    .update(`${websocketKey}${WEBSOCKET_ACCEPT_GUID}`)
    .digest('base64');
}

function parseHandshakeHeaders(headerText: string): { statusLine: string; headers: Record<string, string> } {
  const [statusLine = '', ...lines] = headerText.split('\r\n');
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }
  return { statusLine, headers };
}

export async function connectHeaderWebSocket(options: HeaderWebSocketOptions): Promise<HeaderWebSocketConnection> {
  if (options.signal?.aborted) {
    throw new DOMException('WebSocket connection aborted', 'AbortError');
  }
  const target = new URL(options.url);
  if (target.protocol !== 'wss:') {
    throw new Error('Only wss:// realtime provider endpoints are supported');
  }

  const websocketKey = crypto.randomBytes(16).toString('base64');
  const port = target.port ? Number(target.port) : 443;
  const requestPath = `${target.pathname || '/'}${target.search || ''}`;
  const handshakeHeaders = [
    `GET ${requestPath} HTTP/1.1`,
    `Host: ${target.host}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${websocketKey}`,
    'Sec-WebSocket-Version: 13',
    ...Object.entries(options.headers).map(([key, value]) => `${key}: ${value}`),
    '',
    '',
  ].join('\r\n');

  return new Promise((resolve, reject) => {
    let settled = false;
    let connected = false;
    let handshakeBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let frameBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);

    const socket = tls.connect({
      host: target.hostname,
      port,
      servername: target.hostname,
    });

    const abortFromCaller = () => {
      socket.destroy();
      if (!settled) {
        settled = true;
        reject(new DOMException('WebSocket connection aborted', 'AbortError'));
      }
    };
    options.signal?.addEventListener('abort', abortFromCaller, { once: true });

    const timeout = setTimeout(() => {
      socket.destroy();
      if (!settled) {
        settled = true;
        reject(new Error('Realtime provider WebSocket handshake timed out'));
      }
    }, options.timeoutMs);

    const connection: HeaderWebSocketConnection = {
      get connected() {
        return connected && !socket.destroyed;
      },
      send(data: Buffer | string, opcode: WebSocketOpcode = Buffer.isBuffer(data) ? 0x2 : 0x1) {
        if (!this.connected) {
          throw new Error('Realtime provider WebSocket is not connected');
        }
        socket.write(encodeClientFrame(Buffer.isBuffer(data) ? data : Buffer.from(data), opcode));
      },
      close() {
        if (!socket.destroyed) {
          try {
            socket.write(encodeClientFrame(Buffer.alloc(0), 0x8));
          } finally {
            socket.end();
          }
        }
      },
    };

    socket.on('secureConnect', () => {
      socket.write(handshakeHeaders);
    });

    socket.on('data', chunk => {
      try {
        if (!connected) {
          handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
          const marker = handshakeBuffer.indexOf('\r\n\r\n');
          if (marker === -1) return;

          const headerText = handshakeBuffer.subarray(0, marker).toString('utf8');
          const { statusLine, headers } = parseHandshakeHeaders(headerText);
          if (!statusLine.includes(' 101 ')) {
            throw new Error(`Realtime provider handshake failed: ${statusLine}`);
          }
          if (headers['sec-websocket-accept'] !== expectedAcceptKey(websocketKey)) {
            throw new Error('Realtime provider handshake failed: invalid Sec-WebSocket-Accept');
          }

          connected = true;
          clearTimeout(timeout);
          frameBuffer = handshakeBuffer.subarray(marker + 4);
          handshakeBuffer = Buffer.alloc(0);
          if (!settled) {
            settled = true;
            resolve(connection);
          }
        } else {
          frameBuffer = Buffer.concat([frameBuffer, chunk]);
        }

        while (frameBuffer.length > 0) {
          const { frame, rest } = tryReadServerFrame(frameBuffer);
          if (!frame) break;
          frameBuffer = rest;
          if (frame.opcode === 0x8) {
            connection.close();
            return;
          }
          if (frame.opcode === 0x9) {
            socket.write(encodeClientFrame(frame.payload, 0xa));
            continue;
          }
          options.onMessage?.(frame.payload, frame.opcode);
        }
      } catch (error) {
        socket.destroy();
        options.onError?.(error instanceof Error ? error : new Error(String(error)));
        if (!settled) {
          settled = true;
          reject(error);
        }
      }
    });

    socket.on('error', error => {
      clearTimeout(timeout);
      options.onError?.(error);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });

    socket.on('close', () => {
      clearTimeout(timeout);
      connected = false;
      options.signal?.removeEventListener('abort', abortFromCaller);
      options.onClose?.();
    });
  });
}
