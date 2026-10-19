// Run with: pnpm exec tsx scripts/probe-codex-identity.mjs
// Runs real gateway handlers with a counter fixture or an isolated Playwright pilot.
import 'reflect-metadata';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

process.umask(0o077);
const repository = fileURLToPath(new URL('../', import.meta.url));
const stateRoot =
  process.platform === 'win32'
    ? process.env.LOCALAPPDATA
    : process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
if (!stateRoot || !path.isAbsolute(stateRoot))
  throw new Error('An absolute local state root is required');
const parent = path.join(stateRoot, 'mcp-gateway', 'identity-probes');
fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
if (process.argv.includes('--restore-check')) {
  const restoredSettings = process.argv[process.argv.indexOf('--restore-check') + 1];
  assert.ok(restoredSettings && path.dirname(restoredSettings).startsWith(parent + path.sep));
  assert.equal(path.basename(restoredSettings), 'settings.json');
  const restoredDirectory = path.dirname(restoredSettings);
  const savedLocator = JSON.parse(
    fs.readFileSync(path.join(restoredDirectory, 'locator.json'), 'utf8'),
  );
  assert.equal(savedLocator.schema, 'mcphub-identity-probe/v1');
  assert.equal(savedLocator.prototype, true);
  for (const file of savedLocator.files)
    assert.equal(hashBuffer(fs.readFileSync(file.path)), file.sha256);
  process.chdir(restoredDirectory);
  process.env.MCPHUB_SETTING_PATH = restoredSettings;
  process.env.MCPHUB_CATALOG_DIR = path.join(restoredDirectory, 'catalog');
  process.env.USE_DB = 'false';
  process.env.HUB_MODE = 'local';
  process.env.SMART_ROUTING_ENABLED = 'false';
  const { default: dotenv } = await import('dotenv');
  dotenv.config = () => ({ parsed: {} });
  const { logger } = await import('../src/utils/logger.js');
  logger.log = () => {};
  const service = await import('../src/services/mcpService.js');
  await service.initializeClientsFromSettings(true, 'probe');
  const result = await service.handleListToolsRequest({}, { server: 'probe', group: 'probe' });
  assert.ok(result.tools.some((tool) => tool.name === 'probe_identity'));
  assert.equal(
    fs.readFileSync(`/proc/${process.pid}/task/${process.pid}/children`, 'utf8').trim(),
    '',
  );
  await service.cleanupAllServers();
  process.stdout.write(JSON.stringify({ restored: true, upstreamChildren: 0 }) + '\n');
  process.exit(0);
}
function hashBuffer(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
const directory = fs.mkdtempSync(path.join(parent, 'run-'));
const logicalId = `codex-identity-${randomUUID()}`;
const revisionResult = spawnSync('git', ['rev-parse', 'HEAD'], {
  cwd: repository,
  encoding: 'utf8',
});
assert.equal(revisionResult.status, 0);
const baseRevision = revisionResult.stdout.trim();
const token = randomBytes(32).toString('hex');
const settingsPath = path.join(directory, 'settings.json');
const observationsPath = path.join(directory, 'observations.jsonl');
const clientPath = path.join(directory, 'client.toml');
const locatorPath = path.join(directory, 'locator.json');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const fingerprint = (value) => (typeof value === 'string' && value ? hash(value) : null);
const writePrivate = (target, text) => fs.writeFileSync(target, text, { mode: 0o600 });
const pilotArgument = process.argv.indexOf('--playwright-cli');
const playwrightCli = pilotArgument >= 0 ? process.argv[pilotArgument + 1] : undefined;
const playwrightPilot = playwrightCli !== undefined;
if (playwrightPilot) {
  assert.ok(path.isAbsolute(playwrightCli) && fs.statSync(playwrightCli).isFile());
  assert.ok(!process.argv.includes('--self-test'), 'Use the external Desktop pilot validator');
}
const registrationName = playwrightPilot ? 'gateway_playwright_pilot' : 'gateway_identity_probe';
const prototype = process.argv.includes('--prototype') || playwrightPilot;
const prototypeSelfTest = prototype && process.argv.includes('--self-test');
const fixture = path.join(repository, 'tests', 'fixtures', 'session-identity-server.mjs');
const pilotDirectories = Object.fromEntries(
  ['tmp', 'cache', 'config', 'output'].map((name) => {
    // Chrome can fail to launch under deeply nested temporary paths. Keep the
    // active private profile durable without nesting it under the evidence tree.
    const shortTemporary = playwrightPilot && name === 'tmp' && process.platform === 'linux';
    const target = shortTemporary
      ? fs.mkdtempSync(path.join(os.homedir(), '.cache', 'mcpgw-'))
      : path.join(directory, name);
    if (playwrightPilot && !shortTemporary) fs.mkdirSync(target, { mode: 0o700 });
    return [name, target];
  }),
);
const browserArgument = process.argv.indexOf('--browser-executable');
const browserExecutable = browserArgument >= 0 ? process.argv[browserArgument + 1] : undefined;
const definition = {
  type: 'stdio',
  command: process.execPath,
  args: playwrightPilot
    ? [
        playwrightCli,
        '--isolated',
        '--headless',
        '--sandbox',
        '--idle-timeout',
        '0',
        '--no-webmcp',
        '--output-dir',
        pilotDirectories.output,
        ...(browserExecutable ? ['--executable-path', browserExecutable] : []),
      ]
    : [fixture],
  ...(playwrightPilot
    ? {
        env: {
          TMPDIR: pilotDirectories.tmp,
          TMP: pilotDirectories.tmp,
          TEMP: pilotDirectories.tmp,
          XDG_CONFIG_HOME: pilotDirectories.config,
          XDG_CACHE_HOME: pilotDirectories.cache,
        },
      }
    : {}),
};

writePrivate(
  settingsPath,
  JSON.stringify(
    {
      mcpServers: {
        probe: {
          ...definition,
          startOnDemand: true,
          perSessionClient: true,
          idleTimeoutMs: 15 * 60 * 1000,
          ...(prototype ? { catalogMode: 'persistent', retentionPolicy: 'explicit' } : {}),
        },
        ...(prototype && !playwrightPilot
          ? {
              idle_probe: {
                ...definition,
                catalogMode: 'persistent',
                retentionPolicy: 'idle',
                idleTimeoutMs: prototypeSelfTest ? 400 : 15 * 60 * 1000,
              },
            }
          : {}),
      },
      users: [],
      groups: [],
      bearerKeys: [
        {
          id: 'identity-probe',
          name: 'identity-probe',
          token,
          kind: 'system',
          enabled: true,
          accessType: 'all',
          createdAt: new Date().toISOString(),
        },
      ],
      systemConfig: {
        routing: { enableGlobalRoute: true, enableGroupNameRoute: true, enableBearerAuth: true },
        oauthServer: { enabled: false },
        smartRouting: { enabled: false },
      },
    },
    null,
    2,
  ),
);
writePrivate(observationsPath, '');
let status = 'starting';
let endpoint;
let selfTestResult = null;
const behaviorPath = path.join(directory, 'behavior.json');
const sourceDirectory = path.join(directory, 'sources');
fs.mkdirSync(sourceDirectory, { mode: 0o700 });
const sourceFiles = [
  'scripts/probe-codex-identity.mjs',
  'tests/fixtures/session-identity-server.mjs',
  'src/services/mcpService.ts',
  'src/services/sseService.ts',
  'src/services/serverCatalogService.ts',
  'src/services/runtimeOwnerService.ts',
  'src/utils/stdioProcessCleanup.ts',
].map((file) => {
  const content = fs.readFileSync(path.join(repository, file));
  const retainedPath = path.join(sourceDirectory, file);
  fs.mkdirSync(path.dirname(retainedPath), { recursive: true, mode: 0o700 });
  writePrivate(retainedPath, content);
  return { path: file, retainedPath, sha256: hash(content) };
});
const snapshot = () => {
  const catalogDirectory = path.join(directory, 'catalog');
  const catalogFiles = fs.existsSync(catalogDirectory)
    ? fs
        .readdirSync(catalogDirectory, { recursive: true })
        .map((name) => path.join(catalogDirectory, name))
        .filter((file) => fs.statSync(file).isFile())
    : [];
  const files = [settingsPath, observationsPath, clientPath, behaviorPath, ...catalogFiles].filter(
    (file) => fs.existsSync(file),
  );
  const locator = {
    schema: 'mcphub-identity-probe/v1',
    logicalId,
    status,
    pid: process.pid,
    endpoint,
    source: {
      repository,
      baseRevision,
      validationMode: 'retained-source-snapshots',
      files: sourceFiles,
    },
    selfTestResult,
    prototype,
    playwrightPilot,
    ...(playwrightPilot ? { pilotDirectories } : {}),
    registrationName,
    ...(playwrightPilot
      ? {
          playwright: {
            cli: playwrightCli,
            cliSha256: hash(fs.readFileSync(playwrightCli)),
            packageVersion: JSON.parse(
              fs.readFileSync(path.join(path.dirname(playwrightCli), 'package.json'), 'utf8'),
            ).version,
            browserExecutable,
          },
        }
      : {}),
    credentialBinding: `mcp_servers.${registrationName}.http_headers.Authorization`,
    updatedAt: new Date().toISOString(),
    files: files.map((file) => ({ path: file, sha256: hash(fs.readFileSync(file)) })),
  };
  writePrivate(locatorPath, JSON.stringify(locator, null, 2));
  // Verify retained bytes on every checkpoint, including after startup and stop.
  for (const file of locator.files) {
    if (hash(fs.readFileSync(file.path)) !== file.sha256)
      throw new Error('Probe artifact digest mismatch');
  }
  for (const file of sourceFiles) {
    if (hash(fs.readFileSync(file.retainedPath)) !== file.sha256)
      throw new Error('Retained source digest mismatch');
  }
};

const prototypeTest = async () => {
  const modern = await import('@modelcontextprotocol/client');
  const { Client: LegacyClient } = await import('@modelcontextprotocol/sdk-v1/client/index.js');
  const { StreamableHTTPClientTransport: LegacyTransport } = await import(
    '@modelcontextprotocol/sdk-v1/client/streamableHttp.js'
  );
  const clients = [];
  const clientTransports = new Map();
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const alive = (pid) => {
    try {
      return !/\) [ZX] /.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
    } catch {
      return false;
    }
  };
  const fixturePids = () =>
    fs
      .readdirSync('/proc')
      .filter((name) => /^\d+$/.test(name))
      .map(Number)
      .filter((pid) => {
        try {
          const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
          const parentPid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
          return (
            parentPid === process.pid &&
            fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').includes(fixture) &&
            alive(pid)
          );
        } catch {
          return false;
        }
      });
  const pss = (pid) => {
    const match = fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8').match(/^Pss:\s+(\d+) kB$/m);
    assert.ok(match, `Missing PSS for PID ${pid}`);
    return Number(match[1]);
  };
  const until = async (predicate, message) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await wait(30);
    }
    assert.fail(message);
  };
  const makeClient = async (route = 'probe', legacy = true) => {
    const Client = legacy ? LegacyClient : modern.Client;
    const Transport = legacy ? LegacyTransport : modern.StreamableHTTPClientTransport;
    const client = new Client({ name: 'prototype-lifecycle-check', version: '1.0' });
    clients.push(client);
    const transport = new Transport(new URL(endpoint.replace('/mcp/probe', `/mcp/${route}`)), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    clientTransports.set(client, transport);
    await client.connect(transport);
    return client;
  };
  const call = async (client, name, args = {}, meta) => {
    const result = await client.callTool({
      name,
      arguments: args,
      ...(meta ? { _meta: meta } : {}),
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  const inventory = (client, meta) => call(client, 'mcphub_runtime_list', {}, meta);
  const release = (client, owner, meta) =>
    call(client, 'mcphub_runtime_release', { owner_id: owner.ownerId }, meta);
  const report = {
    schema: 'mcphub-prototype-behavior/v1',
    logicalId,
    platform: process.platform,
    checks: [],
    memory: {},
  };
  const checked = (name) => report.checks.push(name);
  try {
    assert.equal(process.platform, 'linux', 'This diagnostic verifies Linux process/PSS evidence');
    assert.equal(
      (
        await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        })
      ).status,
      401,
    );
    const a = await makeClient();
    const b = await makeClient();
    for (const client of [a, b]) {
      assert.ok((await client.listTools()).tools.every((tool) => tool.name.startsWith('mcphub_')));
      assert.deepEqual((await client.listPrompts()).prompts, []);
      assert.deepEqual((await client.listResources()).resources, []);
      assert.deepEqual((await client.listResourceTemplates()).resourceTemplates, []);
    }
    assert.deepEqual(fixturePids(), []);
    checked('cold startup and all four discovery lists spawn no upstream');
    await call(a, 'mcphub_catalog_refresh');
    assert.deepEqual(fixturePids(), []);
    assert.equal((await call(a, 'mcphub_catalog_status'))[0].loaded, true);
    assert.ok((await a.listTools()).tools.some((tool) => tool.name === 'probe_identity'));
    checked('explicit bootstrap persists catalog and closes discovery child');
    const first = await call(a, 'probe_identity', { label: 'prototype_A1' });
    const second = await call(b, 'probe_identity', { label: 'prototype_B1' });
    const again = await call(a, 'probe_identity', { label: 'prototype_A2' });
    assert.notEqual(first.pid, second.pid);
    assert.equal(first.instance, again.instance);
    assert.equal(again.calls, 2);
    assert.equal(fixturePids().length, 2);
    report.memory.twoOwners = {
      upstreamPssKb: pss(first.pid) + pss(second.pid),
      gatewayPssKb: pss(process.pid),
    };
    const ownersA = await inventory(a);
    const ownersB = await inventory(b);
    assert.equal(ownersA.length, 2);
    assert.deepEqual(
      ownersA.map((owner) => owner.ownerId).sort(),
      ownersB.map((owner) => owner.ownerId).sort(),
    );
    // Creation order is observable here: A is the sole owner before B's creation.
    const ownA = ownersA[0];
    await release(a, ownA);
    await until(() => !alive(first.pid), 'Released owner A process survived');
    const afterRelease = await call(b, 'probe_identity', { label: 'prototype_B2' });
    assert.equal(afterRelease.instance, second.instance);
    assert.equal(afterRelease.calls, 2);
    report.memory.oneOwner = { upstreamPssKb: pss(second.pid), gatewayPssKb: pss(process.pid) };
    checked('two transport owners isolate state and selective release preserves the other');
    await clientTransports.get(b).terminateSession();
    await b.close();
    const replacement = await makeClient();
    await until(
      async () => (await inventory(replacement)).some((owner) => owner.detachedAt),
      'Transport close did not detach owner',
    );
    assert.ok(alive(second.pid));
    await release(replacement, (await inventory(replacement))[0]);
    await until(() => !alive(second.pid), 'Detached explicit owner survived explicit release');
    checked('transport detach retains explicit owner for authenticated inventory/release');
    const idle = await makeClient('idle_probe');
    await call(idle, 'mcphub_catalog_refresh');
    const slow = call(idle, 'probe_identity', { label: 'prototype_slow', delayMs: 750 });
    await until(
      async () => (await inventory(idle)).some((owner) => owner.activeOperations === 1),
      'Slow operation never acquired lease',
    );
    const idlePid = fixturePids()[0];
    await wait(500);
    assert.ok(alive(idlePid));
    const slowResult = await slow;
    assert.equal(slowResult.pid, idlePid);
    await until(() => !alive(idlePid), 'Idle process did not stop');
    await until(
      async () => (await inventory(idle)).length === 0,
      'Idle owner did not finish closing',
    );
    const restarted = await call(idle, 'probe_identity', { label: 'prototype_restart' });
    assert.notEqual(restarted.pid, idlePid);
    assert.equal(restarted.calls, 1);
    checked('idle expiry waits for active call and next call creates a fresh process');
    await until(() => !alive(restarted.pid), 'Restarted idle process did not stop');
    await until(
      async () => (await inventory(idle)).length === 0,
      'Restarted idle owner did not finish closing',
    );
    const modernClient = await makeClient('probe', false);
    const meta = { 'openai/session': 'prototype-modern-owner' };
    const modernFirst = await call(
      modernClient,
      'probe_identity',
      { label: 'prototype_modern' },
      meta,
    );
    const slowModern = call(
      modernClient,
      'probe_identity',
      { label: 'prototype_drain', delayMs: 700 },
      meta,
    );
    await until(
      async () =>
        (await inventory(modernClient, meta)).some((owner) => owner.activeOperations === 1),
      'Modern operation never acquired lease',
    );
    const modernOwner = (await inventory(modernClient, meta))[0];
    assert.equal((await release(modernClient, modernOwner, meta))[0].status, 'releasing');
    assert.ok(alive(modernFirst.pid));
    assert.equal((await slowModern).instance, modernFirst.instance);
    await until(() => !alive(modernFirst.pid), 'Drained modern process survived');
    checked('modern application owner release drains active call before closing');
    await cleanupAllServers();
    await initializeClientsFromSettings(true, 'probe');
    assert.equal((await call(a, 'mcphub_catalog_status'))[0].loaded, true);
    assert.ok((await a.listTools()).tools.some((tool) => tool.name === 'probe_identity'));
    assert.deepEqual(fixturePids(), []);
    report.memory.released = { upstreamPssKb: 0, gatewayPssKb: pss(process.pid) };
    checked('catalog reload after runtime cleanup exposes definitions without spawn');
    snapshot();
    const restored = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        path.join(repository, 'scripts/probe-codex-identity.mjs'),
        '--restore-check',
        settingsPath,
      ],
      { cwd: repository, encoding: 'utf8', timeout: 20000 },
    );
    assert.equal(restored.status, 0, restored.stderr + restored.stdout);
    assert.ok(restored.stdout.includes('"restored":true'));
    checked('fresh gateway process restores catalog without an upstream child');
    report.limits = [
      'Fixture PSS only; no heavy production MCP RAM benchmark',
      'No Windows runtime validation',
      'No automatic reattachment after client transport recreation',
    ];
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    writePrivate(behaviorPath, JSON.stringify(report, null, 2));
    snapshot();
  }
};
snapshot();
process.on('exit', () => {
  if (status !== 'stopped' && status !== 'stop-timeout')
    status = process.exitCode ? 'failed' : 'exited';
  snapshot();
});

// Avoid the repository's .env and all existing runtime settings. Only this
// process receives these overrides; no user Codex configuration is edited.
process.chdir(directory);
process.env.MCPHUB_SETTING_PATH = settingsPath;
process.env.USE_DB = 'false';
process.env.HUB_MODE = 'local';
process.env.SMART_ROUTING_ENABLED = 'false';
process.env.MCPHUB_CATALOG_DIR = path.join(directory, 'catalog');

// Disable dotenv inside this isolated diagnostic process before importing any
// application module. No .env path (including the repository's) is opened.
const { default: dotenv } = await import('dotenv');
dotenv.config = () => ({ parsed: {} });

const { default: express } = await import('express');
const { logger } = await import('../src/utils/logger.js');
// Gateway request logs include raw _meta. Keep only the allowlisted, hashed
// observations below instead of retaining a second copy of client metadata.
logger.log = () => {};
const { sseUserContextMiddleware } = await import('../src/middlewares/userContext.js');
const { initializeClientsFromSettings, cleanupAllServers, closeServer } = await import(
  '../src/services/mcpService.js'
);
const { handleMcpPostRequest, handleMcpOtherRequest, transports, closeModernMcpHandler } =
  await import('../src/services/sseService.js');
// A targeted load waits for the fixture catalog instead of racing the first
// client's discovery against MCPHub's normal background startup priming.
await initializeClientsFromSettings(true, 'probe');

const app = express();
app.use(express.json({ limit: '32kb' }));
app.get('/health', (_req, res) => res.json({ logicalId, status }));
if (playwrightPilot) {
  app.get('/pilot', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res
      .type('html')
      .send(
        '<!doctype html><html><head><title>MCP gateway isolation pilot</title></head><body><h1>Isolated browser state</h1><p id="owner">unset</p><button id="counter" onclick="this.textContent=String(Number(this.textContent)+1)">0</button><script>window.__pilotPageInstance=crypto.randomUUID();</script></body></html>',
      );
  });
  app.get('/favicon.ico', (_req, res) => res.status(204).end());
}
app.use(
  '/mcp/:group',
  (req, res, next) => {
    if (req.body?.method === 'tools/call') {
      const meta = req.body.params?._meta;
      const label = req.body.params?.arguments?.label;
      const observation = {
        timestamp: new Date().toISOString(),
        protocol: req.headers['mcp-protocol-version'] ?? null,
        tool: typeof req.body.params?.name === 'string' ? req.body.params.name : null,
        label: typeof label === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(label) ? label : null,
        openaiSession: fingerprint(meta?.['openai/session']),
        explicitState: fingerprint(req.headers['x-mcphub-state-id']),
        transportSession: fingerprint(req.headers['mcp-session-id']),
      };
      res.on('finish', () => {
        fs.appendFileSync(
          observationsPath,
          JSON.stringify({ ...observation, httpStatus: res.statusCode }) + '\n',
        );
        snapshot();
      });
    }
    next();
  },
  sseUserContextMiddleware,
);
app.post('/mcp/:group', handleMcpPostRequest);
app.get('/mcp/:group', handleMcpOtherRequest);
app.delete('/mcp/:group', handleMcpOtherRequest);

const httpServer = app.listen(0, '127.0.0.1', async () => {
  endpoint = `http://127.0.0.1:${httpServer.address().port}/mcp/probe`;
  // A fragment for explicit opt-in test registration, never auto-installed.
  writePrivate(
    clientPath,
    [
      `[mcp_servers.${registrationName}]`,
      `url = ${JSON.stringify(endpoint)}`,
      `http_headers = { Authorization = "Bearer ${token}" }`,
      'startup_timeout_sec = 30',
      'tool_timeout_sec = 30',
      '',
    ].join('\n'),
  );
  status = 'ready';
  snapshot();
  process.stdout.write(JSON.stringify({ logicalId, endpoint, locatorPath, clientPath }) + '\n');
  if (process.argv.includes('--self-test')) {
    try {
      if (prototype) await prototypeTest();
      else await selfTest();
      selfTestResult = 'passed';
      process.stdout.write(JSON.stringify({ selfTest: 'passed', logicalId }) + '\n');
    } catch (error) {
      selfTestResult = 'failed';
      console.error(error);
      process.exitCode = 1;
    } finally {
      await stop();
    }
  }
});

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  status = 'stopping';
  snapshot();
  const deadline = setTimeout(() => {
    status = 'stop-timeout';
    snapshot();
    process.exit(1);
  }, 5000);
  deadline.unref();
  await closeModernMcpHandler();
  for (const entry of Object.values(transports)) await entry.transport.close();
  // Cancel the runtime's idle timer before cleanupAllServers clears the pool.
  await closeServer('probe');
  await closeServer('idle_probe');
  await cleanupAllServers();
  if (playwrightPilot) fs.rmSync(pilotDirectories.tmp, { recursive: true, force: true });
  httpServer.closeAllConnections();
  await new Promise((resolve) => httpServer.close(resolve));
  status = 'stopped';
  snapshot();
  clearTimeout(deadline);
};
process.on('SIGINT', () => {
  void stop();
});
process.on('SIGTERM', () => {
  void stop();
});

// Synthetic client checks validate the diagnostic only. They do not establish
// whether real Codex Desktop/CLI calls supply a stable conversation identity.
const selfTest = async () => {
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const clients = [];
  const toolNames = new Map();
  const call = async (client, owner, label) => {
    const result = await client.callTool({
      name: toolNames.get(client),
      arguments: { label },
      _meta: { 'openai/session': owner },
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  try {
    assert.equal(
      (
        await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        })
      ).status,
      401,
    );
    for (let index = 0; index < 2; index++) {
      const client = new Client({ name: 'synthetic-check', version: '1.0' });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(endpoint), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }),
      );
      const listed = (await client.listTools()).tools.map((tool) => tool.name);
      assert.equal(listed.length, 1, JSON.stringify({ listed }));
      assert.match(listed[0], /(^|-)probe_identity$/);
      toolNames.set(client, listed[0]);
    }
    const first = await call(clients[0], 'synthetic-owner-A', 'synthetic-A1');
    const second = await call(clients[1], 'synthetic-owner-B', 'synthetic-B1');
    const again = await call(clients[0], 'synthetic-owner-A', 'synthetic-A2');
    assert.notEqual(first.instance, second.instance);
    assert.notEqual(first.pid, second.pid);
    assert.equal(first.instance, again.instance);
    assert.equal(first.calls, 1);
    assert.equal(second.calls, 1);
    assert.equal(again.calls, 2);
    const observations = fs
      .readFileSync(observationsPath, 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse);
    assert.equal(observations.length, 3);
    assert.equal(observations[0].openaiSession, observations[2].openaiSession);
    assert.notEqual(observations[0].openaiSession, observations[1].openaiSession);
    assert.ok(!fs.readFileSync(observationsPath, 'utf8').includes('synthetic-owner-'));
  } finally {
    await Promise.all(clients.map((client) => client.close()));
  }
};
