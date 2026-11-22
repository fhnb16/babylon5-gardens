/* core/scene/structuresDynamics.ts vs the legacy updateStructures()
   (js/structures.js run under the Canvas stub, like test.mjs). */
import '../../test/dom-stub.mjs';
import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { buildStructures, updateStructures, liftSeat } from '../../test/legacy-oracle/structures.js';
import { initialLifts, liftMatrices, liftsStep } from '../scene/structuresDynamics.ts';
import { buildStructuresFragment } from '../scene/structures.ts';

const fakeRenderer = { capabilities: { getMaxAnisotropy: (): number => 8 } };

function legacy(): { group: THREE.Group; body: THREE.InstancedMesh; glass: THREE.InstancedMesh; lamp: THREE.InstancedMesh } {
  const group = new THREE.Group();
  buildStructures(group, fakeRenderer, 'LOW', null, null);
  const find = (n: string): THREE.InstancedMesh => group.children.find(o => o.name === n) as THREE.InstancedMesh;
  return { group, body: find('lift.body'), glass: find('lift.glass'), lamp: find('lift.lamp') };
}

const maxDev = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
  let d = 0;
  for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i]));
  return d;
};

describe('lift dynamics', () => {
  test('initialLifts equals the legacy state after updateStructures(0)', () => {
    const L = legacy();
    const s = initialLifts();
    expect(s.count).toBe(L.body.count);
    const out = liftMatrices(s, new Float32Array(16 * s.count));
    expect(maxDev(out, L.body.instanceMatrix.array)).toBe(0);
    const p = new THREE.Vector3(), d = new THREE.Vector3();
    for (let k = 0; k < s.count; k++) {
      liftSeat(k, p, d);
      expect(s.z[k]).toBe(p.z);
      expect(s.dir[k]).toBe(d.z);
    }
    /* the fragment ships the same matrices for all three lift meshes */
    const { fragment } = buildStructuresFragment({ seed: 1337, quality: 'LOW', season: 'summer', saturation: 0.62, greenK: 1 });
    for (const role of ['lift.body', 'lift.lamp', 'lift.glass']) {
      const m = fragment.meshes.find(x => x.role === role);
      expect(m?.dynamic).toBe('lifts');
      expect(maxDev(m?.instances?.matrices as Float32Array, L.body.instanceMatrix.array)).toBe(0);
    }
  });

  test('liftsStep follows updateStructures over a run with reversals at both ends', () => {
    const L = legacy();
    const s = initialLifts();
    const out = new Float32Array(16 * s.count);
    /* frame-like steps, odd steps and big jumps that overshoot the limits */
    const dts = [0.016, 0.016, 0.033, 0.1, 0.25, 1, 2.5, 5, 5, 5, 7.3, 9, 0, 3.1, 12, 0.5, 20, 4, 4, 4, 11, 0.016];
    const p = new THREE.Vector3(), d = new THREE.Vector3();
    let reversals = 0;
    let prevDir = Array.from(s.dir);
    for (const dt of dts) {
      updateStructures(dt);
      liftsStep(s, dt, out);
      for (const im of [L.body, L.lamp, L.glass]) {
        expect(maxDev(out, im.instanceMatrix.array)).toBeLessThan(1e-4);
      }
      for (let k = 0; k < s.count; k++) {
        liftSeat(k, p, d);
        /* LiftState.z is Float32 (contract); legacy keeps doubles */
        expect(Math.abs(s.z[k] - p.z)).toBeLessThan(1e-4);
        expect(s.dir[k]).toBe(d.z);
        if (s.dir[k] !== prevDir[k]) reversals++;
      }
      prevDir = Array.from(s.dir);
    }
    expect(reversals).toBeGreaterThanOrEqual(4);
  });

  test('initialLifts returns independent state', () => {
    const a = initialLifts(), b = initialLifts();
    liftsStep(a, 1, new Float32Array(32));
    expect(b.z[0]).toBe(-40);
    expect(a.z[0]).not.toBe(-40);
  });
});
