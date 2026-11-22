/* PT-P4 convergence: half-buffer pixel error (statistics on synthetic
   accumulations with a known noise level), tile reduction vs brute force,
   active-tile policy, percentile / samplesNeeded UX, valid-slot counting of
   the tile mapping, and the WGSL kernel shape (parse, B5Frame fields, no
   duplicate declarations in any integrator / denoiser module). */
import { describe, expect, test } from 'vitest';
import { WgslReflect } from 'wgsl_reflect/wgsl_reflect.module.js';
import { mulberry32 } from '../../core/rng.ts';
import { buildKernelSource } from '../kernels.ts';
import {
  CONVERGENCE, MEAN_ABS_TO_RMS, TILE_UNKNOWN, activePixels, calibrateStats, convergenceProgress, noiseCalibration, percentile,
  pixelError, samplesForNoise, selectActiveTiles, tileGrid, tilePixels, tileStatsRef
} from '../convergence.ts';
import { INTEGRATOR_KERNELS, STUB_DEFINES, integratorGeneratedSources, validSlots } from '../integrator.ts';
import { surfaceGeneratedSources } from '../scene-upload.ts';
import { loadWgslSources } from './wgsl-fs.ts';

const fsSources = loadWgslSources();
const sources = { ...fsSources, ...surfaceGeneratedSources(), ...integratorGeneratedSources() };

/** Box–Muller normal */
function gauss(rnd: () => number): number {
  return Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
}

/**
 * Synthetic accumulation: grey pixels of mean mu (luminance = rgb), w samples
 * of N(mu, sigma²) each (half buffer = even samples), as k_accumulate writes.
 */
function synth(width: number, height: number, w: number, mu: (x: number, y: number) => number, sigma: (x: number, y: number) => number, seed = 1) {
  const rnd = mulberry32(seed);
  const accum = new Float32Array(width * height * 4), half = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      let s = 0, h = 0;
      for (let k = 0; k < w; k++) {
        const v = mu(x, y) + sigma(x, y) * gauss(rnd);
        s += v;
        if ((k & 1) === 0) h += v;
      }
      accum.set([s, s, s, w], p * 4);
      half[p] = h;
    }
  }
  return { accum, half };
}

describe('pixel error estimator', () => {
  test('mean over pixels ≈ relative standard error of the pixel mean (linear tonemap region)', () => {
    /* exposure tiny → T(x) ≈ x, ε → 0: e estimates σ/(μ√w) */
    const mu = 1, sigma = 0.8, w = 64;
    const { accum, half } = synth(64, 64, w, () => mu, () => sigma, 7);
    let s = 0;
    for (let p = 0; p < 64 * 64; p++) s += pixelError(accum[p * 4], accum[p * 4 + 1], accum[p * 4 + 2], w, half[p], 1e-3, 0)[0];
    const est = s / (64 * 64), truth = sigma / (mu * Math.sqrt(w));
    expect(est / truth).toBeGreaterThan(0.95);
    expect(est / truth).toBeLessThan(1.05);
  });

  test('tonemap weighting discounts blown-out pixels; ε bounds near-black ones; fewer than 2 samples = no estimate', () => {
    const e = (mu: number, exposure: number, eps = 0) => {
      const { accum, half } = synth(32, 32, 16, () => mu, () => 0.5 * mu, 3);
      let s = 0;
      for (let p = 0; p < 1024; p++) s += pixelError(accum[p * 4], accum[p * 4 + 1], accum[p * 4 + 2], 16, half[p], exposure, eps)[0];
      return s / 1024;
    };
    expect(e(100, 1)).toBeLessThan(e(0.01, 1) / 10);  // same relative noise, saturated → small display error
    expect(e(1e-4, 1, 0.02)).toBeLessThan(0.01);       // near black: absolute, not relative
    expect(pixelError(1, 1, 1, 1, 1, 1, 0.02)).toEqual([0, 0]);
    expect(MEAN_ABS_TO_RMS).toBeCloseTo(1.2533141, 6);
  });
});

describe('tile reduction', () => {
  test('tileStatsRef = brute-force mean of pixel errors per 16×16 tile (partial edge tiles)', () => {
    const W = 50, H = 37;
    const { accum, half } = synth(W, H, 8, (x, y) => 0.1 + 0.01 * x + 0.02 * y, () => 0.05, 11);
    const g = tileGrid(W, H);
    expect(g).toEqual({ tilesX: 4, tilesY: 3, count: 12 });
    const st = tileStatsRef(accum, half, W, H);
    for (let t = 0; t < g.count; t++) {
      const tx = t % g.tilesX, ty = Math.floor(t / g.tilesX);
      let s = 0, n = 0;
      for (let y = ty * 16; y < Math.min(H, ty * 16 + 16); y++) {
        for (let x = tx * 16; x < Math.min(W, tx * 16 + 16); x++) {
          const p = y * W + x;
          s += pixelError(accum[p * 4], accum[p * 4 + 1], accum[p * 4 + 2], 8, half[p], CONVERGENCE.toneExposure, CONVERGENCE.epsilon)[0];
          n++;
        }
      }
      expect(st[t * 4]).toBeCloseTo(s / n, 6);
      expect(st[t * 4 + 1]).toBe(8);
      expect(st[t * 4 + 2]).toBe(8);
      expect(st[t * 4 + 3]).toBe(n);
      expect(n).toBe(tilePixels(t, W, H));
    }
    expect(activePixels(Array.from({ length: g.count }, (_, i) => i), W, H)).toBe(W * H);
  });

  test('tiles with fewer than 2 samples are unknown', () => {
    const accum = new Float32Array(16 * 16 * 4).fill(0);
    for (let p = 0; p < 256; p++) accum[p * 4 + 3] = 1;
    const st = tileStatsRef(accum, new Float32Array(256), 16, 16);
    expect(st[0]).toBe(TILE_UNKNOWN);
    expect(st[3]).toBe(0);
  });
});

describe('active tiles and the legacy UX', () => {
  const rec = (e: number, minW: number) => [e, minW, minW, 256];
  test('policy: minSpp first, then target, cap stops; p95 over tiles', () => {
    const stats = Float32Array.from([
      ...rec(0.01, 8),       // under minSpp → active
      ...rec(0.01, 32),      // converged
      ...rec(0.05, 32),      // above target → active
      ...rec(0.05, 1111),    // capped
      ...rec(TILE_UNKNOWN, 1) // unknown → active, counts as ∞ in the percentile
    ]);
    const s = selectActiveTiles(stats, { target: 0.03, capSpp: 1111 });
    expect(Array.from(s.active)).toEqual([0, 2, 4]);
    expect(s.converged).toBe(1);
    expect(s.capped).toBe(1);
    expect(s.done).toBe(false);
    expect(s.noise).toBe(Infinity);
    expect(s.minSpp).toBe(1);
    const done = selectActiveTiles(Float32Array.from([...rec(0.02, 64), ...rec(0.04, 1111)]), { target: 0.03, capSpp: 1111 });
    expect(done.done).toBe(true);
    expect(done.noise).toBeCloseTo(0.04, 6);
  });

  test('percentile, samplesNeeded (legacy ceil(1e4/noise²)), progress, calibration', () => {
    expect(percentile([5, 1, 4, 2, 3], 0.95)).toBe(5);
    expect(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 0.95)).toBe(95);
    expect(percentile([], 0.5)).toBe(Infinity);
    expect(samplesForNoise(3)).toBe(1112);
    expect(samplesForNoise(1)).toBe(10000);
    expect(samplesForNoise(5)).toBe(400);
    expect(convergenceProgress(0.06, 0.03, 100, 1112, false)).toBeCloseTo(0.25, 6);
    expect(convergenceProgress(0.03, 0.03, 100, 1112, true)).toBe(1);
    expect(convergenceProgress(Infinity, 0.03, 0, 1112, false)).toBe(0);
    expect(noiseCalibration('pcg')).toBe(1);
    const st = Float32Array.from([...rec(0.3, 8), ...rec(TILE_UNKNOWN, 1)]);
    const c = calibrateStats(st, 0.5);
    expect(c[0]).toBeCloseTo(0.15, 6);
    expect(c[4]).toBe(TILE_UNKNOWN);
    expect(st[0]).toBeCloseTo(0.3, 6); // input untouched
  });

  test('valid slots of the tile mapping (edge tiles are partial)', () => {
    const W = 40, H = 20; // tiles 3 × 2: widths 16 16 8, heights 16 4
    const all = [0, 1, 2, 3, 4, 5];
    expect(validSlots(all, 0, 6 * 256, W, H)).toBe(W * H);
    expect(validSlots([2], 0, 256, W, H)).toBe(8 * 16);
    expect(validSlots([5], 0, 256, W, H)).toBe(8 * 4);
    // 56 slots of tile 0, then slots 0..43 of tile 5 = rows 0..2, 8 valid columns each
    expect(validSlots([0, 5], 200, 100, W, H)).toBe(56 + 24);
    expect(validSlots([0, 5], 256, 48, W, H)).toBe(8 * 3);
    expect(validSlots([], 0, 10, W, H)).toBe(0);
  });
});

describe('WGSL modules', () => {
  test('no duplicate module-scope declarations in any integrator kernel (the WGSL compiler rejects them; wgsl_reflect does not)', () => {
    const defines = { B5_SPECULAR: true, ...STUB_DEFINES };
    for (const k of Object.values(INTEGRATOR_KERNELS)) {
      const code = buildKernelSource(k.file, sources, defines).code;
      const names = [...code.matchAll(/^(?:const|override|fn|struct|var(?:<[^>]*>)?)\s+(\w+)/gm)].map((m) => m[1]);
      const dup = names.filter((n, i) => names.indexOf(n) !== i);
      expect(dup, k.file).toEqual([]);
    }
  });

  test('k_tilestats parses and uses the frame fields of convergence', () => {
    const code = buildKernelSource('k_tilestats.wgsl', sources, {}).code;
    const r = new WgslReflect(code);
    expect(r.entry.compute.map((f) => f.name)).toEqual(['b5_k_tilestats']);
    expect(code).toMatch(/f\.toneExp/);
    expect(code).toMatch(/f\.convEps/);
    expect(code).toMatch(/const B5_TILE_UNKNOWN: f32 = 1\.0e9;/);
    expect(TILE_UNKNOWN).toBe(1e9);
    expect(code).toMatch(/const B5_TILE: u32 = 16u;/);
    expect(CONVERGENCE.tile).toBe(16);
  });

  test('k_atrous parses: three entry points, hygiene', () => {
    const code = fsSources['k_atrous.wgsl'];
    const r = new WgslReflect(code);
    expect(r.entry.compute.map((f) => f.name).sort()).toEqual(['b5_k_atrous_final', 'b5_k_atrous_pass', 'b5_k_atrous_prep']);
    expect(code.includes('$')).toBe(false);
    for (const m of code.matchAll(/^(?:const|override|fn|struct|var(?:<[^>]*>)?)\s+(\w+)/gm)) expect(m[1]).toMatch(/^(B5|b5_)/);
  });
});
