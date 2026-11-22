/* ═══════════════════════════════════════════════════════════════════════════
   Convergence / adaptive sampling (PT-P4) — CPU side and mirrors of
   wgsl/k_tilestats.wgsl.

   Estimator (Dammertz et al. 2010 style half buffer): k_accumulate also sums
   the luminance of every even sample into half[pixel]; A = even-sample mean,
   B = odd-sample mean. Per pixel, in display space (T(x) = x/(1+x) of the
   luminance × the presenter exposure — tonemap weighting):
       e = |T(A) − T(B)| / (T(A) + T(B) + ε) · √(π/2)
   ≈ the relative standard error of the pixel mean. A 16×16 tile's error is
   the mean e of its pixels.

   Policy (selectActiveTiles):
     • a tile stays ACTIVE while  minW < minSpp  or  (error > target and minW < cap);
     • inactive (converged / capped) tiles are skipped by k_raygen (active tile
       list → B5_F_TILES mapping); they never come back until a reset;
     • noiseNow = 95th percentile of the tile errors (%), tiles without an
       estimate yet count as +∞ (→ 100 %);
     • the UX of js/pathtrace.js is kept: target noise % (CONFIG.PATH.noise),
       samplesNeeded() = ceil(1e4 / noise²) is the per-pixel spp CAP.
   ═══════════════════════════════════════════════════════════════════════════ */

import { RASTER_TONE_EXPOSURE } from './config.ts';

export const CONVERGENCE = {
  /** tile edge (k_tilestats: 8×8 invocations × 2×2 pixels) */
  tile: 16,
  /** no tile is judged converged before this many samples per pixel */
  minSpp: 16,
  /** display-space floor of T(A) + T(B): near-black pixels are judged by absolute, not relative, error */
  epsilon: 0.02,
  /** exposure of the tonemap weighting (the presenter's: raster exposure 1.22 before ACES) */
  toneExposure: RASTER_TONE_EXPOSURE,
  /** noiseNow percentile over tiles */
  percentile: 0.95,
  /** run k_tilestats every N integrator steps (each step = up to MAX_WAVES_PER_SUBMIT waves) */
  statsEverySteps: 1,
  /** legacy default target noise (%) when none is given (js/config.js CONFIG.PATH.noise) */
  defaultNoise: 3,
  /**
   * Owen-scrambled Sobol makes the half-buffer estimate CONSERVATIVE: the
   * even and odd half-sequences each behave almost like random samples, while
   * the full sequence converges faster (QMC). Measured on the station (view 0
   * DAY, tests/browser/pt-output.spec.ts (a)): estimate / true error of two
   * independent renders = 1.40 (8 spp), 1.44 (16), 1.56 (64), 1.61 (256); PCG
   * 0.97–0.98. The tile errors of a Sobol run are multiplied by this factor
   * (≈ 1 / 1.5) before the tile selection and noiseNow.
   */
  sobolCalibration: 0.667
} as const;

/** Factor applied to the measured tile errors of a sampler (see CONVERGENCE.sobolCalibration). */
export function noiseCalibration(sampler: 'sobol' | 'pcg'): number {
  return sampler === 'sobol' ? CONVERGENCE.sobolCalibration : 1;
}

/** Tile statistics with the error column scaled (unknown tiles stay unknown). */
export function calibrateStats(stats: Float32Array, k: number): Float32Array {
  if (k === 1) return stats;
  const out = stats.slice();
  for (let i = 0; i < out.length; i += 4) if (out[i] < TILE_UNKNOWN) out[i] *= k;
  return out;
}

/** k_tilestats B5_TILE_UNKNOWN: no pixel of the tile has two samples yet */
export const TILE_UNKNOWN = 1e9;
export const MEAN_ABS_TO_RMS = Math.sqrt(Math.PI / 2);
/** floats per tile record: error, minW, maxW, valid pixels */
export const TILE_STATS_FLOATS = 4;

export interface TileGrid {
  tilesX: number;
  tilesY: number;
  count: number;
}

export function tileGrid(width: number, height: number, tile: number = CONVERGENCE.tile): TileGrid {
  const tilesX = Math.ceil(width / tile), tilesY = Math.ceil(height / tile);
  return { tilesX, tilesY, count: tilesX * tilesY };
}

/** Pixels of the image inside tile `t` (edge tiles are partial). */
export function tilePixels(t: number, width: number, height: number, tile: number = CONVERGENCE.tile): number {
  const g = tileGrid(width, height, tile);
  const tx = t % g.tilesX, ty = Math.floor(t / g.tilesX);
  return Math.min(tile, width - tx * tile) * Math.min(tile, height - ty * tile);
}

/** samplesNeeded of js/pathtrace.js: noise ∝ 1/√spp, so 1 % ↔ 10 000 samples. */
export function samplesForNoise(noisePct: number): number {
  return Math.ceil(1e4 / (noisePct * noisePct));
}

const f32 = Math.fround;
const tm = (x: number) => f32(x / f32(1 + x));

/** CPU mirror of k_tilestats.wgsl b5_pixel_error (f32 steps): [error, valid]. */
export function pixelError(r: number, g: number, b: number, w: number, half: number, exposure: number, eps: number): [number, number] {
  if (w < 2) return [0, 0];
  const nA = Math.ceil(w * 0.5), nB = w - nA;
  const lum = f32(f32(f32(0.2126 * r) + f32(0.7152 * g)) + f32(0.0722 * b));
  const A = Math.max(f32(half / nA), 0), B = Math.max(f32(f32(lum - half) / nB), 0);
  const a = tm(f32(A * exposure)), bb = tm(f32(B * exposure));
  return [f32(f32(Math.abs(a - bb) / f32(a + bb + eps)) * f32(MEAN_ABS_TO_RMS)), 1];
}

export interface TileStatsOptions {
  exposure?: number;
  epsilon?: number;
  tile?: number;
}

/**
 * CPU mirror of k_tilestats: accum = vec4 (rgb sum, count) per pixel, half =
 * even-sample luminance sum per pixel → TILE_STATS_FLOATS per tile.
 */
export function tileStatsRef(accum: Float32Array, half: Float32Array, width: number, height: number, o: TileStatsOptions = {}): Float32Array {
  const tile = o.tile ?? CONVERGENCE.tile;
  const exposure = o.exposure ?? CONVERGENCE.toneExposure, eps = o.epsilon ?? CONVERGENCE.epsilon;
  const g = tileGrid(width, height, tile);
  const out = new Float32Array(g.count * TILE_STATS_FLOATS);
  for (let ty = 0; ty < g.tilesY; ty++) {
    for (let tx = 0; tx < g.tilesX; tx++) {
      let se = 0, n = 0, minW = Infinity, maxW = 0;
      for (let y = ty * tile; y < Math.min(height, (ty + 1) * tile); y++) {
        for (let x = tx * tile; x < Math.min(width, (tx + 1) * tile); x++) {
          const p = y * width + x;
          const w = accum[p * 4 + 3];
          const [e, v] = pixelError(accum[p * 4], accum[p * 4 + 1], accum[p * 4 + 2], w, half[p], exposure, eps);
          se += e; n += v;
          minW = Math.min(minW, w); maxW = Math.max(maxW, w);
        }
      }
      const t = (ty * g.tilesX + tx) * TILE_STATS_FLOATS;
      out[t] = n > 0 ? se / n : TILE_UNKNOWN;
      out[t + 1] = minW; out[t + 2] = maxW; out[t + 3] = n;
    }
  }
  return out;
}

/** q-quantile (nearest rank) of the values; [] → +∞. */
export function percentile(values: ArrayLike<number>, q: number): number {
  const a = Float64Array.from(values).sort();
  if (!a.length) return Infinity;
  const k = Math.min(a.length - 1, Math.max(0, Math.ceil(q * a.length) - 1));
  return a[k];
}

export interface ActiveTileOptions {
  /** target relative error (fraction, e.g. 0.03) */
  target: number;
  /** per-pixel spp cap */
  capSpp: number;
  minSpp?: number;
  percentile?: number;
}

export interface ConvergenceSummary {
  /** tiles still sampled */
  active: Uint32Array;
  /** percentile tile error (fraction; +∞ while unknown) */
  noise: number;
  /** tiles that met the target (not just the cap) */
  converged: number;
  /** tiles stopped by the spp cap with error > target */
  capped: number;
  /** min / mean samples per pixel over all tiles (mean weighted by valid pixels of the tile record) */
  minSpp: number;
  maxSpp: number;
  /** fraction of tiles inactive */
  doneFraction: number;
  done: boolean;
}

/** Active tile list + convergence summary from TILE_STATS_FLOATS-per-tile statistics. */
export function selectActiveTiles(stats: Float32Array, o: ActiveTileOptions, prevActive?: Uint32Array | null): ConvergenceSummary {
  const n = stats.length / TILE_STATS_FLOATS;
  const minSpp = o.minSpp ?? CONVERGENCE.minSpp;
  const errs: number[] = [];
  const active: number[] = [];
  let converged = 0, capped = 0, lo = Infinity, hi = 0;
  /* tiles that were already retired stay retired (their statistics no longer change) */
  const wasActive = prevActive ? new Uint8Array(n) : null;
  if (prevActive && wasActive) for (const t of prevActive) wasActive[t] = 1;
  for (let t = 0; t < n; t++) {
    const e = stats[t * 4], w = stats[t * 4 + 1];
    lo = Math.min(lo, w); hi = Math.max(hi, stats[t * 4 + 2]);
    errs.push(e >= TILE_UNKNOWN ? Infinity : e);
    const want = w < minSpp || (e > o.target && w < o.capSpp);
    if (want && (!wasActive || wasActive[t])) active.push(t);
    else if (e <= o.target && w >= minSpp) converged++;
    else capped++;
  }
  const noise = percentile(errs, o.percentile ?? CONVERGENCE.percentile);
  return {
    active: Uint32Array.from(active), noise, converged, capped,
    minSpp: lo === Infinity ? 0 : lo, maxSpp: hi,
    doneFraction: n ? 1 - active.length / n : 1, done: active.length === 0
  };
}

/** Pixels covered by the listed tiles (k_raygen slots minus the parts of edge tiles outside the image). */
export function activePixels(active: ArrayLike<number>, width: number, height: number, tile: number = CONVERGENCE.tile): number {
  let s = 0;
  for (let i = 0; i < active.length; i++) s += tilePixels(active[i], width, height, tile);
  return s;
}

/**
 * Progress 0…1 of a run towards `target` (fraction) under `capSpp`: noise ∝
 * 1/√spp, so (target/noise)² estimates the fraction of the needed samples.
 */
export function convergenceProgress(noise: number, target: number, spp: number, capSpp: number, done: boolean): number {
  if (done) return 1;
  const bySpp = capSpp > 0 ? spp / capSpp : 0;
  const byNoise = Number.isFinite(noise) && noise > 0 ? (target / noise) ** 2 : 0;
  return Math.min(0.999, Math.max(bySpp, byNoise));
}
