/* Command Tower geometry — port of buildTower() in js/structures.js.
   Drawn in model space with height CONFIG.TOWER.modelH; the scene applies the
   group transform (surface frame + Y scale h/modelH), see towerGroupMatrix(). */

import { CORE_CONFIG } from '../../config/index.ts';
import type { Mat4 } from '../../math/mat4.ts';
import type { MeshData, ThreeCompat } from '../mesh.ts';
import { mergeMeshes, rotateY, rotateZ, translate } from '../mesh.ts';
import { panelUV, rod } from '../ops.ts';
import { cylinder } from '../primitives/cylinder.ts';
import { icosahedron } from '../primitives/icosahedron.ts';
import { surfaceMatrix } from '../shapes/surface.ts';

const TAU = Math.PI * 2;
const D2R = Math.PI / 180;
const COLONNADE = { count: 22, w: 0.4, h: 4.3, r: 5.9, y: 25.45 };
const BUTTRESS = { count: 3, phase: 0.4, rTop: 0.38, rBottom: 0.75, h: 14, seg: 8, tilt: 0.42, x: 6.4, y: 6.6 };
const BEACON = { r: 1.0, detail: 1, y: 34.2 };

/** Vertical squash of the model (legacy group scale.y). */
export const towerScaleY = (): number => CORE_CONFIG.TOWER.h / CORE_CONFIG.TOWER.modelH;

/** Legacy Group 'tower' local matrix: surface frame at (deg, R, z), scale (1, h/modelH, 1). */
export function towerGroupMatrix(out?: Mat4): Mat4 {
  const T = CORE_CONFIG.TOWER;
  return surfaceMatrix(T.deg * D2R, CORE_CONFIG.R, T.z, [1, towerScaleY(), 1], out);
}

/** Beacon offset inside the tower group (legacy beacon.position.y). */
export const beaconY = (): number => BEACON.y;

const cylAt = (compat: ThreeCompat) => (r0: number, r1: number, h: number, y: number, seg = 24): MeshData => {
  const c = cylinder(r0, r1, h, seg, 1, false, 0, TAU, compat);
  return translate(c, 0, y + h / 2, 0);
};

export function towerConcrete(compat: ThreeCompat = 187): MeshData {
  const T = CORE_CONFIG.TOWER;
  const cyl = cylAt(compat);
  const shell: MeshData[] = [
    cyl(T.plinthR, T.plinthR, 1.2, 0, 28),
    cyl(8.2, 8.2, 1.0, 1.2, 28),
    rod(15.5, 0.7, 6.4, 0, 2.55, 3.2),
    rod(6.4, 0.7, 14.0, -3.0, 2.55, -2.2),
    cyl(5.6, 5.2, 12.0, 2.2),
    cyl(6.7, 6.7, 0.55, 14.2, 28),
    cyl(4.3, 4.0, 8.0, 14.75),
    cyl(6.3, 6.3, 0.6, 22.75, 28),
    cyl(6.8, 6.8, 0.75, 27.6, 28),          // office roof
    cyl(0.9, 0.3, 5.2, 28.35, 12),          // mast
    rod(1.2, 0.25, 9.0, 0, 8.4, 5.6),       // cantilever balcony
    rod(9.0, 0.25, 1.2, 5.6, 11.4, 0)
  ];
  for (let k = 0; k < COLONNADE.count; k++) {
    const a = (k / COLONNADE.count) * TAU;
    shell.push(rod(COLONNADE.w, COLONNADE.h, COLONNADE.w,
      Math.sin(a) * COLONNADE.r, COLONNADE.y, Math.cos(a) * COLONNADE.r));
  }
  for (let k = 0; k < BUTTRESS.count; k++) {
    const a = (k / BUTTRESS.count) * TAU + BUTTRESS.phase;
    const l = cylinder(BUTTRESS.rTop, BUTTRESS.rBottom, BUTTRESS.h, BUTTRESS.seg, 1, false, 0, TAU, compat);
    rotateZ(l, BUTTRESS.tilt); translate(l, BUTTRESS.x, BUTTRESS.y, 0); rotateY(l, a);
    shell.push(l);
  }
  return panelUV(mergeMeshes(shell), CORE_CONFIG.PANEL_TILE, towerScaleY());
}

export function towerGlass(compat: ThreeCompat = 187): MeshData {
  const cyl = cylAt(compat);
  const glass: MeshData[] = [
    cyl(5.65, 5.5, 1.5, 4.2), cyl(5.5, 5.4, 1.5, 7.6), cyl(5.4, 5.3, 1.5, 11.0),
    cyl(4.35, 4.3, 1.6, 16.6), cyl(4.3, 4.2, 1.6, 20.0),
    cyl(5.5, 5.5, 4.2, 23.35, 28)            // commander's office
  ];
  return panelUV(mergeMeshes(glass), CORE_CONFIG.PANEL_TILE * 0.5, towerScaleY());
}

/** Beacon sphere at the origin (placed by beaconY() in the tower frame). */
export const towerBeacon = (): MeshData => icosahedron(BEACON.r, BEACON.detail);
