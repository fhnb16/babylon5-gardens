/* PT-P4 sampler: Owen-scrambled Sobol (sampler.ts) — direction numbers vs the
   WGSL table, known Sobol points, net properties (stratification) that the
   Owen scramble and the index shuffle must preserve, low discrepancy vs PCG,
   determinism, dimension allocation shared with sampling.wgsl. */
import { describe, expect, test } from 'vitest';
import {
  SAMPLER_DIMS, SOBOL_INDEX_MASK, createCpuSampler, lkPermute, owenScramble, pcgHash, pixelSeed, reverseBits32,
  sobolOwen, sobolOwenU32, sobolU32, wgslSobolTable
} from '../sampler.ts';
import { loadWgslSources } from './wgsl-fs.ts';

const sources = loadWgslSources();
const samplingWgsl = sources['sampling.wgsl'];

/** count of points per cell of a 2^a × 2^b grid on dims (dx, dy) */
function cells(pts: number[][], dx: number, dy: number, a: number, b: number): Uint32Array {
  const c = new Uint32Array(1 << (a + b));
  for (const p of pts) c[(Math.floor(p[dx] * (1 << a)) << b) | Math.floor(p[dy] * (1 << b))]++;
  return c;
}

/** every elementary interval of the (0, m, 2)-net structure holds exactly one point */
function isZeroNet2D(pts: number[][], dx: number, dy: number, m: number): boolean {
  for (let a = 0; a <= m; a++) if (!cells(pts, dx, dy, a, m - a).every((n) => n === 1)) return false;
  return true;
}

/** L2-star discrepancy (Warnock's formula) of 2-D points */
function l2Star(pts: number[][]): number {
  const n = pts.length;
  let s1 = 0, s2 = 0;
  for (const p of pts) s1 += (1 - p[0] * p[0]) * (1 - p[1] * p[1]);
  for (const p of pts) for (const q of pts) s2 += (1 - Math.max(p[0], q[0])) * (1 - Math.max(p[1], q[1]));
  return Math.sqrt(1 / 9 - (2 / n) * (s1 / 4) + s2 / (n * n));
}

describe('Sobol direction numbers', () => {
  test('WGSL table in sampling.wgsl = sampler.ts sobolDirections()', () => {
    const want = wgslSobolTable().replace(/\s+/g, ' ');
    const m = /const B5_SOBOL_V: array<u32, 96> = array<u32, 96>\([^)]*\);/.exec(samplingWgsl);
    expect(m, 'B5_SOBOL_V in sampling.wgsl').toBeTruthy();
    expect(m![0].replace(/\s+/g, ' ')).toBe(want);
  });

  test('first points equal the reference Sobol sequence (Joe–Kuo, direct ordering)', () => {
    const want = [
      [0, 0, 0, 0], [0.5, 0.5, 0.5, 0.5], [0.25, 0.75, 0.75, 0.75], [0.75, 0.25, 0.25, 0.25],
      [0.125, 0.625, 0.375, 0.125], [0.625, 0.125, 0.875, 0.625], [0.375, 0.375, 0.625, 0.875], [0.875, 0.875, 0.125, 0.375]
    ];
    for (let i = 0; i < want.length; i++) for (let d = 0; d < 4; d++) expect(sobolU32(i, d) / 2 ** 32).toBe(want[i][d]);
  });

  test('dimension allocation constants are shared with sampling.wgsl', () => {
    const val = (n: string) => Number(new RegExp(`const ${n}: u32 = (\\d+)u;`).exec(samplingWgsl)?.[1]);
    expect(val('B5_DIM_CAMERA')).toBe(SAMPLER_DIMS.camera);
    expect(val('B5_DIM_BOUNCE0')).toBe(SAMPLER_DIMS.bounce0);
    expect(val('B5_DIMS_PER_BOUNCE')).toBe(SAMPLER_DIMS.perBounce);
    expect(Number(/const B5_SOBOL_INDEX_MASK: u32 = (0x[0-9a-f]+)u;/.exec(samplingWgsl)?.[1])).toBe(SOBOL_INDEX_MASK);
    expect(SAMPLER_DIMS.rr).toBeLessThan(SAMPLER_DIMS.perBounce);
    expect(SAMPLER_DIMS.bounce0 % 4).toBe(0); // bounce dims start on a 4-D group
    expect(SAMPLER_DIMS.perBounce % 4).toBe(0);
  });
});

describe('Owen scrambling', () => {
  test('bit reversal and the LK permutation are bijections with the nested property', () => {
    expect(reverseBits32(1)).toBe(0x80000000);
    expect(reverseBits32(0x80000000)).toBe(1);
    expect(reverseBits32(reverseBits32(0x12345678))).toBe(0x12345678);
    // output bit k depends on input bits ≤ k only: inputs equal in the low k+1 bits → outputs equal there
    for (let t = 0; t < 200; t++) {
      const seed = pcgHash(t), x = pcgHash(t + 1000), k = t % 31;
      const mask = (2 ** (k + 1) - 1) >>> 0;
      const y = ((x & mask) | (pcgHash(t + 2000) & ~mask)) >>> 0;
      expect((lkPermute(x, seed) & mask) >>> 0).toBe((lkPermute(y, seed) & mask) >>> 0);
    }
  });

  test('scrambled index blocks: the first 2^m shuffled indices form an aligned block', () => {
    for (const seed of [1, 0xdeadbeef, 12345]) {
      for (const m of [2, 5, 8]) {
        const s = Array.from({ length: 1 << m }, (_, i) => owenScramble(i, seed));
        const hi = s.map((v) => Math.floor(v / 2 ** m));
        expect(new Set(hi).size).toBe(1);
        expect(new Set(s.map((v) => v % 2 ** m)).size).toBe(1 << m);
        // still an aligned block after masking to the kept index bits
        expect(new Set(s.map((v) => Math.floor((v & SOBOL_INDEX_MASK) / 2 ** m))).size).toBe(1);
      }
    }
  });

  test.each([[3], [6], [9]])('2^%i padded Owen–Sobol points: (0, m, 2)-nets on every bounce pair and 1-D strata on every dim', (m) => {
    for (const seed of [pixelSeed(0, 0), pixelSeed(123456, 7)]) {
      const n = 1 << m;
      const dims = 4 + 2 * SAMPLER_DIMS.perBounce;
      const pts = Array.from({ length: n }, (_, i) => Array.from({ length: dims }, (_, d) => sobolOwen(i, d, seed)));
      // jitter, BSDF direction, light position of two bounces
      const pairs: [number, number][] = [[0, 1]];
      for (let b = 0; b < 2; b++) {
        const o = SAMPLER_DIMS.bounce0 + b * SAMPLER_DIMS.perBounce;
        pairs.push([o + SAMPLER_DIMS.dir, o + SAMPLER_DIMS.dir + 1], [o + SAMPLER_DIMS.lightPos, o + SAMPLER_DIMS.lightPos + 1]);
      }
      for (const [dx, dy] of pairs) expect(isZeroNet2D(pts, dx, dy, m), `dims ${dx},${dy}`).toBe(true);
      for (let d = 0; d < dims; d++) {
        const strata = new Uint32Array(n);
        for (const p of pts) strata[Math.floor(p[d] * n)]++;
        expect(strata.every((c) => c === 1), `dim ${d}`).toBe(true);
      }
    }
  });

  test('lower discrepancy than PCG (L2-star, 256 points, 2-D)', () => {
    let sob = 0, pcg = 0;
    const trials = 8;
    for (let t = 0; t < trials; t++) {
      const seed = pixelSeed(t * 7919, 3);
      const S = Array.from({ length: 256 }, (_, i) => [sobolOwen(i, 4 + SAMPLER_DIMS.dir, seed), sobolOwen(i, 4 + SAMPLER_DIMS.dir + 1, seed)]);
      const P = Array.from({ length: 256 }, (_, i) => { const s = createCpuSampler('pcg', t, i, 3); return [s.next(), s.next()]; });
      sob += l2Star(S); pcg += l2Star(P);
    }
    console.log(`[sampler] L2-star discrepancy @256: Owen–Sobol ${(sob / trials).toExponential(3)}, PCG ${(pcg / trials).toExponential(3)}`);
    expect(sob).toBeLessThan(pcg / 4);
  });

  test('integration error of a smooth 2-D integrand decays faster than 1/√n', () => {
    const f = (x: number, y: number) => Math.exp(-x) * Math.sin(3 * y) + x * y; // ∫∫ = (1 − e⁻¹)(1 − cos 3)/3 + 1/4
    const exact = (1 - Math.exp(-1)) * (1 - Math.cos(3)) / 3 + 0.25;
    const rms = (n: number) => {
      let s = 0;
      for (let t = 0; t < 32; t++) {
        const seed = pixelSeed(t, 99);
        let m = 0;
        for (let i = 0; i < n; i++) m += f(sobolOwen(i, 0, seed), sobolOwen(i, 1, seed));
        s += (m / n - exact) ** 2;
      }
      return Math.sqrt(s / 32);
    };
    const e16 = rms(16), e256 = rms(256);
    console.log(`[sampler] smooth 2-D integrand rms error: 16 spp ${e16.toExponential(2)}, 256 spp ${e256.toExponential(2)} (×${(e16 / e256).toFixed(1)}; MC would be ×4)`);
    expect(e16 / e256).toBeGreaterThan(8);
  });

  test('deterministic, seed-dependent, values in [0, 1) with 24-bit precision', () => {
    const a = createCpuSampler('sobol', 42, 5, 1), b = createCpuSampler('sobol', 42, 5, 1), c = createCpuSampler('sobol', 43, 5, 1);
    const va = Array.from({ length: 12 }, () => a.next()), vb = Array.from({ length: 12 }, () => b.next()), vc = Array.from({ length: 12 }, () => c.next());
    expect(va).toEqual(vb);
    expect(va).not.toEqual(vc);
    for (const v of va) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1); expect(v * 2 ** 24).toBe(Math.floor(v * 2 ** 24)); }
    a.bounce(1);
    expect(a.next()).toBe(sobolOwen(5, SAMPLER_DIMS.bounce0 + SAMPLER_DIMS.perBounce, pixelSeed(42, 1)));
    expect(sobolOwenU32(5, 9, 77)).toBe(sobolOwenU32(5, 9, 77));
  });
});

/* The GPU sampler is compared with this CPU mirror bit for bit in the browser
   (pathtracer/smoke/pt-output.ts mode=stats, tests/browser/pt-output.spec.ts (a)):
   the wgsl_reflect interpreter does not wrap u32 multiplication (b5_pcg differs)
   and cannot index the const direction table in a loop, so it cannot run it. */
