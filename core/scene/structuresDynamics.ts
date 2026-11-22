/* Monorail cabin motion — pure port of updateStructures() in js/structures.js.

   Each cabin runs along its rail (one cabin per rail angle) and turns back
   at ±(L/2 − LIFT_END_GAP). Instance matrix: surface frame at the rail
   angle, radius LIFT_RADIUS (outside the beam), local +Y towards the axis.
   The same matrices drive lift.body, lift.lamp and lift.glass. */

import { CORE_CONFIG } from '../config/index.ts';
import { railRadius } from '../geometry/structures/axis.ts';
import { surfaceMatrix } from '../geometry/shapes/surface.ts';
import type { Mat4 } from '../math/mat4.ts';
import type { LiftState } from './types.ts';

/** Distance from the hull end where a cabin turns back (legacy `CONFIG.L / 2 - 16`). */
const LIFT_END_GAP = 16;
/** Cabin centre sits this far outside the rail beam centre line (legacy `railR + 2.6`). */
const LIFT_BEAM_OFFSET = 2.6;
/** Start positions / directions by parity of the rail index (legacy `k % 2 ? 60 : -40`). */
const LIFT_START = { evenZ: -40, oddZ: 60 };

export const LIFT_ROLES = ['lift.body', 'lift.lamp', 'lift.glass'];

/** Radius of the cabin centres. */
export const liftRadius = (): number => railRadius() + LIFT_BEAM_OFFSET;
/** |z| at which cabins reverse. */
export const liftLimit = (): number => CORE_CONFIG.L / 2 - LIFT_END_GAP;

/** Fresh state equal to the legacy one right after buildStructures() (updateStructures(0)). */
export function initialLifts(): LiftState {
  const angles = CORE_CONFIG.AXIS.railAngles.slice();
  const n = angles.length;
  const z = new Float64Array(n), dir = new Int8Array(n);
  for (let k = 0; k < n; k++) {
    z[k] = k % 2 ? LIFT_START.oddZ : LIFT_START.evenZ;
    dir[k] = k % 2 ? -1 : 1;
  }
  return { count: n, railAngles: angles, speed: CORE_CONFIG.AXIS.liftSpeed, z, dir, roles: LIFT_ROLES.slice() };
}

const _m: Mat4 = new Float64Array(16);

/** Write the current cabin matrices (16 floats per lift) into `out`. */
export function liftMatrices(state: LiftState, out: Float32Array): Float32Array {
  const r = liftRadius();
  for (let k = 0; k < state.count; k++) {
    surfaceMatrix(state.railAngles[k], r, state.z[k], undefined, _m);
    for (let i = 0; i < 16; i++) out[16 * k + i] = _m[i];
  }
  return out;
}

/**
 * Advance the cabins by dt seconds (mutates `state.z` / `state.dir`) and
 * write their matrices into `outMatrices` (length ≥ 16·count).
 */
export function liftsStep(state: LiftState, dt: number, outMatrices: Float32Array): Float32Array {
  const lim = liftLimit();
  for (let k = 0; k < state.count; k++) {
    let z = state.z[k] + state.dir[k] * state.speed * dt;
    if (z > lim) { z = lim; state.dir[k] = -1; }
    if (z < -lim) { z = -lim; state.dir[k] = 1; }
    state.z[k] = z;
  }
  return liftMatrices(state, outMatrices);
}
