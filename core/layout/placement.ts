/* ═══════════════════════════════════════════════════════════════════════════
   Zoned placement — port of the buildWorld closures `free`, `fits`,
   `spanHits`, `inPond`, `onStreet`, `sample`, plus the city plots and the
   parking lots. Decisions and the order of rnd() calls are identical to the
   legacy code (see core/layout/grid.ts for why the grid changes nothing).
   ═══════════════════════════════════════════════════════════════════════════ */

import { CORE_CONFIG } from '../config/index.ts';
import type { Rng } from '../rng.ts';
import { D2R, TAU } from '../math/scalar.ts';
import { DiscGrid } from './grid.ts';
import { inPond, type Pond } from './hills.ts';
import { spanHits, zoneAt, type SectorKind, type ZoneId } from './zones.ts';
import { cellInfo, cellUsable, cityBlock, cityCenter, parkingRng, type CellInfo } from './city.ts';

/** Zone acceptance weights (probability an attempt in that zone is kept). */
export type ZoneWeights = Record<ZoneId, number>;

export const W_TREE: ZoneWeights = { park: 1.0, edge: 0.5, field: 0.13, city: 0.14, river: 0 };
export const W_BUSH: ZoneWeights = { park: 1.0, edge: 0.6, field: 0.24, city: 0.22, river: 0 };

/** A sampled spot: angle, z, reserved radius. */
export type Spot = [number, number, number];

export interface Placer {
  readonly R: number;
  readonly L: number;
  readonly grid: DiscGrid;
  /** away from the Command Tower plinth */
  free(t: number, z: number): boolean;
  /** overlaps no reserved disc */
  fits(t: number, z: number, r: number): boolean;
  claim(t: number, z: number, r: number): void;
  inPond(t: number, z: number, r: number): boolean;
  onStreet(t: number, z: number, r: number): boolean;
  /**
   * Rejection-sample up to n spots (legacy `sample`). rnd order per attempt:
   * rad() (if a function), t, z, then the zone accept call only when the
   * zone weight is > 0.
   */
  sample(rnd: Rng, w: ZoneWeights, n: number, rad: number | (() => number), claim: boolean, bad?: readonly SectorKind[] | null): Spot[];
}

export function createPlacer(ponds: readonly Pond[]): Placer {
  const R = CORE_CONFIG.R, L = CORE_CONFIG.L, HL = L / 2;
  const towerT = CORE_CONFIG.TOWER.deg * D2R;
  const grid = new DiscGrid(R, -HL - 16, HL + 16);
  const CT = CORE_CONFIG.CITY;
  const cellT = TAU / CT.cols, cellZ = L / CT.rows;

  const free = (t: number, z: number): boolean => {
    const arc = Math.abs(((t - towerT + Math.PI) % TAU + TAU) % TAU - Math.PI) * R;
    return Math.hypot(arc, z - CORE_CONFIG.TOWER.z) > CORE_CONFIG.TOWER_CLEAR;
  };

  const onStreet = (t: number, z: number, r: number): boolean => {
    const halfT = CT.street / R + r / R;
    const halfZ = CT.street + r;
    const fu = (((t % cellT) + cellT) % cellT) / cellT;
    const fv = ((((z + HL) % cellZ) + cellZ) % cellZ) / cellZ;
    const du = Math.min(fu, 1 - fu) * cellT;
    const dv = Math.min(fv, 1 - fv) * cellZ;
    return du < halfT || dv < halfZ;
  };

  const placer: Placer = {
    R, L, grid,
    free,
    fits: (t, z, r) => grid.fits(t, z, r),
    claim: (t, z, r) => grid.add(t, z, r),
    inPond: (t, z, r) => inPond(ponds, t, z, r, R),
    onStreet,
    sample(rnd, w, n, rad, claim, bad = null) {
      const out: Spot[] = [];
      for (let guard = 0; out.length < n && guard < n * 80; guard++) {
        const r = typeof rad === 'function' ? rad() : rad;
        const margin = r + 3;
        const t = rnd() * TAU, z = -HL + margin + rnd() * (L - margin * 2);
        const p = w[zoneAt(t / D2R)];
        if (p <= 0 || rnd() > p) continue;
        if (!free(t, z) || !grid.fits(t, z, r)) continue;
        if (bad && spanHits(t, r, R, bad)) continue;
        if (zoneAt(t / D2R) === 'city' && onStreet(t, z, r)) continue;
        if (inPond(ponds, t, z, r, R)) continue;
        out.push([t, z, r]);
        if (claim) grid.add(t, z, r);
      }
      return out;
    }
  };

  /* fixed structures reserve ground: truss feet and the end-cap spokes */
  const A = CORE_CONFIG.AXIS;
  for (const z of A.spars) {
    for (let k = 0; k < A.sparArms; k++) {
      grid.add((A.sparAngle + k * 360 / A.sparArms) * D2R, z, A.baseR + 1.5);
    }
  }
  for (const sign of [-1, 1]) {
    for (let k = 0; k < 6; k++) grid.add((k / 6) * TAU + 0.26, sign * (HL - 8), 3.0);
  }
  return placer;
}

/** A building plot: block centre and the block's CellInfo. */
export type Plot = [number, number, CellInfo];

/** Built blocks per building type (legacy plots[4]); each reserves its block. */
export function cityPlots(placer: Placer, seed: number): Plot[][] {
  const C = CORE_CONFIG.CITY;
  const BLK = cityBlock();
  const blockRad = Math.min(BLK.wT, BLK.wZ) / 2;
  const plots: Plot[][] = [[], [], [], []];
  for (let i = 0; i < C.cols; i++) {
    const t = cityCenter(i, 0).t;
    for (let j = 0; j < C.rows; j++) {
      if (!cellUsable(i, j)) continue;
      const z = cityCenter(i, j).z;
      const info = cellInfo(seed, i, j);
      if (info.kind !== 'built') continue;
      if (!placer.free(t, z) || !placer.fits(t, z, blockRad)) continue;
      plots[info.type].push([t, z, info]);
      placer.claim(t, z, blockRad);
    }
  }
  return plots;
}

/** A parked car: angle, z, vertical (along the block's long side), colour roll. */
export type ParkedCar = [number, number, boolean, number];

/** Cars on 'lot' blocks: 4×3 slots, each with its own rng (35 % empty). */
export function parkedCars(placer: Placer, seed: number): ParkedCar[] {
  const C = CORE_CONFIG.CITY;
  const BLK = cityBlock();
  const R = CORE_CONFIG.R;
  const cars: ParkedCar[] = [];
  for (let i2 = 0; i2 < C.cols; i2++) {
    for (let j2 = 0; j2 < C.rows; j2++) {
      if (!cellUsable(i2, j2)) continue;
      const info = cellInfo(seed, i2, j2);
      if (info.kind !== 'lot') continue;
      const t = cityCenter(i2, 0).t, z = cityCenter(i2, j2).z;
      if (!placer.free(t, z)) continue;
      const vert = info.spin % 2 === 0;
      const rows2 = 4, cols2 = 3;
      for (let a = 0; a < rows2; a++) {
        for (let b = 0; b < cols2; b++) {
          const cr = parkingRng(seed, i2, j2, a, b);
          if (cr() < 0.35) continue;
          const u = (a + 0.5) / rows2 - 0.5, v = (b + 0.5) / cols2 - 0.5;
          const dx = (vert ? u : v) * BLK.wT * 0.66;
          const dz = (vert ? v : u) * BLK.wZ * 0.66;
          cars.push([t + dx / R, z + dz, vert, cr()]);
        }
      }
    }
  }
  return cars;
}
