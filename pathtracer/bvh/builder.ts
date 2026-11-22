/* ═══════════════════════════════════════════════════════════════════════════
   Binned-SAH BVH2 builder (CPU, pure TS, no DOM/three — runs in a worker or
   in Node).

   Output is already in the GPU node layout (layout.ts) with LOCAL references:
   inner child = node index inside this tree, leaf offset = position in
   `primIndex` (or, with `directLeaves`, the primitive id itself + leafIdBase).
   pack.ts relocates when several trees are concatenated.

   Algorithm
   • top-down, explicit task stack (DFS, left child first ⇒ child0 of node i is
     usually node i+1), no recursion, no per-node allocation: one primitive id
     array partitioned in place, preallocated bins and node buffer;
   • per task: centroid bounds → B bins on all three axes in one pass → SAH
     sweep per axis → leaf if (n ≤ maxLeaf and leaf cost ≤ split cost);
   • SAH cost = Ct + Ci·(A_L·N_L + A_R·N_R)/A, leaf cost = Ci·N;
   • fallbacks: no valid binned split (identical centroids, everything in one
     bin, zero-area node) or depth budget exhausted → median split (quickselect
     on the largest centroid axis, or index halving when centroids coincide).
     The depth budget guarantees maxDepth: a node with `a` inner ancestors and
     n prims switches to median splits once a + 1 + ⌈log2⌈n/maxLeaf⌉⌉ > maxDepth.
   • degenerate / zero-area triangles keep a valid point/segment box; triangles
     with non-finite vertices get an EMPTY box at the origin centroid and can
     never be hit.
   ═══════════════════════════════════════════════════════════════════════════ */

import {
  BLAS_MAX_DEPTH, EMPTY_BOX_COORD, EMPTY_LEAF, MAX_LEAF_OFFSET, MAX_LEAF_PRIMS,
  NODE_INVALID, NODE_W, NODE_WORDS, NODE_BYTES, isLeaf, leafCount, leafOffset, makeLeaf
} from './layout.ts';

export interface BuildOptions {
  /** SAH bins per axis, 4..64 (default 32) */
  bins?: number;
  /** max primitives per leaf, 1..15 (default 4) */
  maxLeaf?: number;
  /** max inner nodes on a root→leaf path (default BLAS_MAX_DEPTH = 40) */
  maxDepth?: number;
  /** SAH traversal cost Ct relative to Ci (default 1.5 ⇒ ~2–3 tris per leaf) */
  traversalCost?: number;
  /** SAH primitive intersection cost Ci (default 1) */
  intersectCost?: number;
  /** 'median' builds the object-median baseline (tests / comparison) */
  strategy?: 'sah' | 'median';
  /** leaves reference the primitive id directly (+ leafIdBase); requires maxLeaf = 1 (TLAS) */
  directLeaves?: boolean;
  leafIdBase?: number;
}

export interface Bvh2 {
  /** nodeCount × 64 B in GPU layout, local references */
  nodes: ArrayBuffer;
  nodeCount: number;
  /** leaf slot → original primitive id (length primCount) */
  primIndex: Uint32Array;
  primCount: number;
  /** root bounds minx,miny,minz,maxx,maxy,maxz (EMPTY box if no prims) */
  bounds: Float32Array;
  /** inner nodes on the deepest root→leaf path (root = 1) */
  maxDepth: number;
  leafCount: number;
  /** number of nodes split by the median fallback */
  medianSplits: number;
  directLeaves: boolean;
  /** added to direct leaf ids (TLAS: index of the first instance of this tree) */
  leafIdBase: number;
}

const INF = Infinity;
/** default SAH Ct (Ci = 1): node fetch (64 B + 2 slab tests + stack) vs Woop test (48 B) */
export const DEFAULT_TRAVERSAL_COST = 1.5;

/** Per-triangle AABBs (6 floats each). Non-finite triangles get an EMPTY box. */
export function triangleBounds(
  positions: Float32Array,
  index?: Uint16Array | Uint32Array | null,
  out?: Float32Array
): Float32Array {
  const n = index ? (index.length / 3) | 0 : (positions.length / 9) | 0;
  const b = out && out.length >= n * 6 ? out : new Float32Array(n * 6);
  const p = positions;
  for (let t = 0; t < n; t++) {
    let a: number, c: number, d: number;
    if (index) { a = index[t * 3] * 3; c = index[t * 3 + 1] * 3; d = index[t * 3 + 2] * 3; }
    else { a = t * 9; c = a + 3; d = a + 6; }
    const ax = p[a], ay = p[a + 1], az = p[a + 2];
    const bx = p[c], by = p[c + 1], bz = p[c + 2];
    const cx = p[d], cy = p[d + 1], cz = p[d + 2];
    const o = t * 6;
    const sum = ax + ay + az + bx + by + bz + cx + cy + cz;
    if (sum - sum !== 0) { // NaN or ±Inf somewhere
      b[o] = b[o + 1] = b[o + 2] = EMPTY_BOX_COORD;
      b[o + 3] = b[o + 4] = b[o + 5] = -EMPTY_BOX_COORD;
      continue;
    }
    b[o] = ax < bx ? (ax < cx ? ax : cx) : (bx < cx ? bx : cx);
    b[o + 1] = ay < by ? (ay < cy ? ay : cy) : (by < cy ? by : cy);
    b[o + 2] = az < bz ? (az < cz ? az : cz) : (bz < cz ? bz : cz);
    b[o + 3] = ax > bx ? (ax > cx ? ax : cx) : (bx > cx ? bx : cx);
    b[o + 4] = ay > by ? (ay > cy ? ay : cy) : (by > cy ? by : cy);
    b[o + 5] = az > bz ? (az > cz ? az : cz) : (bz > cz ? bz : cz);
  }
  return b;
}

function ceilLog2(x: number): number {
  let r = 0;
  while (2 ** r < x) r++;
  return r;
}

/**
 * Build a BVH2 over primitive boxes (6 floats per primitive). Inverted boxes
 * (min > max) are treated as empty: they never enlarge a node and sit at the
 * origin for binning.
 */
export function buildBvhFromBoxes(boxes: Float32Array, opts: BuildOptions = {}): Bvh2 {
  const n = (boxes.length / 6) | 0;
  const B = Math.max(4, Math.min(64, opts.bins ?? 32)) | 0;
  const direct = !!opts.directLeaves;
  const maxLeaf = direct ? 1 : Math.max(1, Math.min(MAX_LEAF_PRIMS, opts.maxLeaf ?? 4)) | 0;
  const maxDepth = Math.max(1, opts.maxDepth ?? BLAS_MAX_DEPTH) | 0;
  const Ct = opts.traversalCost ?? DEFAULT_TRAVERSAL_COST;
  const Ci = opts.intersectCost ?? 1;
  const median = opts.strategy === 'median';
  const idBase = opts.leafIdBase ?? 0;
  if (n + (direct ? idBase : 0) > MAX_LEAF_OFFSET) throw new RangeError(`too many primitives: ${n}`);
  if (ceilLog2(Math.ceil(n / maxLeaf)) > maxDepth) throw new RangeError(`maxDepth ${maxDepth} too small for ${n} prims`);

  /* centroids (box centres; empty boxes → origin) */
  const cen = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const o = i * 6;
    if (boxes[o] > boxes[o + 3]) { cen[i * 3] = cen[i * 3 + 1] = cen[i * 3 + 2] = 0; continue; }
    cen[i * 3] = (boxes[o] + boxes[o + 3]) * 0.5;
    cen[i * 3 + 1] = (boxes[o + 1] + boxes[o + 4]) * 0.5;
    cen[i * 3 + 2] = (boxes[o + 2] + boxes[o + 5]) * 0.5;
  }
  const ids = new Uint32Array(n);
  for (let i = 0; i < n; i++) ids[i] = i;

  const cap = Math.max(1, n - 1);
  const buf = new ArrayBuffer(cap * NODE_BYTES);
  const F = new Float32Array(buf);
  const U = new Uint32Array(buf);
  let nodeCount = 0;

  /* bins: [axis][bin] → count, box */
  const binCnt = new Uint32Array(3 * B);
  const binBox = new Float32Array(3 * B * 6);
  const rArea = new Float64Array(B);
  const rCnt = new Uint32Array(B);

  /* task stack (DFS) */
  const S = 2 * maxDepth + 8;
  const tS = new Uint32Array(S), tE = new Uint32Array(S), tD = new Uint32Array(S);
  const tSlot = new Int32Array(S); // u32 word index of the parent's child reference, −1 = root
  const tParent = new Uint32Array(S);
  const tBox = new Float64Array(S * 6), tCb = new Float64Array(S * 6);
  let sp = 1; // the root task is written at index 0 below

  /* scratch for computing the two child ranges' bounds */
  const sb = new Float64Array(12); // box L (6), box R (6)
  const sc = new Float64Array(12); // centroid bounds L, R

  const rangeBounds = (s: number, e: number, bo: Float64Array, bOff: number, co: Float64Array, cOff: number) => {
    let x0 = INF, y0 = INF, z0 = INF, x1 = -INF, y1 = -INF, z1 = -INF;
    let cx0 = INF, cy0 = INF, cz0 = INF, cx1 = -INF, cy1 = -INF, cz1 = -INF;
    for (let i = s; i < e; i++) {
      const id = ids[i], o = id * 6, c = id * 3;
      const a0 = boxes[o], a1 = boxes[o + 1], a2 = boxes[o + 2];
      const a3 = boxes[o + 3], a4 = boxes[o + 4], a5 = boxes[o + 5];
      if (a0 < x0) x0 = a0; if (a1 < y0) y0 = a1; if (a2 < z0) z0 = a2;
      if (a3 > x1) x1 = a3; if (a4 > y1) y1 = a4; if (a5 > z1) z1 = a5;
      const q0 = cen[c], q1 = cen[c + 1], q2 = cen[c + 2];
      if (q0 < cx0) cx0 = q0; if (q0 > cx1) cx1 = q0;
      if (q1 < cy0) cy0 = q1; if (q1 > cy1) cy1 = q1;
      if (q2 < cz0) cz0 = q2; if (q2 > cz1) cz1 = q2;
    }
    bo[bOff] = x0; bo[bOff + 1] = y0; bo[bOff + 2] = z0; bo[bOff + 3] = x1; bo[bOff + 4] = y1; bo[bOff + 5] = z1;
    co[cOff] = cx0; co[cOff + 1] = cy0; co[cOff + 2] = cz0; co[cOff + 3] = cx1; co[cOff + 4] = cy1; co[cOff + 5] = cz1;
  };

  const halfArea = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => {
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
    return dx < 0 || dy < 0 || dz < 0 ? 0 : dx * dy + dy * dz + dz * dx;
  };

  /** write a child box (6 doubles, inverted = empty) into node word offset w */
  const writeBox = (w: number, minW: number, maxW: number, bx: Float64Array, o: number) => {
    if (!(bx[o] <= bx[o + 3])) {
      F[w + minW] = F[w + minW + 1] = F[w + minW + 2] = EMPTY_BOX_COORD;
      F[w + maxW] = F[w + maxW + 1] = F[w + maxW + 2] = EMPTY_BOX_COORD;
      return;
    }
    F[w + minW] = bx[o]; F[w + minW + 1] = bx[o + 1]; F[w + minW + 2] = bx[o + 2];
    F[w + maxW] = bx[o + 3]; F[w + maxW + 1] = bx[o + 4]; F[w + maxW + 2] = bx[o + 5];
  };

  /** in-place quickselect: ids[s..e) so that ids[k] has the k-th centroid along axis */
  const select = (s: number, e: number, k: number, axis: number) => {
    let lo = s, hi = e - 1;
    while (hi > lo) {
      const m = (lo + hi) >>> 1;
      const a = cen[ids[lo] * 3 + axis], b = cen[ids[m] * 3 + axis], c = cen[ids[hi] * 3 + axis];
      const pivot = a < b ? (b < c ? b : a < c ? c : a) : (a < c ? a : b < c ? c : b);
      let i = lo, j = hi;
      while (i <= j) {
        while (cen[ids[i] * 3 + axis] < pivot) i++;
        while (cen[ids[j] * 3 + axis] > pivot) j--;
        if (i <= j) { const t = ids[i]; ids[i] = ids[j]; ids[j] = t; i++; j--; }
      }
      if (k <= j) hi = j;
      else if (k >= i) lo = i;
      else break;
    }
  };

  let maxDepthSeen = 0, leafCountTotal = 0, medianSplits = 0;
  const rootBounds = new Float32Array(6);

  /* root task */
  {
    rangeBounds(0, n, tBox, 0, tCb, 0);
    tS[0] = 0; tE[0] = n; tD[0] = 1; tSlot[0] = -1; tParent[0] = NODE_INVALID;
    if (n > 0 && tBox[0] <= tBox[3]) for (let k = 0; k < 6; k++) rootBounds[k] = tBox[k];
    else { rootBounds.fill(EMPTY_BOX_COORD, 0, 3); rootBounds.fill(-EMPTY_BOX_COORD, 3, 6); }
  }

  const leafRef = (s: number, cnt: number) =>
    cnt === 0 ? EMPTY_LEAF : makeLeaf(cnt, direct ? idBase + ids[s] : s);

  while (sp > 0) {
    sp--;
    const s = tS[sp], e = tE[sp], depth = tD[sp], slot = tSlot[sp], parent = tParent[sp];
    const bo = sp * 6;
    const nb0 = tBox[bo], nb1 = tBox[bo + 1], nb2 = tBox[bo + 2], nb3 = tBox[bo + 3], nb4 = tBox[bo + 4], nb5 = tBox[bo + 5];
    const cb0 = tCb[bo], cb1 = tCb[bo + 1], cb2 = tCb[bo + 2], cb3 = tCb[bo + 3], cb4 = tCb[bo + 4], cb5 = tCb[bo + 5];
    const cnt = e - s;

    /* ── decide: leaf / binned split / median split ── */
    let leaf = false, useMedian = false, bestAxis = -1, bestBin = 0;
    let scale0 = 0, scale1 = 0, scale2 = 0, Be = B;
    const forced = depth + ceilLog2(Math.ceil(cnt / maxLeaf)) > maxDepth;
    if (cnt <= 1) leaf = true;
    else if (median || forced) {
      if (cnt <= maxLeaf) leaf = true; else useMedian = true;
    } else {
      const area = halfArea(nb0, nb1, nb2, nb3, nb4, nb5);
      const ex0 = cb3 - cb0, ex1 = cb4 - cb1, ex2 = cb5 - cb2;
      Be = cnt <= 16 ? (B < 8 ? B : 8) : cnt <= 64 ? (B < 16 ? B : 16) : B; // fewer bins for small nodes
      scale0 = ex0 > 0 ? Be / ex0 : 0; scale1 = ex1 > 0 ? Be / ex1 : 0; scale2 = ex2 > 0 ? Be / ex2 : 0;
      let bestSum = INF;
      if (area > 0 && (scale0 > 0 || scale1 > 0 || scale2 > 0)) {
        for (let k = 0; k < 3 * B; k++) {
          if (k % B >= Be) continue;
          binCnt[k] = 0;
          const o = k * 6;
          binBox[o] = binBox[o + 1] = binBox[o + 2] = INF;
          binBox[o + 3] = binBox[o + 4] = binBox[o + 5] = -INF;
        }
        const Bm1 = Be - 1;
        for (let i = s; i < e; i++) {
          const id = ids[i], o = id * 6, c = id * 3;
          const a0 = boxes[o], a1 = boxes[o + 1], a2 = boxes[o + 2];
          const a3 = boxes[o + 3], a4 = boxes[o + 4], a5 = boxes[o + 5];
          let k0 = ((cen[c] - cb0) * scale0) | 0; if (k0 > Bm1) k0 = Bm1;
          let k1 = ((cen[c + 1] - cb1) * scale1) | 0; if (k1 > Bm1) k1 = Bm1;
          let k2 = ((cen[c + 2] - cb2) * scale2) | 0; if (k2 > Bm1) k2 = Bm1;
          k1 += B; k2 += 2 * B;
          binCnt[k0]++; binCnt[k1]++; binCnt[k2]++;
          let q = k0 * 6;
          if (a0 < binBox[q]) binBox[q] = a0; if (a1 < binBox[q + 1]) binBox[q + 1] = a1; if (a2 < binBox[q + 2]) binBox[q + 2] = a2;
          if (a3 > binBox[q + 3]) binBox[q + 3] = a3; if (a4 > binBox[q + 4]) binBox[q + 4] = a4; if (a5 > binBox[q + 5]) binBox[q + 5] = a5;
          q = k1 * 6;
          if (a0 < binBox[q]) binBox[q] = a0; if (a1 < binBox[q + 1]) binBox[q + 1] = a1; if (a2 < binBox[q + 2]) binBox[q + 2] = a2;
          if (a3 > binBox[q + 3]) binBox[q + 3] = a3; if (a4 > binBox[q + 4]) binBox[q + 4] = a4; if (a5 > binBox[q + 5]) binBox[q + 5] = a5;
          q = k2 * 6;
          if (a0 < binBox[q]) binBox[q] = a0; if (a1 < binBox[q + 1]) binBox[q + 1] = a1; if (a2 < binBox[q + 2]) binBox[q + 2] = a2;
          if (a3 > binBox[q + 3]) binBox[q + 3] = a3; if (a4 > binBox[q + 4]) binBox[q + 4] = a4; if (a5 > binBox[q + 5]) binBox[q + 5] = a5;
        }
        for (let axis = 0; axis < 3; axis++) {
          if ((axis === 0 ? scale0 : axis === 1 ? scale1 : scale2) === 0) continue;
          const base = axis * B;
          let x0 = INF, y0 = INF, z0 = INF, x1 = -INF, y1 = -INF, z1 = -INF, c = 0;
          for (let k = Be - 1; k > 0; k--) {
            const q = (base + k) * 6;
            c += binCnt[base + k];
            if (binBox[q] < x0) x0 = binBox[q]; if (binBox[q + 1] < y0) y0 = binBox[q + 1]; if (binBox[q + 2] < z0) z0 = binBox[q + 2];
            if (binBox[q + 3] > x1) x1 = binBox[q + 3]; if (binBox[q + 4] > y1) y1 = binBox[q + 4]; if (binBox[q + 5] > z1) z1 = binBox[q + 5];
            rCnt[k] = c;
            rArea[k] = c > 0 ? halfArea(x0, y0, z0, x1, y1, z1) : 0;
          }
          x0 = INF; y0 = INF; z0 = INF; x1 = -INF; y1 = -INF; z1 = -INF; c = 0;
          for (let k = 0; k < Be - 1; k++) {
            const q = (base + k) * 6;
            c += binCnt[base + k];
            if (binBox[q] < x0) x0 = binBox[q]; if (binBox[q + 1] < y0) y0 = binBox[q + 1]; if (binBox[q + 2] < z0) z0 = binBox[q + 2];
            if (binBox[q + 3] > x1) x1 = binBox[q + 3]; if (binBox[q + 4] > y1) y1 = binBox[q + 4]; if (binBox[q + 5] > z1) z1 = binBox[q + 5];
            const rc = rCnt[k + 1];
            if (c === 0 || rc === 0) continue;
            const sum = halfArea(x0, y0, z0, x1, y1, z1) * c + rArea[k + 1] * rc;
            if (sum < bestSum) { bestSum = sum; bestAxis = axis; bestBin = k + 1; }
          }
        }
      }
      if (bestAxis < 0) {
        if (cnt <= maxLeaf) leaf = true; else useMedian = true;
      } else {
        const splitCost = Ct + (Ci * bestSum) / area;
        if (cnt <= maxLeaf && Ci * cnt <= splitCost) leaf = true;
      }
    }

    /* ── leaf ── */
    if (leaf && slot >= 0) {
      U[slot] = leafRef(s, cnt);
      leafCountTotal++;
      continue;
    }

    /* ── inner node (the root is always an inner node) ── */
    const node = nodeCount++;
    const w = node * NODE_WORDS;
    U[w + NODE_W.parent] = parent;
    U[w + NODE_W.aux] = 0;
    if (slot >= 0) U[slot] = node;
    if (depth > maxDepthSeen) maxDepthSeen = depth;

    if (leaf) { // root holding ≤ maxLeaf prims: child0 = leaf, child1 = empty
      writeBox(w, NODE_W.c0min, NODE_W.c0max, tBox, bo);
      U[w + NODE_W.child0] = leafRef(s, cnt);
      sb[0] = INF; sb[3] = -INF;
      writeBox(w, NODE_W.c1min, NODE_W.c1max, sb, 0);
      U[w + NODE_W.child1] = EMPTY_LEAF;
      if (cnt > 0) leafCountTotal++;
      continue;
    }

    let mid: number;
    if (useMedian) {
      medianSplits++;
      const ex0 = cb3 - cb0, ex1 = cb4 - cb1, ex2 = cb5 - cb2;
      const axis = ex0 >= ex1 && ex0 >= ex2 ? 0 : ex1 >= ex2 ? 1 : 2;
      mid = s + (cnt >>> 1);
      if ((axis === 0 ? ex0 : axis === 1 ? ex1 : ex2) > 0) select(s, e, mid, axis);
      rangeBounds(s, mid, sb, 0, sc, 0);
      rangeBounds(mid, e, sb, 6, sc, 6);
    } else {
      /* in-place partition by bin (same arithmetic as the binning pass),
         accumulating both children's box and centroid bounds on the way */
      const sc0 = bestAxis === 0 ? scale0 : bestAxis === 1 ? scale1 : scale2;
      const cmin = bestAxis === 0 ? cb0 : bestAxis === 1 ? cb1 : cb2;
      const Bm1 = Be - 1;
      let lx0 = INF, ly0 = INF, lz0 = INF, lx1 = -INF, ly1 = -INF, lz1 = -INF;
      let lcx0 = INF, lcy0 = INF, lcz0 = INF, lcx1 = -INF, lcy1 = -INF, lcz1 = -INF;
      let rx0 = INF, ry0 = INF, rz0 = INF, rx1 = -INF, ry1 = -INF, rz1 = -INF;
      let rcx0 = INF, rcy0 = INF, rcz0 = INF, rcx1 = -INF, rcy1 = -INF, rcz1 = -INF;
      let i = s, j = e - 1;
      while (i <= j) {
        const id = ids[i], c = id * 3, o = id * 6;
        const q0 = cen[c], q1 = cen[c + 1], q2 = cen[c + 2];
        let k = (((bestAxis === 0 ? q0 : bestAxis === 1 ? q1 : q2) - cmin) * sc0) | 0; if (k > Bm1) k = Bm1;
        const a0 = boxes[o], a1 = boxes[o + 1], a2 = boxes[o + 2], a3 = boxes[o + 3], a4 = boxes[o + 4], a5 = boxes[o + 5];
        if (k < bestBin) {
          if (a0 < lx0) lx0 = a0; if (a1 < ly0) ly0 = a1; if (a2 < lz0) lz0 = a2;
          if (a3 > lx1) lx1 = a3; if (a4 > ly1) ly1 = a4; if (a5 > lz1) lz1 = a5;
          if (q0 < lcx0) lcx0 = q0; if (q0 > lcx1) lcx1 = q0;
          if (q1 < lcy0) lcy0 = q1; if (q1 > lcy1) lcy1 = q1;
          if (q2 < lcz0) lcz0 = q2; if (q2 > lcz1) lcz1 = q2;
          i++;
        } else {
          if (a0 < rx0) rx0 = a0; if (a1 < ry0) ry0 = a1; if (a2 < rz0) rz0 = a2;
          if (a3 > rx1) rx1 = a3; if (a4 > ry1) ry1 = a4; if (a5 > rz1) rz1 = a5;
          if (q0 < rcx0) rcx0 = q0; if (q0 > rcx1) rcx1 = q0;
          if (q1 < rcy0) rcy0 = q1; if (q1 > rcy1) rcy1 = q1;
          if (q2 < rcz0) rcz0 = q2; if (q2 > rcz1) rcz1 = q2;
          ids[i] = ids[j]; ids[j] = id; j--;
        }
      }
      mid = i;
      if (mid === s || mid === e) { // cannot happen with identical arithmetic; stay safe
        mid = s + (cnt >>> 1);
        medianSplits++;
        rangeBounds(s, mid, sb, 0, sc, 0);
        rangeBounds(mid, e, sb, 6, sc, 6);
      } else {
        sb[0] = lx0; sb[1] = ly0; sb[2] = lz0; sb[3] = lx1; sb[4] = ly1; sb[5] = lz1;
        sb[6] = rx0; sb[7] = ry0; sb[8] = rz0; sb[9] = rx1; sb[10] = ry1; sb[11] = rz1;
        sc[0] = lcx0; sc[1] = lcy0; sc[2] = lcz0; sc[3] = lcx1; sc[4] = lcy1; sc[5] = lcz1;
        sc[6] = rcx0; sc[7] = rcy0; sc[8] = rcz0; sc[9] = rcx1; sc[10] = rcy1; sc[11] = rcz1;
      }
    }
    writeBox(w, NODE_W.c0min, NODE_W.c0max, sb, 0);
    writeBox(w, NODE_W.c1min, NODE_W.c1max, sb, 6);
    U[w + NODE_W.child0] = 0;
    U[w + NODE_W.child1] = 0;

    if (sp + 2 > S) throw new Error('bvh task stack overflow');
    /* push right first so the left child is processed (and allocated) next */
    for (let side = 1; side >= 0; side--) {
      const t = sp++;
      tS[t] = side ? mid : s; tE[t] = side ? e : mid; tD[t] = depth + 1;
      tSlot[t] = w + (side ? NODE_W.child1 : NODE_W.child0);
      tParent[t] = node;
      for (let k = 0; k < 6; k++) { tBox[t * 6 + k] = sb[side * 6 + k]; tCb[t * 6 + k] = sc[side * 6 + k]; }
    }
  }

  return {
    nodes: nodeCount === cap ? buf : buf.slice(0, nodeCount * NODE_BYTES),
    nodeCount,
    primIndex: ids,
    primCount: n,
    bounds: rootBounds,
    maxDepth: maxDepthSeen,
    leafCount: leafCountTotal,
    medianSplits,
    directLeaves: direct,
    leafIdBase: direct ? idBase : 0
  };
}

/** BLAS over a triangle mesh (positions xyz, optional index). */
export function buildBlas(
  positions: Float32Array,
  index?: Uint16Array | Uint32Array | null,
  opts: BuildOptions = {}
): Bvh2 {
  return buildBvhFromBoxes(triangleBounds(positions, index), opts);
}

/* ─── analysis ────────────────────────────────────────────────────────────── */

function nodeHalfArea(F: Float32Array, w: number, minW: number, maxW: number): number {
  const dx = F[w + maxW] - F[w + minW], dy = F[w + maxW + 1] - F[w + minW + 1], dz = F[w + maxW + 2] - F[w + minW + 2];
  return dx * dy + dy * dz + dz * dx;
}

/**
 * SAH cost of a built tree (local refs, root = node 0):
 * Ct·Σ_inner A(n)/A(root) + Ci·Σ_leaf N(l)·A(l)/A(root).
 */
export function bvhSahCost(bvh: Bvh2, Ct = DEFAULT_TRAVERSAL_COST, Ci = 1): number {
  const F = new Float32Array(bvh.nodes, 0, bvh.nodeCount * NODE_WORDS);
  const U = new Uint32Array(bvh.nodes, 0, bvh.nodeCount * NODE_WORDS);
  if (bvh.nodeCount === 0 || bvh.primCount === 0) return 0;
  const r = bvh.bounds;
  const rootA = (r[3] - r[0]) * (r[4] - r[1]) + (r[4] - r[1]) * (r[5] - r[2]) + (r[5] - r[2]) * (r[3] - r[0]);
  if (!(rootA > 0)) return Ct;
  let cost = Ct * rootA;
  for (let i = 0; i < bvh.nodeCount; i++) {
    const w = i * NODE_WORDS;
    for (let side = 0; side < 2; side++) {
      const ref = U[w + (side ? NODE_W.child1 : NODE_W.child0)];
      if (ref === EMPTY_LEAF) continue;
      const a = nodeHalfArea(F, w, side ? NODE_W.c1min : NODE_W.c0min, side ? NODE_W.c1max : NODE_W.c0max);
      cost += isLeaf(ref) ? Ci * leafCount(ref) * a : Ct * a;
    }
  }
  return cost / rootA;
}

/**
 * Structural validation (tests / debug). Returns null when valid, otherwise
 * the first problem found. Checks: every primitive referenced exactly once,
 * child boxes inside the parent's box for that child, primitive boxes inside
 * their leaf box, parent links, no orphan nodes, depth ≤ maxDepth.
 */
export function validateBvh(bvh: Bvh2, boxes: Float32Array, maxDepth = BLAS_MAX_DEPTH): string | null {
  const F = new Float32Array(bvh.nodes, 0, bvh.nodeCount * NODE_WORDS);
  const U = new Uint32Array(bvh.nodes, 0, bvh.nodeCount * NODE_WORDS);
  const n = bvh.primCount;
  const seen = new Uint8Array(n);
  const visited = new Uint8Array(bvh.nodeCount);
  if (bvh.nodeCount < 1) return 'no root node';
  const stack: number[] = [0, 1]; // node, depth
  // box (for each node) = the box stored for it in its parent; root: bvh.bounds
  const ownBox = new Float32Array(bvh.nodeCount * 6);
  for (let k = 0; k < 6; k++) ownBox[k] = bvh.bounds[k];
  const inside = (a: ArrayLike<number>, ao: number, b: ArrayLike<number>, bo: number) =>
    a[ao] >= b[bo] && a[ao + 1] >= b[bo + 1] && a[ao + 2] >= b[bo + 2] &&
    a[ao + 3] <= b[bo + 3] && a[ao + 4] <= b[bo + 4] && a[ao + 5] <= b[bo + 5];
  const cb = new Float32Array(6);
  let maxD = 0;
  while (stack.length) {
    const d = stack.pop()!, node = stack.pop()!;
    if (node >= bvh.nodeCount) return `node ${node} out of range`;
    if (visited[node]) return `node ${node} reached twice`;
    visited[node] = 1;
    if (d > maxD) maxD = d;
    const w = node * NODE_WORDS;
    for (let side = 0; side < 2; side++) {
      const ref = U[w + (side ? NODE_W.child1 : NODE_W.child0)];
      const mn = side ? NODE_W.c1min : NODE_W.c0min, mx = side ? NODE_W.c1max : NODE_W.c0max;
      cb[0] = F[w + mn]; cb[1] = F[w + mn + 1]; cb[2] = F[w + mn + 2];
      cb[3] = F[w + mx]; cb[4] = F[w + mx + 1]; cb[5] = F[w + mx + 2];
      if (ref === EMPTY_LEAF) {
        if (cb[0] !== EMPTY_BOX_COORD) return `node ${node} empty slot ${side} has a non-empty box`;
        continue;
      }
      if (cb[0] !== EMPTY_BOX_COORD && !inside(cb, 0, ownBox, node * 6)) return `node ${node} child ${side} box not inside parent box`;
      if (isLeaf(ref)) {
        const c = leafCount(ref), off = leafOffset(ref);
        if (c === 0) return `node ${node} child ${side}: zero-count leaf with flag`;
        for (let k = 0; k < c; k++) {
          let id: number;
          if (bvh.directLeaves) {
            id = off + k - bvh.leafIdBase;
            if (id < 0 || id >= n) return `direct leaf id ${off + k} out of range`;
            if (seen[id]) return `primitive ${id} referenced twice`;
            seen[id] = 1;
          } else {
            const sl = off + k;
            if (sl >= n) return `leaf offset ${sl} ≥ ${n}`;
            if (seen[sl]) return `primitive slot ${sl} referenced twice`;
            seen[sl] = 1;
            id = bvh.primIndex[sl];
          }
          const o = id * 6;
          if (boxes[o] <= boxes[o + 3] && !inside(boxes, o, cb, 0)) return `prim ${id} box not inside leaf box`;
        }
      } else {
        if (ref >= bvh.nodeCount) return `child ref ${ref} out of range`;
        if (U[ref * NODE_WORDS + NODE_W.parent] !== node) return `node ${ref} parent link wrong`;
        for (let k = 0; k < 6; k++) ownBox[ref * 6 + k] = cb[k];
        stack.push(ref, d + 1);
      }
    }
  }
  if (maxD > maxDepth) return `depth ${maxD} > ${maxDepth}`;
  if (maxD !== bvh.maxDepth) return `reported depth ${bvh.maxDepth} ≠ ${maxD}`;
  for (let i = 0; i < bvh.nodeCount; i++) if (!visited[i]) return `orphan node ${i}`;
  for (let i = 0; i < n; i++) if (!seen[i]) return `primitive ${i} not referenced`;
  const perm = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const id = bvh.primIndex[i];
    if (id >= n || perm[id]) return `primIndex is not a permutation at ${i}`;
    perm[id] = 1;
  }
  if (U[NODE_W.parent] !== NODE_INVALID) return 'root parent is not NODE_INVALID';
  return null;
}
