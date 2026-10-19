import { randomUUID } from 'node:crypto';

export type RuntimeRetentionPolicy = 'idle' | 'explicit';

export interface RuntimeOwnerSummary {
  ownerId: string;
  serverName: string;
  retentionPolicy: RuntimeRetentionPolicy;
  createdAt: number;
  lastUsedAt: number;
  detachedAt?: number;
  activeOperations: number;
  status: 'retained' | 'releasing' | 'close_failed';
}

interface RuntimeOwner extends RuntimeOwnerSummary {
  scope: string;
  correlation: string;
  key: string;
  idleTimeoutMs: number;
  timer?: ReturnType<typeof setTimeout>;
  closed: boolean;
  closePromise?: Promise<'released' | 'close_failed'>;
  closeReason?: 'idle' | 'release' | 'invalidate';
}

interface AcquireRuntimeOwner {
  /** Must be built from authenticated credential/principal/route, never raw metadata. */
  scope: string;
  /** Current transport or authenticated application-state correlation, not durable chat identity. */
  correlation: string;
  serverName: string;
  retentionPolicy: RuntimeRetentionPolicy;
  idleTimeoutMs?: number;
}

/** Process-local owner lifetimes, independent of downstream transport attachment. */
export class RuntimeOwnerService {
  private readonly owners = new Map<string, RuntimeOwner>();
  private readonly ownerIdsByKey = new Map<string, string>();

  constructor(
    private readonly close: (ownerId: string, serverName: string) => void | Promise<void>,
    private readonly maxOwners = 1000,
  ) {
    if (!Number.isInteger(maxOwners) || maxOwners < 1) {
      throw new Error('Runtime owner limit must be a positive integer');
    }
  }

  acquire(input: AcquireRuntimeOwner): { ownerId: string; release: () => void } {
    if (!input.scope || !input.correlation || !input.serverName) {
      throw new Error('Runtime owners require authenticated scope and state correlation');
    }
    if (input.retentionPolicy !== 'idle' && input.retentionPolicy !== 'explicit') {
      throw new Error('Runtime owner retention policy must be idle or explicit');
    }
    const idleTimeoutMs = input.idleTimeoutMs ?? 15 * 60 * 1000;
    if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0 || idleTimeoutMs > 2_147_483_647) {
      throw new Error('Runtime owner idle timeout must be between 1 and 2147483647 milliseconds');
    }
    const key = JSON.stringify([input.scope, input.correlation, input.serverName]);
    const existingId = this.ownerIdsByKey.get(key);
    let owner = existingId ? this.owners.get(existingId) : undefined;
    if (owner?.status === 'close_failed') {
      throw new Error('Runtime owner cleanup failed; retry release before starting more work');
    }
    if (owner && owner.status !== 'retained') {
      throw new Error('Runtime owner is releasing; wait for active operations to finish');
    }
    if (owner && owner.retentionPolicy !== input.retentionPolicy) {
      throw new Error('Runtime owner retention policy changed; invalidate the old runtime first');
    }
    if (!owner) {
      if (this.owners.size >= this.maxOwners) {
        throw new Error('Runtime owner limit reached; release an existing owner before retrying');
      }
      const now = Date.now();
      owner = {
        ownerId: randomUUID(),
        serverName: input.serverName,
        retentionPolicy: input.retentionPolicy,
        scope: input.scope,
        correlation: input.correlation,
        key,
        idleTimeoutMs,
        createdAt: now,
        lastUsedAt: now,
        activeOperations: 0,
        status: 'retained',
        closed: false,
      };
      this.owners.set(owner.ownerId, owner);
      this.ownerIdsByKey.set(key, owner.ownerId);
    }
    clearTimeout(owner.timer);
    owner.timer = undefined;
    owner.activeOperations += 1;
    owner.lastUsedAt = Date.now();
    const held = owner;
    let released = false;
    return {
      ownerId: held.ownerId,
      release: () => {
        if (released) return;
        released = true;
        held.activeOperations -= 1;
        held.lastUsedAt = Date.now();
        if (held.closed || held.activeOperations > 0) return;
        if (held.status !== 'retained') {
          void this.closeOwner(held);
        } else if (held.retentionPolicy === 'idle') {
          held.timer = setTimeout(() => void this.closeOwner(held, 'idle'), held.idleTimeoutMs);
          held.timer.unref?.();
        }
      },
    };
  }

  list(scope: string, correlation?: string): RuntimeOwnerSummary[] {
    return [...this.owners.values()]
      .filter(
        (owner) =>
          owner.scope === scope && (correlation === undefined || owner.correlation === correlation),
      )
      .map((owner) => ({
        ownerId: owner.ownerId,
        serverName: owner.serverName,
        retentionPolicy: owner.retentionPolicy,
        createdAt: owner.createdAt,
        lastUsedAt: owner.lastUsedAt,
        ...(owner.detachedAt === undefined ? {} : { detachedAt: owner.detachedAt }),
        activeOperations: owner.activeOperations,
        status: owner.status,
      }));
  }

  async release(
    scope: string,
    ownerId: string,
  ): Promise<'released' | 'releasing' | 'not_found' | 'close_failed'> {
    const owner = this.owners.get(ownerId);
    if (!owner || owner.scope !== scope) return 'not_found';
    owner.closeReason = 'release';
    owner.status = 'releasing';
    clearTimeout(owner.timer);
    owner.timer = undefined;
    if (owner.activeOperations > 0) return 'releasing';
    return this.closeOwner(owner);
  }

  detach(correlation: string): void {
    for (const owner of this.owners.values()) {
      if (owner.correlation === correlation) owner.detachedAt ??= Date.now();
    }
  }

  /** New work may wait for automatic idle cleanup, but never overrides deliberate release. */
  waitForIdleClose(
    scope: string,
    correlation: string,
    serverName: string,
  ): Promise<void> | undefined {
    const id = this.ownerIdsByKey.get(JSON.stringify([scope, correlation, serverName]));
    const owner = id ? this.owners.get(id) : undefined;
    if (owner?.status !== 'releasing' || owner.closeReason !== 'idle' || !owner.closePromise)
      return undefined;
    return owner.closePromise.then((result) => {
      if (result === 'close_failed') throw new Error('Runtime owner cleanup failed; retry release');
      if (owner.closeReason !== 'idle')
        throw new Error('Runtime owner was deliberately released; retry the request');
    });
  }

  /** Intentional security/configuration invalidation may interrupt active calls. */
  async invalidate(filter: { serverName?: string } = {}): Promise<void> {
    const closes: Array<Promise<'released' | 'close_failed'>> = [];
    for (const owner of this.owners.values()) {
      if (filter.serverName !== undefined && owner.serverName !== filter.serverName) continue;
      owner.closeReason = 'invalidate';
      closes.push(this.closeOwner(owner));
    }
    const results = await Promise.all(closes);
    if (results.includes('close_failed')) {
      throw new Error('Failed to close one or more owned runtimes');
    }
  }

  private closeOwner(
    owner: RuntimeOwner,
    reason: 'idle' | 'release' = 'release',
  ): Promise<'released' | 'close_failed'> {
    if (owner.closed) return Promise.resolve('released');
    if (owner.closePromise) return owner.closePromise;
    owner.closeReason ??= reason;
    owner.status = 'releasing';
    clearTimeout(owner.timer);
    owner.closePromise = Promise.resolve()
      .then(() => this.close(owner.ownerId, owner.serverName))
      .then(() => {
        owner.closed = true;
        this.owners.delete(owner.ownerId);
        this.ownerIdsByKey.delete(owner.key);
        return 'released' as const;
      })
      .catch(() => {
        owner.status = 'close_failed';
        return 'close_failed' as const;
      })
      .finally(() => {
        owner.closePromise = undefined;
      });
    return owner.closePromise;
  }
}
