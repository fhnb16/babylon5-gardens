/* ═══════════════════════════════════════════════════════════════════════════
   PT-P4 output-side checks (pt-output.html → tests/browser/pt-output.spec.ts):
     mode=adaptive  public API (pathtracer/index.ts) end to end: the station,
                    target noise (default 3 %) → spp reached, time, measured
                    noise (p95 tile error), tiles converged / capped; PNGs of
                    the raw and the à-trous-cleaned image;
     mode=stats     k_tilestats vs the CPU mirror (convergence.ts), the
                    half-buffer estimator vs the true error of two
                    independent renders, k_atrous vs the CPU mirror (denoise.ts);
     mode=rmse      denoised `spp` (64) vs a `ref` (2048) spp reference: RMSE
                    of noisy and denoised, linear and display space; PNGs;
     mode=sampler   Owen-Sobol vs PCG: relative rms noise at `spp` (two
                    independent renders each), time per spp.
   Results go to window.__ptOut.
   ═══════════════════════════════════════════════════════════════════════════ */
import { viewPose } from '../../core/camera/flight.ts';
import { CORE_CONFIG } from '../../core/config/index.ts';
import { buildScene, defaultParams } from '../../core/scene/build.ts';
import { RASTER_TONE_EXPOSURE, tracerLightingAt } from '../config.ts';
import { CONVERGENCE, MEAN_ABS_TO_RMS, TILE_STATS_FLOATS, TILE_UNKNOWN, noiseCalibration, percentile, tileStatsRef } from '../convergence.ts';
import { atrousRef, createAtrousDenoiser } from '../denoise.ts';
import { createDevice, describeDevice } from '../device.ts';
import { BUFFER, MAP } from '../gpu-flags.ts';
import * as api from '../index.ts';
import { createIntegrator, type Integrator, type IntegratorOptions } from '../integrator.ts';
import { pcgHash, sobolOwenU32, type SamplerName } from '../sampler.ts';
import commonWgsl from '../wgsl/common.wgsl?raw';
import samplingWgsl from '../wgsl/sampling.wgsl?raw';
import { uploadSceneDesc } from '../scene-upload.ts';
import { createPresenter } from '../three-interop.ts';

const BASE_W = 960, BASE_H = 540, SEED = 1337, FOV = 62;

export interface PtOutState {
  done: boolean;
  error?: string;
  log: string[];
  device?: string;
  mode?: string;
  width?: number;
  height?: number;
  gpuErrors: string[];
  deviceLost?: string;
  /** PNGs as data URLs (name → url) */
  images: Record<string, string>;
  adaptive?: Record<string, unknown>;
  stats?: Record<string, unknown>;
  rmse?: Record<string, unknown>;
  sampler?: Record<string, unknown>;
}

declare global {
  interface Window { __ptOut?: PtOutState }
}

const state: PtOutState = { done: false, log: [], gpuErrors: [], images: {} };
window.__ptOut = state;
const logEl = document.getElementById('log')!;
const statusEl = document.getElementById('status')!;
const views = document.getElementById('views')!;

function log(line: string): void {
  state.log.push(line);
  logEl.textContent += line + '\n';
  console.log('[pt-output] ' + line);
}

function makeCanvas(name: string, w: number, h: number): HTMLCanvasElement {
  const fig = document.createElement('figure');
  const c = document.createElement('canvas');
  c.id = `cv-${name}`;
  c.width = w; c.height = h;
  const cap = document.createElement('figcaption');
  cap.textContent = name;
  fig.append(c, cap);
  views.appendChild(fig);
  return c;
}

async function blobUrl(b: Blob | null): Promise<string> {
  if (!b) return '';
  return new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.readAsDataURL(b); });
}

/* ─── readback / colour helpers ───────────────────────────────────────────── */

function f16(h: number): number {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

async function readBuffer(device: GPUDevice, buf: GPUBuffer): Promise<Float32Array> {
  const rb = device.createBuffer({ size: buf.size, usage: BUFFER.MAP_READ | BUFFER.COPY_DST });
  const enc = device.createCommandEncoder();
  enc.copyBufferToBuffer(buf, 0, rb, 0, buf.size);
  device.queue.submit([enc.finish()]);
  await rb.mapAsync(MAP.READ);
  const out = new Float32Array(rb.getMappedRange().slice(0));
  rb.unmap(); rb.destroy();
  return out;
}

/** rgba16float texture → rgb Float32Array (3 per pixel). */
async function readRgba16(device: GPUDevice, tex: GPUTexture): Promise<Float32Array> {
  const w = tex.width, h = tex.height, bpr = Math.ceil((w * 8) / 256) * 256;
  const rb = device.createBuffer({ size: bpr * h, usage: BUFFER.MAP_READ | BUFFER.COPY_DST });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: tex }, { buffer: rb, bytesPerRow: bpr }, [w, h]);
  device.queue.submit([enc.finish()]);
  await rb.mapAsync(MAP.READ);
  const u16 = new Uint16Array(rb.getMappedRange().slice(0));
  rb.unmap(); rb.destroy();
  const out = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) out[(y * w + x) * 3 + c] = f16(u16[(y * bpr) / 2 + x * 4 + c]);
  return out;
}

/** mean rgb (3 per pixel) of an accumulation (vec4 rgb sum + count). */
function meanOf(acc: Float32Array): Float32Array {
  const n = acc.length / 4, out = new Float32Array(n * 3);
  for (let p = 0; p < n; p++) for (let c = 0; c < 3; c++) out[p * 3 + c] = acc[p * 4 + c] / Math.max(1, acc[p * 4 + 3]);
  return out;
}

/* three r187 ACESFilmicToneMapping (three-interop.ts PRESENT_WGSL b5_aces_three) + sRGB */
function acesThree(r: number, g: number, b: number): [number, number, number] {
  const x = [r / 0.6, g / 0.6, b / 0.6];
  const inM = [[0.59719, 0.35458, 0.04823], [0.07600, 0.90834, 0.01566], [0.02840, 0.13383, 0.83777]];
  const outM = [[1.60475, -0.53108, -0.07367], [-0.10208, 1.10813, -0.00605], [-0.00327, -0.07276, 1.07602]];
  const v = inM.map((row) => row[0] * x[0] + row[1] * x[1] + row[2] * x[2]);
  const t = v.map((q) => (q * (q + 0.0245786) - 0.000090537) / (q * (0.983729 * q + 0.4329510) + 0.238081));
  const o = outM.map((row) => row[0] * t[0] + row[1] * t[1] + row[2] * t[2]);
  const srgb = (c: number) => { const q = Math.min(1, Math.max(0, c)); return q <= 0.0031308 ? q * 12.92 : 1.055 * q ** (1 / 2.4) - 0.055; };
  return [srgb(o[0]), srgb(o[1]), srgb(o[2])];
}

function display(rgb: Float32Array, exposure = RASTER_TONE_EXPOSURE): Float32Array {
  const out = new Float32Array(rgb.length);
  for (let p = 0; p < rgb.length; p += 3) out.set(acesThree(rgb[p] * exposure, rgb[p + 1] * exposure, rgb[p + 2] * exposure), p);
  return out;
}

function rmse(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += Number.isFinite(d) ? d * d : 0; }
  return Math.sqrt(s / a.length);
}

function mean(a: Float32Array): number {
  let s = 0;
  for (const v of a) s += v;
  return s / a.length;
}

/* ─── scene / integrator setup ────────────────────────────────────────────── */

const q = new URLSearchParams(location.search);
/* the LAST occurrence wins (PT_OUTPUT_QUERY overrides the spec's query) */
const str = (k: string) => q.getAll(k).at(-1) ?? null;
const num = (k: string, d: number) => (q.has(k) ? Number(str(k)) : d);

async function setupIntegrator(device: GPUDevice, width: number, height: number, sampler: SamplerName = 'sobol') {
  const desc = buildScene({ ...defaultParams('HIGH'), seed: SEED });
  const gs = await uploadSceneDesc(device, desc, {});
  /* raw tile statistics (noiseCalibration 1): compared with the CPU mirror */
  return { gs, make: (s: SamplerName = sampler, extra: Partial<IntegratorOptions> = {}) =>
    createIntegrator(device, gs, { width, height, sampler: s, noiseCalibration: 1, ...extra }) };
}

async function prepare(integ: Integrator, view: number, phase: number): Promise<void> {
  const tp = CORE_CONFIG.TP[view % CORE_CONFIG.TP.length];
  integ.setCamera(viewPose(tp.pos, tp.look), FOV, integ.width / integ.height);
  integ.setLighting(tracerLightingAt(phase));
  await integ.lightsReady();
}

async function renderTo(integ: Integrator, spp: number, budget: number): Promise<{ ms: number; gpuMs: number }> {
  const t0 = performance.now();
  let gpuMs = 0;
  while (integ.spp < spp) gpuMs += (await integ.step(budget)).ms;
  return { ms: performance.now() - t0, gpuMs };
}

/* ─── modes ───────────────────────────────────────────────────────────────── */

async function modeAdaptive(pdev: Awaited<ReturnType<typeof createDevice>>, w: number, h: number, view: number, phase: number) {
  const noise = num('noise', CONVERGENCE.defaultNoise);
  const canvas = makeCanvas('adaptive', w, h);
  const desc = buildScene({ ...defaultParams('HIGH'), seed: SEED });
  const tp = CORE_CONFIG.TP[view % CORE_CONFIG.TP.length];
  api.setNoiseTarget(noise);
  const ts = performance.now();
  const ok = await api.startPath(desc, { pose: viewPose(tp.pos, tp.look), fovY: FOV }, {
    canvas, device: pdev, lighting: phase, budgetMs: num('budget', 30), log
  });
  if (!ok) throw new Error(`startPath failed: ${api.pt.error}`);
  const setupMs = performance.now() - ts;
  log(`startPath ready in ${setupMs.toFixed(0)} ms; ${api.pathLabel()}`);
  const t0 = performance.now();
  let frames = 0;
  const trace: { t: number; spp: number; noise: number; active: number }[] = [];
  while (!api.pt.done) {
    api.pathStep();
    await api.pathIdle();
    frames++;
    if (frames % 10 === 0) {
      trace.push({ t: Math.round(performance.now() - t0), spp: +api.pt.samples.toFixed(2), noise: +api.noiseNow().toFixed(3), active: api.pt.activeTiles });
      log(api.pathLabel() + ` · active tiles ${api.pt.activeTiles}`);
    }
    if (performance.now() - t0 > num('timeout', 200_000)) { log('timeout'); break; }
    if (state.deviceLost) throw new Error(`device lost: ${state.deviceLost}`);
  }
  const timeMs = performance.now() - t0;
  const integ = api.pathInternals().integrator!;
  const c = integ.convergence!;
  const acc = await integ.readAccumulation();
  let minW = Infinity, maxW = 0;
  for (let p = 0; p < acc.length; p += 4) { minW = Math.min(minW, acc[p + 3]); maxW = Math.max(maxW, acc[p + 3]); }
  state.images.adaptive = await blobUrl(await api.pathSnapshot());
  const okClean = await api.cleanPath('atrous');
  state.images['adaptive-atrous'] = await blobUrl(await api.pathSnapshot());
  state.adaptive = {
    target: noise, capSpp: api.samplesNeeded(), done: api.pt.done, spp: api.pt.samples, timeMs, setupMs, frames,
    noiseP95: api.noiseNow(), tiles: integ.tiles.count, converged: c.converged, capped: c.capped,
    minSpp: minW, maxSpp: maxW, denoiseMs: api.pt.denoiseMs, cleaned: okClean, label: api.pathLabel(), trace
  };
  log(`adaptive: target ${noise} % → ${api.pt.samples.toFixed(1)} spp mean (${minW}..${maxW}) in ${(timeMs / 1000).toFixed(1)} s, ` +
    `p95 noise ${api.noiseNow().toFixed(2)} %, tiles converged ${c.converged} / capped ${c.capped} / ${integ.tiles.count}; à-trous ${api.pt.denoiseMs.toFixed(1)} ms`);
  api.stopPath();
}

/** sampling.wgsl on the GPU vs sampler.ts (bit for bit): Sobol–Owen samples and the PCG hash. */
async function samplerParity(device: GPUDevice): Promise<{ n: number; mismatches: number }> {
  const N = 4096;
  const code = commonWgsl + '\n' + samplingWgsl + `
@group(0) @binding(0) var<storage, read_write> b5_io: array<vec4u>;
@compute @workgroup_size(64) fn b5_main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= ${N}u) { return; }
  let v = b5_io[gid.x];
  /* the cached path of b5_rnd: start a path with seed v.z, index v.x, then jump to dim v.y */
  b5_smp_seed = v.z;
  b5_smp_index = v.x;
  b5_smp_sobol = true;
  b5_smp_group = 0xffffffffu;
  var st = v.y;
  let cached = u32(b5_rnd(&st) * 16777216.0);
  let direct = u32(b5_sobol_owen(v.x, v.y, v.z) * 16777216.0);
  b5_io[gid.x] = vec4u(select(0xffffffffu, v.x, cached == direct), v.y, direct, b5_pcg(v.z));
}`;
  const module = device.createShaderModule({ label: 'b5 sampler parity', code });
  const pipe = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'b5_main' } });
  const io = new Uint32Array(N * 4);
  for (let i = 0; i < N; i++) { io[i * 4] = (i * 7) % 1031; io[i * 4 + 1] = i % 40; io[i * 4 + 2] = pcgHash(i * 13 + 1); }
  const buf = device.createBuffer({ size: io.byteLength, usage: BUFFER.STORAGE | BUFFER.COPY_SRC | BUFFER.COPY_DST });
  device.queue.writeBuffer(buf, 0, io);
  const enc = device.createCommandEncoder();
  const p = enc.beginComputePass();
  p.setPipeline(pipe);
  p.setBindGroup(0, device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: buf } }] }));
  p.dispatchWorkgroups(N / 64);
  p.end();
  device.queue.submit([enc.finish()]);
  const out = new Uint32Array((await readBuffer(device, buf)).buffer);
  buf.destroy();
  let mismatches = 0;
  for (let i = 0; i < N; i++) {
    if (out[i * 4 + 2] !== sobolOwenU32(io[i * 4], io[i * 4 + 1], io[i * 4 + 2]) >>> 8) mismatches++;
    if (out[i * 4 + 3] !== pcgHash(io[i * 4 + 2])) mismatches++;
    if (out[i * 4] !== io[i * 4]) mismatches++; // b5_rnd (group cache) ≠ b5_sobol_owen
  }
  return { n: N, mismatches };
}

async function modeStats(device: GPUDevice, w: number, h: number, view: number, phase: number) {
  const spp = num('spp', 64);
  const sp = await samplerParity(device);
  log(`sampler GPU vs CPU mirror: ${sp.mismatches} mismatches in ${sp.n} Sobol–Owen samples + ${sp.n} PCG hashes`);
  const { gs, make } = await setupIntegrator(device, w, h, (str('sampler') ?? 'sobol') as SamplerName);
  const integ = await make();
  await prepare(integ, view, phase);
  await renderTo(integ, spp, 30);
  const g = await integ.measure({ target: 0.03, capSpp: 1e9 });
  const gpu = integ.tileStats!;
  const acc1 = await integ.readAccumulation();
  const half1 = await integ.readHalf();
  const aov1 = await readBuffer(device, integ.buffers.aov);
  const cpu = tileStatsRef(acc1, half1, w, h);
  let maxRel = 0, wDiff = 0;
  for (let t = 0; t < gpu.length / TILE_STATS_FLOATS; t++) {
    const a = gpu[t * 4], b = cpu[t * 4];
    if (a < TILE_UNKNOWN && b < TILE_UNKNOWN) maxRel = Math.max(maxRel, Math.abs(a - b) / Math.max(b, 1e-6));
    wDiff = Math.max(wDiff, Math.abs(gpu[t * 4 + 1] - cpu[t * 4 + 1]), Math.abs(gpu[t * 4 + 2] - cpu[t * 4 + 2]), Math.abs(gpu[t * 4 + 3] - cpu[t * 4 + 3]));
  }
  log(`tile stats GPU vs CPU: max relative error diff ${maxRel.toExponential(2)}, count/min/max diff ${wDiff}; p95 ${(g.noise * 100).toFixed(2)} %`);

  /* estimator vs truth: a second independent render (other salt) to the same spp;
     per pixel true relative SE ≈ |T(X1) − T(X2)| / (T(X1) + T(X2) + ε) · √(π/2) · √2 */
  const den = createAtrousDenoiser(device, w, h, integ.buffers);
  await den.run();
  const gpuDen = await readRgba16(device, den.output);
  const tc = performance.now();
  const cpuDen = atrousRef(acc1, half1, aov1, w, h).rgb;
  const cpuMs = performance.now() - tc;
  let dMax = 0, dSum = 0, cnt = 0;
  for (let i = 0; i < gpuDen.length; i++) {
    const r = Math.abs(gpuDen[i] - cpuDen[i]) / Math.max(Math.abs(cpuDen[i]), 1e-2);
    if (!Number.isFinite(r)) continue;
    dMax = Math.max(dMax, r); dSum += r; cnt++;
  }
  log(`à-trous GPU vs CPU mirror: mean relative diff ${(dSum / cnt).toExponential(2)}, max ${dMax.toExponential(2)} (CPU ${cpuMs.toFixed(0)} ms)`);

  integ.setSalt(0x9e3779b9);
  await renderTo(integ, spp, 30);
  const acc2 = await integ.readAccumulation();
  const E = CONVERGENCE.epsilon, X = CONVERGENCE.toneExposure;
  const tm = (v: number) => (v * X) / (1 + v * X);
  const lum = (A: Float32Array, p: number) => (0.2126 * A[p * 4] + 0.7152 * A[p * 4 + 1] + 0.0722 * A[p * 4 + 2]) / Math.max(1, A[p * 4 + 3]);
  const tilesX = integ.tiles.tilesX, T = CONVERGENCE.tile;
  const trueSum = new Float64Array(integ.tiles.count), trueN = new Float64Array(integ.tiles.count);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const a = tm(lum(acc1, p)), b = tm(lum(acc2, p));
      const t = Math.floor(y / T) * tilesX + Math.floor(x / T);
      trueSum[t] += (Math.abs(a - b) / (a + b + E)) * MEAN_ABS_TO_RMS * Math.SQRT2;
      trueN[t]++;
    }
  }
  const est: number[] = [], tru: number[] = [], ratio: number[] = [];
  for (let t = 0; t < integ.tiles.count; t++) {
    if (gpu[t * 4] >= TILE_UNKNOWN || !trueN[t]) continue;
    const tv = trueSum[t] / trueN[t];
    est.push(gpu[t * 4]); tru.push(tv);
    if (tv > 0) ratio.push(gpu[t * 4] / tv);
  }
  const p95Est = percentile(est, 0.95), p95True = percentile(tru, 0.95), medRatio = percentile(ratio, 0.5);
  log(`estimator vs truth @${spp} spp: p95 ${(p95Est * 100).toFixed(2)} % vs ${(p95True * 100).toFixed(2)} %, median tile ratio ${medRatio.toFixed(3)}`);
  const sampler = (str('sampler') ?? 'sobol') as SamplerName;
  const calib = noiseCalibration(sampler);
  log(`calibrated (×${calib} for ${sampler}): median tile ratio ${(medRatio * calib).toFixed(3)}, p95 ${(p95Est * calib * 100).toFixed(2)} %`);
  state.stats = {
    samplerMismatches: sp.mismatches, sampler, calibration: calib, medianRatioCalibrated: medRatio * calib, p95EstCalibrated: p95Est * calib,
    spp, tiles: integ.tiles.count, tileStatsMaxRelDiff: maxRel, tileCountDiff: wDiff,
    atrousMeanRelDiff: dSum / cnt, atrousMaxRelDiff: dMax, p95Est, p95True, medianRatio: medRatio,
    p05Ratio: percentile(ratio, 0.05), p95Ratio: percentile(ratio, 0.95)
  };
  den.dispose(); integ.dispose(); gs.destroy();
}

async function modeRmse(device: GPUDevice, w: number, h: number, view: number, phase: number) {
  const spp = num('spp', 64), ref = num('ref', 2048);
  const { gs, make } = await setupIntegrator(device, w, h);
  const integ = await make();
  await prepare(integ, view, phase);
  const cRef = makeCanvas('reference', w, h), cNoisy = makeCanvas('noisy', w, h), cDen = makeCanvas('denoised', w, h);
  const pRef = createPresenter(device, cRef), pNoisy = createPresenter(device, cNoisy), pDen = createPresenter(device, cDen);
  const pres = { exposure: RASTER_TONE_EXPOSURE, mode: 'aces-three' as const };
  integ.setSalt(1);
  const tr = await renderTo(integ, ref, 40);
  const refRgb = meanOf(await integ.readAccumulation());
  pRef.present(integ.output, pres);
  state.images.reference = await blobUrl(await new Promise<Blob | null>((r) => cRef.toBlob(r)));
  log(`reference: ${integ.spp.toFixed(0)} spp in ${(tr.ms / 1000).toFixed(1)} s`);
  integ.setSalt(2);
  const tn = await renderTo(integ, spp, 40);
  const noisy = meanOf(await integ.readAccumulation());
  pNoisy.present(integ.output, pres);
  state.images.noisy = await blobUrl(await new Promise<Blob | null>((r) => cNoisy.toBlob(r)));
  /* experiments: passes / sl / sn / sz override the à-trous defaults (denoise.ts DENOISE) */
  const aOpts = Object.fromEntries(([['passes', 'passes'], ['sigmaL', 'sl'], ['sigmaN', 'sn'], ['sigmaZ', 'sz'], ['albedoEps', 'ae']] as const)
    .filter(([, k]) => q.has(k)).map(([o, k]) => [o, num(k, 0)]));
  const den = createAtrousDenoiser(device, w, h, integ.buffers, aOpts);
  await den.run();
  const denMs = await den.run();
  const denoised = await readRgba16(device, den.output);
  pDen.present(den.output, pres);
  state.images.denoised = await blobUrl(await new Promise<Blob | null>((r) => cDen.toBlob(r)));
  const mRef = mean(refRgb);
  const dRef = display(refRgb), dNoisy = display(noisy), dDen = display(denoised);
  /* relMSE (denoising literature): mean (x − r)² / (r² + 0.01) per channel; and linear
     RMSE over the pixels whose reference is below / above display saturation */
  const relMse = (x: Float32Array) => { let s = 0; for (let i = 0; i < x.length; i++) { const d = x[i] - refRgb[i]; s += Number.isFinite(d) ? (d * d) / (refRgb[i] ** 2 + 0.01) : 0; } return s / x.length; };
  const split = (x: Float32Array) => {
    let sl = 0, nl = 0, sh = 0, nh = 0;
    for (let p = 0; p < x.length; p += 3) {
      const hot = (0.2126 * refRgb[p] + 0.7152 * refRgb[p + 1] + 0.0722 * refRgb[p + 2]) * RASTER_TONE_EXPOSURE > 4;
      let e = 0;
      for (let c = 0; c < 3; c++) e += (x[p + c] - refRgb[p + c]) ** 2;
      if (hot) { sh += e; nh += 3; } else { sl += e; nl += 3; }
    }
    return { below: Math.sqrt(sl / Math.max(1, nl)) / mRef, above: Math.sqrt(sh / Math.max(1, nh)) / mRef, hotPixels: nh / 3 };
  };
  const sN = split(noisy), sD = split(denoised);
  log(`relMSE noisy ${relMse(noisy).toExponential(3)}, denoised ${relMse(denoised).toExponential(3)}; ` +
    `relative RMSE below saturation noisy ${(sN.below * 100).toFixed(2)} % / denoised ${(sD.below * 100).toFixed(2)} %, ` +
    `above (${sN.hotPixels} px) ${(sN.above * 100).toFixed(1)} % / ${(sD.above * 100).toFixed(1)} %`);
  const out = {
    relMseNoisy: relMse(noisy), relMseDenoised: relMse(denoised),
    relRmseUnsatNoisy: sN.below, relRmseUnsatDenoised: sD.below, relRmseSatNoisy: sN.above, relRmseSatDenoised: sD.above, saturatedPixels: sN.hotPixels,
    width: w, height: h, spp, refSpp: ref, refTimeMs: tr.ms, noisyTimeMs: tn.ms, denoiseMs: denMs,
    relRmseNoisy: rmse(noisy, refRgb) / mRef, relRmseDenoised: rmse(denoised, refRgb) / mRef,
    displayRmseNoisy: rmse(dNoisy, dRef), displayRmseDenoised: rmse(dDen, dRef),
    meanRef: mRef, meanDenoised: mean(denoised), meanNoisy: mean(noisy)
  };
  state.rmse = out;
  log(`RMSE vs ${ref} spp: noisy ${spp} spp ${(out.relRmseNoisy * 100).toFixed(2)} % (display ${out.displayRmseNoisy.toFixed(4)}), ` +
    `à-trous ${(out.relRmseDenoised * 100).toFixed(2)} % (display ${out.displayRmseDenoised.toFixed(4)}); denoise ${denMs.toFixed(1)} ms; ` +
    `mean ref ${mRef.toFixed(4)} / denoised ${out.meanDenoised.toFixed(4)}`);
  den.dispose(); integ.dispose(); gs.destroy();
}

async function modeSampler(device: GPUDevice, w: number, h: number, view: number, phase: number) {
  const spp = num('spp', 16);
  const { gs, make } = await setupIntegrator(device, w, h);
  const res: Record<string, unknown> = {};
  const reg = num('reg', 0.5);
  const configs: [string, SamplerName, Partial<IntegratorOptions>][] = [['sobol', 'sobol', {}], ['pcg', 'pcg', {}], ['sobolReg', 'sobol', { regularize: reg }]];
  for (const [s, smp, extra] of configs) {
    const integ = await make(smp, extra);
    await prepare(integ, view, phase);
    integ.setSalt(11);
    const t = await renderTo(integ, spp, 40);
    const a = await integ.readAccumulation();
    integ.setSalt(12);
    await renderTo(integ, spp, 40);
    const b = await integ.readAccumulation();
    let d2 = 0, m = 0, cnt = 0;
    for (let p = 0; p < a.length; p += 4) {
      const la = (0.2126 * a[p] + 0.7152 * a[p + 1] + 0.0722 * a[p + 2]) / a[p + 3];
      const lb = (0.2126 * b[p] + 0.7152 * b[p + 1] + 0.0722 * b[p + 2]) / b[p + 3];
      if (!Number.isFinite(la + lb)) continue;
      d2 += (la - lb) ** 2; m += (la + lb) / 2; cnt++;
    }
    const relRms = Math.sqrt(d2 / cnt / 2) / (m / cnt);
    res[s] = { relRms, meanLum: m / cnt, gpuMs: t.gpuMs, ms: t.ms };
    log(`sampler ${s}: relative rms noise ${(relRms * 100).toFixed(2)} % at ${spp} spp, mean ${(m / cnt).toFixed(5)}, GPU ${t.gpuMs.toFixed(0)} ms`);
    integ.dispose();
  }
  state.sampler = { spp, ...res };
  gs.destroy();
}

async function main(): Promise<void> {
  const mode = str('mode') ?? 'adaptive';
  const res = num('res', mode === 'rmse' || mode === 'sampler' ? 0.5 : 1);
  const w = Math.max(8, Math.round(BASE_W * res)), h = Math.max(8, Math.round(BASE_H * res));
  const view = num('view', 0), phase = num('phase', 0);
  Object.assign(state, { mode, width: w, height: h });
  if (!navigator.gpu) throw new Error('navigator.gpu is undefined: WebGPU is not available in this browser');
  const pdev = await createDevice();
  state.device = describeDevice(pdev);
  log(`device: ${state.device}`);
  pdev.onError((e) => { state.gpuErrors.push(e.message); log(`GPU ERROR: ${e.message}`); });
  pdev.onLost((info) => { state.deviceLost = `${info.reason}: ${info.message}`; log(`DEVICE LOST: ${state.deviceLost}`); });
  const device = pdev.device;
  device.pushErrorScope('validation');
  if (mode === 'adaptive') await modeAdaptive(pdev, w, h, view, phase);
  else if (mode === 'stats') await modeStats(device, w, h, view, phase);
  else if (mode === 'rmse') await modeRmse(device, w, h, view, phase);
  else if (mode === 'sampler') await modeSampler(device, w, h, view, phase);
  else throw new Error(`unknown mode ${mode}`);
  await device.queue.onSubmittedWorkDone();
  const verr = await device.popErrorScope();
  if (verr) state.gpuErrors.push(`validation: ${verr.message}`);
  statusEl.textContent = state.gpuErrors.length ? 'FAIL — GPU errors' : 'DONE';
  statusEl.className = state.gpuErrors.length ? 'fail' : 'pass';
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ''}` : String(e);
  state.error = msg;
  statusEl.textContent = 'FAIL — ' + msg;
  statusEl.className = 'fail';
  log('ERROR ' + msg);
}).finally(() => {
  state.done = true;
});
