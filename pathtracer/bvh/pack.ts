/* ═══════════════════════════════════════════════════════════════════════════
   Packing: builder output → GPU ArrayBuffers in the layouts of layout.ts.

   Per geometry: PackedBlas = nodes (local refs) + triangles gathered in leaf
   order. Per scene: packScene concatenates all BLAS into ONE node buffer and
   ONE triangle buffer (references relocated to absolute indices), appends the
   TLAS and writes the instance records:

     nodes     : [ BLAS 0 | BLAS 1 | … | merge* | TLAS static | TLAS dynamic* ]
     tris      : [ BLAS 0 tris | BLAS 1 tris | … ]
     instances : [ static instances (batch order) | dynamic instances ]
     (* only when there are dynamic instances; the merge node's children are
        the static and the dynamic TLAS roots, so traversal has one entry
        point `tlasRoot` either way)

   The dynamic TLAS always has max(1, n−1) nodes, so updateDynamic() rewrites
   its region (plus the merge node and the dynamic instance records) in place
   and reports the byte ranges to re-upload.
   ═══════════════════════════════════════════════════════════════════════════ */

import { buildBlas, type BuildOptions, type Bvh2 } from './builder.ts';
import {
  EMPTY_BOX_COORD, EMPTY_LEAF, INST_DYNAMIC, INST_FLAGS_SHIFT, INST_LIGHT_MASK, INST_W, INST_WORDS,
  INST_BYTES, NODE_BYTES, NODE_INVALID, NODE_W, NODE_WORDS, NO_LIGHT, TRI_BYTES, TRI_W, TRI_WORDS,
  VIS_ALL, encodeRgb9e5, isLeaf, leafCount, leafOffset, makeLeaf
} from './layout.ts';
import { affineInverseRows, buildTlas, instanceWorldBounds, tlasNodeCount } from './tlas.ts';

export interface PackedBlas {
  /** nodeCount × 64 B, local refs (root = node 0, leaf offsets into `tris`) */
  nodes: ArrayBuffer;
  nodeCount: number;
  /** triCount × 48 B, leaf order */
  tris: ArrayBuffer;
  triCount: number;
  /** root bounds (6 floats) */
  bounds: Float32Array;
  maxDepth: number;
  leafCount: number;
}

/** Same shape as core GeometryGroup (start/count in index units, or vertices if non-indexed). */
export interface GroupLike {
  start: number;
  count: number;
  slot: number;
}

export interface BlasBuildOptions extends BuildOptions {
  groups?: GroupLike[];
}

/** Material slot per triangle from geometry groups (null when there are no groups). */
export function triangleSlots(triCount: number, groups?: GroupLike[] | null): Uint32Array | null {
  if (!groups || groups.length === 0) return null;
  const s = new Uint32Array(triCount);
  for (const g of groups) {
    const t0 = Math.max(0, Math.floor(g.start / 3));
    const t1 = Math.min(triCount, Math.floor((g.start + g.count) / 3));
    for (let t = t0; t < t1; t++) s[t] = g.slot;
  }
  return s;
}

/** Gather triangles in leaf order into 48-byte records. */
export function packTriangles(
  positions: Float32Array,
  index: Uint16Array | Uint32Array | null | undefined,
  primIndex: Uint32Array,
  slots?: Uint32Array | null
): ArrayBuffer {
  const n = primIndex.length;
  const buf = new ArrayBuffer(n * TRI_BYTES);
  const F = new Float32Array(buf);
  const U = new Uint32Array(buf);
  const p = positions;
  for (let i = 0; i < n; i++) {
    const t = primIndex[i];
    let a: number, b: number, c: number;
    if (index) { a = index[t * 3] * 3; b = index[t * 3 + 1] * 3; c = index[t * 3 + 2] * 3; }
    else { a = t * 9; b = a + 3; c = a + 6; }
    const w = i * TRI_WORDS;
    F[w + TRI_W.v0] = p[a]; F[w + TRI_W.v0 + 1] = p[a + 1]; F[w + TRI_W.v0 + 2] = p[a + 2];
    U[w + TRI_W.primId] = t;
    F[w + TRI_W.v1] = p[b]; F[w + TRI_W.v1 + 1] = p[b + 1]; F[w + TRI_W.v1 + 2] = p[b + 2];
    U[w + TRI_W.slot] = slots ? slots[t] : 0;
    F[w + TRI_W.v2] = p[c]; F[w + TRI_W.v2 + 1] = p[c + 1]; F[w + TRI_W.v2 + 2] = p[c + 2];
    U[w + TRI_W.aux] = 0;
  }
  return buf;
}

export function packBlas(bvh: Bvh2, positions: Float32Array, index?: Uint16Array | Uint32Array | null, slots?: Uint32Array | null): PackedBlas {
  return {
    nodes: bvh.nodes,
    nodeCount: bvh.nodeCount,
    tris: packTriangles(positions, index, bvh.primIndex, slots),
    triCount: bvh.primCount,
    bounds: bvh.bounds,
    maxDepth: bvh.maxDepth,
    leafCount: bvh.leafCount
  };
}

/** Build + pack one geometry (what the worker does). */
export function buildPackedBlas(
  positions: Float32Array,
  index?: Uint16Array | Uint32Array | null,
  opts: BlasBuildOptions = {}
): PackedBlas {
  const bvh = buildBlas(positions, index, opts);
  return packBlas(bvh, positions, index, triangleSlots(bvh.primCount, opts.groups));
}

/**
 * Copy `count` nodes into dst at node index `dstNode`, adding `nodeBase` to
 * inner child refs and parent links and `leafBase` to non-empty leaf offsets.
 */
export function relocateNodes(
  src: ArrayBuffer, count: number,
  dst: Uint32Array, dstNode: number,
  nodeBase: number, leafBase: number
): void {
  dst.set(new Uint32Array(src, 0, count * NODE_WORDS), dstNode * NODE_WORDS);
  for (let i = 0; i < count; i++) {
    const w = (dstNode + i) * NODE_WORDS;
    for (const cw of [NODE_W.child0, NODE_W.child1]) {
      const r = dst[w + cw];
      if (isLeaf(r)) {
        if (r !== EMPTY_LEAF && leafBase !== 0) dst[w + cw] = makeLeaf(leafCount(r), leafOffset(r) + leafBase);
      } else dst[w + cw] = r + nodeBase;
    }
    const p = dst[w + NODE_W.parent];
    if (p !== NODE_INVALID) dst[w + NODE_W.parent] = p + nodeBase;
  }
}

/* ─── instances ───────────────────────────────────────────────────────────── */

/** A batch of instances (maps 1:1 onto core MeshDesc + InstanceSet). */
export interface InstanceBatch {
  count: number;
  /** BLAS index (into the PackedBlas list) per instance, or one for all */
  blas: Uint32Array | number;
  /** objectToWorld, column-major, 16 per instance (station frame) */
  matrices: Float32Array;
  /** material index of slot 0, per instance or one for all (default 0) */
  matBase?: Uint32Array | number;
  /** linear RGB tint, 3 per instance (InstanceSet.colors); default white */
  tint?: Float32Array;
  /** flag byte (visibility bits 0..3, properties 4..7), default VIS_ALL */
  flags?: Uint8Array | number;
  /** first emissive-triangle light of this instance, default NO_LIGHT */
  lightBase?: Uint32Array | number;
  /** rebuilt by updateDynamic (traffic, lifts); gets INST_DYNAMIC */
  dynamic?: boolean;
}

export interface PackedScene {
  nodes: ArrayBuffer;
  tris: ArrayBuffer;
  instances: ArrayBuffer;
  nodeCount: number;
  triCount: number;
  instanceCount: number;
  /** traversal entry point (merge node, or the static TLAS root) */
  tlasRoot: number;
  tlasStaticRoot: number;
  /** NODE_INVALID when there is no dynamic part */
  tlasDynamicRoot: number;
  /** absolute root node / first triangle record of each BLAS */
  blasRoots: Uint32Array;
  blasTriBase: Uint32Array;
  /** BLAS root bounds, 6 per BLAS */
  blasBounds: Float32Array;
  staticInstanceCount: number;
  dynamicInstanceCount: number;
  /** first instance index of each input batch (in input order) */
  batchInstanceBase: Uint32Array;
  /** BLAS id per instance (CPU-side lookup: instance → geometry) */
  instanceBlas: Uint32Array;
  /** scene bounds (6 floats) */
  bounds: Float32Array;
  tlasStaticDepth: number;
  tlasDynamicDepth: number;
}

function writeInstances(
  U: Uint32Array, F: Float32Array, first: number,
  b: InstanceBatch, blasRoots: Uint32Array, instanceBlas: Uint32Array
): void {
  for (let i = 0; i < b.count; i++) {
    const idx = first + i;
    const w = idx * INST_WORDS;
    const det = affineInverseRows(b.matrices, i * 16, F, w + INST_W.w2o0);
    const blas = typeof b.blas === 'number' ? b.blas : b.blas[i];
    if (blas >= blasRoots.length) throw new RangeError(`instance ${idx}: BLAS ${blas} does not exist`);
    instanceBlas[idx] = blas;
    U[w + INST_W.blasRoot] = blasRoots[blas];
    U[w + INST_W.matBase] = b.matBase === undefined ? 0 : typeof b.matBase === 'number' ? b.matBase : b.matBase[i];
    U[w + INST_W.tint] = b.tint
      ? encodeRgb9e5(b.tint[i * 3], b.tint[i * 3 + 1], b.tint[i * 3 + 2])
      : encodeRgb9e5(1, 1, 1);
    let flags = b.flags === undefined ? VIS_ALL : typeof b.flags === 'number' ? b.flags : b.flags[i];
    if (b.dynamic) flags |= INST_DYNAMIC;
    if (det === 0) flags &= ~VIS_ALL; // singular matrix: invisible to every ray
    const light = b.lightBase === undefined ? NO_LIGHT : typeof b.lightBase === 'number' ? b.lightBase : b.lightBase[i];
    U[w + INST_W.flagsLight] = (((flags & 0xff) << INST_FLAGS_SHIFT) | (light & INST_LIGHT_MASK)) >>> 0;
  }
}

function batchBounds(batches: InstanceBatch[], blasBounds: Float32Array): Float32Array {
  let n = 0;
  for (const b of batches) n += b.count;
  const out = new Float32Array(n * 6);
  let o = 0;
  for (const b of batches) {
    instanceWorldBounds(blasBounds, b.blas, b.matrices, b.count, out.subarray(o * 6, (o + b.count) * 6));
    o += b.count;
  }
  return out;
}

function writeBox(F: Float32Array, w: number, minW: number, maxW: number, b: Float32Array): void {
  if (!(b[0] <= b[3])) {
    F.fill(EMPTY_BOX_COORD, w + minW, w + minW + 3);
    F.fill(EMPTY_BOX_COORD, w + maxW, w + maxW + 3);
    return;
  }
  F[w + minW] = b[0]; F[w + minW + 1] = b[1]; F[w + minW + 2] = b[2];
  F[w + maxW] = b[3]; F[w + maxW + 1] = b[4]; F[w + maxW + 2] = b[5];
}

export interface PackSceneOptions {
  tlas?: BuildOptions;
}

/** Concatenate BLAS, write instances, build static (+ dynamic) TLAS. */
export function packScene(blas: PackedBlas[], batches: InstanceBatch[], opts: PackSceneOptions = {}): PackedScene {
  const blasCount = blas.length;
  const blasRoots = new Uint32Array(blasCount);
  const blasTriBase = new Uint32Array(blasCount);
  const blasBounds = new Float32Array(blasCount * 6);
  let blasNodes = 0, triCount = 0;
  for (let i = 0; i < blasCount; i++) {
    blasRoots[i] = blasNodes;
    blasTriBase[i] = triCount;
    blasBounds.set(blas[i].bounds, i * 6);
    blasNodes += blas[i].nodeCount;
    triCount += blas[i].triCount;
  }

  /* instance order: static batches, then dynamic batches (each in input order) */
  const order = batches.map((b, i) => i).sort((a, b) => Number(!!batches[a].dynamic) - Number(!!batches[b].dynamic) || a - b);
  const batchInstanceBase = new Uint32Array(batches.length);
  let staticCount = 0, dynamicCount = 0;
  for (const i of order) {
    batchInstanceBase[i] = staticCount + dynamicCount;
    if (batches[i].dynamic) dynamicCount += batches[i].count; else staticCount += batches[i].count;
  }
  const instanceCount = staticCount + dynamicCount;
  const staticBatches = order.filter((i) => !batches[i].dynamic).map((i) => batches[i]);
  const dynamicBatches = order.filter((i) => batches[i].dynamic).map((i) => batches[i]);

  const instances = new ArrayBuffer(instanceCount * INST_BYTES);
  const IU = new Uint32Array(instances), IF = new Float32Array(instances);
  const instanceBlas = new Uint32Array(instanceCount);
  for (const i of order) writeInstances(IU, IF, batchInstanceBase[i], batches[i], blasRoots, instanceBlas);

  const sTlas = buildTlas(batchBounds(staticBatches, blasBounds), 0, opts.tlas);
  const hasDyn = dynamicCount > 0;
  const dTlas = hasDyn ? buildTlas(batchBounds(dynamicBatches, blasBounds), staticCount, opts.tlas) : null;

  const merge = hasDyn ? blasNodes : NODE_INVALID;
  const sBase = hasDyn ? blasNodes + 1 : blasNodes;
  const dBase = sBase + sTlas.nodeCount;
  const nodeCount = dBase + (dTlas ? dTlas.nodeCount : 0);

  const nodes = new ArrayBuffer(nodeCount * NODE_BYTES);
  const NU = new Uint32Array(nodes), NF = new Float32Array(nodes);
  for (let i = 0; i < blasCount; i++) relocateNodes(blas[i].nodes, blas[i].nodeCount, NU, blasRoots[i], blasRoots[i], blasTriBase[i]);

  const tris = new ArrayBuffer(triCount * TRI_BYTES);
  const TU = new Uint32Array(tris);
  for (let i = 0; i < blasCount; i++) {
    TU.set(new Uint32Array(blas[i].tris, 0, blas[i].triCount * TRI_WORDS), blasTriBase[i] * TRI_WORDS);
    // tri.aux = BLAS (geometry) index: hit → (geometry, primId) → source vertex attributes
    for (let t = blasTriBase[i], e = t + blas[i].triCount; t < e; t++) TU[t * TRI_WORDS + TRI_W.aux] = i;
  }

  relocateNodes(sTlas.nodes, sTlas.nodeCount, NU, sBase, sBase, 0);
  const bounds = new Float32Array(sTlas.bounds);
  if (dTlas) {
    relocateNodes(dTlas.nodes, dTlas.nodeCount, NU, dBase, dBase, 0);
    NU[sBase * NODE_WORDS + NODE_W.parent] = merge;
    NU[dBase * NODE_WORDS + NODE_W.parent] = merge;
    const w = merge * NODE_WORDS;
    writeBox(NF, w, NODE_W.c0min, NODE_W.c0max, sTlas.bounds);
    writeBox(NF, w, NODE_W.c1min, NODE_W.c1max, dTlas.bounds);
    NU[w + NODE_W.child0] = sBase;
    NU[w + NODE_W.child1] = dBase;
    NU[w + NODE_W.parent] = NODE_INVALID;
    NU[w + NODE_W.aux] = 0;
    unionInto(bounds, dTlas.bounds);
  }

  return {
    nodes, tris, instances,
    nodeCount, triCount, instanceCount,
    tlasRoot: hasDyn ? merge : sBase,
    tlasStaticRoot: sBase,
    tlasDynamicRoot: hasDyn ? dBase : NODE_INVALID,
    blasRoots, blasTriBase, blasBounds,
    staticInstanceCount: staticCount,
    dynamicInstanceCount: dynamicCount,
    batchInstanceBase,
    instanceBlas,
    bounds,
    tlasStaticDepth: sTlas.maxDepth + (hasDyn ? 1 : 0),
    tlasDynamicDepth: dTlas ? dTlas.maxDepth + 1 : 0
  };
}

function unionInto(a: Float32Array, b: Float32Array): void {
  if (!(b[0] <= b[3])) return;
  if (!(a[0] <= a[3])) { a.set(b); return; }
  for (let k = 0; k < 3; k++) {
    if (b[k] < a[k]) a[k] = b[k];
    if (b[k + 3] > a[k + 3]) a[k + 3] = b[k + 3];
  }
}

export interface DirtyRanges {
  /** [byteOffset, byteLength] pairs to re-upload into the node buffer */
  nodes: [number, number][];
  instances: [number, number];
}

/**
 * Rewrite the dynamic part in place: instance records, dynamic TLAS and the
 * merge node. `batches` must be the dynamic batches with the same counts and
 * order as given to packScene (new matrices / tints / flags allowed).
 */
export function updateDynamic(scene: PackedScene, batches: InstanceBatch[], opts: PackSceneOptions = {}): DirtyRanges {
  const n = batches.reduce((s, b) => s + b.count, 0);
  if (n !== scene.dynamicInstanceCount || scene.tlasDynamicRoot === NODE_INVALID) {
    throw new Error(`updateDynamic: expected ${scene.dynamicInstanceCount} dynamic instances, got ${n}`);
  }
  const IU = new Uint32Array(scene.instances), IF = new Float32Array(scene.instances);
  let first = scene.staticInstanceCount;
  for (const b of batches) {
    writeInstances(IU, IF, first, { ...b, dynamic: true }, scene.blasRoots, scene.instanceBlas);
    first += b.count;
  }
  const dTlas = buildTlas(batchBounds(batches, scene.blasBounds), scene.staticInstanceCount, opts.tlas);
  if (dTlas.nodeCount !== tlasNodeCount(n)) throw new Error('dynamic TLAS node count changed');
  const NU = new Uint32Array(scene.nodes), NF = new Float32Array(scene.nodes);
  const dBase = scene.tlasDynamicRoot;
  relocateNodes(dTlas.nodes, dTlas.nodeCount, NU, dBase, dBase, 0);
  const merge = scene.tlasRoot;
  NU[dBase * NODE_WORDS + NODE_W.parent] = merge;
  writeBox(NF, merge * NODE_WORDS, NODE_W.c1min, NODE_W.c1max, dTlas.bounds);
  scene.tlasDynamicDepth = dTlas.maxDepth + 1;
  const sb = new Float32Array(6);
  sb[0] = NF[merge * NODE_WORDS + NODE_W.c0min]; sb[1] = NF[merge * NODE_WORDS + NODE_W.c0min + 1]; sb[2] = NF[merge * NODE_WORDS + NODE_W.c0min + 2];
  sb[3] = NF[merge * NODE_WORDS + NODE_W.c0max]; sb[4] = NF[merge * NODE_WORDS + NODE_W.c0max + 1]; sb[5] = NF[merge * NODE_WORDS + NODE_W.c0max + 2];
  if (sb[0] === EMPTY_BOX_COORD) { sb.fill(EMPTY_BOX_COORD, 0, 3); sb.fill(-EMPTY_BOX_COORD, 3, 6); }
  unionInto(sb, dTlas.bounds);
  scene.bounds.set(sb);
  return {
    nodes: [
      [merge * NODE_BYTES, NODE_BYTES],
      [dBase * NODE_BYTES, dTlas.nodeCount * NODE_BYTES]
    ],
    instances: [scene.staticInstanceCount * INST_BYTES, n * INST_BYTES]
  };
}
