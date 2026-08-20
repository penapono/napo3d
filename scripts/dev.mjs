import { spawn } from 'node:child_process';

const commands = [
  { label: 'front', cmd: 'pnpm', args: ['run', 'dev:front'] },
  { label: 'back', cmd: 'pnpm', args: ['run', 'dev:back'] }
];

const children = commands.map(({ label, cmd, args }) => {
  const child = spawn(cmd, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });

  child.on('exit', (code, signal) => {
    if (signal || code === 0) return;
    console.error(`[${label}] exited with code ${code}`);
    shutdown(code || 1);
  });

  return child;
});

let shuttingDown = false;

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(exitCode), 200);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
