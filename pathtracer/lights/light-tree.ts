/* ═══════════════════════════════════════════════════════════════════════════
   Light BVH with orientation cones — the L2 light selector for emissive
   triangles (Conty Estevez & Kulla 2018, "Importance Sampling of Many Lights
   with Adaptive Tree Splitting"; the bounds/importance/cost follow pbrt-v4
   BVHLightSampler / LightBounds / DirectionCone).

   Leaves hold ONE light. Stochastic traversal: at an inner node both children
   get an importance I(p, n) (power × cos bound of the emitter cone ×
   receiver cos bound / distance²), the walk goes left with I0 / (I0 + I1);
   the product of the choices is the pmf. pmf(p, n, light) walks UP from the
   light's leaf through parent links with the same importances (MIS of
   BSDF-sampled hits). Mirror of light_tree.wgsl — keep both in step.
   ═══════════════════════════════════════════════════════════════════════════ */

import { LIGHTS_PT } from '../config.ts';

type V3 = [number, number, number];

export interface LightBounds {
  bmin: V3;
  bmax: V3;
  /** emitted "energy" (luminance × area; position-independent weight) */
  phi: number;
  /** cone axis (unit) */
  w: V3;
  /** cos of the cone half-angle of the normals */
  cosO: number;
  /** cos of the emission spread beyond the normal cone (π/2 → 0) */
  cosE: number;
  twoSided: boolean;
}

export const NO_NODE = 0xffffffff;
/** node flags (bits of the 4th word of the 4th row) */
export const LNODE_TWO_SIDED = 1;
export const LNODE_LEAF = 2;

export interface LightTreeNode extends LightBounds {
  /** inner: child node indices; leaf: child0 = light index, child1 = NO_NODE */
  child0: number;
  child1: number;
  parent: number;
  leaf: boolean;
}

export interface LightTree {
  nodes: LightTreeNode[];
  /** leaf node of each light (NO_NODE for lights with zero power) */
  leafOf: Uint32Array;
}

/* ─── small vector helpers ─── */
const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: ArrayLike<number>) => Math.sqrt(dot(a, a));
const norm = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const clamp1 = (x: number) => Math.max(-1, Math.min(1, x));
const safeAcos = (x: number) => Math.acos(clamp1(x));
const safeSqrt = (x: number) => Math.sqrt(Math.max(0, x));

/* ─── direction cones (pbrt-v4 DirectionCone::Union) ─── */
export function coneUnion(wa: V3, cosA: number, wb: V3, cosB: number): { w: V3; cos: number } {
  const ta = safeAcos(cosA), tb = safeAcos(cosB);
  const td = safeAcos(dot(wa, wb));
  if (Math.min(td + tb, Math.PI) <= ta) return { w: wa, cos: cosA };
  if (Math.min(td + ta, Math.PI) <= tb) return { w: wb, cos: cosB };
  const to = (ta + td + tb) / 2;
  if (to >= Math.PI) return { w: wa, cos: -1 };
  const tr = to - ta;
  const ax = cross(wa, wb);
  if (dot(ax, ax) < 1e-24) return { w: wa, cos: -1 };
  // Rodrigues rotation of wa about ax by tr
  const k = norm(ax), c = Math.cos(tr), s = Math.sin(tr);
  const kxv = cross(k, wa), kdv = dot(k, wa);
  const w: V3 = norm([
    wa[0] * c + kxv[0] * s + k[0] * kdv * (1 - c),
    wa[1] * c + kxv[1] * s + k[1] * kdv * (1 - c),
    wa[2] * c + kxv[2] * s + k[2] * kdv * (1 - c)
  ]);
  return { w, cos: Math.cos(to) };
}

export function boundsUnion(a: LightBounds, b: LightBounds): LightBounds {
  if (!(a.phi > 0)) return b;
  if (!(b.phi > 0)) return a;
  const cone = coneUnion(a.w, a.cosO, b.w, b.cosO);
  return {
    bmin: [Math.min(a.bmin[0], b.bmin[0]), Math.min(a.bmin[1], b.bmin[1]), Math.min(a.bmin[2], b.bmin[2])],
    bmax: [Math.max(a.bmax[0], b.bmax[0]), Math.max(a.bmax[1], b.bmax[1]), Math.max(a.bmax[2], b.bmax[2])],
    phi: a.phi + b.phi,
    w: cone.w, cosO: cone.cos,
    cosE: Math.min(a.cosE, b.cosE),
    twoSided: a.twoSided || b.twoSided
  };
}

/** Bounds of a (two-sided, Lambertian) emissive triangle. */
export function triangleBounds(v0: ArrayLike<number>, v1: ArrayLike<number>, v2: ArrayLike<number>, phi: number): LightBounds {
  const e1: V3 = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
  const e2: V3 = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]];
  const n = cross(e1, e2);
  const w: V3 = len(n) > 0 ? norm(n) : [0, 0, 1];
  return {
    bmin: [Math.min(v0[0], v1[0], v2[0]), Math.min(v0[1], v1[1], v2[1]), Math.min(v0[2], v1[2], v2[2])],
    bmax: [Math.max(v0[0], v1[0], v2[0]), Math.max(v0[1], v1[1], v2[1]), Math.max(v0[2], v1[2], v2[2])],
    phi, w, cosO: 1, cosE: 0, twoSided: true
  };
}

/* ─── importance (pbrt-v4 LightBounds::Importance) ─── */

const cosSub = (sA: number, cA: number, sB: number, cB: number) => (cA > cB ? 1 : cA * cB + sA * sB);
const sinSub = (sA: number, cA: number, sB: number, cB: number) => (cA > cB ? 0 : sA * cB - cA * sB);

/**
 * Importance of bounds b for a receiver at p with normal n (n = [0,0,0]: no
 * receiver term). Same operation order as b5_lt_importance (WGSL, f32).
 */
export function importance(b: LightBounds, p: ArrayLike<number>, n: ArrayLike<number>): number {
  if (!(b.phi > 0)) return 0;
  const cx = (b.bmin[0] + b.bmax[0]) * 0.5, cy = (b.bmin[1] + b.bmax[1]) * 0.5, cz = (b.bmin[2] + b.bmax[2]) * 0.5;
  const dx = p[0] - cx, dy = p[1] - cy, dz = p[2] - cz;
  let d2 = dx * dx + dy * dy + dz * dz;
  const ex = b.bmax[0] - b.bmin[0], ey = b.bmax[1] - b.bmin[1], ez = b.bmax[2] - b.bmin[2];
  const halfDiag = 0.5 * Math.sqrt(ex * ex + ey * ey + ez * ez);
  d2 = Math.max(d2, halfDiag);
  const dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const wi: V3 = dl > 0 ? [dx / dl, dy / dl, dz / dl] : [0, 0, 1];
  let cosW = dot(b.w, wi);
  if (b.twoSided) cosW = Math.abs(cosW);
  const sinW = safeSqrt(1 - cosW * cosW);
  // bounding sphere of the box: subtended cone from p
  const r2 = halfDiag * halfDiag;
  let cosB = -1;
  if (dl * dl >= r2) cosB = safeSqrt(1 - r2 / (dl * dl));
  const sinB = safeSqrt(1 - cosB * cosB);
  const sinO = safeSqrt(1 - b.cosO * b.cosO);
  const cosX = cosSub(sinW, cosW, sinO, b.cosO);
  const sinX = sinSub(sinW, cosW, sinO, b.cosO);
  const cosP = cosSub(sinX, cosX, sinB, cosB);
  if (cosP <= b.cosE) return 0;
  let imp = (b.phi * cosP) / d2;
  if (n[0] !== 0 || n[1] !== 0 || n[2] !== 0) {
    const cosI = Math.abs(dot(wi, n));
    const sinI = safeSqrt(1 - cosI * cosI);
    imp *= cosSub(sinI, cosI, sinB, cosB);
  }
  return Math.max(imp, 0);
}

/* ─── build (pbrt-v4 BVHLightSampler::buildBVH, bucketed cost) ─── */

function mOmega(b: LightBounds): number {
  const tO = safeAcos(b.cosO), tE = safeAcos(b.cosE);
  const tW = Math.min(tO + tE, Math.PI);
  const sinO = safeSqrt(1 - b.cosO * b.cosO);
  return 2 * Math.PI * (1 - b.cosO) + (Math.PI / 2) * (2 * tW * sinO - Math.cos(tO - 2 * tW) - 2 * tO * sinO + b.cosO);
}

function surfaceArea(b: LightBounds): number {
  const x = b.bmax[0] - b.bmin[0], y = b.bmax[1] - b.bmin[1], z = b.bmax[2] - b.bmin[2];
  return 2 * (x * y + y * z + z * x);
}

function cost(b: LightBounds, kr: number): number {
  return b.phi * mOmega(b) * Math.max(surfaceArea(b), 1e-12) * kr;
}

/** Build the tree over lights with phi > 0. */
export function buildLightTree(bounds: LightBounds[]): LightTree {
  const leafOf = new Uint32Array(bounds.length).fill(NO_NODE);
  const nodes: LightTreeNode[] = [];
  const ids: number[] = [];
  for (let i = 0; i < bounds.length; i++) if (bounds[i].phi > 0) ids.push(i);
  if (!ids.length) return { nodes, leafOf };
  const centroid = (i: number, a: number) => (bounds[i].bmin[a] + bounds[i].bmax[a]) * 0.5;
  const nb = LIGHTS_PT.treeBuckets;

  const build = (lo: number, hi: number, parent: number): number => {
    const idx = nodes.length;
    if (hi - lo === 1) {
      const li = ids[lo];
      nodes.push({ ...bounds[li], child0: li, child1: NO_NODE, parent, leaf: true });
      leafOf[li] = idx;
      return idx;
    }
    let all = bounds[ids[lo]];
    const cmin: V3 = [Infinity, Infinity, Infinity], cmax: V3 = [-Infinity, -Infinity, -Infinity];
    for (let k = lo; k < hi; k++) {
      const i = ids[k];
      if (k > lo) all = boundsUnion(all, bounds[i]);
      for (let a = 0; a < 3; a++) { const c = centroid(i, a); cmin[a] = Math.min(cmin[a], c); cmax[a] = Math.max(cmax[a], c); }
    }
    let best = Infinity, bestAxis = -1, bestBucket = -1;
    const ext = [all.bmax[0] - all.bmin[0], all.bmax[1] - all.bmin[1], all.bmax[2] - all.bmin[2]];
    const maxExt = Math.max(ext[0], ext[1], ext[2]);
    for (let a = 0; a < 3; a++) {
      if (!(cmax[a] > cmin[a])) continue;
      const buckets: (LightBounds | null)[] = Array.from({ length: nb }, () => null);
      for (let k = lo; k < hi; k++) {
        const i = ids[k];
        const b = Math.min(nb - 1, Math.floor(((centroid(i, a) - cmin[a]) / (cmax[a] - cmin[a])) * nb));
        buckets[b] = buckets[b] ? boundsUnion(buckets[b]!, bounds[i]) : bounds[i];
      }
      const kr = maxExt / Math.max(ext[a], 1e-12);
      for (let s = 0; s < nb - 1; s++) {
        let L: LightBounds | null = null, R: LightBounds | null = null;
        for (let j = 0; j <= s; j++) if (buckets[j]) L = L ? boundsUnion(L, buckets[j]!) : buckets[j];
        for (let j = s + 1; j < nb; j++) if (buckets[j]) R = R ? boundsUnion(R, buckets[j]!) : buckets[j];
        if (!L || !R) continue;
        const c = cost(L, kr) + cost(R, kr);
        if (c < best) { best = c; bestAxis = a; bestBucket = s; }
      }
    }
    let mid: number;
    if (bestAxis < 0) {
      mid = (lo + hi) >> 1; // all centroids coincide: split in the middle
    } else {
      const a = bestAxis;
      const part = ids.slice(lo, hi);
      const left = part.filter((i) => Math.min(nb - 1, Math.floor(((centroid(i, a) - cmin[a]) / (cmax[a] - cmin[a])) * nb)) <= bestBucket);
      const right = part.filter((i) => Math.min(nb - 1, Math.floor(((centroid(i, a) - cmin[a]) / (cmax[a] - cmin[a])) * nb)) > bestBucket);
      for (let k = 0; k < left.length; k++) ids[lo + k] = left[k];
      for (let k = 0; k < right.length; k++) ids[lo + left.length + k] = right[k];
      mid = lo + left.length;
      if (mid === lo || mid === hi) mid = (lo + hi) >> 1;
    }
    nodes.push({ ...all, child0: NO_NODE, child1: NO_NODE, parent, leaf: false });
    const c0 = build(lo, mid, idx);
    const c1 = build(mid, hi, idx);
    nodes[idx].child0 = c0;
    nodes[idx].child1 = c1;
    return idx;
  };
  build(0, ids.length, NO_NODE);
  return { nodes, leafOf };
}

/* ─── sampling / pmf (CPU mirror of light_tree.wgsl) ─── */

export interface TreeSample {
  light: number;
  pmf: number;
}

/** Stochastic traversal with one uniform number (re-used after rescaling, like the WGSL). */
export function treeSample(t: LightTree, p: ArrayLike<number>, n: ArrayLike<number>, u: number): TreeSample | null {
  if (!t.nodes.length) return null;
  let i = 0, pmf = 1;
  for (;;) {
    const nd = t.nodes[i];
    if (nd.leaf) return pmf > 0 ? { light: nd.child0, pmf } : null;
    const i0 = importance(t.nodes[nd.child0], p, n), i1 = importance(t.nodes[nd.child1], p, n);
    if (!(i0 + i1 > 0)) return null;
    const p0 = i0 / (i0 + i1);
    if (u < p0) { i = nd.child0; u = Math.min(u / p0, 1 - 2 ** -24); pmf *= p0; }
    else { i = nd.child1; u = Math.min((u - p0) / (1 - p0), 1 - 2 ** -24); pmf *= 1 - p0; }
  }
}

/** Probability that treeSample() returns `light` at (p, n). */
export function treePmf(t: LightTree, p: ArrayLike<number>, n: ArrayLike<number>, light: number): number {
  let i = t.leafOf[light];
  if (i === NO_NODE || i === undefined) return 0;
  let pmf = 1;
  while (t.nodes[i].parent !== NO_NODE) {
    const par = t.nodes[t.nodes[i].parent];
    const i0 = importance(t.nodes[par.child0], p, n), i1 = importance(t.nodes[par.child1], p, n);
    if (!(i0 + i1 > 0)) return 0;
    pmf *= (par.child0 === i ? i0 : i1) / (i0 + i1);
    i = t.nodes[i].parent;
  }
  return pmf;
}

/** Importance of the whole tree at (p, n): sum over the root's children (tube vs triangles selection). */
export function treeRootImportance(t: LightTree, p: ArrayLike<number>, n: ArrayLike<number>): number {
  if (!t.nodes.length) return 0;
  const r = t.nodes[0];
  if (r.leaf) return importance(r, p, n);
  return importance(t.nodes[r.child0], p, n) + importance(t.nodes[r.child1], p, n);
}
