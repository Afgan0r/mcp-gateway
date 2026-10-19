import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import {
  createStdioClientTransport,
  isHostBridgeTransport,
} from '../../src/utils/hostBridgeTransport.js';

const describeLinux = process.platform === 'linux' ? describe : describe.skip;
const running = (pid: number): boolean => {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return !['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};

describeLinux('SDK transport through the native host bridge', () => {
  let directory: string;
  let broker: ChildProcessWithoutNullStreams;
  let port: number;
  const clients: Client[] = [];

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'host-bridge-sdk-'));
    fs.chmodSync(directory, 0o700);
    const listener = net.createServer().listen(0, '127.0.0.1');
    await once(listener, 'listening');
    port = (listener.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    const token = 'd'.repeat(64);
    fs.writeFileSync(path.join(directory, 'token'), token, { mode: 0o600 });
    fs.writeFileSync(
      path.join(directory, 'broker.json'),
      JSON.stringify({
        schemaVersion: 1,
        host: '127.0.0.1',
        port,
        token,
        servers: {
          counter: {
            command: process.execPath,
            args: [path.resolve('tests/fixtures/session-identity-server.mjs')],
            inheritEnv: false,
            env: {},
          },
        },
      }),
      { mode: 0o600 },
    );
    broker = spawn(process.execPath, [
      path.resolve('scripts/host-mcp-broker.mjs'),
      '--config',
      path.join(directory, 'broker.json'),
    ]);
    await Promise.race([
      once(broker.stdout, 'data'),
      once(broker, 'exit').then(() => {
        throw new Error('Broker exited before readiness');
      }),
    ]);
  });

  afterEach(async () => {
    await Promise.allSettled(clients.splice(0).map((client) => client.close()));
    const exited = once(broker, 'exit');
    broker.kill('SIGTERM');
    await exited;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const connect = async () => {
    const transport = createStdioClientTransport({
      command: process.execPath,
      args: [path.resolve('scripts/host-mcp-relay.mjs'), '--server', 'counter'],
      env: {
        PATH: process.env.PATH ?? '',
        MCP_GATEWAY_BRIDGE_PORT: String(port),
        MCP_GATEWAY_BRIDGE_TOKEN_FILE: path.join(directory, 'token'),
      },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'host-bridge-sdk-test', version: '1' });
    clients.push(client);
    await client.connect(transport);
    return { client, transport };
  };

  const identity = async (client: Client) => {
    const result = await client.callTool({ name: 'probe_identity', arguments: { label: 'sdk' } });
    const content = result.content as { type: string; text: string }[];
    return JSON.parse(content[0].text) as { pid: number; calls: number; instance: string };
  };

  it('waits for native child exit and preserves another SDK owner', async () => {
    const first = await connect();
    const second = await connect();
    expect(isHostBridgeTransport(first.transport)).toBe(true);
    const a = await identity(first.client);
    const b = await identity(second.client);
    expect(a.instance).not.toBe(b.instance);
    await first.transport.close();
    expect(running(a.pid)).toBe(false);
    expect(running(b.pid)).toBe(true);
    expect((await identity(second.client)).calls).toBe(2);
    await first.transport.close();
    await second.client.close();
    expect(running(b.pid)).toBe(false);
  });

  it('safely cancels a never-started relay before any native child can launch', async () => {
    const transport = createStdioClientTransport({
      command: process.execPath,
      args: [path.resolve('scripts/host-mcp-relay.mjs'), '--server', 'counter'],
      env: {
        MCP_GATEWAY_BRIDGE_PORT: String(port),
        MCP_GATEWAY_BRIDGE_TOKEN_FILE: path.join(directory, 'token'),
      },
      stderr: 'pipe',
    });
    await expect(transport.close()).resolves.toBeUndefined();
  });

  it('reports an unverified release and allows retry after authentication recovers', async () => {
    const { client, transport } = await connect();
    const child = await identity(client);
    fs.writeFileSync(path.join(directory, 'token'), 'e'.repeat(64), { mode: 0o600 });
    await expect(transport.close()).rejects.toThrow('cleanup was not verified');
    expect(running(child.pid)).toBe(true);
    fs.writeFileSync(path.join(directory, 'token'), 'd'.repeat(64), { mode: 0o600 });
    await expect(transport.close()).resolves.toBeUndefined();
    expect(running(child.pid)).toBe(false);
  });
});
