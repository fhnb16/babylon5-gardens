/* ═══════════════════════════════════════════════════════════════════════════
   Per-frame dynamics — pure steppers over SceneDesc.dynamics.

   stepDynamics(state, dt, out) advances every dynamic population and writes
   the new instance matrices into caller-owned arrays keyed by
   MeshDesc.dynamic ('traffic' | 'lifts'): every mesh whose `dynamic` equals
   the key uses those matrices (traffic.body + traffic.lamp share one array,
   lift.body/lamp/glass another). The only mutation is of `state` itself
   (positions/directions) and of `out` — no hidden module state.

   Traffic: port of js/world.js updateTraffic. Lifts: js/structures.js
   updateStructures, implemented by core/scene/structuresDynamics.ts.
   ═══════════════════════════════════════════════════════════════════════════ */

import { CORE_CONFIG } from '../config/index.ts';
import { compose } from '../math/mat4.ts';
import { fromAxisAngle, multiply as qmul } from '../math/quat.ts';
import { surfacePos, surfaceQuat } from '../layout/surface.ts';
import type { LiftState, TrafficState } from './types.ts';
import { liftsStep } from './structuresDynamics.ts';

export interface DynamicsState {
  traffic?: TrafficState;
  lifts?: LiftState;
}

/** Caller-owned output matrices (16 floats per instance), keyed by MeshDesc.dynamic. */
export interface DynamicsOut {
  traffic?: Float32Array;
  lifts?: Float32Array;
}

const _q = [0, 0, 0, 1], _qs = [0, 0, 0, 1], _p = [0, 0, 0];
const _one = [1, 1, 1], _up = [0, 1, 0];
const _m = new Float64Array(16);

/** Write the traffic matrices for the current state (no movement). */
export function trafficMatrices(state: TrafficState, out: Float32Array): Float32Array {
  const R = CORE_CONFIG.R;
  const n = state.z.length;
  for (let k = 0; k < n; k++) {
    const lane = state.lanes[state.lane[k]];
    const t = lane.theta;
    surfaceQuat(t, _q);
    if (lane.dir < 0) qmul(_q, fromAxisAngle(_up, Math.PI, _qs), _q);
    surfacePos(t, R - CORE_CONFIG.TRAFFIC.h * 0.5, state.z[k], _p);
    compose(_p, _q, _one, _m);
    out.set(_m, k * 16);
  }
  return out;
}

/**
 * Move cars along their lanes (wrapping over the station length) and write
 * the matrices. Legacy kept `off = z + L/2` in a Float32Array; z is an f64
 * holding fround(off) − L/2, so z + L/2 recovers the legacy f32 offset exactly
 * and every step rounds like the legacy store — bit-exact with updateTraffic.
 */
export function stepTraffic(state: TrafficState, dt: number, out: Float32Array): Float32Array {
  const L = CORE_CONFIG.L, HL = L / 2;
  const n = state.z.length;
  for (let k = 0; k < n; k++) {
    const lane = state.lanes[state.lane[k]];
    let off = (state.z[k] + HL + lane.dir * lane.speed * dt + L) % L;   // legacy formula
    if (off < 0) off = ((off % L) + L) % L;                              // dt > L/speed
    state.z[k] = Math.fround(off) - HL;                                  // legacy Float32 store
  }
  return trafficMatrices(state, out);
}

/** Advance all dynamic populations by dt seconds; fills the `out` arrays that are present. */
export function stepDynamics(state: DynamicsState, dt: number, out: DynamicsOut): DynamicsOut {
  if (state.traffic && out.traffic) stepTraffic(state.traffic, dt, out.traffic);
  if (state.lifts && out.lifts) liftsStep(state.lifts, dt, out.lifts);
  return out;
}
