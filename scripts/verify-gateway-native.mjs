// Real native smoke test. Settings and upstreams are generated, never copied.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const runtime = path.resolve(process.argv[2]);
assert.equal(process.platform, 'win32');
assert.equal(process.arch, 'x64');
assert.equal(process.version, 'v24.16.0');
assert.equal(path.resolve(process.execPath), path.join(runtime, 'node.exe'));
const fixture = path.dirname(runtime);
const manifest = JSON.parse(fs.readFileSync(path.join(runtime, 'runtime-manifest.json'), 'utf8'));
assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.platform, 'win32');
assert.equal(manifest.arch, 'x64');
assert.equal(manifest.nodeVersion, process.version);
assert.match(manifest.sourceRevision, /^[a-f0-9]{40}$/);
assert.equal(typeof manifest.sourceDirty, 'boolean');
const actual = {};
function walk(directory) {
  for (const name of fs.readdirSync(directory)) {
    const filename = path.join(directory, name);
    const stat = fs.lstatSync(filename);
    assert(!stat.isSymbolicLink(), 'Runtime must not contain symlinks or junctions');
    if (stat.isDirectory()) walk(filename);
    else {
      const relative = path.relative(runtime, filename).split(path.sep).join('/');
      if (relative !== 'runtime-manifest.json')
        actual[relative] = createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
    }
  }
}
walk(runtime);
assert.deepEqual(actual, manifest.files, 'Manifest must cover exactly every payload file');
for (const relative of [
  'node.exe',
  'package.json',
  'scripts/local-gateway.mjs',
  'scripts/gateway-docker.mjs',
  'dist/services/mcpService.js',
  'locales/en.json',
])
  assert(Object.hasOwn(actual, relative));
assert(!fs.existsSync(path.join(runtime, 'frontend')), 'Dashboard is excluded');
assert(!fs.existsSync(path.join(runtime, 'mcp_settings.json')), 'Deployment settings are excluded');
const require = createRequire(path.join(runtime, 'package.json'));
const { Client, StreamableHTTPClientTransport } = await import(
  pathToFileURL(require.resolve('@modelcontextprotocol/client')).href
);
const sockets = new Set();
const clients = [];
let gateway;
let proxy;
let output = '';
const tokens = Object.fromEntries(
  ['system', 'alice', 'bob'].map((name) => [name, randomBytes(32).toString('hex')]),
);
async function listen(server) {
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}
const upstreamScript = path.join(fixture, 'upstream.mjs');
const pidDirectory = path.join(fixture, 'pids');
fs.mkdirSync(pidDirectory);
const pidFiles = () => fs.readdirSync(pidDirectory).map((name) => path.join(pidDirectory, name));
const running = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
fs.writeFileSync(
  upstreamScript,
  `
import fs from 'node:fs';
import readline from 'node:readline';
const [pidDirectory]=process.argv.slice(2);
fs.writeFileSync(pidDirectory+'/'+process.pid+'.pid',String(process.pid));
let state=null;
readline.createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line); if(request.id===undefined)return;
 let result;
 if(request.method==='initialize')result={protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'native-fixture',version:'1'}};
 else if(request.method==='tools/list')result={tools:[{name:'echo',description:'Deterministic native owner state fixture',inputSchema:{type:'object',properties:{value:{type:'string'}}}}]};
 else if(request.method==='tools/call'){if(request.params.arguments.value!==undefined)state=request.params.arguments.value;result={content:[{type:'text',text:JSON.stringify({pid:process.pid,value:state})}]};}
 else result={};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
});
process.stdin.on('end',()=>process.exit(0));
`,
  { mode: 0o600 },
);
const settingsPath = path.join(fixture, 'settings.json');
fs.writeFileSync(
  settingsPath,
  JSON.stringify({
    mcpServers: {
      owned: {
        type: 'stdio',
        command: process.execPath,
        args: [upstreamScript, pidDirectory],
        enabled: true,
        owner: 'gateway-local',
        visibility: 'private',
        inheritEnv: false,
        catalogMode: 'persistent',
        retentionPolicy: 'explicit',
      },
    },
    users: ['alice', 'bob'].map((username) => ({
      username,
      password: 'unused-synthetic-fixture',
      isAdmin: false,
    })),
    groups: [],
    bearerKeys: Object.entries(tokens).map(([owner, token]) => ({
      id: owner,
      name: owner,
      token,
      enabled: true,
      kind: owner === 'system' ? 'system' : 'user',
      ...(owner === 'system' ? {} : { owner }),
      accessType: 'all',
    })),
    systemConfig: { routing: { enableBearerAuth: true } },
  }),
  { mode: 0o600 },
);
try {
  let proxyUrl = process.env.GATEWAY_SMOKE_PROXY || 'http://127.0.0.1:8118';
  if (process.argv.includes('--direct-egress')) {
    // GitHub's Windows runner has no personal proxy. This test-owned CONNECT
    // proxy permits only the real, non-secret country probe, never OpenAI.
    proxy = http.createServer((_req, res) => res.writeHead(403).end());
    proxy.on('connect', (req, client, head) => {
      if (req.url !== 'api.country.is:443') return client.destroy();
      const upstream = net.connect(443, 'api.country.is', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        client.pipe(upstream).pipe(client);
      });
      sockets.add(upstream);
      upstream.once('close', () => sockets.delete(upstream));
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
      client.on('close', () => upstream.destroy());
    });
    proxyUrl = `http://127.0.0.1:${await listen(proxy)}`;
  }
  const reservation = net.createServer();
  const port = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  const env = {
    ...process.env,
    PATH: `${runtime};${process.env.SystemRoot}\\System32`,
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(port),
    MCPHUB_SETTING_PATH: settingsPath,
    HTTPS_PROXY: proxyUrl,
    https_proxy: proxyUrl,
    NODE_PATH: '',
    NODE_OPTIONS: '',
  };
  gateway = spawn(process.execPath, [path.join(runtime, 'scripts/local-gateway.mjs')], {
    cwd: fixture,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  gateway.stdout.on('data', (chunk) => {
    output = (output + chunk).slice(-12000);
  });
  gateway.stderr.on('data', (chunk) => {
    output = (output + chunk).slice(-12000);
  });
  const deadline = Date.now() + 60000;
  let health;
  while (Date.now() < deadline) {
    if (gateway.exitCode !== null) throw new Error('Native gateway exited during startup');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        health = await response.json();
        break;
      }
    } catch {
      /* Poll the real listener until startup completes. */
    }
    await delay(200);
  }
  assert.equal(health?.status, 'ready', 'Gateway must become ready');
  assert.match(health.egressCountry, /^[A-Z]{2}$/);
  assert.equal(health.servers.length, 1);
  assert.equal(pidFiles().length, 0, 'Persistent catalog must not spawn during startup');
  async function request(route, token, body) {
    return fetch(`http://127.0.0.1:${port}${route}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10000),
    });
  }
  const initialize = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'native-smoke', version: '1' },
    },
  };
  assert.equal((await request('/mcp/owned', null, initialize)).status, 401);
  assert.equal((await request('/mcp/owned', 'wrong-fixture-key', initialize)).status, 401);
  for (const owner of ['A', 'B']) {
    const client = new Client({ name: `native-smoke-${owner}`, version: '1' });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/owned`), {
        requestInit: {
          headers: { authorization: `Bearer ${tokens.system}`, 'x-mcphub-state-id': randomUUID() },
        },
      }),
    );
  }
  const control = async (client, name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, `Native lifecycle operation failed: ${name}`);
    return JSON.parse(result.content[0].text);
  };
  const initialTools = (await clients[0].listTools()).tools.map((tool) => tool.name);
  assert(initialTools.includes('mcphub_catalog_refresh'));
  assert(!initialTools.includes('echo'), 'Empty persistent catalog must not invent tools');
  await control(clients[0], 'mcphub_catalog_refresh');
  assert(pidFiles().length > 0, 'Catalog refresh must launch real deterministic upstream');
  for (const file of pidFiles())
    assert(
      !running(Number(fs.readFileSync(file, 'utf8'))),
      'Temporary discovery process must close',
    );
  for (const client of clients)
    assert((await client.listTools()).tools.some((tool) => tool.name === 'echo'));
  const first = await control(clients[0], 'echo', { value: 'owner-A' });
  const second = await control(clients[1], 'echo');
  assert.notEqual(first.pid, second.pid, 'Same-key clients need distinct retained upstream owners');
  assert.equal(first.value, 'owner-A');
  assert.equal(second.value, null, 'Owner A state must not leak to owner B');
  assert.equal((await control(clients[1], 'echo', { value: 'owner-B' })).value, 'owner-B');
  assert.equal((await control(clients[0], 'echo')).value, 'owner-A');
  const released = await control(clients[0], 'mcphub_runtime_release');
  assert(
    released.some((entry) => entry.status === 'released'),
    'Owner A release must complete',
  );
  assert(!running(first.pid), 'Releasing A must stop its owned process');
  await clients[0].close();
  const surviving = await control(clients[1], 'echo');
  assert.equal(surviving.pid, second.pid, 'Releasing or closing A must preserve B process');
  assert.equal(surviving.value, 'owner-B');
  for (const token of [null, 'wrong-fixture-key', tokens.alice])
    assert.equal((await request('/_gateway/shutdown', token)).status, 401);
  for (const client of clients) await client.close();
  assert.equal((await request('/_gateway/shutdown', tokens.system)).status, 202);
  await Promise.race([
    once(gateway, 'close'),
    delay(30000, undefined, { ref: false }).then(() => {
      throw new Error('Authenticated shutdown timed out');
    }),
  ]);
  assert.equal(gateway.exitCode, 0, 'Gateway must shut down cleanly');
  for (const pidfile of pidFiles()) {
    const pid = Number(fs.readFileSync(pidfile, 'utf8'));
    assert(!running(pid), 'Owned upstream process must terminate with gateway');
  }
  console.log(
    JSON.stringify({
      status: 'passed',
      files: Object.keys(actual).length,
      sourceRevision: manifest.sourceRevision,
      sourceDirty: manifest.sourceDirty,
      checks: [
        'manifest-exact-hashes',
        'no-links',
        'bundled-node',
        'real-guarded-egress',
        'authentication',
        'stdio-list-call',
        'persistent-catalog-refresh',
        'owner-isolation',
        'owner-release-preserves-other-owner',
        'authenticated-shutdown',
        'owned-child-cleanup',
      ],
    }),
  );
} catch (error) {
  // Fixture tokens are generated, but keep output secret-free by design.
  const sanitized = Object.values(tokens).reduce(
    (value, token) => value.replaceAll(token, '[redacted]'),
    output,
  );
  if (sanitized) process.stderr.write(sanitized + '\n');
  throw error;
} finally {
  for (const client of clients) await client.close().catch(() => {});
  if (gateway && gateway.exitCode === null) gateway.kill();
  for (const pidfile of pidFiles()) {
    if (!fs.existsSync(pidfile)) continue;
    const pid = Number(fs.readFileSync(pidfile, 'utf8'));
    if (!running(pid)) continue;
    if (Number.isInteger(pid) && pid > 0) {
      // A PID alone is not an ownership proof after a failed startup. Verify
      // the exact unique fixture and bundled executable before killing it.
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '$p = Get-CimInstance Win32_Process -Filter "ProcessId=$env:GATEWAY_FIXTURE_PID"; if ($p -and $p.ExecutablePath -eq $env:GATEWAY_FIXTURE_NODE -and $p.CommandLine.Contains($env:GATEWAY_FIXTURE_SCRIPT)) { Stop-Process -Id $p.ProcessId -Force }',
        ],
        {
          env: {
            ...process.env,
            GATEWAY_FIXTURE_PID: String(pid),
            GATEWAY_FIXTURE_NODE: process.execPath,
            GATEWAY_FIXTURE_SCRIPT: upstreamScript,
          },
          timeout: 10000,
          windowsHide: true,
          stdio: 'ignore',
        },
      );
    }
  }
  for (const socket of sockets) socket.destroy();
  proxy?.close();
}
