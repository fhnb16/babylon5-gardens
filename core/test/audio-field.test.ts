/* core/audio/field: identical levels to the pure functions of js/audio.js. */
import { describe, expect, test } from 'vitest';
import * as A from '../../js/audio.js';
import { CONFIG } from '../../js/config.js';
import { mulberry32 } from '../rng.ts';
import { ambienceTargets, birdLevel, fieldAt, humLevel, SPEED_MAX_DEFAULT, waterLevel, windLevel } from '../audio/field.ts';

describe('audio field parity', () => {
  test('speed limit default equals legacy CONFIG.SPEED_MAX', () => {
    expect(SPEED_MAX_DEFAULT).toBe(CONFIG.SPEED_MAX);
  });

  test('levels over random points of the station', () => {
    const rnd = mulberry32(3);
    for (let k = 0; k < 2000; k++) {
      const t = rnd() * Math.PI * 2, r = rnd() * 50, z = (rnd() - 0.5) * 300;
      const p = { x: Math.sin(t) * r, y: Math.cos(t) * r, z };
      const fl = A.fieldAt(p), fc = fieldAt([p.x, p.y, p.z]);
      expect(fc).toEqual(fl);
      const speed = rnd() * 60, day = rnd() * 1.2 - 0.1;
      expect(waterLevel(fc)).toBe(A.waterLevel(fl));
      expect(windLevel(fc, speed)).toBe(A.windLevel(fl, speed));
      expect(humLevel(fc)).toBe(A.humLevel(fl));
      expect(birdLevel(fc, day)).toBe(A.birdLevel(fl, day));
    }
  });

  test('targets: water loud on a river bank, birds silent in a city', () => {
    const river = 115 * Math.PI / 180, city = 25 * Math.PI / 180;
    const atRiver = ambienceTargets([Math.sin(river) * 49, Math.cos(river) * 49, 0], 0, 1);
    expect(atRiver.water).toBeGreaterThan(0.25);
    const atCity = ambienceTargets([Math.sin(city) * 48, Math.cos(city) * 48, 0], 0, 1);
    expect(atCity.birds).toBe(0);
  });
});
