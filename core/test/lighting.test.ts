/* lightingAt must reproduce the legacy applyPalette maths (three.js Color
   lerp in linear working space). three is used here ONLY as a test oracle. */
import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { exposureFromEv100, hexToLinear, lightingAt } from '../lighting/phases.ts';
import { CORE_CONFIG } from '../config/index.ts';

const oracle = (a: number, b: number, t: number) => {
  const c = new THREE.Color().setHex(a).lerp(new THREE.Color().setHex(b), t);
  return [c.r, c.g, c.b];
};

describe('lightingAt', () => {
  test('hexToLinear matches THREE.Color.setHex', () => {
    for (const hex of [0x000000, 0xffffff, 0xb8cfe0, 0x1f4260, 0x537cb8, 0x808080]) {
      const c = new THREE.Color().setHex(hex);
      const l = hexToLinear(hex);
      expect(l[0]).toBeCloseTo(c.r, 6);
      expect(l[1]).toBeCloseTo(c.g, 6);
      expect(l[2]).toBeCloseTo(c.b, 6);
    }
  });

  test('pure phases return the palette values', () => {
    const d = lightingAt(0), k = lightingAt(1), n = lightingAt(2);
    expect(d.daylight).toBe(1);
    expect(k.daylight).toBe(0.5);
    expect(n.daylight).toBe(0);
    expect(d.fogDensity).toBe(CORE_CONFIG.DAY.fogD);
    expect(n.windowEmission).toBe(CORE_CONFIG.NIGHT.winEmis);
  });

  test('wraps: phase 3 ≡ 0 and −1 ≡ 2', () => {
    expect(lightingAt(3).fog).toEqual(lightingAt(0).fog);
    expect(lightingAt(-1).fogDensity).toBeCloseTo(lightingAt(2).fogDensity, 12);
  });

  test('colour lerp equals three.js oracle at fractional phases', () => {
    for (const ph of [0.25, 0.5, 1.3, 2.7]) {
      const L = lightingAt(ph);
      const P = CORE_CONFIG.PHASES;
      const i = Math.floor(ph) % 3;
      const A = CORE_CONFIG[P[i]], B = CORE_CONFIG[P[(i + 1) % 3]];
      const t = ph - Math.floor(ph);
      const o = oracle(A.fog, B.fog, t);
      L.fog.forEach((v, j) => expect(v).toBeCloseTo(o[j], 6));
      const w = oracle(A.waterTint, B.waterTint, t);
      L.waterTint.forEach((v, j) => expect(v).toBeCloseTo(w[j], 6));
    }
  });

  test('derived values follow daylight like applyPalette', () => {
    const n = lightingAt(2);
    expect(n.cloudOpacity).toBeCloseTo(0.06, 9);
    expect(n.trafficLamp).toBeCloseTo(CORE_CONFIG.TRAFFIC.lamp, 9);
    expect(lightingAt(0).blobOpacity).toBeCloseTo(CORE_CONFIG.PRINT.dark * 0.85, 9);
  });

  test('physical palette is monotone darker towards night', () => {
    const d = lightingAt(0).phys, n = lightingAt(2).phys;
    expect(n.tubeNits).toBeLessThan(d.tubeNits);
    expect(n.ev100).toBeLessThan(d.ev100);
    expect(n.channelNits.windows).toBeGreaterThan(d.channelNits.windows);
    expect(Math.max(...d.tubeColor)).toBeCloseTo(1, 9);
    expect(exposureFromEv100(0)).toBeCloseTo(1 / 1.2, 9);
  });
});
