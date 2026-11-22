/* Scalar helpers ported from js/util.js (same formulas, same constants). */

export const D2R = Math.PI / 180;
export const TAU = Math.PI * 2;

export const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const easeInOut = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

/** Same as THREE.MathUtils.euclideanModulo. */
export const euclideanModulo = (n: number, m: number): number => ((n % m) + m) % m;

export const inRanges = (deg: number, ranges: ReadonlyArray<readonly [number, number]>): boolean =>
  ranges.some(([a, b]) => deg >= a && deg <= b);
