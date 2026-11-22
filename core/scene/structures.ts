/* ═══════════════════════════════════════════════════════════════════════════
   Structures fragment — port of js/structures.js buildStructures() to plain
   data (SceneFragment). Roles, order, geometry and raster material params
   mirror the legacy objects exactly (checked against test/golden by
   core/test/structures-golden.test.ts).

   Every legacy object lives in worldGroup (it rotates with the habitat), so
   all meshes have parent 'station'. The legacy Group 'tower' (surface frame
   + Y scale modelH → h) has no MeshDesc: its matrix is baked into the
   transforms of tower.concrete / tower.glass / tower.beacon.

   Emission (tracers): the sun tube is an analytic 'tube' emitter (role
   axis.sun); lift lamps, lift glazing, tower glazing, the beacon and the
   endcap glow are 'meshEmission' emitters on their roles. Palette channels:
     lift.lamp   → liftLamp     (legacy: constant HDR colour, toneMapped off)
     lift.glass  → liftGlass    (legacy: emissiveIntensity = lerp(1.4, 0.3, daylight))
     tower.glass → towerGlass   (legacy: emissiveIntensity = winEmis · 0.45)
     endcap.disc → towerGlass   (legacy: SAME driver as tower glass, winEmis · 0.45,
                                 it sits in structMats.glass — so it shares the channel)
     tower.beacon→ beacon       (legacy: 0.2 + night · flicker)
     axis.sun    → tube
   emissiveNits = the channel's peak luminance over the phases (CORE_CONFIG.PHYS),
   i.e. the material's luminance at full channel power.
   Raster emissiveIntensity fields keep the legacy INITIAL values; the
   backends drive them per frame from the channel.
   ═══════════════════════════════════════════════════════════════════════════ */

import { CORE_CONFIG } from '../config/index.ts';
import type { MeshData } from '../geometry/mesh.ts';
import { toGeometryDesc } from '../geometry/mesh.ts';
import {
  collars, endcapDisc, endcapHub, endcapInstanceMatrices, liftBody, liftGlass, liftLamp,
  spine, sunTube, towerBeacon, towerConcrete, towerGlass, towerGroupMatrix, beaconY, trussColumn
} from '../geometry/structures/index.ts';
import { surfaceMatrix } from '../geometry/shapes/surface.ts';
import { setHex } from '../math/color.ts';
import * as m4 from '../math/mat4.ts';
import { TEX } from '../textures/ids.ts';
import type {
  EmitterDesc, GeometryDesc, ImageDesc, InstanceChunk, InstanceSet, Linear3, LiftState,
  MaterialDesc, MeshDesc, PaletteChannel, SceneFragment, WorldParams
} from './types.ts';
import { initialLifts, liftLimit, liftMatrices, liftRadius } from './structuresDynamics.ts';

const D2R = Math.PI / 180;

/* Thin-glass parameters for tracers (no legacy counterpart: the raster fakes
   glazing with a dark metallic surface). */
const GLASS_TINT: Linear3 = [...CORE_CONFIG.GLASS.tint] as Linear3;
const GLASS_IOR = CORE_CONFIG.GLASS.ior;

/* Legacy texture details (js/world.js / js/structures.js / js/textures.js). */
const PANEL_SIZE = 512;
const PANEL_SEED_OFFSET = 53;
const PANEL_ANISO = 4;               // panel.anisotropy = min(4, maxAniso)
const ENDCAP_SEED_OFFSET = 99;
const ENDCAP_SIZE = { low: 512, high: 1024 };
const ENDCAP_ANISO = 8;              // map.anisotropy = min(8, maxAniso)
const ENDCAP_NORMAL_SIZE = 1024;

const lin = (hex: number): Linear3 => setHex(hex, [0, 0, 0]) as Linear3;

/** Peak luminance of a palette channel over the day cycle. */
function peakNits(ch: PaletteChannel): number {
  let n = 0;
  for (const p of CORE_CONFIG.PHASES) n = Math.max(n, CORE_CONFIG.PHYS[p].channelNits[ch]);
  return n;
}

/* ─── images ──────────────────────────────────────────────────────────────── */

function img(size: number, srgb: boolean, repeat: boolean, aniso: number,
  gen: string, args: Record<string, unknown>): ImageDesc {
  return {
    width: size, height: size, format: 'rgba8', colorSpace: srgb ? 'srgb' : 'linear',
    wrap: repeat ? 'repeat' : 'clamp', mipmaps: true, origin: 'top-left',
    anisotropyHint: aniso, source: { gen, args }
  };
}

function structureImages(params: WorldParams, normals: boolean, low: boolean): Record<string, ImageDesc> {
  const images: Record<string, ImageDesc> = {};
  const capSize = low ? ENDCAP_SIZE.low : ENDCAP_SIZE.high;
  const capSeed = params.seed + ENDCAP_SEED_OFFSET;
  images[TEX.panel] = img(PANEL_SIZE, true, true, PANEL_ANISO, 'panelTexture',
    { seed: params.seed + PANEL_SEED_OFFSET });
  if (normals) {
    /* legacy heightToNormal(panelCanvas, NORMALS.panel): size 0 = source size */
    images[TEX.panelNormal] = img(PANEL_SIZE, false, true, 1, 'heightToNormal',
      { src: images[TEX.panel].source, strength: CORE_CONFIG.NORMALS.panel, size: 0 });
  }
  images[TEX.endcap] = img(capSize, true, false, ENDCAP_ANISO, 'endCapTexture',
    { size: capSize, seed: capSeed, output: 'map' });
  images[TEX.endcapEmissive] = img(capSize, true, false, 1, 'endCapTexture',
    { size: capSize, seed: capSeed, output: 'emissive' });
  if (normals) {
    images[TEX.endcapNormal] = img(ENDCAP_NORMAL_SIZE, false, true, 1, 'heightToNormal',
      { src: images[TEX.endcap].source, strength: CORE_CONFIG.NORMALS.endcap, size: ENDCAP_NORMAL_SIZE });
  }
  return images;
}

/* ─── materials ───────────────────────────────────────────────────────────── */

export const STRUCT_MAT = {
  sun: 's.sun',
  metal: 's.metal',
  liftBody: 's.lift.body',
  liftLamp: 's.lift.lamp',
  liftGlass: 's.lift.glass',
  concrete: 's.tower.concrete',
  towerGlass: 's.tower.glass',
  beacon: 's.tower.beacon',
  endcap: 's.endcap.disc',
  hub: 's.endcap.hub'
} as const;

function structureMaterials(normals: boolean): Record<string, MaterialDesc> {
  const panelNormal = normals ? { normalMap: TEX.panelNormal } : {};
  const L = CORE_CONFIG.LIFTCAR;
  const list: MaterialDesc[] = [
    {
      /* MeshBasicMaterial + fadeByFog; colour is re-driven per frame from
         LightingState.sunColor · sunEmission · SUN_HDR (legacy applyPalette) */
      id: STRUCT_MAT.sun, model: 'unlit', baseColor: lin(CORE_CONFIG.DAY.sunCol),
      roughness: 1, metalness: 0, side: 'double', alpha: { blend: 1 }, toneMapped: false,
      kernels: ['fogFade'], channel: 'tube', emissiveNits: peakNits('tube')
    },
    {
      id: STRUCT_MAT.metal, model: 'standard', baseColor: lin(0x9099a3),
      map: TEX.panel, ...panelNormal, roughness: 0.45, metalness: 0.62,
      side: 'front', alpha: 'opaque'
    },
    {
      id: STRUCT_MAT.liftBody, model: 'standard', baseColor: lin(L.color),
      map: TEX.panel, ...panelNormal, roughness: 0.6, metalness: 0.12,
      side: 'double', alpha: 'opaque'
    },
    {
      /* MeshBasicMaterial with an HDR linear colour (THREE.Color(r, g, b) stores linear as is) */
      id: STRUCT_MAT.liftLamp, model: 'unlit', baseColor: [L.lamp, L.lamp * 0.94, L.lamp * 0.82],
      roughness: 1, metalness: 0, side: 'front', alpha: 'opaque', toneMapped: false,
      channel: 'liftLamp', emissiveNits: peakNits('liftLamp')
    },
    {
      id: STRUCT_MAT.liftGlass, model: 'thinGlass', baseColor: lin(0x16283c),
      roughness: 0.1, metalness: 0.7, emissive: lin(0xffe0b0), emissiveIntensity: 0.35,
      side: 'double', alpha: { blend: 1 }, channel: 'liftGlass', emissiveNits: peakNits('liftGlass'),
      emissiveDrive: { param: 'liftGlassEmission' },
      transmissionTint: GLASS_TINT, ior: GLASS_IOR
    },
    {
      id: STRUCT_MAT.concrete, model: 'standard', baseColor: lin(0xc0a993),
      map: TEX.panel, ...panelNormal, roughness: 0.78, metalness: 0.06,
      side: 'front', alpha: 'opaque'
    },
    {
      id: STRUCT_MAT.towerGlass, model: 'thinGlass', baseColor: lin(0x16283c),
      roughness: 0.09, metalness: 0.72, emissive: lin(0xffe6bd), emissiveIntensity: 0,
      side: 'front', alpha: 'opaque', channel: 'towerGlass', emissiveNits: peakNits('towerGlass'),
      emissiveDrive: { param: 'windowEmission', scale: 0.45 },
      transmissionTint: GLASS_TINT, ior: GLASS_IOR
    },
    {
      id: STRUCT_MAT.beacon, model: 'standard', baseColor: lin(0x30414f),
      roughness: 0.4, metalness: 0, emissive: lin(0xff5c3a), emissiveIntensity: 0.2,
      side: 'front', alpha: 'opaque', channel: 'beacon', emissiveNits: peakNits('beacon')
    },
    {
      id: STRUCT_MAT.endcap, model: 'standard', baseColor: [1, 1, 1],
      map: TEX.endcap, emissiveMap: TEX.endcapEmissive, emissive: [1, 1, 1], emissiveIntensity: 0,
      ...(normals ? { normalMap: TEX.endcapNormal, normalScale: [1, 1] as [number, number] } : {}),
      roughness: 0.85, metalness: 0.12, side: 'double', alpha: 'opaque',
      channel: 'towerGlass', emissiveNits: peakNits('towerGlass'),
      emissiveDrive: { param: 'windowEmission', scale: 0.45 }
    },
    {
      id: STRUCT_MAT.hub, model: 'standard', baseColor: lin(0xa7b0ba),
      roughness: 0.45, metalness: 0.55, side: 'front', alpha: 'opaque'
    }
  ];
  const out: Record<string, MaterialDesc> = {};
  for (const m of list) out[m.id] = m;
  return out;
}

/* ─── instances ───────────────────────────────────────────────────────────── */

/** One chunk covering all instances: bounding spheres of the transformed geometry sphere. */
function instanceSet(matrices: Float32Array, geo: GeometryDesc): InstanceSet {
  const count = matrices.length / 16;
  const c = geo.bounds.center, r = geo.bounds.radius;
  const centers: number[] = [], radii: number[] = [];
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let k = 0; k < count; k++) {
    const m = matrices.subarray(16 * k, 16 * k + 16);
    const p = m4.transformPoint(m, c);
    const s = Math.max(Math.hypot(m[0], m[1], m[2]), Math.hypot(m[4], m[5], m[6]), Math.hypot(m[8], m[9], m[10]));
    centers.push(p[0], p[1], p[2]); radii.push(r * s);
    minX = Math.min(minX, p[0]); minY = Math.min(minY, p[1]); minZ = Math.min(minZ, p[2]);
    maxX = Math.max(maxX, p[0]); maxY = Math.max(maxY, p[1]); maxZ = Math.max(maxZ, p[2]);
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
  let R = 0;
  for (let k = 0; k < count; k++) {
    R = Math.max(R, Math.hypot(centers[3 * k] - cx, centers[3 * k + 1] - cy, centers[3 * k + 2] - cz) + radii[k]);
  }
  const chunks: InstanceChunk[] = [{ start: 0, count, sphere: [cx, cy, cz, R] }];
  return { count, matrices, chunks };
}

/** Lifts move: the chunk sphere covers the whole travel along the axis. */
function liftInstanceSet(matrices: Float32Array, geo: GeometryDesc, count: number): InstanceSet {
  const R = Math.hypot(liftRadius(), liftLimit()) + geo.bounds.radius;
  return { count, matrices, chunks: [{ start: 0, count, sphere: [0, 0, 0, R] }] };
}

/* ─── build ───────────────────────────────────────────────────────────────── */

export interface StructuresResult {
  fragment: SceneFragment;
  /** initial monorail state (legacy after updateStructures(0)); its matrices
      are the ones shared by the lift.* MeshDescs */
  lifts: LiftState;
}

export function buildStructuresFragment(params: WorldParams): StructuresResult {
  const Q = CORE_CONFIG.QUALITY[params.quality] || CORE_CONFIG.QUALITY.HIGH;
  const normals = Q.normals > 0;
  const low = params.quality === 'LOW';
  const A = CORE_CONFIG.AXIS, R = CORE_CONFIG.R;

  const geometries: Record<string, GeometryDesc> = {};
  const geo = (role: string, m: MeshData): string => {
    const id = 's.' + role;
    geometries[id] = toGeometryDesc(m);
    return id;
  };
  const meshes: MeshDesc[] = [];
  const add = (d: MeshDesc): MeshDesc => { meshes.push(d); return d; };

  /* --- axis --- */
  add({ role: 'axis.sun', geometry: geo('axis.sun', sunTube()), materials: [STRUCT_MAT.sun], parent: 'station' });
  add({ role: 'axis.spine', geometry: geo('axis.spine', spine()), materials: [STRUCT_MAT.metal], parent: 'station' });

  /* --- monorail cabins: one instance per rail; the three meshes share matrices --- */
  const lifts = initialLifts();
  const liftMats = liftMatrices(lifts, new Float32Array(16 * lifts.count));
  const liftParts: [string, MeshData, string][] = [
    ['lift.body', liftBody(), STRUCT_MAT.liftBody],
    ['lift.lamp', liftLamp(), STRUCT_MAT.liftLamp],
    ['lift.glass', liftGlass(), STRUCT_MAT.liftGlass]
  ];
  for (const [role, m, mat] of liftParts) {
    const g = geo(role, m);
    add({
      role, geometry: g, materials: [mat], parent: 'station', dynamic: 'lifts',
      instances: liftInstanceSet(liftMats, geometries[g], lifts.count)
    });
  }

  add({ role: 'axis.collars', geometry: geo('axis.collars', collars()), materials: [STRUCT_MAT.metal], parent: 'station' });

  /* --- support columns: spars × arms --- */
  {
    const trussMats = new Float32Array(16 * A.spars.length * A.sparArms);
    const m = new Float64Array(16);
    let n = 0;
    for (const z of A.spars) {
      for (let k = 0; k < A.sparArms; k++) {
        const t = (A.sparAngle + k * 360 / A.sparArms) * D2R;
        surfaceMatrix(t, R - 1, z, undefined, m);
        trussMats.set(m, 16 * n++);
      }
    }
    const g = geo('truss', trussColumn());
    add({ role: 'truss', geometry: g, materials: [STRUCT_MAT.metal], parent: 'station',
      instances: instanceSet(trussMats, geometries[g]) });
  }

  /* --- Command Tower: group matrix baked into each child --- */
  {
    const G = towerGroupMatrix(new Float64Array(16));
    const toF32 = (m: ArrayLike<number>): Float32Array => Float32Array.from(m);
    add({ role: 'tower.concrete', geometry: geo('tower.concrete', towerConcrete()), materials: [STRUCT_MAT.concrete],
      transform: toF32(G), parent: 'station' });
    add({ role: 'tower.glass', geometry: geo('tower.glass', towerGlass()), materials: [STRUCT_MAT.towerGlass],
      transform: toF32(G), parent: 'station' });
    const beaconWorld = m4.multiply(G, m4.makeTranslation(0, beaconY(), 0), new Float64Array(16));
    add({ role: 'tower.beacon', geometry: geo('tower.beacon', towerBeacon()), materials: [STRUCT_MAT.beacon],
      transform: toF32(beaconWorld), parent: 'station' });
  }

  /* --- end caps: two instances each --- */
  {
    const gd = geo('endcap.disc', endcapDisc());
    add({ role: 'endcap.disc', geometry: gd, materials: [STRUCT_MAT.endcap], parent: 'station',
      instances: instanceSet(endcapInstanceMatrices(true), geometries[gd]) });
    const gh = geo('endcap.hub', endcapHub());
    add({ role: 'endcap.hub', geometry: gh, materials: [STRUCT_MAT.hub], parent: 'station',
      instances: instanceSet(endcapInstanceMatrices(false), geometries[gh]) });
  }

  const S = CORE_CONFIG.SUN;
  const emitters: EmitterDesc[] = [
    /* z0 = start of the tube on Z (it is centred on z = 0) */
    { kind: 'tube', radius: S.r, length: S.len, z0: -S.len / 2, channel: 'tube', role: 'axis.sun' },
    { kind: 'meshEmission', role: 'lift.lamp', channel: 'liftLamp' },
    { kind: 'meshEmission', role: 'lift.glass', channel: 'liftGlass' },
    { kind: 'meshEmission', role: 'tower.glass', channel: 'towerGlass' },
    { kind: 'meshEmission', role: 'tower.beacon', channel: 'beacon' },
    { kind: 'meshEmission', role: 'endcap.disc', channel: 'towerGlass' }
  ];

  const fragment: SceneFragment = {
    geometries,
    materials: structureMaterials(normals),
    meshes,
    emitters,
    images: structureImages(params, normals, low)
  };
  return { fragment, lifts };
}
