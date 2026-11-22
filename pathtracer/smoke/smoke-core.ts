/* ═══════════════════════════════════════════════════════════════════════════
   Traversal smoke test, environment-independent part: used by the browser
   page (pt-smoke.ts) and by Node + Dawn scripts. No DOM.

   1. build the test scene (scene.ts) with pathtracer/bvh, upload it;
   2. dispatch k_intersect for a camera ray grid (VIS_CAMERA) and for
      incoherent "diffuse" rays (VIS_INDIRECT), k_shadow for shadow rays
      (VIS_SHADOW); read everything back;
   3. compare with traverse-ref.ts in f32 mode (compare.ts verdicts);
   4. debug image of the camera grid (k_hitviz.wgsl → rgba16float texture);
   5. optional throughput: 1920×1080 primary rays, as many incoherent
      closest-hit and shadow rays, timed with timestamp-query when the
      device has it (wall clock around onSubmittedWorkDone otherwise).
   ═══════════════════════════════════════════════════════════════════════════ */

import { AOV_FORMATS } from '../../core/shading/contracts.ts';
import { VIS_CAMERA, VIS_INDIRECT, VIS_SHADOW, createTraverser } from '../bvh/index.ts';
import { describeDevice, type PtDevice, type PtLimits } from '../device.ts';
import { BUFFER, TEXTURE } from '../gpu-flags.ts';
import { readBuffer, uploadScene } from '../gpu-scene.ts';
import {
  buildKernelSource, compileShader, createKernels, createTraceBatch, encodeTrace, writeTraceParams,
  type KernelDefines, type KernelName, type PtKernels, type TraceBatch, type WgslSources
} from '../kernels.ts';
import { HIT_BYTES, RAY_BYTES } from '../rays.ts';
import { addTally, agreement, compareAny, compareClosest, newTally, type Mismatch, type Tally } from './compare.ts';
import { buildSmokeScene, cameraRays, diffuseRays, shadowRays, type SmokeSceneOptions } from './scene.ts';

export interface SmokeOptions {
  log?: (line: string) => void;
  /** comparison camera grid (default 640×360) */
  camera?: [number, number];
  /** incoherent closest-hit rays compared (default 65536) */
  diffuse?: number;
  /** shadow rays compared (default 131072) */
  shadow?: number;
  /** relative t tolerance of ties (default 1e-4) */
  tol?: number;
  /** PASS threshold (default 0.9999) */
  minAgreement?: number;
  /** run the throughput benchmark (default true) */
  bench?: boolean;
  /** benchmark primary grid (default 1920×1080) */
  benchSize?: [number, number];
  benchRepeats?: number;
  scene?: SmokeSceneOptions;
  /** kernel workgroup size (default 64) */
  workgroupSize?: number;
  /** kernel defines, e.g. { B5_TRAVERSE_STACK: 4 } to exercise the overflow path */
  defines?: KernelDefines;
}

export interface Bench {
  rays: number;
  medianMs: number;
  minMs: number;
  mraysPerSec: number;
}

export interface SmokeReport {
  device: string;
  limits: PtLimits;
  adapterLimits: PtLimits | null;
  features: string[];
  scene: { tris: number; instances: number; nodes: number; buildMs: number; mib: number };
  compileMs: number;
  tallies: Record<string, Tally>;
  total: Tally;
  agreement: number;
  minAgreement: number;
  mismatches: Mismatch[];
  stackOverflow: number;
  refMs: number;
  bench: { timer: 'timestamp-query' | 'wall-clock'; workgroupSize: number; primary: Bench; diffuse: Bench; shadow: Bench } | null;
  gpuErrors: string[];
  pass: boolean;
}

export interface SmokeResult {
  report: SmokeReport;
  /** rgba16float debug image of the camera grid */
  viz: GPUTexture;
  dispose(): void;
}

const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

export async function runSmoke(pt: PtDevice, sources: WgslSources, opts: SmokeOptions = {}): Promise<SmokeResult> {
  const log = opts.log ?? (() => {});
  const device = pt.device;
  const [cw, ch] = opts.camera ?? [640, 360];
  const nDiffuse = opts.diffuse ?? 65536, nShadow = opts.shadow ?? 131072;
  const tol = opts.tol ?? 1e-4, minAgreement = opts.minAgreement ?? 0.9999;
  const maxPerDim = pt.limits.maxComputeWorkgroupsPerDimension;
  const gpuErrors: string[] = [];
  const offErr = pt.onError((e) => gpuErrors.push(e.message));
  device.pushErrorScope('out-of-memory');
  device.pushErrorScope('validation');

  log(`device: ${describeDevice(pt)}`);

  /* 1. scene */
  const sc = buildSmokeScene(opts.scene);
  const mib = (sc.packed.nodes.byteLength + sc.packed.tris.byteLength + sc.packed.instances.byteLength) / 1048576;
  log(`scene: ${sc.triCount} tris, ${sc.instanceCount} instances, ${sc.packed.nodeCount} nodes, ${mib.toFixed(1)} MiB, built in ${sc.buildMs.toFixed(0)} ms`);
  const kernels = await createKernels(device, sources, { workgroupSize: opts.workgroupSize, defines: opts.defines });
  const vizModule = await compileShader(device, 'k_hitviz.wgsl', buildKernelSource('k_hitviz.wgsl', sources, kernels.defines));
  const vizPipeline = await device.createComputePipelineAsync({ label: 'b5_k_hitviz', layout: 'auto', compute: { module: vizModule, entryPoint: 'b5_k_hitviz' } });
  log(`kernels compiled in ${kernels.compileMs.toFixed(0)} ms (workgroup ${kernels.workgroupSize}, stack ${kernels.defines.B5_TRAVERSE_STACK})`);
  const gs = uploadScene(device, kernels, sc.packed);
  gs.resetDebug();

  /* 2. GPU traces of the comparison sets */
  const sets: { name: string; kind: KernelName; mask: number; rays: Float32Array; count: number }[] = [
    { name: `camera ${cw}x${ch}`, kind: 'intersect', mask: VIS_CAMERA, rays: cameraRays(cw, ch), count: cw * ch },
    { name: 'diffuse', kind: 'intersect', mask: VIS_INDIRECT, rays: diffuseRays(nDiffuse, 7), count: nDiffuse },
    { name: 'shadow', kind: 'shadow', mask: VIS_SHADOW, rays: shadowRays(nShadow, 11), count: nShadow }
  ];
  const batches: TraceBatch[] = sets.map((s) => {
    const b = createTraceBatch(device, kernels, s.kind, s.count, RAY_BYTES, s.kind === 'intersect' ? HIT_BYTES : 4);
    device.queue.writeBuffer(b.rays, 0, s.rays);
    writeTraceParams(device, b, s.count, s.mask, gs.tlasRoot);
    return b;
  });
  const enc = device.createCommandEncoder({ label: 'b5 smoke trace' });
  const pass = enc.beginComputePass();
  sets.forEach((s, i) => encodeTrace(pass, kernels, batches[i], gs.bindGroup, s.count, maxPerDim));
  pass.end();
  /* debug image from the camera hits */
  const viz = device.createTexture({
    label: 'b5 smoke viz', size: [cw, ch], format: AOV_FORMATS.color,
    usage: TEXTURE.STORAGE_BINDING | TEXTURE.TEXTURE_BINDING | TEXTURE.COPY_SRC
  });
  const vizUbo = device.createBuffer({ size: 16, usage: BUFFER.UNIFORM | BUFFER.COPY_DST });
  device.queue.writeBuffer(vizUbo, 0, new Uint32Array([cw, ch, 0, 0]));
  const vizBg = device.createBindGroup({
    layout: vizPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: vizUbo } },
      { binding: 1, resource: { buffer: batches[0].out } },
      { binding: 2, resource: viz.createView() }
    ]
  });
  const vp = enc.beginComputePass();
  vp.setPipeline(vizPipeline);
  vp.setBindGroup(0, vizBg);
  vp.dispatchWorkgroups(Math.ceil(cw / 8), Math.ceil(ch / 8));
  vp.end();
  const tg = performance.now();
  device.queue.submit([enc.finish()]);
  const outs = await Promise.all(sets.map((s, i) => readBuffer(device, batches[i].out, s.count * (s.kind === 'intersect' ? HIT_BYTES : 4))));
  const { stackOverflow } = await gs.readDebug();
  log(`GPU traced ${sets.reduce((a, s) => a + s.count, 0)} rays in ${(performance.now() - tg).toFixed(0)} ms (incl. readback); stack overflows: ${stackOverflow}`);
  batches.forEach((b) => b.destroy());

  /* 3. CPU reference (f32 mode) */
  const ref = createTraverser(sc.packed, { f32: true, stackSize: Number(kernels.defines.B5_TRAVERSE_STACK) });
  const mismatches: Mismatch[] = [];
  const tallies: Record<string, Tally> = {};
  const tr = performance.now();
  sets.forEach((s, i) => {
    tallies[s.name] = s.kind === 'intersect'
      ? compareClosest(s.name, s.rays, outs[i], s.count, ref, s.mask, mismatches, tol)
      : compareAny(s.name, s.rays, outs[i], s.count, ref, s.mask, mismatches, tol);
    const t = tallies[s.name];
    log(`${s.name}: ${t.rays} rays, ref hits ${t.hits} — exact ${t.exact}, close ${t.close}, tie ${t.tie}, mismatch ${t.mismatch}` +
      (t.close + t.tie ? `, max |Δt|/t ${t.maxRelDt.toExponential(2)}` : ''));
  });
  const refMs = performance.now() - tr;
  log(`CPU reference (f32 mode) in ${refMs.toFixed(0)} ms; ref max stack ${ref.stats.maxStack}, ref stack overflows ${ref.stats.stackOverflow}`);
  const total = Object.values(tallies).reduce(addTally, newTally());
  const agr = agreement(total);
  for (const m of mismatches.slice(0, 10)) log(`MISMATCH ${m.set} #${m.ray}: ${m.detail}`);

  /* 5. throughput */
  let bench: SmokeReport['bench'] = null;
  if (opts.bench ?? true) {
    const [bw, bh] = opts.benchSize ?? [1920, 1080];
    const n = bw * bh, repeats = opts.benchRepeats ?? 8;
    const run = (kind: KernelName, mask: number, rays: Float32Array) =>
      benchKernel(pt, kernels, gs.bindGroup, gs.tlasRoot, kind, mask, rays, n, repeats, maxPerDim);
    const primary = await run('intersect', VIS_CAMERA, cameraRays(bw, bh));
    const diffuse = await run('intersect', VIS_INDIRECT, diffuseRays(n, 13));
    const shadow = await run('shadow', VIS_SHADOW, shadowRays(n, 17));
    bench = { timer: pt.hasTimestamps ? 'timestamp-query' : 'wall-clock', workgroupSize: kernels.workgroupSize, primary, diffuse, shadow };
    const f = (b: Bench) => `${b.mraysPerSec.toFixed(0)} Mrays/s (median ${b.medianMs.toFixed(2)} ms, min ${b.minMs.toFixed(2)} ms)`;
    log(`throughput [${bench.timer}] ${bw}x${bh} = ${n} rays: primary ${f(primary)}; incoherent closest-hit ${f(diffuse)}; shadow any-hit ${f(shadow)}`);
  }

  const verr = await device.popErrorScope();
  const oom = await device.popErrorScope();
  if (verr) gpuErrors.push(`validation: ${verr.message}`);
  if (oom) gpuErrors.push(`out-of-memory: ${oom.message}`);
  offErr();
  const pass2 = agr >= minAgreement && gpuErrors.length === 0;
  log(`agreement ${(agr * 100).toFixed(4)} % (${total.mismatch} mismatches of ${total.rays}) — ${pass2 ? 'PASS' : 'FAIL'}`);

  const report: SmokeReport = {
    device: describeDevice(pt),
    limits: pt.limits,
    adapterLimits: pt.adapterLimits,
    features: [...pt.features].sort(),
    scene: { tris: sc.triCount, instances: sc.instanceCount, nodes: sc.packed.nodeCount, buildMs: sc.buildMs, mib },
    compileMs: kernels.compileMs,
    tallies, total, agreement: agr, minAgreement,
    mismatches, stackOverflow, refMs, bench, gpuErrors,
    pass: pass2
  };
  return {
    report, viz,
    dispose() { gs.destroy(); viz.destroy(); vizUbo.destroy(); }
  };
}

async function benchKernel(
  pt: PtDevice, kernels: PtKernels, sceneBg: GPUBindGroup, root: number,
  kind: KernelName, mask: number, rays: Float32Array, n: number, repeats: number, maxPerDim: number
): Promise<Bench> {
  const device = pt.device;
  const batch = createTraceBatch(device, kernels, kind, n, RAY_BYTES, kind === 'intersect' ? HIT_BYTES : 4);
  device.queue.writeBuffer(batch.rays, 0, rays);
  writeTraceParams(device, batch, n, mask, root);
  /* warm-up */
  {
    const e = device.createCommandEncoder();
    const p = e.beginComputePass();
    encodeTrace(p, kernels, batch, sceneBg, n, maxPerDim);
    p.end();
    device.queue.submit([e.finish()]);
    await device.queue.onSubmittedWorkDone();
  }
  const ts = pt.hasTimestamps;
  const qs = ts ? device.createQuerySet({ type: 'timestamp', count: repeats * 2 }) : null;
  const resolve = ts ? device.createBuffer({ size: repeats * 16, usage: BUFFER.QUERY_RESOLVE | BUFFER.COPY_SRC }) : null;
  const e = device.createCommandEncoder();
  for (let r = 0; r < repeats; r++) {
    const p = e.beginComputePass(qs ? { timestampWrites: { querySet: qs, beginningOfPassWriteIndex: 2 * r, endOfPassWriteIndex: 2 * r + 1 } } : {});
    encodeTrace(p, kernels, batch, sceneBg, n, maxPerDim);
    p.end();
  }
  if (qs && resolve) e.resolveQuerySet(qs, 0, repeats * 2, resolve, 0);
  const t0 = performance.now();
  device.queue.submit([e.finish()]);
  await device.queue.onSubmittedWorkDone();
  const wallMs = (performance.now() - t0) / repeats;
  let times: number[] = [];
  if (qs && resolve) {
    const raw = new BigUint64Array(await readBuffer(device, resolve, repeats * 16));
    times = Array.from({ length: repeats }, (_, r) => Number(raw[2 * r + 1] - raw[2 * r]) / 1e6);
    qs.destroy();
    resolve.destroy();
  }
  if (!times.length || times.some((t) => !(t > 0))) times = [wallMs];
  batch.destroy();
  const med = median(times);
  return { rays: n, medianMs: med, minMs: Math.min(...times), mraysPerSec: n / (med * 1e-3) / 1e6 };
}
