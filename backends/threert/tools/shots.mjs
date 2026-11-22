#!/usr/bin/env node
// Capture 9 ThreeRT viewpoints in 3 phases and compare them with backends/threert/shots/ref
// with the mean CIE76 delta E (alpha ignored).
//
//   node backends/threert/tools/shots.mjs --dry-run                    # only print the commands
//   node backends/threert/tools/shots.mjs --views 0,3 --phases DAY     # shoot + diff
//   node backends/threert/tools/shots.mjs --write-ref                  # promote the new shots to the references
//   node backends/threert/tools/shots.mjs --project backends/threert/spike --views 0 --phases none --out <dir>
//                                                                      # pipeline proof on the spike scene
//
// Per phase:  threert event <phase-handler> '{"phase":"DAY"}'   (the game must define that handler; `--phases none`
//                                                                skips it)
// Per view:   threert event setView '{"view":0,"fov":62}' for the native station (preserves station roll);
//             threert camera '{"position":[x,y,z],"target":[x,y,z],"fov":62}' for other projects.
//             threert shot -o <out>/<name>.png --history 32
// In launch {"shots":true}, the native station freezes movement and accepts the requested view.
// Views are CORE_CONFIG.TP converted to station-local xyz.
// Windows 0.4.3 has no offline renderer: `shot` is the live frame after --history accumulated frames, and frame
// times depend on free VRAM (see README spike results). Keep runs short; the client is quit at the end unless --keep.
// Never runs publish / login / pair / unpublish (refused below).
//
// Options: --project DIR (backends/threert)  --views all|0,1,..  --phases DAY,DUSK,NIGHT|none  --out DIR
//          (backends/threert/shots/out)  --ref DIR (backends/threert/shots/ref)  --threshold N (6, mean delta E)
//          --history N (32)  --fov DEG (62, legacy camera)  --phase-handler NAME (setPhase)  --launch JSON
//          ({"shots":true})  --no-open  --keep  --write-ref  --dry-run  --timeout SEC (240, per command)
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodePng, encodePng, deltaE } from './lib/png.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND = resolve(HERE, '..');
const ROOT = resolve(BACKEND, '..', '..');
const EXE = join(process.env.LOCALAPPDATA || '', 'threert-portable', 'ThreeRT', 'bin', 'threert.exe');
const FORBIDDEN = new Set(['publish', 'unpublish', 'login', 'logout', 'pair', 'unpair']);

const opt = { project: BACKEND, views: 'all', phases: 'DAY,DUSK,NIGHT', out: join(BACKEND, 'shots', 'out'), ref: join(BACKEND, 'shots', 'ref'),
  threshold: 6, history: 32, fov: 62, phaseHandler: 'setPhase', launch: '{"shots":true}', open: true, keep: false, writeRef: false,
  dryRun: false, timeout: 240 };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => { if (i + 1 >= argv.length) die(`missing value after ${a}`); return argv[++i]; };
  if (a === '--project') opt.project = resolve(next());
  else if (a === '--views') opt.views = next();
  else if (a === '--phases') opt.phases = next();
  else if (a === '--out') opt.out = resolve(next());
  else if (a === '--ref') opt.ref = resolve(next());
  else if (a === '--threshold') opt.threshold = Number(next());
  else if (a === '--history') opt.history = Number(next());
  else if (a === '--fov') opt.fov = Number(next());
  else if (a === '--phase-handler') opt.phaseHandler = next();
  else if (a === '--launch') opt.launch = next();
  else if (a === '--timeout') opt.timeout = Number(next());
  else if (a === '--no-open') opt.open = false;
  else if (a === '--keep') opt.keep = true;
  else if (a === '--write-ref') opt.writeRef = true;
  else if (a === '--dry-run') opt.dryRun = true;
  else if (a === '-h' || a === '--help') { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n')); process.exit(0); }
  else die(`unknown argument ${a}`);
}
function die(msg) { console.error(`shots: ${msg}`); process.exit(1); }
if (!Number.isSafeInteger(opt.history) || opt.history < 0) die('--history must be a nonnegative integer');

// ── views from core ─────────────────────────────────────────────────────────────────────────────────
const { CORE_CONFIG } = await import(pathToFileURL(join(ROOT, 'core/config/index.ts')).href);
const { tpVec } = await import(pathToFileURL(join(BACKEND, 'src/sim/camera.ts')).href);
const { positionToEngine } = await import(pathToFileURL(join(BACKEND, 'src/sim/units.ts')).href);
const TP = CORE_CONFIG.TP;
const viewIdx = opt.views === 'all' ? TP.map((_, i) => i) : opt.views.split(',').map(Number);
if (viewIdx.some(i => !Number.isInteger(i) || i < 0 || i >= TP.length)) die(`--views must be 'all' or indices 0..${TP.length - 1}`);
const phases = opt.phases === 'none' ? [null] : opt.phases.split(',').map(s => s.trim().toUpperCase());
for (const p of phases) if (p !== null && !CORE_CONFIG.PHASES.includes(p)) die(`unknown phase ${p} (${CORE_CONFIG.PHASES.join(', ')})`);

const cameraJson = (i) => JSON.stringify({
  position: positionToEngine(tpVec(TP[i].pos)).map(round), target: positionToEngine(tpVec(TP[i].look)).map(round), fov: opt.fov });
function round(v) { return Math.round(v * 1e4) / 1e4; }
const shotName = (i, p) => `view${i}_${p ?? 'static'}`;

// ── running the CLI ──────────────────────────────────────────────────────────────────────────────────
function run(cliArgs, { allowFail = false, quiet = false } = {}) {
  if (cliArgs.some(a => FORBIDDEN.has(a)) || FORBIDDEN.has(cliArgs[0])) die(`refusing to run threert ${cliArgs[0]}`);
  const shown = cliArgs.map(a => (/[\s{"']/.test(a) ? `'${a}'` : a)).join(' ');
  if (!quiet) console.log(`${opt.dryRun ? '[dry-run] ' : '> '}threert ${shown}`);
  if (opt.dryRun) return { status: 0, stdout: '' };
  const r = spawnSync(EXE, cliArgs, { encoding: 'utf8', timeout: opt.timeout * 1000, cwd: opt.project });
  if (r.error) die(`threert ${cliArgs[0]}: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) { console.error((r.stdout || '') + (r.stderr || '')); die(`threert ${cliArgs[0]} exited ${r.status}`); }
  return r;
}

// The Windows client can keep temporal history after a view or phase edit.
async function waitForFreshFrames() {
  if (opt.dryRun) return;
  function frame() {
    const status = JSON.parse(run(['status', '--json'], { quiet: true }).stdout);
    if (!Number.isSafeInteger(status.frame)) throw new Error('ThreeRT did not report a rendered frame');
    return status.frame;
  }
  const target = frame() + opt.history;
  const deadline = Date.now() + opt.timeout * 1000;
  while (Date.now() < deadline) {
    await wait(500);
    if (frame() >= target) return;
  }
  throw new Error('ThreeRT did not render ' + opt.history + ' fresh frames before timeout');
}

if (!opt.dryRun && !existsSync(EXE)) die(`ThreeRT client not found at ${EXE}`);
if (!existsSync(join(opt.project, 'threert.config.json')) && !existsSync(join(opt.project, 'game.ts'))) {
  const msg = `no ThreeRT game project at ${opt.project} (no threert.config.json / game.ts yet: the native backend is not written). Use --project backends/threert/spike for a pipeline check.`;
  if (opt.dryRun) console.log(`note: ${msg}`); else die(msg);
}

mkdirSync(opt.out, { recursive: true });
console.log(`shots: ${viewIdx.length} view(s) x ${phases.length} phase(s) -> ${opt.out}; reference ${opt.ref}; threshold mean dE ${opt.threshold}`);

const results = [];
let opened = false;
try {
  if (opt.open) { run(['open', opt.project, '--launch', opt.launch]); opened = true; }
  for (const p of phases) {
    if (p) run(['event', opt.phaseHandler, JSON.stringify({ phase: p })]);
    for (const i of viewIdx) {
      const name = shotName(i, p), file = join(opt.out, `${name}.png`);
      // The CLI position+target view loses cylinder roll. Our game sets its
      // station-frame quaternion from the same external viewpoint request.
      if (opt.project === BACKEND) {
        run(['event', 'setView', JSON.stringify({ view: i, fov: opt.fov })]);
        await waitForFreshFrames();
      } else run(['camera', cameraJson(i)]);
      run(['shot', '-o', file, '--history', String(opt.history)]);
      results.push({ name, file, view: TP[i].name });
    }
  }
} finally {
  if (opened && !opt.keep) run(['quit'], { allowFail: true });
}

// ── diff against the references ──────────────────────────────────────────────────────────────────────
if (opt.dryRun) { console.log('shots: dry run, nothing shot.'); process.exit(0); }
let failed = 0;
console.log('\nname'.padEnd(20) + 'mean dE'.padStart(10) + 'p95'.padStart(8) + 'max'.padStart(8) + '  status');
for (const r of results) {
  if (!existsSync(r.file)) { console.log(`${r.name.padEnd(19)} no shot file written`); failed++; continue; }
  const refFile = join(opt.ref, `${r.name}.png`);
  if (opt.writeRef) {
    mkdirSync(opt.ref, { recursive: true }); copyFileSync(r.file, refFile);
    console.log(`${r.name.padEnd(19)} ${'-'.padStart(9)}${'-'.padStart(8)}${'-'.padStart(8)}  reference written`);
    continue;
  }
  if (!existsSync(refFile)) { console.log(`${r.name.padEnd(19)} ${'-'.padStart(9)}${'-'.padStart(8)}${'-'.padStart(8)}  no reference (use --write-ref)`); continue; }
  try {
    const d = deltaE(decodePng(readFileSync(r.file)), decodePng(readFileSync(refFile)));
    const ok = d.mean <= opt.threshold;
    if (!ok) failed++;
    writeFileSync(join(opt.out, `${r.name}.diff.png`), encodePng(...diffArgs(r.file, d)));
    console.log(`${r.name.padEnd(19)} ${d.mean.toFixed(2).padStart(9)}${d.p95.toFixed(1).padStart(8)}${d.max.toFixed(1).padStart(8)}  ${ok ? 'ok' : 'FAIL'}`);
  } catch (e) { failed++; console.log(`${r.name.padEnd(19)} ${e.message}`); }
}
function diffArgs(file, d) { const im = decodePng(readFileSync(file)); return [im.width, im.height, d.diff]; }
process.exit(failed ? 1 : 0);
