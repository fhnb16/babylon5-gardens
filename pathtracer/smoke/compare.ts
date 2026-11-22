/* ═══════════════════════════════════════════════════════════════════════════
   GPU kernel output vs CPU reference (traverse-ref.ts, f32 mode). Pure.

   Verdicts per ray:
     exact    — same instance + triangle, t/u/v bit-identical, same facing
                (both miss also counts as exact);
     close    — same instance + triangle, |Δt| ≤ tol·max(|t|, 1e-6);
     tie      — different triangle, |Δt| ≤ tol·max(|t|, 1e-6) (shared edge /
                coplanar overlap: any of them is a correct closest hit);
     mismatch — everything else.
   Any-hit: equal flags → exact; otherwise a tie when the reference's closest
   occluder sits within tol of the ray's tmax (boundary case), else mismatch.
   The only legitimate differences are last-bit ones (FMA contraction,
   2.5-ulp WGSL division), so tol = 1e-4 relative is generous.
   ═══════════════════════════════════════════════════════════════════════════ */

import { HIT_FRONT, HIT_W, HIT_WORDS, NO_INDEX, RAY_W, RAY_WORDS } from '../rays.ts';
import type { Hit, Ray, Traverser } from '../bvh/traverse-ref.ts';

export type Verdict = 'exact' | 'close' | 'tie' | 'mismatch';

export interface Tally {
  rays: number;
  exact: number;
  close: number;
  tie: number;
  mismatch: number;
  /** rays that hit (reference) / occluded (reference, any-hit) */
  hits: number;
  /** largest |Δt| / t over close + tie rays */
  maxRelDt: number;
}

export const newTally = (): Tally => ({ rays: 0, exact: 0, close: 0, tie: 0, mismatch: 0, hits: 0, maxRelDt: 0 });

export function addTally(a: Tally, b: Tally): Tally {
  return {
    rays: a.rays + b.rays, exact: a.exact + b.exact, close: a.close + b.close,
    tie: a.tie + b.tie, mismatch: a.mismatch + b.mismatch, hits: a.hits + b.hits,
    maxRelDt: Math.max(a.maxRelDt, b.maxRelDt)
  };
}

export const agreement = (t: Tally): number => (t.rays ? (t.rays - t.mismatch) / t.rays : 1);

export interface GpuHit {
  t: number;
  u: number;
  v: number;
  inst: number;
  tri: number;
  front: boolean;
}

export function readGpuHit(F: Float32Array, U: Uint32Array, i: number): GpuHit {
  const w = i * HIT_WORDS;
  return {
    t: F[w + HIT_W.t], u: F[w + HIT_W.u], v: F[w + HIT_W.v],
    inst: U[w + HIT_W.inst], tri: U[w + HIT_W.tri], front: (U[w + HIT_W.flags] & HIT_FRONT) !== 0
  };
}

export function readRay(F: Float32Array, i: number): Ray {
  const w = i * RAY_WORDS;
  return {
    ox: F[w + RAY_W.o], oy: F[w + RAY_W.o + 1], oz: F[w + RAY_W.o + 2],
    dx: F[w + RAY_W.d], dy: F[w + RAY_W.d + 1], dz: F[w + RAY_W.d + 2],
    tmin: F[w + RAY_W.tmin], tmax: F[w + RAY_W.tmax]
  };
}

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol * Math.max(Math.abs(a), Math.abs(b), 1e-6);

export function compareHit(g: GpuHit, r: Hit | null, tol = 1e-4, twoLevel = true): Verdict {
  const gMiss = g.tri === NO_INDEX;
  if (gMiss || !r) return gMiss && !r ? 'exact' : 'mismatch';
  const rInst = twoLevel ? r.instance : NO_INDEX;
  if (g.tri === r.tri && g.inst === rInst) {
    if (g.t === r.t && g.u === r.u && g.v === r.v && g.front === !!r.frontFace) return 'exact';
    return near(g.t, r.t, tol) ? 'close' : 'mismatch';
  }
  return near(g.t, r.t, tol) ? 'tie' : 'mismatch';
}

export interface Mismatch {
  set: string;
  ray: number;
  detail: string;
}

const fmt = (x: number) => (Number.isFinite(x) ? x.toPrecision(9) : String(x));
const fmtRay = (r: Ray) => `o=(${fmt(r.ox)}, ${fmt(r.oy)}, ${fmt(r.oz)}) d=(${fmt(r.dx)}, ${fmt(r.dy)}, ${fmt(r.dz)}) tmax=${fmt(r.tmax)}`;
const fmtG = (g: GpuHit) => (g.tri === NO_INDEX ? 'miss' : `inst ${g.inst} tri ${g.tri} t=${fmt(g.t)} u=${fmt(g.u)} v=${fmt(g.v)} front=${g.front}`);
const fmtR = (h: Hit | null) => (!h ? 'miss' : `inst ${h.instance} tri ${h.tri} t=${fmt(h.t)} u=${fmt(h.u)} v=${fmt(h.v)} front=${h.frontFace}`);

/** Closest hit: compare `count` GPU hit records with the reference. */
export function compareClosest(
  set: string, rays: Float32Array, hits: ArrayBuffer, count: number,
  ref: Traverser, mask: number, out: Mismatch[], tol = 1e-4, maxReport = 50
): Tally {
  const F = new Float32Array(hits), U = new Uint32Array(hits);
  const t = newTally();
  for (let i = 0; i < count; i++) {
    const ray = readRay(rays, i);
    const r = ref.closestHit(ray, mask);
    const g = readGpuHit(F, U, i);
    const v = compareHit(g, r, tol);
    t.rays++; t[v]++;
    if (r) t.hits++;
    if ((v === 'close' || v === 'tie') && r) t.maxRelDt = Math.max(t.maxRelDt, Math.abs(g.t - r.t) / Math.max(Math.abs(r.t), 1e-6));
    if (v === 'mismatch' && out.length < maxReport) {
      const edge = r ? Math.min(r.u, r.v, 1 - r.u - r.v) : NaN;
      out.push({ set, ray: i, detail: `${fmtRay(ray)}\n      gpu ${fmtG(g)}\n      ref ${fmtR(r)} (min barycentric ${fmt(edge)})` });
    }
  }
  return t;
}

/** Any hit: compare occlusion flags (u32 per ray). */
export function compareAny(
  set: string, rays: Float32Array, occl: ArrayBuffer, count: number,
  ref: Traverser, mask: number, out: Mismatch[], tol = 1e-4, maxReport = 50
): Tally {
  const O = new Uint32Array(occl);
  const t = newTally();
  for (let i = 0; i < count; i++) {
    const ray = readRay(rays, i);
    const r = ref.anyHit(ray, mask);
    const g = O[i] !== 0;
    t.rays++;
    if (r) t.hits++;
    if (r === g) { t.exact++; continue; }
    const c = ref.closestHit({ ...ray, tmax: 1e30 }, mask);
    if (c && near(c.t, ray.tmax, tol)) { t.tie++; continue; }
    t.mismatch++;
    if (out.length < maxReport) out.push({ set, ray: i, detail: `${fmtRay(ray)}\n      gpu occluded=${g} ref occluded=${r}; ref closest ${fmtR(c)}` });
  }
  return t;
}
