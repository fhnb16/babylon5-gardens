/* core/camera: parity of aimAt / turnToward / clampPitch / stationUp with the
   legacy THREE-based helpers, and flight path sanity. */
import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import * as U from '../../test/legacy-oracle/util.js';
import { mulberry32 } from '../rng.ts';
import { CORE_CONFIG } from '../config/index.ts';
import {
  aimAt, clampPitch, flyPoint, forwardOf, planFlight, stationUp, stepFlight, sunAxisPoint, turnToward, viewPose
} from '../camera/flight.ts';
import { tpVec } from '../layout/surface.ts';

const rnd = mulberry32(7);
const rv = (): THREE.Vector3 => new THREE.Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1);
const arr = (v: THREE.Vector3): number[] => [v.x, v.y, v.z];
const close = (a: ArrayLike<number>, b: ArrayLike<number>, eps = 1e-12): void => {
  for (let i = 0; i < a.length; i++) expect(Math.abs(a[i] - b[i])).toBeLessThan(eps);
};

describe('camera helpers vs js/util.js', () => {
  test('aimAt (incl. up nearly along the view)', () => {
    for (let k = 0; k < 300; k++) {
      const eye = rv().multiplyScalar(40), tgt = rv().multiplyScalar(40);
      const up = k % 5 === 0 ? tgt.clone().sub(eye).normalize().add(rv().multiplyScalar(0.01)).normalize() : rv().normalize();
      const q = U.aimAt(eye, tgt, up, new THREE.Quaternion());
      const c = aimAt(arr(eye), arr(tgt), arr(up));
      close(c, [q.x, q.y, q.z, q.w], 1e-12);
    }
  });

  test('turnToward (incl. exactly opposite)', () => {
    for (let k = 0; k < 300; k++) {
      const from = rv().normalize();
      const to = k % 7 === 0 ? from.clone().negate() : rv().normalize();
      const up = rv().normalize(), w = rnd() * 1.4 - 0.2;
      const r = U.turnToward(from.clone(), to, w, up, new THREE.Vector3());
      close(turnToward(arr(from), arr(to), w, arr(up)), arr(r), 1e-12);
    }
  });

  test('clampPitch', () => {
    for (let k = 0; k < 300; k++) {
      const dir = rv().normalize(), up = rv().normalize(), s = rnd();
      const r = U.clampPitch(dir.clone(), up, s);
      const c = clampPitch(arr(dir), arr(up), s);
      close(c, arr(r), 1e-12);
      expect(Math.abs(c[0] * up.x + c[1] * up.y + c[2] * up.z)).toBeLessThanOrEqual(s + 1e-12);
    }
  });

  test('stationUp', () => {
    expect(stationUp([30, 40, 5])).toEqual([-0.6, -0.8, 0]);
    expect(stationUp([0, 0.001, 5])).toEqual([0, 1, 0]);
  });
});

describe('flight', () => {
  test('path starts at p0, ends at the target, stays inside the hull and off the tube', () => {
    const p0 = tpVec(CORE_CONFIG.TP[0].pos), p2 = tpVec(CORE_CONFIG.TP[5].pos), look = tpVec(CORE_CONFIG.TP[5].look);
    const st = planFlight(p0, p2, look, [0, 0, -1], [0, 1, 0]);
    close(flyPoint(st, 0), p0, 1e-9);
    close(flyPoint(st, 1), p2, 1e-9);
    expect(st.dur).toBeGreaterThanOrEqual(CORE_CONFIG.FLY.min);
    expect(st.dur).toBeLessThanOrEqual(CORE_CONFIG.FLY.max);
    const pose = { pos: [0, 0, 0], quat: [0, 0, 0, 1] };
    let steps = 0, prevF: ArrayLike<number> | null = null, maxTurn = 0;
    while (st.on && steps < 10000) {
      stepFlight(st, 1 / 60, 0, pose);
      const r = Math.hypot(pose.pos[0], pose.pos[1]);
      expect(r).toBeLessThan(CORE_CONFIG.R);
      expect(r).toBeGreaterThan(CORE_CONFIG.SUN.r);
      const f = forwardOf(pose.quat);
      if (prevF) maxTurn = Math.max(maxTurn, Math.acos(Math.min(1, f[0] * prevF[0] + f[1] * prevF[1] + f[2] * prevF[2])));
      prevF = f;
      steps++;
    }
    expect(st.on).toBe(false);
    close(pose.pos, p2, 1e-9);
    expect(maxTurn).toBeLessThan(0.2);          // no 90°/180° flips between frames
  });

  test('viewPose looks at the view target', () => {
    const v = CORE_CONFIG.TP[1];
    const pose = viewPose(v.pos, v.look);
    const f = forwardOf(pose.quat);
    const l = tpVec(v.look), p = tpVec(v.pos);
    const d = [l[0] - p[0], l[1] - p[1], l[2] - p[2]];
    const n = Math.hypot(d[0], d[1], d[2]);
    close(f, d.map(x => x / n), 1e-9);
  });

  test('sun axis point = closest axis point to the view ray', () => {
    const q = sunAxisPoint([10, 0, 0], [-1 / Math.SQRT2, 0, 1 / Math.SQRT2]);
    close(q, [0, 0, 10], 1e-12);
    expect(sunAxisPoint([0, 30, 140], [0, 0, 1])[2]).toBe(CORE_CONFIG.L / 2);
  });
});
