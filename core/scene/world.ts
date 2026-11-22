/* ═══════════════════════════════════════════════════════════════════════════
   World builder — pure-data port of js/world.js `buildWorld`.

   Output: a SceneFragment (geometries/materials/meshes/lodSets/billboards/
   images, ids prefixed 'w.'), the HullDesc, the traffic state and the raw
   layout lists. Nothing here touches three, the DOM or the mutable legacy
   CONFIG: everything comes from WorldParams + CORE_CONFIG.

   rnd() ORDER on the main stream mulberry32(seed) — must never change:
     1. tree sampling: per attempt treeH (2 calls, even if rejected), t, z,
        zone accept (only when the zone weight > 0);
     2. per accepted tree, in sampling order: spin, squash, fall, tint;
     3. bush sampling: per attempt radius, t, z, zone accept;
     4. bush instances, IN SECTOR-BUCKET ORDER: rotation, colour (pick);
     5. traffic: n colour calls, then n offset calls.
   Other streams: hills seed+404; textures (generated elsewhere) +7 hull,
   +11 detail, +31·(v+1) facades, +77 roof, +53 panel, +61 leaf; foliage
   geometry: lod0 and lod1 EACH a fresh seed+5; bushes seed+6; each city cell
   its own rng (cellInfo), each parking slot its own (parkingRng).

   Sectored legacy objects `<role>.s<bucket>` become ONE MeshDesc per role
   whose InstanceSet.chunks are the non-empty buckets in bucket order (same
   instance order inside each bucket). Crowns become a LodSetDesc.
   ═══════════════════════════════════════════════════════════════════════════ */

import { CORE_CONFIG, type QualityPreset } from '../config/index.ts';
import { mulberry32, pick } from '../rng.ts';
import { D2R, TAU } from '../math/scalar.ts';
import { natural, setHex } from '../math/color.ts';
import { compose } from '../math/mat4.ts';
import { fromAxisAngle, multiply as qmul } from '../math/quat.ts';
import { computeBounds, toGeometryDesc, type MeshData } from '../geometry/mesh.ts';
import { TEX } from '../textures/ids.ts';
import { standardImages } from '../textures/registry.ts';
import type {
  BillboardSetDesc, EmitterDesc, GeometryDesc, HillDesc, HullDesc, ImageDesc, InstanceChunk, InstanceSet,
  LodSetDesc, MaterialDesc, MeshDesc, SceneFragment, TrafficState, WorldParams
} from './types.ts';
import { placeHills, pondsOf, reliefAt, reliefList, type Hill, type Pond } from '../layout/hills.ts';
import { surfacePos, surfaceQuat } from '../layout/surface.ts';
import { trafficRoads } from '../layout/city.ts';
import { pickFloors } from '../layout/city.ts';
import {
  W_BUSH, W_TREE, cityPlots, createPlacer, parkedCars, type ParkedCar, type Plot, type Spot
} from '../layout/placement.ts';
import {
  buildingGeo, carBodyGeo, crossQuadGeo, decalGeo, foliageGeo, hullGeo, trafficBodyGeo,
  trafficLampGeo, trunkGeo, tuftGeo
} from './world-shapes.ts';
import { trafficMatrices } from './dynamics.ts';

/* ─── public result ───────────────────────────────────────────────────────── */

/** Per-tree data (legacy item[2] after sampling). */
export interface TreeData {
  H: number;
  th: number;
  tr: number;
  up: number;
  spin: number;
  squash: number;
  fall: boolean;
  tint: number;
}

export interface WorldLayout {
  /** legacy displaceHills list ({t, z, r, h, dip, ax, rot}) */
  hills: Hill[];
  /** legacy ponds ({t, z, r, ax, rot}) */
  ponds: Pond[];
  /** building plots per type 0..3 */
  plots: Plot[][];
  cars: ParkedCar[];
  trees: [number, number, TreeData][];
  /** bushes: t, z, reserved radius */
  bushes: Spot[];
  /** sector-bucket count used for chunks */
  chunks: number;
}

export interface WorldResult {
  fragment: SceneFragment;
  hull: HullDesc;
  dynamics: { traffic?: TrafficState };
  layout: WorldLayout;
}

/* ─── helpers ─────────────────────────────────────────────────────────────── */

const UP = [0, 1, 0];
const ID = (s: string): string => 'w.' + s;

export function qualityOf(params: WorldParams): QualityPreset {
  return CORE_CONFIG.QUALITY[params.quality] || CORE_CONFIG.QUALITY.HIGH;
}

/** Sector bucket of an angle (legacy `instance`). */
export const bucketOf = (t: number, CH: number): number => {
  const w = ((t % TAU) + TAU) % TAU;
  return Math.min(CH - 1, (w / TAU * CH) | 0);
};

type Item<T> = [number, number, T];

function bucketize<T>(list: readonly Item<T>[], CH: number): Item<T>[][] {
  const buckets: Item<T>[][] = [];
  for (let b = 0; b < CH; b++) buckets.push([]);
  for (const item of list) buckets[bucketOf(item[0], CH)].push(item);
  return buckets;
}

/* scratch */
const _q = [0, 0, 0, 1], _qs = [0, 0, 0, 1], _p = [0, 0, 0], _s = [1, 1, 1];
const _m = new Float64Array(16);

/** q = surfaceQuat(t) · axisAngle(UP, a) */
function standQuat(t: number, a: number): number[] {
  surfaceQuat(t, _q);
  fromAxisAngle(UP, a, _qs);
  return qmul(_q, _qs, _q) as number[];
}

/**
 * Exactly THREE InstancedMesh.computeBoundingSphere over instances [start,
 * start+count) of `mats` (Float32, as getMatrixAt reads them): the geometry
 * bounding sphere transformed by each matrix, merged with Sphere.union.
 */
export function instanceSphere(geoCenter: readonly number[], geoRadius: number, mats: Float32Array,
  start: number, count: number): [number, number, number, number] {
  let cx = 0, cy = 0, cz = 0, cr = -1;
  for (let i = start; i < start + count; i++) {
    const e = i * 16;
    const x = geoCenter[0], y = geoCenter[1], z = geoCenter[2];
    const w = 1 / (mats[e + 3] * x + mats[e + 7] * y + mats[e + 11] * z + mats[e + 15]);
    const sx = (mats[e] * x + mats[e + 4] * y + mats[e + 8] * z + mats[e + 12]) * w;
    const sy = (mats[e + 1] * x + mats[e + 5] * y + mats[e + 9] * z + mats[e + 13]) * w;
    const sz = (mats[e + 2] * x + mats[e + 6] * y + mats[e + 10] * z + mats[e + 14]) * w;
    const scX = mats[e] * mats[e] + mats[e + 1] * mats[e + 1] + mats[e + 2] * mats[e + 2];
    const scY = mats[e + 4] * mats[e + 4] + mats[e + 5] * mats[e + 5] + mats[e + 6] * mats[e + 6];
    const scZ = mats[e + 8] * mats[e + 8] + mats[e + 9] * mats[e + 9] + mats[e + 10] * mats[e + 10];
    const sr = geoRadius * Math.sqrt(Math.max(scX, scY, scZ));
    /* Sphere.union */
    if (sr < 0) continue;
    if (cr < 0) { cx = sx; cy = sy; cz = sz; cr = sr; continue; }
    if (cx === sx && cy === sy && cz === sz) { cr = Math.max(cr, sr); continue; }
    let vx = sx - cx, vy = sy - cy, vz = sz - cz;
    const k = 1 / (Math.sqrt(vx * vx + vy * vy + vz * vz) || 1);
    vx = vx * k * sr; vy = vy * k * sr; vz = vz * k * sr;
    for (const sgn of [1, -1]) {
      const px = sgn > 0 ? sx + vx : sx - vx;
      const py = sgn > 0 ? sy + vy : sy - vy;
      const pz = sgn > 0 ? sz + vz : sz - vz;
      /* expandByPoint (never empty here) */
      const dx = px - cx, dy = py - cy, dz = pz - cz;
      const l2 = dx * dx + dy * dy + dz * dz;
      if (l2 > cr * cr) {
        const len = Math.sqrt(l2);
        const delta = (len - cr) * 0.5;
        const f = delta / len;
        cx += dx * f; cy += dy * f; cz += dz * f;
        cr += delta;
      }
    }
  }
  return cr < 0 ? [0, 0, 0, -1] : [cx, cy, cz, cr];
}

interface InstFill {
  /** write the instance matrix into _m (Float64Array(16)); may write colour into col */
  (item: Item<unknown>, m: Float64Array, col: Float32Array | null, ci: number): void;
}

/**
 * Legacy `instance()`: buckets by angle, calls `fill` in bucket order (rnd
 * order!), stores Float32 matrices/colours, one chunk per NON-EMPTY bucket
 * with the THREE instance bounding sphere.
 */
function instances<T>(geo: MeshData, list: readonly Item<T>[], CH: number, colors: boolean,
  fill: (item: Item<T>, m: Float64Array, col: Float32Array | null, ci: number) => void): InstanceSet {
  const buckets = bucketize(list, CH);
  const n = list.length;
  const matrices = new Float32Array(n * 16);
  const cols = colors ? new Float32Array(n * 3) : null;
  const chunks: InstanceChunk[] = [];
  const gb = computeBounds(geo);
  let k = 0;
  buckets.forEach((b, bucket) => {
    if (!b.length) return;
    const start = k;
    for (const item of b) {
      (fill as InstFill)(item as Item<unknown>, _m, cols, k * 3);
      matrices.set(_m, k * 16);
      k++;
    }
    chunks.push({ start, count: b.length, bucket, sphere: instanceSphere(gb.center, gb.radius, matrices, start, b.length) });
  });
  const set: InstanceSet = { count: n, matrices, chunks };
  if (cols) set.colors = cols;
  return set;
}

/** Wind attribute: phase = m[12]·0.7 + m[14]·0.3 (legacy instanceMatrix[3][0/2]), scale 1. */
function windOf(matrices: Float32Array, count: number): Float32Array {
  const w = new Float32Array(count * 2);
  for (let k = 0; k < count; k++) {
    w[2 * k] = matrices[k * 16 + 12] * 0.7 + matrices[k * 16 + 14] * 0.3;
    w[2 * k + 1] = 1;
  }
  return w;
}

function linHex(hex: number): [number, number, number] {
  const c = [0, 0, 0];
  setHex(hex, c);
  return [c[0], c[1], c[2]];
}


/* ─── the builder ─────────────────────────────────────────────────────────── */

export function buildWorldFragment(params: WorldParams): WorldResult {
  const C = CORE_CONFIG;
  const Q = qualityOf(params);
  const ci = Q.count;
  const seed = params.seed;
  const sat = params.saturation;
  const rnd = mulberry32(seed);
  const R = C.R, L = C.L, HL = L / 2;
  const CH = Q.chunks || C.CHUNKS;

  const geometries: Record<string, GeometryDesc> = {};
  const materials: Record<string, MaterialDesc> = {};
  const meshes: MeshDesc[] = [];
  const images: Record<string, ImageDesc> = {};
  const lodSets: LodSetDesc[] = [];
  const billboards: BillboardSetDesc[] = [];
  const addGeo = (id: string, m: MeshData): string => { geometries[ID(id)] = toGeometryDesc(m); return ID(id); };
  const addMat = (m: MaterialDesc): string => { materials[m.id] = m; return m.id; };

  /* ─────────── hull ─────────── */
  const hills = placeHills(mulberry32(seed + 404), R, L);
  const hull = hullGeo(R, L, Q.rings ? C.HULL_SEG : 128, Q.rings || C.HULL_RINGS, hills);
  const ponds = pondsOf(hills);

  /* Images come from the texture registry (exact legacy set and specs);
     the fragment lists only the ones world materials / the hull reference. */
  const std = standardImages({ seed, quality: params.quality, ponds: ponds.map(p => ({ ...p })) });
  const use = (id: string): void => {
    const d = std[id];
    if (!d) throw new Error('world: no standard image ' + id);
    images[id] = d;
  };
  use(TEX.hullAlbedo);
  use(TEX.hullMask);
  use(TEX.detail);
  if (Q.normals) {
    use(TEX.hullNormal);
  }
  use(TEX.waterRough);
  use(TEX.waterNormal);

  const arms: number[] = [];
  for (let k = 0; k < C.AXIS.sparArms; k++) arms.push((C.AXIS.sparAngle + k * 360 / C.AXIS.sparArms) * D2R);

  const hullMat = addMat({
    id: ID('hull'), model: 'hull', baseColor: [1, 1, 1], map: TEX.hullAlbedo,
    roughness: 0.95, metalness: 0.02, side: 'front', alpha: 'opaque', kernels: ['hull'],
    /* AS-RENDERED scale (types.ts): legacy BackSide hull rendered (−1, −1) — three negated it */
    ...(Q.normals ? { normalMap: TEX.hullNormal, normalScale: [-1, -1] as [number, number] } : {})
  });
  meshes.push({ role: 'hull', geometry: addGeo('hull', hull), materials: [hullMat], collider: true, parent: 'station' });

  /* ─────────── placement ─────────── */
  const placer = createPlacer(ponds);
  const plots = cityPlots(placer, seed);
  const prints: [number, number, number, number, number][] = [];
  const shadows: Item<{ r: number; up: number }>[] = [];

  /* ─────────── buildings: 4 silhouettes × own facade ─────────── */
  const tints = [0x9fb0c4, 0xb6c2cf, 0x8c9db2, 0xc3ccd6, 0x7f90a5, 0xc9b7a4];
  use(TEX.roof);
  if (Q.normals) {
    use(TEX.roofNormal);
  }
  const roofMat = addMat({
    id: ID('bld.roof'), model: 'standard', baseColor: [1, 1, 1], map: TEX.roof,
    roughness: 0.92, metalness: 0.04, side: 'front', alpha: 'opaque',
    ...(Q.normals ? { normalMap: TEX.roofNormal, normalScale: [0.8, 0.8] as [number, number] } : {})
  });
  for (let v = 0; v < 4; v++) {
    use(TEX.facade(v));
    use(TEX.facadeEmissive(v));
    if (Q.normals) {
      use(TEX.facadeNormal(v));
    }
    const wallMat = addMat({
      id: ID('bld.wall.' + v), model: 'standard', baseColor: [1, 1, 1], map: TEX.facade(v),
      emissive: [1, 1, 1], emissiveMap: TEX.facadeEmissive(v), emissiveIntensity: 0, emissiveDrive: { param: 'windowEmission' },
      channel: 'windows', roughness: 0.68, metalness: 0.1, side: 'front', alpha: 'opaque', instanceColors: true,
      ...(Q.normals ? { normalMap: TEX.facadeNormal(v), normalScale: [1, 1] as [number, number] } : {})
    });
    const S = C.BLD[v];
    const set = instances(buildingGeo(v), plots[v], CH, true, (item, m, col, o) => {
      const [t, z, info] = item;
      const h = pickFloors(info.floors, S.floors) * C.FLOOR_H;
      const w = S.w[0] + info.w * (S.w[1] - S.w[0]);
      const d = S.w[0] + info.d * (S.w[1] - S.w[0]);
      standQuat(t, info.spin * Math.PI / 2);
      surfacePos(t, R - h / 2, z, _p);
      _s[0] = w; _s[1] = h; _s[2] = d;
      compose(_p, _q, _s, m);
      natural(tints[(info.tint * tints.length) | 0], 0.5 + sat * 0.5, col as Float32Array, o);
      prints.push([t, z, w, d, info.spin]);
    });
    meshes.push({
      role: 'bld.' + v, geometry: addGeo('bld.' + v, buildingGeo(v)), materials: [wallMat, roofMat],
      instances: set, sectored: true, parent: 'station'
    });
  }

  /* ─────────── parked cars ─────────── */
  const cars = parkedCars(placer, seed);
  if (cars.length) {
    const carCols = [0xb9c2cb, 0x8a94a0, 0x6d4f46, 0x39506b, 0xa8564a, 0xd8d2c4];
    const carMat = addMat({ id: ID('cars.parked'), model: 'standard', baseColor: [1, 1, 1], roughness: 0.42, metalness: 0.35,
      side: 'front', alpha: 'opaque', instanceColors: true });
    const body = carBodyGeo();
    const list = cars.map(([t, z, vert, r2]) => [t, z, { vert, r2 }] as Item<{ vert: boolean; r2: number }>);
    const set = instances(body, list, CH, true, (item, m, col, o) => {
      const [t, z, c] = item;
      standQuat(t, c.vert ? 0 : Math.PI / 2);
      surfacePos(t, R - 0.07, z, _p);
      _s[0] = 1; _s[1] = 1; _s[2] = 1;
      compose(_p, _q, _s, m);
      natural(carCols[(c.r2 * carCols.length) | 0], 0.7, col as Float32Array, o);
    });
    meshes.push({ role: 'cars.parked', geometry: addGeo('cars.parked', body), materials: [carMat], instances: set, sectored: true, parent: 'station' });
  }

  /* the panel texture (legacy makePanelTexture(SEED+53) in buildWorld) is
     declared by the structures fragment, its only consumer */

  /* ─────────── trees ─────────── */
  const relief = reliefList(hills);
  const TR = C.TREE;
  const treeH = (): number => {
    const u = Math.pow((rnd() + rnd()) / 2, TR.bias);
    return TR.h[0] + u * (TR.h[1] - TR.h[0]);
  };
  const density = params.greenK;
  const spaceK = 1 / Math.sqrt(Math.max(0.2, density));
  const treeSpots = placer.sample(rnd, W_TREE, Math.round(C.COUNT.trees[ci] * Q.trees * density),
    () => treeH() * TR.crown * TR.spacing * spaceK, true);
  const SZ = C.SEASONS[params.season] || C.SEASONS.summer;
  const trees: Item<TreeData>[] = [];
  for (const [t, z, r] of treeSpots) {
    const H = r / (TR.crown * TR.spacing);
    trees.push([t, z, {
      H, th: H * TR.trunk, tr: H * TR.crown,
      up: reliefAt(relief, t, z, R),
      spin: rnd() * TAU, squash: 0.85 + rnd() * 0.45,
      fall: rnd() < SZ.accent, tint: rnd()
    }]);
  }

  const trunkMat = addMat({ id: ID('trunks'), model: 'standard', baseColor: linHex(0x6b5236), roughness: 1, metalness: 0,
    side: 'front', alpha: 'opaque', vertexColors: true });
  const trunk = trunkGeo();
  meshes.push({
    role: 'trunks', geometry: addGeo('trunks', trunk), materials: [trunkMat], sectored: true, parent: 'station',
    instances: instances(trunk, trees, CH, false, (item, m) => {
      const [t, z, o] = item;
      surfaceQuat(t, _q);
      surfacePos(t, R - o.up - o.th / 2, z, _p);
      _s[0] = o.H; _s[1] = o.th; _s[2] = o.H;
      compose(_p, _q, _s, m);
    })
  });

  /* crowns: three LOD levels over one population */
  const FOL = C.FOLIAGE, det = Q.foliage;
  use(TEX.leaf);
  if (Q.normals) use(TEX.leafNormal);
  const leafN = Q.normals ? { normalMap: TEX.leafNormal, normalScale: [1.1, 1.1] as [number, number] } : {};
  const crownMats = [
    addMat({ id: ID('crowns.lod0'), model: 'standard', baseColor: [1, 1, 1], roughness: 0.9, metalness: 0, side: 'front',
      alpha: 'opaque', flatShading: true, vertexColors: true, instanceColors: true, flatDither: FOL.dither, kernels: ['wind'], ...leafN }),
    addMat({ id: ID('crowns.lod1'), model: 'standard', baseColor: [1, 1, 1], roughness: 0.9, metalness: 0, side: 'front',
      alpha: 'opaque', flatShading: true, vertexColors: true, instanceColors: true, flatDither: FOL.dither, ...leafN }),
    addMat({ id: ID('crowns.lod2'), model: 'standard', baseColor: [1, 1, 1], map: TEX.leaf, roughness: 0.95, metalness: 0,
      side: 'double', alpha: { mask: 0.5 }, vertexColors: true, instanceColors: true })
  ];
  const crownGeos = [
    addGeo('crowns.lod0', foliageGeo(det, mulberry32(seed + 5), FOL.wobble, FOL.dither)),
    addGeo('crowns.lod1', foliageGeo(Math.max(0, det - 1), mulberry32(seed + 5), FOL.wobble, FOL.dither)),
    addGeo('crowns.lod2', crossQuadGeo())
  ];
  {
    const buckets = bucketize(trees, CH);
    const n = trees.length;
    const matrices = new Float32Array(n * 16), colors = new Float32Array(n * 3), centers = new Float32Array(n * 3);
    const chunks: InstanceChunk[] = [];
    let k = 0;
    buckets.forEach((b, bucket) => {
      if (!b.length) return;
      const start = k;
      for (const [t, z, o] of b) {
        standQuat(t, o.spin);
        surfacePos(t, R - o.up - (o.th + o.tr * 0.55), z, _p);
        _s[0] = o.tr; _s[1] = o.tr * o.squash; _s[2] = o.tr;
        compose(_p, _q, _s, _m);
        matrices.set(_m, k * 16);
        centers[k * 3] = _p[0]; centers[k * 3 + 1] = _p[1]; centers[k * 3 + 2] = _p[2];
        const pal = o.fall ? SZ.accents : SZ.greens;
        natural(pal[(o.tint * pal.length) | 0], sat, colors, k * 3);
        shadows.push([t, z, { r: o.tr * 1.5, up: o.up }]);
        k++;
      }
      chunks.push({ start, count: b.length, bucket, sphere: sectorSphere(b, R) });
    });
    const TL = C.TREE_LOD;
    lodSets.push({
      role: 'crowns',
      levels: [0, 1, 2].map(li => ({ geometry: crownGeos[li], material: crownMats[li], role: 'crowns.lod' + li })),
      near: TL.near, mid: TL.mid, step: TL.step,
      matrices, colors, centers, wind: windOf(matrices, n), chunks
    });
  }

  /* tufts at the trunk base */
  {
    const tuftMat = addMat({ id: ID('tufts'), model: 'standard', baseColor: linHex(0x5c8a3c), roughness: 1, metalness: 0,
      side: 'double', alpha: 'opaque', flatShading: true, kernels: ['wind'] });
    const g = tuftGeo();
    const set = instances(g, trees, CH, false, (item, m) => {
      const [t, z, o] = item;
      const s = C.TREE.tuft * (0.7 + o.H * 0.5);
      standQuat(t, o.spin);
      surfacePos(t, R - o.up, z, _p);
      _s[0] = s; _s[1] = s; _s[2] = s;
      compose(_p, _q, _s, m);
    });
    set.wind = windOf(set.matrices, set.count);
    meshes.push({ role: 'tufts', geometry: addGeo('tufts', g), materials: [tuftMat], instances: set, sectored: true, parent: 'station' });
  }

  /* ─────────── bushes ─────────── */
  let bushSpots: Spot[];
  {
    const bushMat = addMat({ id: ID('bushes'), model: 'standard', baseColor: [1, 1, 1], roughness: 1, metalness: 0,
      side: 'front', alpha: 'opaque', flatShading: true, vertexColors: true, instanceColors: true,
      flatDither: FOL.dither, kernels: ['wind'] });
    const bushCols = SZ.bushes;
    const BS = C.BUSH;
    const bushS = (): number => BS.s[0] + rnd() * (BS.s[1] - BS.s[0]);
    const g = foliageGeo(0, mulberry32(seed + 6), FOL.wobble * 1.3, FOL.dither);
    const spots = placer.sample(rnd, W_BUSH, Math.round(C.COUNT.bushes[ci] * Q.trees * params.greenK),
      () => bushS() * BS.spacing, true);
    const set = instances(g, spots, CH, true, (item, m, col, o) => {
      const [t, z, rad] = item;
      const s = rad / BS.spacing, up = reliefAt(relief, t, z, R);
      standQuat(t, rnd() * TAU);
      surfacePos(t, R - up - s * BS.flat * 0.45, z, _p);
      _s[0] = s; _s[1] = s * BS.flat; _s[2] = s;
      compose(_p, _q, _s, m);
      natural(pick(rnd, bushCols), sat, col as Float32Array, o);
    });
    set.wind = windOf(set.matrices, set.count);
    meshes.push({ role: 'bushes', geometry: addGeo('bushes', g), materials: [bushMat], instances: set, sectored: true, parent: 'station' });
    bushSpots = spots;
  }

  /* ─────────── contact shadows ─────────── */
  const decal = decalGeo();
  const decalId = addGeo('decal', decal);
  use(TEX.blob);
  const blobMat = addMat({ id: ID('blob'), model: 'decal', baseColor: [1, 1, 1], map: TEX.blob, roughness: 1, metalness: 0,
    side: 'front', alpha: { blend: { param: 'blobOpacity' } }, depthWrite: false, renderOrder: 1, rasterOnly: true });
  if (!Q.footprint) for (const [t, z, w2, d2] of prints) shadows.push([t, z, { r: Math.max(w2, d2) * 0.75, up: 0 }]);
  meshes.push({
    role: 'blob', geometry: decalId, materials: [blobMat], sectored: true, parent: 'station', only: 'raster',
    instances: instances(decal, shadows, CH, false, (item, m) => {
      const [t, z, info] = item;
      surfaceQuat(t, _q);
      surfacePos(t, R - info.up - 0.04, z, _p);
      _s[0] = info.r * 2; _s[1] = 1; _s[2] = info.r * 2;
      compose(_p, _q, _s, m);
    })
  });
  if (Q.footprint) {
    use(TEX.footprint);
    const printMat = addMat({ id: ID('print'), model: 'decal', baseColor: [1, 1, 1], map: TEX.footprint, roughness: 1, metalness: 0,
      side: 'front', alpha: { blend: { param: 'printOpacity' } }, depthWrite: false, renderOrder: 1, rasterOnly: true });
    const P = C.PRINT;
    const list = prints.map(([t, z, w2, d2, spin]) => [t, z, { w: w2, d: d2, spin }] as Item<{ w: number; d: number; spin: number }>);
    meshes.push({
      role: 'print', geometry: decalId, materials: [printMat], sectored: true, parent: 'station', only: 'raster',
      instances: instances(decal, list, CH, false, (item, m) => {
        const [t, z, o] = item;
        const along = o.spin % 2;
        standQuat(t, o.spin * Math.PI / 2);
        surfacePos(t, R - 0.05, z, _p);
        _s[0] = (along ? o.d : o.w) * P.across; _s[1] = 1; _s[2] = (along ? o.w : o.d) * P.along;
        compose(_p, _q, _s, m);
      })
    });
  }

  /* ─────────── traffic ─────────── */
  let traffic: TrafficState | undefined;
  {
    const roads = trafficRoads();
    if (roads.length) {
      const T2 = C.TRAFFIC;
      const per = T2.perLane;
      const n = roads.length * per;
      const tint = [0x9aa4b0, 0x6f7b88, 0x8a5a4e, 0x40566e, 0xb4b0a6, 0x55606c];
      const colors = new Float32Array(n * 3);
      for (let k = 0; k < n; k++) natural(tint[(rnd() * tint.length) | 0], 0.75, colors, k * 3);
      const half = C.CITY.street * 0.22;
      const lanes: TrafficState['lanes'] = [];
      for (const road of roads) {
        for (const dir of [-1, 1] as const) lanes.push({ theta: road + dir * half / R, dir, speed: T2.speed });
      }
      const lane = new Uint16Array(n), z = new Float64Array(n);
      const off = new Float32Array(1);
      for (let k = 0; k < n; k++) {
        const dir = k % 2 ? 1 : -1;
        lane[k] = 2 * ((k / per) | 0) + (dir > 0 ? 1 : 0);
        off[0] = rnd() * L;                       // legacy Float32Array storage
        off[0] = (off[0] + dir * T2.speed * 0 + L) % L;   // legacy updateTraffic(0)
        z[k] = off[0] - HL;
      }
      traffic = { lanes, lane, z, role: 'traffic' };
      const matrices = trafficMatrices(traffic, new Float32Array(n * 16));
      const allSphere: [number, number, number, number] = [0, 0, 0, Math.hypot(R, HL)];
      const bodyGeo = trafficBodyGeo(), lampGeo = trafficLampGeo();
      use(TEX.carWindows);
      const bodyMat = addMat({ id: ID('traffic.body'), model: 'standard', baseColor: linHex(0x2c3340), roughness: 0.35, metalness: 0.5,
        emissive: [1, 1, 1], emissiveMap: TEX.carWindows, emissiveIntensity: 0, emissiveDrive: { param: 'trafficWindow' },
        channel: 'trafficBody',
        side: 'front', alpha: 'opaque', instanceColors: true });
      /* Lamps are COLOUR multipliers in legacy: colour = base × trafficLamp
         (lightingAt). Backends implement that drive for channel 'trafficLamp'. */
      const front = addMat({ id: ID('traffic.lamp.front'), model: 'unlit', baseColor: [1, 0.96, 0.85],
        channel: 'trafficLamp', roughness: 1, metalness: 0,
        side: 'front', alpha: 'opaque', toneMapped: false });
      const rear = addMat({ id: ID('traffic.lamp.rear'), model: 'unlit', baseColor: [0.4, 0.004, 0.0015],
        channel: 'trafficLamp', roughness: 1, metalness: 0,
        side: 'front', alpha: 'opaque', toneMapped: false });
      meshes.push({
        role: 'traffic.body', geometry: addGeo('traffic.body', bodyGeo), materials: [bodyMat], parent: 'station', dynamic: 'traffic',
        instances: { count: n, matrices, colors, chunks: [{ start: 0, count: n, sphere: allSphere }] }
      });
      meshes.push({
        role: 'traffic.lamp', geometry: addGeo('traffic.lamp', lampGeo), materials: [front, rear], parent: 'station', dynamic: 'traffic',
        /* shares the body's matrices: stepDynamics writes one array per dynamic key */
        instances: { count: n, matrices, chunks: [{ start: 0, count: n, sphere: allSphere }] }
      });
    }
  }

  /* ─────────── nav lights ─────────── */
  {
    const np: number[] = [];
    for (let deg = 0; deg < 360; deg += 15) {
      const t = deg * D2R;
      for (let zz = -HL + 6; zz <= HL - 6; zz += 15) np.push(Math.sin(t) * 49.5, Math.cos(t) * 49.5, zz);
    }
    for (const zc of [-HL + 2, HL - 2]) {
      for (let deg = 0; deg < 360; deg += 6) {
        const t = deg * D2R;
        np.push(Math.sin(t) * 49.2, Math.cos(t) * 49.2, zc);
      }
    }
    use(TEX.spriteNav);
    const navMat = addMat({ id: ID('nav'), model: 'sprite', baseColor: linHex(0xffcf8a), map: TEX.spriteNav, roughness: 1, metalness: 0,
      side: 'front', alpha: { blend: { param: 'navIntensity' }, additive: true }, depthWrite: false, channel: 'nav' });
    billboards.push({ role: 'nav', positions: new Float32Array(np), size: { param: 'navSize' }, material: navMat, parent: 'station' });
  }

  /* ─────────── hull descriptor ─────────── */
  const hd = C.HILL.dipDepth;
  const hillDescs: HillDesc[] = hills.map(h => {
    const d: HillDesc = { theta: h.t, z: h.z, r: h.r, rise: h.dip ? -h.h * hd : h.h, ax: h.ax, rot: h.rot };
    /* same value as the legacy pond record (pondsOf: r · 0.62 = r · HILL.pondFill) */
    if (h.dip) d.pond = { r: h.r * 0.62 };
    return d;
  });
  const hullDesc: HullDesc = {
    role: 'hull', mask: TEX.hullMask, detail: TEX.detail, detailRep: C.DETAIL_REP,
    armAngles: arms, sparZ: C.AXIS.spars.slice(), hills: hillDescs
  };

  /* emissive surfaces for the tracers (raster uses the materials directly) */
  const emitters: EmitterDesc[] = [];
  for (let v = 0; v < 4; v++) emitters.push({ kind: 'meshEmission', role: 'bld.' + v, channel: 'windows' });
  if (traffic) {
    emitters.push({ kind: 'meshEmission', role: 'traffic.body', channel: 'trafficBody' });
    emitters.push({ kind: 'meshEmission', role: 'traffic.lamp', channel: 'trafficLamp' });
  }

  const fragment: SceneFragment = { geometries, materials, meshes, lodSets, billboards, emitters, images };
  return {
    fragment, hull: hullDesc,
    dynamics: traffic ? { traffic } : {},
    layout: { hills, ponds, plots, cars, trees, bushes: bushSpots, chunks: CH }
  };
}


/** Crown chunk sphere (legacy sectorSphere): centroid of the surface points + max distance + 4. */
function sectorSphere(list: readonly Item<unknown>[], R: number): [number, number, number, number] {
  let cx = 0, cy = 0, cz = 0;
  const v = [0, 0, 0];
  for (const [t, z] of list) { surfacePos(t, R, z, v); cx += v[0]; cy += v[1]; cz += v[2]; }
  const k = 1 / Math.max(1, list.length);
  cx *= k; cy *= k; cz *= k;
  let rad = 0;
  for (const [t, z] of list) {
    surfacePos(t, R, z, v);
    const dx = cx - v[0], dy = cy - v[1], dz = cz - v[2];
    rad = Math.max(rad, Math.sqrt(dx * dx + dy * dy + dz * dz));
  }
  return [cx, cy, cz, rad + 4];
}
