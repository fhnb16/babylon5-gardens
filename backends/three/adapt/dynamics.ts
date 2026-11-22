/* Per-frame dynamics: core stepDynamics writes one matrix array per dynamic
   key ('traffic' | 'lifts'); every InstancedMesh with that key wraps the
   same CPU array in its own instanceMatrix attribute (traffic.body +
   traffic.lamp, lift.body + lift.lamp + lift.glass — legacy wrote the same
   matrix into each), so a step is one core call + needsUpdate flags.

   The dynamics state is a structured clone of SceneDesc.dynamics: stepping
   never mutates the descriptor, which stays reusable. */

import type * as THREE from 'three';
import { stepDynamics, type DynamicsOut, type DynamicsState } from '../../../core/scene/dynamics.ts';
import type { SceneDesc } from '../../../core/scene/types.ts';

export type DynamicKey = 'traffic' | 'lifts';

export interface ThreeDynamics {
  state: DynamicsState;
  /** CPU matrices per key (wrapped by the meshes' instanceMatrix) */
  arrays: DynamicsOut;
  meshes: Record<DynamicKey, THREE.InstancedMesh[]>;
  /** advance by dt; `traffic: false` freezes the cars (legacy trafficOn) */
  step(dt: number, opts?: { traffic?: boolean }): void;
}

export function createDynamics(scene: SceneDesc): ThreeDynamics {
  const state: DynamicsState = structuredClone(scene.dynamics) as DynamicsState;
  const arrays: DynamicsOut = {};
  for (const m of scene.meshes) {
    if (!m.dynamic || !m.instances) continue;
    if (!arrays[m.dynamic]) arrays[m.dynamic] = new Float32Array(m.instances.matrices);
  }
  const meshes: Record<DynamicKey, THREE.InstancedMesh[]> = { traffic: [], lifts: [] };
  const out: DynamicsOut = {};
  return {
    state, arrays, meshes,
    step(dt, opts = {}) {
      out.traffic = opts.traffic === false ? undefined : arrays.traffic;
      out.lifts = arrays.lifts;
      stepDynamics(state, dt, out);
      for (const k of ['traffic', 'lifts'] as const) {
        if (!out[k]) continue;
        for (const im of meshes[k]) im.instanceMatrix.needsUpdate = true;
      }
    }
  };
}
