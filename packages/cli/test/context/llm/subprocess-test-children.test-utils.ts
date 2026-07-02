import { spawn, type ChildProcess } from 'node:child_process';

// A wedged subprocess-backed call: the child ignores SIGTERM (as a child hung on a
// provider socket does), spawns a grandchild (the SDK's model binary stand-in) that
// also ignores SIGTERM, and never replies. Only a SIGKILL of the whole process group
// reaps it.
export const HANGING_CHILD = `
process.on('SIGTERM', () => {});
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
process.on('message', () => {
  const gc = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000000)'], { stdio: 'ignore' });
  gc.unref();
  if (process.env.KTX_TEST_GC_PID_FILE) writeFileSync(process.env.KTX_TEST_GC_PID_FILE, String(gc.pid));
});
`;

export const RESPONDING_CHILD = `
process.on('message', () => {
  const raw = process.env.KTX_TEST_RESPONSE || '{"ok":true,"output":{"answer":"yes"}}';
  process.send(JSON.parse(raw), () => process.exit(0));
});
`;

export function spawnTestChild(registry: ChildProcess[], code: string, env: Record<string, string> = {}): ChildProcess {
  const child = spawn(process.execPath, ['-e', code], {
    detached: true,
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    env: { ...process.env, ...env },
  });
  registry.push(child);
  return child;
}

export function killTestChildren(registry: ChildProcess[]): void {
  for (const child of registry) {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Already exited.
      }
    }
  }
}
