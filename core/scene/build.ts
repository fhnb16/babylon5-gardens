/* ═══════════════════════════════════════════════════════════════════════════
   buildScene(params) → SceneDesc: merges the ambient fragment (core/scene/
   ambient.ts: sun glow, clouds, motes), the world fragment (core/scene/
   world.ts, port of js/world.js) and the structures fragment (core/scene/
   structures.ts, port of js/structures.js), then adds the raster light
   rig, views and the layout hash. Pure: same params ⇒ identical SceneDesc.

   Merge rules: geometry/material/mesh ids are prefixed per builder ('a.' /
   'w.' / 's.') and must not collide; an image id may be declared by both builders
   only with a byte-identical TextureSpec (asserted). Meshes keep builder
   order: ambient, world, then structures (= legacy creation order).
   Image pixels are NOT generated here (ImageDesc.data stays empty).
   ═══════════════════════════════════════════════════════════════════════════ */

import { CORE_CONFIG } from '../config/index.ts';
import type { ImageDesc, RasterLightDesc, SceneDesc, SceneFragment, ViewDesc, WorldParams } from './types.ts';
import { buildWorldFragment } from './world.ts';
import { buildStructuresFragment } from './structures.ts';
import { buildAmbientFragment } from './ambient.ts';
import { standardImages } from '../textures/registry.ts';

/** Default world parameters (factory seed/season/palette). */
export function defaultParams(quality: WorldParams['quality'] = 'HIGH'): WorldParams {
  return {
    seed: CORE_CONFIG.SEED_DEFAULT, quality, season: CORE_CONFIG.SEASON_DEFAULT,
    saturation: CORE_CONFIG.SATURATION_DEFAULT, greenK: CORE_CONFIG.GREEN_K_DEFAULT
  };
}

/** Merge fragments into one (throws on id collisions / conflicting image specs). */
export function mergeFragments(frags: readonly SceneFragment[], baseImages: Record<string, ImageDesc> = {}): Required<SceneFragment> {
  const out: Required<SceneFragment> = {
    geometries: {}, materials: {}, meshes: [], lodSets: [], billboards: [], emitters: [], images: { ...baseImages }
  };
  for (const f of frags) {
    for (const [id, g] of Object.entries(f.geometries)) {
      if (id in out.geometries) throw new Error(`mergeFragments: geometry id collision '${id}'`);
      out.geometries[id] = g;
    }
    for (const [id, m] of Object.entries(f.materials)) {
      if (id in out.materials) throw new Error(`mergeFragments: material id collision '${id}'`);
      out.materials[id] = m;
    }
    for (const [id, im] of Object.entries(f.images)) {
      const prev: ImageDesc | undefined = out.images[id];
      if (prev) {
        if (JSON.stringify(prev.source) !== JSON.stringify(im.source)) {
          throw new Error(`mergeFragments: image '${id}' declared with different specs: ` +
            `${JSON.stringify(prev.source)} vs ${JSON.stringify(im.source)}`);
        }
        continue;
      }
      out.images[id] = im;
    }
    out.meshes.push(...f.meshes);
    if (f.lodSets) out.lodSets.push(...f.lodSets);
    if (f.billboards) out.billboards.push(...f.billboards);
    if (f.emitters) out.emitters.push(...f.emitters);
  }
  const roles = new Set<string>();
  for (const m of out.meshes) {
    if (roles.has(m.role)) throw new Error(`mergeFragments: duplicate mesh role '${m.role}'`);
    roles.add(m.role);
  }
  return out;
}

/** Raster stand-in lights for a quality (js/main.js buildLights). */
export function rasterLightsFor(quality: WorldParams['quality']): RasterLightDesc {
  const want = (CORE_CONFIG.QUALITY[quality] || CORE_CONFIG.QUALITY.HIGH).lights;
  const zs = want <= 3 ? CORE_CONFIG.LIGHT_Z_3 : CORE_CONFIG.LIGHT_Z;
  return {
    hemisphere: true,
    pointZ: zs.slice(),
    perLightScale: CORE_CONFIG.LIGHT_Z.length / zs.length,
    distance: CORE_CONFIG.POINT_LIGHT.distance,
    decay: CORE_CONFIG.POINT_LIGHT.decay
  };
}

export function viewsOf(): ViewDesc[] {
  return CORE_CONFIG.TP.map(v => ({ ico: v.ico, name: v.name, hint: v.hint, pos: [v.pos[0], v.pos[1], v.pos[2]], look: [v.look[0], v.look[1], v.look[2]] }));
}

/* ─── layout hash ─────────────────────────────────────────────────────────── */

function fnv(h: number, v: number): number {
  for (let s = 0; s < 32; s += 8) {
    h ^= (v >>> s) & 255;
    h = Math.imul(h, 0x01000193);
  }
  return h;
}
const quant = (x: number, step: number): number => Math.round(x / step) | 0;

/**
 * Stable hash of the placement decisions: hills (1e-4) and, per instanced
 * mesh / LOD set in scene order, its role, instance count and instance
 * positions quantized to 1e-3 units. Independent of geometry tessellation,
 * materials and images, so every backend can compare it.
 */
export function layoutHash(scene: Pick<SceneDesc, 'hull' | 'meshes' | 'lodSets'>): string {
  let h = 0x811c9dc5;
  const str = (s: string): void => { for (let i = 0; i < s.length; i++) h = fnv(h, s.charCodeAt(i)); };
  for (const hl of scene.hull.hills) {
    h = fnv(h, quant(hl.theta, 1e-4)); h = fnv(h, quant(hl.z, 1e-4));
    h = fnv(h, quant(hl.r, 1e-4)); h = fnv(h, quant(hl.rise, 1e-4));
  }
  const mats = (role: string, m: Float32Array): void => {
    str(role);
    const n = m.length / 16;
    h = fnv(h, n);
    for (let k = 0; k < n; k++) {
      h = fnv(h, quant(m[k * 16 + 12], 1e-3)); h = fnv(h, quant(m[k * 16 + 13], 1e-3)); h = fnv(h, quant(m[k * 16 + 14], 1e-3));
    }
  };
  for (const m of scene.meshes) if (m.instances && !m.dynamic) mats(m.role, m.instances.matrices);
  for (const l of scene.lodSets) mats(l.role, l.matrices);
  return (h >>> 0).toString(16).padStart(8, '0');
}

/* ─── buildScene ──────────────────────────────────────────────────────────── */

export function buildScene(params: WorldParams): SceneDesc {
  const world = buildWorldFragment(params);
  const structures = buildStructuresFragment(params);
  const ambient = buildAmbientFragment(params);
  /* the full legacy image set (incl. clouds/motes/glow used by the app), then
     the fragments' own declarations, which must agree with it */
  const base = standardImages({ seed: params.seed, quality: params.quality, ponds: world.layout.ponds.map(p => ({ ...p })) });
  /* ambient first: legacy built the glow/clouds/motes before the world (creation order breaks transparent-sort ties) */
  const merged = mergeFragments([ambient, world.fragment, structures.fragment], base);
  const scene: SceneDesc = {
    version: 1,
    params: { ...params },
    frame: { R: CORE_CONFIG.R, L: CORE_CONFIG.L, metresPerUnit: 10 },
    images: merged.images,
    geometries: merged.geometries,
    materials: merged.materials,
    meshes: merged.meshes,
    lodSets: merged.lodSets,
    billboards: merged.billboards,
    emitters: merged.emitters,
    rasterLights: rasterLightsFor(params.quality),
    hull: world.hull,
    dynamics: { ...(world.dynamics.traffic ? { traffic: world.dynamics.traffic } : {}), lifts: structures.lifts },
    views: viewsOf(),
    layoutHash: ''
  };
  scene.layoutHash = layoutHash(scene);
  return scene;
}
