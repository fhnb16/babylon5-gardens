/* Support column from the hull to the spine — port of trussGeo() in
   js/structures.js. Grows along local +Y from the hull (y = 0) to the spine
   (y = len): tapered shaft, bands, stylobate steps, saddle yoke + cheeks and
   six buttress fins at the foot. */

import { CORE_CONFIG } from '../../config/index.ts';
import type { MeshData, ThreeCompat } from '../mesh.ts';
import { mergeMeshes, rotateY, rotateZ, translate } from '../mesh.ts';
import { box } from '../primitives/box.ts';
import { cylinder } from '../primitives/cylinder.ts';

const TAU = Math.PI * 2;
const BAND_K = 1.14;
const FIN = { count: 6, phase: 0.26, w: 0.7, h: 5.6, d: 1.5, tilt: 0.44, at: 0.62, y: 2.6 };

/** Column length used by the legacy build: from R − 1 to the spine. */
export const trussLength = (): number => CORE_CONFIG.R - 1 - CORE_CONFIG.AXIS.spineR;

export function trussColumn(len: number = trussLength(), w: number = CORE_CONFIG.AXIS.trussW,
  compat: ThreeCompat = 187): MeshData {
  const g: MeshData[] = [];
  const B = CORE_CONFIG.AXIS.baseR;
  const C = CORE_CONFIG.AXIS.column;
  const cyl = (r0: number, r1: number, h: number, seg: number, open = false): MeshData =>
    cylinder(r0, r1, h, seg, 1, open, 0, TAU, compat);

  const shaft = cyl(w * C.top, w * C.bottom, len, C.seg);
  translate(shaft, 0, len / 2, 0);
  g.push(shaft);

  const rings = Math.max(2, Math.round(len / C.ringStep));
  for (let k = 1; k < rings; k++) {
    const u = k / rings;
    const r = w * (C.bottom + (C.top - C.bottom) * u);
    const band = cyl(r * BAND_K, r * BAND_K, C.ringH, C.seg);
    translate(band, 0, len * u, 0);
    g.push(band);
  }

  const disc = (r0: number, r1: number, hh: number, y: number, seg = 20): MeshData => {
    const c = cyl(r0, r1, hh, seg);
    translate(c, 0, y + hh / 2, 0);
    return c;
  };
  g.push(disc(B, B * 1.06, 1.4, -0.7));
  g.push(disc(B * 0.78, B * 0.94, 1.1, 0.7));
  g.push(disc(w * C.bottom * 1.6, B * 0.74, 4.2, 1.8));

  const sd = CORE_CONFIG.AXIS.saddle;
  const yoke = cyl(sd.r, sd.r, sd.w, 16, true);
  rotateZ(yoke, Math.PI / 2);
  translate(yoke, 0, len - sd.r * 0.2, 0);
  g.push(yoke);
  for (const sx of [-1, 1]) {
    const cheek = box(sd.w * 0.22, sd.r * 1.7, sd.r * 2.1);
    translate(cheek, sx * sd.w * 0.42, len - sd.r * 0.9, 0);
    g.push(cheek);
  }

  for (let k = 0; k < FIN.count; k++) {
    const a = (k / FIN.count) * TAU + FIN.phase;
    const fin = box(FIN.w, FIN.h, FIN.d);
    rotateZ(fin, FIN.tilt);
    translate(fin, B * FIN.at, FIN.y, 0);
    rotateY(fin, a);
    g.push(fin);
  }
  return mergeMeshes(g);
}
