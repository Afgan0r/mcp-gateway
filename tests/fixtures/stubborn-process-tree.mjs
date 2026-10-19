import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.argv[2] === 'descendant') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
  if (process.send) process.send({ ready: true });
} else {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'descendant'], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  child.once('message', () => {
    if (process.send) process.send({ pid: child.pid });
  });
  process.on('SIGTERM', () => process.exit(0));
}
