/* Options of the WebGPU post pipeline — the app's settings, one to one.

   Defaults come from the live CONFIG (js/config.js: POST, AA_FILTER,
   AA_MSAA, AA_SCALE), read at call time: CONFIG is a mutable global. */
import { CONFIG as RAW } from '../../../js/config.js';
import type { TonemapId } from './tonemap.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CONFIG: any = RAW;

/** CONFIG.AA_FILTER ids: a filter name is just the set of its parts. */
export type AaFilterId = 'none' | 'fxaa' | 'smaa' | 'smaafxaa'
  | 'taa' | 'taafxaa' | 'taasmaa' | 'taasmaafxaa';
export const AA_FILTER_IDS: readonly AaFilterId[] =
  ['none', 'fxaa', 'smaa', 'smaafxaa', 'taa', 'taafxaa', 'taasmaa', 'taasmaafxaa'];

export interface AaParts { taa: boolean; smaa: boolean; fxaa: boolean }
export const aaParts = (id: string): AaParts =>
  ({ taa: id.includes('taa'), smaa: id.includes('smaa'), fxaa: id.includes('fxaa') });

export type MsaaSamples = 0 | 2 | 4 | 8;

export interface PostOptions {
  /** MSAA samples of the scene pass (CONFIG.AA_MSAA). Forced to 0 with TAA. */
  msaa: MsaaSamples;
  /** -1 disables screen rays, 0 composites, positive values inspect individual buffers. */
  screenTrace: number;
  traceClean: boolean;
  /** CONFIG.AA_FILTER id. */
  aa: AaFilterId;
  /** Supersampling factor ≥ 1 (CONFIG.AA_SCALE): scene pass renders larger. */
  ssaa: number;
  /** Render fraction ≤ 1 (CONFIG.POST.FSR values; 1 = native). < 1 → upscale. */
  fsr: number;
  /** 'b5' = our ports of UPSCALE_FRAG/SHARP_FRAG, 'three' = r187 fsr1() (AMD EASU+RCAS). */
  fsrImpl: 'b5' | 'three';
  /** Sharpen amount after upscale; null → classic formula from fsr fraction. */
  sharpen: number | null;
  bloom: boolean;
  /** 'three' = built-in bloom() (mip chain), 'classic' = BRIGHT+BLUR port. */
  bloomImpl: 'three' | 'classic';
  rays: boolean;
  /** Linear luma threshold (CONFIG.POST.threshold). */
  threshold: number;
  /** Classic blur step in half-res texels (CONFIG.POST.radius). */
  radius: number;
  /** Glow weight in the composite (CONFIG.POST.glow). */
  glow: number;
  /** Path tracer threshold lift (setBrightScale): threshold ×k, glow/rays ÷k. */
  brightScale: number;
  /** Bright / rays / classic glow buffers at 1/div resolution (CONFIG.POST.div). */
  div: number;
  /** Ray weight, steps, density and decay (CONFIG.POST.rays/raySteps/…). */
  rayStrength: number;
  raySteps: number;
  rayDensity: number;
  rayDecay: number;
  /** three bloom() radius in [0,1]; null → derived from `radius`. */
  bloomRadius: number | null;
  tonemap: TonemapId;
  exposure: number;
}

/** Defaults from the current CONFIG. */
export function defaultPostOptions(): PostOptions {
  const P = CONFIG.POST;
  return {
    screenTrace: -1, traceClean: false, msaa: 0, aa: 'none', ssaa: 1, fsr: 1, fsrImpl: 'b5', sharpen: null,
    bloom: false, bloomImpl: 'three', rays: false,
    threshold: P.threshold, radius: P.radius, glow: P.glow,
    brightScale: 1, div: P.div,
    rayStrength: P.rays, raySteps: P.raySteps, rayDensity: P.rayDensity, rayDecay: P.rayDecay,
    bloomRadius: null, tonemap: 'b5', exposure: 1
  };
}

/** Effective render scale of the scene pass relative to the drawing buffer. */
export const renderScaleOf = (o: PostOptions): number =>
  Math.max(0.05, (o.ssaa > 0 ? o.ssaa : 1) * (o.fsr > 0 && o.fsr < 1 ? o.fsr : 1));

/** Classic sharpen formula (app/perf.ts): POST.sharpen · (1 − frac) / 0.65. */
export function sharpenFor(frac: number): number {
  const P = CONFIG.POST;
  /* 0.65 = the strongest FSR step's (1 − 0.35) normaliser in the app formula */
  const NORM = 0.65;
  return frac < 0.999 ? P.sharpen * (1 - frac) / NORM : 0;
}

/** Mapping of the classic blur step onto three's bloom radius ∈ [0,1].

    three's bloom sums 5 mips (σ ≈ 2, 3.3, 4.7, 6, 7.3 texels of halving
    targets) with factors lerp(f, 1.2 − f, radius): radius 0 favours the
    tight mips. The classic glow is a single σ = radius half-res texels
    blur; σ ≈ 2 (three's first mip) maps to 0, every texel beyond it adds
    1/BLOOM_RADIUS_SPAN. CONFIG radius 2.6 → 0.075. */
const BLOOM_SIGMA0 = 2;
const BLOOM_RADIUS_SPAN = 8;
export const bloomRadiusOf = (o: PostOptions): number => o.bloomRadius ?? Math.min(1, Math.max(0,
  (o.radius - BLOOM_SIGMA0) / BLOOM_RADIUS_SPAN));

/** three bloom: 5 mip factors always sum to 3 → divide strength by it to keep the classic energy. */
export const BLOOM_MIP_SUM = 3;

/** Options whose change needs a new node graph (the rest are uniforms). */
export const STRUCTURAL: readonly (keyof PostOptions)[] = [
  'screenTrace', 'msaa', 'aa', 'fsrImpl', 'bloom', 'bloomImpl', 'rays', 'raySteps', 'tonemap', 'div'
];

/** Scale regime: 'down' (SSAA), 'native', 'up' (FSR). Changing regime is structural. */
export const scaleRegime = (o: PostOptions): 'down' | 'native' | 'up' => {
  const s = renderScaleOf(o);
  return s > 1.001 ? 'down' : s < 0.999 ? 'up' : 'native';
};

/** Parse URL-style params (tools/post-lab) onto options. */
export function optionsFromParams(q: URLSearchParams, base: PostOptions = defaultPostOptions()): PostOptions {
  const o = { ...base };
  const num = (k: string): number | undefined => (q.has(k) ? Number(q.get(k)) : undefined);
  const bool = (k: string): boolean | undefined => (q.has(k) ? q.get(k) !== '0' && q.get(k) !== 'false' : undefined);
  const m = num('msaa'); if (m !== undefined) o.msaa = ([0, 2, 4, 8].includes(m) ? m : 0) as MsaaSamples;
  const aa = q.get('aa'); if (aa && (AA_FILTER_IDS as readonly string[]).includes(aa)) o.aa = aa as AaFilterId;
  for (const k of ['ssaa', 'fsr', 'threshold', 'radius', 'glow', 'brightScale', 'div', 'rayStrength',
    'raySteps', 'rayDensity', 'rayDecay', 'exposure'] as const) {
    const v = num(k); if (v !== undefined && Number.isFinite(v)) o[k] = v;
  }
  const sh = num('sharpen'); if (sh !== undefined) o.sharpen = sh;
  const br = num('bloomRadius'); if (br !== undefined) o.bloomRadius = br;
  const b = bool('bloom'); if (b !== undefined) o.bloom = b;
  const r = bool('rays'); if (r !== undefined) o.rays = r;
  const bi = q.get('bloomImpl'); if (bi === 'three' || bi === 'classic') o.bloomImpl = bi;
  const fi = q.get('fsrImpl'); if (fi === 'b5' || fi === 'three') o.fsrImpl = fi;
  const tm = q.get('tonemap'); if (tm === 'b5' || tm === 'three' || tm === 'none') o.tonemap = tm;
  return o;
}
