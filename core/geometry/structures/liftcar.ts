/* Monorail cabin geometry — port of the cabin part of buildAxis() in
   js/structures.js. Local frame: long side along Z, +Y looks at the axis.
   Three meshes: body (floor, roof, end walls, pillars, belts, bogie, wheels,
   seats), ceiling lamp strip, glazing panels. */

import { CORE_CONFIG } from '../../config/index.ts';
import type { MeshData, ThreeCompat } from '../mesh.ts';
import { mergeMeshes, rotateZ, translate } from '../mesh.ts';
import { panelUV, rod } from '../ops.ts';
import { cylinder } from '../primitives/cylinder.ts';

const PILLARS = 5;
const WHEEL = { r: 0.3, w: 0.22, seg: 10 };

export function liftBody(compat: ThreeCompat = 187): MeshData {
  const CR = CORE_CONFIG.LIFTCAR;
  const hw = CR.w / 2, hh = CR.h / 2, hl = CR.len / 2;
  const parts: MeshData[] = [
    rod(CR.w, CR.floor, CR.len, 0, -hh + CR.floor / 2, 0),               // floor
    rod(CR.w, CR.floor, CR.len, 0, hh - CR.floor / 2, 0),                // roof
    rod(CR.w, CR.h, CR.floor, 0, 0, hl - CR.floor / 2),                  // end wall
    rod(CR.w, CR.h, CR.floor, 0, 0, -hl + CR.floor / 2),                 // end wall
    rod(CR.w * 0.34, CR.h * 0.55, CR.len * 0.26, 0, hh + CR.h * 0.2, 0)  // bogie
  ];
  for (let k = 0; k <= PILLARS; k++) {
    const z = -hl + (CR.len / PILLARS) * k;
    for (const sx of [-1, 1]) parts.push(rod(CR.floor, CR.h * 0.86, CR.pillar, sx * hw, 0, z));
  }
  const winTop = CR.h * 0.04 + CR.h * 0.26, winBot = CR.h * 0.04 - CR.h * 0.26;
  for (const sx of [-1, 1]) {
    const upH = (hh - CR.floor) - winTop;
    if (upH > 0.001) parts.push(rod(CR.floor, upH, CR.len, sx * hw, winTop + upH / 2, 0));
    const dnH = winBot - (-hh + CR.floor);
    if (dnH > 0.001) parts.push(rod(CR.floor, dnH, CR.len, sx * hw, winBot - dnH / 2, 0));
    parts.push(rod(CR.floor * 1.4, CR.belt, CR.len, sx * hw, winBot, 0));
    parts.push(rod(CR.floor * 1.4, CR.belt, CR.len, sx * hw, winTop, 0));
  }
  for (const sgn of [-1, 1]) {
    for (const sx of [-1, 1]) {
      const wheel = cylinder(WHEEL.r, WHEEL.r, WHEEL.w, WHEEL.seg, 1, false, 0, Math.PI * 2, compat);
      rotateZ(wheel, Math.PI / 2);
      translate(wheel, sx * CR.w * 0.4, hh + CR.h * 0.42, sgn * CR.len * 0.3);
      parts.push(wheel);
    }
  }
  for (const sx of [-1, 1]) {
    parts.push(rod(CR.w * 0.22, CR.floor, CR.len * 0.78, sx * (hw - CR.w * 0.13),
      -hh + CR.floor + CR.seat, 0));
    parts.push(rod(CR.floor, CR.seat, CR.len * 0.78, sx * (hw - CR.w * 0.03),
      -hh + CR.floor + CR.seat / 2, 0));
  }
  return panelUV(mergeMeshes(parts), CORE_CONFIG.PANEL_TILE);
}

/** Ceiling lamp strip (merged like legacy, so the index layout matches). */
export function liftLamp(): MeshData {
  const CR = CORE_CONFIG.LIFTCAR;
  const hh = CR.h / 2;
  return mergeMeshes([rod(CR.w * 0.3, CR.floor * 0.5, CR.len * 0.9, 0, hh - CR.floor * 1.2, 0)]);
}

/** Thin glazing panels in the side openings and both end walls. */
export function liftGlass(): MeshData {
  const CR = CORE_CONFIG.LIFTCAR;
  const hw = CR.w / 2, hl = CR.len / 2;
  const parts: MeshData[] = [];
  for (const sx of [-1, 1]) parts.push(rod(CR.glass, CR.h * 0.52, CR.len * 0.97, sx * hw, CR.h * 0.04, 0));
  parts.push(rod(CR.w * 0.9, CR.h * 0.44, CR.glass, 0, CR.h * 0.04, hl - CR.floor));
  parts.push(rod(CR.w * 0.9, CR.h * 0.44, CR.glass, 0, CR.h * 0.04, -hl + CR.floor));
  return mergeMeshes(parts);
}
