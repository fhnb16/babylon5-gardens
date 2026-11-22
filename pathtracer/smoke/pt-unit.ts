/* ═══════════════════════════════════════════════════════════════════════════
   PT-W4a GPU unit probes (pt-unit.html → tests/browser/pt-unit.spec.ts):
   the WGSL BSDF and light-sampling modules run on the GPU with the SAME
   inputs (random numbers included) as their CPU mirrors.
     bsdf   — std / water / glass records: sample (wi, pdf, weight, flags) and
              eval at a second direction, per record; white furnace
              (directional albedo, white colours) per configuration, GPU vs CPU;
     lights — a small random emissive-triangle scene (light BVH + alias table
              packed by lights/light-data.ts): tree sample + pmf, tree pmf of a
              given light, alias sample, tube sample / pdf, p_tube.
   Results: window.__ptUnit.
   ═══════════════════════════════════════════════════════════════════════════ */
import { mulberry32 } from '../../core/rng.ts';
import { CORE_CONFIG } from '../../core/config/index.ts';
import { HULL_CONST } from '../../core/shading/kernels/hull.ts';
import { bsdfEval, bsdfSample, glassMake, stdMake, waterMake, type Bsdf, type V3 } from '../bsdf-ref.ts';
import { LIGHT_MODE } from '../config.ts';
import { createDevice, describeDevice } from '../device.ts';
import { BUFFER, MAP } from '../gpu-flags.ts';
import { integratorSources } from '../integrator.ts';
import { buildKernelSource, compileShader } from '../kernels.ts';
import { buildAlias, sampleAlias } from '../lights/alias.ts';
import { packLights } from '../lights/light-data.ts';
import { treePmf, treeSample } from '../lights/light-tree.ts';
import { pTube } from '../lights/select.ts';
import { tubePdfW, tubeSample, type TubeGeom } from '../lights/tube.ts';
import kProbe from './k_probe.wgsl?raw';

const BSDF_IN = 28, BSDF_OUT = 12, LIGHT_IN = 12, LIGHT_OUT = 16;
const MIN_ALPHA = 0.045 ** 2;
/** a few f32 ulps of 1 (pdf conditioning of sharp GGX lobes, see below) */
const F32_COND = 1e-6;
const FURNACE_SAMPLES = 8192;
const RECORDS_PER_CONFIG = 512;
const QUERIES = 4096;
const LIGHTS = 400;
const S = CORE_CONFIG.SUN;
const TUBE: TubeGeom = { radius: S.r, length: S.len, z0: -S.len / 2 };

export interface PtUnitState {
  done: boolean;
  error?: string;
  device?: string;
  log: string[];
  bsdf?: {
    records: number;
    /** records whose sample / eval disagree beyond tolerance */
    mismatches: number;
    worstRel: number;
    furnace: { name: string; cos: number; gpu: number; cpu: number }[];
  };
  lights?: {
    queries: number;
    treeSameLight: number;
    treePmfWorstRel: number;
    pmfEvalWorstRel: number;
    aliasSame: number;
    tubeWorstRel: number;
    tubePdfWorstRel: number;
    pTubeWorstAbs: number;
  };
  gpuErrors: string[];
}

declare global {
  interface Window { __ptUnit?: PtUnitState }
}

const state: PtUnitState = { done: false, log: [], gpuErrors: [] };
window.__ptUnit = state;
const logEl = document.getElementById('log')!;
function log(line: string): void {
  state.log.push(line);
  logEl.textContent += line + '\n';
  console.log('[pt-unit] ' + line);
}

const rel = (a: number, b: number, floor = 1e-6) => Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), floor);

function randDir(rnd: () => number): V3 {
  const z = rnd() * 2 - 1, ph = rnd() * 2 * Math.PI, r = Math.sqrt(1 - z * z);
  return [r * Math.cos(ph), r * Math.sin(ph), z];
}
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

interface Config { name: string; make: (n: V3, nv: number) => Bsdf; white: boolean }
const CONFIGS: Config[] = [
  { name: 'std dielectric r1', make: (n, nv) => stdMake(n, [1, 1, 1], 0, 1, MIN_ALPHA, nv), white: true },
  { name: 'std dielectric r0.3', make: (n, nv) => stdMake(n, [1, 1, 1], 0, 0.3, MIN_ALPHA, nv), white: true },
  { name: 'std metal r0.2', make: (n, nv) => stdMake(n, [1, 1, 1], 1, 0.2, MIN_ALPHA, nv), white: true },
  { name: 'std coloured', make: (n, nv) => stdMake(n, [0.6, 0.3, 0.1], 0.3, 0.6, MIN_ALPHA, nv), white: false },
  { name: 'water white', make: (n, nv) => waterMake(n, [1, 1, 1], [1, 1, 1], 0.1, HULL_CONST.absorbK, MIN_ALPHA, nv), white: true },
  { name: 'water tinted', make: (n, nv) => waterMake(n, [0.4, 0.35, 0.2], [0.02, 0.05, 0.1], 0.05, HULL_CONST.absorbK * 0.6, MIN_ALPHA, nv), white: false },
  { name: 'glass', make: (n) => glassMake(n, [0.9, 0.94, 0.97], 1.5), white: true }
];

function writeBsdf(F: Float32Array, k: number, b: Bsdf, wo: V3, u: V3, wi2: V3): void {
  const i = k * BSDF_IN;
  F.set(b.n, i); F[i + 3] = b.lobe; F.set(b.cd, i + 4); F[i + 7] = b.a; F.set(b.f0, i + 8); F[i + 11] = b.pSpec;
  F.set(b.tint, i + 12); F[i + 15] = b.eta; F[i + 16] = b.depth; F[i + 17] = b.fBoost;
  F.set(wo, i + 18); F.set(u, i + 21); F.set(wi2, i + 24);
}

async function main(): Promise<void> {
  if (!navigator.gpu) throw new Error('navigator.gpu is undefined');
  const pt = await createDevice();
  state.device = describeDevice(pt);
  log(`device: ${state.device}`);
  pt.onError((e) => { state.gpuErrors.push(e.message); log(`GPU ERROR: ${e.message}`); });
  const device = pt.device;
  const sources = { ...integratorSources(), 'k_probe.wgsl': kProbe };
  const module = await compileShader(device, 'k_probe.wgsl', buildKernelSource('k_probe.wgsl', sources, {}));

  async function runProbe(entry: string, input: Float32Array, outFloats: number, count: number, params: number[], ldata?: ArrayBuffer): Promise<Float32Array> {
    const pipe = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: entry } });
    const mkb = (size: number, usage: number) => device.createBuffer({ size: Math.max(16, Math.ceil(size / 16) * 16), usage });
    const inB = mkb(input.byteLength, BUFFER.STORAGE | BUFFER.COPY_DST);
    device.queue.writeBuffer(inB, 0, input);
    const outB = mkb(outFloats * 4, BUFFER.STORAGE | BUFFER.COPY_SRC);
    const prm = mkb(16, BUFFER.UNIFORM | BUFFER.COPY_DST);
    device.queue.writeBuffer(prm, 0, new Float32Array(params));
    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: inB } }, { binding: 1, resource: { buffer: outB } }, { binding: 2, resource: { buffer: prm } }
    ];
    let ldB: GPUBuffer | null = null;
    if (ldata) {
      ldB = mkb(ldata.byteLength, BUFFER.STORAGE | BUFFER.COPY_DST);
      device.queue.writeBuffer(ldB, 0, ldata);
      entries.push({ binding: 3, resource: { buffer: ldB } });
    }
    const bg = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries });
    const rb = mkb(outFloats * 4, BUFFER.MAP_READ | BUFFER.COPY_DST);
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipe);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil(count / 64));
    pass.end();
    enc.copyBufferToBuffer(outB, 0, rb, 0, outFloats * 4);
    device.queue.submit([enc.finish()]);
    await rb.mapAsync(MAP.READ);
    const out = new Float32Array(rb.getMappedRange().slice(0, outFloats * 4));
    rb.unmap();
    for (const b of [inB, outB, prm, rb, ldB]) b?.destroy();
    return out;
  }

  /* ── BSDF: per-record agreement ── */
  {
    const rnd = mulberry32(2024);
    const n = CONFIGS.length * RECORDS_PER_CONFIG;
    const F = new Float32Array(n * BSDF_IN);
    const recs: { b: Bsdf; wo: V3; u: V3; wi2: V3 }[] = [];
    CONFIGS.forEach((c, ci) => {
      for (let j = 0; j < RECORDS_PER_CONFIG; j++) {
        const nrm = randDir(rnd);
        let wo = randDir(rnd);
        if (dot(wo, nrm) < 0) wo = [-wo[0], -wo[1], -wo[2]];
        let wi2 = randDir(rnd);
        if (dot(wi2, nrm) < 0) wi2 = [-wi2[0], -wi2[1], -wi2[2]];
        const b = c.make(nrm, Math.max(dot(nrm, wo), 1e-6));
        const u: V3 = [rnd(), rnd(), rnd()];
        // f32 round-trip so both sides see identical inputs
        const k = ci * RECORDS_PER_CONFIG + j;
        writeBsdf(F, k, b, wo, u, wi2);
        const g = (o: number): V3 => [F[k * BSDF_IN + o], F[k * BSDF_IN + o + 1], F[k * BSDF_IN + o + 2]];
        const bf: Bsdf = { ...b, n: g(0), cd: g(4), a: F[k * BSDF_IN + 7], f0: g(8), pSpec: F[k * BSDF_IN + 11], tint: g(12),
          eta: F[k * BSDF_IN + 15], depth: F[k * BSDF_IN + 16], fBoost: F[k * BSDF_IN + 17] };
        recs.push({ b: bf, wo: g(18), u: g(21), wi2: g(24) });
      }
    });
    const out = await runProbe('b5_k_probe_bsdf', F, n * BSDF_OUT, n, [n, 0, 0, 0]);
    let mismatches = 0, worst = 0;
    const why: Record<string, number> = {};
    const samples: string[] = [];
    recs.forEach((r, k) => {
      const s = bsdfSample(r.b, r.wo, r.u), e = bsdfEval(r.b, r.wo, r.wi2);
      const o = k * BSDF_OUT;
      const flags = (s.delta ? 1 : 0) | (s.through ? 2 : 0) | (s.ok ? 4 : 0);
      let d = 0;
      if (out[o + 7] !== flags) d = 1;
      else {
        if (s.ok) for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(out[o + c] - s.wi[c]), rel(out[o + 4 + c], s.w[c], 1e-3));
        /* the GGX peak pdf is f32-ill-conditioned for sharp lobes: k = 1 − (1 − α²)(n·h)² cancels, an absolute
           error of a few ulps of 1 in (n·h)² is a relative error ≈ F32_COND / α² of the pdf */
        if (s.ok && !s.delta) d = Math.max(d, rel(out[o + 3], s.pdf, 1e-3) * (2e-3 / (2e-3 + F32_COND / (r.b.a * r.b.a))));
        for (let c = 0; c < 3; c++) d = Math.max(d, rel(out[o + 8 + c], e.f[c], 1e-3));
        d = Math.max(d, rel(out[o + 11], e.pdf, 1e-3));
      }
      if (d > 2e-3) {
        mismatches++;
        const key = `${CONFIGS[Math.floor(k / RECORDS_PER_CONFIG)].name}/${out[o + 7] !== flags ? 'flags' : 'values'}`;
        why[key] = (why[key] ?? 0) + 1;
        if (samples.length < 6) samples.push(`${key}: gpu ${Array.from(out.subarray(o, o + 12)).map((x) => x.toPrecision(5)).join(',')} cpu wi ${s.wi.map((x) => x.toPrecision(5))} pdf ${s.pdf.toPrecision(5)} w ${s.w.map((x) => x.toPrecision(5))} e ${e.f.map((x) => x.toPrecision(5))},${e.pdf.toPrecision(5)} a ${r.b.a}`);
      } else worst = Math.max(worst, d);
    });
    log(`bsdf mismatches by config/kind: ${JSON.stringify(why)}\n  ${samples.join('\n  ')}`);
    /* white furnace per configuration at three view angles */
    const furnace: { name: string; cos: number; gpu: number; cpu: number }[] = [];
    const fr = mulberry32(77);
    const cases: { c: Config; cos: number }[] = [];
    for (const c of CONFIGS.filter((x) => x.white)) for (const cos of [1, 0.5, 0.15]) cases.push({ c, cos });
    const nf = cases.length * FURNACE_SAMPLES;
    const FF = new Float32Array(nf * BSDF_IN);
    const cpuSum = new Float64Array(cases.length);
    cases.forEach(({ c, cos }, ci) => {
      const nrm: V3 = [0, 0, 1];
      const wo: V3 = [Math.sqrt(1 - cos * cos), 0, cos];
      const b = c.make(nrm, cos);
      for (let j = 0; j < FURNACE_SAMPLES; j++) {
        const u: V3 = [fr(), fr(), fr()];
        const k = ci * FURNACE_SAMPLES + j;
        writeBsdf(FF, k, b, wo, u, nrm);
        const s = bsdfSample(b, wo, u);
        if (s.ok) cpuSum[ci] += s.w[1];
      }
    });
    const fo = await runProbe('b5_k_probe_bsdf', FF, nf * BSDF_OUT, nf, [nf, 0, 0, 0]);
    cases.forEach(({ c, cos }, ci) => {
      let g = 0;
      for (let j = 0; j < FURNACE_SAMPLES; j++) {
        const o = (ci * FURNACE_SAMPLES + j) * BSDF_OUT;
        if ((fo[o + 7] & 4) !== 0) g += fo[o + 5];
      }
      furnace.push({ name: c.name, cos, gpu: g / FURNACE_SAMPLES, cpu: cpuSum[ci] / FURNACE_SAMPLES });
    });
    state.bsdf = { records: n, mismatches, worstRel: worst, furnace };
    log(`bsdf: ${n} records, ${mismatches} mismatches, worst rel ${worst.toExponential(2)}; furnace ` +
      furnace.map((x) => `${x.name}@${x.cos}: GPU ${x.gpu.toFixed(4)} / CPU ${x.cpu.toFixed(4)}`).join(', '));
  }

  /* ── lights: small random scene ── */
  {
    const rnd = mulberry32(99);
    const verts = new Float32Array(LIGHTS * 9), phi = new Float32Array(LIGHTS), area = new Float32Array(LIGHTS);
    for (let i = 0; i < LIGHTS; i++) {
      const th = rnd() * 2 * Math.PI, r = 25 + rnd() * 24, z = -130 + rnd() * 260;
      const c = [r * Math.cos(th), r * Math.sin(th), z];
      for (let v = 0; v < 3; v++) for (let k = 0; k < 3; k++) verts[i * 9 + v * 3 + k] = c[k] + (rnd() - 0.5) * (0.5 + rnd() * 3);
      phi[i] = rnd() < 0.15 ? 0 : rnd() ** 3 * 50;
      area[i] = 1;
    }
    const list = { count: LIGHTS, verts, inst: new Uint32Array(LIGHTS), tri: new Uint32Array(LIGHTS).map((_, i) => i), area };
    const packed = packLights(list, phi);
    const alias = buildAlias(Array.from(phi));
    const Q = new Float32Array(QUERIES * LIGHT_IN);
    for (let k = 0; k < QUERIES; k++) {
      const th = rnd() * 2 * Math.PI, r = 4 + rnd() * 46;
      const p = [r * Math.cos(th), r * Math.sin(th), -150 + rnd() * 300];
      const n = rnd() < 0.2 ? [0, 0, 0] : randDir(rnd);
      Q.set(p, k * LIGHT_IN); Q.set(n, k * LIGHT_IN + 3);
      Q.set([rnd(), rnd(), rnd()], k * LIGHT_IN + 6);
      Q[k * LIGHT_IN + 9] = Math.floor(rnd() * LIGHTS);
    }
    const out = await runProbe('b5_k_probe_lights', Q, QUERIES * LIGHT_OUT, QUERIES, [QUERIES, TUBE.radius, TUBE.z0, TUBE.length], packed.data);
    let same = 0, pmfW = 0, evalW = 0, aliasSame = 0, tubeW = 0, tpdfW = 0, ptW = 0;
    for (let k = 0; k < QUERIES; k++) {
      const q = Q.subarray(k * LIGHT_IN, (k + 1) * LIGHT_IN), o = out.subarray(k * LIGHT_OUT, (k + 1) * LIGHT_OUT);
      const p = q.subarray(0, 3), n = q.subarray(3, 6);
      const ts = treeSample(packed.tree, p, n, q[6]);
      if (ts && ts.light === o[0]) { same++; pmfW = Math.max(pmfW, rel(o[1], ts.pmf, 1e-12)); }
      evalW = Math.max(evalW, rel(o[2], treePmf(packed.tree, p, n, q[9]), 1e-9));
      if (sampleAlias(alias, q[6]) === o[3]) aliasSame++;
      const tu = tubeSample(p, TUBE, q[7], q[8]);
      if (tu && tu.pdfW > 0) {
        for (let c = 0; c < 3; c++) tubeW = Math.max(tubeW, Math.abs(o[5 + c] - tu.x[c]) / Math.max(1, Math.abs(tu.x[c])));
        tpdfW = Math.max(tpdfW, rel(o[8], tu.pdfW, 1e-9), rel(o[9], tubePdfW(p, [o[5], o[6], o[7]], TUBE), 1e-9));
      }
      ptW = Math.max(ptW, Math.abs(o[10] - pTube(TUBE, 10, packed.tree, LIGHT_MODE.tree, p, n)));
    }
    state.lights = {
      queries: QUERIES, treeSameLight: same / QUERIES, treePmfWorstRel: pmfW, pmfEvalWorstRel: evalW,
      aliasSame: aliasSame / QUERIES, tubeWorstRel: tubeW, tubePdfWorstRel: tpdfW, pTubeWorstAbs: ptW
    };
    log(`lights: ${LIGHTS} triangles (${packed.active} with power, ${packed.nNodes} nodes), ${QUERIES} queries: ` +
      `tree same light ${(100 * same / QUERIES).toFixed(2)} % (pmf worst rel ${pmfW.toExponential(2)}), pmf eval worst rel ${evalW.toExponential(2)}, ` +
      `alias same ${(100 * aliasSame / QUERIES).toFixed(2)} %, tube point worst ${tubeW.toExponential(2)}, tube pdf worst rel ${tpdfW.toExponential(2)}, ` +
      `p_tube worst abs ${ptW.toExponential(2)}`);
  }
}

main().catch((e: unknown) => {
  state.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  log('ERROR ' + state.error);
}).finally(() => { state.done = true; });
