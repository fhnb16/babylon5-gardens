/* Axial structure geometry — port of buildAxis() in js/structures.js:
   the glowing sun tube, the spine (ribs, brackets, longerons and both
   monorail beams merged into ONE geometry) and the force collars.
   Call order of the primitives and transforms is kept exactly as legacy:
   merged vertex order and float rounding depend on it. */

import { CORE_CONFIG } from '../../config/index.ts';
import type { MeshData, ThreeCompat } from '../mesh.ts';
import { mergeMeshes, rotateX, translate } from '../mesh.ts';
import { panelUV, rod } from '../ops.ts';
import { cylinder } from '../primitives/cylinder.ts';
import { torus } from '../primitives/torus.ts';
import { railBeamParts } from './railbeam.ts';

const TUBE_SEGMENTS = 20;
const RIB = { offset: 0.6, tube: 0.42, radialSeg: 6, tubularSeg: 16, endGap: 8 };
const BRACKET = { w: 0.3, h: 1.9, offset: 1.3 };
const LONGERON = { w: 0.5, offset: 0.6 };
const COLLAR = { offset: 1.2, tube: 0.8, radialSeg: 8, tubularSeg: 20 };

/** Radius of the monorail beams' centre line (legacy railR). */
export const railRadius = (): number => CORE_CONFIG.AXIS.spineR + 2.8;

/** Closed cylinder along Z: the sun tube (keeps the 3 cylinder groups). */
export function sunTube(compat: ThreeCompat = 187): MeshData {
  const S = CORE_CONFIG.SUN;
  const g = cylinder(S.r, S.r, S.len, TUBE_SEGMENTS, 1, false, 0, Math.PI * 2, compat);
  return rotateX(g, Math.PI / 2);
}

/** Spine: ribs + brackets, 4 longerons, both monorail beams; panel UVs. */
export function spine(): MeshData {
  const A = CORE_CONFIG.AXIS, HL = CORE_CONFIG.L / 2, len = CORE_CONFIG.SUN.len;
  const parts: MeshData[] = [];
  for (let z = -HL + RIB.endGap; z <= HL - RIB.endGap; z += A.ribEvery) {
    const t = torus(A.spineR + RIB.offset, RIB.tube, RIB.radialSeg, RIB.tubularSeg);
    translate(t, 0, 0, z);
    parts.push(t);
    for (let k = 0; k < 4; k++) {
      const a = k * Math.PI / 2 + Math.PI / 4;
      parts.push(rod(BRACKET.w, BRACKET.h, BRACKET.w,
        Math.sin(a) * (A.spineR + BRACKET.offset), Math.cos(a) * (A.spineR + BRACKET.offset), z, 0, 0, -a));
    }
  }
  for (let k = 0; k < 4; k++) {
    const a = k * Math.PI / 2;
    parts.push(rod(LONGERON.w, len, LONGERON.w,
      Math.sin(a) * (A.spineR + LONGERON.offset), Math.cos(a) * (A.spineR + LONGERON.offset), 0, Math.PI / 2));
  }
  const railR = railRadius();
  for (const side of A.railAngles) railBeamParts(side, railR, parts);
  return panelUV(mergeMeshes(parts), CORE_CONFIG.PANEL_TILE);
}

/** Force collars around the spine at every spar. */
export function collars(): MeshData {
  const A = CORE_CONFIG.AXIS;
  const parts: MeshData[] = [];
  for (const z of A.spars) {
    const t = torus(A.spineR + COLLAR.offset, COLLAR.tube, COLLAR.radialSeg, COLLAR.tubularSeg);
    translate(t, 0, 0, z);
    parts.push(t);
  }
  return panelUV(mergeMeshes(parts), CORE_CONFIG.PANEL_TILE);
}
