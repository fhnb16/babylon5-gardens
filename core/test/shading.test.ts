/* Shading kernels: CPU behaviour, golden equivalence with the legacy GLSL
   (transcribed by hand below), recorder cross-check, WGSL hygiene/validity. */
import { describe, expect, test } from 'vitest';
import { CORE_CONFIG } from '../config/index.ts';
import { FOAM_COLOR, LAMP_TINT } from '../shading/contracts.ts';
import { K_FUNCTIONS, unroll } from '../shading/kernel.ts';
import type { Kernel } from '../shading/kernel.ts';
import { hullSurface } from '../shading/kernels/hull.ts';
import { hullMirror } from '../shading/kernels/hullMirror.ts';
import { windOffset } from '../shading/kernels/wind.ts';
import { fogFade } from '../shading/kernels/fogfade.ts';
import { foliageDither } from '../shading/kernels/foliageDither.ts';
import { cpuK, evaluateKernel, evaluateRecorded } from '../shading/emit/cpu.ts';
import type { CpuValues } from '../shading/emit/cpu.ts';
import { recordKernel } from '../shading/emit/record.ts';
import type { Recorded } from '../shading/emit/record.ts';
import {
  emitWgsl, emitWgslLibrary, flatParamLayout, packFlatParams, uniformLayout, wgslFloat
} from '../shading/emit/wgsl.ts';
import { mulberry32 } from '../rng.ts';
import { buildScene, defaultParams } from '../scene/build.ts';

/* ─── fixtures ───────────────────────────────────────────────────────────── */

const D2R = Math.PI / 180;
const AX = CORE_CONFIG.AXIS;
const ARMS = unroll<number[]>(AX.sparArms, [], (a, k) => [...a, (AX.sparAngle + k * 360 / AX.sparArms) * D2R]);

const HULL_U: CpuValues = {
  time: 3.7, flow: CORE_CONFIG.RIVER_FLOW, foam: CORE_CONFIG.WATER.foam, ripple: CORE_CONFIG.WATER.ripple,
  waterTint: [0.0137, 0.0544, 0.1170], cityGlow: 0.9, citySpill: CORE_CONFIG.CITY.spill,
  sparShade: CORE_CONFIG.DAY.sparShade, armW: AX.trussW / CORE_CONFIG.R * 1.4, sparZW: 30,
  arms: ARMS, sparZ: AX.spars.slice(),
};
const HULL_I: CpuValues = {
  base: [0.30, 0.45, 0.20], mask: [0, 0, 0], dGrass: 0.5, dPave: 0.5, baseRough: 0.95,
  p: [120.3, 47.9], far: 0, theta: 0.3, z: 0,
};
const hull = (i: Partial<CpuValues>, u: Partial<CpuValues> = {}, raster = true): CpuValues =>
  evaluateKernel(hullSurface, { ...HULL_I, ...i } as CpuValues, { ...HULL_U, ...u } as CpuValues,
    { raster, nArm: AX.sparArms, nSpar: AX.spars.length });
const v3 = (v: CpuValues[string]): number[] => [...(v as number[])];
const n = (v: CpuValues[string]): number => v as number;

/* ─── legacy GLSL transcribed to JS (reference semantics) ────────────────── */

const G = {
  mix: (a: number, b: number, t: number) => a * (1 - t) + b * t,
  clamp: (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi),
  smoothstep(e0: number, e1: number, x: number) {
    const t = G.clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  },
  mod: (x: number, y: number) => x - y * Math.floor(x / y),
  dot: (a: number[], b: number[]) => a.reduce((s, x, k) => s + x * b[k], 0),
  normalize(a: number[]) { const l = Math.sqrt(G.dot(a, a)); return a.map(x => x / l); },
  reflect(i: number[], nn: number[]) { const d = G.dot(nn, i); return i.map((x, k) => x - 2 * d * nn[k]); },
};
const PI = 3.141592653589793;

/** js/world.js patchHullMaterial (map, emissive, roughness, normal chunks), vMapUv*(314,300) → p. */
function legacyHull(i: CpuValues, u: CpuValues, raster: boolean) {
  const mask = v3(i.mask), base = v3(i.base), p = v3(i.p);
  const time = n(u.time), flow = n(u.flow);
  let dc = base.map(x => x * G.mix(1.0, 0.70 + 0.60 * n(i.dGrass), mask[1] * 0.9));
  dc = dc.map(x => x * G.mix(1.0, 0.86 + 0.28 * n(i.dPave), mask[2] * 0.7));
  const wDeep = mask[0];
  const absorb = 1.0 - Math.exp(-wDeep * 3.2);
  dc = dc.map((x, k) => G.mix(x, v3(u.waterTint)[k], absorb));
  if (wDeep > 0.001) {
    const edge = G.smoothstep(0.20, 0.02, wDeep);
    const fp = [p[0], p[1] - time * flow];
    const f = Math.sin(fp[0] * 14.0 + Math.sin(fp[1] * 3.1) * 2.0) * 0.5 + 0.5;
    dc = dc.map((x, k) => x + [0.55, 0.62, 0.66][k] * edge * (0.35 + 0.65 * f) * n(u.foam));
  }
  if (raster) {
    let zt = 0.0;
    for (const sz of v3(u.sparZ)) zt = Math.max(zt, 1.0 - G.smoothstep(0.0, n(u.sparZW), Math.abs(n(i.z) - sz)));
    if (zt > 0.002) {
      let shade = 1.0;
      for (const arm of v3(u.arms)) {
        let d = n(i.theta) - arm;
        d = G.mod(d + PI, 2.0 * PI) - PI;
        shade -= n(u.sparShade) * zt * (1.0 - G.smoothstep(0.0, n(u.armW), Math.abs(d)));
      }
      dc = dc.map(x => x * G.clamp(shade, 0.25, 1.0));
    }
  }
  const lamps = G.smoothstep(0.10, 0.75, mask[2]);
  const spill = G.smoothstep(0.02, 0.30, mask[2]) * n(u.citySpill);
  const emissive = dc.map((x, k) => n(u.cityGlow) * x * (lamps * (0.5 + 0.8 * n(i.dPave)) + spill) * [1.0, 0.86, 0.66][k]);
  const wFar = n(i.far);
  const wet = G.smoothstep(0.04, 0.14, mask[0]);
  const roughness = G.mix(n(i.baseRough), G.mix(0.045, 0.20, wFar), wet);
  let slope = [0, 0];
  if (mask[0] > 0.02) {
    const P = [p[0], p[1] - time * flow];
    const t = time, near = 1.0 - wFar;
    const rip = [0, 0];
    const add = (a: number[], s: number) => { rip[0] += a[0] * s; rip[1] += a[1] * s; };
    add([1.00, 0.14], Math.cos(G.dot(P, [7.9, 1.1]) + t * 2.1));
    add([0.74, -0.11], Math.cos(G.dot(P, [12.7, -1.9]) - t * 2.8));
    add([0.46, 0.08], Math.cos(G.dot(P, [23.3, 3.1]) + t * 4.2) * near);
    add([0.28, -0.06], Math.cos(G.dot(P, [41.1, -4.7]) - t * 5.9) * near);
    add([0.22, 0.55], Math.cos(G.dot(P, [1.7, 0.9]) + t * 0.8));
    const amp = n(u.ripple) * mask[0] * (0.45 + 0.55 * near);
    slope = [rip[0] * amp, rip[1] * amp];
  }
  return { albedo: dc, roughness, slope, water: mask[0], emissive };
}

/** uMirror branch; the texture fetch is replaced by (hullUv, hullWeight). */
function legacyMirror(i: CpuValues, u: CpuValues) {
  let sunEmissive = [0, 0, 0], hullUv = [0, 0], hullWeight = 0;
  const water = n(i.water), mirror = n(u.mirror), R = n(u.hullR), L = n(u.hullL), slope = v3(i.slope);
  if (mirror > 0.001 && water > 0.02) {
    const sT = Math.sin(n(i.theta)), cT = Math.cos(n(i.theta));
    const Pw = [sT * R, cT * R, n(i.z)];
    const up = [-sT, -cT, 0.0], tu = [cT, -sT, 0.0], tv = [0.0, 0.0, 1.0];
    const Nw = G.normalize(up.map((x, k) => x + tu[k] * slope[0] + tv[k] * slope[1]));
    const Vw = G.normalize(Pw.map((x, k) => x - v3(u.camObj)[k]));
    const Rw = G.reflect(Vw, Nw);
    let got: number[] | null = null, huv: number[] | null = null, found = 0;
    const qa = G.dot(Rw.slice(0, 2), Rw.slice(0, 2));
    if (qa > 1e-6) {
      const qb = 2.0 * G.dot(Pw.slice(0, 2), Rw.slice(0, 2));
      const pp = G.dot(Pw.slice(0, 2), Pw.slice(0, 2));
      const ds = qb * qb - 4.0 * qa * (pp - n(u.sunR) * n(u.sunR));
      if (ds > 0.0) {
        const ts = (-qb - Math.sqrt(ds)) / (2.0 * qa);
        if (ts > 0.05 && Math.abs(Pw[2] + Rw[2] * ts) < L * 0.5) {
          got = [1.0, 0.94, 0.78].map(x => x * n(u.sunGlow)); found = 1.0;
        }
      }
      if (found < 0.5) {
        const dh = qb * qb - 4.0 * qa * (pp - R * R);
        if (dh > 0.0) {
          const th2 = (-qb + Math.sqrt(dh)) / (2.0 * qa);
          const hw = Pw.map((x, k) => x + Rw[k] * th2);
          if (th2 > 0.05 && Math.abs(hw[2]) < L * 0.5) {
            /* v2.12.0 behaviour fix: legacy GLSL had 0.5 − θ/2π (the hull at
               angle π − θ); the baked hull UV is u ≡ θ/2π */
            const a = Math.atan2(hw[0], hw[1]) / 6.28318531;
            huv = [a - Math.floor(a), hw[2] / L + 0.5]; found = 1.0;
          }
        }
      }
    }
    const fr = Math.pow(1.0 - Math.max(0.0, G.dot(Vw.map(x => -x), Nw)), 4.0);
    const w = found * water * mirror * (0.04 + 0.96 * fr);
    if (got) sunEmissive = got.map(x => x * w);
    else if (huv) { hullUv = huv; hullWeight = w; }
  }
  return { sunEmissive, hullUv, hullWeight };
}

/** js/world.js patchWindMaterial (begin_vertex), phase passed in. */
function legacyWind(i: CpuValues, u: CpuValues) {
  const p = v3(i.pGeom), ph = n(i.phase), t = n(u.time), wind = n(u.wind);
  const tr = p.slice();
  const sway = Math.sin(t * 1.7 + ph) + 0.5 * Math.sin(t * 2.9 + ph * 1.7);
  const amp = 0.035 * wind * (tr[1] + 0.9);
  tr[0] += sway * amp;
  tr[2] += Math.cos(t * 1.3 + ph) * amp * 0.6;
  const leafPh = ph + tr[1] * 5.3 + tr[0] * 3.1 + tr[2] * 2.7;
  const nn = G.normalize(tr), s = Math.sin(t * 3.6 + leafPh) * 0.055 * wind;
  return { offset: tr.map((x, k) => x + nn[k] * s - p[k]) };
}

/** js/util.js fadeByFog. */
function legacyFog(i: CpuValues, u: CpuValues) {
  const D = n(u.fogDensity), d = n(i.viewDist);
  const fogF = 1.0 - Math.exp(-D * D * d * d);
  return { opacity: n(i.opacity) * (1.0 - G.clamp(fogF, 0.0, 1.0)) };
}

function maxDiff(a: CpuValues, b: Record<string, number | number[]>): number {
  let m = 0;
  for (const k of Object.keys(b)) {
    const x = a[k], y = b[k];
    const xs = typeof x === 'number' ? [x] : [...x], ys = typeof y === 'number' ? [y] : y;
    expect(xs.length).toBe(ys.length);
    for (let j = 0; j < xs.length; j++) m = Math.max(m, Math.abs(xs[j] - ys[j]));
  }
  return m;
}

/* random input generators */
const rnd = mulberry32(12345);
const r = (lo: number, hi: number) => lo + (hi - lo) * rnd();
const r3 = (lo: number, hi: number) => [r(lo, hi), r(lo, hi), r(lo, hi)];
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];

function randomHull(): { i: CpuValues; u: CpuValues } {
  // bias depth / theta / z toward the interesting thresholds
  const depth = pick([0, 0.0005, 0.01, 0.03, 0.1, 0.15, r(0, 0.25), r(0, 1), 1]);
  const z = rnd() < 0.5 ? pick(AX.spars) + r(-35, 35) : r(-150, 150);
  const theta = rnd() < 0.5 ? pick(ARMS) + r(-0.1, 0.1) + pick([0, 2 * PI, -2 * PI]) : r(-7, 7);
  return {
    i: {
      base: r3(0, 1), mask: [depth, r(0, 1), pick([0, r(0, 1), 1])], dGrass: r(0, 1), dPave: r(0, 1),
      baseRough: r(0.2, 1), p: [r(0, 314), r(0, 300)], far: pick([0, 1, r(0, 1)]), theta, z,
    },
    u: {
      ...HULL_U, time: r(0, 1000), flow: r(0, 0.5), foam: r(0, 0.4), ripple: r(0, 0.05),
      waterTint: r3(0, 0.3), cityGlow: r(0, 2), citySpill: r(0, 0.5), sparShade: r(0, 1),
    },
  };
}

function randomMirror(): { i: CpuValues; u: CpuValues } {
  const cr = r(0, 45), ca = r(0, 2 * PI);
  return {
    i: { theta: r(-PI, PI), z: r(-150, 150), slope: [r(-0.05, 0.05), r(-0.05, 0.05)], water: pick([0, 0.01, r(0, 1)]) },
    u: {
      mirror: pick([0, r(0, 1)]), sunR: CORE_CONFIG.SUN.r, hullR: CORE_CONFIG.R, hullL: CORE_CONFIG.L, sunGlow: 3.2,
      camObj: [cr * Math.sin(ca), cr * Math.cos(ca), r(-140, 140)],
    },
  };
}

/* ─── behaviour ──────────────────────────────────────────────────────────── */

describe('hull kernel behaviour (CPU)', () => {
  const deep = { mask: [1, 0, 0] };

  test('water roughness: 0.045 near, 0.20 far on deep water; baseRough on dry ground', () => {
    expect(n(hull({ ...deep, far: 0 }).roughness)).toBeCloseTo(0.045, 12);
    expect(n(hull({ ...deep, far: 1 }).roughness)).toBeCloseTo(0.20, 12);
    expect(n(hull({ mask: [0, 1, 0], baseRough: 0.83 }).roughness)).toBe(0.83);
    // shallow water is as glossy as deep water (legacy design: no depth dependence past wetHi)
    expect(n(hull({ mask: [0.2, 0, 0], far: 0 }).roughness)).toBeCloseTo(0.045, 12);
  });

  test('absorption pulls deep water to waterTint', () => {
    const tint = v3(HULL_U.waterTint);
    const dist = (d: number) => {
      const a = v3(hull({ mask: [d, 0, 0], theta: 2.5, z: 0 }).albedo);
      return Math.hypot(a[0] - tint[0], a[1] - tint[1], a[2] - tint[2]);
    };
    expect(dist(1)).toBeLessThan(dist(0.5));
    expect(dist(0.5)).toBeLessThan(dist(0.25));
    const base = v3(HULL_I.base);
    expect(dist(1)).toBeLessThan(0.05 * Math.hypot(base[0] - tint[0], base[1] - tint[1], base[2] - tint[2]));
  });

  test('foam only at shallow edges', () => {
    const foamDelta = (d: number) => {
      const a = v3(hull({ mask: [d, 0, 0] }).albedo), b = v3(hull({ mask: [d, 0, 0] }, { foam: 0 }).albedo);
      return a[0] - b[0] + a[1] - b[1] + a[2] - b[2];
    };
    expect(foamDelta(0)).toBe(0);
    expect(foamDelta(0.0005)).toBe(0);      // below the wDeep > 0.001 gate
    expect(foamDelta(0.05)).toBeGreaterThan(0);
    expect(foamDelta(0.3)).toBe(0);
    expect(foamDelta(1)).toBe(0);
  });

  test('ripple: zero on dry ground, moves with time, advected by flow', () => {
    expect(v3(hull({ mask: [0, 1, 0] }).slope)).toEqual([0, 0]);
    expect(v3(hull({ mask: [0.015, 0, 0] }).slope)).toEqual([0, 0]);
    const s0 = v3(hull({ ...deep }, { time: 0 }).slope), s1 = v3(hull({ ...deep }, { time: 1.3 }).slope);
    expect(Math.hypot(s1[0] - s0[0], s1[1] - s0[1])).toBeGreaterThan(1e-4);
    // phase shift ∝ flow: (p.y, flow) ≡ (p.y − t·flow, flow = 0)
    const t = 7.1, flow = 0.37, p = [33.3, 101.7];
    const a = v3(hull({ ...deep, p }, { time: t, flow }).slope);
    const b = v3(hull({ ...deep, p: [p[0], p[1] - t * flow] }, { time: t, flow: 0 }).slope);
    expect(a[0]).toBeCloseTo(b[0], 9);
    expect(a[1]).toBeCloseTo(b[1], 9);
    // far fades fine ripples: amplitude scale (0.45 + 0.55 near)
    expect(Math.hypot(...v3(hull({ ...deep, far: 1 }).slope))).toBeLessThan(Math.hypot(...v3(hull({ ...deep, far: 0 }).slope)));
  });

  test('truss shadow: darkest on an arm near a spar; none off-spar or when raster = false', () => {
    const at = (theta: number, z: number, raster = true) =>
      v3(hull({ mask: [0, 0, 0], theta, z }, {}, raster).albedo)[1];
    const lit = at(ARMS[0] + 1.0, AX.spars[0]);
    const onArm = at(ARMS[0], AX.spars[0]);
    expect(onArm).toBeLessThan(lit * 0.6);
    expect(at(ARMS[1] + 2 * PI, AX.spars[1])).toBeCloseTo(onArm, 12);       // floored mod wraps θ
    expect(at(ARMS[0] + 0.03, AX.spars[0])).toBeGreaterThan(onArm);
    expect(at(ARMS[0], AX.spars[0] + 40)).toBe(lit);                        // outside sparZW
    expect(at(ARMS[0], AX.spars[0], false)).toBe(lit);
  });

  test('city glow: zero when cityGlow = 0, lamps on pavement', () => {
    expect(v3(hull({ mask: [0, 0, 1] }, { cityGlow: 0 }).emissive)).toEqual([0, 0, 0]);
    const e = v3(hull({ mask: [0, 0, 1], base: [0.5, 0.5, 0.5] }).emissive);
    expect(e[0]).toBeGreaterThan(0);
    expect(e[1] / e[0]).toBeLessThan(1);   // warm lamp tint
    expect(v3(hull({ mask: [0, 1, 0] }).emissive)).toEqual([0, 0, 0]);
  });

  test('water weight = mask.r', () => {
    expect(n(hull({ mask: [0.42, 0.1, 0.2] }).water)).toBe(0.42);
  });
});

describe('wind / fog / foliage behaviour (CPU)', () => {
  test('wind offset is exactly zero at wind = 0', () => {
    for (let k = 0; k < 20; k++) {
      const o = evaluateKernel(windOffset, { pGeom: r3(-1, 1), phase: r(0, 50) }, { time: r(0, 100), wind: 0 });
      expect(v3(o.offset).map(Math.abs)).toEqual([0, 0, 0]);
    }
    const o = evaluateKernel(windOffset, { pGeom: [0.3, 0.8, -0.2], phase: 1.1 }, { time: 2, wind: 1 });
    expect(Math.hypot(...v3(o.offset))).toBeGreaterThan(0.005);
  });

  test('fog fade: opaque at 0, transparent far away', () => {
    expect(n(evaluateKernel(fogFade, { viewDist: 0, opacity: 0.8 }, { fogDensity: 0.004 }).opacity)).toBe(0.8);
    expect(n(evaluateKernel(fogFade, { viewDist: 5000, opacity: 0.8 }, { fogDensity: 0.004 }).opacity)).toBeLessThan(1e-6);
  });

  test('foliage dither: range, per-cell constant, varied', () => {
    const amount = 0.3, cell = 0.5;
    const ks = new Set<number>();
    for (let q = 0; q < 300; q++) {
      const pw = r3(-150, 150);
      const k = n(evaluateKernel(foliageDither, { pWorld: pw }, { amount, cell }).k);
      expect(k).toBeGreaterThanOrEqual(1 - amount / 2);
      expect(k).toBeLessThan(1 + amount / 2);
      const c = pw.map(x => (Math.floor(x / cell) + 0.5) * cell);   // cell centre: same cell
      expect(n(evaluateKernel(foliageDither, { pWorld: c }, { amount, cell }).k)).toBe(k);
      ks.add(Math.round(k * 1e6));
    }
    expect(ks.size).toBeGreaterThan(250);
    expect(n(evaluateKernel(foliageDither, { pWorld: [1, 2, 3] }, { amount: 0, cell }).k)).toBe(1);
  });
});

/* ─── golden equivalence with the legacy GLSL ────────────────────────────── */

describe('golden equivalence: kernels vs transcribed legacy GLSL', () => {
  test('hull surface (raster and tracer variants), 4000 random points', () => {
    let m = 0;
    for (let q = 0; q < 4000; q++) {
      const { i, u } = randomHull();
      const raster = q % 2 === 0;
      const got = evaluateKernel(hullSurface, i, u, { raster, nArm: AX.sparArms, nSpar: AX.spars.length });
      m = Math.max(m, maxDiff(got, legacyHull(i, u, raster)));
    }
    expect(m).toBeLessThan(1e-6);
  });

  test('hull mirror, 4000 random points', () => {
    let m = 0, sun = 0, hit = 0;
    for (let q = 0; q < 4000; q++) {
      const { i, u } = randomMirror();
      const ref = legacyMirror(i, u);
      if (ref.sunEmissive[0] > 0) sun++;
      if (ref.hullWeight > 0) hit++;
      m = Math.max(m, maxDiff(evaluateKernel(hullMirror, i, u), ref));
    }
    expect(m).toBeLessThan(1e-6);
    expect(sun).toBeGreaterThan(10);    // both branches exercised
    expect(hit).toBeGreaterThan(100);
  });

  test('hull mirror samples the hull at the geometrically reflected point', () => {
    /* Independent of the kernel maths: reflect the view ray about the water
       normal, march it to the cylinder wall, and look up the baked hull UV of
       the core hull geometry (buildScene) nearest to that point. The kernel's
       hullUv must name that same texel column (u) and row (v). */
    const scene = buildScene(defaultParams('LOW'));
    const g = scene.geometries[scene.meshes.find(mm => mm.role === 'hull')!.geometry];
    const R = CORE_CONFIG.R, L = CORE_CONFIG.L;
    /* hull vertices bucketed by angle for a nearest lookup */
    const NB = 720, cols: number[][] = Array.from({ length: NB }, () => []);
    for (let k = 0; k < g.position.length / 3; k++) {
      const t = Math.atan2(g.position[3 * k], g.position[3 * k + 1]);
      cols[Math.floor(((t / (2 * PI)) % 1 + 1) % 1 * NB) % NB].push(k);
    }
    const uvAt = (x: number, y: number, z: number): [number, number] => {
      const t = Math.atan2(x, y), b = Math.floor(((t / (2 * PI)) % 1 + 1) % 1 * NB) % NB;
      let best = -1, bd = Infinity;
      for (const db of [-1, 0, 1]) {
        for (const k of cols[(b + db + NB) % NB]) {
          const d = (g.position[3 * k] - x) ** 2 + (g.position[3 * k + 1] - y) ** 2 + (g.position[3 * k + 2] - z) ** 2;
          if (d < bd) { bd = d; best = k; }
        }
      }
      return [g.uv[2 * best], g.uv[2 * best + 1]];
    };
    const wrapD = (a: number, b: number): number => { const d = Math.abs(a - b) % 1; return Math.min(d, 1 - d); };
    let checked = 0, worstU = 0, worstV = 0;
    for (let q = 0; q < 3000 && checked < 300; q++) {
      const { i, u } = randomMirror();
      u.mirror = 1; i.water = 0.5; i.slope = [0, 0];
      const out = evaluateKernel(hullMirror, i, u);
      if (!(n(out.hullWeight) > 0)) continue;
      /* geometric reflection (flat water: the normal points to the axis) */
      const th = n(i.theta), P = [Math.sin(th) * R, Math.cos(th) * R, n(i.z)];
      const N = [-Math.sin(th), -Math.cos(th), 0];
      const V = G.normalize(P.map((x, k) => x - v3(u.camObj)[k]));
      const Rv = V.map((x, k) => x - 2 * G.dot(V, N) * N[k]);
      /* far root of |P.xy + t Rv.xy| = R */
      const a = Rv[0] ** 2 + Rv[1] ** 2, b = 2 * (P[0] * Rv[0] + P[1] * Rv[1]), c = P[0] ** 2 + P[1] ** 2 - R * R;
      const t = (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
      const H = [P[0] + Rv[0] * t, P[1] + Rv[1] * t, P[2] + Rv[2] * t];
      if (Math.abs(H[2]) > L / 2 - 1) continue;
      const [gu, gv] = uvAt(H[0], H[1], H[2]);
      const huv = v3(out.hullUv);
      worstU = Math.max(worstU, wrapD(huv[0], gu));
      worstV = Math.max(worstV, Math.abs(huv[1] - gv));
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
    /* nearest-vertex lookup: within about one hull segment */
    expect(worstU).toBeLessThan(2 / 256);
    expect(worstV).toBeLessThan(0.02);
  });

  test('wind and fog fade, 2000 random points', () => {
    let m = 0;
    for (let q = 0; q < 2000; q++) {
      const wi = { pGeom: r3(-1.2, 1.2), phase: r(-100, 100) }, wu = { time: r(0, 1000), wind: r(0, 2) };
      m = Math.max(m, maxDiff(evaluateKernel(windOffset, wi, wu), legacyWind(wi, wu)));
      const fi = { viewDist: r(0, 400), opacity: r(0, 1) }, fu = { fogDensity: r(0, 0.02) };
      m = Math.max(m, maxDiff(evaluateKernel(fogFade, fi, fu), legacyFog(fi, fu)));
    }
    expect(m).toBeLessThan(1e-6);
  });

  test('constants match the contract', () => {
    expect(FOAM_COLOR).toEqual([0.55, 0.62, 0.66]);
    expect(LAMP_TINT).toEqual([1.0, 0.86, 0.66]);
  });
});

/* ─── recorder (feeds WGSL) vs direct CPU evaluation ─────────────────────── */

describe('recorded DAG evaluates like the kernel', () => {
  test('all kernels, random inputs', () => {
    const cases: [Kernel<never>, () => { i: CpuValues; u: CpuValues }, unknown][] = [
      [hullSurface as Kernel<never>, randomHull, { raster: true, nArm: AX.sparArms, nSpar: AX.spars.length }],
      [hullSurface as Kernel<never>, randomHull, { raster: false, nArm: AX.sparArms, nSpar: AX.spars.length }],
      [hullMirror as Kernel<never>, randomMirror, undefined],
      [windOffset as Kernel<never>, () => ({ i: { pGeom: r3(-1, 1), phase: r(0, 9) }, u: { time: r(0, 99), wind: r(0, 2) } }), undefined],
      [fogFade as Kernel<never>, () => ({ i: { viewDist: r(0, 300), opacity: r(0, 1) }, u: { fogDensity: r(0, 0.02) } }), undefined],
      [foliageDither as Kernel<never>, () => ({ i: { pWorld: r3(-150, 150) }, u: { amount: 0.3, cell: 0.7 } }), undefined],
    ];
    for (const [kernel, gen, opts] of cases) {
      const rec = recordKernel(kernel, opts as never);
      for (let q = 0; q < 300; q++) {
        const { i, u } = gen();
        const a = evaluateKernel(kernel, i, u, opts as never);
        expect(maxDiff(evaluateRecorded(rec, i, u), a as Record<string, number | number[]>)).toBe(0);
      }
    }
  });

  test('CSE: identical sub-expressions share one node', () => {
    const rec = recordKernel(hullSurface);
    const keys = rec.graph.nodes.map(e => `${e.op}|${e.value}|${e.src}${e.name}${e.index}|${e.comps}|${e.args.map(a => a.id)}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('K surface is complete on the CPU evaluator', () => {
    for (const f of K_FUNCTIONS) expect(typeof cpuK[f]).toBe('function');
  });
});

/* ─── WGSL ───────────────────────────────────────────────────────────────── */

const LIB_KERNELS = [
  { kernel: hullSurface as Kernel<unknown>, options: { raster: false, nArm: AX.sparArms, nSpar: AX.spars.length } },
  { kernel: hullMirror as Kernel<unknown> },
  { kernel: windOffset as Kernel<unknown> },
  { kernel: fogFade as Kernel<unknown> },
  { kernel: foliageDither as Kernel<unknown> },
];

function hygiene(src: string): void {
  expect(src).not.toMatch(/\$/);
  expect(src).not.toMatch(/@/);                         // no @group/@binding/@compute…
  expect(src).not.toMatch(/\b(override|enable|requires|var<)/);
  expect(src).not.toMatch(/texture/i);
  expect(src).not.toMatch(/%/);
  expect(src).not.toMatch(/\b(i32|u32|f16|f64)\b/);
  const decls = [...src.matchAll(/\b(?:fn|struct|let|var|const|alias)\s+([A-Za-z_][A-Za-z0-9_]*)/g)].map(m => m[1]);
  expect(decls.length).toBeGreaterThan(0);
  for (const d of decls) expect(d).toMatch(/^(b5_|B5)/);
  // function parameters
  for (const m of src.matchAll(/\bfn\s+\w+\(([^)]*)\)/g)) {
    for (const p of m[1].matchAll(/(\w+)\s*:/g)) expect(p[1]).toMatch(/^b5_/);
  }
  // no recursion: a function never calls itself
  for (const m of src.matchAll(/\bfn\s+(\w+)\([^)]*\)[^{]*\{([\s\S]*?)\n\}/g)) {
    expect(m[2]).not.toMatch(new RegExp(`\\b${m[1]}\\(`));
  }
}

interface WgslReflectLib {
  WgslReflect: new (code: string) => { functions: { name: string }[]; structs: { name: string }[] };
  WgslParser: new () => { parse(code: string): unknown[] };
  WgslExec: new (ast: unknown[]) => {
    dispatchWorkgroups(fn: string, count: number, groups: Record<number, Record<number, Float32Array>>): void;
  };
}

/** wgsl_reflect is an optional devDependency: tests skip (with a message) when it is missing. */
async function loadReflect(): Promise<WgslReflectLib | null> {
  // 1.6.0: package "main" is a UMD file under "type": "module" (no named exports in Node),
  // so fall back to the ESM build by subpath.
  for (const id of ['wgsl_reflect', 'wgsl_reflect/wgsl_reflect.module.js']) {
    try {
      const mod = await import(/* @vite-ignore */ id);
      if (mod.WgslReflect && mod.WgslExec && mod.WgslParser) return mod as WgslReflectLib;
    } catch {
      /* try the next specifier */
    }
  }
  return null;
}

/** Test-only compute harness around `<kernel>_flat`: buf = [inputs | flat params | outputs]. */
function harness(rec: Recorded, flatN: number): { code: string; nIn: number; outs: { name: string; off: number; size: number }[]; size: number } {
  const sig = rec.signature;
  const sz = (t: string) => (t === 'f32' ? 1 : t === 'vec2' ? 2 : 3);
  let off = 0;
  const fields: string[] = [];
  for (const name of Object.keys(sig.inputs)) {
    const k = sz(sig.inputs[name]);
    const items = Array.from({ length: k }, (_, j) => `b5_buf[${off + j}]`);
    fields.push(k === 1 ? items[0] : `vec${k}<f32>(${items.join(', ')})`);
    off += k;
  }
  const nIn = off;
  const params = Array.from({ length: flatN }, (_, j) => `b5_buf[${nIn + j}]`);
  off = nIn + flatN;
  const outs: { name: string; off: number; size: number }[] = [];
  const writes: string[] = [];
  for (const name of Object.keys(sig.outputs)) {
    const k = sz(sig.outputs[name]);
    outs.push({ name, off, size: k });
    for (let j = 0; j < k; j++) writes.push(`  b5_buf[${off + j}] = b5_o.${name}${k === 1 ? '' : '.' + 'xyz'[j]};`);
    off += k;
  }
  const code = `
@group(0) @binding(0) var<storage, read_write> b5_buf: array<f32>;
@compute @workgroup_size(1) fn b5_main() {
  let b5_o = ${sig.name}_flat(${rec.typeName}In(${fields.join(', ')}), array<f32, ${flatN}>(${params.join(', ')}));
${writes.join('\n')}
}`;
  return { code, nIn, outs, size: off };
}

function execCompare(
  lib: WgslReflectLib, kernel: Kernel<never>, opts: unknown, arrays: 'f32' | 'vec4',
  gen: () => { i: CpuValues; u: CpuValues }, count: number, tol = 2e-4
): { worst: number; within: number } {
  const flatN = 32;
  const rec = recordKernel(kernel, opts as never);
  const h = harness(rec, flatN);
  const src = emitWgsl(kernel, opts as never, { flat: flatN, arrays }) + h.code;
  const exec = new lib.WgslExec(new lib.WgslParser().parse(src));
  const sig = rec.signature;
  let worst = 0, within = 0;
  for (let q = 0; q < count; q++) {
    const { i, u } = gen();
    const buf = new Float32Array(h.size);
    let off = 0;
    for (const name of Object.keys(sig.inputs)) {
      const v = i[name];
      for (const x of typeof v === 'number' ? [v] : v) buf[off++] = x;
    }
    buf.set(packFlatParams(sig, u as Record<string, number | number[]>, flatN), h.nIn);
    exec.dispatchWorkgroups('b5_main', 1, { 0: { 0: buf } });
    const ref = evaluateKernel(kernel, i, u, opts as never);
    let d = 0;
    for (const o of h.outs) {
      const rv = ref[o.name];
      const rs = typeof rv === 'number' ? [rv] : rv;
      for (let j = 0; j < o.size; j++) d = Math.max(d, Math.abs(buf[o.off + j] - rs[j]) / Math.max(1, Math.abs(rs[j])));
    }
    if (d < tol) within++;
    else worst = Math.max(worst, d);
  }
  return { worst, within };
}

describe('WGSL emission', () => {
  test('hull: structs, function, unrolled truss loops, b5_mod', () => {
    const src = emitWgsl(hullSurface, undefined, { flat: true });
    expect(src).toContain('struct B5HullIn {');
    expect(src).toContain('struct B5HullUniforms {');
    expect(src).toContain('struct B5HullOut {');
    expect(src).toContain('fn b5_hull_surface(b5_i: B5HullIn, b5_u: B5HullUniforms) -> B5HullOut {');
    expect(src).toContain('fn b5_hull_surface_flat(b5_i: B5HullIn, b5_p: array<f32, 32>) -> B5HullOut {');
    expect(src).toContain(`arms: array<f32, ${AX.sparArms}>,`);
    expect(src).toContain('fn b5_mod(');
    for (let j = 0; j < AX.spars.length; j++) expect(src).toContain(`b5_u.sparZ[${j}]`);
    for (let j = 0; j < AX.sparArms; j++) expect(src).toContain(`b5_u.arms[${j}]`);
    hygiene(src);
  });

  test('tracer variant has no truss shadow code', () => {
    const src = emitWgsl(hullSurface, { raster: false, nArm: 3, nSpar: 4 });
    expect(src).not.toContain('b5_u.sparZ[');
    expect(src).not.toContain('b5_mod');
    hygiene(src);
  });

  test('vec4 array layout for var<uniform>', () => {
    const src = emitWgsl(hullSurface, undefined, { arrays: 'vec4', flat: 24 });
    expect(src).toContain('arms: array<vec4<f32>, 1>,');
    expect(src).toContain('sparZ: array<vec4<f32>, 1>,');
    expect(src).toContain('b5_u.sparZ[0].w');
    hygiene(src);
    const lay = uniformLayout(hullSurface.signatureFor(hullSurface.defaults), 'vec4');
    const at = (k: string) => lay.fields.find(f => f.name === k);
    expect(at('waterTint')).toMatchObject({ offset: 16, size: 12 });
    expect(at('cityGlow')).toMatchObject({ offset: 28 });
    expect(lay.size % 16).toBe(0);
    for (const f of lay.fields) expect(f.offset % f.align).toBe(0);
  });

  test('flat params: layout and packing', () => {
    const sig = hullSurface.signatureFor(hullSurface.defaults);
    const lay = flatParamLayout(sig);
    const last = lay[lay.length - 1];
    expect(last.offset + last.length).toBeLessThanOrEqual(32);
    const packed = packFlatParams(sig, HULL_U as Record<string, number | number[]>);
    expect(packed.length).toBe(32);
    const wt = lay.find(f => f.name === 'waterTint');
    expect(wt).toBeDefined();
    expect(packed[(wt as { offset: number }).offset + 2]).toBeCloseTo(0.1170, 6);
  });

  test('library: every kernel once, helpers once, hygienic', () => {
    const lib = emitWgslLibrary(LIB_KERNELS, { flat: true });
    for (const f of ['b5_hull_surface', 'b5_hull_mirror', 'b5_wind_offset', 'b5_fog_fade', 'b5_foliage_dither']) {
      expect(lib.split(`fn ${f}(`).length).toBe(2);
      expect(lib).toContain(`fn ${f}_flat(`);
    }
    expect(lib).toContain('atan2(');
    hygiene(lib);
    expect(() => emitWgslLibrary([LIB_KERNELS[1], LIB_KERNELS[1]])).toThrow(/duplicate/);
  });

  test('float literals', () => {
    expect(wgslFloat(1)).toBe('1.0');
    expect(wgslFloat(-0.11)).toBe('(-0.11)');
    expect(wgslFloat(1e-6)).toBe('0.000001');
    expect(wgslFloat(1e-7)).toBe('1.0e-7');
    expect(() => wgslFloat(NaN)).toThrow();
  });

  test('emitted WGSL executes like the CPU evaluator (wgsl_reflect WgslExec, f32)', async () => {
    const lib = await loadReflect();
    if (!lib) {
      console.warn('[shading] wgsl_reflect is not installed — WGSL execution check SKIPPED');
      return;
    }
    // moderate times keep f32 argument rounding of sin/cos(t·ω) well below the tolerance
    const smallT = (g: () => { i: CpuValues; u: CpuValues }) => () => {
      const c = g();
      if (typeof c.u.time === 'number') c.u.time = r(0, 20);
      return c;
    };
    const full = { raster: true, nArm: AX.sparArms, nSpar: AX.spars.length };
    const cases: [string, Kernel<never>, unknown, 'f32' | 'vec4', () => { i: CpuValues; u: CpuValues }, number, number?][] = [
      ['hull raster f32', hullSurface as Kernel<never>, full, 'f32', smallT(randomHull), 60],
      ['hull raster vec4', hullSurface as Kernel<never>, full, 'vec4', smallT(randomHull), 60],
      ['hull tracer', hullSurface as Kernel<never>, { ...full, raster: false }, 'f32', smallT(randomHull), 40],
      ['mirror', hullMirror as Kernel<never>, undefined, 'f32', randomMirror, 60],
      ['wind', windOffset as Kernel<never>, undefined, 'f32',
        () => ({ i: { pGeom: r3(-1, 1), phase: r(0, 9) }, u: { time: r(0, 20), wind: r(0, 2) } }), 40],
      ['fog', fogFade as Kernel<never>, undefined, 'f32',
        () => ({ i: { viewDist: r(0, 300), opacity: r(0, 1) }, u: { fogDensity: r(0, 0.02) } }), 40],
      ['foliage', foliageDither as Kernel<never>, undefined, 'f32',
        // hash13 takes fract() of values ~1e4: f32 ulp ≈ 2e-3 in h → ≈ 6e-4 in k (invisible)
        () => ({ i: { pWorld: r3(-20, 20) }, u: { amount: 0.3, cell: 0.7 } }), 40, 2e-3],
    ];
    for (const [label, kernel, opts, arrays, gen, count, tol] of cases) {
      const { worst, within } = execCompare(lib, kernel, opts, arrays, gen, count, tol);
      // f32 vs f64: allow a rare threshold flip / fract wrap, nothing systematic
      expect(within, `${label}: worst outlier ${worst}`).toBeGreaterThanOrEqual(count - 1);
    }
  }, 60000);

  test('parses with wgsl_reflect', async () => {
    const lib = await loadReflect();
    if (!lib) {
      console.warn('[shading] wgsl_reflect is not installed — WGSL parse check SKIPPED');
      return;
    }
    const { WgslReflect } = lib;
    const variants = [
      emitWgslLibrary(LIB_KERNELS, { flat: true }),
      emitWgslLibrary(LIB_KERNELS, { flat: 24, arrays: 'vec4' }),
      emitWgsl(hullSurface, undefined, { flat: true }),
    ];
    for (const src of variants) {
      const refl = new WgslReflect(src);
      const fns = refl.functions.map(f => f.name);
      expect(fns).toContain('b5_hull_surface');
      expect(refl.structs.map(s => s.name)).toContain('B5HullUniforms');
    }
  });
});
