import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const { packageManager } = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
const pin = /^pnpm@([^+]+)\+(sha512)\.([a-f0-9]{128})$/.exec(packageManager);
if (!pin) throw new Error('packageManager must pin pnpm with a SHA-512 checksum');
const prefix = process.env.PNPM_HOME;
if (!prefix || !path.isAbsolute(prefix)) throw new Error('PNPM_HOME must be an absolute path');
if (process.platform !== 'linux') throw new Error('This bootstrap targets Linux CI and Docker');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mcphub-pnpm-'));

function npm(args, capture = false) {
  const result = spawnSync('npm', args, {
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    timeout: 120000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ${args[0]} failed (${result.status})`);
  return result.stdout;
}

try {
  // npm resolves full package metadata instead of Corepack's lazy native
  // downloader, whose per-version metadata request can stall before startup.
  const [packed] = JSON.parse(
    npm(
      ['pack', `pnpm@${pin[1]}`, '--ignore-scripts', '--json', '--pack-destination', temporary],
      true,
    ),
  );
  if (path.basename(packed.filename) !== packed.filename)
    throw new Error('Invalid package filename');
  const archive = path.join(temporary, packed.filename);
  const digest = createHash(pin[2]).update(fs.readFileSync(archive)).digest('hex');
  if (digest !== pin[3]) throw new Error('Downloaded pnpm does not match packageManager checksum');
  npm(['install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', archive]);
  const version = spawnSync(path.join(prefix, 'bin/pnpm'), ['--version'], {
    encoding: 'utf8',
    timeout: 30000,
  });
  if (version.error) throw version.error;
  if (version.status !== 0 || version.stdout.trim() !== pin[1])
    throw new Error('Installed pnpm version differs from packageManager');
  console.log(`Verified and installed pnpm ${pin[1]}`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
