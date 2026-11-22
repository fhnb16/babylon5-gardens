/* core/layout: parity with js/util.js helpers, grid-vs-brute equivalence of
   the placement decisions, hull UV mapping. */
import { describe, expect, test } from 'vitest';
import * as U from '../../test/legacy-oracle/util.js';
import { CONFIG } from '../../js/config.js';
import { CORE_CONFIG } from '../config/index.ts';
import { mulberry32 } from '../rng.ts';
import { TAU } from '../math/scalar.ts';
import {
  DiscGrid, angGap, cellInfo, cellUsable, cityCenter, createPlacer, pickFloors, placeHills, pondsOf,
  spanHits, surfacePos, surfaceQuat, trafficRoads, zoneAt, W_TREE
} from '../layout/index.ts';
import { hullGeo, hullUvError } from '../scene/world-shapes.ts';

describe('layout parity with js/util.js', () => {
  test('zoneAt over every 0.25°, incl. sector borders', () => {
    for (let d = -360; d <= 720; d += 0.25) expect(zoneAt(d)).toBe(U.zoneAt(d));
  });

  test('city grid: centres, usability, cellInfo, pickFloors', () => {
    const seed = CONFIG.SEED >>> 0;
    for (let i = 0; i < CORE_CONFIG.CITY.cols; i++) {
      for (let j = 0; j < CORE_CONFIG.CITY.rows; j++) {
        expect(cityCenter(i, j)).toEqual(U.cityCenter(i, j));
        expect(cellUsable(i, j)).toBe(U.cellUsable(i, j));
        expect(cellInfo(seed, i, j)).toEqual(U.cellInfo(i, j));
      }
    }
    for (let u = 0; u < 1; u += 0.013) {
      for (const r of [[1, 5], [2, 6]] as [number, number][]) expect(pickFloors(u, r)).toBe(U.pickFloors(u, r));
    }
  });

  test('surface basis matches THREE (surfaceQuat / surfacePos)', () => {
    for (let t = -7; t < 7; t += 0.37) {
      const q = U.surfaceQuat(t);
      const c = surfaceQuat(t);
      expect([c[0], c[1], c[2], c[3]]).toEqual([q.x, q.y, q.z, q.w]);
      const p = U.surfacePos(t, 47.3, -12.5);
      expect(surfacePos(t, 47.3, -12.5)).toEqual([p.x, p.y, p.z]);
    }
  });

  test('traffic roads lie inside cities', () => {
    const roads = trafficRoads();
    expect(roads.length).toBeGreaterThan(0);
    for (const t of roads) expect(zoneAt(t * 180 / Math.PI)).toBe('city');
  });

  test('spanHits: a 14-unit hill straddling a 6° river is caught', () => {
    const t = 115 * Math.PI / 180;
    expect(spanHits(t + 0.2, 14, 50, ['rivers'])).toBe(true);
    expect(spanHits(200 * Math.PI / 180, 2, 50, ['rivers'])).toBe(false);
  });
});

describe('placement grid', () => {
  test('DiscGrid.fits === brute force over random queries (incl. wrap and ends)', () => {
    const R = CORE_CONFIG.R, HL = CORE_CONFIG.L / 2;
    const g = new DiscGrid(R, -HL - 16, HL + 16);
    const rnd = mulberry32(99);
    for (let k = 0; k < 3000; k++) g.add(rnd() * TAU * 3 - TAU, (rnd() - 0.5) * 320, 0.2 + rnd() * rnd() * 9);
    let differ = 0, rejected = 0;
    for (let k = 0; k < 20000; k++) {
      const t = rnd() * TAU * 2 - TAU / 2, z = (rnd() - 0.5) * 330, r = rnd() * 8;
      const a = g.fits(t, z, r), b = g.fitsBrute(t, z, r);
      if (a !== b) differ++;
      if (!b) rejected++;
    }
    expect(differ).toBe(0);
    expect(rejected).toBeGreaterThan(1000);   // the test exercises both outcomes
  });

  test('sample(): rnd order — rejected attempts in river zones skip the accept call', () => {
    const ponds = pondsOf(placeHills(mulberry32(1337 + 404), CORE_CONFIG.R, CORE_CONFIG.L));
    /* replay the stream by hand: rad, t, z, [accept] per attempt */
    const placer = createPlacer(ponds);
    const calls: number[] = [];
    const base = mulberry32(5);
    const rnd = (): number => { const v = base(); calls.push(v); return v; };
    const out = placer.sample(rnd, W_TREE, 50, () => rnd() * 0.5, false);
    expect(out.length).toBe(50);
    let i = 0;
    for (let a = 0; i < calls.length; a++) {
      i++;                                    // rad()
      const t = calls[i++] * TAU; i++;        // t, z
      if (W_TREE[zoneAt(t / (Math.PI / 180))] > 0) i++;
    }
    expect(i).toBe(calls.length);
  });

  test('angGap is symmetric and wraps', () => {
    expect(angGap(0.1, TAU - 0.1)).toBeCloseTo(0.2, 12);
    expect(angGap(TAU - 0.1, 0.1)).toBeCloseTo(0.2, 12);
  });
});

describe('hull UVs (baked θ, no BackSide mirror)', () => {
  test('u ≡ θ/2π at every vertex, normals face the axis, winding CCW from inside', () => {
    const hills = placeHills(mulberry32(1337 + 404), CORE_CONFIG.R, CORE_CONFIG.L);
    const g = hullGeo(CORE_CONFIG.R, CORE_CONFIG.L, CORE_CONFIG.HULL_SEG, 40, hills);
    expect(hullUvError(g)).toBeLessThan(1e-6);
    const p = g.position, n = g.normal, idx = g.index as Uint16Array;
    for (let k = 0; k < p.length / 3; k += 97) {
      expect(p[3 * k] * n[3 * k] + p[3 * k + 1] * n[3 * k + 1]).toBeLessThan(0);   // inward
    }
    /* geometric normal of each triangle (CCW) points towards the axis */
    let bad = 0;
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz;
      if (nx * p[a] + ny * p[a + 1] >= 0) bad++;
    }
    expect(bad).toBe(0);
  });

  test('same texel as legacy: legacy uv with repeat −1 / offset 0.5 equals the baked uv', () => {
    const hills = placeHills(mulberry32(42 + 404), CORE_CONFIG.R, CORE_CONFIG.L);
    const g = hullGeo(CORE_CONFIG.R, CORE_CONFIG.L, 256, 8, hills);
    /* legacy cylinder uv: u = x / segments along the ring, here recovered per vertex */
    for (let k = 0; k < g.uv.length / 2; k++) {
      const legacyU = (k % 257) / 256;
      expect(g.uv[2 * k]).toBe(-legacyU + 0.5);
    }
  });
});
