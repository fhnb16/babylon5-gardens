/* ═══════════════════════════════════════════════════════════════════════════
   Scene upload: SceneDesc → GPU (PT M1, DECISIONS.md "M1 interface").

   prepareScene()  (CPU, Node-safe)
     • traced items: every MeshDesc (static mesh = 1-instance batch with its
       transform; instanced mesh = InstanceSet, transform pre-multiplied),
       LodSetDesc → level 0 only; skipped: only:'raster' meshes, meshes whose
       materials are all raster-only (model decal / sprite, rasterOnly),
       billboards, RasterLightDesc;
     • one BLAS per referenced GeometryDesc (bvh/pool.ts when given, else
       synchronous), packScene() → nodes / tris / instances (group 0);
     • material lists: MeshDesc.materials expanded to the geometry's slot
       count (a single entry serves every slot), deduplicated; the material
       buffer is the concatenation of the lists, so instance.matBase + tri.slot
       indexes it directly ("instance-material table"). Records carry the
       source material id (B5Surface.matId);
     • per-triangle attributes in TRIANGLE-RECORD order (DECISIONS item 5),
       B5TriAttr, 64 B:
         byte  0  n0, n1, n2  u32 × 3   vertex normals, octahedral snorm16×2
                                        (object space; unpack2x16snorm)
         byte 12  c0          u32       vertex colour 0, RGB9E5 linear
                                        (white when the geometry has none)
         byte 16  uv0         vec2f     uv per vertex (v-up, f32: hull and
         byte 24  uv1         vec2f     facade UVs need more than f16)
         byte 32  uv2         vec2f
         byte 40  c1, c2      u32 × 2   vertex colours 1, 2 (RGB9E5)
         byte 48  lodConst    f32       ray-cone base LOD, object space:
                                        0.5·log2(uvArea / objectArea)
                                        (0 for degenerate triangles)
         byte 52  light       u32       local emissive-triangle index within
                                        its BLAS (record order) — triangles of
                                        meshEmission roles whose slot material
                                        emits — else NO_LIGHT (0xFFFFFF)
         byte 56  r0, r1      u32       reserved (0)
       Vertex form is fetched from the triangle record itself; primId (the
       BLAS build permutation) maps a record back to the source triangle.
       The tangent frame for normal maps is derived per hit from the
       triangle's positions and UVs (nothing stored).
     • instance colours → instance tint (RGB9E5, applied to albedo always —
       white when the InstanceSet has no colours).
   uploadPrepared() (GPU)
     • group 0 via gpu-scene.ts uploadScene (nodes, tris, instances, dbg);
     • group 2 (SURFACE_BINDINGS / surfaceBindGroupLayoutEntries):
         0 attrs     storage  array<B5TriAttr>
         1 mats      storage  array<B5Material>  (materials.ts)
         2 texrefs   uniform  B5TexTable          (textures.ts)
         3 frame     uniform  B5SurfaceFrame      (materials.ts paletteUniform)
         4 sampler   repeat   linear/linear/linear
         5 sampler   clamp-to-edge
         6..9  texture_2d_array srgb 256/512/1024/2048 (rgba8unorm-srgb views)
         10..13 texture_2d_array linear 256/512/1024/2048
   ═══════════════════════════════════════════════════════════════════════════ */

import type { GeometryDesc, ImageId, LightingState, MaterialDesc, MeshDesc, SceneDesc } from '../core/scene/types.ts';
import { emitWgslLibrary } from '../core/shading/emit/wgsl.ts';
import { HULL_DEFAULTS, hullSurface } from '../core/shading/kernels/hull.ts';
import { FAR_FAR_UNITS, FAR_NEAR_UNITS, REF_PIXEL_ANGLE } from '../core/shading/contracts.ts';
import type { HullKernelOptions } from '../core/shading/contracts.ts';
import type { Kernel } from '../core/shading/kernel.ts';
import type { PixelImage } from '../core/raster/index.ts';
import { lightingAt } from '../core/lighting/phases.ts';
import {
  INST_EMISSIVE, INST_GLASS, NO_LIGHT, TRI_W, TRI_WORDS, VIS_ALL, buildPackedBlas, encodeRgb9e5, packScene, updateDynamic,
  type BvhPool, type DirtyRanges, type InstanceBatch, type PackedBlas, type PackedScene
} from './bvh/index.ts';
import { BUFFER, STAGE } from './gpu-flags.ts';
import { buildLightList, type LightList } from './lights/light-data.ts';
import { emitWgslPtConfig } from './config.ts';
import { uploadScene, type GpuScene as TraversalScene } from './gpu-scene.ts';
import { createSceneLayout, type PtKernels, type WgslSources } from './kernels.ts';
import {
  FRAME_BYTES, MAT_BYTES, MAT_KIND, NO_TEX, describeMaterial, emitWgslMaterials, isEmissiveMaterial,
  isRasterOnlyMaterial, materialKind, paletteUniform, writeMaterial, type FrameOptions, type MaterialTextures
} from './materials.ts';
import {
  CLASS_COUNT, emitWgslTextures, loadTextureImages, planTextures, syncImageGenerator, textureBudget, uploadTextures,
  type GpuTextures, type ImageGenerator, type TexturePlan
} from './textures.ts';
import surfaceWgsl from './wgsl/surface.wgsl?raw';
import mipgenWgsl from './wgsl/mipgen.wgsl?raw';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/* ─── attribute record ────────────────────────────────────────────────────── */

export const ATTR_BYTES = 64;
export const ATTR_WORDS = 16;
export const ATTR_OFFSETS = {
  n0: 0, n1: 4, n2: 8, c0: 12, uv0: 16, uv1: 24, uv2: 32, c1: 40, c2: 44, lodConst: 48, light: 52, r0: 56, r1: 60
} as const;
export const ATTR_W = {
  n0: 0, n1: 1, n2: 2, c0: 3, uv0: 4, uv1: 6, uv2: 8, c1: 10, c2: 11, lodConst: 12, light: 13, r0: 14, r1: 15
} as const;

const snorm16 = (v: number): number => Math.round(Math.max(-1, Math.min(1, v)) * 32767) & 0xffff;
const fromSnorm16 = (u: number): number => Math.max(-1, ((u << 16) >> 16) / 32767);

/** Octahedral encoding (Cigolle et al. 2014) as snorm16×2 (x low, y high). */
export function encodeOct(x: number, y: number, z: number): number {
  const s = Math.abs(x) + Math.abs(y) + Math.abs(z);
  if (!(s > 0)) return (snorm16(0) | (snorm16(0) << 16)) >>> 0;
  let px = x / s, py = y / s;
  if (z < 0) {
    const ox = (1 - Math.abs(py)) * (px >= 0 ? 1 : -1);
    const oy = (1 - Math.abs(px)) * (py >= 0 ? 1 : -1);
    px = ox; py = oy;
  }
  return (snorm16(px) | (snorm16(py) << 16)) >>> 0;
}

/** CPU mirror of b5_oct_decode (normalised). */
export function decodeOct(p: number, out: number[] = [0, 0, 0]): number[] {
  const ex = fromSnorm16(p & 0xffff), ey = fromSnorm16(p >>> 16);
  let x = ex, y = ey;
  const z = 1 - Math.abs(ex) - Math.abs(ey);
  const t = Math.max(-z, 0);
  x += x >= 0 ? -t : t;
  y += y >= 0 ? -t : t;
  const l = Math.hypot(x, y, z) || 1;
  out[0] = x / l; out[1] = y / l; out[2] = z / l;
  return out;
}

/* ─── traced items ────────────────────────────────────────────────────────── */

export interface TracedItem {
  role: string;
  geometry: string;
  /** material ids per slot (expanded) */
  materials: string[];
  count: number;
  /** objectToWorld per instance (column-major ×16) */
  matrices: Float32Array;
  colors?: Float32Array;
  dynamic?: 'traffic' | 'lifts';
  source: 'mesh' | 'lod';
  /** the MeshDesc (dynamic refresh) */
  mesh?: MeshDesc;
}

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** out = a · b (column-major 4×4) */
function mul4(a: ArrayLike<number>, b: ArrayLike<number>, bo: number, out: Float32Array, oo: number): void {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[oo + c * 4 + r] = a[r] * b[bo + c * 4] + a[4 + r] * b[bo + c * 4 + 1] + a[8 + r] * b[bo + c * 4 + 2] + a[12 + r] * b[bo + c * 4 + 3];
    }
  }
}

function slotCount(g: GeometryDesc): number {
  let m = 0;
  for (const gr of g.groups) m = Math.max(m, gr.slot + 1);
  return Math.max(1, m);
}

function meshMatrices(m: MeshDesc): Float32Array {
  if (!m.instances) return new Float32Array(m.transform ?? IDENTITY);
  if (!m.transform) return m.instances.matrices;
  const out = new Float32Array(m.instances.count * 16);
  for (let i = 0; i < m.instances.count; i++) mul4(m.transform, m.instances.matrices, i * 16, out, i * 16);
  return out;
}

/** The items the tracer sees (pure). */
export function tracedItems(scene: SceneDesc): TracedItem[] {
  const out: TracedItem[] = [];
  const mat = (id: string): MaterialDesc => {
    const m = scene.materials[id];
    if (!m) throw new Error(`material '${id}' not in SceneDesc.materials`);
    return m;
  };
  const expand = (g: GeometryDesc, mats: string[]): string[] => {
    const n = Math.max(slotCount(g), mats.length);
    return Array.from({ length: n }, (_, k) => mats[Math.min(k, mats.length - 1)]);
  };
  for (const m of scene.meshes) {
    if (m.only === 'raster') continue;
    if (m.materials.every((id) => isRasterOnlyMaterial(mat(id)))) continue;
    const g = scene.geometries[m.geometry];
    if (!g) throw new Error(`mesh ${m.role}: geometry '${m.geometry}' missing`);
    const count = m.instances ? m.instances.count : 1;
    if (count === 0) continue;
    out.push({
      role: m.role, geometry: m.geometry, materials: expand(g, m.materials), count,
      matrices: meshMatrices(m), colors: m.instances?.colors, dynamic: m.dynamic, source: 'mesh', mesh: m
    });
  }
  for (const l of scene.lodSets) {
    const lv = l.levels[0];
    if (!lv || isRasterOnlyMaterial(mat(lv.material))) continue;
    const g = scene.geometries[lv.geometry];
    const count = l.matrices.length / 16;
    if (!count) continue;
    out.push({
      role: lv.role, geometry: lv.geometry, materials: expand(g, [lv.material]), count,
      matrices: l.matrices, colors: l.colors, source: 'lod'
    });
  }
  return out;
}

/* ─── prepare (CPU) ───────────────────────────────────────────────────────── */

export interface RoleRange {
  role: string;
  /** first instance index in the packed instance buffer */
  first: number;
  count: number;
  blas: number;
  geometry: string;
  matBase: number;
  materials: string[];
  dynamic: boolean;
  emissive: boolean;
}

export interface SceneStats {
  geometries: number;
  /** unique triangles (sum over BLAS) */
  triangles: number;
  /** triangles × instances */
  instancedTriangles: number;
  instances: number;
  dynamicInstances: number;
  nodes: number;
  materials: number;
  textures: number;
  emissiveTriangles: number;
  /** emissive-triangle lights (instanced: Σ emissive triangles × emitter instances) */
  lights: number;
  bytes: { nodes: number; tris: number; instances: number; attrs: number; materials: number; textures: number };
}

export interface PrepareTimings {
  /** wall time of all BLAS builds (parallel when a pool is used) */
  bvhMs: number;
  /** sum of per-BLAS build times (worker-side) */
  bvhCpuMs: number;
  packMs: number;
  attrMs: number;
}

export interface PreparedScene {
  scene: SceneDesc;
  items: TracedItem[];
  /** geometry id per BLAS index */
  geometries: string[];
  blas: PackedBlas[];
  packed: PackedScene;
  batches: InstanceBatch[];
  /** batch index of each item (dynamic refresh) */
  attrs: ArrayBuffer;
  materials: ArrayBuffer;
  materialCount: number;
  /** MaterialDesc ids in id order (record.id → MaterialDesc) */
  materialIds: string[];
  texPlan: TexturePlan;
  roles: RoleRange[];
  /** emissive triangles per BLAS (light-list sizes for wave 4) */
  emissiveTris: Uint32Array;
  stats: SceneStats;
  timings: PrepareTimings;
}

export interface PrepareOptions {
  /** BLAS worker pool (bvh/pool.ts); synchronous builds when absent */
  pool?: BvhPool;
}

function texturesOf(m: MaterialDesc): ImageId[] {
  return [m.map, m.normalMap, m.roughnessMap, m.emissiveMap].filter((x): x is ImageId => !!x);
}

export async function prepareScene(scene: SceneDesc, opts: PrepareOptions = {}): Promise<PreparedScene> {
  const items = tracedItems(scene);

  /* geometries → BLAS */
  const geometries: string[] = [];
  const geoIndex = new Map<string, number>();
  for (const it of items) {
    if (!geoIndex.has(it.geometry)) { geoIndex.set(it.geometry, geometries.length); geometries.push(it.geometry); }
  }
  const t0 = now();
  let blas: PackedBlas[];
  let bvhCpuMs = 0;
  if (opts.pool) {
    const res = await opts.pool.buildAll(geometries.map((id) => {
      const g = scene.geometries[id];
      return { positions: g.position, index: g.index ?? null, options: { groups: g.groups } };
    }));
    for (const r of res) bvhCpuMs += r.ms;
    blas = res;
  } else {
    blas = geometries.map((id) => {
      const g = scene.geometries[id];
      const s = now();
      const b = buildPackedBlas(g.position, g.index ?? null, { groups: g.groups });
      bvhCpuMs += now() - s;
      return b;
    });
  }
  const bvhMs = now() - t0;

  /* materials: ids, lists, textures */
  const materialIds = Object.keys(scene.materials);
  const matId = new Map(materialIds.map((id, i) => [id, i]));
  const listBase = new Map<string, number>();
  const lists: string[][] = [];
  let materialCount = 0;
  const itemBase = items.map((it) => {
    const key = it.materials.join('\u0001');
    let b = listBase.get(key);
    if (b === undefined) { b = materialCount; listBase.set(key, b); lists.push(it.materials); materialCount += it.materials.length; }
    return b;
  });
  const texIds: ImageId[] = [];
  const usedMats = [...new Set(lists.flat())];
  for (const id of usedMats) {
    const m = scene.materials[id];
    if (isRasterOnlyMaterial(m)) continue;
    texIds.push(...texturesOf(m));
    if (m.model === 'hull') texIds.push(scene.hull.mask, scene.hull.detail);
  }
  const texPlan = planTextures(scene.images, texIds);
  const ti = (id: ImageId | undefined) => (id ? texPlan.byImage.get(id) ?? NO_TEX : NO_TEX);
  const materials = new ArrayBuffer(Math.max(1, materialCount) * MAT_BYTES);
  {
    let k = 0;
    for (const list of lists) {
      for (const id of list) {
        const m = scene.materials[id];
        if (isRasterOnlyMaterial(m)) throw new Error(`material '${id}' is raster-only but sits in a traced mesh`);
        const tex: MaterialTextures = { albedo: ti(m.map), normal: ti(m.normalMap), rough: ti(m.roughnessMap), emissive: ti(m.emissiveMap) };
        if (materialKind(m) === MAT_KIND.hull) { tex.mask = ti(scene.hull.mask); tex.detail = ti(scene.hull.detail); }
        writeMaterial(materials, k++, describeMaterial(m, matId.get(id)!, tex));
      }
    }
  }

  /* emissive slots per geometry (meshEmission roles only) */
  const emitterRoles = new Set(scene.emitters.filter((e) => e.kind === 'meshEmission').map((e) => e.role));
  const emissiveSlots = geometries.map(() => new Set<number>());
  items.forEach((it) => {
    if (!emitterRoles.has(it.role)) return;
    it.materials.forEach((id, slot) => { if (isEmissiveMaterial(scene.materials[id])) emissiveSlots[geoIndex.get(it.geometry)!].add(slot); });
  });
  /* emissive triangle records per BLAS (= attr.light count, record order) */
  const emissiveTris = new Uint32Array(blas.length);
  blas.forEach((b, i) => {
    if (!emissiveSlots[i].size) return;
    const BU = new Uint32Array(b.tris);
    for (let t = 0; t < b.triCount; t++) if (emissiveSlots[i].has(BU[t * TRI_WORDS + TRI_W.slot])) emissiveTris[i]++;
  });

  /* instance batches. PT-W4a (owner of this file since U3 finished):
     • lightBase — emitter-role instances whose BLAS has emissive triangles
       get consecutive global light ids (batch order, then instance order):
       light id = inst.lightBase + attr.light (lights/light-data.ts);
     • INST_GLASS — items made only of thinGlass materials: shadow rays pass
       through them with the glass transmittance (k_shadow_tr.wgsl). */
  let nextLight = 0;
  const batches: InstanceBatch[] = items.map((it, i) => {
    const emissive = it.materials.some((id) => isEmissiveMaterial(scene.materials[id]));
    const glass = it.materials.every((id) => scene.materials[id].model === 'thinGlass');
    const b = geoIndex.get(it.geometry)!;
    let lightBase: Uint32Array | number = NO_LIGHT;
    if (emitterRoles.has(it.role) && emissiveTris[b] > 0) {
      const lb = new Uint32Array(it.count);
      for (let k = 0; k < it.count; k++) { lb[k] = nextLight; nextLight += emissiveTris[b]; }
      if (nextLight >= NO_LIGHT) throw new RangeError(`${nextLight} emissive triangle lights exceed the 24-bit lightBase`);
      lightBase = lb;
    }
    return {
      count: it.count,
      blas: b,
      matrices: it.matrices,
      matBase: itemBase[i],
      tint: it.colors,
      flags: VIS_ALL | (emissive ? INST_EMISSIVE : 0) | (glass ? INST_GLASS : 0),
      lightBase,
      dynamic: !!it.dynamic
    };
  });
  const tp = now();
  const packed = packScene(blas, batches);
  const packMs = now() - tp;

  /* attributes in triangle-record order */
  const ta = now();
  const attrs = new ArrayBuffer(Math.max(1, packed.triCount) * ATTR_BYTES);
  const AU = new Uint32Array(attrs), AF = new Float32Array(attrs);
  const TU = new Uint32Array(packed.tris);
  const white = encodeRgb9e5(1, 1, 1);
  for (let b = 0; b < blas.length; b++) {
    const g = scene.geometries[geometries[b]];
    const P = g.position, N = g.normal, UV = g.uv, C = g.color, I = g.index;
    const eslots = emissiveSlots[b];
    let light = 0;
    const base = packed.blasTriBase[b];
    for (let i = 0; i < blas[b].triCount; i++) {
      const rec = base + i;
      const t = TU[rec * TRI_WORDS + TRI_W.primId];
      const slot = TU[rec * TRI_WORDS + TRI_W.slot];
      const vi = I ? [I[t * 3], I[t * 3 + 1], I[t * 3 + 2]] : [t * 3, t * 3 + 1, t * 3 + 2];
      const w = rec * ATTR_WORDS;
      for (let k = 0; k < 3; k++) {
        const v = vi[k];
        AU[w + ATTR_W.n0 + k] = encodeOct(N[v * 3], N[v * 3 + 1], N[v * 3 + 2]);
        AF[w + ATTR_W.uv0 + 2 * k] = UV[v * 2];
        AF[w + ATTR_W.uv0 + 2 * k + 1] = UV[v * 2 + 1];
        AU[w + (k === 0 ? ATTR_W.c0 : k === 1 ? ATTR_W.c1 : ATTR_W.c2)] = C ? encodeRgb9e5(C[v * 3], C[v * 3 + 1], C[v * 3 + 2]) : white;
      }
      const a = vi[0] * 3, bb = vi[1] * 3, c = vi[2] * 3;
      const e1x = P[bb] - P[a], e1y = P[bb + 1] - P[a + 1], e1z = P[bb + 2] - P[a + 2];
      const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
      const cx = e1y * e2z - e1z * e2y, cy = e1z * e2x - e1x * e2z, cz = e1x * e2y - e1y * e2x;
      const area = 0.5 * Math.hypot(cx, cy, cz);
      const u0 = vi[0] * 2, u1 = vi[1] * 2, u2 = vi[2] * 2;
      const uvArea = 0.5 * Math.abs((UV[u1] - UV[u0]) * (UV[u2 + 1] - UV[u0 + 1]) - (UV[u1 + 1] - UV[u0 + 1]) * (UV[u2] - UV[u0]));
      AF[w + ATTR_W.lodConst] = area > 0 && uvArea > 0 ? 0.5 * Math.log2(uvArea / area) : 0;
      AU[w + ATTR_W.light] = eslots.has(slot) ? light++ : NO_LIGHT;
    }
    if (light !== emissiveTris[b]) throw new Error(`BLAS ${b}: ${light} emissive records ≠ ${emissiveTris[b]} counted before packing`);
  }
  const attrMs = now() - ta;

  /* role ranges */
  const roles: RoleRange[] = items.map((it, i) => ({
    role: it.role, first: packed.batchInstanceBase[i], count: it.count, blas: geoIndex.get(it.geometry)!,
    geometry: it.geometry, matBase: itemBase[i], materials: it.materials, dynamic: !!it.dynamic,
    emissive: ((typeof batches[i].flags === 'number' ? batches[i].flags : 0) & INST_EMISSIVE) !== 0
  }));

  let instancedTriangles = 0;
  items.forEach((it) => { instancedTriangles += blas[geoIndex.get(it.geometry)!].triCount * it.count; });
  const stats: SceneStats = {
    geometries: blas.length,
    triangles: packed.triCount,
    instancedTriangles,
    instances: packed.instanceCount,
    dynamicInstances: packed.dynamicInstanceCount,
    nodes: packed.nodeCount,
    materials: materialCount,
    textures: texPlan.refs.length,
    emissiveTriangles: emissiveTris.reduce((s, x) => s + x, 0),
    lights: nextLight,
    bytes: {
      nodes: packed.nodes.byteLength, tris: packed.tris.byteLength, instances: packed.instances.byteLength,
      attrs: attrs.byteLength, materials: materials.byteLength, textures: texPlan.bytes
    }
  };
  return {
    scene, items, geometries, blas, packed, batches, attrs, materials, materialCount, materialIds, texPlan, roles,
    emissiveTris, stats, timings: { bvhMs, bvhCpuMs, packMs, attrMs }
  };
}

/** Emissive-triangle light list of a prepared scene (world vertices from the current batch matrices). */
export function preparedLightList(prep: PreparedScene): LightList {
  const inst2batch = new Uint32Array(prep.packed.instanceCount);
  const inst2local = new Uint32Array(prep.packed.instanceCount);
  prep.batches.forEach((b, i) => {
    const base = prep.packed.batchInstanceBase[i];
    for (let k = 0; k < b.count; k++) { inst2batch[base + k] = i; inst2local[base + k] = k; }
  });
  return buildLightList({
    instances: prep.packed.instances, tris: prep.packed.tris, attrs: prep.attrs,
    attrWords: ATTR_WORDS, attrLightWord: ATTR_W.light,
    objectToWorld(k, out) { out.set(prep.batches[inst2batch[k]].matrices.subarray(inst2local[k] * 16, inst2local[k] * 16 + 16)); },
    instanceBlas: prep.packed.instanceBlas,
    blasTriBase: prep.packed.blasTriBase,
    blasTriCount: new Uint32Array(prep.blas.map((b) => b.triCount))
  });
}

/** Refresh the dynamic batches from the (stepDynamics-mutated) SceneDesc matrices; CPU part of updateDynamics. */
export function refreshDynamic(prep: PreparedScene): DirtyRanges | null {
  if (prep.packed.dynamicInstanceCount === 0) return null;
  const dyn: InstanceBatch[] = [];
  prep.items.forEach((it, i) => {
    if (!it.dynamic) return;
    if (it.mesh) it.matrices = meshMatrices(it.mesh);
    prep.batches[i].matrices = it.matrices;
    dyn.push(prep.batches[i]);
  });
  return updateDynamic(prep.packed, dyn);
}

/* ─── WGSL ────────────────────────────────────────────────────────────────── */

/** Hull kernel options used by the tracer (raster-only truss shadow excluded). */
export const TRACER_HULL_OPTIONS: HullKernelOptions = { ...HULL_DEFAULTS, raster: false };

export function emitWgslAttrs(): string {
  return [
    '// generated by pathtracer/scene-upload.ts — do not edit',
    `const B5_REF_PIXEL_ANGLE: f32 = ${REF_PIXEL_ANGLE.toPrecision(9)};`,
    `const B5_FAR_NEAR: f32 = ${FAR_NEAR_UNITS.toFixed(1)};`,
    `const B5_FAR_FAR: f32 = ${FAR_FAR_UNITS.toFixed(1)};`,
    '',
    `// size ${ATTR_BYTES} B`,
    'struct B5TriAttr {',
    ...Object.entries(ATTR_OFFSETS).map(([k, o]) => `  ${k}: ${k.startsWith('uv') ? 'vec2f' : k === 'lodConst' ? 'f32' : 'u32'}, // @${o}`),
    '}',
    ''
  ].join('\n');
}

/** Generated WGSL sources surface.wgsl includes (pure; usable in Node). */
export function surfaceGeneratedSources(): WgslSources {
  return {
    'surface_layout.gen.wgsl': [emitWgslMaterials(), emitWgslTextures(), emitWgslAttrs()].join('\n'),
    'pt_config.gen.wgsl': emitWgslPtConfig(),
    'hull_kernel.gen.wgsl': emitWgslLibrary([{ kernel: hullSurface as unknown as Kernel<unknown>, options: TRACER_HULL_OPTIONS }])
  };
}

/** Everything U3 contributes to the kernel source map: merge with wgsl/index.ts WGSL_SOURCES. */
export function surfaceSources(): WgslSources {
  return { 'surface.wgsl': surfaceWgsl, 'mipgen.wgsl': mipgenWgsl, ...surfaceGeneratedSources() };
}

/* ─── GPU ─────────────────────────────────────────────────────────────────── */

export const SURFACE_BINDINGS = {
  attrs: 0, mats: 1, texrefs: 2, frame: 3, samplerRepeat: 4, samplerClamp: 5,
  /** first texture binding; srgb 256..2048 then linear 256..2048 */
  textures: 6
} as const;

/** Bind group layout entries of group 2 (stable — U4 builds its pipeline layouts with it). */
export const surfaceBindGroupLayoutEntries: GPUBindGroupLayoutEntry[] = [
  { binding: SURFACE_BINDINGS.attrs, visibility: STAGE.COMPUTE, buffer: { type: 'read-only-storage' } },
  { binding: SURFACE_BINDINGS.mats, visibility: STAGE.COMPUTE, buffer: { type: 'read-only-storage' } },
  { binding: SURFACE_BINDINGS.texrefs, visibility: STAGE.COMPUTE, buffer: { type: 'uniform' } },
  { binding: SURFACE_BINDINGS.frame, visibility: STAGE.COMPUTE, buffer: { type: 'uniform' } },
  { binding: SURFACE_BINDINGS.samplerRepeat, visibility: STAGE.COMPUTE, sampler: { type: 'filtering' } },
  { binding: SURFACE_BINDINGS.samplerClamp, visibility: STAGE.COMPUTE, sampler: { type: 'filtering' } },
  ...Array.from({ length: 2 * CLASS_COUNT }, (_, i): GPUBindGroupLayoutEntry => ({
    binding: SURFACE_BINDINGS.textures + i, visibility: STAGE.COMPUTE,
    texture: { sampleType: 'float', viewDimension: '2d-array' }
  }))
];

export function createSurfaceLayout(device: GPUDevice): GPUBindGroupLayout {
  return device.createBindGroupLayout({ label: 'b5 surface', entries: surfaceBindGroupLayoutEntries });
}

export interface UploadTimings extends PrepareTimings {
  /** texture pixel generation (+ resampling to class squares) */
  texGenMs: number;
  texUploadMs: number;
  mipMs: number;
  /** buffer creation + writes (scene, attrs, materials, uniforms) */
  bufferMs: number;
  totalMs: number;
}

export interface GpuScene {
  device: GPUDevice;
  prepared: PreparedScene;
  /** group 0 (traversal kernels) */
  traversal: TraversalScene;
  sceneLayout: GPUBindGroupLayout;
  sceneBindGroup: GPUBindGroup;
  tlasRoot: number;
  /** group 2 */
  attrs: GPUBuffer;
  materials: GPUBuffer;
  frame: GPUBuffer;
  textures: GpuTextures;
  /** level-0 class squares (texture-table order) when UploadOptions.keepImages — surface-ref input */
  images: PixelImage[] | null;
  surfaceLayout: GPUBindGroupLayout;
  surfaceBindGroup: GPUBindGroup;
  roles: RoleRange[];
  stats: SceneStats;
  timings: UploadTimings;
  /** write the B5SurfaceFrame uniform (palette, hull params, time) */
  setFrame(state: LightingState, opts?: FrameOptions): void;
  /** re-pack and re-upload traffic / lifts after stepDynamics (photo mode freezes them) */
  updateDynamics(): DirtyRanges | null;
  destroy(): void;
}

export interface UploadOptions extends PrepareOptions {
  /** WGSL sources with mipgen.wgsl (default surfaceSources()) */
  sources?: WgslSources;
  /** pixel source (default synchronous core/textures; browser: app/workers/texturePool) */
  images?: ImageGenerator;
  /** reuse the traversal kernels' group-0 layout (else an equivalent one is created) */
  sceneLayout?: GPUBindGroupLayout;
  surfaceLayout?: GPUBindGroupLayout;
  /** initial lighting (default DAY = lightingAt(0)) */
  state?: LightingState;
  /** keep the CPU level-0 images on the GpuScene (surface-ref.ts) */
  keepImages?: boolean;
  log?: (line: string) => void;
}

function storage(device: GPUDevice, label: string, data: ArrayBuffer): GPUBuffer {
  const size = Math.max(64, Math.ceil(data.byteLength / 16) * 16);
  const b = device.createBuffer({ label, size, usage: BUFFER.STORAGE | BUFFER.COPY_DST, mappedAtCreation: true });
  new Uint8Array(b.getMappedRange()).set(new Uint8Array(data));
  b.unmap();
  return b;
}

/** GPU upload of a prepared scene. `level0` = class-square images (loadTextureImages). */
export async function uploadPrepared(
  device: GPUDevice, prep: PreparedScene, level0: PixelImage[],
  opts: UploadOptions = {}, texGenMs = 0
): Promise<GpuScene> {
  const sources = opts.sources ?? surfaceSources();
  const textures = await uploadTextures(device, prep.texPlan, level0, { sources, log: opts.log });
  const tb = now();
  const sceneLayout = opts.sceneLayout ?? createSceneLayout(device);
  const traversal = uploadScene(device, { sceneLayout } as unknown as PtKernels, prep.packed);
  const maxBinding = device.limits.maxStorageBufferBindingSize;
  if (prep.attrs.byteLength > maxBinding) throw new RangeError(`attrs ${prep.attrs.byteLength} B > maxStorageBufferBindingSize`);
  const attrs = storage(device, 'b5 attrs', prep.attrs);
  const materials = storage(device, 'b5 materials', prep.materials);
  const frame = device.createBuffer({ label: 'b5 surface frame', size: FRAME_BYTES, usage: BUFFER.UNIFORM | BUFFER.COPY_DST });
  device.queue.writeBuffer(frame, 0, paletteUniform(opts.state ?? lightingAt(0), { detailRep: prep.scene.hull.detailRep }));
  const surfaceLayout = opts.surfaceLayout ?? createSurfaceLayout(device);
  const surfaceBindGroup = device.createBindGroup({
    label: 'b5 surface',
    layout: surfaceLayout,
    entries: [
      { binding: SURFACE_BINDINGS.attrs, resource: { buffer: attrs } },
      { binding: SURFACE_BINDINGS.mats, resource: { buffer: materials } },
      { binding: SURFACE_BINDINGS.texrefs, resource: { buffer: textures.table } },
      { binding: SURFACE_BINDINGS.frame, resource: { buffer: frame } },
      { binding: SURFACE_BINDINGS.samplerRepeat, resource: textures.samplerRepeat },
      { binding: SURFACE_BINDINGS.samplerClamp, resource: textures.samplerClamp },
      ...textures.views.map((v, i) => ({ binding: SURFACE_BINDINGS.textures + i, resource: v }))
    ]
  });
  await device.queue.onSubmittedWorkDone();
  const bufferMs = now() - tb;
  const timings: UploadTimings = {
    ...prep.timings, texGenMs, texUploadMs: textures.timings.uploadMs, mipMs: textures.timings.mipMs, bufferMs,
    totalMs: 0
  };
  timings.totalMs = timings.bvhMs + timings.packMs + timings.attrMs + texGenMs + timings.texUploadMs + timings.mipMs + bufferMs;
  return {
    device, prepared: prep, traversal, sceneLayout, sceneBindGroup: traversal.bindGroup, tlasRoot: prep.packed.tlasRoot,
    attrs, materials, frame, textures, images: opts.keepImages ? level0 : null, surfaceLayout, surfaceBindGroup,
    roles: prep.roles, stats: prep.stats, timings,
    setFrame(state, fo = {}) {
      device.queue.writeBuffer(frame, 0, paletteUniform(state, { detailRep: prep.scene.hull.detailRep, ...fo }));
    },
    updateDynamics() {
      const d = refreshDynamic(prep);
      if (!d) return null;
      traversal.writeRanges('nodes', prep.packed.nodes, d.nodes);
      traversal.writeRanges('instances', prep.packed.instances, [d.instances]);
      return d;
    },
    destroy() {
      traversal.destroy(); attrs.destroy(); materials.destroy(); frame.destroy(); textures.destroy();
    }
  };
}

/** SceneDesc → GpuScene in one call: prepareScene + loadTextureImages + uploadPrepared. */
export async function uploadSceneDesc(device: GPUDevice, scene: SceneDesc, opts: UploadOptions = {}): Promise<GpuScene> {
  const prep = await prepareScene(scene, opts);
  const tg = now();
  const level0 = await loadTextureImages(prep.texPlan, scene.images, opts.images ?? syncImageGenerator);
  const texGenMs = now() - tg;
  const gs = await uploadPrepared(device, prep, level0, opts, texGenMs);
  const t = gs.timings, s = gs.stats;
  opts.log?.(`scene upload: ${s.geometries} BLAS / ${s.triangles} tris (${s.instancedTriangles} instanced), ${s.instances} instances ` +
    `(${s.dynamicInstances} dynamic), ${s.nodes} nodes, ${s.materials} material records, ${s.textures} textures; ` +
    `BVH ${t.bvhMs.toFixed(0)} ms (cpu ${t.bvhCpuMs.toFixed(0)}), pack ${t.packMs.toFixed(0)}, attrs ${t.attrMs.toFixed(0)}, ` +
    `tex gen ${t.texGenMs.toFixed(0)}, tex upload ${t.texUploadMs.toFixed(0)}, mips ${t.mipMs.toFixed(0)}, buffers ${t.bufferMs.toFixed(0)} ms`);
  opts.log?.(textureBudget(prep.texPlan));
  return gs;
}
