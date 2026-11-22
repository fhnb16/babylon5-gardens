/* ═══════════════════════════════════════════════════════════════════════════
   CPU reference path tracer for tiny ANALYTIC scenes — the oracle of the
   integrator (k_shade v0) in Node tests and for the GPU furnace check.

   Scene: a closed cylinder around the Z axis (radius R, z ∈ [−H/2, H/2],
   walls + end caps, seen from inside), Lambert albedo ρ and uniform emission
   Le on every wall, optionally the axis tube emitter (radius r, z ∈ [z0,
   z0 + length], radiance Lt, opaque, not reflective).

   Same estimator as k_shade.wgsl (Lambert lobe only): emission on hits (MIS
   power heuristic against tube NEE when the hit is on the tube, weight 1
   otherwise), NEE by uniform AREA sampling of the tube with one shadow test,
   cosine-weighted BSDF sampling, Russian roulette from rrDepth with
   q = min(max throughput, 0.95), maxDepth bounces (the vertex at depth
   maxDepth only collects emission). `nee: false` = pure BSDF sampling (tube
   hits weighted 1) — an independent estimator of the same integral.

   Furnace: closed walls, ρ, Le, no tube ⇒ L = Le / (1 − ρ) everywhere.
   ═══════════════════════════════════════════════════════════════════════════ */

import { mulberry32, type Rng } from '../core/rng.ts';
import { tubePdfW, tubeSample } from './lights/tube.ts';

export interface RefTube {
  radius: number;
  length: number;
  z0: number;
  /** radiance (grey) */
  Le: number;
}

export interface RefScene {
  R: number;
  H: number;
  albedo: number;
  /** wall emission (grey) */
  Le: number;
  tube?: RefTube | null;
}

export interface RefOptions {
  maxDepth: number;
  rrDepth: number;
  /** tube next-event estimation + MIS (default true) */
  nee?: boolean;
  /** relative ray origin offset */
  eps?: number;
  /** tube NEE strategy: 'uniform' area (M1) or 'equiangular' (lights/tube.ts, the GPU default) */
  tubeSampler?: 'uniform' | 'equiangular';
}

type V = [number, number, number];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V): V => { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; };

export interface RefHit {
  t: number;
  /** 0 wall, 1 cap, 2 tube */
  what: 0 | 1 | 2;
  /** outward normal of the hit primitive (unnormalised direction not guaranteed) */
  n: V;
}

/** smallest root > tmin of a·t² + 2b·t + c = 0 for x²+y² = r² */
function cylT(o: V, d: V, r: number, tmin: number): number[] {
  const a = d[0] * d[0] + d[1] * d[1];
  if (a < 1e-18) return [];
  const b = o[0] * d[0] + o[1] * d[1];
  const c = o[0] * o[0] + o[1] * o[1] - r * r;
  const disc = b * b - a * c;
  if (disc < 0) return [];
  const s = Math.sqrt(disc);
  return [(-b - s) / a, (-b + s) / a].filter((t) => t > tmin);
}

/** closest hit of a ray inside the cylinder (o strictly inside). */
export function refIntersect(sc: RefScene, o: V, d: V, tmin = 0): RefHit | null {
  let best: RefHit | null = null;
  const take = (t: number, what: 0 | 1 | 2, n: V) => { if (!best || t < best.t) best = { t, what, n }; };
  for (const t of cylT(o, d, sc.R, tmin)) {
    const z = o[2] + d[2] * t;
    if (Math.abs(z) <= sc.H / 2) { take(t, 0, [o[0] + d[0] * t, o[1] + d[1] * t, 0]); break; }
  }
  if (Math.abs(d[2]) > 1e-12) {
    for (const zc of [-sc.H / 2, sc.H / 2]) {
      const t = (zc - o[2]) / d[2];
      if (t > tmin) {
        const x = o[0] + d[0] * t, y = o[1] + d[1] * t;
        if (x * x + y * y <= sc.R * sc.R) take(t, 1, [0, 0, Math.sign(zc)]);
      }
    }
  }
  const tb = sc.tube;
  if (tb) {
    for (const t of cylT(o, d, tb.radius, tmin)) {
      const z = o[2] + d[2] * t;
      if (z >= tb.z0 && z <= tb.z0 + tb.length) { take(t, 2, [o[0] + d[0] * t, o[1] + d[1] * t, 0]); break; }
    }
  }
  return best;
}

function onb(n: V): [V, V, V] {
  const s = n[2] >= 0 ? 1 : -1;
  const a = -1 / (s + n[2]);
  const b = n[0] * n[1] * a;
  return [[1 + s * n[0] * n[0] * a, s * b, -s * n[0]], [b, s + n[1] * n[1] * a, -n[1]], n];
}

const power = (a: number, b: number) => (a * a + b * b > 0 ? (a * a) / (a * a + b * b) : 0);

/** One path sample from o along unit d. */
export function refRadiance(sc: RefScene, o0: V, d0: V, rnd: Rng, opt: RefOptions): number {
  const nee = opt.nee ?? true;
  const eps = opt.eps ?? 1e-6;
  const tb = sc.tube ?? null;
  const area = tb ? 2 * Math.PI * tb.radius * tb.length : 0;
  const eq = opt.tubeSampler === 'equiangular';
  let o = o0, d = d0, thr = 1, L = 0, pdfPrev = 0;
  let pPrev: V = o0;
  for (let depth = 0; ; depth++) {
    const h = refIntersect(sc, o, d);
    if (!h) return L;
    const p: V = [o[0] + d[0] * h.t, o[1] + d[1] * h.t, o[2] + d[2] * h.t];
    if (h.what === 2) {
      // tube: emissive only
      let w = 1;
      if (depth > 0 && nee) {
        // outer side only (what NEE samples)
        const nl = norm([p[0], p[1], 0]);
        const cosL = -dot(nl, d);
        if (eq) w = power(pdfPrev, tubePdfW(pPrev, p, tb!));
        else if (cosL > 0) w = power(pdfPrev, (h.t * h.t) / (cosL * area));
      }
      return L + thr * tb!.Le * w;
    }
    L += thr * sc.Le;
    if (depth >= opt.maxDepth) return L;
    // inward normal (facing the ray: walls/caps are seen from inside)
    let n = norm(h.n);
    if (dot(n, d) > 0) n = [-n[0], -n[1], -n[2]];
    const s = 1 + Math.max(Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]));
    const po: V = [p[0] + n[0] * eps * s, p[1] + n[1] * eps * s, p[2] + n[2] * eps * s];
    const f = sc.albedo / Math.PI;
    // NEE (consumes 2 dims like the GPU, even without a tube)
    const u1 = rnd(), u2 = rnd();
    if (tb && nee && eq) {
      const ts = tubeSample(p, tb, u1, u2);
      if (ts && ts.pdfW > 0) {
        const cosS = dot(n, ts.wi);
        if (cosS > 0) {
          const dl: V = [ts.x[0] - po[0], ts.x[1] - po[1], ts.x[2] - po[2]];
          const dist = Math.hypot(dl[0], dl[1], dl[2]);
          const sh = refIntersect(sc, po, norm(dl));
          if (!sh || sh.t >= dist * (1 - 1e-3)) L += thr * f * cosS * tb.Le * power(ts.pdfW, cosS / Math.PI) / ts.pdfW;
        }
      }
    } else if (tb && nee) {
      const phi = 2 * Math.PI * u1;
      const nl: V = [Math.sin(phi), Math.cos(phi), 0];
      const pl: V = [nl[0] * tb.radius, nl[1] * tb.radius, tb.z0 + tb.length * u2];
      let wi: V = [pl[0] - p[0], pl[1] - p[1], pl[2] - p[2]];
      const d2 = dot(wi, wi);
      wi = norm(wi);
      const cosL = -dot(nl, wi), cosS = dot(n, wi);
      if (cosL > 0 && cosS > 0) {
        const dl: V = [pl[0] - po[0], pl[1] - po[1], pl[2] - po[2]];
        const dist = Math.hypot(dl[0], dl[1], dl[2]);
        const sh = refIntersect(sc, po, norm(dl));
        if (!sh || sh.t >= dist * (1 - 1e-3)) {
          const pdfL = d2 / (cosL * area);
          const pdfB = cosS / Math.PI;
          L += thr * f * cosS * tb.Le * power(pdfL, pdfB) / pdfL;
        }
      }
    }
    // BSDF: cosine sampling (the lobe-select dimension is consumed too)
    rnd();
    const r1 = rnd(), r2 = rnd();
    const r = Math.sqrt(r1), ph = 2 * Math.PI * r2;
    const lx = r * Math.cos(ph), ly = r * Math.sin(ph), lz = Math.sqrt(Math.max(0, 1 - r1));
    const [T, Bv, N] = onb(n);
    const wi: V = norm([T[0] * lx + Bv[0] * ly + N[0] * lz, T[1] * lx + Bv[1] * ly + N[1] * lz, T[2] * lx + Bv[2] * ly + N[2] * lz]);
    const cosI = dot(n, wi);
    if (cosI <= 0) return L;
    const pdf = cosI / Math.PI;
    thr *= f * cosI / pdf; // = albedo
    if (depth + 1 >= opt.rrDepth) {
      const q = Math.min(thr, 0.95);
      if (rnd() >= q) return L;
      thr /= q;
    }
    pdfPrev = pdf;
    pPrev = p;
    o = po;
    d = wi;
  }
}

export interface RefEstimate {
  mean: number;
  /** standard error of the mean */
  stderr: number;
  n: number;
}

/** Mean radiance over n samples of rays from `o` in uniformly random directions. */
export function refEstimate(sc: RefScene, o: V, n: number, seed: number, opt: RefOptions): RefEstimate {
  const rnd = mulberry32(seed);
  let s = 0, s2 = 0;
  for (let i = 0; i < n; i++) {
    const z = rnd() * 2 - 1, ph = rnd() * 2 * Math.PI, r = Math.sqrt(1 - z * z);
    const v = refRadiance(sc, o, [r * Math.cos(ph), r * Math.sin(ph), z], rnd, opt);
    s += v; s2 += v * v;
  }
  const mean = s / n;
  return { mean, stderr: Math.sqrt(Math.max(0, s2 / n - mean * mean) / n), n };
}

/** Analytic furnace radiance Le / (1 − ρ). */
export const furnaceRadiance = (Le: number, albedo: number): number => Le / (1 - albedo);
