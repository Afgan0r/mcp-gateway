#!/usr/bin/env node
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export const MAX_FRAME = 1024 * 1024;
export const HEARTBEAT_MS = 5000;
export const IDLE_MS = 20000;
export const validSessionId = (value) =>
  typeof value === 'string' &&
  /^(?:[a-f0-9]{16,64}|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/i.test(value);

// Shared by the native broker and the standalone container relay. Traffic is
// opaque bytes: neither side parses, logs, or rewrites MCP messages.
export function frameChannel(socket, receive, fail) {
  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    try {
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (!length || length > MAX_FRAME) throw new Error('Invalid frame');
        if (buffer.length < length + 4) break;
        const frame = JSON.parse(buffer.subarray(4, length + 4).toString('utf8'));
        buffer = buffer.subarray(length + 4);
        if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
          throw new Error('Invalid frame');
        }
        receive(frame);
      }
    } catch {
      fail();
    }
  });
  return (frame) => {
    if (socket.destroyed || socket.writableEnded) return false;
    const payload = Buffer.from(JSON.stringify(frame));
    if (payload.length > MAX_FRAME || socket.writableLength > 4 * MAX_FRAME) {
      fail();
      return false;
    }
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length);
    return socket.write(Buffer.concat([header, payload]));
  };
}

export function decodeData(value) {
  if (
    typeof value !== 'string' ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error('Invalid data');
  }
  return Buffer.from(value, 'base64');
}

export function readPrivateFile(filename) {
  if (!filename || !path.isAbsolute(filename)) throw new Error('Private file required');
  const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const info = fs.fstatSync(descriptor);
    if (
      !info.isFile() ||
      info.size > MAX_FRAME ||
      (process.platform !== 'win32' && info.mode & 0o077)
    ) {
      throw new Error('Unsafe private file');
    }
    return fs.readFileSync(descriptor, 'utf8');
  } finally {
    fs.closeSync(descriptor);
  }
}

async function runRelay() {
  const args = process.argv.slice(2);
  const health = args.length === 1 && args[0] === '--health';
  const releaseControl = args.length === 2 && args[0] === '--release-session';
  const shutdownControl = args.length === 1 && args[0] === '--shutdown';
  const control = releaseControl || shutdownControl;
  if (!health && !control && (args.length !== 2 || args[0] !== '--server' || !args[1])) {
    throw new Error('Invalid bridge command');
  }
  const sessionId = releaseControl
    ? args[1]
    : (process.env.MCP_GATEWAY_BRIDGE_SESSION_ID ?? randomUUID());
  if (!health && !shutdownControl && !validSessionId(sessionId))
    throw new Error('Invalid bridge session');
  const token = readPrivateFile(process.env.MCP_GATEWAY_BRIDGE_TOKEN_FILE).trim();
  if (token.length < 32 || token.length > 512) throw new Error('Invalid bridge token');
  const host = process.env.MCP_GATEWAY_BRIDGE_HOST ?? '127.0.0.1';
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('Loopback host required');
  const port = Number(process.env.MCP_GATEWAY_BRIDGE_PORT ?? '19766');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid bridge port');
  const socket = net.createConnection({ host, port });
  let ready = false;
  let releasing = false;
  let complete = false;
  let failed = false;
  let lastFrame = Date.now();
  let releaseTimer;
  const finish = (code) => {
    if (complete) return;
    complete = true;
    clearInterval(heartbeat);
    clearTimeout(handshake);
    clearTimeout(releaseTimer);
    process.stdin.pause();
    process.stdin.removeListener('data', input);
    process.stdin.removeListener('end', release);
    process.removeListener('SIGTERM', release);
    process.removeListener('SIGINT', release);
    process.exitCode = code;
    socket.destroy();
  };
  const fail = () => {
    if (failed || complete) return;
    failed = true;
    process.stderr.write('Host MCP bridge failed\n');
    finish(1);
  };
  const send = frameChannel(
    socket,
    (frame) => {
      lastFrame = Date.now();
      if (frame.op === 'ready' && !ready && !control) {
        ready = true;
        clearTimeout(handshake);
        if (health) {
          process.stdout.write('{"ok":true}\n');
          finish(0);
        } else if (releasing) {
          send({ op: 'release' });
        } else {
          process.stdin.on('data', input);
          process.stdin.resume();
        }
      } else if (frame.op === 'stdout' || frame.op === 'stderr') {
        if (!ready || health || control) return fail();
        const stream = frame.op === 'stdout' ? process.stdout : process.stderr;
        if (!stream.write(decodeData(frame.data))) {
          socket.pause();
          stream.once('drain', () => socket.resume());
        }
      } else if (frame.op === 'closed') {
        clearTimeout(handshake);
        finish(
          Number.isInteger(frame.code) && frame.code >= 0 && frame.code <= 255 ? frame.code : 1,
        );
      } else if (frame.op !== 'pong') {
        fail();
      }
    },
    fail,
  );
  function input(chunk) {
    for (let offset = 0; offset < chunk.length; offset += 64 * 1024) {
      if (
        !send({ op: 'stdin', data: chunk.subarray(offset, offset + 64 * 1024).toString('base64') })
      ) {
        process.stdin.pause();
        socket.once('drain', () => {
          if (!releasing) process.stdin.resume();
        });
      }
    }
  }
  function release() {
    if (releasing || complete) return;
    if (control || health) return;
    releasing = true;
    process.stdin.pause();
    if (ready) send({ op: 'release' });
    releaseTimer = setTimeout(fail, 12000);
  }
  const handshake = setTimeout(fail, control ? 12000 : 5000);
  const heartbeat = setInterval(() => {
    if (Date.now() - lastFrame > IDLE_MS) fail();
    else if (ready && !health && !control) send({ op: 'ping' });
  }, HEARTBEAT_MS);
  socket.once('connect', () =>
    send({
      op: health
        ? 'health'
        : shutdownControl
          ? 'shutdown'
          : releaseControl
            ? 'releaseSession'
            : 'open',
      token,
      ...(health || shutdownControl ? {} : { sessionId, ...(control ? {} : { server: args[1] }) }),
    }),
  );
  socket.on('error', fail);
  socket.once('close', () => {
    if (!complete) fail();
  });
  process.stdin.on('end', release);
  process.stdout.on('error', release);
  process.on('SIGTERM', release);
  process.on('SIGINT', release);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runRelay().catch(() => {
    process.stderr.write('Host MCP bridge failed\n');
    process.exitCode = 1;
  });
}
