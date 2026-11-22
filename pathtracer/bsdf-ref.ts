/* ═══════════════════════════════════════════════════════════════════════════
   CPU mirror of the WGSL BSDFs (bsdf_std / bsdf_glass / bsdf_water /
   bsdf.wgsl + the GGX helpers of sampling.wgsl). Same formulas, same order
   of random dimensions (u.x lobe, u.yz direction), so a GPU probe fed the
   same numbers must agree to f32 precision (tests/browser/pt-unit.spec.ts).
   Shading frame: vectors in WORLD space around b.n (Duff et al. ONB).
   ═══════════════════════════════════════════════════════════════════════════ */

import { WATER_PT } from './config.ts';

export type V3 = [number, number, number];

export const LOBE = { std: 0, glass: 1, water: 2 } as const;
const F0_DIELECTRIC = 0.04;
const SPEC_PROB_MIN = 0.1, SPEC_PROB_MAX = 0.9;
const GLASS_MIN_COS = 1e-3;

export interface Bsdf {
  n: V3;
  lobe: number;
  cd: V3;
  a: number;
  f0: V3;
  pSpec: number;
  tint: V3;
  eta: number;
  depth: number;
  fBoost: number;
}

export interface BsdfSample {
  wi: V3;
  pdf: number;
  w: V3;
  delta: boolean;
  through: boolean;
  ok: boolean;
}

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const lum = (c: ArrayLike<number>) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export function schlick(f0: ArrayLike<number>, c: number): V3 {
  const m = clamp(1 - c, 0, 1), m5 = m * m * m * m * m;
  return [f0[0] + (1 - f0[0]) * m5, f0[1] + (1 - f0[1]) * m5, f0[2] + (1 - f0[2]) * m5];
}

export function ggxD(nh: number, a: number): number {
  const a2 = a * a, k = nh * nh * (a2 - 1) + 1;
  return a2 / (Math.PI * k * k);
}
export function ggxLambda(c: number, a: number): number {
  const c2 = Math.max(c * c, 1e-12);
  return 0.5 * (-1 + Math.sqrt(1 + (a * a * (1 - c2)) / c2));
}
export const ggxG2 = (nv: number, nl: number, a: number) => 1 / (1 + ggxLambda(nv, a) + ggxLambda(nl, a));
export const ggxG1 = (nv: number, a: number) => 1 / (1 + ggxLambda(nv, a));

export function fresnelDielectric(cosI: number, eta: number): number {
  const c = clamp(cosI, 0, 1), s2 = 1 - c * c, t2 = 1 - s2 / (eta * eta);
  if (t2 <= 0) return 1;
  const ct = Math.sqrt(t2);
  const rs = (c - eta * ct) / (c + eta * ct), rp = (eta * c - ct) / (eta * c + ct);
  return 0.5 * (rs * rs + rp * rp);
}

/** Duff et al. 2017 ONB, columns t, b, n (sampling.wgsl b5_onb) */
export function onb(n: V3): [V3, V3, V3] {
  const s = n[2] >= 0 ? 1 : -1, a = -1 / (s + n[2]), b = n[0] * n[1] * a;
  return [[1 + s * n[0] * n[0] * a, s * b, -s * n[0]], [b, s + n[1] * n[1] * a, -n[1]], n];
}
const toWorld = (B: [V3, V3, V3], v: V3): V3 => [
  B[0][0] * v[0] + B[1][0] * v[1] + B[2][0] * v[2],
  B[0][1] * v[0] + B[1][1] * v[1] + B[2][1] * v[2],
  B[0][2] * v[0] + B[1][2] * v[1] + B[2][2] * v[2]
];
const toLocal = (B: [V3, V3, V3], v: V3): V3 => [dot(B[0], v), dot(B[1], v), dot(B[2], v)];

export function cosineLocal(u1: number, u2: number): V3 {
  const r = Math.sqrt(u1), phi = 2 * Math.PI * u2;
  return [r * Math.cos(phi), r * Math.sin(phi), Math.sqrt(Math.max(0, 1 - u1))];
}

export function vndfLocal(v: V3, a: number, u1: number, u2: number): V3 {
  const vh = norm([a * v[0], a * v[1], v[2]]);
  const lensq = vh[0] * vh[0] + vh[1] * vh[1];
  const t1: V3 = lensq > 0 ? [-vh[1] / Math.sqrt(lensq), vh[0] / Math.sqrt(lensq), 0] : [1, 0, 0];
  const t2: V3 = [vh[1] * t1[2] - vh[2] * t1[1], vh[2] * t1[0] - vh[0] * t1[2], vh[0] * t1[1] - vh[1] * t1[0]];
  const r = Math.sqrt(u1), phi = 2 * Math.PI * u2;
  const p1 = r * Math.cos(phi), s = 0.5 * (1 + vh[2]);
  const p2 = (1 - s) * Math.sqrt(Math.max(0, 1 - p1 * p1)) + s * r * Math.sin(phi);
  const p3 = Math.sqrt(Math.max(0, 1 - p1 * p1 - p2 * p2));
  const nh: V3 = [p1 * t1[0] + p2 * t2[0] + p3 * vh[0], p1 * t1[1] + p2 * t2[1] + p3 * vh[1], p1 * t1[2] + p2 * t2[2] + p3 * vh[2]];
  return norm([a * nh[0], a * nh[1], Math.max(1e-6, nh[2])]);
}

const reflect = (i: V3, n: V3): V3 => { const k = 2 * dot(n, i); return [i[0] - k * n[0], i[1] - k * n[1], i[2] - k * n[2]]; };

/* ─── constructors ─── */

export function stdMake(n: V3, albedo: V3, metal: number, rough: number, minAlpha: number, nv: number): Bsdf {
  const cd: V3 = [albedo[0] * (1 - metal), albedo[1] * (1 - metal), albedo[2] * (1 - metal)];
  const f0: V3 = [0, 1, 2].map((k) => F0_DIELECTRIC + (albedo[k] - F0_DIELECTRIC) * metal) as V3;
  const Fv = schlick(f0, nv);
  const ws = lum(Fv), wd = lum([cd[0] * (1 - Fv[0]), cd[1] * (1 - Fv[1]), cd[2] * (1 - Fv[2])]);
  return {
    n, lobe: LOBE.std, cd, a: Math.max(rough * rough, minAlpha), f0,
    pSpec: wd > 0 ? clamp(ws / (ws + wd), SPEC_PROB_MIN, SPEC_PROB_MAX) : 1,
    tint: [1, 1, 1], eta: 1.5, depth: 0, fBoost: 1
  };
}

export function glassMake(n: V3, tint: V3, ior: number): Bsdf {
  return { n, lobe: LOBE.glass, cd: [0, 0, 0], a: 0, f0: [0, 0, 0], pSpec: 0, tint, eta: ior, depth: 0, fBoost: 1 };
}

const waterF = (c: number, eta: number, boost: number) => Math.min(1, fresnelDielectric(c, eta) * boost);
const waterCosT = (c: number, eta: number) => Math.sqrt(Math.max(1e-6, 1 - (1 - c * c) / (eta * eta)));
function waterRho(b: Bsdf, nv: number, nl: number): V3 {
  const tr = Math.exp(-b.depth * 0.5 * (1 / waterCosT(nv, b.eta) + 1 / waterCosT(nl, b.eta)));
  return [b.cd[0] * tr + b.tint[0] * (1 - tr), b.cd[1] * tr + b.tint[1] * (1 - tr), b.cd[2] * tr + b.tint[2] * (1 - tr)];
}

export function waterMake(n: V3, bed: V3, waterTint: V3, rough: number, depth: number, minAlpha: number, nv: number): Bsdf {
  const b: Bsdf = {
    n, lobe: LOBE.water, cd: bed, a: Math.max(rough * rough, minAlpha), f0: [0, 0, 0], pSpec: 0,
    tint: waterTint, eta: WATER_PT.ior, depth, fBoost: WATER_PT.f0Boost
  };
  const fo = waterF(nv, b.eta, b.fBoost);
  const wd = (1 - fo) * lum(waterRho(b, nv, nv));
  b.pSpec = wd > 0 ? clamp(fo / (fo + wd), SPEC_PROB_MIN, SPEC_PROB_MAX) : 1;
  return b;
}

/* ─── eval / sample ─── */

function ggxTerms(n: V3, wo: V3, wi: V3, a: number): [number, number, number] {
  const nl = dot(n, wi), nv = dot(n, wo);
  const h = norm([wo[0] + wi[0], wo[1] + wi[1], wo[2] + wi[2]]);
  const nh = Math.max(dot(n, h), 0);
  const D = ggxD(nh, a);
  return [(D * ggxG2(nv, nl, a)) / (4 * nl * nv), (ggxG1(nv, a) * D) / (4 * nv), Math.max(dot(wo, h), 0)];
}

/** f (rgb) and the mixture pdf; zero for delta lobes. */
export function bsdfEval(b: Bsdf, wo: V3, wi: V3): { f: V3; pdf: number } {
  const nl = dot(b.n, wi), nv = dot(b.n, wo);
  if (b.lobe === LOBE.glass || nl <= 0 || nv <= 0) return { f: [0, 0, 0], pdf: 0 };
  let f: V3, pdf = ((1 - b.pSpec) * nl) / Math.PI;
  if (b.lobe === LOBE.water) {
    const fo = waterF(nv, b.eta, b.fBoost), fi = waterF(nl, b.eta, b.fBoost), rho = waterRho(b, nv, nl);
    const k = ((1 - fo) * (1 - fi)) / Math.PI;
    f = [rho[0] * k, rho[1] * k, rho[2] * k];
    if (b.pSpec > 0) {
      const t = ggxTerms(b.n, wo, wi, b.a), F = waterF(t[2], b.eta, b.fBoost) * t[0];
      f = [f[0] + F, f[1] + F, f[2] + F];
      pdf += b.pSpec * t[1];
    }
  } else {
    const Fv = schlick(b.f0, nv);
    const kd: V3 = b.pSpec > 0 ? [1 - Fv[0], 1 - Fv[1], 1 - Fv[2]] : [1, 1, 1]; // pSpec 0: pure Lambert
    f = [b.cd[0] * kd[0] / Math.PI, b.cd[1] * kd[1] / Math.PI, b.cd[2] * kd[2] / Math.PI];
    if (b.pSpec > 0) {
      const t = ggxTerms(b.n, wo, wi, b.a), F = schlick(b.f0, t[2]);
      f = [f[0] + F[0] * t[0], f[1] + F[1] * t[0], f[2] + F[2] * t[0]];
      pdf += b.pSpec * t[1];
    }
  }
  return { f, pdf };
}

export function glassReflectance(cosI: number, ior: number): number {
  const r = fresnelDielectric(Math.max(Math.abs(cosI), GLASS_MIN_COS), ior);
  return (2 * r) / (1 + r);
}

export function bsdfSample(b: Bsdf, wo: V3, u: [number, number, number]): BsdfSample {
  if (b.lobe === LOBE.glass) {
    const rp = glassReflectance(dot(b.n, wo), b.eta);
    if (u[0] < rp) return { wi: reflect([-wo[0], -wo[1], -wo[2]], b.n), pdf: 0, w: [1, 1, 1], delta: true, through: false, ok: true };
    return { wi: [-wo[0], -wo[1], -wo[2]], pdf: 0, w: [...b.tint], delta: true, through: true, ok: true };
  }
  const B = onb(b.n);
  let wi: V3;
  if (u[0] < b.pSpec) {
    const woL = toLocal(B, wo);
    const hL = vndfLocal(woL, b.a, u[1], u[2]);
    wi = toWorld(B, reflect([-woL[0], -woL[1], -woL[2]], hL));
  } else {
    wi = toWorld(B, cosineLocal(u[1], u[2]));
  }
  const e = bsdfEval(b, wo, wi), c = dot(b.n, wi);
  if (e.pdf > 0 && c > 0) return { wi, pdf: e.pdf, w: [e.f[0] * c / e.pdf, e.f[1] * c / e.pdf, e.f[2] * c / e.pdf], delta: false, through: false, ok: true };
  return { wi, pdf: e.pdf, w: [0, 0, 0], delta: false, through: false, ok: false };
}

/** Directional albedo ∫ f cos dωi by importance sampling (white-furnace check). */
export function directionalAlbedo(b: Bsdf, wo: V3, n: number, rnd: () => number): { mean: V3; stderr: number } {
  const s: V3 = [0, 0, 0];
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const r = bsdfSample(b, wo, [rnd(), rnd(), rnd()]);
    if (!r.ok) continue;
    s[0] += r.w[0]; s[1] += r.w[1]; s[2] += r.w[2];
    s2 += lum(r.w) * lum(r.w);
  }
  const m: V3 = [s[0] / n, s[1] / n, s[2] / n];
  return { mean: m, stderr: Math.sqrt(Math.max(0, s2 / n - lum(m) ** 2) / n) };
}
