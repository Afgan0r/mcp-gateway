import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const describeLinux = process.platform === 'linux' ? describe : describe.skip;
const brokerScript = path.resolve('scripts/host-mcp-broker.mjs');
const relayScript = path.resolve('scripts/host-mcp-relay.mjs');
const fixture = path.resolve('tests/fixtures/host-mcp-counter.mjs');
const dockerProbe = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
  timeout: 5000,
  stdio: 'pipe',
});
const dockerTest = dockerProbe.status === 0 ? it : it.skip;
const dockerProgram = `let count=0;process.stdin.on('data',()=>process.stdout.write(JSON.stringify({count:++count,hostname:process.env.HOSTNAME})+'\\n'));setInterval(()=>{},1000);`;

function running(pid: number): boolean {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return !['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function eventually(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Condition did not settle');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describeLinux('native host MCP bridge', () => {
  let directory: string;
  let port: number;
  let broker: ChildProcessWithoutNullStreams;
  let relays: ChildProcessWithoutNullStreams[];
  const token = '0123456789abcdef'.repeat(4);
  const outputs = new Map<ChildProcessWithoutNullStreams, { stdout: string; stderr: string }>();

  function start(args: string[], tokenFile = path.join(directory, 'token'), sessionId?: string) {
    const relay = spawn(process.execPath, [relayScript, ...args], {
      env: {
        PATH: process.env.PATH,
        MCP_GATEWAY_BRIDGE_PORT: String(port),
        MCP_GATEWAY_BRIDGE_TOKEN_FILE: tokenFile,
        ...(sessionId ? { MCP_GATEWAY_BRIDGE_SESSION_ID: sessionId } : {}),
      },
    });
    const output = { stdout: '', stderr: '' };
    outputs.set(relay, output);
    relay.stdout.on('data', (chunk) => {
      output.stdout += chunk.toString();
    });
    relay.stderr.on('data', (chunk) => {
      output.stderr += chunk.toString();
    });
    relays.push(relay);
    return relay;
  }

  async function request(relay: ChildProcessWithoutNullStreams, value = 'next') {
    const output = outputs.get(relay)!;
    const previous = output.stdout.length;
    relay.stdin.write(`${value}\n`);
    await eventually(() => output.stdout.slice(previous).includes('\n'));
    return JSON.parse(output.stdout.slice(previous).split('\n')[0]);
  }

  async function launchBroker(script = brokerScript) {
    broker = spawn(process.execPath, [script, '--config', path.join(directory, 'config.json')], {
      env: { ...process.env, BRIDGE_UNRELATED: 'must-not-cross', BRIDGE_SOURCE: 'declared' },
    });
    let ready = false;
    broker.stdout.on('data', () => {
      ready = true;
    });
    await eventually(() => ready || broker.exitCode !== null);
    expect(broker.exitCode).toBeNull();
  }

  beforeEach(async () => {
    relays = [];
    outputs.clear();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'host-mcp-bridge-'));
    fs.chmodSync(directory, 0o700);
    const listener = net.createServer();
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    port = (listener.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    fs.writeFileSync(path.join(directory, 'token'), token, { mode: 0o600 });
    fs.writeFileSync(path.join(directory, 'wrong-token'), 'f'.repeat(64), { mode: 0o600 });
    const server = {
      command: process.execPath,
      args: [fixture],
      inheritEnv: false,
      env: { BRIDGE_EXPLICIT: '${BRIDGE_SOURCE}' },
    };
    fs.writeFileSync(
      path.join(directory, 'config.json'),
      JSON.stringify({
        schemaVersion: 1,
        host: '127.0.0.1',
        port,
        token,
        servers: {
          counter: server,
          tree: { ...server, args: [fixture, 'tree'] },
          missing: { ...server, env: { MISSING: '${BRIDGE_MISSING_OPTIONAL}' } },
          docker: {
            ...server,
            args: [
              path.resolve('scripts/gateway-docker.mjs'),
              'run',
              '--rm',
              '-i',
              'node:22',
              'node',
              '-e',
              dockerProgram,
            ],
            env: { HOME: path.join(directory, 'home') },
          },
        },
      }),
      { mode: 0o600 },
    );
    await launchBroker();
  });

  afterEach(async () => {
    for (const relay of relays)
      if (relay.exitCode === null && relay.signalCode === null) relay.kill('SIGTERM');
    broker.kill('SIGTERM');
    await eventually(() => broker.exitCode !== null || broker.signalCode !== null);
    await eventually(() =>
      relays.every((relay) => relay.exitCode !== null || relay.signalCode !== null),
    );
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('authenticates preflight without starting an upstream and tolerates optional missing bindings', async () => {
    const health = start(['--health']);
    await eventually(() => health.exitCode !== null);
    expect(health.exitCode).toBe(0);
    expect(outputs.get(health)!.stdout).toBe('{"ok":true}\n');
    const missing = start(['--server', 'missing']);
    await eventually(() => missing.exitCode !== null);
    expect(missing.exitCode).toBe(1);
    expect((await request(start(['--server', 'counter']))).count).toBe(1);
  });

  it('isolates owners, passes explicit env and upstream bytes, and verifies release cleanup', async () => {
    const first = start(['--server', 'counter']);
    const second = start(['--server', 'counter']);
    const a = await request(first);
    const b = await request(second);
    expect(a.pid).not.toBe(b.pid);
    expect(a.count).toBe(1);
    expect(b.count).toBe(1);
    expect(a.explicit).toBe('declared');
    expect(a.unrelated).toBeNull();
    expect((await request(first)).count).toBe(2);
    first.stdin.write('stderr\n');
    await eventually(() => outputs.get(first)!.stderr.includes('fixture diagnostic\n'));
    first.stdin.end();
    await eventually(() => first.exitCode !== null);
    expect(first.exitCode).toBe(0);
    expect(running(a.pid)).toBe(false);
    expect(running(b.pid)).toBe(true);
    expect((await request(second)).count).toBe(2);
  });

  it('rejects wrong tokens, unknown names and oversized frames without spawning', async () => {
    const wrong = start(['--server', 'counter'], path.join(directory, 'wrong-token'));
    const unknown = start(['--server', 'unlisted']);
    await eventually(() => wrong.exitCode !== null && unknown.exitCode !== null);
    expect(wrong.exitCode).toBe(1);
    expect(unknown.exitCode).toBe(1);
    expect(outputs.get(wrong)!.stdout).toBe('');
    const socket = net.connect(port, '127.0.0.1');
    await once(socket, 'connect');
    const closed = once(socket, 'close');
    socket.write(Buffer.from([0x7f, 0xff, 0xff, 0xff]));
    await closed;
    const health = start(['--health']);
    await eventually(() => health.exitCode !== null);
    expect(health.exitCode).toBe(0);
  });

  it('rejects authenticated command/environment overrides and unsafe token files', async () => {
    const socket = net.connect(port, '127.0.0.1');
    await once(socket, 'connect');
    const payload = Buffer.from(
      JSON.stringify({ op: 'open', token, server: 'counter', env: { OVERRIDE: 'forbidden' } }),
    );
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length);
    const closed = once(socket, 'close');
    socket.write(Buffer.concat([header, payload]));
    await closed;
    fs.chmodSync(path.join(directory, 'wrong-token'), 0o644);
    const unsafe = start(['--health'], path.join(directory, 'wrong-token'));
    await eventually(() => unsafe.exitCode !== null);
    expect(unsafe.exitCode).toBe(1);
    expect(outputs.get(unsafe)!.stdout).toBe('');
    expect(outputs.get(unsafe)!.stderr).toBe('Host MCP bridge failed\n');
  });

  it('drains final upstream stdout and propagates natural exit status', async () => {
    const relay = start(['--server', 'counter']);
    await request(relay);
    relay.stdin.write('exit\n');
    await eventually(() => relay.exitCode !== null);
    expect(relay.exitCode).toBe(7);
    expect(outputs.get(relay)!.stdout.endsWith('final bytes\n')).toBe(true);
  });

  it('cleans a stubborn process tree after abrupt relay loss, preserving another owner', async () => {
    const first = start(['--server', 'tree']);
    const second = start(['--server', 'counter']);
    const tree = await request(first);
    const other = await request(second);
    // Allow the descendant to install its SIGTERM handler before disconnect.
    await new Promise((resolve) => setTimeout(resolve, 150));
    first.kill('SIGKILL');
    await eventually(() => !running(tree.pid) && !running(tree.descendant));
    expect(running(other.pid)).toBe(true);
    expect((await request(second)).count).toBe(2);
  });

  it('stops all owned children before broker shutdown succeeds', async () => {
    const first = await request(start(['--server', 'tree']));
    const second = await request(start(['--server', 'counter']));
    broker.kill('SIGTERM');
    await eventually(() => broker.exitCode !== null);
    expect(broker.exitCode).toBe(0);
    expect(running(first.pid)).toBe(false);
    expect(running(first.descendant)).toBe(false);
    expect(running(second.pid)).toBe(false);
  });

  it('verifies explicit release and retries its recorded result without affecting another owner', async () => {
    const sessionId = randomUUID();
    const first = start(['--server', 'tree'], undefined, sessionId);
    const tree = await request(first);
    const other = start(['--server', 'counter']);
    await request(other);
    const collision = start(['--server', 'counter'], undefined, sessionId);
    await eventually(() => collision.exitCode !== null);
    expect(collision.exitCode).toBe(1);
    const release = start(['--release-session', sessionId]);
    await eventually(() => release.exitCode !== null);
    expect(release.exitCode).toBe(0);
    expect(outputs.get(release)!.stdout).toBe('');
    expect(running(tree.pid)).toBe(false);
    expect(running(tree.descendant)).toBe(false);
    const retry = start(['--release-session', sessionId]);
    await eventually(() => retry.exitCode !== null);
    expect(retry.exitCode).toBe(0);
    expect((await request(other)).count).toBe(2);
  });

  it('cancels an unknown ID atomically so a delayed open cannot start it', async () => {
    const sessionId = randomUUID();
    const cancel = start(['--release-session', sessionId]);
    await eventually(() => cancel.exitCode !== null);
    expect(cancel.exitCode).toBe(0);
    const delayed = start(['--server', 'counter'], undefined, sessionId);
    await eventually(() => delayed.exitCode !== null);
    expect(delayed.exitCode).toBe(1);
    expect(outputs.get(delayed)!.stdout).toBe('');
  });

  it('retains an abrupt-loss cleanup result for an explicit control retry', async () => {
    const sessionId = randomUUID();
    const relay = start(['--server', 'tree'], undefined, sessionId);
    const tree = await request(relay);
    relay.kill('SIGKILL');
    const release = start(['--release-session', sessionId]);
    await eventually(() => release.exitCode !== null);
    expect(release.exitCode).toBe(0);
    expect(running(tree.pid)).toBe(false);
    expect(running(tree.descendant)).toBe(false);
  });

  it('propagates cleanup failure and preserves failure on a control retry', async () => {
    broker.kill('SIGTERM');
    await eventually(() => broker.exitCode !== null);
    const installed = path.join(directory, 'installed');
    fs.mkdirSync(path.join(installed, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(installed, 'dist/utils'), { recursive: true });
    fs.writeFileSync(path.join(installed, 'package.json'), '{"type":"module"}');
    fs.copyFileSync(brokerScript, path.join(installed, 'scripts/host-mcp-broker.mjs'));
    fs.copyFileSync(relayScript, path.join(installed, 'scripts/host-mcp-relay.mjs'));
    // Inject failure only into a disposable extracted-helper fixture. The real
    // production helper still kills and verifies the owned child first.
    fs.writeFileSync(
      path.join(installed, 'dist/utils/stdioProcessCleanup.js'),
      [
        `import { closeTrackedStdioProcessTree as actual } from ${JSON.stringify(pathToFileURL(path.resolve('dist/utils/stdioProcessCleanup.js')).href)};`,
        'export async function closeTrackedStdioProcessTree(...args) { await actual(...args); throw new Error("fixture failure"); }',
      ].join('\n'),
    );
    await launchBroker(path.join(installed, 'scripts/host-mcp-broker.mjs'));
    const sessionId = randomUUID();
    const relay = start(['--server', 'counter'], undefined, sessionId);
    const child = await request(relay);
    const release = start(['--release-session', sessionId]);
    await eventually(() => release.exitCode !== null);
    expect(release.exitCode).toBe(1);
    expect(running(child.pid)).toBe(false);
    const retry = start(['--release-session', sessionId]);
    await eventually(() => retry.exitCode !== null);
    expect(retry.exitCode).toBe(1);
    expect(outputs.get(retry)!.stdout).toBe('');
  });

  it('acknowledges authenticated shutdown only after every owned process exits', async () => {
    const tree = await request(start(['--server', 'tree']));
    const shutdown = start(['--shutdown']);
    await eventually(() => shutdown.exitCode !== null);
    expect(shutdown.exitCode).toBe(0);
    expect(running(tree.pid)).toBe(false);
    expect(running(tree.descendant)).toBe(false);
    await eventually(() => broker.exitCode !== null);
    expect(broker.exitCode).toBe(0);
  });

  it('refuses Docker cleanup success without a positive ACK and clean wrapper exit', async () => {
    broker.kill('SIGTERM');
    await eventually(() => broker.exitCode !== null);
    const installed = path.join(directory, 'wrapper-ack-fixture');
    fs.mkdirSync(path.join(installed, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(installed, 'dist/utils'), { recursive: true });
    fs.writeFileSync(path.join(installed, 'package.json'), '{"type":"module"}');
    fs.copyFileSync(brokerScript, path.join(installed, 'scripts/host-mcp-broker.mjs'));
    fs.copyFileSync(relayScript, path.join(installed, 'scripts/host-mcp-relay.mjs'));
    fs.writeFileSync(
      path.join(installed, 'dist/utils/stdioProcessCleanup.js'),
      `export { closeTrackedStdioProcessTree } from ${JSON.stringify(pathToFileURL(path.resolve('dist/utils/stdioProcessCleanup.js')).href)};`,
    );
    const wrapper = path.join(installed, 'scripts/gateway-docker.mjs');
    fs.writeFileSync(
      wrapper,
      [
        `process.stdin.on('data',()=>process.stdout.write('{"count":1}\\n'));`,
        `process.stdin.on('end',()=>{ const mode=process.env.MODE; if(mode==='missing') process.exit(0); else process.send({op:'dockerCleanup',ok:mode!=='negative'},()=>{process.disconnect();process.exit(mode==='nonzero'?1:0);}); });`,
      ].join('\n'),
    );
    const configPath = path.join(directory, 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    for (const mode of ['missing', 'negative', 'nonzero'])
      config.servers[mode] = {
        command: process.execPath,
        args: [wrapper],
        inheritEnv: false,
        env: { MODE: mode },
      };
    fs.writeFileSync(configPath, JSON.stringify(config));
    await launchBroker(path.join(installed, 'scripts/host-mcp-broker.mjs'));
    for (const mode of ['missing', 'negative', 'nonzero']) {
      const sessionId = randomUUID();
      await request(start(['--server', mode], undefined, sessionId));
      const release = start(['--release-session', sessionId]);
      await eventually(() => release.exitCode !== null);
      expect(release.exitCode).toBe(1);
      const retry = start(['--release-session', sessionId]);
      await eventually(() => retry.exitCode !== null);
      expect(retry.exitCode).toBe(1);
    }
  }, 30000);

  dockerTest(
    'verifies real Docker removal before owner release while another container remains usable',
    async () => {
      const image = spawnSync('docker', ['image', 'inspect', 'node:22'], {
        timeout: 5000,
        stdio: 'pipe',
      });
      if (image.status !== 0)
        throw new Error(
          'Docker is healthy; run docker pull node:22 before the host bridge Docker test',
        );
      const firstId = randomUUID();
      const first = start(['--server', 'docker'], undefined, firstId);
      const firstReply = await request(first);
      const second = start(['--server', 'docker']);
      const secondReply = await request(second);
      const root = path.join(directory, 'home/.local/state/mcp-gateway/containers');
      const ids = fs
        .readdirSync(root)
        .map((entry) => fs.readFileSync(path.join(root, entry, 'container.id'), 'utf8').trim());
      const firstContainer = ids.find((id) => id.startsWith(firstReply.hostname));
      const secondContainer = ids.find((id) => id.startsWith(secondReply.hostname));
      expect(firstContainer).toMatch(/^[a-f0-9]{64}$/);
      expect(secondContainer).toMatch(/^[a-f0-9]{64}$/);
      const release = start(['--release-session', firstId]);
      await eventually(() => release.exitCode !== null);
      expect(release.exitCode).toBe(0);
      const absent = spawnSync(
        'docker',
        ['container', 'ls', '--all', '--quiet', '--no-trunc', '--filter', `id=${firstContainer}`],
        { encoding: 'utf8', timeout: 5000 },
      );
      expect(absent.status).toBe(0);
      expect(absent.stdout.trim()).toBe('');
      const other = spawnSync(
        'docker',
        ['inspect', '--format', '{{.State.Running}}', secondContainer!],
        { encoding: 'utf8', timeout: 5000 },
      );
      expect(other.status).toBe(0);
      expect(other.stdout.trim()).toBe('true');
      expect((await request(second)).count).toBe(2);
    },
    30000,
  );
});
