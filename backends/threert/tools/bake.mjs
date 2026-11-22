#!/usr/bin/env node
// Bake the heavy, determinism-sensitive parts of the world in Node (V8) for the ThreeRT backend, so QuickJS
// (10-30x slower, ulp-different Math.sin/exp/pow) only has to load them.
//
//   node backends/threert/tools/bake.mjs --seed 1337 --quality HIGH
//
// Outputs (both gitignored, see backends/threert/.gitignore):
//   backends/threert/generated/bake.json      what was baked: params, core modules found/missing, layoutHash
//   backends/threert/generated/hills.json     hills + ponds of the seed (core/layout/hills.ts)       [needs core/layout]
//   backends/threert/generated/layout.json    SceneDesc without pixels: materials, meshes, instances, hull, dynamics,
//   backends/threert/generated/layout.bin     views ...; typed arrays live in layout.bin as {"$ta","offset","length"}
//                                                                                                   [needs core/scene/build.ts]
//   backends/threert/generated/textures.json  id -> file, size, colour space, wrap, mipmaps, anisotropy, source key
//   backends/threert/assets/tex/<id>.png      every image of the scene, RGBA8, row 0 = top (origin 'top-left')
//                                                                                                   [needs core/textures/registry.ts]
//
// Status of the core pieces is probed at run time. Whatever is missing is listed and skipped (exit 0): with no
// core/scene/build.ts the textures are still baked from the registry's standardImages() (ponds from core/layout);
// with no registry nothing is baked and the script only reports. Core is TypeScript: Node >= 22.18 strips the types.
//
// Options: --seed N (1337)  --quality LOW|HIGH|ULTRAM|ULTRA (HIGH)  --season summer|spring|autumn|winter
//          --saturation X  --green-k X  --out DIR (generated)  --tex DIR (assets/tex)
//          --force (re-encode unchanged PNGs)  --no-geometry (leave SceneDesc.geometries out of layout.json)
//          --dry-run (probe + print the plan only)
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { encodePng } from './lib/png.mjs';
import { bakeAmbience } from './lib/runtime-assets.mjs';
import { byteHash } from '../src/layout-hash.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND = resolve(HERE, '..');                 // backends/threert
const ROOT = resolve(BACKEND, '..', '..');           // repo root

// ── arguments ────────────────────────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const opt = { seed: null, quality: 'HIGH', season: 'summer', saturation: null, greenK: null,
  out: join(BACKEND, 'generated'), tex: join(BACKEND, 'assets', 'tex'), force: false, geometry: true, dryRun: false };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const next = () => { if (i + 1 >= args.length) die(`missing value after ${a}`); return args[++i]; };
  if (a === '--milestone') {
    opt.milestone = Number(next());
    if (![1, 2, 3, 4].includes(opt.milestone)) die('milestone must be 1, 2, 3 or 4');
    continue;
  }
  if (a === '--seed') opt.seed = Number(next());
  else if (a === '--quality') opt.quality = next().toUpperCase();
  else if (a === '--season') opt.season = next();
  else if (a === '--saturation') opt.saturation = Number(next());
  else if (a === '--green-k') opt.greenK = Number(next());
  else if (a === '--out') opt.out = resolve(next());
  else if (a === '--tex') opt.tex = resolve(next());
  else if (a === '--force') opt.force = true;
  else if (a === '--no-geometry') opt.geometry = false;
  else if (a === '--dry-run') opt.dryRun = true;
  else if (a === '-h' || a === '--help') { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n')); process.exit(0); }
  else die(`unknown argument ${a}`);
}
function die(msg) { console.error(`bake: ${msg}`); process.exit(1); }

// ── probing the core modules ───────────────────────────────────────────────────────────────────────────
async function probe(rel, need) {
  const file = resolve(ROOT, rel);
  if (!existsSync(file)) return { rel, ok: false, why: 'file does not exist yet' };
  try {
    const mod = await import(pathToFileURL(file).href);
    for (const n of need) if (typeof mod[n] === 'undefined') return { rel, ok: false, why: `does not export ${n}` };
    return { rel, ok: true, mod };
  } catch (e) {
    return { rel, ok: false, why: `failed to load: ${e && e.message ? e.message.split('\n')[0] : e}`, error: true };
  }
}

const cfgP = await probe('core/config/index.ts', ['CORE_CONFIG']);
if (!cfgP.ok) die(`${cfgP.rel}: ${cfgP.why}`);
const CORE_CONFIG = cfgP.mod.CORE_CONFIG;
if (opt.seed === null) opt.seed = CORE_CONFIG.SEED_DEFAULT;
if (opt.saturation === null) opt.saturation = CORE_CONFIG.SATURATION_DEFAULT;
if (opt.greenK === null) opt.greenK = CORE_CONFIG.GREEN_K_DEFAULT;
if (!Number.isFinite(opt.seed)) die('--seed must be a number');
if (!(opt.quality in CORE_CONFIG.QUALITY)) die(`--quality must be one of ${Object.keys(CORE_CONFIG.QUALITY).join(', ')}`);
if (!(opt.season in CORE_CONFIG.SEASONS)) die(`--season must be one of ${Object.keys(CORE_CONFIG.SEASONS).join(', ')}`);

const [rngP, hillsP, buildP, regP] = await Promise.all([
  probe('core/rng.ts', ['mulberry32']),
  probe('core/layout/hills.ts', ['placeHills', 'pondsOf']),
  probe('core/scene/build.ts', ['buildScene']),
  probe('core/textures/registry.ts', ['generateImage', 'standardImages', 'specKey']),
]);
const probes = [rngP, hillsP, buildP, regP];
const params = { seed: opt.seed, quality: opt.quality, season: opt.season, saturation: opt.saturation, greenK: opt.greenK };

console.log(`bake: seed ${params.seed}, quality ${params.quality}, season ${params.season}`);
for (const p of probes) console.log(`  ${p.ok ? 'found  ' : 'MISSING'} ${p.rel}${p.ok ? '' : `  (${p.why})`}`);

const missing = probes.filter(p => !p.ok);
const hasBuild = buildP.ok, hasTex = regP.ok && rngP.ok, hasHills = hillsP.ok && rngP.ok;
const plan = [
  hasHills ? 'hills.json' : null,
  hasBuild ? 'layout.json + layout.bin' : null,
  hasTex ? (hasBuild ? 'textures from SceneDesc.images' : `textures from standardImages (ponds ${hasHills ? 'from core/layout' : 'unavailable'})`) : null,
].filter(Boolean);
console.log(`  plan: ${plan.length ? plan.join('; ') : 'nothing (every core module is missing)'}`);
if (!hasBuild) console.log('  waiting on core/scene/build.ts buildScene(params): SceneDesc layout (layout.json/bin) is NOT baked; the texture set is the registry standard set.');
if (opt.dryRun || !plan.length) {
  if (missing.length) console.log(`bake: ${missing.length} core module(s) missing, nothing written.`);
  process.exit(missing.some(m => m.error) ? 1 : 0);
}

mkdirSync(opt.out, { recursive: true });
mkdirSync(opt.tex, { recursive: true });
const t0 = Date.now();
const rel = (p) => relative(BACKEND, p).split('\\').join('/');
const bake = { tool: 'backends/threert/tools/bake.mjs', params, modules: Object.fromEntries(probes.map(p => [p.rel, p.ok ? 'found' : p.why])), written: [] };
const sha = (s) => createHash('sha1').update(s).digest('hex').slice(0, 16);

// ── hills / ponds (core/layout) ──────────────────────────────────────────────────────────────────────
let hills = null, ponds = [];
if (hasHills) {
  const { mulberry32 } = rngP.mod, { placeHills, pondsOf } = hillsP.mod;
  hills = placeHills(mulberry32(params.seed + 404), CORE_CONFIG.R, CORE_CONFIG.L);   // js/world.js: SEED + 404
  ponds = pondsOf(hills);
  const f = join(opt.out, 'hills.json');
  writeFileSync(f, JSON.stringify({ seed: params.seed, R: CORE_CONFIG.R, L: CORE_CONFIG.L, dipDepth: CORE_CONFIG.HILL.dipDepth, hills, ponds }, null, 1));
  bake.written.push(rel(f));
  console.log(`  hills.json: ${hills.length} hills (${hills.filter(h => h.dip).length} dips)`);
}

// ── SceneDesc layout (core/scene/build.ts) ────────────────────────────────────────────────────────────
let images = null;
if (hasBuild) {
  const scene = await buildP.mod.buildScene(params);
  images = scene.images;
  const blobs = []; let blobLen = 0;
  const walk = (v) => {
    if (v === null || v === undefined) return v === undefined ? undefined : null;
    if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
      const pad = (8 - (blobLen % 8)) % 8;
      if (pad) { blobs.push(Buffer.alloc(pad)); blobLen += pad; }
      const bytes = Buffer.from(v.buffer, v.byteOffset, v.byteLength);
      const ref = { $ta: v.constructor.name, offset: blobLen, length: v.length };
      blobs.push(bytes); blobLen += bytes.length;
      return ref;
    }
    if (Array.isArray(v)) return v.map(x => { const w = walk(x); return w === undefined ? null : w; });
    if (typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v)) { const w = walk(v[k]); if (w !== undefined) o[k] = w; }
      return o;
    }
    if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('non-finite number in SceneDesc');
    return v;
  };
  const layout = {};
  for (const k of Object.keys(scene)) {
    if (k === 'images') {                       // pixels are PNGs; keep the descriptors only
      layout.images = Object.fromEntries(Object.entries(scene.images).map(([id, d]) => { const { data, ...rest } = d; return [id, rest]; }));
    } else if (k === 'geometries' && !opt.geometry) layout.geometries = '(omitted: --no-geometry)';
    else layout[k] = walk(scene[k]);
  }
  const jf = join(opt.out, 'layout.json'), bf = join(opt.out, 'layout.bin');
  writeFileSync(jf, JSON.stringify(layout));
  const packedBytes = Buffer.concat(blobs);
  writeFileSync(bf, packedBytes);
  if (opt.geometry) {
    const src = 'export const description: string = ' + JSON.stringify(JSON.stringify(layout)) + ';\n'
      + 'export const packed: string = "' + packedBytes.toString('base64') + '";\n'
      + 'export const expectedBytes: string = "' + byteHash(packedBytes) + '";\n';
    writeFileSync(join(opt.out, 'station.ts'), src + 'export const milestone: number = ' + (opt.milestone ?? 4) + ';\n');
  }
  bake.layoutHash = scene.layoutHash; bake.written.push(rel(jf), rel(bf));
  console.log(`  layout.json ${(statSync(jf).size / 1048576).toFixed(2)} MiB + layout.bin ${(statSync(bf).size / 1048576).toFixed(2)} MiB, layoutHash ${scene.layoutHash}`);
}

// ── textures (core/textures registry) ─────────────────────────────────────────────────────────────────
if (hasTex) {
  const { generateImage, standardImages, specKey } = regP.mod;
  if (!images) images = standardImages({ seed: params.seed, quality: params.quality, ponds });
  const manifestFile = join(opt.out, 'textures.json');
  let old = {};
  try { old = JSON.parse(readFileSync(manifestFile, 'utf8')).images || {}; } catch { /* first bake */ }
  const manifest = {};
  let encoded = 0, reused = 0, bytes = 0;
  /* buildScene may reference a source image by id (a string, e.g. panel.normal -> src: 'panel') where the registry
     wants the nested TextureSpec: resolve ids through the scene's own image table. */
  const resolveSpec = (s, depth = 0) => {
    if (depth > 8) throw new Error('bake: image source cycle');
    const args = { ...s.args };
    for (const k of ['src', 'mask']) {
      if (typeof args[k] === 'string') {
        const ref = images[args[k]];
        if (!ref) throw new Error(`bake: ${s.gen} references unknown image '${args[k]}'`);
        args[k] = resolveSpec(ref.source, depth + 1);
      } else if (args[k] && typeof args[k] === 'object') args[k] = resolveSpec(args[k], depth + 1);
    }
    return { gen: s.gen, args };
  };
  for (const [id, desc0] of Object.entries(images)) {
    const desc = { ...desc0, source: resolveSpec(desc0.source) };
    const key = sha(specKey(desc.source));
    const file = join(opt.tex, `${id.replace(/[^A-Za-z0-9._-]/g, '_')}.png`);
    const entry = { file: rel(file), width: desc.width, height: desc.height, colorSpace: desc.colorSpace, wrap: desc.wrap,
      mipmaps: desc.mipmaps, anisotropyHint: desc.anisotropyHint, origin: desc.origin, key };
    if (!opt.force && old[id] && old[id].key === key && old[id].width === desc.width && existsSync(file)) {
      reused++;
    } else {
      const px = desc.data && desc.data.length === desc.width * desc.height * 4 ? desc.data : generateImage(desc.source).data;
      const png = encodePng(desc.width, desc.height, px);
      writeFileSync(file, png);
      encoded++; bytes += png.length;
    }
    manifest[id] = entry;
  }
  writeFileSync(manifestFile, JSON.stringify({ params, images: manifest }, null, 1));
  bake.written.push(rel(manifestFile));
  console.log(`  textures: ${Object.keys(manifest).length} images -> ${rel(opt.tex)}/ (${encoded} encoded, ${reused} unchanged, ${(bytes / 1048576).toFixed(1)} MiB written)`);
}

if (opt.out === join(BACKEND, 'generated')) {
  bakeAmbience(join(BACKEND, 'assets', 'sound'));
  const sdk = process.env.THREERT_SDK ?? join(process.env.LOCALAPPDATA ?? '', 'threert-portable', 'ThreeRT', 'Resources', 'sdk', 'engine');
  writeFileSync(join(opt.out, 'sdk.json'), JSON.stringify({
    compilerOptions: {
      paths: Object.fromEntries(['scene', 'gameplay'].map(name =>
        ['@threert/' + name, [join(sdk, 'packages', name, 'src', 'index.ts')]]))
    }
  }, null, 2));
}
writeFileSync(join(opt.out, 'bake.json'), JSON.stringify(bake, null, 1));
console.log(`bake: done in ${((Date.now() - t0) / 1000).toFixed(1)} s${missing.length ? `; still waiting on: ${missing.map(m => m.rel).join(', ')}` : ''}`);
