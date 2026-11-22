/* PT-W4a BSDFs, CPU reference (bsdf-ref.ts = mirror of bsdf_*.wgsl):
   white furnace (directional albedo ≤ 1 with white colours), pdf
   normalisation over the sphere, sample/eval consistency, glass event
   probabilities, water absorption limits, WGSL parse. GPU agreement (same
   random numbers → same results): tests/browser/pt-unit.spec.ts. */
import { describe, expect, test } from 'vitest';
import { WgslReflect } from 'wgsl_reflect/wgsl_reflect.module.js';
import { mulberry32 } from '../../core/rng.ts';
import { HULL_CONST } from '../../core/shading/kernels/hull.ts';
import {
  bsdfEval, bsdfSample, directionalAlbedo, fresnelDielectric, glassMake, glassReflectance, stdMake, waterMake,
  type Bsdf, type V3
} from '../bsdf-ref.ts';
import { buildKernelSource } from '../kernels.ts';
import { integratorGeneratedSources } from '../integrator.ts';
import { loadWgslSources } from './wgsl-fs.ts';

const N: V3 = [0.3, -0.2, 0.932737905];
const MIN_ALPHA = 0.045 ** 2;
const wo = (cosT: number, n: V3 = N): V3 => {
  // a direction at angle acos(cosT) from n
  const t: V3 = [n[1], -n[0], 0];
  const l = Math.hypot(t[0], t[1]);
  const s = Math.sqrt(1 - cosT * cosT);
  return [n[0] * cosT + (t[0] / l) * s, n[1] * cosT + (t[1] / l) * s, n[2] * cosT];
};

const CASES: [string, (nv: number) => Bsdf][] = [
  ['std dielectric rough 1', (nv) => stdMake(N, [1, 1, 1], 0, 1, MIN_ALPHA, nv)],
  ['std dielectric rough 0.5', (nv) => stdMake(N, [1, 1, 1], 0, 0.5, MIN_ALPHA, nv)],
  ['std dielectric rough 0.045', (nv) => stdMake(N, [1, 1, 1], 0, 0.045, MIN_ALPHA, nv)],
  ['std metal rough 0.3', (nv) => stdMake(N, [1, 1, 1], 1, 0.3, MIN_ALPHA, nv)],
  ['std half-metal rough 0.7', (nv) => stdMake(N, [1, 1, 1], 0.5, 0.7, MIN_ALPHA, nv)],
  ['water clear (white bed)', (nv) => waterMake(N, [1, 1, 1], [1, 1, 1], 0.045, 0, MIN_ALPHA, nv)],
  ['water deep (white tint)', (nv) => waterMake(N, [1, 1, 1], [1, 1, 1], 0.2, HULL_CONST.absorbK, MIN_ALPHA, nv)]
];

describe('BSDF white furnace (CPU reference)', () => {
  test.each(CASES)('%s: directional albedo ≤ 1 for every view angle', (name, make) => {
    const rnd = mulberry32(9);
    const out: string[] = [];
    for (const c of [1, 0.8, 0.5, 0.25, 0.1, 0.03]) {
      const v = wo(c);
      const a = directionalAlbedo(make(c), v, 60_000, rnd);
      const m = Math.max(...a.mean);
      out.push(`cos ${c}: ${m.toFixed(4)}`);
      expect(m).toBeLessThan(1 + 4 * a.stderr + 1e-3);
      // and not absurdly lossy (single-scatter GGX loses energy at grazing views)
      expect(m).toBeGreaterThan(c >= 0.5 ? 0.55 : 0.15);
    }
    console.log(`[bsdf furnace] ${name}: ${out.join(', ')}`);
  });

  test.each(CASES)('%s: mixture pdf integrates to 1 over the hemisphere (uniform sphere MC)', (_n, make) => {
    const rnd = mulberry32(13);
    for (const c of [0.9, 0.4]) {
      const v = wo(c), b = make(c);
      let s = 0;
      const M = 200_000;
      for (let k = 0; k < M; k++) {
        const z = rnd() * 2 - 1, ph = rnd() * 2 * Math.PI, r = Math.sqrt(1 - z * z);
        s += bsdfEval(b, v, [r * Math.cos(ph), r * Math.sin(ph), z]).pdf * 4 * Math.PI;
      }
      // the VNDF lobe leaks below the horizon for rough / grazing views (those samples are rejected) → ≤ 1
      expect(s / M).toBeLessThan(1.02);
      expect(s / M).toBeGreaterThan(b.a > 0.2 ? 0.8 : 0.9);
    }
  });

  test.each(CASES)('%s: sample/eval consistency', (_n, make) => {
    const rnd = mulberry32(17);
    const v = wo(0.6), b = make(0.6);
    for (let k = 0; k < 5000; k++) {
      const s = bsdfSample(b, v, [rnd(), rnd(), rnd()]);
      if (!s.ok) continue;
      const e = bsdfEval(b, v, s.wi);
      expect(e.pdf / s.pdf).toBeCloseTo(1, 9);
      const c = N[0] * s.wi[0] + N[1] * s.wi[1] + N[2] * s.wi[2];
      expect((e.f[1] * c) / e.pdf).toBeCloseTo(s.w[1], 6);
    }
  });
});

describe('thin glass', () => {
  test('reflect with R′ = 2R/(1+R), transmit straight with the tint; energy = R′ + (1 − R′)·tint ≤ 1', () => {
    const rnd = mulberry32(1);
    const tint: V3 = [0.9, 0.94, 0.97];
    for (const c of [1, 0.5, 0.1]) {
      const v = wo(c), b = glassMake(N, tint, 1.5);
      const R = fresnelDielectric(c, 1.5), Rp = (2 * R) / (1 + R);
      expect(glassReflectance(c, 1.5)).toBeCloseTo(Rp, 12);
      let refl = 0, e = 0;
      let nonDelta = 0, wrongDirection = 0;
      const transmitted = v.map(x => -x);
      const M = 200_000;
      for (let k = 0; k < M; k++) {
        const s = bsdfSample(b, v, [rnd(), rnd(), rnd()]);
        if (s.delta !== true) nonDelta++;
        if (!s.through) refl++;
        else if (s.wi.length !== transmitted.length || s.wi.some((x, i) => !Object.is(x, transmitted[i]))) wrongDirection++;
        e += s.w[1];
      }
      expect(nonDelta).toBe(0);
      expect(wrongDirection).toBe(0);
      expect(Math.abs(refl / M - Rp)).toBeLessThan(5 * Math.sqrt(Rp * (1 - Rp) / M) + 1e-4);
      expect(e / M).toBeLessThanOrEqual(1);
      expect(Math.abs(e / M - (Rp + (1 - Rp) * tint[1]))).toBeLessThan(0.005);
    }
    expect(fresnelDielectric(1, 1.5)).toBeCloseTo(0.04, 9);
    expect(bsdfEval(glassMake(N, tint, 1.5), wo(0.5), wo(0.5)).pdf).toBe(0);
  });
});

describe('water', () => {
  test('normal-incidence absorption equals the raster mix(bed, waterTint, 1 − exp(−absorbK·w))', () => {
    const bed: V3 = [0.4, 0.3, 0.2], tint: V3 = [0.02, 0.05, 0.1];
    for (const w of [0, 0.3, 1]) {
      const b = waterMake(N, bed, tint, 0.2, HULL_CONST.absorbK * w, MIN_ALPHA, 1);
      // diffuse part at normal view/light, divided by both interface transmissions
      const e = bsdfEval({ ...b, pSpec: 0 }, N, N);
      const F = fresnelDielectric(1, 1.33);
      const rho = e.f.map((x) => (x * Math.PI) / ((1 - F) ** 2));
      const a = 1 - Math.exp(-HULL_CONST.absorbK * w);
      for (let k = 0; k < 3; k++) expect(rho[k]).toBeCloseTo(bed[k] + (tint[k] - bed[k]) * a, 6);
    }
    expect(fresnelDielectric(1, 1.33)).toBeCloseTo(((1.33 - 1) / 2.33) ** 2, 9);
  });
});

describe('BSDF / light WGSL', () => {
  test('the GPU probe kernel (all BSDF + light modules, no surface) parses; hygiene', () => {
    const src = buildKernelSource('k_probe.wgsl', { ...loadWgslSources(), ...integratorGeneratedSources() });
    const r = new WgslReflect(src.code);
    expect(r.entry.compute.map((f) => f.name).sort()).toEqual(['b5_k_probe_bsdf', 'b5_k_probe_lights']);
    for (const s of ['B5Bsdf', 'B5BsdfSample', 'B5TubeSample', 'B5LNode', 'B5LightTri']) expect(r.getStructInfo(s), s).toBeTruthy();
    expect(src.code.includes('$')).toBe(false);
    for (const m of src.code.matchAll(/^(?:const|override|fn|struct|var(?:<[^>]*>)?)\s+(\w+)/gm)) expect(m[1]).toMatch(/^(B5|b5_)/);
  });
});
