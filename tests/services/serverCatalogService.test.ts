import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  identifyServerCatalog,
  beginServerCatalogDiscovery,
  readServerCatalog,
  writeServerCatalog,
  invalidateServerCatalog,
  type ServerCatalog,
} from '../../src/services/serverCatalogService.js';
import { remainingListTtl } from '../../src/utils/listFreshness.js';

describe('persistent server catalogs', () => {
  let directory: string;
  const prior = process.env.MCPHUB_CATALOG_DIR;
  const catalog: ServerCatalog = {
    tools: [
      {
        name: 'ping',
        inputSchema: { type: 'object' },
        _meta: { private: { nested: true } },
        outputSchema: { type: 'object' },
      },
    ],
    prompts: [],
    resources: null,
    resourceTemplates: [{ name: 'sample', uriTemplate: 'test://{id}', _meta: { custom: true } }],
  };
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcphub-catalog-test-'));
    process.env.MCPHUB_CATALOG_DIR = directory;
  });
  afterEach(async () => {
    if (prior === undefined) delete process.env.MCPHUB_CATALOG_DIR;
    else process.env.MCPHUB_CATALOG_DIR = prior;
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('round trips raw metadata, empty and unsupported categories without positive freshness', async () => {
    const identity = await identifyServerCatalog('/settings/a.json', 'demo', {
      command: 'node',
      env: { SECRET: 'secret-value' },
    });
    await expect(writeServerCatalog(identity, catalog, async () => true)).resolves.toBe(true);
    const restored = await readServerCatalog(
      await identifyServerCatalog('/settings/a.json', 'demo', {
        command: 'node',
        env: { SECRET: 'secret-value' },
      }),
    );
    expect(restored).toEqual(catalog);
    expect(remainingListTtl([restored!.tools!], performance.now(), performance.now())).toBe(0);
    const snapshot = await fs.readFile(path.join(directory, `${identity.slot}.json`), 'utf8');
    expect(snapshot).not.toContain('secret-value');
    expect(snapshot).not.toContain('/settings/a.json');
    if (process.platform !== 'win32') {
      expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(path.join(directory, `${identity.slot}.json`))).mode & 0o777).toBe(
        0o600,
      );
      expect((await fs.stat(path.join(directory, 'fingerprint.key'))).mode & 0o777).toBe(0o600);
    }
  });

  it('partitions by settings file, server and effective configuration', async () => {
    const original = await identifyServerCatalog('/settings/a.json', 'demo', { command: 'old' });
    await writeServerCatalog(original, catalog, async () => true);
    for (const [settings, server, command] of [
      ['/settings/b.json', 'demo', 'old'],
      ['/settings/a.json', 'other', 'old'],
      ['/settings/a.json', 'demo', 'new'],
    ]) {
      expect(
        await readServerCatalog(await identifyServerCatalog(settings, server, { command })),
      ).toBeUndefined();
    }
  });

  it('rejects malformed, oversized, public and unsupported-version snapshots', async () => {
    const identity = await identifyServerCatalog('/settings/a.json', 'demo', {});
    const file = path.join(directory, `${identity.slot}.json`);
    for (const bytes of [
      '{',
      JSON.stringify({ version: 2, fingerprint: identity.fingerprint, catalog }),
      JSON.stringify({
        version: 1,
        fingerprint: identity.fingerprint,
        catalog: { ...catalog, tools: [{ name: 'bad' }] },
      }),
      ' '.repeat(16 * 1024 * 1024 + 1),
    ]) {
      await fs.writeFile(file, bytes, { mode: 0o600 });
      expect(await readServerCatalog(identity)).toBeUndefined();
    }
    await writeServerCatalog(identity, catalog, async () => true);
    if (process.platform !== 'win32') {
      await fs.chmod(file, 0o644);
      expect(await readServerCatalog(identity)).toBeUndefined();
    }
  });

  it('prevents late discovery from replacing a newer discovery or surviving invalidation', async () => {
    const identity = await identifyServerCatalog('/settings/a.json', 'demo', {});
    const old = beginServerCatalogDiscovery(identity);
    const recent = beginServerCatalogDiscovery(identity);
    await writeServerCatalog(recent, catalog, async () => true);
    expect(await writeServerCatalog(old, { ...catalog, tools: [] }, async () => true)).toBe(false);
    expect(await readServerCatalog(recent)).toEqual(catalog);
    await invalidateServerCatalog(recent);
    expect(await writeServerCatalog(recent, catalog, async () => true)).toBe(false);
    expect(await readServerCatalog(recent)).toBeUndefined();
    expect(
      await writeServerCatalog(
        await identifyServerCatalog('/settings/a.json', 'demo', {}),
        catalog,
        async () => false,
      ),
    ).toBe(false);
  });
});
