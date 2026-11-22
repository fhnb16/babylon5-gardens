/* ═══════════════════════════════════════════════════════════════════════════
   TLAS: instances → world AABBs → BVH2 with one instance per leaf.

   Everything lives in the station frame (station rotation is a rigid root
   transform applied to rays/camera), so the static TLAS is built once per
   world; only the dynamic part (traffic, lifts) is rebuilt when matrices
   change. Static and dynamic instances get separate trees (two roots); pack.ts
   joins them under a small merge node.

   Matrices are column-major Float32Array(16) (SceneDesc convention).
   ═══════════════════════════════════════════════════════════════════════════ */

import { buildBvhFromBoxes, type BuildOptions, type Bvh2 } from './builder.ts';
import { EMPTY_BOX_COORD, TLAS_MAX_DEPTH } from './layout.ts';

/**
 * Relative padding of instance world boxes. The traversal sees the geometry
 * through the f32 worldToObject inverse, which differs from objectToWorld by
 * a few ulps; the pad keeps every hit inside its TLAS leaf box.
 */
export const INSTANCE_BOX_PAD = 2 ** -18;

/**
 * Transform an AABB (box[bo..bo+6]) by a column-major affine matrix
 * (m[mo..mo+16]) and write the exact bounds of its 8 transformed corners
 * (Arvo's per-axis min/max form, identical to transforming the corners),
 * padded by INSTANCE_BOX_PAD. Empty input → EMPTY box.
 */
export function transformAabb(
  box: ArrayLike<number>, bo: number,
  m: ArrayLike<number>, mo: number,
  out: Float32Array, oo: number
): void {
  if (!(box[bo] <= box[bo + 3]) || box[bo] === EMPTY_BOX_COORD) {
    out[oo] = out[oo + 1] = out[oo + 2] = EMPTY_BOX_COORD;
    out[oo + 3] = out[oo + 4] = out[oo + 5] = -EMPTY_BOX_COORD;
    return;
  }
  for (let r = 0; r < 3; r++) {
    let lo = m[mo + 12 + r], hi = lo;
    for (let c = 0; c < 3; c++) {
      const a = m[mo + c * 4 + r];
      const e0 = a * box[bo + c], e1 = a * box[bo + 3 + c];
      if (e0 < e1) { lo += e0; hi += e1; } else { lo += e1; hi += e0; }
    }
    const pad = (Math.max(Math.abs(lo), Math.abs(hi)) + (hi - lo)) * INSTANCE_BOX_PAD;
    out[oo + r] = Math.fround(lo - pad);
    out[oo + 3 + r] = Math.fround(hi + pad);
    // fround may round inward; step one ulp outward if it did
    if (out[oo + r] > lo - pad) out[oo + r] = nextDown(out[oo + r]);
    if (out[oo + 3 + r] < hi + pad) out[oo + 3 + r] = nextUp(out[oo + 3 + r]);
  }
}

const f32b = new Float32Array(1);
const u32b = new Uint32Array(f32b.buffer);
function nextUp(x: number): number {
  f32b[0] = x;
  if (x === 0) { u32b[0] = 1; return f32b[0]; }
  u32b[0] += x > 0 ? 1 : -1;
  return f32b[0];
}
function nextDown(x: number): number {
  return -nextUp(-x);
}

/**
 * Affine inverse of a column-major 4×4 (upper 3×4 used), written as 3 rows
 * of 4 floats (worldToObject rows, layout.ts INST w2o0..2). Computed in f64.
 * Returns the determinant of the 3×3 part (0 ⇒ singular; rows are zeroed).
 */
export function affineInverseRows(m: ArrayLike<number>, mo: number, out: Float32Array, oo: number): number {
  const a00 = m[mo], a10 = m[mo + 1], a20 = m[mo + 2];
  const a01 = m[mo + 4], a11 = m[mo + 5], a21 = m[mo + 6];
  const a02 = m[mo + 8], a12 = m[mo + 9], a22 = m[mo + 10];
  const tx = m[mo + 12], ty = m[mo + 13], tz = m[mo + 14];
  const c00 = a11 * a22 - a12 * a21, c01 = a02 * a21 - a01 * a22, c02 = a01 * a12 - a02 * a11;
  const c10 = a12 * a20 - a10 * a22, c11 = a00 * a22 - a02 * a20, c12 = a02 * a10 - a00 * a12;
  const c20 = a10 * a21 - a11 * a20, c21 = a01 * a20 - a00 * a21, c22 = a00 * a11 - a01 * a10;
  const det = a00 * c00 + a01 * c10 + a02 * c20;
  if (!(Math.abs(det) > 1e-30) || !Number.isFinite(det)) {
    out.fill(0, oo, oo + 12);
    return 0;
  }
  const k = 1 / det;
  const i00 = c00 * k, i01 = c01 * k, i02 = c02 * k;
  const i10 = c10 * k, i11 = c11 * k, i12 = c12 * k;
  const i20 = c20 * k, i21 = c21 * k, i22 = c22 * k;
  out[oo] = i00; out[oo + 1] = i01; out[oo + 2] = i02; out[oo + 3] = -(i00 * tx + i01 * ty + i02 * tz);
  out[oo + 4] = i10; out[oo + 5] = i11; out[oo + 6] = i12; out[oo + 7] = -(i10 * tx + i11 * ty + i12 * tz);
  out[oo + 8] = i20; out[oo + 9] = i21; out[oo + 10] = i22; out[oo + 11] = -(i20 * tx + i21 * ty + i22 * tz);
  return det;
}

/**
 * World AABBs of `count` instances.
 * @param blasBounds 6 floats per BLAS (Bvh2.bounds / PackedBlas.bounds)
 * @param blas BLAS id per instance, or one id for all
 * @param matrices 16 floats per instance, column-major objectToWorld
 * @param out optional destination (6 * count)
 */
export function instanceWorldBounds(
  blasBounds: ArrayLike<number>,
  blas: ArrayLike<number> | number,
  matrices: ArrayLike<number>,
  count: number,
  out?: Float32Array
): Float32Array {
  const o = out && out.length >= count * 6 ? out : new Float32Array(count * 6);
  for (let i = 0; i < count; i++) {
    const b = typeof blas === 'number' ? blas : blas[i];
    transformAabb(blasBounds, b * 6, matrices, i * 16, o, i * 6);
    // singular matrices: the instance is invisible (pack zeroes its mask) → empty box
    const m = i * 16;
    const det =
      matrices[m] * (matrices[m + 5] * matrices[m + 10] - matrices[m + 9] * matrices[m + 6]) -
      matrices[m + 4] * (matrices[m + 1] * matrices[m + 10] - matrices[m + 9] * matrices[m + 2]) +
      matrices[m + 8] * (matrices[m + 1] * matrices[m + 6] - matrices[m + 5] * matrices[m + 2]);
    if (!(Math.abs(det) > 1e-30) || !Number.isFinite(det)) {
      o[i * 6] = o[i * 6 + 1] = o[i * 6 + 2] = EMPTY_BOX_COORD;
      o[i * 6 + 3] = o[i * 6 + 4] = o[i * 6 + 5] = -EMPTY_BOX_COORD;
    }
  }
  return o;
}

/**
 * TLAS over instance world boxes: binned SAH, one instance per leaf, leaves
 * reference the instance index directly (+ instanceBase, the index of the
 * first instance of this tree in the instance buffer).
 * Default depth limit TLAS_MAX_DEPTH − 1, leaving one level for the merge node.
 */
export function buildTlas(
  worldBoxes: Float32Array,
  instanceBase = 0,
  opts: BuildOptions = {}
): Bvh2 {
  return buildBvhFromBoxes(worldBoxes, {
    bins: 32,
    maxDepth: TLAS_MAX_DEPTH - 1,
    ...opts,
    maxLeaf: 1,
    directLeaves: true,
    leafIdBase: instanceBase
  });
}

/** Number of nodes a TLAS over n instances occupies (fixed ⇒ the dynamic region can be rewritten in place). */
export function tlasNodeCount(n: number): number {
  return Math.max(1, n - 1);
}
