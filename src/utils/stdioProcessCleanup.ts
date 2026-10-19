import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

interface ProcessIdentity {
  pid: number;
  parent: number;
  started: string;
  state: string;
}

const readIdentity = (pid: number): ProcessIdentity | undefined => {
  try {
    // comm may itself contain spaces and parentheses; fields after the final
    // closing parenthesis start at the process state (field 3).
    const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = text
      .slice(text.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/);
    if (!fields[19] || !/^\d+$/.test(fields[19])) throw new Error('Invalid process identity');
    return { pid, parent: Number(fields[1]), started: fields[19], state: fields[0] };
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
    throw error;
  }
};

const captureTree = (root: number): ProcessIdentity[] => {
  const identity = readIdentity(root);
  if (!identity) return [];
  const all = new Map<number, ProcessIdentity>();
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const item = readIdentity(Number(entry));
      if (item) all.set(item.pid, item);
    } catch (error) {
      // Other users' process metadata may be inaccessible under hidepid. The
      // owned root was read above; its same-user descendants remain readable.
      if (!['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  const result = [identity];
  const seen = new Set([root]);
  for (let index = 0; index < result.length; index++) {
    for (const item of all.values()) {
      if (item.parent === result[index].pid && !seen.has(item.pid)) {
        seen.add(item.pid);
        result.push(item);
      }
    }
  }
  return result;
};

const stillRunning = (identity: ProcessIdentity): boolean => {
  const current = readIdentity(identity.pid);
  return !!current && current.started === identity.started && !['Z', 'X'].includes(current.state);
};

const signal = (identity: ProcessIdentity, value: NodeJS.Signals): void => {
  if (!stillRunning(identity)) return;
  try {
    process.kill(identity.pid, value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
};

const waitForExit = async (tree: ProcessIdentity[], milliseconds: number): Promise<boolean> => {
  const deadline = Date.now() + milliseconds;
  while (tree.some(stillRunning)) {
    if (Date.now() >= deadline) return false;
    await delay(Math.min(25, Math.max(1, deadline - Date.now())));
  }
  return true;
};

/**
 * Close an owned Linux stdio runtime and verify its captured descendants exit.
 * Snapshotting precedes transport closure, so a wrapper exiting first does not
 * prevent escalation of its surviving children. Start times guard PID reuse.
 * This is not process containment: arbitrary descendants created after the
 * snapshot require a process group/cgroup boundary for a strict guarantee.
 */
export async function closeTrackedStdioProcessTree(
  pid: number,
  close: () => Promise<void> | void,
  graceMs = 2000,
): Promise<void> {
  if (process.platform !== 'linux') throw new Error('Tracked stdio cleanup requires Linux /proc');
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) {
    throw new Error('Refusing to close an invalid stdio process owner');
  }
  if (!Number.isFinite(graceMs) || graceMs < 0 || graceMs > 60_000) {
    throw new Error('Invalid stdio shutdown grace period');
  }
  const tree = captureTree(pid);
  if (tree.some((item) => item.pid === process.pid)) {
    throw new Error('Refusing to close a tree containing the gateway');
  }
  // Convert synchronous errors too, and attach rejection handling immediately.
  // Transport shutdown and process termination proceed concurrently.
  const closing = Promise.resolve()
    .then(close)
    .then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
  for (const item of [...tree].reverse()) signal(item, 'SIGTERM');
  if (!(await waitForExit(tree, graceMs))) {
    for (const item of [...tree].reverse()) signal(item, 'SIGKILL');
    if (!(await waitForExit(tree, 1000))) throw new Error('Tracked stdio descendants did not exit');
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      closing,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Stdio transport close did not settle')), 3000);
      }),
    ]);
    if (!result.ok) throw result.error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
