/* ═══════════════════════════════════════════════════════════════════════════
   City grid — the single source of truth about blocks, shared by the hull
   texture (core/textures) and placement. Port of js/util.js cityBlock /
   cityCenter / cellUsable / cellInfo / pickFloors. cellInfo takes the seed
   explicitly (legacy read the mutable CONFIG.SEED).
   ═══════════════════════════════════════════════════════════════════════════ */

import { CORE_CONFIG } from '../config/index.ts';
import { mulberry32 } from '../rng.ts';
import { D2R, TAU } from '../math/scalar.ts';

export interface CityBlock {
  /** step along the arc / along the axis (units) */
  stepT: number;
  stepZ: number;
  /** block width (step minus street) along the arc / along the axis */
  wT: number;
  wZ: number;
}

export function cityBlock(): CityBlock {
  const C = CORE_CONFIG.CITY;
  return {
    stepT: TAU * CORE_CONFIG.R / C.cols,
    stepZ: CORE_CONFIG.L / C.rows,
    wT: TAU * CORE_CONFIG.R / C.cols - C.street,
    wZ: CORE_CONFIG.L / C.rows - C.street
  };
}

/** Centre of block (i, j): angle (rad) and z. */
export function cityCenter(i: number, j: number): { t: number; z: number } {
  const C = CORE_CONFIG.CITY;
  return {
    t: ((i + 0.5) / C.cols) * TAU,
    z: -CORE_CONFIG.L / 2 + (j + 0.5) * (CORE_CONFIG.L / C.rows)
  };
}

/** The whole angular span of the block lies inside a city sector, and it is not an end row. */
export function cellUsable(i: number, j: number): boolean {
  const B = cityBlock();
  const half = (B.wT / CORE_CONFIG.R) / D2R / 2;
  const c = cityCenter(i, 0).t / D2R;
  if (!CORE_CONFIG.SECT.cities.some(([a, b]) => c - half >= a && c + half <= b)) return false;
  return Math.abs(cityCenter(i, j).z) <= CORE_CONFIG.L / 2 - B.stepZ;
}

export type CellKind = 'park' | 'plaza' | 'lot' | 'built';

export interface CellInfo {
  kind: CellKind;
  type: number;
  w: number;
  d: number;
  spin: number;
  floors: number;
  tint: number;
}

/** What is in block (i, j). Deterministic by indices and seed (own rng per cell). */
export function cellInfo(seed: number, i: number, j: number): CellInfo {
  const rnd = mulberry32((seed ^ Math.imul(i, 374761393) ^ Math.imul(j, 668265263)) >>> 0);
  const roll = rnd();
  const kind: CellKind = roll < 0.15 ? 'park' : roll < 0.23 ? 'plaza' : roll < 0.31 ? 'lot' : 'built';
  return {
    kind,
    type: (rnd() * 4) | 0,
    w: rnd(), d: rnd(),
    spin: (rnd() * 4) | 0,
    floors: rnd(),
    tint: rnd()
  };
}

/** Floor count from the CONFIG.FLOOR_W weights limited to [lo, hi]; u uniform in [0, 1). */
export function pickFloors(u: number, range: readonly [number, number] | readonly number[]): number {
  const W = CORE_CONFIG.FLOOR_W;
  const lo = range[0], hi = range[1];
  let sum = 0;
  for (let f = lo; f <= hi; f++) sum += W[f - 1];
  let acc = u * sum;
  for (let f = lo; f <= hi; f++) { acc -= W[f - 1]; if (acc < 0) return f; }
  return hi;
}

/** Per-slot rng of a parking lot (cell i, j; slot row a, column b) — legacy formula. */
export function parkingRng(seed: number, i: number, j: number, a: number, b: number): () => number {
  return mulberry32((seed ^ (i * 911) ^ (j * 233) ^ (a * 37) ^ (b * 7)) >>> 0);
}

/** Road centre angles of the traffic lanes: every third column boundary inside a city (legacy). */
export function trafficRoads(): number[] {
  const C = CORE_CONFIG.CITY;
  const BLK = cityBlock();
  const roads: number[] = [];
  for (let i2 = 0; i2 < C.cols; i2 += 3) {
    if (!cellUsable(i2, Math.floor(C.rows / 2))) continue;
    roads.push(cityCenter(i2, 0).t - (BLK.stepT / 2) / CORE_CONFIG.R);
  }
  return roads;
}
