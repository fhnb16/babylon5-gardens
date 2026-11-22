/* Ports of the geometry helpers in js/util.js (rod, facadeUV, splitRoofGroups,
   panelUV) onto MeshData. Same maths and same order of operations. */

import type { MeshData } from './mesh.ts';
import { rotateX, rotateY, rotateZ, translate } from './mesh.ts';
import { box } from './primitives/box.ts';

/** Box with its long side along local Y, rotated (order: X, Z, Y — as legacy) and translated. */
export function rod(
  w: number, h: number, d: number, x: number, y: number, z: number,
  rx = 0, ry = 0, rz = 0
): MeshData {
  const g = box(w, h, d);
  if (rx) rotateX(g, rx);
  if (rz) rotateZ(g, rz);
  if (ry) rotateY(g, ry);
  translate(g, x, y, z);
  return g;
}

/** U scaled by `uScale`, V taken from the vertex height (Y). */
export function facadeUV(m: MeshData, uScale: number): MeshData {
  const uv = m.uv, p = m.position;
  for (let k = 0; k < uv.length / 2; k++) {
    uv[2 * k] = uv[2 * k] * uScale;
    uv[2 * k + 1] = p[3 * k + 1];
  }
  return m;
}

/**
 * Reorder triangles so walls (group slot 0) come first and near-horizontal
 * faces (|ny| avg > 0.7, group slot 1 = roof) follow. Replaces the index with
 * a Uint32Array like legacy; returns `m` untouched if either part is empty.
 */
export function splitRoofGroups(m: MeshData): MeshData {
  const n = m.normal;
  const idx = m.index;
  const count = idx ? idx.length : m.position.length / 3;
  const get = (k: number): number => (idx ? idx[k] : k);

  const walls: number[] = [], roofs: number[] = [];
  for (let t = 0; t < count; t += 3) {
    const ny = Math.abs(n[3 * get(t) + 1]) + Math.abs(n[3 * get(t + 1) + 1]) + Math.abs(n[3 * get(t + 2) + 1]);
    (ny / 3 > 0.7 ? roofs : walls).push(t);
  }
  if (!roofs.length || !walls.length) return m;

  const order = new Uint32Array(count);
  let w = 0;
  for (const t of walls) { order[w++] = get(t); order[w++] = get(t + 1); order[w++] = get(t + 2); }
  const wallCount = w;
  for (const t of roofs) { order[w++] = get(t); order[w++] = get(t + 1); order[w++] = get(t + 2); }

  m.index = order;
  m.groups = [
    { start: 0, count: wallCount, slot: 0 },
    { start: wallCount, count: count - wallCount, slot: 1 }
  ];
  return m;
}

/** Panel UV by world position, projected along the dominant normal axis (tile = world units per UV unit). */
export function panelUV(m: MeshData, tile: number, sy = 1): MeshData {
  const p = m.position, n = m.normal, uv = m.uv;
  const cnt = p.length / 3;
  for (let k = 0; k < cnt; k++) {
    const nx = Math.abs(n[3 * k]), ny = Math.abs(n[3 * k + 1]), nz = Math.abs(n[3 * k + 2]);
    let a: number, b: number;
    if (nx >= ny && nx >= nz) { a = p[3 * k + 2]; b = p[3 * k + 1] * sy; }
    else if (ny >= nz) { a = p[3 * k]; b = p[3 * k + 2]; }
    else { a = p[3 * k]; b = p[3 * k + 1] * sy; }
    uv[2 * k] = a / tile;
    uv[2 * k + 1] = b / tile;
  }
  return m;
}
