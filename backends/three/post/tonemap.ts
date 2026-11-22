/* Tone mapping for the WebGPU RenderPipeline: the app's ACES look.

   The classic chain (js/photo.js, TONEMAP_GLSL) tonemaps with the
   Hill/Narkowicz RRT+ODT fit between the ACES input/output matrices, then
   applies the exact sRGB OETF. three's `acesFilmicToneMapping` (r187,
   src/nodes/display/ToneMappingFunctions.js) is the SAME fit with the SAME
   matrices, except that it divides the exposed colour by 0.6 first:

       three(x, e) = b5(x · e / 0.6)   ⇒   b5(x, e) = three(x, e · 0.6)

   So the calibration is exact (not fitted): feeding three's function
   exposure × ACES_THREE_EXPOSURE_SCALE reproduces the classic output to
   float rounding. Both variants are provided — `b5` (our own port, default)
   and `three` (three's node + the calibrated exposure) — and the browser
   test probes both against the CPU reference `toScreenCpu` below.

   Matrices: GLSL `mat3(a..i)` is column-major. To avoid any ambiguity about
   TSL's mat3 argument order the products are written out as sums of columns. */
import { Fn, vec3, float, mix, step, max, clamp, pow } from 'three/tsl';
import { acesFilmicToneMapping, sRGBTransferOETF } from 'three/tsl';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TslNode = any;

/** three's ACES divides by 0.6; multiply our exposure by this to match. */
export const ACES_THREE_EXPOSURE_SCALE = 0.6;

/** Columns of the classic input / output matrices (TONEMAP_GLSL). */
const IN_M: readonly (readonly [number, number, number])[] = [
  [0.59719, 0.07600, 0.02840],
  [0.35458, 0.90834, 0.13383],
  [0.04823, 0.01566, 0.83777]
];
const OUT_M: readonly (readonly [number, number, number])[] = [
  [1.60475, -0.10208, -0.00327],
  [-0.53108, 1.10813, -0.07276],
  [-0.07367, -0.00605, 1.07602]
];
/** RRT+ODT rational fit coefficients (same in three and in the classic chain). */
const FIT = { a: 0.0245786, b: 0.000090537, c: 0.983729, d: 0.4329510, e: 0.238081 };
/** sRGB OETF constants. */
const SRGB = { lin: 0.0031308, slope: 12.92, gamma: 0.41666, scale: 1.055, off: 0.055 };

const mulCols = (m: typeof IN_M, x: TslNode): TslNode =>
  vec3(...m[0]).mul(x.x).add(vec3(...m[1]).mul(x.y)).add(vec3(...m[2]).mul(x.z));

/** Classic `aces()` — linear in, display-linear [0,1] out. */
export const acesB5 = Fn(([x]: [TslNode]) => {
  const v = mulCols(IN_M, vec3(x)).toVar();
  const a = v.mul(v.add(FIT.a)).sub(FIT.b);
  const b = v.mul(v.mul(FIT.c).add(FIT.d)).add(FIT.e);
  return clamp(mulCols(OUT_M, a.div(b)), 0.0, 1.0);
});

/** Exact sRGB OETF as in the classic `toScreen` (step at 0.0031308). */
export const srgbOetfB5 = Fn(([c]: [TslNode]) => {
  const cc = vec3(c);
  const hi = pow(max(cc, vec3(0.0)), vec3(SRGB.gamma)).mul(SRGB.scale).sub(SRGB.off);
  return mix(cc.mul(SRGB.slope), hi, step(vec3(SRGB.lin), cc));
});

export type TonemapId = 'b5' | 'three' | 'none';

/** linear HDR (already multiplied by exposure) → display sRGB, [0,1]. */
export function toScreen(hdr: TslNode, mode: TonemapId): TslNode {
  if (mode === 'none') return srgbOetfB5(clamp(vec3(hdr), 0.0, 1.0));
  if (mode === 'three') {
    return sRGBTransferOETF(acesFilmicToneMapping(vec3(hdr), float(ACES_THREE_EXPOSURE_SCALE)));
  }
  return srgbOetfB5(acesB5(vec3(hdr)));
}

/* ── CPU reference (tests, probes) ─────────────────────────────────────── */

function acesCpu1(x: readonly number[]): number[] {
  const v = [0, 1, 2].map(i => IN_M[0][i] * x[0] + IN_M[1][i] * x[1] + IN_M[2][i] * x[2]);
  const r = v.map(t => (t * (t + FIT.a) - FIT.b) / (t * (FIT.c * t + FIT.d) + FIT.e));
  return [0, 1, 2].map(i => Math.min(1, Math.max(0,
    OUT_M[0][i] * r[0] + OUT_M[1][i] * r[1] + OUT_M[2][i] * r[2])));
}

/** CPU port of the classic GLSL `toScreen(linear, exposure)` (js/photo.js). */
export function toScreenCpu(rgb: readonly number[], exposure: number): [number, number, number] {
  const c = acesCpu1(rgb.map(t => t * exposure));
  const o = c.map(t => t >= SRGB.lin
    ? SRGB.scale * Math.pow(Math.max(t, 0), SRGB.gamma) - SRGB.off
    : t * SRGB.slope);
  return [o[0], o[1], o[2]];
}
