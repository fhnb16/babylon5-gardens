/* ═══════════════════════════════════════════════════════════════════════════
   Sampler (PT-P4): Owen-scrambled Sobol (Burley 2020, "Practical Hash-based
   Owen Scrambling", JCGT 9(4)) — CPU mirror of wgsl/sampling.wgsl.

   • 4-D Sobol (Joe–Kuo direction numbers, dims 1…4 of new-joe-kuo-6.21201),
     generated here; the WGSL copy of the table (B5_SOBOL_V in sampling.wgsl)
     is checked against sobolDirections() by pathtracer/test/sampler.test.ts.
   • Higher dimensions are PADDED: dimension d belongs to 4-D group d >> 2;
     every group shuffles the sample index with its own nested uniform
     scramble (an Owen scramble of the index bits = a permutation that maps
     aligned power-of-two blocks onto aligned blocks, so every prefix of 2^m
     samples stays a (t, m, 4)-net), and every dimension gets its own Owen
     scramble of the output bits. Seeds: per pixel (hash of pixel index and
     the run salt) ⊕ group / dimension.
   • Owen scramble = reverse bits → Laine–Karras-style permutation
     (Vegdahl's improved hash, 2021) → reverse bits.
   • The sample index of a pixel is its accumulated sample count (the
     integrator reads it from the accumulation buffer), so adaptive sampling
     keeps every pixel on its own low-discrepancy sequence.

   Dimension allocation (SAMPLER_DIMS; identical constants in sampling.wgsl):
     group 0  dims 0, 1   pixel jitter x, y          dims 2, 3 reserved (lens)
     vertex depth b, base = 4 + 8·b:
       group A  +0, +1 BSDF direction   +2 BSDF lobe   +3 layer pick (hull foam / water / dry)
       group B  +4, +5 point on light   +6 light pick (tube vs triangles, tree)   +7 Russian roulette
     Every 2-D sample sits on components 0, 1 of its 4-D group: only that pair
     of Sobol dims is a (0, 2)-sequence (dims 2, 3 have t > 0).
   PCG (the M1 sampler) stays available behind SAMPLER_MODE.pcg.
   ═══════════════════════════════════════════════════════════════════════════ */

export const SAMPLER_MODE = { pcg: 0, sobol: 1 } as const;
export type SamplerName = keyof typeof SAMPLER_MODE;

export const SAMPLER_DIMS = {
  camera: 0,
  bounce0: 4,
  perBounce: 8,
  /** offsets inside a bounce */
  dir: 0, lobe: 2, layer: 3, lightPos: 4, lightPick: 6, rr: 7
} as const;

/** Joe–Kuo primitive polynomials (degree s, coefficients a, initial m) of Sobol dims 1…3 (dim 0 = van der Corput). */
export const JOE_KUO = [
  { s: 1, a: 0, m: [1] },
  { s: 2, a: 1, m: [1, 3] },
  { s: 3, a: 1, m: [1, 3, 1] }
] as const;

export const SOBOL_DIMS = 4;
export const SOBOL_BITS = 32;

/** Direction numbers V[dim·32 + bit] (bit 0 = most significant contribution). */
export function sobolDirections(): Uint32Array {
  const V = new Uint32Array(SOBOL_DIMS * SOBOL_BITS);
  for (let i = 0; i < SOBOL_BITS; i++) V[i] = (1 << (31 - i)) >>> 0;
  JOE_KUO.forEach(({ s, a, m }, k) => {
    const o = (k + 1) * SOBOL_BITS;
    for (let i = 0; i < SOBOL_BITS; i++) {
      if (i < s) { V[o + i] = (m[i] << (31 - i)) >>> 0; continue; }
      let v = V[o + i - s] ^ (V[o + i - s] >>> s);
      for (let j = 1; j < s; j++) if ((a >>> (s - 1 - j)) & 1) v ^= V[o + i - j];
      V[o + i] = v >>> 0;
    }
  });
  return V;
}

const DIRS = sobolDirections();

/** Unscrambled Sobol point (32-bit fixed point) of `index` in dimension 0…3. */
export function sobolU32(index: number, dim: number): number {
  let x = 0;
  const o = dim * SOBOL_BITS;
  for (let b = 0, i = index >>> 0; i !== 0; b++, i >>>= 1) if (i & 1) x ^= DIRS[o + b];
  return x >>> 0;
}

export function reverseBits32(x: number): number {
  x = ((x >>> 1) & 0x55555555) | ((x & 0x55555555) << 1);
  x = ((x >>> 2) & 0x33333333) | ((x & 0x33333333) << 2);
  x = ((x >>> 4) & 0x0f0f0f0f) | ((x & 0x0f0f0f0f) << 4);
  x = ((x >>> 8) & 0x00ff00ff) | ((x & 0x00ff00ff) << 8);
  return ((x >>> 16) | (x << 16)) >>> 0;
}

/** PCG hash (common.wgsl b5_pcg). */
export function pcgHash(v: number): number {
  const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
  const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
}

/** Laine–Karras-style permutation (Vegdahl 2021): output bit k depends only on input bits ≤ k. */
export function lkPermute(x: number, seed: number): number {
  x = (x ^ Math.imul(x, 0x3d20adea)) >>> 0;
  x = (x + seed) >>> 0;
  x = Math.imul(x, (seed >>> 16) | 1) >>> 0;
  x = (x ^ Math.imul(x, 0x05526c56)) >>> 0;
  x = (x ^ Math.imul(x, 0x53a22864)) >>> 0;
  return x;
}

/** Owen (nested uniform) scramble of a 32-bit fixed-point value. */
export function owenScramble(x: number, seed: number): number {
  return reverseBits32(lkPermute(reverseBits32(x >>> 0), seed >>> 0));
}

/** Seed combination (boost hash_combine over a PCG-hashed value). */
export function hashCombine(seed: number, v: number): number {
  return (seed ^ ((pcgHash(v) + 0x9e3779b9 + (seed << 6) + (seed >>> 2)) >>> 0)) >>> 0;
}

const PIXEL_SALT = 0x5bd1e995;
/** Per-pixel scramble seed (sampling.wgsl b5_pixel_seed). */
export function pixelSeed(pixel: number, salt: number): number {
  return pcgHash((pixel ^ pcgHash((salt ^ PIXEL_SALT) >>> 0)) >>> 0);
}

/**
 * Bits kept of the shuffled sample index. The nested scramble maps the first
 * 2^m indices onto an aligned 2^m block, and so does the block modulo 2^20,
 * so masking keeps every net property for up to 2^20 samples per pixel (the
 * legacy cap is 1e4 at 1 % noise) and halves the direction-number loop.
 */
export const SOBOL_INDEX_MASK = 0xfffff;

/** Owen-scrambled, index-shuffled (padded) Sobol sample as 32-bit fixed point. */
export function sobolOwenU32(index: number, dim: number, seed: number): number {
  const gseed = hashCombine(seed, dim >>> 2);
  const shuffled = (owenScramble(index, gseed) & SOBOL_INDEX_MASK) >>> 0;
  const comp = dim & 3;
  return owenScramble(sobolU32(shuffled, comp), hashCombine(gseed, comp + 1));
}

const INV24 = 1 / 16777216;
/** Sample in [0, 1) with 24-bit precision (f32-exact), as sampling.wgsl b5_rnd. */
export function sobolOwen(index: number, dim: number, seed: number): number {
  return (sobolOwenU32(index, dim, seed) >>> 8) * INV24;
}

/** PCG stream mirror (sampling.wgsl b5_path_seed / b5_rnd, mode pcg). */
export function pcgPathSeed(pixel: number, sample: number, salt: number): number {
  return pcgHash((pixel ^ pcgHash((sample ^ pcgHash(salt >>> 0)) >>> 0)) >>> 0);
}

export interface CpuSampler {
  /** next dimension in [0, 1) */
  next(): number;
  /** jump to the dimensions of vertex depth `depth` (no-op for PCG: its stream just continues) */
  bounce(depth: number): void;
}

/** CPU sampler with the integrator's dimension discipline (tests / reference renders). */
export function createCpuSampler(mode: SamplerName, pixel: number, sample: number, salt: number): CpuSampler {
  if (mode === 'pcg') {
    let st = pcgPathSeed(pixel, sample, salt);
    return {
      next() { st = pcgHash(st); return (st >>> 8) * INV24; },
      bounce() { /* sequential stream */ }
    };
  }
  const seed = pixelSeed(pixel, salt);
  let dim = SAMPLER_DIMS.camera;
  return {
    next() { return sobolOwen(sample, dim++, seed); },
    bounce(depth) { dim = SAMPLER_DIMS.bounce0 + depth * SAMPLER_DIMS.perBounce; }
  };
}

/** WGSL literal of the direction table of dims 1…3 (sampling.wgsl B5_SOBOL_V), for the consistency test. */
export function wgslSobolTable(): string {
  const v = Array.from(DIRS.subarray(SOBOL_BITS), (x) => `0x${x.toString(16).padStart(8, '0')}u`);
  const rows: string[] = [];
  for (let i = 0; i < v.length; i += 8) rows.push('  ' + v.slice(i, i + 8).join(', '));
  return `const B5_SOBOL_V: array<u32, ${v.length}> = array<u32, ${v.length}>(\n${rows.join(',\n')}\n);`;
}
