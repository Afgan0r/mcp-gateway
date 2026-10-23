// Build an allowlisted, self-contained Windows distribution outside the checkout.
// Node checksums: https://nodejs.org/dist/v24.16.0/SHASUMS256.txt
// Flat dependencies: https://pnpm.io/settings/node-modules#nodelinker
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

assert.equal(process.platform, 'win32', 'Build on Windows for native dependency compatibility');
assert.equal(process.arch, 'x64');
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(process.env.LOCALAPPDATA, 'mcp-gateway', 'native-build');
fs.mkdirSync(root, { recursive: true });
const sid = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).match(
  /S-1-[\d-]+/,
)[0];
execFileSync(
  'icacls.exe',
  [root, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'],
  { stdio: 'pipe' },
);
const work = fs.mkdtempSync(path.join(root, 'build-'));
const run = (command, args, cwd = work, env = process.env, timeout = 1200000) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: 'inherit',
      windowsHide: true,
      windowsVerbatimArguments: command === 'cmd.exe',
    });
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.pid) {
        try {
          execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
            timeout: 15000,
          });
        } catch {
          /* The owned command may have exited concurrently. */
        }
      }
      reject(new Error(`Build stage timed out: ${command}`));
    }, timeout);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Build stage failed (${code}): ${command}`));
    });
  });
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: source,
  encoding: 'utf8',
}).trim();
assert.match(revision, /^[a-f0-9]{40}$/);
const dirty = Boolean(
  execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: source,
    encoding: 'utf8',
  }).trim(),
);
if (process.env.CI && dirty) throw new Error('Release builds require a clean source tree');

async function download(url, destination) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  fs.writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
}
const nodeVersion = 'v24.16.0';
const archiveName = `node-${nodeVersion}-win-x64.zip`;
const toolchain = path.join(root, 'toolchain');
fs.mkdirSync(toolchain, { recursive: true });
const archive = path.join(toolchain, archiveName);
const sums = path.join(toolchain, 'SHASUMS256.txt');
await download(`https://nodejs.org/dist/${nodeVersion}/SHASUMS256.txt`, sums);
const expected = fs
  .readFileSync(sums, 'utf8')
  .split(/\r?\n/)
  .find((line) => line.endsWith(`  ${archiveName}`))
  ?.split(/\s+/)[0];
assert.match(expected || '', /^[a-f0-9]{64}$/);
if (!fs.existsSync(archive) || digest(fs.readFileSync(archive)) !== expected)
  await download(`https://nodejs.org/dist/${nodeVersion}/${archiveName}`, archive);
assert.equal(digest(fs.readFileSync(archive)), expected, 'Official Node SHA256 mismatch');
const nodeDirectory = path.join(toolchain, `node-${nodeVersion}-win-x64`);
if (!fs.existsSync(nodeDirectory))
  await run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Expand-Archive -LiteralPath $env:GATEWAY_NODE_ARCHIVE -DestinationPath $env:GATEWAY_NODE_TOOLS',
    ],
    work,
    { ...process.env, GATEWAY_NODE_ARCHIVE: archive, GATEWAY_NODE_TOOLS: toolchain },
  );
const node = path.join(nodeDirectory, 'node.exe');
assert.equal(execFileSync(node, ['--version'], { encoding: 'utf8' }).trim(), nodeVersion);
const env = {
  ...process.env,
  PATH: `${nodeDirectory}${path.delimiter}${process.env.PATH}`,
  CI: 'true',
};
// Invoke the pinned repository package manager; cmd.exe is required for pnpm.cmd.
async function pnpm(args, cwd) {
  const quote = (arg) => `"${arg.replaceAll('"', '""')}"`;
  await run('cmd.exe', ['/d', '/s', '/c', `pnpm ${args.map(quote).join(' ')}`], cwd, env);
}
const pnpmVersion = execFileSync('cmd.exe', ['/d', '/s', '/c', 'pnpm --version'], {
  env,
  encoding: 'utf8',
  timeout: 30000,
}).trim();
assert.equal(pnpmVersion, '12.14.0', 'Install the packageManager version declared in package.json');
function copy(relative, target) {
  const from = path.join(source, relative);
  const to = path.join(target, relative);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true, dereference: false });
}
function manifests(target) {
  fs.mkdirSync(target, { recursive: true });
  for (const relative of [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    '.pnpmfile.cjs',
    'patches',
  ])
    copy(relative, target);
  const workspace = path.join(target, 'pnpm-workspace.yaml');
  // Only these native production dependencies run build scripts. esbuild is
  // needed by the backend build. This leaves shared Linux policy unchanged.
  const config = fs
    .readFileSync(workspace, 'utf8')
    .replace(/^( {2}(?:bcrypt|better-sqlite3|esbuild):) false$/gm, '$1 true');
  fs.writeFileSync(workspace, config + '\nnodeLinker: hoisted\npackageImportMethod: copy\n');
}
const build = path.join(work, 'source');
manifests(build);
copy('src', build);
copy('tsconfig.json', build);
copy('scripts/build-mcp-client.js', build);
await pnpm(['install', '--frozen-lockfile'], build);
await pnpm(['backend:build'], build);
const payload = path.join(work, 'runtime');
manifests(payload);
await pnpm(['install', '--prod', '--frozen-lockfile'], payload);
for (const relative of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', '.pnpmfile.cjs', 'patches'])
  fs.rmSync(path.join(payload, relative), { recursive: true, force: true });
// Package-manager bookkeeping carries build-machine paths and has no runtime
// role. Dependencies themselves are flat regular files under node_modules.
for (const relative of [
  'node_modules/.modules.yaml',
  'node_modules/.pnpm-workspace-state-v1.json',
  'node_modules/.pnpm/lock.yaml',
])
  fs.rmSync(path.join(payload, relative), { force: true });
fs.cpSync(path.join(build, 'dist'), path.join(payload, 'dist'), { recursive: true });
for (const relative of [
  'scripts/local-gateway.mjs',
  'scripts/gateway-docker.mjs',
  'locales',
  'LICENSE',
])
  copy(relative, payload);
fs.copyFileSync(node, path.join(payload, 'node.exe'));
fs.copyFileSync(path.join(nodeDirectory, 'LICENSE'), path.join(payload, 'NODE-LICENSE'));
const pkg = JSON.parse(fs.readFileSync(path.join(payload, 'package.json'), 'utf8'));
fs.writeFileSync(
  path.join(payload, 'package.json'),
  JSON.stringify({ name: pkg.name, version: pkg.version, type: 'module', private: true }, null, 2) +
    '\n',
);
// Prove native addon loading against the exact bundled ABI before archiving.
await run(
  node,
  [
    '--input-type=module',
    '-e',
    "import bcrypt from 'bcrypt'; import Database from 'better-sqlite3'; const db=new Database(':memory:'); db.prepare('select 1').get(); db.close(); if(!bcrypt.compareSync('smoke',bcrypt.hashSync('smoke',4)))throw Error('bcrypt failed');",
  ],
  payload,
  env,
  30000,
);
const files = {};
function walk(directory) {
  for (const name of fs.readdirSync(directory).sort()) {
    const filename = path.join(directory, name);
    const stat = fs.lstatSync(filename);
    assert(!stat.isSymbolicLink(), `Distribution contains a symlink or junction: ${filename}`);
    if (stat.isDirectory()) walk(filename);
    else {
      assert(stat.isFile(), 'Only regular files may be packaged');
      const relative = path.relative(payload, filename).split(path.sep).join('/');
      assert(
        !/(^|\/)\.env(?:\.|$)|(^|\/)(?:mcp_settings\.json|\.secrets|logs)(?:\/|$)/i.test(relative),
        'Private state found in payload',
      );
      files[relative] = digest(fs.readFileSync(filename));
    }
  }
}
walk(payload);
fs.writeFileSync(
  path.join(payload, 'runtime-manifest.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      platform: 'win32',
      arch: 'x64',
      sourceRevision: revision,
      sourceDirty: dirty,
      nodeVersion,
      files,
    },
    null,
    2,
  ) + '\n',
);
const require = createRequire(path.join(payload, 'package.json'));
const AdmZip = require('adm-zip');
const zip = new AdmZip();
zip.addLocalFolder(payload);
const destination = path.join(root, 'mcp-gateway-windows-x64.zip');
const pending = path.join(root, `.${randomUUID()}.zip`);
zip.writeZip(pending);
fs.renameSync(pending, destination);
const sha256 = digest(fs.readFileSync(destination));
fs.writeFileSync(destination + '.sha256', `${sha256}  mcp-gateway-windows-x64.zip\n`);
console.log(
  JSON.stringify({
    artifact: destination,
    sha256,
    sourceRevision: revision,
    sourceDirty: dirty,
    nodeVersion,
    files: Object.keys(files).length,
    payload,
  }),
);
