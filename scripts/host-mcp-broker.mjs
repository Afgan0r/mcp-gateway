#!/usr/bin/env node
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  frameChannel,
  decodeData,
  readPrivateFile,
  validSessionId,
  IDLE_MS,
} from './host-mcp-relay.mjs';

const execute = promisify(execFile);
const safeKeys = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'HOMEDRIVE',
  'HOMEPATH',
];
const allowedServerKeys = new Set(['command', 'args', 'env', 'inheritEnv', 'cwd']);
const dockerWrapperPath = fileURLToPath(new URL('./gateway-docker.mjs', import.meta.url));

function trustedDockerWrapper(item) {
  if (path.basename(item.args[0] ?? '') !== 'gateway-docker.mjs') return false;
  if (
    !path.isAbsolute(item.command) ||
    !path.isAbsolute(item.args[0]) ||
    fs.realpathSync(item.command) !== fs.realpathSync(process.execPath) ||
    fs.realpathSync(item.args[0]) !== fs.realpathSync(dockerWrapperPath)
  ) {
    throw new Error('Untrusted Docker wrapper');
  }
  return true;
}

function configuration() {
  if (process.argv.length !== 4 || process.argv[2] !== '--config')
    throw new Error('Configuration required');
  const config = JSON.parse(readPrivateFile(process.argv[3]));
  if (
    config.schemaVersion !== 1 ||
    !['127.0.0.1', '::1'].includes(config.host) ||
    !Number.isInteger(config.port) ||
    config.port < 1 ||
    config.port > 65535 ||
    typeof config.token !== 'string' ||
    config.token.length < 32 ||
    config.token.length > 512 ||
    !config.servers ||
    Array.isArray(config.servers) ||
    typeof config.servers !== 'object'
  )
    throw new Error('Invalid configuration');
  const servers = new Map();
  for (const [name, item] of Object.entries(config.servers)) {
    if (
      !name ||
      !item ||
      typeof item !== 'object' ||
      Object.keys(item).some((key) => !allowedServerKeys.has(key)) ||
      item.inheritEnv !== false ||
      typeof item.command !== 'string' ||
      !item.command ||
      (item.args !== undefined &&
        (!Array.isArray(item.args) || item.args.some((arg) => typeof arg !== 'string'))) ||
      (item.cwd !== undefined && (typeof item.cwd !== 'string' || !path.isAbsolute(item.cwd))) ||
      (item.env !== undefined &&
        (!item.env || typeof item.env !== 'object' || Array.isArray(item.env)))
    )
      throw new Error('Invalid server configuration');
    for (const [key, value] of Object.entries(item.env ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string')
        throw new Error('Invalid environment');
    }
    servers.set(name, {
      command: item.command,
      args: item.args ?? [],
      cwd: item.cwd,
      env: item.env ?? {},
    });
  }
  return { ...config, servers };
}

function childEnvironment(explicit) {
  const env = Object.fromEntries(
    safeKeys.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]),
  );
  for (const [key, value] of Object.entries(explicit)) {
    env[key] = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, variable) => {
      if (process.env[variable] === undefined) throw new Error('Missing declared environment');
      return process.env[variable];
    });
  }
  return env;
}

function linuxGroup(pid) {
  const result = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
      const fields = stat
        .slice(stat.lastIndexOf(')') + 2)
        .trim()
        .split(/\s+/);
      if (Number(fields[2]) === pid && !['Z', 'X'].includes(fields[0])) result.push(Number(entry));
    } catch (error) {
      if (!['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code)) throw error;
    }
  }
  return result;
}

async function windowsProcesses() {
  const { stdout } = await execute(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress',
    ],
    { timeout: 5000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
  );
  const rows = JSON.parse(stdout);
  return Array.isArray(rows) ? rows : [rows];
}

async function closeWindows(child) {
  const all = await windowsProcesses();
  const owned = new Set([child.pid]);
  let previous;
  do {
    previous = owned.size;
    for (const row of all) if (owned.has(row.ParentProcessId)) owned.add(row.ProcessId);
  } while (previous !== owned.size);
  const identities = all.filter((row) => owned.has(row.ProcessId));
  const surviving = async () =>
    (await windowsProcesses()).filter((row) =>
      identities.some(
        (identity) =>
          identity.ProcessId === row.ProcessId && identity.CreationDate === row.CreationDate,
      ),
    );
  child.stdin.end();
  try {
    await execute('taskkill.exe', ['/PID', String(child.pid), '/T'], {
      timeout: 3000,
      windowsHide: true,
    });
  } catch {
    /* Verify and escalate below. */
  }
  await delay(500);
  for (const row of await surviving()) {
    try {
      await execute('taskkill.exe', ['/PID', String(row.ProcessId), '/T', '/F'], {
        timeout: 3000,
        windowsHide: true,
      });
    } catch {
      /* Verification is authoritative. */
    }
  }
  if ((await surviving()).length) throw new Error('Cleanup failed');
}

async function run() {
  const config = configuration();
  if (!['linux', 'win32'].includes(process.platform)) throw new Error('Unsupported host platform');
  const cleanup =
    process.platform === 'linux'
      ? (await import('../dist/utils/stdioProcessCleanup.js')).closeTrackedStdioProcessTree
      : undefined;
  const sessions = new Set();
  const results = new Map();
  const pruneResults = () => {
    for (const [id, entry] of results) {
      if (entry.settledAt && (Date.now() - entry.settledAt > 600000 || results.size > 2048))
        results.delete(id);
    }
  };
  let shuttingDown = false;
  let failed = false;
  const server = net.createServer((socket) => {
    // Reserve admission capacity for authenticated release/shutdown controls
    // even while all upstream slots are occupied.
    if (shuttingDown || sessions.size >= 256) return socket.destroy();
    socket.setNoDelay(true);
    let authenticated = false;
    let child;
    let childClosed = false;
    let dockerWrapper = false;
    let dockerCleanupAck = false;
    let dockerCleanupOk = false;
    let closing;
    let result;
    let lastFrame = Date.now();
    let exitCode = 0;
    const close = () => {
      if (closing) return closing;
      clearTimeout(handshake);
      clearInterval(heartbeat);
      closing = (async () => {
        try {
          let wrapperVerified = true;
          if (dockerWrapper) {
            // Docker owns a daemon-side container beyond this process tree.
            // Let the trusted wrapper finish exact-CID rm+verification first.
            // Missing ACK, nonzero exit, or forced termination remains failure.
            wrapperVerified = await new Promise((resolve) => {
              const finish = () =>
                resolve(
                  dockerCleanupAck &&
                    dockerCleanupOk &&
                    child?.exitCode === 0 &&
                    !child?.signalCode,
                );
              if (childClosed) return finish();
              const deadline = setTimeout(() => {
                child?.removeListener('close', closed);
                resolve(false);
              }, 11000);
              const closed = () => {
                clearTimeout(deadline);
                finish();
              };
              child?.once('close', closed);
              child?.stdin.end();
            });
          }
          if (child?.pid) {
            if (cleanup) {
              // Capture all process-group members before transport shutdown, so
              // an already-exited wrapper cannot orphan its remaining children.
              const roots = new Set([child.pid, ...linuxGroup(child.pid)]);
              await Promise.all(
                [...roots].map((pid) =>
                  cleanup(
                    pid,
                    () => {
                      if (pid === child.pid) child.stdin.end();
                    },
                    1000,
                  ),
                ),
              );
              if (linuxGroup(child.pid).length) throw new Error('Cleanup failed');
            } else await closeWindows(child);
            // Child exit precedes pipe closure. Drain the final upstream bytes
            // before acknowledging release or a naturally completed process.
            if (!childClosed) {
              await new Promise((resolve, rejectClose) => {
                const deadline = setTimeout(
                  () => rejectClose(new Error('Pipes did not close')),
                  1000,
                );
                child.once('close', () => {
                  clearTimeout(deadline);
                  resolve();
                });
              });
            }
          }
          if (!wrapperVerified) throw new Error('Docker cleanup was not acknowledged');
          send({ op: 'closed', code: exitCode });
          socket.end();
          const drainDeadline = setTimeout(() => socket.destroy(), 1000);
          drainDeadline.unref();
          if (result) result.status = 'cleaned';
          return true;
        } catch {
          failed = true;
          send({ op: 'error', code: 'cleanup_failed' });
          socket.destroy();
          process.stderr.write('Host MCP bridge cleanup failed\n');
          if (result) result.status = 'close_failed';
          return false;
        } finally {
          if (result) result.settledAt = Date.now();
          sessions.delete(close);
        }
      })();
      return closing;
    };
    sessions.add(close);
    const reject = () => {
      socket.destroy();
      void close();
    };
    const send = frameChannel(
      socket,
      (frame) => {
        lastFrame = Date.now();
        if (!authenticated) {
          const expected = Buffer.from(config.token);
          const supplied = Buffer.from(typeof frame.token === 'string' ? frame.token : '');
          if (
            shuttingDown ||
            supplied.length !== expected.length ||
            !timingSafeEqual(supplied, expected) ||
            !['open', 'health', 'releaseSession', 'shutdown'].includes(frame.op) ||
            Object.keys(frame).some((key) => !['op', 'token', 'server', 'sessionId'].includes(key))
          )
            return reject();
          clearTimeout(handshake);
          authenticated = true;
          if (frame.op === 'health') {
            send({ op: 'ready' });
            void close();
            return;
          }
          if (frame.op === 'shutdown') {
            // Exclude this control socket: acknowledge only after every other
            // session has completed its verified teardown.
            sessions.delete(close);
            void shutdown().then(() => {
              send(failed ? { op: 'error', code: 'close_failed' } : { op: 'closed', code: 0 });
              socket.end();
              void close();
            });
            return;
          }
          pruneResults();
          if (!validSessionId(frame.sessionId)) return reject();
          if (frame.op === 'releaseSession') {
            let owned = results.get(frame.sessionId);
            if (!owned) {
              // Release may beat a pending handshake. A cancellation tombstone
              // prevents a late open with this ID from spawning an upstream.
              owned = { close: async () => true, status: 'cancelled', settledAt: Date.now() };
              results.set(frame.sessionId, owned);
            }
            void owned.close().then((ok) => {
              send(ok ? { op: 'closed', code: 0 } : { op: 'error', code: 'close_failed' });
              socket.end();
              void close();
            });
            return;
          }
          if (results.has(frame.sessionId)) return reject();
          if ([...results.values()].filter((entry) => entry.status === 'active').length >= 128)
            return reject();
          const item = config.servers.get(frame.server);
          if (!item) return reject();
          dockerWrapper = trustedDockerWrapper(item);
          result = { close, status: 'active', settledAt: 0 };
          results.set(frame.sessionId, result);
          child = spawn(item.command, item.args, {
            env: childEnvironment(item.env),
            cwd: item.cwd,
            stdio: dockerWrapper ? ['pipe', 'pipe', 'pipe', 'ipc'] : ['pipe', 'pipe', 'pipe'],
            detached: process.platform === 'linux',
            windowsHide: true,
          });
          child.once('close', () => {
            childClosed = true;
          });
          if (dockerWrapper)
            child.on('message', (message) => {
              if (message && message.op === 'dockerCleanup' && typeof message.ok === 'boolean') {
                dockerCleanupAck = true;
                dockerCleanupOk = message.ok;
              }
            });
          child.once('error', () => {
            exitCode = 1;
            void close();
          });
          child.stdin.on('error', () => {
            if (!closing) exitCode = 1;
            void close();
          });
          for (const stream of ['stdout', 'stderr'])
            child[stream].on('data', (chunk) => {
              for (let offset = 0; offset < chunk.length; offset += 64 * 1024) {
                if (
                  !send({
                    op: stream,
                    data: chunk.subarray(offset, offset + 64 * 1024).toString('base64'),
                  })
                ) {
                  child[stream].pause();
                  socket.once('drain', () => child[stream].resume());
                }
              }
            });
          child.once('exit', (code, signal) => {
            if (!closing) exitCode = signal ? 1 : (code ?? 1);
            void close();
          });
          child.once('spawn', () => {
            if (!closing) send({ op: 'ready' });
          });
        } else if (!closing && frame.op === 'stdin' && child) {
          if (!child.stdin.write(decodeData(frame.data))) {
            socket.pause();
            child.stdin.once('drain', () => socket.resume());
          }
        } else if (frame.op === 'ping') send({ op: 'pong' });
        else if (frame.op === 'release') void close();
        else reject();
      },
      reject,
    );
    const handshake = setTimeout(reject, 5000);
    const heartbeat = setInterval(() => {
      if (Date.now() - lastFrame > IDLE_MS) reject();
    }, 5000);
    socket.on('error', () => {
      void close();
    });
    socket.once('close', () => {
      void close();
    });
  });
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close();
    await Promise.all([...sessions].map((close) => close()));
    process.exitCode = failed ? 1 : 0;
  };
  process.on('SIGTERM', () => {
    void shutdown();
  });
  process.on('SIGINT', () => {
    void shutdown();
  });
  server.on('error', () => {
    failed = true;
    void shutdown();
  });
  server.listen(config.port, config.host, () => process.stdout.write('Host MCP broker ready\n'));
}

run().catch(() => {
  process.stderr.write('Host MCP broker failed\n');
  process.exitCode = 1;
});
