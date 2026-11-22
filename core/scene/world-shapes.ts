/* ═══════════════════════════════════════════════════════════════════════════
   World-only shapes — ports of the geometry builders inside js/world.js:
   foliageGeo, crossQuadGeo, buildingGeo (+ roofUV), the trunk, tuft, decal,
   parked-car and traffic meshes, and the hull cylinder. Same primitives,
   same order of transforms, so the Float32 outputs match three r187.
   ═══════════════════════════════════════════════════════════════════════════ */

import { CORE_CONFIG } from '../config/index.ts';
import type { Rng } from '../rng.ts';
import { TAU } from '../math/scalar.ts';
import {
  computeVertexNormals, mergeMeshes, rotateX, rotateY, toNonIndexed, translate, type MeshData
} from '../geometry/mesh.ts';
import { facadeUV, rod, splitRoofGroups } from '../geometry/ops.ts';
import { cylinder } from '../geometry/primitives/cylinder.ts';
import { icosahedron } from '../geometry/primitives/icosahedron.ts';
import { plane } from '../geometry/primitives/plane.ts';
import { displaceHull, type Hill } from '../layout/hills.ts';

/** three r187 generator behaviour (CylinderGeometry apex) — the app runs r187. */
const COMPAT = 187;

/**
 * Crown / bush: icosahedron with every unique vertex pushed along its
 * direction by 1 ± wobble (dedup by 4-decimal key, rnd per NEW key in vertex
 * order), flat normals, then one lightness value per face (rnd per face).
 */
export function foliageGeo(detail: number, rnd: Rng, wobble: number, dither: number): MeshData {
  const g = icosahedron(1, detail);
  const p = g.position;
  const n = p.length / 3;
  const seen = new Map<string, number>();
  for (let k = 0; k < n; k++) {
    const x = p[3 * k], y = p[3 * k + 1], z = p[3 * k + 2];
    const key = x.toFixed(4) + ',' + y.toFixed(4) + ',' + z.toFixed(4);
    let s = seen.get(key);
    if (s === undefined) { s = 1 + (rnd() - 0.5) * 2 * wobble; seen.set(key, s); }
    p[3 * k] = x * s; p[3 * k + 1] = y * s; p[3 * k + 2] = z * s;
  }
  computeVertexNormals(g);
  const col = new Float32Array(n * 3);
  for (let f = 0; f < n; f += 3) {
    const v = 1 - dither / 2 + rnd() * dither;
    for (let k = 0; k < 3; k++) col.fill(v, (f + k) * 3, (f + k) * 3 + 3);
  }
  g.color = col;
  return g;
}

/** Far crown level: TREE_LOD.blades vertical quads around Y, white vertex colour. */
export function crossQuadGeo(): MeshData {
  const parts: MeshData[] = [];
  const N = CORE_CONFIG.TREE_LOD.blades;
  for (let k = 0; k < N; k++) {
    const g = plane(2, 2);
    translate(g, 0, CORE_CONFIG.TREE_LOD.lift, 0);
    rotateY(g, (k / N) * Math.PI);
    parts.push(g);
  }
  const merged = mergeMeshes(parts);
  merged.color = new Float32Array(merged.position.length).fill(1);
  return merged;
}

/** Roof faces (|ny| ≥ 0.7) get planar UVs at constant density (legacy roofUV). */
export function roofUV(m: MeshData, tile: number = CORE_CONFIG.ROOF_TILE): MeshData {
  const p = m.position, n = m.normal, uv = m.uv;
  const cnt = p.length / 3;
  for (let k = 0; k < cnt; k++) {
    if (Math.abs(n[3 * k + 1]) < 0.7) continue;
    uv[2 * k] = (p[3 * k] + 0.5) * tile;
    uv[2 * k + 1] = (p[3 * k + 2] + 0.5) * tile;
  }
  return m;
}

/** Building silhouette `type` (0..3) in a unit cube, base at y = −0.5; groups [walls, roof]. */
export function buildingGeo(type: number): MeshData {
  const S = CORE_CONFIG.BLD[type], T = CORE_CONFIG.FACADE_TILE;
  const W = (S.w[0] + S.w[1]) / 2;
  const parts: MeshData[] = [];
  const box = (w: number, h: number, d: number, x: number, y: number, z: number): MeshData =>
    facadeUV(rod(w, h, d, x, y, z), w * W / T);
  const cyl = (r: number, h: number, y: number, seg = 14): MeshData => {
    const g = cylinder(r, r, h, seg, 1, false, 0, Math.PI * 2, COMPAT);
    translate(g, 0, y + h / 2, 0);
    return facadeUV(g, 2 * Math.PI * r * W / T);
  };
  if (type === 0) {
    parts.push(box(1, 0.5, 1, 0, 0.25, 0));
    parts.push(box(0.74, 0.34, 0.74, 0, 0.67, 0));
    parts.push(box(0.46, 0.2, 0.46, 0, 0.94, 0));
    parts.push(box(0.1, 0.14, 0.1, 0.12, 1.07, 0.12));
  } else if (type === 1) {
    parts.push(box(1, 0.5, 1, 0, 0.25, 0));
    parts.push(box(1.12, 0.06, 1.12, 0, 0.53, 0));
    parts.push(cyl(0.3, 0.44, 0.56, 12));
    parts.push(box(0.06, 0.24, 0.06, 0.2, 1.12, -0.2));
  } else if (type === 2) {
    parts.push(cyl(0.5, 0.84, 0));
    parts.push(cyl(0.58, 0.06, 0.84));
    parts.push(cyl(0.26, 0.1, 0.9, 10));
  } else {
    parts.push(cyl(0.5, 0.56, 0, 18));
    parts.push(cyl(0.62, 0.07, 0.56, 18));
    parts.push(cyl(0.24, 0.37, 0.63, 12));
  }
  const g = splitRoofGroups(mergeMeshes(parts));
  translate(g, 0, -0.5, 0);
  return roofUV(g);
}

/** Trunk: tapered 6-sided cylinder with a vertex colour darkening towards the ground. */
export function trunkGeo(): MeshData {
  const g = cylinder(0.075, 0.13, 1, 6, 1, false, 0, Math.PI * 2, COMPAT);
  const tp = g.position;
  const n = tp.length / 3;
  const tc = new Float32Array(n * 3);
  for (let k = 0; k < n; k++) {
    const v = 0.34 + 0.66 * Math.min(1, Math.pow(tp[3 * k + 1] + 0.5, 0.55) * 1.15);
    tc.fill(v, k * 3, k * 3 + 3);
  }
  g.color = tc;
  return g;
}

/** Grass tuft: 7 tilted blades around the trunk, non-indexed blades re-indexed and merged. */
export function tuftGeo(): MeshData {
  const blades: MeshData[] = [];
  const nb = 7;
  for (let k = 0; k < nb; k++) {
    const a = (k / nb) * TAU + 0.4;
    const g0 = plane(0.16, 0.34);
    translate(g0, 0, 0.17, 0);
    rotateX(g0, -0.22);
    translate(g0, 0.2, 0, 0);
    rotateY(g0, a);
    const b = toNonIndexed(g0);
    const cnt = b.position.length / 3;
    const idx = new Uint16Array(cnt);
    for (let i = 0; i < cnt; i++) idx[i] = i;
    b.index = idx;
    blades.push(b);
  }
  return mergeMeshes(blades);
}

/** Unit decal quad lying in local XZ, normal +Y. */
export function decalGeo(): MeshData {
  const g = plane(1, 1);
  rotateX(g, -Math.PI / 2);
  return g;
}

/** Parked car body (two boxes). */
export function carBodyGeo(): MeshData {
  return mergeMeshes([
    rod(0.22, 0.1, 0.5, 0, 0.05, 0),
    rod(0.19, 0.09, 0.26, 0, 0.14, -0.02)
  ]);
}

/** Traffic car body (two boxes, CONFIG.TRAFFIC dimensions). */
export function trafficBodyGeo(): MeshData {
  const T2 = CORE_CONFIG.TRAFFIC;
  return mergeMeshes([
    rod(T2.w, T2.h * 0.62, T2.len, 0, T2.h * 0.31, 0),
    rod(T2.w * 0.86, T2.h * 0.5, T2.len * 0.52, 0, T2.h * 0.72, -T2.len * 0.04)
  ]);
}

/** Traffic lamps: group slot 0 = head lamps (front), slot 1 = tail lamps (rear). */
export function trafficLampGeo(): MeshData {
  const T2 = CORE_CONFIG.TRAFFIC;
  const front: MeshData[] = [], rear: MeshData[] = [];
  const addLamp = (list: MeshData[], x: number, z: number): void => {
    list.push(rod(T2.w * 0.24, T2.h * 0.2, 0.06, x, T2.h * 0.34, z));
  };
  addLamp(front, -T2.w * 0.32, T2.len * 0.5);
  addLamp(front, T2.w * 0.32, T2.len * 0.5);
  addLamp(rear, -T2.w * 0.32, -T2.len * 0.5);
  addLamp(rear, T2.w * 0.32, -T2.len * 0.5);
  const gF = mergeMeshes(front), gR = mergeMeshes(rear);
  const nF = (gF.index as Uint16Array).length;
  const lamp = mergeMeshes([gF, gR]);
  const total = (lamp.index as Uint16Array).length;
  lamp.groups = [{ start: 0, count: nF, slot: 0 }, { start: nF, count: total - nF, slot: 1 }];
  return lamp;
}

/**
 * The hull, emitted for viewing from INSIDE (no BackSide anywhere):
 *
 *  1. legacy steps: CylinderGeometry(R, R, L, segs, rings, open) along +Y,
 *     hill displacement, smooth normals, rotateX(90°) to lay it along Z;
 *  2. normals negated → they face the axis;
 *  3. every triangle's winding reversed (a, b, c) → (a, c, b) → CCW seen
 *     from inside, so side 'front' culls correctly;
 *  4. U un-mirrored: u' = 0.5 − u.
 *
 * UV mapping (documented contract): after step 1 a vertex built at cylinder
 * angle φ = u·2π sits at x = R·sin φ, y = −R·cos φ, so its station angle is
 * θ = atan2(x, y) = π − φ  ⇒  θ/2π = 0.5 − u. Legacy sampled the maps with
 * texture.repeat.x = −1, offset.x = 0.5, i.e. at (0.5 − u) — exactly u'.
 * Hence u' ≡ θ/2π (mod 1) and every backend samples the SAME texel legacy
 * did, with plain repeat wrapping and no texture transform. u' spans
 * [−0.5, 0.5]; with segs a power of two it is exact in Float32.
 * v = z/L + 0.5 is unchanged (v = 1 at z = +L/2).
 */
export function hullGeo(R: number, L: number, segs: number, rings: number, hills: readonly Hill[]): MeshData {
  const g = cylinder(R, R, L, segs, rings, true, 0, Math.PI * 2, COMPAT);
  displaceHull(g, hills, R);
  computeVertexNormals(g);
  rotateX(g, Math.PI / 2);
  const nrm = g.normal;
  for (let i = 0; i < nrm.length; i++) nrm[i] = -nrm[i];
  const idx = g.index as Uint16Array | Uint32Array;
  for (let i = 0; i < idx.length; i += 3) {
    const b = idx[i + 1];
    idx[i + 1] = idx[i + 2];
    idx[i + 2] = b;
  }
  const uv = g.uv;
  for (let i = 0; i < uv.length; i += 2) uv[i] = 0.5 - uv[i];
  return g;
}

/** Legacy uvSelfTest idea, for the baked hull: worst |u − θ/2π| (wrapped) over every 7th vertex. */
export function hullUvError(m: MeshData): number {
  const p = m.position, u = m.uv;
  let worst = 0;
  for (let k = 0; k < p.length / 3; k += 7) {
    let th = Math.atan2(p[3 * k], p[3 * k + 1]);
    if (th < 0) th += TAU;
    let uu = u[2 * k];
    uu -= Math.floor(uu);
    const d = Math.abs(uu - th / TAU);
    worst = Math.max(worst, Math.min(d, 1 - d));
  }
  return worst;
}
