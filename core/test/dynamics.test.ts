/* stepDynamics: traffic follows the legacy updateTraffic maths (Float32 `off`
   storage replayed by hand), lifts plug in through the same entry point. */
import { describe, expect, test } from 'vitest';
import { buildScene, defaultParams } from '../scene/build.ts';
import { stepDynamics, stepTraffic, trafficMatrices } from '../scene/dynamics.ts';
import { CORE_CONFIG } from '../config/index.ts';
import { liftsStep } from '../scene/structuresDynamics.ts';
import * as U from '../../test/legacy-oracle/util.js';
import * as THREE from 'three';

const scene = buildScene(defaultParams('LOW'));

describe('traffic', () => {
  test('initial matrices equal trafficMatrices(state) and are shared by body and lamps', () => {
    const tr = scene.dynamics.traffic;
    if (!tr) throw new Error('no traffic');
    const body = scene.meshes.find(m => m.role === 'traffic.body');
    const lamp = scene.meshes.find(m => m.role === 'traffic.lamp');
    expect(body?.dynamic).toBe('traffic');
    expect(body?.instances?.matrices).toBe(lamp?.instances?.matrices);
    expect(trafficMatrices(tr, new Float32Array(tr.z.length * 16))).toEqual(body?.instances?.matrices);
  });

  /* z is f64 = fround(off) − L/2, so stepping reproduces the legacy Float32
     offset exactly — see stepTraffic */
  test('600 steps of 1/60 s match the legacy updateTraffic bit-exactly', () => {
    const tr = structuredClone(scene.dynamics.traffic);
    if (!tr) throw new Error('no traffic');
    const n = tr.z.length, R = CORE_CONFIG.R, L = CORE_CONFIG.L, HL = L / 2;
    const per = CORE_CONFIG.TRAFFIC.perLane, sp = CORE_CONFIG.TRAFFIC.speed, half = CORE_CONFIG.CITY.street * 0.22;
    /* legacy state: off (Float32), dir, roads */
    const off = new Float32Array(n), dir = new Float32Array(n);
    const roads: number[] = [];
    for (let k = 0; k < n; k++) {
      off[k] = tr.z[k] + HL; dir[k] = k % 2 ? 1 : -1;
      const lane = tr.lanes[tr.lane[k]];
      expect(lane.dir).toBe(dir[k]);
      roads[(k / per) | 0] = lane.theta - dir[k] * half / R;
    }
    const out = new Float32Array(n * 16);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), qs = new THREE.Quaternion(), v = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1);
    const legacy = new Float32Array(16);
    for (let s = 0; s < 600; s++) {
      stepDynamics({ traffic: tr }, 1 / 60, { traffic: out });
      for (let k = 0; k < n; k++) off[k] = (off[k] + dir[k] * sp * (1 / 60) + L) % L;
    }
    let dev = 0;
    for (let k = 0; k < n; k++) {
      const t = roads[(k / per) | 0] + dir[k] * half / R;
      q.copy(U.surfaceQuat(t));
      if (dir[k] < 0) q.multiply(qs.setFromAxisAngle(up, Math.PI));
      m.compose(U.surfacePos(t, R - CORE_CONFIG.TRAFFIC.h * 0.5, off[k] - HL, v), q, one);
      m.toArray(legacy);
      for (let j = 0; j < 16; j++) dev = Math.max(dev, Math.abs(legacy[j] - out[k * 16 + j]));
    }
    expect(dev).toBe(0);
    for (let k = 0; k < n; k++) expect(tr.z[k] + HL).toBe(off[k]);
  });

  test('wraps over the station length', () => {
    const tr = structuredClone(scene.dynamics.traffic);
    if (!tr) throw new Error('no traffic');
    const out = new Float32Array(tr.z.length * 16);
    stepTraffic(tr, 1000, out);
    for (const z of tr.z) expect(Math.abs(z)).toBeLessThanOrEqual(CORE_CONFIG.L / 2);
  });
});

describe('lifts plug into stepDynamics', () => {
  test('same result as liftsStep', () => {
    const a = structuredClone(scene.dynamics.lifts), b = structuredClone(scene.dynamics.lifts);
    const oa = new Float32Array(a.count * 16), ob = new Float32Array(b.count * 16);
    for (let s = 0; s < 50; s++) {
      stepDynamics({ lifts: a }, 0.1, { lifts: oa });
      liftsStep(b, 0.1, ob);
    }
    expect(oa).toEqual(ob);
    expect(Array.from(a.z)).toEqual(Array.from(b.z));
  });
});
