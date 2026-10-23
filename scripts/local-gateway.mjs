// Minimal authenticated loopback deployment of the MCPHub MCP handlers.
import 'reflect-metadata';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';

process.umask(0o077);
const settingsPath = process.env.MCPHUB_SETTING_PATH;
if (!settingsPath || !path.isAbsolute(settingsPath))
  throw new Error('MCPHUB_SETTING_PATH must identify private deployment settings');
const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
if (
  !settings.systemConfig?.routing?.enableBearerAuth ||
  !settings.bearerKeys?.some((key) => key.enabled && key.token)
)
  throw new Error('Local gateway requires an enabled bearer credential');
const port = Number(process.env.PORT || 19765);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid gateway port');
if (process.env.HOST && process.env.HOST !== '127.0.0.1')
  throw new Error('Local gateway must bind to IPv4 loopback');
process.chdir(path.dirname(settingsPath));
process.env.USE_DB = 'false';
process.env.HUB_MODE = 'local';
process.env.SMART_ROUTING_ENABLED = 'false';
process.env.INIT_TIMEOUT = '15000';
// Never load the source checkout's .env or a deployment-directory overlay.
const { default: dotenv } = await import('dotenv');
dotenv.config = () => ({ parsed: {} });
// Verify this process's guarded path before contacting any OpenAI upstream.
// Conservative supported-country subset, checked against OpenAI's official list
// on 2026-10-19: https://help.openai.com/en/articles/5347006
const { fetch: guardedFetch, ProxyAgent } = await import('undici');
const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
if (!proxyUrl) throw new Error('Gateway requires the guarded AI proxy launch environment');
const guard = new ProxyAgent(proxyUrl);
let egressCountry;
try {
  const response = await guardedFetch('https://api.country.is/', {
    dispatcher: guard,
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('Egress probe failed');
  egressCountry = (await response.json()).country;
  const supported = new Set([
    'US',
    'CA',
    'GB',
    'DE',
    'FR',
    'NL',
    'FI',
    'SE',
    'PL',
    'IE',
    'NO',
    'CH',
    'AU',
    'JP',
    'SG',
  ]);
  if (!supported.has(egressCountry))
    throw new Error('Gateway egress is not in the verified supported-country set');
} finally {
  await guard.close();
}
const { default: express } = await import('express');
const { logger } = await import('../dist/utils/logger.js');
// Raw request metadata and upstream failures must not be retained by a desktop service.
for (const key of ['log', 'info', 'debug', 'warn', 'error']) logger[key] = () => {};
const { sseUserContextMiddleware } = await import('../dist/middlewares/userContext.js');
const service = await import('../dist/services/mcpService.js');
const transportService = await import('../dist/services/sseService.js');
const names = Object.keys(settings.mcpServers ?? {});
const initialized = await service.initializeClientsFromSettings(true);
// MCPHub initializes HTTP transports asynchronously. Do not advertise an empty
// temporary catalog as an unavailable upstream during the first bootstrap.
const discoveryDeadline = Date.now() + 20000;
while (
  Date.now() < discoveryDeadline &&
  initialized.some(
    (info) =>
      info.status === 'connecting' ||
      (info.status === 'connected' &&
        info.client?.getServerCapabilities?.()?.tools &&
        !info.tools.length),
  )
)
  await new Promise((resolve) => setTimeout(resolve, 100));
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16mb' }));
let stopping = false;
// Shutdown is an operator action, independent of user-scoped MCP credentials.
// Hash both sides to a fixed length before the constant-time comparison.
const shutdownKeys = settings.bearerKeys
  .filter((key) => key.enabled && key.token && (key.kind ?? 'system') === 'system')
  .map((key) => createHash('sha256').update(key.token).digest());
app.post('/_gateway/shutdown', (req, res) => {
  const token = req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1] || '';
  const supplied = createHash('sha256').update(token).digest();
  const permitted = shutdownKeys.reduce(
    (accepted, expected) => timingSafeEqual(supplied, expected) || accepted,
    false,
  );
  if (!token || !permitted) return res.status(401).json({ error: 'Unauthorized' });
  res.status(202).json({ status: 'stopping' });
  setImmediate(() => void stop());
});
app.get('/health', (_req, res) =>
  res.status(stopping ? 503 : 200).json({
    status: stopping ? 'stopping' : 'ready',
    servers: initialized.map((info) => ({ name: info.name, status: info.status })),
    egressCountry,
  }),
);
app.use(
  '/mcp/:group',
  (req, res, next) => {
    if (stopping) return res.status(503).json({ error: 'Gateway is stopping' });
    if (!names.includes(req.params.group)) return res.status(404).json({ error: 'Unknown server' });
    next();
  },
  sseUserContextMiddleware,
);
app.post('/mcp/:group', transportService.handleMcpPostRequest);
app.get('/mcp/:group', transportService.handleMcpOtherRequest);
app.delete('/mcp/:group', transportService.handleMcpOtherRequest);
const server = app.listen(port, '127.0.0.1', () => {
  process.stdout.write(
    JSON.stringify({ event: 'ready', host: '127.0.0.1', port, servers: names }) + '\n',
  );
});
server.on('error', () => {
  process.stderr.write('Gateway listener failed\n');
  process.exit(1);
});
const stop = async () => {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 25000);
  deadline.unref();
  try {
    await transportService.closeModernMcpHandler();
    for (const entry of Object.values(transportService.transports)) await entry.transport.close();
    for (const name of names) await service.closeServer(name);
    await service.cleanupAllServers();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    clearTimeout(deadline);
  } catch {
    process.stderr.write('Gateway shutdown failed\n');
    process.exitCode = 1;
  }
};
process.on('SIGINT', () => {
  void stop();
});
process.on('SIGTERM', () => {
  void stop();
});
