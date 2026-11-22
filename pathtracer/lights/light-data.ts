/* ═══════════════════════════════════════════════════════════════════════════
   Emissive-triangle light list and its GPU buffer (PT-W4a).

   Light list (buildLightList): every instance whose batch has a meshEmission
   role and whose BLAS has emissive triangles (attr.light ≠ NO_LIGHT) gets a
   contiguous range of global light ids starting at its instance lightBase
   (scene-upload.ts writes lightBase into the instance record). Global id =
   inst.lightBase + attr.light; per light we keep the instance, the absolute
   triangle record and the WORLD-space vertices (dynamic instances: rebuild
   the list after updateDynamics).

   Light data buffer (one storage buffer `b5_ldata: array<vec4f>`, u32 fields
   bitcast; keeps k_shade within 9 storage buffers):
     row 0          u32 nLights, nNodes, nodeBase, lightBase   (bases in rows)
     row 1          u32 aliasBase, f32 totalPhi, u32 mode bits, u32 0
     nodes  (4 rows each, light-tree.ts):
       r0  bmin.xyz, phi           r1  bmax.xyz, cosO
       r2  w.xyz, cosE             r3  u32 child0, child1, parent, flags
       (leaf: child0 = light id, flags & LNODE_LEAF)
     lights (3 rows each):
       r0  v0.xyz, u32 instance    r1  v1.xyz, u32 triangle record
       r2  v2.xyz, u32 leaf node (NO_NODE: zero power, never sampled)
     alias  (1 row each): f32 q, u32 alias, f32 pmf, f32 world area
   ═══════════════════════════════════════════════════════════════════════════ */

import { INST_W, INST_WORDS, NO_LIGHT, TRI_W, TRI_WORDS } from '../bvh/layout.ts';
import { buildAlias } from './alias.ts';
import { LNODE_LEAF, LNODE_TWO_SIDED, NO_NODE, buildLightTree, triangleBounds, type LightTree } from './light-tree.ts';

export const LDATA_HEADER_ROWS = 2;
export const LNODE_ROWS = 4;
export const LIGHT_ROWS = 3;
export const ALIAS_ROWS = 1;

/** The light list (CPU): world vertices per light and their origin. */
export interface LightList {
  count: number;
  /** 9 floats per light: v0, v1, v2 (world) */
  verts: Float32Array;
  inst: Uint32Array;
  tri: Uint32Array;
  /** world area per light */
  area: Float32Array;
}

export interface LightListSource {
  /** packed instance records (bvh layout) */
  instances: ArrayBuffer;
  /** packed triangle records */
  tris: ArrayBuffer;
  /** triangle attribute buffer (scene-upload.ts, ATTR_WORDS per record) */
  attrs: ArrayBuffer;
  attrWords: number;
  attrLightWord: number;
  /** objectToWorld per instance (column-major 16), instance order */
  objectToWorld(instance: number, out: Float32Array): void;
  instanceBlas: Uint32Array;
  blasTriBase: Uint32Array;
  blasTriCount: Uint32Array;
}

/** Collect the lights: instances with a lightBase, their BLAS's emissive records. */
export function buildLightList(src: LightListSource): LightList {
  const IU = new Uint32Array(src.instances), TF = new Float32Array(src.tris);
  const AU = new Uint32Array(src.attrs);
  const nInst = IU.length / INST_WORDS;
  /* emissive records per BLAS, in local light order */
  const perBlas = new Map<number, number[]>();
  const recsOf = (b: number): number[] => {
    let r = perBlas.get(b);
    if (r) return r;
    r = [];
    const base = src.blasTriBase[b];
    for (let i = 0; i < src.blasTriCount[b]; i++) {
      const l = AU[(base + i) * src.attrWords + src.attrLightWord];
      if (l !== NO_LIGHT) r[l] = base + i;
    }
    perBlas.set(b, r);
    return r;
  };
  let count = 0;
  const ranges: [number, number, number[]][] = [];
  for (let k = 0; k < nInst; k++) {
    const lb = IU[k * INST_WORDS + INST_W.flagsLight] & 0xffffff;
    if (lb === NO_LIGHT) continue;
    const recs = recsOf(src.instanceBlas[k]);
    if (!recs.length) continue;
    ranges.push([k, lb, recs]);
    count = Math.max(count, lb + recs.length);
  }
  const verts = new Float32Array(count * 9), inst = new Uint32Array(count).fill(0xffffffff), tri = new Uint32Array(count);
  const area = new Float32Array(count);
  const M = new Float32Array(16);
  for (const [k, lb, recs] of ranges) {
    src.objectToWorld(k, M);
    for (let j = 0; j < recs.length; j++) {
      const id = lb + j, rec = recs[j], w = rec * TRI_WORDS;
      inst[id] = k;
      tri[id] = rec;
      for (let v = 0; v < 3; v++) {
        const o = w + (v === 0 ? TRI_W.v0 : v === 1 ? TRI_W.v1 : TRI_W.v2);
        const x = TF[o], y = TF[o + 1], z = TF[o + 2];
        verts[id * 9 + v * 3] = M[0] * x + M[4] * y + M[8] * z + M[12];
        verts[id * 9 + v * 3 + 1] = M[1] * x + M[5] * y + M[9] * z + M[13];
        verts[id * 9 + v * 3 + 2] = M[2] * x + M[6] * y + M[10] * z + M[14];
      }
      const a = verts.subarray(id * 9, id * 9 + 9);
      const e1 = [a[3] - a[0], a[4] - a[1], a[5] - a[2]], e2 = [a[6] - a[0], a[7] - a[1], a[8] - a[2]];
      area[id] = 0.5 * Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]);
    }
  }
  return { count, verts, inst, tri, area };
}

/** Everything the GPU needs, packed (light-tree + alias + light records). */
export interface PackedLights {
  data: ArrayBuffer;
  tree: LightTree;
  nLights: number;
  nNodes: number;
  totalPhi: number;
  /** lights with phi > 0 */
  active: number;
  buildMs: number;
}

/** Build tree + alias over per-light power `phi` and pack the buffer (pure, worker-safe). */
export function packLights(list: Pick<LightList, 'count' | 'verts' | 'inst' | 'tri' | 'area'>, phi: ArrayLike<number>): PackedLights {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const n = list.count;
  const bounds = Array.from({ length: n }, (_, i) => {
    const v = list.verts.subarray(i * 9, i * 9 + 9);
    const ok = list.inst[i] !== 0xffffffff && phi[i] > 0 && Number.isFinite(phi[i]);
    return triangleBounds(v.subarray(0, 3), v.subarray(3, 6), v.subarray(6, 9), ok ? phi[i] : 0);
  });
  const tree = buildLightTree(bounds);
  const alias = buildAlias(bounds.map((b) => b.phi));
  const nNodes = tree.nodes.length;
  const nodeBase = LDATA_HEADER_ROWS;
  const lightBase = nodeBase + nNodes * LNODE_ROWS;
  const aliasBase = lightBase + n * LIGHT_ROWS;
  const rows = Math.max(aliasBase + n * ALIAS_ROWS, LDATA_HEADER_ROWS + 1);
  const data = new ArrayBuffer(rows * 16);
  const F = new Float32Array(data), U = new Uint32Array(data);
  U[0] = n; U[1] = nNodes; U[2] = nodeBase; U[3] = lightBase;
  U[4] = aliasBase; F[5] = alias.total; U[6] = 0; U[7] = 0;
  tree.nodes.forEach((nd, i) => {
    const w = (nodeBase + i * LNODE_ROWS) * 4;
    F.set(nd.bmin, w); F[w + 3] = nd.phi;
    F.set(nd.bmax, w + 4); F[w + 7] = nd.cosO;
    F.set(nd.w, w + 8); F[w + 11] = nd.cosE;
    U[w + 12] = nd.child0; U[w + 13] = nd.child1; U[w + 14] = nd.parent;
    U[w + 15] = (nd.twoSided ? LNODE_TWO_SIDED : 0) | (nd.leaf ? LNODE_LEAF : 0);
  });
  let active = 0;
  for (let i = 0; i < n; i++) {
    const w = (lightBase + i * LIGHT_ROWS) * 4;
    F.set(list.verts.subarray(i * 9, i * 9 + 3), w); U[w + 3] = list.inst[i];
    F.set(list.verts.subarray(i * 9 + 3, i * 9 + 6), w + 4); U[w + 7] = list.tri[i];
    F.set(list.verts.subarray(i * 9 + 6, i * 9 + 9), w + 8); U[w + 11] = tree.leafOf[i];
    if (tree.leafOf[i] !== NO_NODE) active++;
    const a = (aliasBase + i) * 4;
    F[a] = alias.q[i]; U[a + 1] = alias.alias[i]; F[a + 2] = alias.pmf[i]; F[a + 3] = list.area[i];
  }
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return { data, tree, nLights: n, nNodes, totalPhi: alias.total, active, buildMs: t1 - t0 };
}

/** WGSL constants of the layout (generated include). */
export function emitWgslLights(): string {
  return [
    '// generated by pathtracer/lights/light-data.ts — do not edit',
    `const B5_LNODE_ROWS: u32 = ${LNODE_ROWS}u;`,
    `const B5_LIGHT_ROWS: u32 = ${LIGHT_ROWS}u;`,
    `const B5_LNODE_TWO_SIDED: u32 = ${LNODE_TWO_SIDED}u;`,
    `const B5_LNODE_LEAF: u32 = ${LNODE_LEAF}u;`,
    `const B5_NO_NODE: u32 = 0x${NO_NODE.toString(16)}u;`,
    ''
  ].join('\n');
}
