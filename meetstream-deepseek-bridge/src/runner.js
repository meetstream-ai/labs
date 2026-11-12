// Keep the CLI in this owned process group and terminate it if the bridge disappears.
import { spawn } from 'node:child_process';
if (!process.send) throw new Error('Harness runner requires its parent IPC channel');
const [bin, ...args] = process.argv.slice(2);
let child;
process.on('disconnect', () => {
  if (process.platform !== 'win32') {
    try {
      process.kill(-process.pid, 'SIGKILL');
    } catch {}
  }
  child?.kill('SIGKILL');
  process.exit(1);
});
child = spawn(bin, args, { stdio: 'inherit' });
child.once('error', () => {
  console.error('Harness executable could not start');
  process.exit(127);
});
child.once('exit', (code) => process.exit(code ?? 1));
