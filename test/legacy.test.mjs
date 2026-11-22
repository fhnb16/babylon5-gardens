/* Старый набор test.mjs (~1250 проверок) запускается как есть, отдельным
   процессом того же node: он сам ставит заглушки DOM и пишет «ok/FAIL» в
   stdout. Переписывать его под vitest незачем — достаточно кода выхода. */
import { test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

test('legacy test.mjs passes', () => {
  const r = spawnSync(process.execPath, ['test.mjs'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  if (r.status !== 0) {
    const failing = out.split(/\r?\n/).filter(l => /FAIL|Error|error/.test(l));
    console.error(`test.mjs exit ${r.status}${r.signal ? ` (${r.signal})` : ''}\n` +
      (failing.length ? failing.join('\n') : out.slice(-4000)));
  }
  expect(r.error, String(r.error)).toBeUndefined();
  expect(r.status).toBe(0);
}, 600_000);
