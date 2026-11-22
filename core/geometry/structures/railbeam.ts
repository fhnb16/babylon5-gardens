/* Monorail running beam — the lattice girder part of buildAxis() in
   js/structures.js: four chords, X-braces on both flanks and the bottom per
   bay, cross members at bay boundaries. Rotated to the rail angle `side`. */

import { CORE_CONFIG } from '../../config/index.ts';
import type { MeshData } from '../mesh.ts';
import { rotateX, rotateZ, translate } from '../mesh.ts';
import { rod } from '../ops.ts';
import { box } from '../primitives/box.ts';

/** Append the beam parts for rail angle `side` (rad) at radius `railR` to `out`, in legacy order. */
export function railBeamParts(side: number, railR: number, out: MeshData[]): MeshData[] {
  const RB = CORE_CONFIG.RAILBEAM, len = CORE_CONFIG.SUN.len;
  const c = Math.cos(side), sn = Math.sin(side);
  const put = (w: number, l: number, d: number, ox: number, oy: number, oz = 0, rx = Math.PI / 2): void => {
    out.push(rod(w, l, d, ox * c + oy * sn, -ox * sn + oy * c, oz, rx));
  };

  const chords: [number, number][] = [[-RB.w, RB.h], [RB.w, RB.h], [-RB.w, -RB.h], [RB.w, -RB.h]];
  for (const [ox, oy] of chords) put(RB.chord, len, RB.chord, ox, railR + oy);

  const braces: [number, number, number][] = [[-RB.w, 0, 1], [RB.w, 0, -1], [0, -RB.h, 1]];
  const bays = Math.round(len / RB.bay);
  for (let k = 0; k < bays; k++) {
    const z0 = -len / 2 + k * RB.bay;
    for (const [ax, ay, tilt] of braces) {
      const d = box(RB.brace, RB.brace, Math.hypot(RB.bay, RB.h * 2));
      rotateX(d, Math.atan2(RB.h * 2, RB.bay) * tilt);
      /* legacy does a no-op translate here; it still re-normalizes normals */
      translate(d, 0, 0, 0);
      const px = ax || 0, py = railR + ay;
      translate(d, px * c + py * sn, -px * sn + py * c, z0 + RB.bay / 2);
      out.push(d);
    }
    const cross = box(RB.w * 2, RB.brace, RB.brace);
    translate(cross, 0, railR - RB.h, z0);
    rotateZ(cross, -side);
    out.push(cross);
  }
  return out;
}
