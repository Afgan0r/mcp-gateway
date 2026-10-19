import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { closeTrackedStdioProcessTree } from '../../src/utils/stdioProcessCleanup.js';

const describeLinux = process.platform === 'linux' ? describe : describe.skip;

describeLinux('tracked Linux stdio cleanup', () => {
  let root: ChildProcess | undefined;
  let descendant: number | undefined;

  const isRunning = (pid: number): boolean => {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      return !['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  };

  afterEach(() => {
    if (descendant && isRunning(descendant)) process.kill(descendant, 'SIGKILL');
    if (root?.pid && isRunning(root.pid)) root.kill('SIGKILL');
    root = undefined;
    descendant = undefined;
  });

  it('kills a SIGTERM-resistant descendant even after the wrapper exits', async () => {
    root = spawn(process.execPath, [path.resolve('tests/fixtures/stubborn-process-tree.mjs')], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    descendant = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Fixture did not become ready')), 5000);
      root!.once('error', reject);
      root!.once('message', (value: { pid: number }) => {
        clearTimeout(timeout);
        resolve(value.pid);
      });
    });
    const wrapper = root;
    let exited = false;
    wrapper.once('exit', () => {
      exited = true;
    });
    await closeTrackedStdioProcessTree(
      wrapper.pid!,
      async () => {
        if (exited) return;
        await new Promise<void>((resolve) => wrapper.once('exit', () => resolve()));
      },
      100,
    );
    expect(exited).toBe(true);
    expect(isRunning(descendant)).toBe(false);
    expect(isRunning(wrapper.pid!)).toBe(false);
  });

  it('rejects cleanup of the current process before invoking transport close', async () => {
    const close = jest.fn();
    await expect(closeTrackedStdioProcessTree(process.pid, close)).rejects.toThrow('invalid stdio');
    expect(close).not.toHaveBeenCalled();
  });
});
