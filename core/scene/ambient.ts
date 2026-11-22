/* ═══════════════════════════════════════════════════════════════════════════
   Ambient fragment — the sun glow plane, clouds and dust motes (legacy
   js/main.js / app/lights.ts buildAmbient) as plain data:

     · MeshDesc 'glow'     — a 12 × SUN.len plane lying along the axis
                             (PlaneGeometry rotated +90° about X: normal −Y),
                             unlit, additive, fog-faded, double-sided, not
                             tone-mapped. The raster backend turns it towards
                             the camera around the axis every frame (an axial
                             billboard); tracers skip it (only: 'raster').
     · BillboardSetDesc 'clouds' — 14 soft sprites, size 52; none on LOW
                             (legacy §14: clouds hidden on LOW);
     · BillboardSetDesc 'motes'  — 400 additive dust sprites.

   All of them live in the fixed 'scene' frame (axis-symmetric, they do not
   rotate with the habitat). Opacity and size follow the lighting state by
   ParamRef (glowOpacity, cloudOpacity, moteOpacity, moteSize); the colours
   the palette drives (glow ← sunColor, motes ← moteColor) are keyed by these
   roles in the backend (no colour ParamRef in the contract yet).

   rnd() ORDER on mulberry32(seed ^ 0x5f5): 14 × (θ, r, z) for the clouds —
   drawn on every quality, LOW included — then 400 × (θ, r, z) for the motes.
   Ids are prefixed 'a.'.
   ═══════════════════════════════════════════════════════════════════════════ */

import { CORE_CONFIG } from '../config/index.ts';
import { mulberry32 } from '../rng.ts';
import { TAU } from '../math/scalar.ts';
import { setHex } from '../math/color.ts';
import { rotateX, toGeometryDesc } from '../geometry/mesh.ts';
import { plane } from '../geometry/primitives/plane.ts';
import { TEX } from '../textures/ids.ts';
import { standardImages } from '../textures/registry.ts';
import type { ImageDesc, MaterialDesc, SceneFragment, WorldParams } from './types.ts';

/** The legacy recipe (app/lights.ts buildAmbient). */
export const AMBIENT = {
  rngXor: 0x5f5,
  glow: { width: 12 },
  clouds: { n: 14, r0: 10, dr: 13, z0: -140, dz: 280, size: 52 },
  motes: { n: 400, r0: 4, dr: 44, z0: -150, dz: 300 }
} as const;

function linHex(hex: number): [number, number, number] {
  const c = [0, 0, 0];
  setHex(hex, c);
  return [c[0], c[1], c[2]];
}

/** Ring positions (x = r sin θ, y = r cos θ) — one rnd() triple per point. */
function ring(rnd: () => number, n: number, r0: number, dr: number, z0: number, dz: number): Float32Array {
  const p = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const t = rnd() * TAU, r = r0 + rnd() * dr;
    p[i * 3] = Math.sin(t) * r; p[i * 3 + 1] = Math.cos(t) * r; p[i * 3 + 2] = z0 + rnd() * dz;
  }
  return p;
}

export function buildAmbientFragment(params: WorldParams): SceneFragment {
  const C = CORE_CONFIG, D = C.DAY;
  const std = standardImages({ seed: params.seed, quality: params.quality, ponds: [] });
  const images: Record<string, ImageDesc> = {};
  const use = (id: string): void => {
    const d = std[id];
    if (!d) throw new Error('ambient: no standard image ' + id);
    images[id] = d;
  };

  /* sun glow: one plane along the axis, turned to the camera by the backend */
  use(TEX.glow);
  const glowMat: MaterialDesc = {
    id: 'a.glow', model: 'unlit', baseColor: linHex(D.sunCol), map: TEX.glow,
    roughness: 1, metalness: 0, side: 'double',
    alpha: { blend: { param: 'glowOpacity' }, additive: true },
    depthWrite: false, toneMapped: false, kernels: ['fogFade'], rasterOnly: true
  };
  const glowGeo = toGeometryDesc(rotateX(plane(AMBIENT.glow.width, C.SUN.len), Math.PI / 2));

  const rnd = mulberry32((params.seed ^ AMBIENT.rngXor) >>> 0);
  const K = AMBIENT.clouds, M = AMBIENT.motes;
  const cloudPos = ring(rnd, K.n, K.r0, K.dr, K.z0, K.dz);
  const motePos = ring(rnd, M.n, M.r0, M.dr, M.z0, M.dz);

  const materials: Record<string, MaterialDesc> = { [glowMat.id]: glowMat };
  const billboards: SceneFragment['billboards'] = [];
  /* legacy §14: no clouds on LOW (the stream above is drawn anyway) */
  if (params.quality !== 'LOW') {
    use(TEX.spriteCloud);
    materials['a.clouds'] = {
      id: 'a.clouds', model: 'sprite', baseColor: [1, 1, 1], map: TEX.spriteCloud,
      roughness: 1, metalness: 0, side: 'front', alpha: { blend: { param: 'cloudOpacity' } },
      depthWrite: false, rasterOnly: true
    };
    billboards.push({ role: 'clouds', positions: cloudPos, size: K.size, material: 'a.clouds', parent: 'scene' });
  }
  use(TEX.spriteMote);
  materials['a.motes'] = {
    id: 'a.motes', model: 'sprite', baseColor: linHex(D.moteCol), map: TEX.spriteMote,
    roughness: 1, metalness: 0, side: 'front', alpha: { blend: { param: 'moteOpacity' }, additive: true },
    depthWrite: false, rasterOnly: true
  };
  billboards.push({ role: 'motes', positions: motePos, size: { param: 'moteSize' }, material: 'a.motes', parent: 'scene' });

  return {
    geometries: { 'a.glow': glowGeo },
    materials,
    meshes: [{ role: 'glow', geometry: 'a.glow', materials: ['a.glow'], parent: 'scene', only: 'raster' }],
    billboards,
    images
  };
}
