/* Browser entry of the surface smoke (pt-surface.html, PT-U3):
   1. buildScene(seed 1337, HIGH) → uploadSceneDesc (BVH worker pool, texture
      worker pool, GPU mips) — timings logged;
   2. primary rays of TP view 0 at 640×360 → B5's k_intersect;
   3. debug kernel pt-surface.wgsl calls b5_surface → AOV records;
   4. surface-ref.ts on 2,000 random hit pixels, metrics vs tolerances;
   5. AOV images (albedo, normal, emission, roughness) as PNG data URLs;
   6. upload timing runs for the other qualities (?timings=HIGH,ULTRA).
   Publishes window.__ptSurface for Playwright (tests/browser/pt-surface.spec.ts). */
import { buildScene, defaultParams } from '../../core/scene/build.ts';
import type { QualityId } from '../../core/scene/types.ts';
import { lightingAt } from '../../core/lighting/phases.ts';
import { mulberry32 } from '../../core/rng.ts';
import { createTexturePool } from '../../app/workers/texturePool.ts';
import { createBvhPool, VIS_CAMERA } from '../bvh/index.ts';
import { createDevice, describeDevice } from '../device.ts';
import { BUFFER, STAGE } from '../gpu-flags.ts';
import { readBuffer } from '../gpu-scene.ts';
import {
  buildKernelSource, compileShader, createKernels, createTraceBatch, dispatchSize, encodeTrace, writeTraceParams
} from '../kernels.ts';
import { HIT_BYTES, HIT_W, NO_INDEX, RAY_BYTES, RAY_W, RAY_WORDS } from '../rays.ts';
import { surfaceSources, uploadSceneDesc, type GpuScene } from '../scene-upload.ts';
import { paletteUniform } from '../materials.ts';
import { arraySlot, mipChainCpu } from '../textures.ts';
import { createSurfaceRef, primaryRays, type RefSurface } from '../surface-ref.ts';
import { WGSL_SOURCES } from '../wgsl/index.ts';
import dbgWgsl from './pt-surface.wgsl?raw';

interface Metric { name: string; tol: number; unit: string; values: number[]; pass: number; p50: number; p99: number; max: number }
interface Timing { quality: string; buildSceneMs: number; [k: string]: number | string }
interface PtSurfaceState {
  done: boolean;
  pass?: boolean;
  error?: string;
  log: string[];
  report?: {
    device: string;
    hits: number;
    compared: number;
    idMismatch: number;
    metrics: Omit<Metric, 'values'>[];
    minPass: number;
    timings: Timing[];
    gpuErrors: string[];
    kinds: Record<string, number>;
    mipMaxDiff: number;
  };
  images?: Record<string, string>;
}

declare global {
  interface Window { __ptSurface?: PtSurfaceState }
}

const state: PtSurfaceState = { done: false, log: [] };
window.__ptSurface = state;
const logEl = document.getElementById('log')!;
const statusEl = document.getElementById('status')!;
const aovEl = document.getElementById('aovs')!;

function log(line: string): void {
  state.log.push(line);
  logEl.textContent += line + '\n';
  console.log('[pt-surface] ' + line);
}

const W = 640, H = 360, SAMPLES = 2000;
/** fraction of compared pixels that must be within tolerance, per metric */
const MIN_PASS = 0.99;
const AOV_WORDS = 20;
/** GPU vs CPU mip bytes: rounding ties + pow ulps accumulate ≤ 1 LSB per level (levels 1, 3, 5 checked) */
const MIP_MAX_DIFF = 3;

const srgb = (c: number) => {
  const x = Math.min(1, Math.max(0, c));
  return Math.round((x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055) * 255);
};

function timingOf(q: string, buildMs: number, gs: GpuScene): Timing {
  const t = gs.timings;
  return {
    quality: q, buildSceneMs: buildMs,
    bvhMs: t.bvhMs, bvhCpuMs: t.bvhCpuMs, packMs: t.packMs, attrMs: t.attrMs,
    texGenMs: t.texGenMs, texUploadMs: t.texUploadMs, mipMs: t.mipMs, bufferMs: t.bufferMs, totalMs: t.totalMs,
    tris: gs.stats.triangles, instancedTris: gs.stats.instancedTriangles, instances: gs.stats.instances,
    textureMiB: gs.stats.bytes.textures / 1048576,
    bufferMiB: (gs.stats.bytes.nodes + gs.stats.bytes.tris + gs.stats.bytes.instances + gs.stats.bytes.attrs + gs.stats.bytes.materials) / 1048576
  };
}

async function main(): Promise<void> {
  const q = new URLSearchParams(location.search);
  const quality = (q.get('q') ?? 'HIGH') as QualityId;
  const timingQs = (q.get('timings') ?? 'ULTRA').split(',').filter(Boolean) as QualityId[];
  const phase = Number(q.get('phase') ?? 2);
  if (!navigator.gpu) throw new Error('navigator.gpu is undefined: WebGPU is not available in this browser');
  const pt = await createDevice();
  const device = pt.device;
  const gpuErrors: string[] = [];
  pt.onError((e) => gpuErrors.push(e.message));
  pt.onLost((info) => log(`DEVICE LOST: ${info.reason} ${info.message}`));
  log(`device: ${describeDevice(pt)}`);

  const sources = { ...WGSL_SOURCES, ...surfaceSources(), 'pt-surface.wgsl': dbgWgsl };
  const kernels = await createKernels(device, sources);
  const bvhPool = createBvhPool();
  const texPool = createTexturePool();
  log(`pools: BVH ${bvhPool.size} ${bvhPool.threaded ? 'workers' : '(sync)'}, textures ${texPool.workers} workers`);
  const lighting = lightingAt(phase);
  const timings: Timing[] = [];

  /* 1. scene upload */
  const tb = performance.now();
  const scene = buildScene({ ...defaultParams(quality), seed: 1337 });
  const buildMs = performance.now() - tb;
  log(`buildScene(${quality}, seed 1337): ${buildMs.toFixed(0)} ms`);
  device.pushErrorScope('out-of-memory');
  device.pushErrorScope('validation');
  const gs = await uploadSceneDesc(device, scene, {
    pool: bvhPool, images: (specs) => texPool.generate(specs), sceneLayout: kernels.sceneLayout,
    sources, state: lighting, keepImages: true, log
  });
  timings.push(timingOf(quality, buildMs, gs));

  /* 1b. GPU mip chain vs the CPU mirror (mipgen.wgsl ↔ textures.ts mipChainCpu) */
  const mipDiffs: string[] = [];
  let mipMaxDiff = 0;
  for (const id of ['hull.albedo', 'hull.mask', 'detail', 'facade.0']) {
    const r = gs.textures.plan.refs[gs.textures.plan.byImage.get(id) ?? -1];
    if (!r) continue;
    const cpu = mipChainCpu(gs.images![r.index], r.srgb);
    for (const level of [1, 3, 5]) {
      const S = r.size >> level;
      if (S * 4 < 256) continue;
      const rb = device.createBuffer({ size: S * S * 4, usage: BUFFER.COPY_DST | BUFFER.COPY_SRC });
      const e = device.createCommandEncoder();
      e.copyTextureToBuffer({ texture: gs.textures.textures[arraySlot(r.srgb, r.cls)], mipLevel: level, origin: [0, 0, r.layer] },
        { buffer: rb, bytesPerRow: S * 4, rowsPerImage: S }, [S, S, 1]);
      device.queue.submit([e.finish()]);
      const g = new Uint8Array(await readBuffer(device, rb, S * S * 4));
      rb.destroy();
      const c = cpu[level].data;
      let diff = 0, mx = 0;
      for (let i = 0; i < g.length; i++) { const d = Math.abs(g[i] - c[i]); if (d) { diff++; mx = Math.max(mx, d); } }
      mipMaxDiff = Math.max(mipMaxDiff, mx);
      mipDiffs.push(`${id}@${level}: ${(diff / g.length * 100).toFixed(2)} % bytes differ, max ${mx}`);
    }
  }
  log(`GPU vs CPU mips: ${mipDiffs.join('; ')}`);

  /* 2. primary rays + k_intersect */
  const view = scene.views[0];
  const cam = primaryRays(view.pos, view.look, W, H);
  const n = W * H;
  const batch = createTraceBatch(device, kernels, 'intersect', n, RAY_BYTES, HIT_BYTES);
  device.queue.writeBuffer(batch.rays, 0, cam.rays);
  writeTraceParams(device, batch, n, VIS_CAMERA, gs.tlasRoot);

  /* 3. debug surface kernel */
  const dbgLayout = device.createBindGroupLayout({
    label: 'b5 surface dbg',
    entries: [
      { binding: 0, visibility: STAGE.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: STAGE.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: STAGE.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } }
    ]
  });
  const module = await compileShader(device, 'pt-surface.wgsl', buildKernelSource('pt-surface.wgsl', sources, kernels.defines));
  const pipeline = await device.createComputePipelineAsync({
    label: 'b5_k_surface_dbg',
    layout: device.createPipelineLayout({ bindGroupLayouts: [kernels.sceneLayout, dbgLayout, gs.surfaceLayout] }),
    compute: { module, entryPoint: 'b5_k_surface_dbg', constants: { B5_WG_SIZE: 64 } }
  });
  const params = device.createBuffer({ size: 16, usage: BUFFER.UNIFORM | BUFFER.COPY_DST });
  const pd = new ArrayBuffer(16);
  new Uint32Array(pd)[0] = n;
  new Float32Array(pd)[2] = cam.spread;
  device.queue.writeBuffer(params, 0, pd);
  const aov = device.createBuffer({ size: n * AOV_WORDS * 4, usage: BUFFER.STORAGE | BUFFER.COPY_SRC });
  const bg = device.createBindGroup({
    layout: dbgLayout,
    entries: [
      { binding: 0, resource: { buffer: params } },
      { binding: 1, resource: { buffer: batch.rays } },
      { binding: 2, resource: { buffer: batch.out } },
      { binding: 3, resource: { buffer: aov } }
    ]
  });
  const enc = device.createCommandEncoder();
  const p1 = enc.beginComputePass();
  encodeTrace(p1, kernels, batch, gs.sceneBindGroup, n, pt.limits.maxComputeWorkgroupsPerDimension);
  p1.end();
  const p2 = enc.beginComputePass();
  p2.setPipeline(pipeline);
  p2.setBindGroup(0, gs.sceneBindGroup);
  p2.setBindGroup(1, bg);
  p2.setBindGroup(2, gs.surfaceBindGroup);
  const [dx, dy] = dispatchSize(n, 64);
  p2.dispatchWorkgroups(dx, dy);
  p2.end();
  const ts = performance.now();
  device.queue.submit([enc.finish()]);
  const [hitBuf, aovBuf] = await Promise.all([readBuffer(device, batch.out, n * HIT_BYTES), readBuffer(device, aov, n * AOV_WORDS * 4)]);
  log(`GPU intersect + b5_surface ${W}×${H}: ${(performance.now() - ts).toFixed(0)} ms incl. readback`);
  const verr = await device.popErrorScope();
  const oom = await device.popErrorScope();
  if (verr) gpuErrors.push(`validation: ${verr.message}`);
  if (oom) gpuErrors.push(`out-of-memory: ${oom.message}`);

  /* 4. CPU reference on random hit pixels */
  const HF = new Float32Array(hitBuf), HU = new Uint32Array(hitBuf);
  const AF = new Float32Array(aovBuf), AU = new Uint32Array(aovBuf);
  const hitPix: number[] = [];
  for (let i = 0; i < n; i++) if (HU[i * 6 + HIT_W.tri] !== NO_INDEX) hitPix.push(i);
  const prep = gs.prepared;
  const ref = createSurfaceRef({
    tris: prep.packed.tris, instances: prep.packed.instances, attrs: prep.attrs, materials: prep.materials,
    texTable: gs.textures.tableData, images: gs.images!, frame: paletteUniform(lighting, { detailRep: scene.hull.detailRep })
  });
  const metrics: Metric[] = [
    { name: 'albedo', tol: 0.02, unit: 'max |Δ| linear', values: [], pass: 0, p50: 0, p99: 0, max: 0 },
    { name: 'ns', tol: 2, unit: 'deg', values: [], pass: 0, p50: 0, p99: 0, max: 0 },
    { name: 'ng', tol: 0.05, unit: 'deg', values: [], pass: 0, p50: 0, p99: 0, max: 0 },
    { name: 'rough', tol: 0.02, unit: '|Δ|', values: [], pass: 0, p50: 0, p99: 0, max: 0 },
    { name: 'metal', tol: 1e-6, unit: '|Δ|', values: [], pass: 0, p50: 0, p99: 0, max: 0 },
    { name: 'water', tol: 0.02, unit: '|Δ|', values: [], pass: 0, p50: 0, p99: 0, max: 0 },
    { name: 'emission', tol: 1, unit: '|Δ| / (0.005 + 3 % · ref)', values: [], pass: 0, p50: 0, p99: 0, max: 0 }
  ];
  const M = Object.fromEntries(metrics.map((m) => [m.name, m]));
  const ang = (a: number[], b: number[]) => (Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180) / Math.PI;
  const rnd = mulberry32(2026);
  let idMismatch = 0;
  const worst: string[] = [];
  const tr = performance.now();
  const count = Math.min(SAMPLES, hitPix.length);
  const kinds: Record<string, number> = {};
  for (let k = 0; k < count; k++) {
    const i = hitPix[Math.floor(rnd() * hitPix.length)];
    const hw = i * 6, aw = i * AOV_WORDS, rw = i * RAY_WORDS;
    const o = [cam.rays[rw], cam.rays[rw + 1], cam.rays[rw + 2]];
    const d = [cam.rays[rw + RAY_W.d], cam.rays[rw + RAY_W.d + 1], cam.rays[rw + RAY_W.d + 2]];
    const hit = { t: HF[hw], u: HF[hw + 1], v: HF[hw + 2], inst: HU[hw + 3], tri: HU[hw + 4], flags: HU[hw + 5] };
    const coneW = Math.fround(Math.fround(cam.spread * hit.t) * Math.hypot(d[0], d[1], d[2]));
    const r: RefSurface = ref.surface(hit, o, d, coneW);
    const g = {
      albedo: [AF[aw], AF[aw + 1], AF[aw + 2]], kind: AU[aw + 3], ns: [AF[aw + 4], AF[aw + 5], AF[aw + 6]], rough: AF[aw + 7],
      emission: [AF[aw + 8], AF[aw + 9], AF[aw + 10]], metal: AF[aw + 11], ng: [AF[aw + 12], AF[aw + 13], AF[aw + 14]],
      water: AF[aw + 15], matId: AU[aw + 16]
    };
    kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
    if (g.kind !== r.kind || g.matId !== r.matId) { idMismatch++; continue; }
    /* 0.005 ≈ 1 LSB of the 8-bit tonemapped output (x/(1+x) has slope ≤ 1) + 3 % */
    const em = 0.005 + 0.03 * Math.max(...r.emission);
    const vals: Record<string, number> = {
      albedo: Math.max(...g.albedo.map((x, c) => Math.abs(x - r.albedo[c]))),
      ns: ang(g.ns, r.ns), ng: ang(g.ng, r.ng),
      rough: Math.abs(g.rough - r.rough), metal: Math.abs(g.metal - r.metal), water: Math.abs(g.water - r.water),
      emission: Math.max(...g.emission.map((x, c) => Math.abs(x - r.emission[c]))) / em
    };
    for (const [name, v] of Object.entries(vals)) {
      M[name].values.push(v);
      if (v > M[name].tol && worst.length < 12) {
        worst.push(`${name} ${v.toExponential(2)} @px ${i % W},${Math.floor(i / W)} kind ${r.kind} mat ${prep.materialIds[r.matId]} lod ${r.lod.toFixed(2)}`);
      }
    }
  }
  for (const m of metrics) {
    const s = [...m.values].sort((a, b) => a - b);
    m.pass = s.filter((v) => v <= m.tol).length / Math.max(1, s.length);
    m.p50 = s[Math.floor(s.length * 0.5)] ?? 0;
    m.p99 = s[Math.floor(s.length * 0.99)] ?? 0;
    m.max = s[s.length - 1] ?? 0;
    log(`${m.name.padEnd(8)} tol ${m.tol} ${m.unit}: within ${(m.pass * 100).toFixed(2)} %, p50 ${m.p50.toExponential(2)}, p99 ${m.p99.toExponential(2)}, max ${m.max.toExponential(2)}`);
  }
  log(`CPU reference: ${count} of ${hitPix.length} hit pixels in ${(performance.now() - tr).toFixed(0)} ms; kind/matId mismatches ${idMismatch}; kinds ${JSON.stringify(kinds)}`);
  for (const w of worst) log(`  outside tol: ${w}`);

  /* 5. AOV images */
  const images: Record<string, string> = {};
  const draw = (name: string, px: (aw: number, hit: boolean) => [number, number, number]) => {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d')!;
    const id = ctx.createImageData(W, H);
    for (let i = 0; i < n; i++) {
      const aw = i * AOV_WORDS;
      const [r, g, b] = px(aw, AU[aw + 19] === 1);
      id.data[i * 4] = r; id.data[i * 4 + 1] = g; id.data[i * 4 + 2] = b; id.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(id, 0, 0);
    images[name] = c.toDataURL('image/png');
    const fig = document.createElement('figure');
    const cap = document.createElement('figcaption');
    cap.textContent = name;
    fig.append(c, cap);
    aovEl.append(fig);
  };
  const tm = (x: number) => srgb(x / (1 + x));
  draw('albedo', (aw, h) => (h ? [srgb(AF[aw]), srgb(AF[aw + 1]), srgb(AF[aw + 2])] : [0, 0, 0]));
  draw('normal', (aw, h) => (h ? [0, 1, 2].map((k) => Math.round((AF[aw + 4 + k] * 0.5 + 0.5) * 255)) as [number, number, number] : [0, 0, 0]));
  draw('emission', (aw, h) => (h ? [tm(AF[aw + 8]), tm(AF[aw + 9]), tm(AF[aw + 10])] : [0, 0, 0]));
  draw('roughness', (aw, h) => { const v = h ? Math.round(AF[aw + 7] * 255) : 0; const w = h ? Math.round(AF[aw + 15] * 255) : 0; return [v, v, Math.max(v, w)]; });
  state.images = images;

  batch.destroy(); aov.destroy(); params.destroy();
  gs.destroy();

  /* 6. timing runs for other qualities */
  for (const tq of timingQs) {
    const t0 = performance.now();
    const sc = buildScene({ ...defaultParams(tq), seed: 1337 });
    const bms = performance.now() - t0;
    log(`buildScene(${tq}): ${bms.toFixed(0)} ms`);
    const g2 = await uploadSceneDesc(device, sc, {
      pool: bvhPool, images: (specs) => texPool.generate(specs), sceneLayout: kernels.sceneLayout, sources, state: lighting, log
    });
    timings.push(timingOf(tq, bms, g2));
    g2.destroy();
  }
  bvhPool.terminate();
  texPool.dispose();
  for (const t of timings) log(`timings ${JSON.stringify(t, (_, v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v))}`);

  const pass = idMismatch === 0 && gpuErrors.length === 0 && metrics.every((m) => m.pass >= MIN_PASS) && count >= Math.min(SAMPLES, hitPix.length) && hitPix.length > n * 0.5 && mipMaxDiff <= MIP_MAX_DIFF;
  state.report = {
    device: describeDevice(pt), hits: hitPix.length, compared: count, idMismatch,
    metrics: metrics.map(({ values: _v, ...rest }) => rest), minPass: MIN_PASS, timings, gpuErrors, kinds, mipMaxDiff
  };
  state.pass = pass;
  statusEl.textContent = pass ? 'PASS' : 'FAIL';
  statusEl.className = pass ? 'pass' : 'fail';
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  state.error = msg;
  state.pass = false;
  statusEl.textContent = 'FAIL — ' + msg;
  statusEl.className = 'fail';
  log('ERROR ' + msg);
}).finally(() => {
  state.done = true;
});
