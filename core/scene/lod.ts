/* ═══════════════════════════════════════════════════════════════════════════
   Tree LOD classification — pure port of js/world.js updateTreeLod.

   For every chunk (sector) of a LodSetDesc, each instance goes to level 0
   (d < near or `full`), 1 (d < mid) or 2, by its crown centre's distance to
   the camera in STATION space. Output goes into caller-owned arrays:

     out.counts[chunk * L + level]          number of instances on that level
     out.order[level * N + chunk.start + i] global instance index of the i-th
                                            instance of that chunk on that level
                                            (ascending, = legacy write order)

   with L = levels.length, N = instance count. A backend whose level meshes
   have the legacy layout (capacity N per level, per-chunk regions) copies
   matrices/colours with applyLod(). Legacy re-classified only after the
   camera moved by `step` — see lodNeedsUpdate().
   ═══════════════════════════════════════════════════════════════════════════ */

import type { LodSetDesc } from './types.ts';

export interface LodOut {
  counts: Uint32Array;
  order: Uint32Array;
}

/** Allocate output arrays sized for `lod`. */
export function createLodOut(lod: LodSetDesc): LodOut {
  const n = lod.matrices.length / 16;
  return { counts: new Uint32Array(lod.chunks.length * lod.levels.length), order: new Uint32Array(n * lod.levels.length) };
}

/** Classify every instance; cam = camera position in station space. Returns `out`. */
export function classifyLod(lod: LodSetDesc, cam: ArrayLike<number>, full: boolean, out: LodOut): LodOut {
  const near2 = lod.near * lod.near, mid2 = lod.mid * lod.mid;
  const cx = cam[0], cy = cam[1], cz = cam[2];
  const pts = lod.centers;
  const nL = lod.levels.length;
  const N = lod.matrices.length / 16;
  const { counts, order } = out;
  for (let c = 0; c < lod.chunks.length; c++) {
    const ch = lod.chunks[c];
    let a = 0, b = 0, d = 0;
    for (let k = ch.start; k < ch.start + ch.count; k++) {
      const dx = pts[k * 3] - cx, dy = pts[k * 3 + 1] - cy, dz = pts[k * 3 + 2] - cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (full || d2 < near2) order[ch.start + a++] = k;
      else if (d2 < mid2) order[N + ch.start + b++] = k;
      else order[2 * N + ch.start + d++] = k;
    }
    counts[c * nL] = a;
    counts[c * nL + 1] = b;
    counts[c * nL + 2] = d;
  }
  return out;
}

/**
 * Copy matrices/colours into per-level arrays with the legacy layout: level
 * `li`, chunk c occupies [chunk.start, chunk.start + counts[c, li]).
 */
export function applyLod(lod: LodSetDesc, res: LodOut, levelMatrices: Float32Array[], levelColors: Float32Array[]): void {
  const nL = lod.levels.length;
  const N = lod.matrices.length / 16;
  const M = lod.matrices, C = lod.colors;
  for (let c = 0; c < lod.chunks.length; c++) {
    const ch = lod.chunks[c];
    for (let li = 0; li < nL; li++) {
      const cnt = res.counts[c * nL + li];
      const mm = levelMatrices[li], cc = levelColors[li];
      for (let i = 0; i < cnt; i++) {
        const src = res.order[li * N + ch.start + i];
        const dst = ch.start + i;
        for (let j = 0; j < 16; j++) mm[dst * 16 + j] = M[src * 16 + j];
        cc[dst * 3] = C[src * 3]; cc[dst * 3 + 1] = C[src * 3 + 1]; cc[dst * 3 + 2] = C[src * 3 + 2];
      }
    }
  }
}

/** Legacy throttle: re-classify only when the camera moved at least `step` since `prev`. */
export function lodNeedsUpdate(prev: ArrayLike<number>, cam: ArrayLike<number>, step: number): boolean {
  const dx = cam[0] - prev[0], dy = cam[1] - prev[1], dz = cam[2] - prev[2];
  return !(dx * dx + dy * dy + dz * dz < step * step);
}
