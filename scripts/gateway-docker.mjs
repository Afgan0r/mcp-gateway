// Give one stdio Docker owner an exact container identity and cleanup boundary.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

process.umask(0o077);
const args = process.argv.slice(2);
if (args[0] !== 'run' || args.includes('--cidfile'))
  throw new Error('Expected docker run without cidfile');
const stateRoot =
  process.platform === 'win32'
    ? process.env.LOCALAPPDATA
    : path.join(os.homedir(), '.local', 'state');
if (!stateRoot) throw new Error('No private container state directory');
const root = path.join(stateRoot, 'mcp-gateway', 'containers');
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
const directory = fs.mkdtempSync(path.join(root, 'owner-'));
const cidfile = path.join(directory, 'container.id');
const child = spawn('docker', ['run', '--cidfile', cidfile, ...args.slice(1)], {
  stdio: ['pipe', 'inherit', 'inherit'],
  windowsHide: true,
});
process.stdin.pipe(child.stdin);
child.stdin.on('error', () => {});
let stopping = false;
const cleanup = () => {
  if (stopping) return;
  stopping = true;
  // Docker itself writes this file; never accept a caller-supplied container ID.
  if (fs.existsSync(cidfile)) {
    const id = fs.readFileSync(cidfile, 'utf8').trim();
    if (/^[a-f0-9]{64}$/.test(id)) {
      const removed = spawnSync('docker', ['rm', '--force', id], {
        stdio: 'ignore',
        timeout: 5000,
        windowsHide: true,
      });
      const inspected = spawnSync(
        'docker',
        ['container', 'ls', '--all', '--quiet', '--no-trunc', '--filter', `id=${id}`],
        {
          encoding: 'utf8',
          timeout: 5000,
          windowsHide: true,
        },
      );
      if (inspected.status !== 0 || inspected.stdout.trim() || removed.error) {
        process.stderr.write('Owned Docker container cleanup could not be verified\n');
        process.exitCode = 1;
        return; // Retain the exact private identity for diagnosis/retry.
      }
    }
  }
  fs.rmSync(directory, { recursive: true, force: true });
};
child.on('error', () => {
  cleanup();
  process.exitCode = 1;
});
child.on('exit', (code) => {
  cleanup();
  process.exitCode = process.exitCode || code || 0;
});
process.stdin.on('end', cleanup);
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    cleanup();
    if (!child.killed) child.kill('SIGTERM');
  });
