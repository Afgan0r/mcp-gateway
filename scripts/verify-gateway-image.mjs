// Exercise the actual image entrypoint using generated settings and a local TLS
// CONNECT proxy. No deployment settings, credentials, or external APIs are used.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const image = process.argv[2];
if (!image) throw new Error('Usage: node scripts/verify-gateway-image.mjs IMAGE');
if (process.platform !== 'linux')
  throw new Error('Image smoke test requires Linux host networking');
execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 10000 });

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-image-smoke-'));
const name = `gateway-image-smoke-${process.pid}`;
const sockets = new Set();
let container;
let proxy;
let responder;
let output = '';
let probes = 0;

async function listen(server) {
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

try {
  fs.writeFileSync(
    path.join(temporary, 'settings.json'),
    JSON.stringify({
      mcpServers: {},
      users: [],
      groups: [],
      bearerKeys: [{ id: 'smoke', token: 'generated-smoke-token', enabled: true, kind: 'system' }],
      systemConfig: { routing: { enableBearerAuth: true } },
    }),
    { mode: 0o600 },
  );
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=api.country.is',
      '-addext',
      'subjectAltName=DNS:api.country.is',
      '-keyout',
      path.join(temporary, 'key.pem'),
      '-out',
      path.join(temporary, 'cert.pem'),
    ],
    { stdio: 'ignore', timeout: 10000 },
  );

  const artifactCheck = `
    const fs = await import('node:fs');
    for (const name of ['local-gateway.mjs', 'host-mcp-broker.mjs', 'host-mcp-relay.mjs', 'gateway-docker.mjs'])
      fs.accessSync('/app/scripts/' + name);
    fs.accessSync('/app/dist/utils/stdioProcessCleanup.js');
    if (fs.existsSync('/app/mcp_settings.json') || fs.existsSync('/app/frontend'))
      throw new Error('Unexpected deployment settings or dashboard in gateway image');
    if (process.getuid() === 0) throw new Error('Image defaults to root');
    await import('/app/dist/clients/mcpSdkClient.js');
  `;
  execFileSync(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      'none',
      '--entrypoint',
      'node',
      image,
      '--input-type=module',
      '-e',
      artifactCheck,
    ],
    { timeout: 20000, stdio: 'pipe' },
  );

  responder = https.createServer(
    {
      key: fs.readFileSync(path.join(temporary, 'key.pem')),
      cert: fs.readFileSync(path.join(temporary, 'cert.pem')),
    },
    (req, res) => {
      assert.equal(req.headers.host, 'api.country.is');
      probes++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ country: 'US' }));
    },
  );
  const responderPort = await listen(responder);
  proxy = http.createServer((_req, res) => res.writeHead(403).end());
  proxy.on('connect', (req, client, head) => {
    if (req.url !== 'api.country.is:443') return client.destroy();
    const upstream = net.connect(responderPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    client.on('close', () => upstream.destroy());
  });
  const proxyPort = await listen(proxy);
  const reservation = net.createServer();
  const port = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  const args = [
    'run',
    '--rm',
    '--name',
    name,
    '--network',
    'host',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=16m',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--user',
    `${process.getuid()}:${process.getgid()}`,
    '--mount',
    `type=bind,src=${temporary},dst=/runtime`,
    '-e',
    'MCPHUB_SETTING_PATH=/runtime/settings.json',
    '-e',
    `PORT=${port}`,
  ];
  const rejected = spawn('docker', [...args, '-e', 'HTTPS_PROXY=', '-e', 'https_proxy=', image], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let rejectedOutput = '';
  rejected.stdout.on('data', (chunk) => {
    rejectedOutput += chunk;
  });
  rejected.stderr.on('data', (chunk) => {
    rejectedOutput += chunk;
  });
  const rejectTimer = setTimeout(() => rejected.kill('SIGKILL'), 20000);
  const [rejectedCode] = await once(rejected, 'close');
  clearTimeout(rejectTimer);
  assert.notEqual(rejectedCode, 0, 'Gateway must reject a missing guarded proxy');
  assert.match(rejectedOutput, /requires the guarded AI proxy/);

  container = spawn(
    'docker',
    [
      ...args,
      '-e',
      `HTTPS_PROXY=http://127.0.0.1:${proxyPort}`,
      '-e',
      'NODE_EXTRA_CA_CERTS=/runtime/cert.pem',
      image,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  container.stdout.on('data', (chunk) => {
    output = (output + chunk).slice(-12000);
  });
  container.stderr.on('data', (chunk) => {
    output = (output + chunk).slice(-12000);
  });
  const deadline = Date.now() + 45000;
  let health;
  while (Date.now() < deadline) {
    if (container.exitCode !== null) throw new Error(`Gateway exited: ${output}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        health = await response.json();
        break;
      }
    } catch {
      /* Wait for the entrypoint to finish initialization. */
    }
    await delay(200);
  }
  assert.deepEqual(health, { status: 'ready', servers: [], egressCountry: 'US' }, output);
  assert.equal(probes, 1, 'Startup must use the guarded egress probe');
  const unknown = await fetch(`http://127.0.0.1:${port}/mcp/unknown`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(unknown.status, 404);
  execFileSync('docker', ['stop', '--time', '30', name], { timeout: 35000, stdio: 'pipe' });
  if (container.exitCode === null) await once(container, 'close');
  assert.equal(container.exitCode, 0, output);
  console.log(
    'Gateway image smoke passed: artifacts, non-root, guarded startup, health, shutdown.',
  );
} finally {
  try {
    execFileSync('docker', ['rm', '--force', name], { timeout: 10000, stdio: 'ignore' });
  } catch {
    /* --rm may already have removed the container. */
  }
  for (const socket of sockets) socket.destroy();
  proxy?.close();
  responder?.close();
  fs.rmSync(temporary, { recursive: true, force: true });
}
