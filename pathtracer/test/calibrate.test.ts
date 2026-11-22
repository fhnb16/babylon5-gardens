/* PT-W4a calibration (pathtracer/tools/calibrate.ts): raster light model,
   indirect multiplier vs the CPU reference integrator, and the proposed
   PHYS table == pathtracer/config.ts PHYS_OVERRIDE (what the tracer uses). */
import { describe, expect, test } from 'vitest';
import { mulberry32 } from '../../core/rng.ts';
import { CORE_CONFIG } from '../../core/config/index.ts';
import { lightingAt } from '../../core/lighting/phases.ts';
import { PHYS_OVERRIDE, tracerLightingAt } from '../config.ts';
import { refRadiance, type RefScene } from '../integrator-ref.ts';
import type { TubeGeom } from '../lights/tube.ts';
import {
  CALIBRATION, RASTER_LIGHTS_HIGH, calibrate, formatPhysTable, giFactor, rasterIrradiance, threeDistanceAttenuation
} from '../tools/calibrate.ts';

const S = CORE_CONFIG.SUN;
const TUBE: TubeGeom = { radius: S.r, length: S.len, z0: -S.len / 2 };

describe('calibration', () => {
  test('raster light model: three attenuation, hemisphere orientation', () => {
    expect(threeDistanceAttenuation(50, 380, 1.05)).toBeCloseTo((1 / 50 ** 1.05) * (1 - (50 / 380) ** 4) ** 2, 12);
    expect(threeDistanceAttenuation(400, 380, 1.05)).toBe(0);
    const s = lightingAt(0);
    const noPts = { ...RASTER_LIGHTS_HIGH, pointZ: [] };
    const up = rasterIrradiance([0, -50, 0], [0, 1, 0], s, noPts);
    const down = rasterIrradiance([0, 50, 0], [0, -1, 0], s, noPts);
    for (let c = 0; c < 3; c++) {
      expect(up[c]).toBeCloseTo(s.hemiSky[c] * s.hemiIntensity, 9);
      expect(down[c]).toBeCloseTo(s.hemiGround[c] * s.hemiIntensity, 9);
    }
  });

  test('indirect multiplier G = 1/(1 − ρ̄(1 − r/R)) vs the CPU reference integrator (closed cylinder + tube)', () => {
    const rho = CALIBRATION.meanAlbedo;
    const sc: RefScene = { R: CORE_CONFIG.R, H: CORE_CONFIG.L, albedo: rho, Le: 0, tube: { ...TUBE, Le: 1 } };
    const rnd = mulberry32(31);
    const N = 30000;
    let full = 0, direct = 0;
    for (let i = 0; i < N; i++) {
      // radiance reflected by the wall at (0, −50, z) toward the axis = ρ/π · E
      const z = -60 + 120 * rnd();
      full += refRadiance(sc, [0, -45, z], [0, -1, 0], rnd, { maxDepth: 48, rrDepth: 3 });
      direct += refRadiance(sc, [0, -45, z], [0, -1, 0], rnd, { maxDepth: 1, rrDepth: 3 });
    }
    const G = full / direct, Ga = giFactor(rho, TUBE, CORE_CONFIG.R);
    console.log(`[calibrate] G: CPU reference ${G.toFixed(4)} vs analytic ${Ga.toFixed(4)} (ρ̄ = ${rho})`);
    expect(Math.abs(G / Ga - 1)).toBeLessThan(0.06);
  });

  test('proposed PHYS table == config.ts PHYS_OVERRIDE (the tracer uses it); report', () => {
    const c = calibrate(TUBE);
    const rows = CORE_CONFIG.PHASES.map((id) => {
      const k = c[id];
      return `  ${id}: raster floor E ${k.rasterFloorE.toFixed(4)}, unit-tube floor E ${k.tubeUnitE.toFixed(4)}, G ${k.gi.toFixed(3)} → ` +
        `tube Le ${k.tubeLe.toFixed(4)} (scene units) = ${k.tubeNits} nits @ EV ${k.ev100} (first guess ${k.tubeNitsCore}); ` +
        `visible raster sun ${k.rasterSunLe.toFixed(3)}`;
    });
    console.log('[calibrate]\n' + rows.join('\n') + '\nproposed CORE_CONFIG.PHYS:\n' + formatPhysTable(c));
    for (const id of CORE_CONFIG.PHASES) {
      expect(PHYS_OVERRIDE[id].ev100).toBe(c[id].palette.ev100);
      expect(PHYS_OVERRIDE[id].tubeNits).toBeCloseTo(c[id].palette.tubeNits, 6);
      for (const [ch, v] of Object.entries(c[id].palette.channelNits)) {
        expect(PHYS_OVERRIDE[id].channelNits[ch as keyof typeof PHYS_OVERRIDE.DAY.channelNits], `${id}.${ch}`).toBeCloseTo(v, 6);
      }
    }
    // the tracer palette is the core one with PHYS replaced
    const t = tracerLightingAt(2), l = lightingAt(2);
    expect(t.hemiIntensity).toBe(l.hemiIntensity);
    expect(t.phys.tubeNits).toBeCloseTo(PHYS_OVERRIDE.NIGHT.tubeNits, 6);
  });
});
