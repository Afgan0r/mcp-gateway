import { RuntimeOwnerService } from '../../src/services/runtimeOwnerService.js';

const idle = {
  scope: 'verified-credential/principal/route',
  correlation: 'current-transport',
  serverName: 'stateful',
  retentionPolicy: 'idle' as const,
};

describe('runtime owner lifetimes', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('starts the default idle window after the last operation and never interrupts work', async () => {
    const close = jest.fn();
    const owners = new RuntimeOwnerService(close);
    const first = owners.acquire(idle);
    await jest.advanceTimersByTimeAsync(60 * 60 * 1000);
    const second = owners.acquire(idle);
    expect(first.ownerId).toBe(second.ownerId);
    first.release();
    first.release();
    await jest.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(close).not.toHaveBeenCalled();
    second.release();
    await jest.advanceTimersByTimeAsync(15 * 60 * 1000 - 1);
    expect(close).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(close).toHaveBeenCalledWith(first.ownerId, 'stateful');
    expect(owners.list(idle.scope)).toEqual([]);
  });

  test('resets idle time on activity and isolates credentials, routes, transports and servers', async () => {
    const close = jest.fn();
    const owners = new RuntimeOwnerService(close);
    const first = owners.acquire({ ...idle, idleTimeoutMs: 1000 });
    first.release();
    const others = [
      { ...idle, scope: 'another-verified-credential' },
      { ...idle, scope: 'another-verified-route' },
      { ...idle, correlation: 'another-transport' },
      { ...idle, serverName: 'another-server' },
    ].map((input) => owners.acquire({ ...input, retentionPolicy: 'explicit' }));
    expect(new Set([first.ownerId, ...others.map((item) => item.ownerId)]).size).toBe(5);
    await jest.advanceTimersByTimeAsync(900);
    const next = owners.acquire({ ...idle, idleTimeoutMs: 1000 });
    next.release();
    await jest.advanceTimersByTimeAsync(999);
    expect(close).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(close).toHaveBeenCalledTimes(1);
    others.forEach((item) => item.release());
    await owners.invalidate();
  });

  test('retains explicit owners after transport loss and beyond the legacy sweep duration', async () => {
    const close = jest.fn();
    const owners = new RuntimeOwnerService(close);
    const lease = owners.acquire({ ...idle, retentionPolicy: 'explicit' });
    lease.release();
    owners.detach(idle.correlation);
    await jest.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(close).not.toHaveBeenCalled();
    expect(owners.list(idle.scope)).toEqual([
      expect.objectContaining({ ownerId: lease.ownerId, detachedAt: expect.any(Number) }),
    ]);
    expect(await owners.release(idle.scope, lease.ownerId)).toBe('released');
    expect(close).toHaveBeenCalledTimes(1);
  });

  test('drains release, rejects new work during drain and leaves other owners untouched', async () => {
    const close = jest.fn();
    const owners = new RuntimeOwnerService(close);
    const active = owners.acquire(idle);
    const other = owners.acquire({ ...idle, correlation: 'other' });
    expect(await owners.release(idle.scope, active.ownerId)).toBe('releasing');
    expect(owners.list(idle.scope)[0].status).toBe('releasing');
    expect(() => owners.acquire(idle)).toThrow('releasing');
    expect(close).not.toHaveBeenCalled();
    active.release();
    await jest.advanceTimersByTimeAsync(0);
    expect(close).toHaveBeenCalledWith(active.ownerId, 'stateful');
    expect(owners.list(idle.scope).map((item) => item.ownerId)).toEqual([other.ownerId]);
    expect(await owners.release(idle.scope, active.ownerId)).toBe('not_found');
    other.release();
    await owners.invalidate();
  });

  test('does not expose correlation or credential scope and rejects cross-scope release', async () => {
    const owners = new RuntimeOwnerService(jest.fn());
    const lease = owners.acquire(idle);
    expect(owners.list('different')).toEqual([]);
    expect(await owners.release('different', lease.ownerId)).toBe('not_found');
    expect(owners.list(idle.scope)[0]).not.toHaveProperty('scope');
    expect(owners.list(idle.scope)[0]).not.toHaveProperty('correlation');
    lease.release();
    await owners.invalidate();
  });

  test('bounds retained admission and permits a fresh owner only after one is released', async () => {
    const owners = new RuntimeOwnerService(jest.fn(), 1);
    const lease = owners.acquire({ ...idle, retentionPolicy: 'explicit' });
    lease.release();
    expect(() => owners.acquire({ ...idle, correlation: 'next' })).toThrow('limit reached');
    await owners.release(idle.scope, lease.ownerId);
    const next = owners.acquire(idle);
    expect(next.ownerId).not.toBe(lease.ownerId);
    next.release();
    await owners.invalidate();
  });

  test('force invalidation closes matching active owners exactly once for shutdown/security', async () => {
    const close = jest.fn();
    const owners = new RuntimeOwnerService(close);
    const active = owners.acquire(idle);
    const other = owners.acquire({ ...idle, serverName: 'other' });
    await owners.invalidate({ serverName: idle.serverName });
    active.release();
    await jest.advanceTimersByTimeAsync(0);
    expect(close).toHaveBeenCalledTimes(1);
    expect(owners.list(idle.scope).map((item) => item.ownerId)).toEqual([other.ownerId]);
    await owners.invalidate();
    other.release();
    await owners.invalidate();
    await jest.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(close).toHaveBeenCalledTimes(2);
  });

  test('keeps an owner visible and counted until asynchronous cleanup really completes', async () => {
    let complete!: () => void;
    const close = jest.fn(() => new Promise<void>((resolve) => (complete = resolve)));
    const owners = new RuntimeOwnerService(close, 1);
    const lease = owners.acquire({ ...idle, retentionPolicy: 'explicit' });
    lease.release();
    const closing = owners.release(idle.scope, lease.ownerId);
    await jest.advanceTimersByTimeAsync(0);
    expect(owners.list(idle.scope)[0].status).toBe('releasing');
    expect(() => owners.acquire({ ...idle, correlation: 'new' })).toThrow('limit reached');
    complete();
    expect(await closing).toBe('released');
    expect(owners.list(idle.scope)).toEqual([]);
  });

  test('keeps failed cleanup visible, rejects new leases and permits deliberate retry', async () => {
    const close = jest
      .fn()
      .mockRejectedValueOnce(new Error('close failed'))
      .mockResolvedValue(undefined);
    const owners = new RuntimeOwnerService(close);
    const lease = owners.acquire(idle);
    lease.release();
    expect(await owners.release(idle.scope, lease.ownerId)).toBe('close_failed');
    expect(owners.list(idle.scope)[0].status).toBe('close_failed');
    expect(() => owners.acquire(idle)).toThrow('cleanup failed');
    expect(await owners.release(idle.scope, lease.ownerId)).toBe('released');
    expect(close).toHaveBeenCalledTimes(2);
    expect(owners.list(idle.scope)).toEqual([]);
  });

  test('does not infer old owner identity when a new transport appears', async () => {
    const owners = new RuntimeOwnerService(jest.fn());
    const old = owners.acquire({ ...idle, retentionPolicy: 'explicit' });
    old.release();
    owners.detach(idle.correlation);
    const next = owners.acquire({
      ...idle,
      correlation: 'recreated-manager',
      retentionPolicy: 'explicit',
    });
    expect(next.ownerId).not.toBe(old.ownerId);
    expect(owners.list(idle.scope)).toHaveLength(2);
    next.release();
    await owners.invalidate();
  });

  test('does not resume an idle-close waiter after deliberate release supersedes cleanup', async () => {
    let finish!: () => void;
    const owners = new RuntimeOwnerService(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    const lease = owners.acquire({ ...idle, idleTimeoutMs: 1000 });
    lease.release();
    await jest.advanceTimersByTimeAsync(1000);
    const waiting = owners.waitForIdleClose(idle.scope, idle.correlation, idle.serverName)!;
    const outcome = waiting.catch((error: Error) => error.message);
    const released = owners.release(idle.scope, lease.ownerId);
    finish();
    expect(await released).toBe('released');
    expect(await outcome).toContain('deliberately released');
  });
});
