/* ═══════════════════════════════════════════════════════════════════════════
   Units. Core / sim work in STATION units; ThreeRT works in metres.

   SceneDesc.frame.metresPerUnit says 10 (R = 50 units = 500 m), but the spike (README row c) showed that the
   live light tree drops emitters farther than 120 m from the shading point, so the native backend puts the
   station into ThreeRT at ENGINE_M_PER_UNIT = 1: one core unit becomes one metre (R = 50 m, L = 300 m). The
   floor illuminance from the tube is scale-invariant. Keep this a single constant so 10 m can be retried.
   Nits, EV100 and colours are NOT scaled.
   ═══════════════════════════════════════════════════════════════════════════ */

/** Metres of the ThreeRT scene that one core station unit becomes (README "Units": the adapter's k). */
export const ENGINE_M_PER_UNIT = 1;

/** station length / coordinate -> ThreeRT metres */
export const lengthToEngine = (u: number, k: number = ENGINE_M_PER_UNIT): number => u * k;
/** ThreeRT metres -> station length / coordinate */
export const lengthFromEngine = (m: number, k: number = ENGINE_M_PER_UNIT): number => m / k;

/** station position [x, y, z] -> ThreeRT position (writes into `out`, default: a fresh array) */
export function positionToEngine(p: ArrayLike<number>, out: number[] = [0, 0, 0], k: number = ENGINE_M_PER_UNIT): number[] {
  out[0] = p[0] * k; out[1] = p[1] * k; out[2] = p[2] * k;
  return out;
}
export function positionFromEngine(p: ArrayLike<number>, out: number[] = [0, 0, 0], k: number = ENGINE_M_PER_UNIT): number[] {
  out[0] = p[0] / k; out[1] = p[1] / k; out[2] = p[2] / k;
  return out;
}

/** station speed (units/s) -> ThreeRT m/s */
export const speedToEngine = lengthToEngine;

/** Extinction coefficient: core `fogDensity` is per station unit; ThreeRT's `scene.fog.density` is per metre. */
export const fogDensityToEngine = (perUnit: number, k: number = ENGINE_M_PER_UNIT): number => perUnit / k;
export const fogDensityFromEngine = (perMetre: number, k: number = ENGINE_M_PER_UNIT): number => perMetre * k;

/** Scale the translation column of a column-major 4x4 (instance / mesh matrices), in place; returns `m`. */
export function scaleMatrixTranslation<T extends { [i: number]: number }>(m: T, k: number = ENGINE_M_PER_UNIT): T {
  m[12] *= k; m[13] *= k; m[14] *= k;
  return m;
}

/** Emitter luminance (nits) and exposure (EV100) are physical: unchanged by the scene scale. */
export const nitsToEngine = (nits: number): number => nits;
