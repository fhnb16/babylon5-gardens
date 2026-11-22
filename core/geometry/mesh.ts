/* ═══════════════════════════════════════════════════════════════════════════
   MeshData — plain, structured-clone-able triangle mesh. Field names match
   scene/types.ts GeometryDesc (position / normal / uv / color / index /
   groups), so a MeshData plus `bounds` IS a GeometryDesc (see toGeometryDesc).

   Operations mutate in place and return the same mesh (like THREE
   BufferGeometry), except toNonIndexed / mergeMeshes which build new data.
   Arithmetic follows THREE r165 BufferGeometry: maths in doubles, results
   stored into Float32Array, so outputs match three bit-for-bit.
   ═══════════════════════════════════════════════════════════════════════════ */

import type { GeometryDesc, GeometryGroup, V3 } from '../scene/types.ts';
import type { Mat4 } from '../math/mat4.ts';
import * as m4 from '../math/mat4.ts';

export interface MeshData {
  position: Float32Array;          // xyz
  normal: Float32Array;            // xyz
  uv: Float32Array;                // uv
  color?: Float32Array;            // rgb, linear
  index?: Uint16Array | Uint32Array;
  groups: GeometryGroup[];
}

/** Which three.js generator behaviour to reproduce where r165 and r187 differ (cylinder apex, lathe last normal). */
export type ThreeCompat = 165 | 187;

export interface Bounds { center: V3; radius: number; min: V3; max: V3 }

/** THREE.BufferGeometry.setIndex rule: Uint32 as soon as any index >= 65535, else Uint16. */
export function makeIndex(indices: ArrayLike<number>): Uint16Array | Uint32Array {
  let wide = false;
  for (let i = indices.length - 1; i >= 0; --i) {
    if (indices[i] >= 65535) { wide = true; break; }
  }
  const out = wide ? new Uint32Array(indices.length) : new Uint16Array(indices.length);
  for (let i = 0; i < indices.length; i++) out[i] = indices[i];
  return out;
}

/** Number of vertices. */
export const vertexCount = (m: MeshData): number => m.position.length / 3;

/** Bounding box + sphere exactly like THREE (centre of the box, max distance to it). */
export function computeBounds(m: MeshData): Bounds {
  const p = m.position;
  const n = p.length / 3;
  if (n === 0) return { center: [0, 0, 0], radius: 0, min: [0, 0, 0], max: [0, 0, 0] };
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = p[3 * i], y = p[3 * i + 1], z = p[3 * i + 2];
    if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
  }
  const cx = (minX + maxX) * 0.5, cy = (minY + maxY) * 0.5, cz = (minZ + maxZ) * 0.5;
  let r2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = cx - p[3 * i], dy = cy - p[3 * i + 1], dz = cz - p[3 * i + 2];
    r2 = Math.max(r2, dx * dx + dy * dy + dz * dz);
  }
  return { center: [cx, cy, cz], radius: Math.sqrt(r2), min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

/** MeshData → GeometryDesc (adds bounds). Arrays are shared, not copied. */
export function toGeometryDesc(m: MeshData): GeometryDesc {
  const d: GeometryDesc = {
    position: m.position,
    normal: m.normal,
    uv: m.uv,
    groups: m.groups.map(g => ({ start: g.start, count: g.count, slot: g.slot })),
    bounds: computeBounds(m)
  };
  if (m.color) d.color = m.color;
  if (m.index) d.index = m.index;
  return d;
}

/**
 * Transform positions by `mat` (with w-divide) and normals by the normal
 * matrix (re-normalized). Same as BufferGeometry.applyMatrix4.
 */
export function applyMatrix4(m: MeshData, mat: Mat4): MeshData {
  const p = m.position;
  const e = mat;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    const w = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15]);
    p[i] = (e[0] * x + e[4] * y + e[8] * z + e[12]) * w;
    p[i + 1] = (e[1] * x + e[5] * y + e[9] * z + e[13]) * w;
    p[i + 2] = (e[2] * x + e[6] * y + e[10] * z + e[14]) * w;
  }
  const nrm = m.normal;
  if (nrm.length) {
    const nm = m4.normalMatrix(mat);
    for (let i = 0; i < nrm.length; i += 3) {
      const x = nrm[i], y = nrm[i + 1], z = nrm[i + 2];
      const rx = nm[0] * x + nm[3] * y + nm[6] * z;
      const ry = nm[1] * x + nm[4] * y + nm[7] * z;
      const rz = nm[2] * x + nm[5] * y + nm[8] * z;
      const k = 1 / (Math.sqrt(rx * rx + ry * ry + rz * rz) || 1);
      nrm[i] = rx * k; nrm[i + 1] = ry * k; nrm[i + 2] = rz * k;
    }
  }
  return m;
}

export const translate = (m: MeshData, x: number, y: number, z: number): MeshData =>
  applyMatrix4(m, m4.makeTranslation(x, y, z));
export const rotateX = (m: MeshData, angle: number): MeshData => applyMatrix4(m, m4.makeRotationX(angle));
export const rotateY = (m: MeshData, angle: number): MeshData => applyMatrix4(m, m4.makeRotationY(angle));
export const rotateZ = (m: MeshData, angle: number): MeshData => applyMatrix4(m, m4.makeRotationZ(angle));
export const scale = (m: MeshData, x: number, y: number, z: number): MeshData =>
  applyMatrix4(m, m4.makeScale(x, y, z));

/** Re-normalize every normal in place (BufferGeometry.normalizeNormals). */
export function normalizeNormals(m: MeshData): MeshData {
  const n = m.normal;
  for (let i = 0; i < n.length; i += 3) {
    const x = n[i], y = n[i + 1], z = n[i + 2];
    const k = 1 / (Math.sqrt(x * x + y * y + z * z) || 1);
    n[i] = x * k; n[i + 1] = y * k; n[i + 2] = z * k;
  }
  return m;
}

/**
 * Port of BufferGeometry.computeVertexNormals (r165).
 *  - indexed: area-weighted smooth normals, accumulated per shared vertex;
 *  - non-indexed: flat face normals (each triangle's 3 vertices get the face normal).
 * Accumulation happens in the Float32 normal array (rounding per step, as THREE).
 */
export function computeVertexNormals(m: MeshData): MeshData {
  const pos = m.position, nrm = m.normal, index = m.index;
  if (nrm.length !== pos.length) throw new Error('computeVertexNormals: normal array size mismatch');
  nrm.fill(0);

  if (index) {
    for (let i = 0, il = index.length; i < il; i += 3) {
      const vA = index[i] * 3, vB = index[i + 1] * 3, vC = index[i + 2] * 3;
      // cb = (pC - pB) x (pA - pB)
      const cbx0 = pos[vC] - pos[vB], cby0 = pos[vC + 1] - pos[vB + 1], cbz0 = pos[vC + 2] - pos[vB + 2];
      const abx = pos[vA] - pos[vB], aby = pos[vA + 1] - pos[vB + 1], abz = pos[vA + 2] - pos[vB + 2];
      const cx = cby0 * abz - cbz0 * aby;
      const cy = cbz0 * abx - cbx0 * abz;
      const cz = cbx0 * aby - cby0 * abx;
      nrm[vA] += cx; nrm[vA + 1] += cy; nrm[vA + 2] += cz;
      nrm[vB] += cx; nrm[vB + 1] += cy; nrm[vB + 2] += cz;
      nrm[vC] += cx; nrm[vC + 1] += cy; nrm[vC + 2] += cz;
    }
  } else {
    for (let i = 0, il = pos.length / 3; i < il; i += 3) {
      const a = i * 3, b = a + 3, c = a + 6;
      const cbx0 = pos[c] - pos[b], cby0 = pos[c + 1] - pos[b + 1], cbz0 = pos[c + 2] - pos[b + 2];
      const abx = pos[a] - pos[b], aby = pos[a + 1] - pos[b + 1], abz = pos[a + 2] - pos[b + 2];
      const cx = cby0 * abz - cbz0 * aby;
      const cy = cbz0 * abx - cbx0 * abz;
      const cz = cbx0 * aby - cby0 * abx;
      nrm[a] = cx; nrm[a + 1] = cy; nrm[a + 2] = cz;
      nrm[b] = cx; nrm[b + 1] = cy; nrm[b + 2] = cz;
      nrm[c] = cx; nrm[c + 1] = cy; nrm[c + 2] = cz;
    }
  }
  return normalizeNormals(m);
}

/**
 * Expand an indexed mesh into a triangle soup (BufferGeometry.toNonIndexed).
 * Groups are copied unchanged (their start/count already refer to index
 * positions == vertex positions of the result). Non-indexed input is returned as is.
 */
export function toNonIndexed(m: MeshData): MeshData {
  const idx = m.index;
  if (!idx) return m;
  const n = idx.length;
  const expand = (src: Float32Array, size: number): Float32Array => {
    const out = new Float32Array(n * size);
    let o = 0;
    for (let i = 0; i < n; i++) {
      let s = idx[i] * size;
      for (let j = 0; j < size; j++) out[o++] = src[s++];
    }
    return out;
  };
  const out: MeshData = {
    position: expand(m.position, 3),
    normal: expand(m.normal, 3),
    uv: expand(m.uv, 2),
    groups: m.groups.map(g => ({ start: g.start, count: g.count, slot: g.slot }))
  };
  if (m.color) out.color = expand(m.color, 3);
  return out;
}

export interface MergeOptions {
  /** Emit one group per input mesh (slot = its list position). Default false: no groups, like legacy mergeGeos. */
  groupPerMesh?: boolean;
}

/**
 * Port of js/util.js `mergeGeos`. Inputs must be indexed. Output layout is
 * identical: position/normal/uv always present (missing attributes stay
 * zero), Uint32 index when the merged vertex count exceeds 65535 else Uint16,
 * and — like the legacy function — no groups (initial groups are dropped)
 * unless `groupPerMesh` is set. Vertex colours are carried only if at least
 * one input has them (missing ones become white). Inputs are not modified
 * (legacy also disposed them; there is nothing to dispose here).
 */
export function mergeMeshes(list: readonly MeshData[], opts: MergeOptions = {}): MeshData {
  let vc = 0, ic = 0, anyColor = false;
  for (const g of list) {
    if (!g.index) throw new Error('mergeMeshes: indexed geometry required');
    vc += g.position.length / 3; ic += g.index.length;
    if (g.color) anyColor = true;
  }
  const pos = new Float32Array(vc * 3), nor = new Float32Array(vc * 3), uv = new Float32Array(vc * 2);
  const col = anyColor ? new Float32Array(vc * 3) : undefined;
  const idx = vc > 65535 ? new Uint32Array(ic) : new Uint16Array(ic);
  const groups: GeometryGroup[] = [];
  let vo = 0, io = 0, slot = 0;
  for (const g of list) {
    const x = g.index as Uint16Array | Uint32Array;
    const cnt = g.position.length / 3;
    pos.set(g.position, vo * 3);
    if (g.normal.length) nor.set(g.normal, vo * 3);
    if (g.uv.length) uv.set(g.uv, vo * 2);
    if (col) {
      if (g.color) col.set(g.color, vo * 3);
      else col.fill(1, vo * 3, (vo + cnt) * 3);
    }
    for (let i = 0; i < x.length; i++) idx[io + i] = x[i] + vo;
    if (opts.groupPerMesh) groups.push({ start: io, count: x.length, slot });
    slot++;
    vo += cnt; io += x.length;
  }
  const out: MeshData = { position: pos, normal: nor, uv, index: idx, groups };
  if (col) out.color = col;
  return out;
}
