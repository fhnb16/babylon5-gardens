import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLayout } from '../src/layout.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const path of readdirSync(join(root, 'src'), { recursive: true }).filter(p => p.endsWith('.ts'))) {
  const code = readFileSync(join(root, 'src', path), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  if (/\b(?:window|document|setTimeout|setInterval|TextEncoder|structuredClone|fetch|process|Intl)\b|['"]node:/.test(code)) {
    throw new Error('QuickJS-incompatible global or import in ' + path);
  }
}
const baked = JSON.parse(readFileSync(join(root, 'generated', 'bake.json'), 'utf8'));
const scene = loadLayout();
if (scene.layoutHash !== baked.layoutHash) throw new Error('Baked layout hash mismatch');
const cli = process.env.THREERT_CLI ?? join(process.env.LOCALAPPDATA, 'threert-portable', 'ThreeRT', 'bin', 'threert.exe');
for (const [command, args] of [[process.execPath, ['tools/check-materials.mjs']], [cli, ['check']]]) {
  const r = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 180000, windowsHide: true });
  process.stdout.write(r.stdout ?? '');
  process.stderr.write(r.stderr ?? '');
  if (r.error) throw r.error;
  if (r.status !== 0) process.exit(r.status ?? 1);
  if (command === cli && !r.stdout.includes('Station layout ' + scene.layoutHash)) {
    throw new Error('Native runtime did not confirm the V8 layout hash');
  }
}
console.log('Baked layout verified: ' + scene.layoutHash);
