/* PT-P4 à-trous CPU mirror (denoise.ts atrousRef = k_atrous.wgsl; GPU parity
   is checked in tests/browser/pt-output.spec.ts (a)): energy / constant
   preservation, noise reduction on flat regions, edge preservation across
   normal and depth discontinuities, albedo (texture) detail kept by the
   demodulation, variance propagation. */
import { describe, expect, test } from 'vitest';
import { mulberry32 } from '../../core/rng.ts';
import { DENOISE, atrousRef } from '../denoise.ts';

interface Scene {
  W: number;
  H: number;
  /** radiance of the illumination (before albedo) */
  light: (x: number, y: number) => number;
  albedo: (x: number, y: number) => number;
  normal: (x: number, y: number) => [number, number, number];
  depth: (x: number, y: number) => number;
  sigma: number;
  spp: number;
}

function gauss(r: () => number): number {
  return Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
}

/** accumulation buffers as the integrator writes them (spp samples, half = even samples, AOV sums) */
function render(s: Scene, seed = 1) {
  const r = mulberry32(seed);
  const n = s.W * s.H;
  const accum = new Float32Array(n * 4), half = new Float32Array(n), aov = new Float32Array(n * 8), truth = new Float32Array(n * 3);
  for (let y = 0; y < s.H; y++) {
    for (let x = 0; x < s.W; x++) {
      const p = y * s.W + x;
      const a = s.albedo(x, y), L = s.light(x, y) * a;
      let sum = 0, h = 0;
      for (let k = 0; k < s.spp; k++) {
        const v = L * (1 + s.sigma * gauss(r));
        sum += v;
        if ((k & 1) === 0) h += v;
      }
      accum.set([sum, sum, sum, s.spp], p * 4);
      half[p] = 0.2126 * h + 0.7152 * h + 0.0722 * h;
      const nn = s.normal(x, y);
      aov.set([a * s.spp, a * s.spp, a * s.spp, s.depth(x, y) * s.spp, nn[0] * s.spp, nn[1] * s.spp, nn[2] * s.spp, 0], p * 8);
      truth.set([L, L, L], p * 3);
    }
  }
  return { accum, half, aov, truth };
}

function rmseOver(a: Float32Array, b: Float32Array, W: number, pick: (x: number, y: number) => boolean): number {
  let s = 0, n = 0;
  for (let p = 0; p < a.length / 3; p++) {
    const x = p % W, y = Math.floor(p / W);
    if (!pick(x, y)) continue;
    s += (a[p * 3] - b[p * 3]) ** 2; n++;
  }
  return Math.sqrt(s / n);
}

const flat: Omit<Scene, 'light' | 'normal' | 'depth'> = { W: 48, H: 32, albedo: () => 0.5, sigma: 0.5, spp: 16 };

describe('à-trous CPU mirror', () => {
  test('a noise-free constant image is unchanged', () => {
    const s: Scene = { ...flat, sigma: 0, light: () => 2, normal: () => [0, 0, 1], depth: () => 10 };
    const r = render(s);
    const { rgb } = atrousRef(r.accum, r.half, r.aov, s.W, s.H);
    for (let i = 0; i < rgb.length; i++) expect(rgb[i]).toBeCloseTo(1, 5);
  });

  test('flat noisy region: error drops several-fold, mean preserved, variance propagated down', () => {
    const s: Scene = { ...flat, light: () => 2, normal: () => [0, 0, 1], depth: () => 10 };
    const r = render(s, 5);
    const noisy = new Float32Array(s.W * s.H * 3);
    for (let p = 0; p < s.W * s.H; p++) noisy.fill(r.accum[p * 4] / s.spp, p * 3, p * 3 + 3);
    const { rgb, stages } = atrousRef(r.accum, r.half, r.aov, s.W, s.H);
    const all = () => true;
    const e0 = rmseOver(noisy, r.truth, s.W, all), e1 = rmseOver(rgb, r.truth, s.W, all);
    console.log(`[denoise] flat: rmse ${e0.toFixed(4)} → ${e1.toFixed(4)} (×${(e0 / e1).toFixed(1)})`);
    expect(e1).toBeLessThan(e0 / 3);
    let m = 0;
    for (let p = 0; p < rgb.length; p += 3) m += rgb[p];
    expect(m / (rgb.length / 3)).toBeCloseTo(1, 1);
    const meanVar = (st: Float32Array) => { let v = 0; for (let p = 3; p < st.length; p += 4) v += st[p]; return v / (st.length / 4); };
    expect(stages).toHaveLength(DENOISE.passes + 1);
    expect(meanVar(stages[stages.length - 1])).toBeLessThan(meanVar(stages[0]) / 10);
  });

  test('normal and depth discontinuities are not blurred across', () => {
    /* left half: floor (normal +z, depth 10, bright); right half: wall (normal +x, depth 30, dark) */
    const left = (x: number) => x < 24;
    const s: Scene = {
      ...flat, sigma: 0.3,
      light: (x) => (left(x) ? 4 : 0.5),
      normal: (x) => (left(x) ? [0, 0, 1] : [1, 0, 0]),
      depth: (x) => (left(x) ? 10 : 30)
    };
    const r = render(s, 9);
    const { rgb } = atrousRef(r.accum, r.half, r.aov, s.W, s.H);
    // columns next to the edge keep their side's level (no bleeding)
    for (let y = 4; y < 28; y += 6) {
      expect(rgb[(y * s.W + 23) * 3]).toBeGreaterThan(1.6);  // truth 2
      expect(rgb[(y * s.W + 24) * 3]).toBeLessThan(0.4);    // truth 0.25
    }
    // with identical guides the same luminance step WOULD blur (the guides do the work)
    const same: Scene = { ...s, normal: () => [0, 0, 1], depth: () => 10, sigma: 0.3 };
    const r2 = render(same, 9);
    const blur = atrousRef(r2.accum, r2.half, r2.aov, s.W, s.H, { sigmaL: 1e6 }).rgb;
    expect(blur[(16 * s.W + 24) * 3]).toBeGreaterThan(0.4);
  });

  test('albedo detail (texture) survives through demodulation', () => {
    /* checkerboard albedo under smooth light */
    const s: Scene = {
      ...flat, sigma: 0.4,
      albedo: (x, y) => (((x >> 1) + (y >> 1)) & 1 ? 0.8 : 0.2),
      light: () => 1, normal: () => [0, 0, 1], depth: () => 10
    };
    const r = render(s, 13);
    const { rgb } = atrousRef(r.accum, r.half, r.aov, s.W, s.H);
    const e1 = rmseOver(rgb, r.truth, s.W, () => true);
    const noisy = new Float32Array(s.W * s.H * 3);
    for (let p = 0; p < s.W * s.H; p++) noisy.fill(r.accum[p * 4] / s.spp, p * 3, p * 3 + 3);
    const e0 = rmseOver(noisy, r.truth, s.W, () => true);
    console.log(`[denoise] checker albedo: rmse ${e0.toFixed(4)} → ${e1.toFixed(4)}`);
    expect(e1).toBeLessThan(e0 / 2);
    expect(rgb[(5 * s.W + 7) * 3] / rgb[(5 * s.W + 5) * 3]).toBeGreaterThan(3.5); // albedo 0.8 vs 0.2: contrast 4 kept
  });
});
