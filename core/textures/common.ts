/* ═══════════════════════════════════════════════════════════════════════════
   Shared helpers for the texture generators (port of the private helpers at
   the top of js/textures.js plus the city-grid functions of js/util.js that
   makeHullMaps reads). Kept byte-for-byte equivalent in arithmetic so the
   ports draw the same pixels and consume the same rnd() sequence.
   ═══════════════════════════════════════════════════════════════════════════ */

import { createCanvas } from '../raster/index.ts';
import type { Context2D, RasterCanvas } from '../raster/index.ts';
import { CORE_CONFIG } from '../config/index.ts';
import { mulberry32 } from '../rng.ts';

export const TAU_2D = Math.PI * 2;
const TAU = Math.PI * 2;
const D2R = Math.PI / 180;

export interface Cv { c: RasterCanvas; g: Context2D }

/** `cv(w, h)` of js/textures.js: a fresh transparent canvas + its context. */
export const cv = (w: number, h: number): Cv => {
  const c = createCanvas(w, h);
  return { c, g: c.getContext('2d') };
};

/** Small per-block tone jitter (js/textures.js `tint`). */
export const tint = (hex: string, k: number): string => {
  const n = parseInt(hex.slice(1), 16);
  const c = [n >> 16, (n >> 8) & 255, n & 255].map(v => Math.max(0, Math.min(255, Math.round(v * k))));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
};

/** Smooth polyline through midpoints (js/textures.js `smoothLine`). */
export const smoothLine = (ctx: Context2D, pts: number[][], sx = 1, sy = 1): void => {
  ctx.beginPath();
  ctx.moveTo(pts[0][0] * sx, pts[0][1] * sy);
  for (let k = 1; k < pts.length - 1; k++) {
    ctx.quadraticCurveTo(pts[k][0] * sx, pts[k][1] * sy,
      (pts[k][0] + pts[k + 1][0]) / 2 * sx, (pts[k][1] + pts[k + 1][1]) / 2 * sy);
  }
  const e = pts[pts.length - 1];
  ctx.lineTo(e[0] * sx, e[1] * sy);
  ctx.stroke();
};

/* ─── city grid (js/util.js cityBlock / cityCenter / cellUsable / cellInfo) ─── */

export interface CityBlock { stepT: number; stepZ: number; wT: number; wZ: number }

export function cityBlock(): CityBlock {
  const C = CORE_CONFIG.CITY;
  return {
    stepT: TAU * CORE_CONFIG.R / C.cols,
    stepZ: CORE_CONFIG.L / C.rows,
    wT: TAU * CORE_CONFIG.R / C.cols - C.street,
    wZ: CORE_CONFIG.L / C.rows - C.street
  };
}

export function cityCenter(i: number, j: number): { t: number; z: number } {
  const C = CORE_CONFIG.CITY;
  return {
    t: ((i + 0.5) / C.cols) * TAU,
    z: -CORE_CONFIG.L / 2 + (j + 0.5) * (CORE_CONFIG.L / C.rows)
  };
}

export function cellUsable(i: number, j: number): boolean {
  const B = cityBlock();
  const half = (B.wT / CORE_CONFIG.R) / D2R / 2;
  const c = cityCenter(i, 0).t / D2R;
  if (!CORE_CONFIG.SECT.cities.some(([a, b]) => c - half >= a && c + half <= b)) return false;
  return Math.abs(cityCenter(i, j).z) <= CORE_CONFIG.L / 2 - B.stepZ;
}

export interface CellInfo {
  kind: 'park' | 'plaza' | 'lot' | 'built';
  type: number; w: number; d: number; spin: number; floors: number; tint: number;
}

/** Deterministic per-cell content; `worldSeed` = CONFIG.SEED of the legacy app. */
export function cellInfo(i: number, j: number, worldSeed: number): CellInfo {
  const rnd = mulberry32((worldSeed ^ Math.imul(i, 374761393) ^ Math.imul(j, 668265263)) >>> 0);
  const roll = rnd();
  const kind = roll < 0.15 ? 'park' : roll < 0.23 ? 'plaza' : roll < 0.31 ? 'lot' : 'built';
  return {
    kind,
    type: (rnd() * 4) | 0,
    w: rnd(), d: rnd(),
    spin: (rnd() * 4) | 0,
    floors: rnd(),
    tint: rnd()
  };
}
