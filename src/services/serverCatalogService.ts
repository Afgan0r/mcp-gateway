import { createHmac, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type {
  Tool,
  Prompt,
  Resource,
  ListResourceTemplatesResult,
} from '@modelcontextprotocol/server';

// Raw, single-page upstream definitions. A null category means the upstream did
// not advertise that capability; [] means discovery succeeded and returned none.
export interface ServerCatalog {
  instructions?: string;
  serverVersion?: string;
  tools: Tool[] | null;
  prompts: Prompt[] | null;
  resources: Resource[] | null;
  resourceTemplates: ListResourceTemplatesResult['resourceTemplates'] | null;
}

const named = z
  .object({
    name: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    _meta: z.record(z.string(), z.unknown()).optional(),
    icons: z
      .array(
        z
          .object({
            src: z.string(),
            mimeType: z.string().optional(),
            sizes: z.array(z.string()).optional(),
            theme: z.enum(['light', 'dark']).optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();
const catalogSchema = z
  .object({
    instructions: z.string().optional(),
    serverVersion: z.string().optional(),
    tools: z
      .array(
        named.extend({
          inputSchema: z.object({ type: z.literal('object') }).passthrough(),
          outputSchema: z
            .object({ type: z.literal('object') })
            .passthrough()
            .optional(),
          annotations: z
            .object({
              title: z.string().optional(),
              readOnlyHint: z.boolean().optional(),
              destructiveHint: z.boolean().optional(),
              idempotentHint: z.boolean().optional(),
              openWorldHint: z.boolean().optional(),
            })
            .passthrough()
            .optional(),
        }),
      )
      .max(10000)
      .nullable(),
    prompts: z
      .array(
        named.extend({
          arguments: z
            .array(
              z
                .object({
                  name: z.string(),
                  required: z.boolean().optional(),
                  description: z.string().optional(),
                })
                .passthrough(),
            )
            .optional(),
        }),
      )
      .max(10000)
      .nullable(),
    resources: z
      .array(
        named.extend({
          uri: z.string(),
          mimeType: z.string().optional(),
          size: z.number().nonnegative().optional(),
        }),
      )
      .max(10000)
      .nullable(),
    resourceTemplates: z
      .array(named.extend({ uriTemplate: z.string(), mimeType: z.string().optional() }))
      .max(10000)
      .nullable(),
  })
  .strict();
const snapshotSchema = z
  .object({
    version: z.literal(1),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    catalog: catalogSchema,
  })
  .strict();
const MAX_BYTES = 16 * 1024 * 1024;
const tails = new Map<string, Promise<unknown>>();
const revisions = new Map<string, number>();

const serial = <T>(root: string, operation: () => Promise<T>): Promise<T> => {
  const run = (tails.get(root) ?? Promise.resolve()).catch(() => undefined).then(operation);
  tails.set(root, run);
  void run
    .finally(() => {
      if (tails.get(root) === run) tails.delete(root);
    })
    .catch(() => undefined);
  return run;
};

const stableJson = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );

export const getServerCatalogDirectory = (): string =>
  path.resolve(
    process.env.MCPHUB_CATALOG_DIR ||
      (process.platform === 'win32'
        ? path.join(
            process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
            'mcphub',
            'catalog',
          )
        : path.join(
            process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'),
            'mcphub',
            'catalog',
          )),
  );

const protectedDirectory = async (root: string): Promise<void> => {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(root);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error('Invalid catalog directory');
  await fs.chmod(root, 0o700);
};

const readProtected = async (file: string, limit: number): Promise<Buffer> => {
  const stat = await fs.lstat(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > limit ||
    (process.getuid && stat.uid !== process.getuid()) ||
    (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
  ) {
    throw new Error('Invalid protected catalog file');
  }
  const data = await fs.readFile(file);
  if (data.length > limit) throw new Error('Catalog exceeds size limit');
  return data;
};

const getKey = async (root: string): Promise<Buffer> => {
  await protectedDirectory(root);
  const file = path.join(root, 'fingerprint.key');
  try {
    await fs.writeFile(file, randomBytes(32), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const key = await readProtected(file, 32);
  if (key.length !== 32) throw new Error('Invalid catalog fingerprint key');
  return key;
};

export interface CatalogIdentity {
  root: string;
  slot: string;
  fingerprint: string;
  revision: number;
}

export const beginServerCatalogDiscovery = (identity: CatalogIdentity): CatalogIdentity => {
  const slot = path.join(identity.root, identity.slot);
  const revision = (revisions.get(slot) ?? 0) + 1;
  revisions.set(slot, revision);
  return { ...identity, revision };
};

/** No raw configuration, credentials, settings paths or server names are stored. */
export const identifyServerCatalog = async (
  settingsPath: string,
  serverName: string,
  effectiveDiscoveryConfig: unknown,
): Promise<CatalogIdentity> => {
  const root = getServerCatalogDirectory();
  return serial(root, async () => {
    const key = await getKey(root);
    const digest = (value: unknown) =>
      createHmac('sha256', key).update(stableJson(value)).digest('hex');
    const slot = digest([path.resolve(settingsPath), serverName]);
    return {
      root,
      slot,
      fingerprint: digest(effectiveDiscoveryConfig),
      revision: revisions.get(path.join(root, slot)) ?? 0,
    };
  });
};

export const readServerCatalog = async (
  identity: CatalogIdentity,
): Promise<ServerCatalog | undefined> =>
  serial(identity.root, async () => {
    try {
      const data = await readProtected(
        path.join(identity.root, `${identity.slot}.json`),
        MAX_BYTES,
      );
      const snapshot = snapshotSchema.parse(JSON.parse(data.toString('utf8')));
      if (snapshot.fingerprint !== identity.fingerprint) return undefined;
      return snapshot.catalog as ServerCatalog;
    } catch {
      return undefined;
    }
  });

/** Single-process serialization; sharing one directory across gateway writers is unsupported. */
export const writeServerCatalog = async (
  identity: CatalogIdentity,
  catalog: ServerCatalog,
  isCurrent: () => Promise<boolean>,
): Promise<boolean> =>
  serial(identity.root, async () => {
    if (
      !(await isCurrent()) ||
      (revisions.get(path.join(identity.root, identity.slot)) ?? 0) !== identity.revision
    )
      return false;
    const snapshot = { version: 1, fingerprint: identity.fingerprint, catalog };
    snapshotSchema.parse(snapshot);
    const bytes = stableJson(snapshot);
    if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error('Catalog exceeds size limit');
    const temporary = path.join(
      identity.root,
      `.${identity.slot}.${randomBytes(8).toString('hex')}.tmp`,
    );
    try {
      await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
      if ((revisions.get(path.join(identity.root, identity.slot)) ?? 0) !== identity.revision)
        return false;
      await fs.rename(temporary, path.join(identity.root, `${identity.slot}.json`));
    } finally {
      await fs.rm(temporary, { force: true });
    }
    return true;
  });

export const invalidateServerCatalog = async (identity: CatalogIdentity): Promise<void> => {
  const slot = path.join(identity.root, identity.slot);
  revisions.set(slot, (revisions.get(slot) ?? 0) + 1);
  await serial(identity.root, () => fs.rm(`${slot}.json`, { force: true }));
};
