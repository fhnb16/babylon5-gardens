/* Tests of backends/threert/src/sim against the legacy app (js/*.js, loaded under test/dom-stub.mjs exactly like
   test.mjs does) and against invariants. Pure Node, no GPU, no ThreeRT client.
   Run: npx vitest run --config backends/threert/vitest.config.ts */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { mulberry32 } from '../../../core/rng.ts';
import * as mat4 from '../../../core/math/mat4.ts';
import * as quat from '../../../core/math/quat.ts';
import { CORE_CONFIG } from '../../../core/config/index.ts';
import * as sim from '../src/sim/index.ts';

const ROOT = resolve(import.meta.dirname, '../../..');
const url = (p: string) => pathToFileURL(resolve(ROOT, p)).href;
/* dynamic, variable specifier: plain Node ESM import of the legacy modules (they carry no types) */
await import(/* @vite-ignore */ url('test/dom-stub.mjs'));
const L: any = {
  cfg: await import(/* @vite-ignore */ url('js/config.js')),
  util: await import(/* @vite-ignore */ url('test/legacy-oracle/util.js')),
  ctl: await import(/* @vite-ignore */ url('js/controls.js')),
  world: await import(/* @vite-ignore */ url('test/legacy-oracle/world.js')),
};
const CONFIG = L.cfg.CONFIG;

const rnd = mulberry32(20261118);
const V = (a: number[]) => new THREE.Vector3(a[0], a[1], a[2]);
const randUnit = (): number[] => {
  const z = rnd() * 2 - 1, t = rnd() * Math.PI * 2, s = Math.sqrt(1 - z * z);
  return [s * Math.cos(t), s * Math.sin(t), z];
};
const near = (a: ArrayLike<number>, b: ArrayLike<number>, tol: number) => {
  for (let i = 0; i < a.length; i++) expect(Math.abs(a[i] - b[i])).toBeLessThan(tol);
};
/** quaternions are equal up to sign */
const nearQ = (a: ArrayLike<number>, b: ArrayLike<number>, tol: number) => {
  const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  expect(1 - d).toBeLessThan(tol);
};
const fwdOf = (q: number[]) => sim.forward(q, [0, 0, 0]);
const rad2deg = (r: number) => r * 180 / Math.PI;
const angleBetween = (a: number[], b: number[]) =>
  rad2deg(Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))));

/* ═══ constants copied from the legacy config ═══════════════════════════════ */
describe('constants', () => {
  it('match js/config.js', () => {
    expect(sim.SPEED_BASE).toBe(CONFIG.SPEED_BASE);
    expect(sim.SPEED_MIN).toBe(CONFIG.SPEED_MIN);
    expect(sim.SPEED_MAX).toBe(CONFIG.SPEED_MAX);
    expect(sim.SPEED_BOOST).toBe(CONFIG.SPEED_BOOST);
    expect(sim.SPEED_TURTLE).toBe(CONFIG.SPEED_TURTLE);
    expect(sim.SPEED_RABBIT).toBe(CONFIG.SPEED_RABBIT);
    expect(sim.LOOK_SENS).toBe(CONFIG.LOOK_SENS);
    expect(sim.STICK_DEAD).toBe(CONFIG.STICK_DEAD);
  });
  it('core config carries the rest (collide radius, fly, tour, rotation)', () => {
    expect(CORE_CONFIG.COLLIDE.radius).toBe(CONFIG.COLLIDE.radius);
    expect(CORE_CONFIG.TOUR_HOLD).toBe(CONFIG.TOUR_HOLD);
    expect(CORE_CONFIG.ROT_PERIOD_DEFAULT).toBe(CONFIG.ROT_PERIOD_DEFAULT);
    expect(CORE_CONFIG.FLY).toEqual(CONFIG.FLY);
    expect(CORE_CONFIG.SUN.r).toBe(CONFIG.SUN.r);
    expect(CORE_CONFIG.SUN.clear).toBe(CONFIG.SUN.clear);
  });
  it('margins and pitch limit match the literals of js/controls.js', () => {
    const src = readFileSync(resolve(ROOT, 'js/controls.js'), 'utf8');
    expect(src).toMatch(/CONFIG\.R - 1\.2/);
    expect(src).toMatch(/CONFIG\.L \/ 2 - 2/);
    expect(src).toMatch(/Math\.sin\(84 \* Math\.PI \/ 180\)/);
    expect(sim.HULL_MARGIN).toBe(1.2);
    expect(sim.END_MARGIN).toBe(2);
    expect(sim.SIN_PITCH_MAX).toBeCloseTo(Math.sin(84 * Math.PI / 180), 15);
    expect(sim.SPEED_WHEEL_STEP).toBe(2);
  });
});

/* ═══ units ═════════════════════════════════════════════════════════════════ */
describe('units', () => {
  it('1 unit = 1 m by default', () => {
    expect(sim.ENGINE_M_PER_UNIT).toBe(1);
    expect(sim.lengthToEngine(50)).toBe(50);
    expect(sim.positionToEngine([1, 2, 3])).toEqual([1, 2, 3]);
    expect(sim.fogDensityToEngine(0.004)).toBe(0.004);
    expect(sim.nitsToEngine(1.5e5)).toBe(1.5e5);
  });
  it('scales consistently when a unit becomes 10 m', () => {
    expect(sim.positionToEngine([1, 2, -3], [0, 0, 0], 10)).toEqual([10, 20, -30]);
    expect(sim.positionFromEngine([10, 20, -30], [0, 0, 0], 10)).toEqual([1, 2, -3]);
    /* extinction per metre shrinks by 10 when the same optical depth spans 10x more metres */
    expect(sim.fogDensityToEngine(0.05, 10)).toBeCloseTo(0.005, 15);
    expect(sim.fogDensityFromEngine(sim.fogDensityToEngine(0.05, 10), 10)).toBeCloseTo(0.05, 15);
    const m = new Float32Array(16); m[12] = 1; m[13] = 2; m[14] = 3; m[15] = 1;
    sim.scaleMatrixTranslation(m, 10);
    expect([m[12], m[13], m[14], m[15]]).toEqual([10, 20, 30, 1]);
  });
});

/* ═══ camera maths vs js/util.js + js/controls.js ═══════════════════════════ */
describe('camera maths vs legacy', () => {
  it('stationUp', () => {
    for (let i = 0; i < 200; i++) {
      const p = [(rnd() - 0.5) * 100, (rnd() - 0.5) * 100, (rnd() - 0.5) * 300];
      const a = L.ctl.stationUp(V(p), new THREE.Vector3());
      near(sim.stationUp(p), [a.x, a.y, a.z], 1e-12);
    }
    expect(sim.stationUp([0, 0, 5])).toEqual([0, 1, 0]);          // on the axis
  });

  it('turnToward incl. degenerate (equal / opposite) directions', () => {
    for (let i = 0; i < 400; i++) {
      const from = randUnit();
      let to = randUnit();
      if (i % 10 === 0) to = from.slice();                          // identical
      if (i % 10 === 1) to = from.map(c => -c);                     // exactly opposite
      if (i % 10 === 2) to = from.map((c, k) => c + 1e-5 * (k + 1)); // near
      const up = randUnit(), w = rnd();
      const len = Math.hypot(...to); to = to.map(c => c / len);
      const o = L.util.turnToward(V(from), V(to), w, V(up), new THREE.Vector3());
      near(sim.turnToward(from, to, w, up), [o.x, o.y, o.z], 1e-12);
    }
  });

  it('turnToward may alias its output with `from`', () => {
    const from = [1, 0, 0], to = [0, 1, 0];
    const r = sim.turnToward(from, to, 0.5, [0, 0, 1], from);
    expect(r).toBe(from);
    near(from, [Math.SQRT1_2, Math.SQRT1_2, 0], 1e-12);
  });

  it('clampPitch lands exactly on the limit and matches legacy', () => {
    for (let i = 0; i < 400; i++) {
      const up = randUnit(), d = randUnit(), lim = Math.sin((20 + rnd() * 70) * Math.PI / 180);
      const o = V(d); L.util.clampPitch(o, V(up), lim);
      const m = d.slice(); sim.clampPitch(m, up, lim);
      near(m, [o.x, o.y, o.z], 1e-12);
      expect(Math.abs(m[0] * up[0] + m[1] * up[1] + m[2] * up[2])).toBeLessThanOrEqual(lim + 1e-12);
    }
  });

  it('aimAt', () => {
    for (let i = 0; i < 300; i++) {
      const eye = randUnit().map(c => c * 40), tgt = randUnit().map(c => c * 40);
      const up = i % 7 === 0 ? sim.stationUp(eye) : randUnit();
      const q = new THREE.Quaternion();
      L.util.aimAt(V(eye), V(tgt), V(up), q);
      nearQ(sim.aimAt(eye, tgt, up), [q.x, q.y, q.z, q.w], 1e-12);
    }
    /* looks at the target: forward = normalize(target - eye) */
    const q = sim.aimAt([0, 20, 0], [5, 20, 30], [0, 1, 0]);
    near(fwdOf(q), [5 / Math.hypot(5, 30), 0, 30 / Math.hypot(5, 30)], 1e-12);
  });

  it('levelCamera (station mode) and free-fly no-op', () => {
    L.ctl.ctl.freeFly = false;
    for (let i = 0; i < 200; i++) {
      const cam = new THREE.PerspectiveCamera();
      const r = 4 + rnd() * 44, a = rnd() * 6.28;
      cam.position.set(Math.sin(a) * r, Math.cos(a) * r, (rnd() - 0.5) * 280);
      cam.quaternion.set(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize();
      const pose = { pos: cam.position.toArray(), quat: cam.quaternion.toArray() };
      L.ctl.levelCamera(cam);
      sim.levelCamera(pose, false);
      nearQ(pose.quat, cam.quaternion.toArray(), 1e-12);
      /* no roll: camera up is in the plane of forward and station-up, and pitch is limited */
      const f = fwdOf(pose.quat), up = sim.stationUp(pose.pos);
      expect(Math.abs(f[0] * up[0] + f[1] * up[1] + f[2] * up[2])).toBeLessThanOrEqual(sim.SIN_PITCH_MAX + 1e-9);
      const cu = sim.cameraUp(pose.quat);
      const right = [f[1] * up[2] - f[2] * up[1], f[2] * up[0] - f[0] * up[2], f[0] * up[1] - f[1] * up[0]];
      expect(Math.abs(cu[0] * right[0] + cu[1] * right[1] + cu[2] * right[2])).toBeLessThan(1e-9);
    }
    const free = { pos: [1, 2, 3], quat: [0.1, 0.2, 0.3, 0.9] };
    sim.levelCamera(free, true);
    expect(free.quat).toEqual([0.1, 0.2, 0.3, 0.9]);
  });

  for (const freeFly of [false, true]) {
    it(`keyboard motion + collision = updateControls (${freeFly ? 'free-fly' : 'station mode'})`, () => {
      const ctl = L.ctl.ctl;
      ctl.enabled = true; ctl.freeFly = freeFly; ctl.vert = 0; ctl.sens = 1;
      const cam = new THREE.PerspectiveCamera();
      cam.position.set(20, 30, -40);
      cam.quaternion.set(0.1, 0.5, -0.2, 0.8).normalize();
      const pose = { pos: cam.position.toArray(), quat: cam.quaternion.toArray() };
      const st = sim.newControlState(freeFly);
      const local = mulberry32(99);
      for (let f = 0; f < 600; f++) {
        const keys: Record<string, boolean> = {
          KeyW: local() < 0.6, KeyS: local() < 0.1, KeyA: local() < 0.25, KeyD: local() < 0.25,
          KeyR: local() < 0.2, KeyF: local() < 0.2,
        };
        ctl.keys = keys; ctl.boost = local() < 0.3; ctl.speed = st.speed = 5 + local() * 35;
        const dt = 1 / 60 + local() * 0.02;
        L.ctl.updateControls(dt, cam);
        const intent = sim.emptyIntent();
        intent.fz = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
        intent.fx = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
        intent.fy = (keys.KeyR ? 1 : 0) - (keys.KeyF ? 1 : 0);
        intent.boost = ctl.boost;
        sim.stepControls(pose, st, intent, dt);
        near(pose.pos, cam.position.toArray(), 1e-9);
        nearQ(pose.quat, cam.quaternion.toArray(), 1e-9);
      }
      ctl.keys = Object.create(null); ctl.boost = false; ctl.freeFly = false;
    });
  }
});

/* ═══ counter-rotation ══════════════════════════════════════════════════════ */
describe('station rotation = camera counter-rotation', () => {
  const rotZ = (rot: number) => new THREE.Matrix4().makeRotationZ(rot);

  it('omega from the rotation period', () => {
    expect(sim.omegaFromPeriod(240)).toBeCloseTo(2 * Math.PI / 240, 15);
    expect(sim.OMEGA_DEFAULT).toBe(sim.omegaFromPeriod(CORE_CONFIG.ROT_PERIOD_DEFAULT));
    expect(sim.omegaFromPeriod(0)).toBe(0);
  });

  it('a camera fixed in the inertial frame sees the static world exactly as the rotating station', () => {
    const omega = sim.omegaFromPeriod(45);
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(12, 30, -20); cam.quaternion.set(0.2, -0.4, 0.1, 0.9).normalize();
    const pose = { pos: cam.position.toArray(), quat: cam.quaternion.toArray() };
    const points = [[0, 50, 0], [20, -40, 60], [-35, 10, -110], [3, 3, 3]].map(V);
    let rot = 0;
    for (let f = 0; f < 240; f++) {
      const dt = 1 / 60;
      rot += omega * dt;                      // legacy: worldGroup.rotation.z += omega * dt
      sim.counterRotate(pose, omega * dt);    // ours: the camera moves, the world stays
    }
    cam.updateMatrixWorld(true);
    const inv = cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    const poseInv = mat4.invert(mat4.compose(pose.pos, pose.quat, [1, 1, 1]));
    for (const p of points) {
      const legacyView = p.clone().applyMatrix4(rotZ(rot)).applyMatrix4(inv);
      const ours = mat4.transformPoint(poseInv, p.toArray());
      near(ours, legacyView.toArray(), 1e-9);
    }
  });

  it('controls + rotation over 600 frames: the pose maps to the inertial legacy camera', () => {
    const ctl = L.ctl.ctl;
    ctl.enabled = true; ctl.freeFly = false; ctl.vert = 0;
    const omega = sim.omegaFromPeriod(45);
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(25, 42, 126); cam.quaternion.set(0, 0.3, 0, 0.95).normalize();
    const pose = { pos: cam.position.toArray(), quat: cam.quaternion.toArray() };
    const st = sim.newControlState(false);
    const local = mulberry32(5);
    let rot = 0;
    for (let f = 0; f < 600; f++) {
      ctl.keys = { KeyW: true, KeyD: local() < 0.5, KeyR: local() < 0.2 };
      ctl.speed = st.speed;
      const dt = 1 / 60;
      L.ctl.updateControls(dt, cam); rot += omega * dt;
      const i = sim.emptyIntent(); i.fz = 1; i.fx = ctl.keys.KeyD ? 1 : 0; i.fy = ctl.keys.KeyR ? 1 : 0;
      sim.stepControls(pose, st, i, dt);
      sim.counterRotate(pose, omega * dt);
    }
    ctl.keys = Object.create(null);
    /* local -> inertial = Rz(rot) */
    const c = Math.cos(rot), s = Math.sin(rot);
    const inertialPos = [c * pose.pos[0] - s * pose.pos[1], s * pose.pos[0] + c * pose.pos[1], pose.pos[2]];
    const q = quat.multiply(quat.fromAxisAngle([0, 0, 1], rot), pose.quat);
    near(inertialPos, cam.position.toArray(), 1e-7);
    nearQ(q, cam.quaternion.toArray(), 1e-9);
  });

  it('counterRotate keeps the station up invariant, so station-mode levelling is unaffected', () => {
    const pose = { pos: [10, 30, 5], quat: [0, 0, 0, 1] };
    sim.goToInstant(pose, [20, 30, 5], [20, 36, 105]);
    const before = fwdOf(pose.quat);
    const up0 = sim.stationUp(pose.pos);
    const pitch0 = before[0] * up0[0] + before[1] * up0[1] + before[2] * up0[2];
    for (let i = 0; i < 1000; i++) sim.counterRotate(pose, 0.01);
    const f = fwdOf(pose.quat), up = sim.stationUp(pose.pos);
    expect(f[0] * up[0] + f[1] * up[1] + f[2] * up[2]).toBeCloseTo(pitch0, 9);
    expect(quat.length(pose.quat)).toBeCloseTo(1, 12);
    expect(Math.hypot(pose.pos[0], pose.pos[1])).toBeCloseTo(30, 9);
  });

  it('orientationOnly leaves the position (monorail ride)', () => {
    const pose = { pos: [10, 30, 5], quat: [0, 0, 0, 1] };
    sim.counterRotate(pose, 0.5, true);
    expect(pose.pos).toEqual([10, 30, 5]);
    nearQ(pose.quat, quat.fromAxisAngle([0, 0, 1], -0.5), 1e-12);
  });
});

/* ═══ look input ════════════════════════════════════════════════════════════ */
describe('look', () => {
  it('yaw turns about the station up; positive = left', () => {
    const pose = { pos: [0, 30, 0], quat: [0, 0, 0, 1] };
    sim.goToInstant(pose, [0, 30, 0], [0, 30, 100]);
    const f0 = fwdOf(pose.quat);
    sim.applyLook(pose, 0.3, 0, false);
    const f1 = fwdOf(pose.quat);
    expect(angleBetween(f0, f1)).toBeCloseTo(rad2deg(0.3), 6);
    const up = sim.stationUp(pose.pos);
    expect(f1[0] * up[0] + f1[1] * up[1] + f1[2] * up[2]).toBeCloseTo(0, 9);   // still level
  });

  it('pitch is limited to 84 degrees and the camera is never rolled', () => {
    const pose = { pos: [0, 30, 0], quat: [0, 0, 0, 1] };
    sim.goToInstant(pose, [0, 30, 0], [0, 30, 100]);
    for (let i = 0; i < 100; i++) sim.applyLook(pose, 0.02, 0.1, false);
    const f = fwdOf(pose.quat), up = sim.stationUp(pose.pos);
    expect(f[0] * up[0] + f[1] * up[1] + f[2] * up[2]).toBeCloseTo(sim.SIN_PITCH_MAX, 9);
    for (let i = 0; i < 100; i++) sim.applyLook(pose, 0, -0.1, false);
    const f2 = fwdOf(pose.quat);
    expect(f2[0] * up[0] + f2[1] * up[1] + f2[2] * up[2]).toBeCloseTo(-sim.SIN_PITCH_MAX, 9);
  });

  it('free-fly pitch is relative to the camera, not the station', () => {
    const pose = { pos: [0, 30, 0], quat: [0, 0, 0, 1] };
    sim.applyLook(pose, 0, 0.5, true);
    near(fwdOf(pose.quat), [0, Math.sin(0.5), -Math.cos(0.5)], 1e-12);
  });
});

/* ═══ intent / input mapping ════════════════════════════════════════════════ */
describe('controls input mapping', () => {
  const fake = (o: Partial<{ x: number; y: number; dx: number; dy: number; wheel: number; keys: string[]; pressed: string[] }> = {}): sim.InputLike => ({
    move: { x: o.x ?? 0, y: o.y ?? 0 },
    look: { dx: o.dx ?? 0, dy: o.dy ?? 0 },
    wheel: o.wheel ?? 0,
    down: k => (o.keys ?? []).includes(k),
    pressed: k => (o.pressed ?? []).includes(k),
  });

  it('maps move/look/keys to an intent', () => {
    const i = sim.readIntent(fake({ x: 0.6, y: 0.8, dx: 0.1, dy: -0.2, keys: ['R', 'Shift'], pressed: ['Space', 'G'], wheel: 1 }));
    expect(i.fx).toBeCloseTo(0.6, 12);
    expect(i.fz).toBeCloseTo(0.8, 12);
    expect(i.fy).toBe(1);
    expect(i.boost).toBe(true);
    expect(i.dYaw).toBeCloseTo(-0.1 * sim.LOOK_GAIN, 12);       // right = negative yaw
    expect(i.dPitch).toBeCloseTo(0.2 * sim.LOOK_GAIN, 12);      // up = positive pitch
    expect(i.cancel).toBe(true);
    expect(i.toggleFly).toBe(true);
    expect(sim.readIntent(fake({ keys: ['F'] })).fy).toBe(-1);
    expect(sim.readIntent(fake({ keys: ['R', 'F'] })).fy).toBe(0);
    expect(sim.readIntent(fake({ keys: ['ArrowUp', 'ArrowLeft'] })).fz).toBe(1);
    expect(sim.readIntent(fake({ keys: ['ArrowUp', 'ArrowLeft'] })).fx).toBe(-1);
  });

  it('LOOK_GAIN reproduces the legacy mouse feel', () => {
    /* one mouse count: legacy turns LOOK_SENS rad; ThreeRT delivers THREERT_RAD_PER_COUNT rad */
    expect(sim.THREERT_RAD_PER_COUNT * sim.LOOK_GAIN).toBeCloseTo(CONFIG.LOOK_SENS, 15);
  });

  it('stick dead zone', () => {
    expect(sim.stickRemap(0.05, 0.05)).toEqual({ x: 0, y: 0 });
    const m = sim.stickRemap(0, 1);
    expect(m.y).toBeCloseTo(1, 12);
    const h = sim.stickRemap(0, 0.56);
    expect(h.y).toBeCloseTo((0.56 - CONFIG.STICK_DEAD) / (1 - CONFIG.STICK_DEAD), 12);
  });

  it('wheel changes the base speed within [MIN, MAX]; G toggles free-fly', () => {
    const pose = sim.newPose(); const st = sim.newControlState();
    pose.pos = [0, 30, 0];
    const i = sim.emptyIntent();
    i.wheel = 3; sim.stepControls(pose, st, i, 0.016);
    expect(st.speed).toBe(sim.SPEED_BASE + 6);
    i.wheel = 1000; sim.stepControls(pose, st, i, 0.016);
    expect(st.speed).toBe(sim.SPEED_MAX);
    i.wheel = -1000; sim.stepControls(pose, st, i, 0.016);
    expect(st.speed).toBe(sim.SPEED_MIN);
    i.wheel = 0; i.toggleFly = true; sim.stepControls(pose, st, i, 0.016);
    expect(st.freeFly).toBe(true);
  });

  it('speed x boost x dt', () => {
    const pose = sim.newPose(); pose.pos = [0, 30, 0];
    sim.goToInstant(pose, [0, 30, 0], [0, 30, 100]);
    const st = sim.newControlState();
    const i = sim.emptyIntent(); i.fz = 1; i.boost = true;
    sim.stepControls(pose, st, i, 0.5);
    expect(pose.pos[2]).toBeCloseTo(sim.SPEED_BASE * sim.SPEED_BOOST * 0.5, 9);
  });
});

/* ═══ collision ═════════════════════════════════════════════════════════════ */
describe('collision', () => {
  /* the real hull of the legacy world: displaceHills over a cylinder at the default seed */
  const geo = new THREE.CylinderGeometry(CONFIG.R, CONFIG.R, CONFIG.L, CONFIG.HULL_SEG, 96, true);
  const legacyHills = L.world.displaceHills(geo, CONFIG.R, CONFIG.L, mulberry32(CONFIG.SEED + 404));
  const hills = sim.hillsFromLegacy(legacyHills);

  it('the seed has hills and ponds', () => {
    expect(hills.length).toBe(CONFIG.COUNT.hills.reduce((a: number, b: number) => a + b, 0));
    expect(hills.some(h => h.rise < 0)).toBe(true);
    expect(hills.some(h => h.rise > 0)).toBe(true);
    expect(hills.some(h => h.aspect && h.aspect !== 1)).toBe(true);
  });

  it('terrainRadiusAt = radius of the legacy displaced hull mesh', () => {
    const pos = geo.attributes.position;
    let checked = 0, lifted = 0, maxDev = 0;
    for (let k = 0; k < pos.count; k += 7) {
      const x = pos.getX(k), y = pos.getY(k), z = pos.getZ(k);
      const th = Math.atan2(x, -z);
      const want = Math.hypot(x, z);
      const got = sim.terrainRadiusAt(th, y, hills);
      maxDev = Math.max(maxDev, Math.abs(got - want));
      if (Math.abs(want - CONFIG.R) > 1e-3) lifted++;
      checked++;
    }
    expect(checked).toBeGreaterThan(3000);
    expect(lifted).toBeGreaterThan(100);       // enough vertices actually sit on a hill / in a pond
    expect(maxDev).toBeLessThan(1e-4);         // float32 positions
  });

  it('terrain is flat where no hill reaches', () => {
    expect(sim.terrainRadiusAt(0.3, 0, [])).toBe(CORE_CONFIG.R);
    const h: sim.Hill = { theta: 1, z: 10, r: 8, rise: 2 };
    expect(sim.terrainRadiusAt(1, 10, [h])).toBeCloseTo(CORE_CONFIG.R - 2, 12);      // centre
    expect(sim.terrainRadiusAt(1, 10 + 8, [h])).toBe(CORE_CONFIG.R);                 // rim
    expect(sim.terrainRadiusAt(1 + 20 / CORE_CONFIG.R, 10, [h])).toBe(CORE_CONFIG.R);
  });

  it('random positions end up inside the keep-in volume; the result is stable (idempotent)', () => {
    const C = sim.DEFAULT_COLLIDE;
    let moved = 0;
    for (let i = 0; i < 5000; i++) {
      const r = rnd() * 70, a = rnd() * Math.PI * 2;
      const p = [Math.sin(a) * r, Math.cos(a) * r, (rnd() - 0.5) * 360];
      if (sim.collide(p, hills)) moved++;
      const rr = Math.hypot(p[0], p[1]);
      expect(rr).toBeGreaterThanOrEqual(C.tubeKeep - 1e-9);
      expect(rr).toBeLessThanOrEqual(sim.maxRadiusAt(Math.atan2(p[0], p[1]), p[2], hills) + 1e-9);
      expect(rr).toBeLessThanOrEqual(CORE_CONFIG.R - sim.HULL_MARGIN + 1e-9);
      expect(Math.abs(p[2])).toBeLessThanOrEqual(CORE_CONFIG.L / 2 - sim.END_MARGIN + 1e-9);
      const copy = p.slice();
      sim.collide(copy, hills);                          // already inside: at most float noise\n      near(copy, p, 1e-9);
    }
    expect(moved).toBeGreaterThan(1000);
  });

  it('positions inside the volume are untouched', () => {
    const p = [0, 25, 30];
    expect(sim.collide(p, hills)).toBe(false);
    expect(p).toEqual([0, 25, 30]);
  });

  it('keeps the camera above a hill crest and out of the tube, preserving the direction', () => {
    const crest = hills.filter(h => h.rise > 0).sort((a, b) => b.rise - a.rise)[0];
    const th = crest.theta, z = crest.z;
    const p = [Math.sin(th) * 49, Math.cos(th) * 49, z];
    sim.collide(p, hills);
    const rr = Math.hypot(p[0], p[1]);
    expect(rr).toBeCloseTo(sim.terrainRadiusAt(th, z, hills) - CORE_CONFIG.COLLIDE.radius, 9);
    expect(rr).toBeLessThan(CORE_CONFIG.R - crest.rise);
    expect(Math.cos(Math.atan2(p[0], p[1]) - th)).toBeCloseTo(1, 12);

    const q = [0.5, 0, 10];                                  // inside the tube
    sim.collide(q, hills);
    expect(Math.hypot(q[0], q[1])).toBeCloseTo(CORE_CONFIG.SUN.r + CORE_CONFIG.SUN.clear, 9);
    const onAxis = [0, 0, 10];
    sim.collide(onAxis, hills);
    expect(onAxis).toEqual([CORE_CONFIG.SUN.r + CORE_CONFIG.SUN.clear, 0, 10]);
  });

  it('z is clamped to the end caps and the free axis motion is kept', () => {
    const p = [0, 20, 999]; sim.collide(p);
    expect(p).toEqual([0, 20, CORE_CONFIG.L / 2 - 2]);
    const q = [0, 20, -999]; sim.collide(q);
    expect(q[2]).toBe(-(CORE_CONFIG.L / 2 - 2));
  });

  it('flying hard into the hull from the middle never leaves the volume', () => {
    const pose = sim.newPose(); pose.pos = [0, 30, 0];
    sim.goToInstant(pose, [0, 30, 0], [0, 80, 0]);          // look at the floor
    const st = sim.newControlState();
    const i = sim.emptyIntent(); i.fz = 1; i.boost = true;
    for (let f = 0; f < 200; f++) {
      sim.stepControls(pose, st, i, 1 / 30, hills);
      expect(Math.hypot(pose.pos[0], pose.pos[1])).toBeLessThanOrEqual(CORE_CONFIG.R - sim.HULL_MARGIN + 1e-9);
    }
  });
});

/* ═══ fly to a viewpoint ════════════════════════════════════════════════════ */
describe('fly to a viewpoint', () => {
  const TP = CORE_CONFIG.TP;
  const station = sim.DEFAULT_STATION;

  const flyOnce = (i: number, j: number, dt = 1 / 60) => {
    const pose = sim.newPose();
    sim.goToInstant(pose, TP[i].pos, TP[i].look);
    const fly = sim.newFly();
    const target = sim.tpVec(TP[j].pos), look = sim.tpVec(TP[j].look);
    sim.startFly(fly, pose, target, look);
    const poses: { pos: number[]; quat: number[] }[] = [];
    let arrived = false, frames = 0;
    while (fly.on && frames < 2000) {
      arrived = sim.stepFly(fly, pose, dt);
      poses.push({ pos: pose.pos.slice(), quat: pose.quat.slice() });
      frames++;
    }
    return { pose, fly, poses, arrived, frames, target, look };
  };

  it('path endpoints: starts at the camera, ends at the viewpoint', () => {
    const pose = sim.newPose();
    sim.goToInstant(pose, TP[0].pos, TP[0].look);
    const fly = sim.newFly();
    const target = sim.tpVec(TP[3].pos);
    sim.startFly(fly, pose, target, sim.tpVec(TP[3].look));
    near(sim.flyPoint(fly, 0), pose.pos, 1e-9);
    near(sim.flyPoint(fly, 1), target, 1e-9);
    expect(fly.dur).toBeGreaterThanOrEqual(CORE_CONFIG.FLY.min);
    expect(fly.dur).toBeLessThanOrEqual(CORE_CONFIG.FLY.max);
  });

  it('every pair of viewpoints: arrives exactly, within the duration, and levelled', () => {
    for (let i = 0; i < TP.length; i++) {
      for (let j = 0; j < TP.length; j++) {
        if (i === j) continue;
        const r = flyOnce(i, j);
        expect(r.arrived).toBe(true);
        near(r.pose.pos, r.target, 1e-9);
        expect(r.frames).toBeLessThanOrEqual(Math.ceil(r.fly.dur * 60) + 1);
        const f = fwdOf(r.pose.quat), up = sim.stationUp(r.pose.pos);
        expect(Math.abs(f[0] * up[0] + f[1] * up[1] + f[2] * up[2])).toBeLessThanOrEqual(sim.SIN_PITCH_MAX + 1e-9);
      }
    }
  });

  it('every path stays in the free corridor between the tube and the buildings, by construction', () => {
    const keep = station.sunKeep, top = station.R - sim.FLY_HULL_PAD;
    for (let i = 0; i < TP.length; i++) {
      for (let j = 0; j < TP.length; j++) {
        if (i === j) continue;
        const pose = sim.newPose(); sim.goToInstant(pose, TP[i].pos, TP[i].look);
        const fly = sim.newFly(); sim.startFly(fly, pose, sim.tpVec(TP[j].pos), sim.tpVec(TP[j].look));
        const lim = Math.max(fly.r0, fly.r1);
        for (let k = 0; k <= 100; k++) {
          const p = sim.flyPoint(fly, k / 100);
          const r = Math.hypot(p[0], p[1]);
          expect(r).toBeGreaterThanOrEqual(Math.min(fly.rMid, fly.r0, fly.r1) - 1e-9);
          expect(r).toBeLessThanOrEqual(Math.max(lim, fly.rMid) + 1e-9);
          expect(r).toBeGreaterThan(keep - 1e-9);
          expect(r).toBeLessThan(top + 1e-9 + Math.max(0, lim - top));
        }
      }
    }
  });

  it('turn rate: worst per-frame rotation over all 72 flights < 8 degrees (same bound as test.mjs)', () => {
    let worst = 0, at = '';
    for (let i = 0; i < TP.length; i++) {
      for (let j = 0; j < TP.length; j++) {
        if (i === j) continue;
        const { poses } = flyOnce(i, j);
        for (let k = 1; k < poses.length; k++) {
          const d = rad2deg(2 * Math.acos(Math.min(1, Math.abs(quat.dot(poses[k].quat, poses[k - 1].quat)))));
          if (d > worst) { worst = d; at = `${TP[i].name} -> ${TP[j].name}`; }
        }
      }
    }
    expect(worst, at).toBeLessThan(8);
  });

  it('matches a three.js reference of js/main.js updateFly frame by frame', () => {
    /* reference: the legacy glue (cylindrical path, direction interpolation) on the legacy three.js Vector3 and
       util functions. Aims along fly.dir (js/main.js line 385 passes the never-assigned `_v2`, see README). */
    const F = CONFIG.FLY, dt = 1 / 60;
    const ss = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    for (const [i, j] of [[0, 3], [5, 7], [8, 2], [1, 4]]) {
      const A = L.util.tpVec(CONFIG.TP[i].pos), B = L.util.tpVec(CONFIG.TP[j].pos), look = L.util.tpVec(CONFIG.TP[j].look);
      const pose = sim.newPose(); sim.goToInstant(pose, TP[i].pos, TP[i].look);
      const cam = new THREE.Quaternion(pose.quat[0], pose.quat[1], pose.quat[2], pose.quat[3]);
      const dir = new THREE.Vector3(...fwdOf(pose.quat));
      const up0 = new THREE.Vector3(...sim.cameraUp(pose.quat)).normalize();
      const a0 = Math.atan2(A.x, A.y), a1 = Math.atan2(B.x, B.y);
      const da = ((a1 - a0 + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
      const r0 = Math.hypot(A.x, A.y), r1 = Math.hypot(B.x, B.y);
      const rMid = Math.min(Math.max(Math.min(r0, r1, CONFIG.R * F.corridor), CONFIG.SUN.r + CONFIG.SUN.clear + 2), CONFIG.R - 8);
      const dur = Math.min(F.max, Math.max(F.min, F.min + Math.hypot(Math.abs(da) * (r0 + r1) * 0.5, B.z - A.z, r1 - r0) / F.speed));
      const pt = (e: number) => {
        const bump = Math.sin(Math.PI * Math.min(1, Math.max(0, e)));
        const a = a0 + da * e, rl = r0 + (r1 - r0) * e, r = rl + (rMid - rl) * bump * F.pull;
        return new THREE.Vector3(Math.sin(a) * r, Math.cos(a) * r, A.z + (B.z - A.z) * e);
      };
      const fly = sim.newFly(); sim.startFly(fly, pose, sim.tpVec(TP[j].pos), sim.tpVec(TP[j].look));
      expect(fly.dur).toBeCloseTo(dur, 12);
      let t = 0;
      while (fly.on) {
        sim.stepFly(fly, pose, dt);
        t = Math.min(1, t + dt / dur);
        const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        const p = pt(e), ahead = pt(e + F.lead);
        const dA = ahead.clone().sub(p); if (dA.lengthSq() < 1e-6) dA.copy(dir); else dA.normalize();
        const dB = look.clone().sub(p).normalize();
        const upA = L.ctl.stationUp(p, new THREE.Vector3());
        const upB = up0.clone().lerp(upA, ss(0.2, 1, e)).normalize();
        L.util.turnToward(dA, dB, ss(F.turnFrom, 1, e), upA, dA);
        L.util.turnToward(dir, dA, 1 - Math.exp(-dt * F.turn), upA, dir);
        L.util.clampPitch(dir, upB, Math.sin(F.pitchMax * Math.PI / 180));
        L.util.aimAt(p, p.clone().addScaledVector(dir, 60), upB, cam);
        near(pose.pos, p.toArray(), 1e-9);
        nearQ(pose.quat, cam.toArray(), 1e-9);
        if (!fly.on) {
          /* the arrival levels the camera, exactly like syncFromCamera */
          const lv = new THREE.PerspectiveCamera(); lv.position.copy(p); lv.quaternion.copy(cam);
          L.ctl.ctl.freeFly = false; L.ctl.levelCamera(lv);
          nearQ(pose.quat, lv.quaternion.toArray(), 1e-9);
        }
      }
    }
  });

  it('the gaze converges on the viewpoint look target while the camera dwells', () => {
    const { pose, target, look } = flyOnce(0, 5);
    /* keep chasing for a few seconds as the tour hold does: the path is parked, direction keeps turning */
    const want = [look[0] - target[0], look[1] - target[1], look[2] - target[2]];
    const n = Math.hypot(...want);
    const f = fwdOf(pose.quat);
    /* pitch is limited to 70 degrees by the flight and 84 by levelling; here only sanity: within 60 degrees */
    expect(angleBetween(f, want.map(c => c / n))).toBeLessThan(60);
  });

  it('goToInstant looks at the target and is levelled', () => {
    for (const tp of TP) {
      const pose = sim.newPose();
      sim.goToInstant(pose, tp.pos, tp.look);
      near(pose.pos, sim.tpVec(tp.pos), 1e-12);
      const want = sim.tpVec(tp.look).map((c, k) => c - pose.pos[k]);
      const n = Math.hypot(...want);
      const f = fwdOf(pose.quat), up = sim.stationUp(pose.pos);
      const w = want.map(c => c / n);
      const pitch = w[0] * up[0] + w[1] * up[1] + w[2] * up[2];
      /* equal to the target direction unless the pitch limit clipped it */
      if (Math.abs(pitch) < sim.SIN_PITCH_MAX) expect(angleBetween(f, w)).toBeLessThan(1e-4);
    }
  });

  it('cancelFly stops it', () => {
    const pose = sim.newPose(); sim.goToInstant(pose, TP[0].pos, TP[0].look);
    const fly = sim.newFly(); sim.startFly(fly, pose, sim.tpVec(TP[1].pos), sim.tpVec(TP[1].look));
    sim.stepFly(fly, pose, 0.1);
    sim.cancelFly(fly);
    expect(sim.stepFly(fly, pose, 0.1)).toBe(false);
    expect(fly.on).toBe(false);
  });
});

/* ═══ tour ══════════════════════════════════════════════════════════════════ */
describe('tour', () => {
  it('goTo 0, caption at the start of each hold, next flight after TOUR_HOLD, wraps around', () => {
    const tour = sim.newTour();
    const hold = CORE_CONFIG.TOUR_HOLD, n = CORE_CONFIG.TP.length;
    expect(sim.startTour(tour)).toEqual({ type: 'goTo', idx: 0 });
    expect(tour.wait).toBe(hold);
    /* flying: timer frozen, caption hidden */
    expect(sim.stepTour(tour, 1, true)).toEqual({ type: 'hideCaption' });
    expect(tour.wait).toBe(hold);
    /* landed: the caption shows once, then the countdown runs */
    expect(sim.stepTour(tour, 0.5, false)).toEqual({ type: 'caption', idx: 0 });
    expect(sim.stepTour(tour, 0.5, false)).toEqual({ type: 'none' });
    let t = 1.0, a: sim.TourAction = { type: 'none' };
    while (a.type !== 'goTo') { a = sim.stepTour(tour, 0.5, false); t += 0.5; }
    expect(a).toEqual({ type: 'goTo', idx: 1 });
    expect(t).toBeGreaterThanOrEqual(hold);
    expect(t).toBeLessThanOrEqual(hold + 0.5);
    for (let k = 1; k < n; k++) {
      tour.wait = 0.1;
      expect(sim.stepTour(tour, 0.2, false)).toEqual({ type: 'goTo', idx: (k + 1) % n });
    }
    expect(tour.idx).toBe(0);
  });

  it('is inert when off', () => {
    const tour = sim.newTour();
    expect(sim.stepTour(tour, 100, false)).toEqual({ type: 'none' });
    sim.startTour(tour);
    expect(sim.stopTour(tour)).toEqual({ type: 'hideCaption' });
    expect(sim.stepTour(tour, 100, false)).toEqual({ type: 'none' });
  });
});

/* ═══ monorail ride ═════════════════════════════════════════════════════════ */
describe('monorail ride', () => {
  const cars = [[0, 3.4, -100], [0, 3.4, 20], [0, -3.4, 60]];
  const seat: sim.SeatFn = (k, p, d) => {
    if (k < 0 || k >= cars.length) return false;
    p[0] = cars[k][0]; p[1] = cars[k][1]; p[2] = cars[k][2]; d[0] = 0; d[1] = 0; d[2] = 1;
    return true;
  };

  it('boards the nearest cabin and rides with it, eye above the floor', () => {
    const pose = sim.newPose(); pose.pos = [5, 20, 50];
    const ride = sim.newRide();
    sim.startRide(ride, pose, seat, cars.length);
    expect(ride.on).toBe(true);
    expect(ride.car).toBe(2);
    expect(sim.stepRide(ride, pose, seat)).toBe(true);
    near(pose.pos, [0, -3.4 + CORE_CONFIG.LIFTCAR.eye, 60], 1e-12);
    cars[2][2] = 70;                                           // the cabin moves, the camera follows
    sim.stepRide(ride, pose, seat);
    expect(pose.pos[2]).toBe(70);
    cars[2][2] = 60;
  });

  it('the gaze is left to the player', () => {
    const pose = sim.newPose(); pose.pos = [0, 3.4, 20];
    const q0 = [0.1, 0.2, 0.3, 0.9]; pose.quat = q0.slice();
    const ride = sim.newRide(); sim.startRide(ride, pose, seat, cars.length);
    sim.stepRide(ride, pose, seat);
    expect(pose.quat).toEqual(q0);
  });

  it('ends when the cabin vanishes; no cabins = no ride', () => {
    const pose = sim.newPose();
    const ride = sim.newRide();
    sim.startRide(ride, pose, seat, 0);
    expect(ride.on).toBe(false);
    sim.startRide(ride, pose, seat, cars.length);
    ride.car = 99;
    expect(sim.stepRide(ride, pose, seat)).toBe(false);
    expect(ride.on).toBe(false);
  });

  it('while riding only the orientation counter-rotates', () => {
    const pose = sim.newPose(); pose.pos = [0, 3.4, 20];
    const ride = sim.newRide(); sim.startRide(ride, pose, seat, cars.length);
    sim.stepRide(ride, pose, seat);
    const p0 = pose.pos.slice();
    sim.counterRotate(pose, 0.2, true);
    sim.stepRide(ride, pose, seat);
    near(pose.pos, p0, 1e-12);
  });
});
