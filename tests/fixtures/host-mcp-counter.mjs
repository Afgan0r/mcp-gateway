import readline from 'node:readline';
import { spawn } from 'node:child_process';

let count = 0;
const child =
  process.argv[2] === 'tree'
    ? spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], {
        stdio: 'ignore',
      })
    : undefined;
if (child) process.on('SIGTERM', () => process.exit(0));
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (line === 'exit') {
    process.stdout.write('final bytes\n', () => process.exit(7));
    return;
  }
  if (line === 'stderr') {
    process.stderr.write('fixture diagnostic\n');
    return;
  }
  process.stdout.write(
    JSON.stringify({
      count: ++count,
      pid: process.pid,
      descendant: child?.pid,
      explicit: process.env.BRIDGE_EXPLICIT,
      unrelated: process.env.BRIDGE_UNRELATED ?? null,
      line,
    }) + '\n',
  );
});
setInterval(() => {}, 1000);
