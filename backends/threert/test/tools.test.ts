/* PNG codec / delta E used by tools/bake.mjs and tools/shots.mjs, and the core hill layout the sim collides with. */
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mulberry32 } from '../../../core/rng.ts';
import { CORE_CONFIG } from '../../../core/config/index.ts';
import { placeHills } from '../../../core/layout/hills.ts';
import * as sim from '../src/sim/index.ts';

const png: any = await import(/* @vite-ignore */ pathToFileURL(resolve(import.meta.dirname, '../tools/lib/png.mjs')).href);

describe('png codec', () => {
  it('round-trips RGBA8 exactly (all three row filters get used)', () => {
    const w = 37, h = 29, rnd = mulberry32(3);
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = x * 7; data[i + 1] = y * 8;                         // gradients: Sub / Up win
      data[i + 2] = y < 10 ? (rnd() * 256) | 0 : 128;               // noise: None wins
      data[i + 3] = 255 - x;
    }
    const buf = png.encodePng(w, h, data);
    const d = png.decodePng(buf);
    expect([d.width, d.height]).toEqual([w, h]);
    expect(Buffer.from(d.data).equals(Buffer.from(data.buffer))).toBe(true);
    expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });

  it('delta E: zero for equal images, grows with the difference, white vs black is 100', () => {
    const mk = (v: number) => ({ width: 4, height: 4, data: new Uint8Array(64).fill(v) });
    expect(png.deltaE(mk(10), mk(10)).mean).toBe(0);
    expect(png.deltaE(mk(10), mk(20)).mean).toBeLessThan(png.deltaE(mk(10), mk(60)).mean);
    expect(png.deltaE(mk(0), mk(255)).mean).toBeCloseTo(100, 0);
    expect(() => png.deltaE(mk(0), { width: 2, height: 2, data: new Uint8Array(16) })).toThrow(/size mismatch/);
  });
});

describe('core hills feed the sim', () => {
  it('placeHills(seed + 404) is deterministic and accepted by hillsFromLegacy', () => {
    const a = placeHills(mulberry32(1337 + 404), CORE_CONFIG.R, CORE_CONFIG.L);
    const b = placeHills(mulberry32(1337 + 404), CORE_CONFIG.R, CORE_CONFIG.L);
    expect(a).toEqual(b);
    const hills = sim.hillsFromLegacy(a);
    expect(hills.length).toBe(a.length);
    /* at a hill centre the wall is lifted by exactly the signed rise (single-hill neighbourhood) */
    const h = hills[0];
    const alone = sim.terrainRadiusAt(h.theta, h.z, [h]);
    expect(alone).toBeCloseTo(CORE_CONFIG.R - h.rise, 9);
  });
});
