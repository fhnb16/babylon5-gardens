/* ═══════════════════════════════════════════════════════════════════════════
   CPU reference traversal over the PACKED buffers — the oracle for the WGSL
   kernels (k_intersect / k_shadow). It follows exactly the algorithm the GPU
   code must implement:

   • one node buffer, one triangle buffer, one instance buffer (layout.ts);
   • stack of (child reference u32, entry distance f32), TRAVERSAL_STACK_SIZE
     entries; ordered visit: both children hit → push the far one, descend the
     near one; popped entries with entry distance > current closest t are
     skipped;
   • two levels: a TLAS leaf (count 1, offset = instance) whose flags pass the
     ray mask transforms the ray into object space with worldToObject (the
     direction is NOT renormalised, so t is the same in both spaces),
     remembers the stack height and continues at blasRoot; when the stack
     drops back to that height the world ray is restored;
   • slab test with min/max, |d| clamped to DIR_EPS, tfar *= SLAB_TFAR_SCALE
     (Ize 2013) so f32 rounding never culls a box a hit lies in;
   • watertight ray/triangle test (Woop, Benthin, Wald 2013), double-sided,
     accepted when tmin < t < tClosest (first hit wins ties).

   The reference computes in f64 by default (the geometric oracle); the GPU
   does the same arithmetic in f32 (Woop's double-precision fallback for
   U/V/W = 0 is not used on either side).

   f32 mode (createTraverser(b, { f32: true }), DECISIONS.md #2) emulates the
   WGSL kernels step by step: every add/sub/mul/div of the ray set-up, the
   instance transform, the slab test and the Woop test is rounded with
   Math.fround, in the same evaluation order as pathtracer/wgsl/*.wgsl, and
   the stack has the kernel's size (B5_TRAVERSE_STACK, default 32) with the
   kernel's overflow policy (replace the farthest entry of the current level,
   count it in stats.stackOverflow) instead of throwing. Remaining sources of
   GPU/CPU difference: FMA contraction and the 2.5-ulp WGSL division, both
   at the last-bit level (compare with a 1e-4 relative tie tolerance).
   ═══════════════════════════════════════════════════════════════════════════ */

import {
  DIR_EPS, EMPTY_LEAF, INST_FLAGS_SHIFT, INST_W, INST_WORDS, NODE_W, NODE_WORDS, SLAB_TFAR_SCALE,
  TRAVERSAL_STACK_SIZE, TRI_W, TRI_WORDS, VIS_ALL, isLeaf, leafCount, leafOffset
} from './layout.ts';

export interface Ray {
  ox: number; oy: number; oz: number;
  dx: number; dy: number; dz: number;
  tmin: number;
  tmax: number;
}

export interface Hit {
  t: number;
  /** instance index, −1 for single-level (BLAS-only) traces */
  instance: number;
  /** original triangle index in its source geometry (tri.primId) */
  prim: number;
  /** absolute triangle record index in the triangle buffer */
  tri: number;
  /** barycentrics: P = (1−u−v)·v0 + u·v1 + v·v2 */
  u: number;
  v: number;
  /** f32 mode only: det > 0 in object space, i.e. (v1−v0)×(v2−v0) faces the ray */
  frontFace?: boolean;
}

export interface TraverserOptions {
  /** emulate the WGSL kernels: f32 rounding at every arithmetic step */
  f32?: boolean;
  /** f32 mode only: stack entries (kernel define B5_TRAVERSE_STACK), default 32 */
  stackSize?: number;
}

/** default private stack size of the WGSL traversal (DECISIONS.md #1) */
export const KERNEL_STACK_SIZE = 32;

export interface TraceBuffers {
  nodes: ArrayBuffer;
  tris: ArrayBuffer;
  instances?: ArrayBuffer;
  /** two-level entry node (PackedScene.tlasRoot) */
  tlasRoot?: number;
}

export interface TraversalStats {
  nodes: number;
  tris: number;
  instances: number;
  maxStack: number;
  /** f32 mode: pushes that overflowed the kernel-sized stack (an entry was dropped) */
  stackOverflow: number;
}

/* ─── ray pre-computation: o, d, 1/d, Woop permutation + shear ───────────── */

const P_O = 0, P_D = 3, P_INV = 6, P_K = 9, P_S = 12;
export const RAY_PRE_SIZE = 15;

export function prepareRay(pre: Float64Array, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): void {
  pre[P_O] = ox; pre[P_O + 1] = oy; pre[P_O + 2] = oz;
  pre[P_D] = dx; pre[P_D + 1] = dy; pre[P_D + 2] = dz;
  pre[P_INV] = 1 / (Math.abs(dx) > DIR_EPS ? dx : dx >= 0 ? DIR_EPS : -DIR_EPS);
  pre[P_INV + 1] = 1 / (Math.abs(dy) > DIR_EPS ? dy : dy >= 0 ? DIR_EPS : -DIR_EPS);
  pre[P_INV + 2] = 1 / (Math.abs(dz) > DIR_EPS ? dz : dz >= 0 ? DIR_EPS : -DIR_EPS);
  const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
  const kz = ax >= ay ? (ax >= az ? 0 : 2) : ay >= az ? 1 : 2;
  let kx = kz === 2 ? 0 : kz + 1;
  let ky = kx === 2 ? 0 : kx + 1;
  const dkz = pre[P_D + kz];
  if (dkz < 0) { const t = kx; kx = ky; ky = t; }
  pre[P_K] = kx; pre[P_K + 1] = ky; pre[P_K + 2] = kz;
  pre[P_S] = pre[P_D + kx] / dkz;
  pre[P_S + 1] = pre[P_D + ky] / dkz;
  pre[P_S + 2] = 1 / dkz;
}

const sv = new Float64Array(9);

/**
 * Watertight ray/triangle test on a triangle record (tri[w..w+12]).
 * Writes [t, u, v] into out and returns true when tmin < t < tmax.
 */
export function intersectTriangle(
  pre: Float64Array, tri: Float32Array, w: number,
  tmin: number, tmax: number, out: Float64Array
): boolean {
  const ox = pre[P_O], oy = pre[P_O + 1], oz = pre[P_O + 2];
  sv[0] = tri[w + TRI_W.v0] - ox; sv[1] = tri[w + TRI_W.v0 + 1] - oy; sv[2] = tri[w + TRI_W.v0 + 2] - oz;
  sv[3] = tri[w + TRI_W.v1] - ox; sv[4] = tri[w + TRI_W.v1 + 1] - oy; sv[5] = tri[w + TRI_W.v1 + 2] - oz;
  sv[6] = tri[w + TRI_W.v2] - ox; sv[7] = tri[w + TRI_W.v2 + 1] - oy; sv[8] = tri[w + TRI_W.v2 + 2] - oz;
  return woopCore(pre, tmin, tmax, out);
}

/** Same test on raw vertices (brute-force oracles). */
export function intersectTriangleRaw(
  pre: Float64Array,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  tmin: number, tmax: number, out: Float64Array
): boolean {
  const ox = pre[P_O], oy = pre[P_O + 1], oz = pre[P_O + 2];
  sv[0] = ax - ox; sv[1] = ay - oy; sv[2] = az - oz;
  sv[3] = bx - ox; sv[4] = by - oy; sv[5] = bz - oz;
  sv[6] = cx - ox; sv[7] = cy - oy; sv[8] = cz - oz;
  return woopCore(pre, tmin, tmax, out);
}

function woopCore(pre: Float64Array, tmin: number, tmax: number, out: Float64Array): boolean {
  const kx = pre[P_K], ky = pre[P_K + 1], kz = pre[P_K + 2];
  const Sx = pre[P_S], Sy = pre[P_S + 1], Sz = pre[P_S + 2];
  const Az = sv[kz], Bz = sv[3 + kz], Cz = sv[6 + kz];
  const Ax = sv[kx] - Sx * Az, Ay = sv[ky] - Sy * Az;
  const Bx = sv[3 + kx] - Sx * Bz, By = sv[3 + ky] - Sy * Bz;
  const Cx = sv[6 + kx] - Sx * Cz, Cy = sv[6 + ky] - Sy * Cz;
  const U = Cx * By - Cy * Bx;
  const V = Ax * Cy - Ay * Cx;
  const W = Bx * Ay - By * Ax;
  if ((U < 0 || V < 0 || W < 0) && (U > 0 || V > 0 || W > 0)) return false;
  const det = U + V + W;
  if (det === 0) return false;
  const T = (U * Az + V * Bz + W * Cz) * Sz;
  const t = T / det;
  if (!(t > tmin && t < tmax)) return false;
  out[0] = t;
  out[1] = V / det;
  out[2] = W / det;
  return true;
}

/* ─── f32 emulation (mirrors pathtracer/wgsl/tri.wgsl + traverse.wgsl) ────── */

const f = Math.fround;
const DIR_EPS_F32 = f(DIR_EPS);
const SLAB_TFAR_SCALE_F32 = f(SLAB_TFAR_SCALE);

/** b5_safe_inv: 1/d with |d| clamped to DIR_EPS (f32) */
function safeInvF32(x: number): number {
  return f(1 / (Math.abs(x) > DIR_EPS_F32 ? x : x >= 0 ? DIR_EPS_F32 : -DIR_EPS_F32));
}

/** prepareRay in f32 (b5_prepare_ray); inputs are rounded to f32 first */
export function prepareRayF32(pre: Float64Array, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): void {
  ox = f(ox); oy = f(oy); oz = f(oz); dx = f(dx); dy = f(dy); dz = f(dz);
  pre[P_O] = ox; pre[P_O + 1] = oy; pre[P_O + 2] = oz;
  pre[P_D] = dx; pre[P_D + 1] = dy; pre[P_D + 2] = dz;
  pre[P_INV] = safeInvF32(dx);
  pre[P_INV + 1] = safeInvF32(dy);
  pre[P_INV + 2] = safeInvF32(dz);
  const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
  const kz = ax >= ay ? (ax >= az ? 0 : 2) : ay >= az ? 1 : 2;
  let kx = kz === 2 ? 0 : kz + 1;
  let ky = kx === 2 ? 0 : kx + 1;
  const dkz = pre[P_D + kz];
  if (dkz < 0) { const t = kx; kx = ky; ky = t; }
  pre[P_K] = kx; pre[P_K + 1] = ky; pre[P_K + 2] = kz;
  pre[P_S] = f(pre[P_D + kx] / dkz);
  pre[P_S + 1] = f(pre[P_D + ky] / dkz);
  pre[P_S + 2] = f(1 / dkz);
}

/** Watertight test in f32 (b5_intersect_tri); out = [t, u, v, frontFace ? 1 : 0] */
export function intersectTriangleF32(
  pre: Float64Array, tri: Float32Array, w: number,
  tmin: number, tmax: number, out: Float64Array
): boolean {
  const ox = pre[P_O], oy = pre[P_O + 1], oz = pre[P_O + 2];
  sv[0] = f(tri[w + TRI_W.v0] - ox); sv[1] = f(tri[w + TRI_W.v0 + 1] - oy); sv[2] = f(tri[w + TRI_W.v0 + 2] - oz);
  sv[3] = f(tri[w + TRI_W.v1] - ox); sv[4] = f(tri[w + TRI_W.v1 + 1] - oy); sv[5] = f(tri[w + TRI_W.v1 + 2] - oz);
  sv[6] = f(tri[w + TRI_W.v2] - ox); sv[7] = f(tri[w + TRI_W.v2 + 1] - oy); sv[8] = f(tri[w + TRI_W.v2 + 2] - oz);
  const kx = pre[P_K], ky = pre[P_K + 1], kz = pre[P_K + 2];
  const Sx = pre[P_S], Sy = pre[P_S + 1], Sz = pre[P_S + 2];
  const Az = sv[kz], Bz = sv[3 + kz], Cz = sv[6 + kz];
  const Ax = f(sv[kx] - f(Sx * Az)), Ay = f(sv[ky] - f(Sy * Az));
  const Bx = f(sv[3 + kx] - f(Sx * Bz)), By = f(sv[3 + ky] - f(Sy * Bz));
  const Cx = f(sv[6 + kx] - f(Sx * Cz)), Cy = f(sv[6 + ky] - f(Sy * Cz));
  const U = f(f(Cx * By) - f(Cy * Bx));
  const V = f(f(Ax * Cy) - f(Ay * Cx));
  const W = f(f(Bx * Ay) - f(By * Ax));
  if ((U < 0 || V < 0 || W < 0) && (U > 0 || V > 0 || W > 0)) return false;
  const det = f(f(U + V) + W);
  if (det === 0) return false;
  const T = f(f(f(f(U * Az) + f(V * Bz)) + f(W * Cz)) * Sz);
  const t = f(T / det);
  if (!(t > tmin && t < tmax)) return false;
  out[0] = t;
  out[1] = f(V / det);
  out[2] = f(W / det);
  out[3] = det > 0 ? 1 : 0;
  return true;
}

/* ─── traversal ───────────────────────────────────────────────────────────── */

export interface Traverser {
  /** two-level closest hit from PackedScene.tlasRoot (needs instances) */
  closestHit(ray: Ray, mask?: number): Hit | null;
  /** two-level any hit (shadow rays) */
  anyHit(ray: Ray, mask?: number): boolean;
  /** single-level closest hit on one BLAS (root = absolute node index); instance = −1 */
  closestHitBlas(root: number, ray: Ray): Hit | null;
  anyHitBlas(root: number, ray: Ray): boolean;
  /** cumulative counters (reset by assigning zeros) */
  stats: TraversalStats;
}

export function createTraverser(b: TraceBuffers, opts: TraverserOptions = {}): Traverser {
  if (opts.f32) return createTraverserF32(b, opts.stackSize ?? KERNEL_STACK_SIZE);
  const NF = new Float32Array(b.nodes), NU = new Uint32Array(b.nodes);
  const TF = new Float32Array(b.tris), TU = new Uint32Array(b.tris);
  const IF = b.instances ? new Float32Array(b.instances) : new Float32Array(0);
  const IU = b.instances ? new Uint32Array(b.instances) : new Uint32Array(0);
  const stackRef = new Uint32Array(TRAVERSAL_STACK_SIZE);
  const stackT = new Float64Array(TRAVERSAL_STACK_SIZE);
  const world = new Float64Array(RAY_PRE_SIZE);
  const obj = new Float64Array(RAY_PRE_SIZE);
  const hitOut = new Float64Array(3);
  const stats: TraversalStats = { nodes: 0, tris: 0, instances: 0, maxStack: 0, stackOverflow: 0 };

  let R = world;
  let tBest = 0, tMin = 0;

  /** slab test of a child box; returns the entry distance or Infinity on miss */
  const slab = (w: number, minW: number, maxW: number): number => {
    const ox = R[P_O], oy = R[P_O + 1], oz = R[P_O + 2];
    const ix = R[P_INV], iy = R[P_INV + 1], iz = R[P_INV + 2];
    const x0 = (NF[w + minW] - ox) * ix, x1 = (NF[w + maxW] - ox) * ix;
    const y0 = (NF[w + minW + 1] - oy) * iy, y1 = (NF[w + maxW + 1] - oy) * iy;
    const z0 = (NF[w + minW + 2] - oz) * iz, z1 = (NF[w + maxW + 2] - oz) * iz;
    const tn = Math.max(Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1), tMin);
    const tf = Math.min(Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1)) * SLAB_TFAR_SCALE;
    return tn <= tf && tn <= tBest ? tn : Infinity;
  };

  function trace(ray: Ray, mask: number, root: number, twoLevel: boolean, any: boolean): Hit | null | true {
    prepareRay(world, ray.ox, ray.oy, ray.oz, ray.dx, ray.dy, ray.dz);
    R = world;
    tBest = ray.tmax;
    tMin = ray.tmin;
    let hitTri = -1, hitInst = -1, hu = 0, hv = 0;
    let sp = 0, blasBase = 0, inBlas = !twoLevel, curInst = -1;
    let ref = root;
    for (;;) {
      descend: if (!isLeaf(ref)) {
        stats.nodes++;
        const w = ref * NODE_WORDS;
        const t0 = slab(w, NODE_W.c0min, NODE_W.c0max);
        const t1 = slab(w, NODE_W.c1min, NODE_W.c1max);
        const c0 = NU[w + NODE_W.child0], c1 = NU[w + NODE_W.child1];
        if (t0 !== Infinity) {
          if (t1 !== Infinity) {
            if (sp >= TRAVERSAL_STACK_SIZE) throw new Error('traversal stack overflow');
            if (t1 < t0) { stackRef[sp] = c0; stackT[sp] = t0; ref = c1; }
            else { stackRef[sp] = c1; stackT[sp] = t1; ref = c0; }
            sp++;
            if (sp > stats.maxStack) stats.maxStack = sp;
          } else ref = c0;
          continue;
        }
        if (t1 !== Infinity) { ref = c1; continue; }
      } else if (ref !== EMPTY_LEAF) {
        const cnt = leafCount(ref), off = leafOffset(ref);
        if (!inBlas) {
          const iw = off * INST_WORDS;
          const flags = IU[iw + INST_W.flagsLight] >>> INST_FLAGS_SHIFT;
          if ((flags & mask & VIS_ALL) === 0) break descend;
          stats.instances++;
          const ox = ray.ox, oy = ray.oy, oz = ray.oz, dx = ray.dx, dy = ray.dy, dz = ray.dz;
          const r0 = iw + INST_W.w2o0, r1 = iw + INST_W.w2o1, r2 = iw + INST_W.w2o2;
          prepareRay(obj,
            IF[r0] * ox + IF[r0 + 1] * oy + IF[r0 + 2] * oz + IF[r0 + 3],
            IF[r1] * ox + IF[r1 + 1] * oy + IF[r1 + 2] * oz + IF[r1 + 3],
            IF[r2] * ox + IF[r2 + 1] * oy + IF[r2 + 2] * oz + IF[r2 + 3],
            IF[r0] * dx + IF[r0 + 1] * dy + IF[r0 + 2] * dz,
            IF[r1] * dx + IF[r1 + 1] * dy + IF[r1 + 2] * dz,
            IF[r2] * dx + IF[r2 + 1] * dy + IF[r2 + 2] * dz);
          R = obj;
          inBlas = true;
          blasBase = sp;
          curInst = off;
          ref = IU[iw + INST_W.blasRoot];
          continue;
        }
        for (let k = 0; k < cnt; k++) {
          stats.tris++;
          const tri = off + k;
          if (intersectTriangle(R, TF, tri * TRI_WORDS, tMin, tBest, hitOut)) {
            if (any) return true;
            tBest = hitOut[0]; hu = hitOut[1]; hv = hitOut[2];
            hitTri = tri; hitInst = curInst;
          }
        }
      }
      /* pop */
      for (;;) {
        if (twoLevel && inBlas && sp === blasBase) { inBlas = false; R = world; curInst = -1; }
        if (sp === 0) {
          if (hitTri < 0) return null;
          return {
            t: tBest, instance: twoLevel ? hitInst : -1,
            prim: TU[hitTri * TRI_WORDS + TRI_W.primId], tri: hitTri, u: hu, v: hv
          };
        }
        sp--;
        if (stackT[sp] > tBest) continue;
        ref = stackRef[sp];
        break;
      }
    }
  }

  return {
    closestHit(ray, mask = VIS_ALL) {
      if (b.tlasRoot === undefined || !b.instances) throw new Error('closestHit needs instances + tlasRoot');
      return trace(ray, mask, b.tlasRoot, true, false) as Hit | null;
    },
    anyHit(ray, mask = VIS_ALL) {
      if (b.tlasRoot === undefined || !b.instances) throw new Error('anyHit needs instances + tlasRoot');
      return trace(ray, mask, b.tlasRoot, true, true) !== null;
    },
    closestHitBlas(root, ray) {
      return trace(ray, VIS_ALL, root, false, false) as Hit | null;
    },
    anyHitBlas(root, ray) {
      return trace(ray, VIS_ALL, root, false, true) !== null;
    },
    stats
  };
}

/**
 * f32 twin of createTraverser: the same algorithm, step for step what
 * pathtracer/wgsl/traverse.wgsl does (f32 rounding, B5_MISS-style entry
 * distances, kernel-sized stack with the overflow policy below).
 */
function createTraverserF32(b: TraceBuffers, stackSize: number): Traverser {
  if (!(stackSize >= 1)) throw new RangeError(`stackSize ${stackSize} < 1`);
  const NF = new Float32Array(b.nodes), NU = new Uint32Array(b.nodes);
  const TF = new Float32Array(b.tris), TU = new Uint32Array(b.tris);
  const IF = b.instances ? new Float32Array(b.instances) : new Float32Array(0);
  const IU = b.instances ? new Uint32Array(b.instances) : new Uint32Array(0);
  const stackRef = new Uint32Array(stackSize);
  const stackT = new Float64Array(stackSize);
  const world = new Float64Array(RAY_PRE_SIZE);
  const obj = new Float64Array(RAY_PRE_SIZE);
  const hitOut = new Float64Array(4);
  const stats: TraversalStats = { nodes: 0, tris: 0, instances: 0, maxStack: 0, stackOverflow: 0 };

  let R = world;
  let tBest = 0, tMin = 0;

  /** b5_slab: entry distance or Infinity (B5_MISS on the GPU) */
  const slab = (w: number, minW: number, maxW: number): number => {
    const ox = R[P_O], oy = R[P_O + 1], oz = R[P_O + 2];
    const ix = R[P_INV], iy = R[P_INV + 1], iz = R[P_INV + 2];
    const x0 = f(f(NF[w + minW] - ox) * ix), x1 = f(f(NF[w + maxW] - ox) * ix);
    const y0 = f(f(NF[w + minW + 1] - oy) * iy), y1 = f(f(NF[w + maxW + 1] - oy) * iy);
    const z0 = f(f(NF[w + minW + 2] - oz) * iz), z1 = f(f(NF[w + maxW + 2] - oz) * iz);
    const tn = Math.max(Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1), tMin);
    const tf = f(Math.min(Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1)) * SLAB_TFAR_SCALE_F32);
    return tn <= tf && tn <= tBest ? tn : Infinity;
  };

  /** p_obj = row · (p, 1), evaluated left to right like the WGSL */
  const row = (r: number, x: number, y: number, z: number): number =>
    f(f(f(f(IF[r] * x) + f(IF[r + 1] * y)) + f(IF[r + 2] * z)) + IF[r + 3]);
  const rowDir = (r: number, x: number, y: number, z: number): number =>
    f(f(f(IF[r] * x) + f(IF[r + 1] * y)) + f(IF[r + 2] * z));

  function trace(ray: Ray, mask: number, root: number, twoLevel: boolean, any: boolean): Hit | null | true {
    prepareRayF32(world, ray.ox, ray.oy, ray.oz, ray.dx, ray.dy, ray.dz);
    R = world;
    tBest = f(ray.tmax);
    tMin = f(ray.tmin);
    let hitTri = -1, hitInst = -1, hu = 0, hv = 0, hf = 0;
    let sp = 0, blasBase = 0, inBlas = !twoLevel, curInst = -1;
    let ref = root;
    for (;;) {
      descend: if (!isLeaf(ref)) {
        stats.nodes++;
        const w = ref * NODE_WORDS;
        const t0 = slab(w, NODE_W.c0min, NODE_W.c0max);
        const t1 = slab(w, NODE_W.c1min, NODE_W.c1max);
        const c0 = NU[w + NODE_W.child0], c1 = NU[w + NODE_W.child1];
        if (t0 !== Infinity) {
          if (t1 !== Infinity) {
            let farRef = c1, farT = t1;
            ref = c0;
            if (t1 < t0) { farRef = c0; farT = t0; ref = c1; }
            if (sp < stackSize) {
              stackRef[sp] = farRef; stackT[sp] = farT; sp++;
              if (sp > stats.maxStack) stats.maxStack = sp;
            } else {
              /* overflow: replace the farthest entry of the current level if it
                 is farther than the new one, else drop the new one */
              stats.stackOverflow++;
              const lo = twoLevel && inBlas ? blasBase : 0;
              let fi = -1, ft = farT;
              for (let i = lo; i < sp; i++) if (stackT[i] > ft) { ft = stackT[i]; fi = i; }
              if (fi >= 0) { stackRef[fi] = farRef; stackT[fi] = farT; }
            }
          } else ref = c0;
          continue;
        }
        if (t1 !== Infinity) { ref = c1; continue; }
      } else if (ref !== EMPTY_LEAF) {
        const cnt = leafCount(ref), off = leafOffset(ref);
        if (!inBlas) {
          const iw = off * INST_WORDS;
          const flags = IU[iw + INST_W.flagsLight] >>> INST_FLAGS_SHIFT;
          if ((flags & mask & VIS_ALL) === 0) break descend;
          stats.instances++;
          const ox = f(ray.ox), oy = f(ray.oy), oz = f(ray.oz), dx = f(ray.dx), dy = f(ray.dy), dz = f(ray.dz);
          const r0 = iw + INST_W.w2o0, r1 = iw + INST_W.w2o1, r2 = iw + INST_W.w2o2;
          prepareRayF32(obj,
            row(r0, ox, oy, oz), row(r1, ox, oy, oz), row(r2, ox, oy, oz),
            rowDir(r0, dx, dy, dz), rowDir(r1, dx, dy, dz), rowDir(r2, dx, dy, dz));
          R = obj;
          inBlas = true;
          blasBase = sp;
          curInst = off;
          ref = IU[iw + INST_W.blasRoot];
          continue;
        }
        for (let k = 0; k < cnt; k++) {
          stats.tris++;
          const tri = off + k;
          if (intersectTriangleF32(R, TF, tri * TRI_WORDS, tMin, tBest, hitOut)) {
            if (any) return true;
            tBest = hitOut[0]; hu = hitOut[1]; hv = hitOut[2]; hf = hitOut[3];
            hitTri = tri; hitInst = curInst;
          }
        }
      }
      /* pop */
      for (;;) {
        if (twoLevel && inBlas && sp === blasBase) { inBlas = false; R = world; curInst = -1; }
        if (sp === 0) {
          if (hitTri < 0) return null;
          return {
            t: tBest, instance: twoLevel ? hitInst : -1,
            prim: TU[hitTri * TRI_WORDS + TRI_W.primId], tri: hitTri, u: hu, v: hv, frontFace: hf === 1
          };
        }
        sp--;
        if (stackT[sp] > tBest) continue;
        ref = stackRef[sp];
        break;
      }
    }
  }

  return {
    closestHit(ray, mask = VIS_ALL) {
      if (b.tlasRoot === undefined || !b.instances) throw new Error('closestHit needs instances + tlasRoot');
      return trace(ray, mask, b.tlasRoot, true, false) as Hit | null;
    },
    anyHit(ray, mask = VIS_ALL) {
      if (b.tlasRoot === undefined || !b.instances) throw new Error('anyHit needs instances + tlasRoot');
      return trace(ray, mask, b.tlasRoot, true, true) !== null;
    },
    closestHitBlas(root, ray) {
      return trace(ray, VIS_ALL, root, false, false) as Hit | null;
    },
    anyHitBlas(root, ray) {
      return trace(ray, VIS_ALL, root, false, true) !== null;
    },
    stats
  };
}
