// Real Docker cleanup check. No Grafana credentials or external API calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const directory = path.join(os.homedir(), '.local', 'state', 'mcp-gateway', 'containers');
const prior = new Set(fs.existsSync(directory) ? fs.readdirSync(directory) : []);
const client = new Client({ name: 'docker-cleanup-probe', version: '1' });
let id;
try {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        fileURLToPath(new URL('./gateway-docker.mjs', import.meta.url)),
        'run',
        '--rm',
        '-i',
        '-e',
        'GRAFANA_URL=http://127.0.0.1',
        'mcp/grafana',
        '-t',
        'stdio',
      ],
      stderr: 'pipe',
    }),
  );
  const tools = await client.listTools();
  assert.ok(tools.tools.length > 0);
  const owners = fs.readdirSync(directory).filter((name) => !prior.has(name));
  assert.equal(owners.length, 1);
  id = fs.readFileSync(path.join(directory, owners[0], 'container.id'), 'utf8').trim();
  assert.match(id, /^[a-f0-9]{64}$/);
  const before = spawnSync(
    'docker',
    ['container', 'ls', '--quiet', '--no-trunc', '--filter', `id=${id}`],
    { encoding: 'utf8' },
  );
  assert.equal(before.status, 0);
  assert.equal(before.stdout.trim(), id);
  await client.close();
  const after = spawnSync(
    'docker',
    ['container', 'ls', '--all', '--quiet', '--no-trunc', '--filter', `id=${id}`],
    { encoding: 'utf8' },
  );
  assert.equal(after.status, 0);
  assert.equal(after.stdout.trim(), '');
  assert.ok(!fs.existsSync(path.join(directory, owners[0])));
  console.log(
    JSON.stringify({
      check: 'real-docker-owned-container-cleanup',
      passed: true,
      tools: tools.tools.length,
    }),
  );
} finally {
  await client.close();
  if (id) spawnSync('docker', ['rm', '--force', id], { stdio: 'ignore', timeout: 10000 });
}
