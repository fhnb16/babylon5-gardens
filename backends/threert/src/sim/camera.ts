/* ═══════════════════════════════════════════════════════════════════════════
   Station-frame camera. Pure maths (core/math only), no ThreeRT, no DOM.

   Frame. The ThreeRT world is STATIC: nothing in it rotates. The legacy app rotates the station by +omega*dt about
   Z while the camera sits in the inertial frame; here we describe the camera in station-local coordinates, so
   every frame the camera pose is rotated about Z by -omega*dt (counterRotate). "Up" is the centrifugal
   direction, from the floor to the axis: stationUp(p) = normalize(-x, -y, 0); it is invariant under that rotation.

   The camera looks along its local -Z, +Y is its up (three.js convention). Quaternions are [x, y, z, w].

   Ported 1:1 from js/controls.js (stationUp, frameUp, levelCamera, look/move) and js/util.js (aimAt, turnToward,
   clampPitch). test/sim.test.ts compares them with the legacy modules.
   TODO(core/camera): another agent is writing core/camera/**. When it exists, import it here and delete the
   duplicates (see README "Layout").
   ═══════════════════════════════════════════════════════════════════════════ */

import * as vec3 from '../../../../core/math/vec3.ts';
import * as quat from '../../../../core/math/quat.ts';
import * as mat4 from '../../../../core/math/mat4.ts';
import { clamp, TAU, D2R } from '../../../../core/math/scalar.ts';
import { CORE_CONFIG } from '../../../../core/config/index.ts';
import { SIN_PITCH_MAX } from './constants.ts';

export type V3 = number[];
export type Q4 = number[];

export interface CameraPose {
  /** station-local position, station units */
  pos: V3;
  /** orientation, station-local, camera looks along -Z */
  quat: Q4;
}

export const newPose = (): CameraPose => ({ pos: [0, 0, 0], quat: [0, 0, 0, 1] });
export const clonePose = (p: CameraPose): CameraPose => ({ pos: p.pos.slice(), quat: p.quat.slice() });
export function copyPose(src: CameraPose, dst: CameraPose): CameraPose {
  vec3.copy(src.pos, dst.pos); quat.copy(src.quat, dst.quat);
  return dst;
}

/** Station rotation rate, rad/s, for a rotation period in seconds (CORE_CONFIG.ROT_PERIOD_*). 0 period = still. */
export const omegaFromPeriod = (periodSeconds: number): number => (periodSeconds > 0 ? TAU / periodSeconds : 0);
export const OMEGA_DEFAULT = omegaFromPeriod(CORE_CONFIG.ROT_PERIOD_DEFAULT);

/* scratch (module-level: no allocation per frame, and no state that survives a call) */
const _up: V3 = [0, 0, 0], _fwd: V3 = [0, 0, 0], _right: V3 = [0, 0, 0], _back: V3 = [0, 0, 0];
const _q: Q4 = [0, 0, 0, 1], _m4 = mat4.identity();
const _aimF: V3 = [0, 0, 0], _aimU: V3 = [0, 0, 0], _aimT: V3 = [0, 0, 0], _aimM = mat4.identity();
const _tA: V3 = [0, 0, 0], _tQ: Q4 = [0, 0, 0, 1], _tR: V3 = [0, 0, 0];
const _cpP: V3 = [0, 0, 0], _cpT: V3 = [0, 0, 0];
const Z_AXIS: V3 = [0, 0, 1];
const FWD_LOCAL: V3 = [0, 0, -1];
const UP_LOCAL: V3 = [0, 1, 0];

/** Direction the camera looks along (-Z of the camera in station space). */
export function forward(q: Q4, out: V3 = [0, 0, 0]): V3 {
  return quat.rotateVec3(q, FWD_LOCAL, out) as V3;
}
/** The camera's own up (+Y of the camera in station space). */
export function cameraUp(q: Q4, out: V3 = [0, 0, 0]): V3 {
  return quat.rotateVec3(q, UP_LOCAL, out) as V3;
}

/** "Up" is the centrifugal force: from the floor to the axis. On the axis itself (|xy| ~ 0) fall back to +Y. */
export function stationUp(pos: ArrayLike<number>, out: V3 = [0, 0, 0]): V3 {
  vec3.set(-pos[0], -pos[1], 0, out);
  if (vec3.lengthSq(out) < 1e-4) return vec3.set(0, 1, 0, out) as V3;
  return vec3.normalize(out, out) as V3;
}

/** The frame's reference up: station-up in station mode, the camera's own up in free-fly. */
export function frameUp(pose: CameraPose, freeFly: boolean, out: V3 = [0, 0, 0]): V3 {
  if (!freeFly) return stationUp(pose.pos, out);
  cameraUp(pose.quat, out);
  return vec3.normalize(out, out) as V3;
}

/** Quaternion of a camera looking from `eye` at `target` (js/util.js aimAt). `up` is orthogonalised against the
    view direction; when they nearly coincide the station axis supplies a stable perpendicular. */
export function aimAt(eye: ArrayLike<number>, target: ArrayLike<number>, up: ArrayLike<number>, out: Q4 = [0, 0, 0, 1]): Q4 {
  vec3.sub(target as V3, eye as V3, _aimF);
  if (vec3.lengthSq(_aimF) < 1e-12) return out;
  vec3.normalize(_aimF, _aimF);
  vec3.addScaled(up as V3, _aimF, -vec3.dot(up as V3, _aimF), _aimU);
  if (vec3.lengthSq(_aimU) < 0.02) {
    vec3.set(0, 0, 1, _aimT);
    if (Math.abs(_aimF[2]) > 0.9) vec3.set(1, 0, 0, _aimT);
    vec3.cross(_aimT, _aimF, _aimU);
    if (vec3.lengthSq(_aimU) < 1e-8) vec3.set(1, 0, 0, _aimU);
  }
  vec3.normalize(_aimU, _aimU);
  mat4.lookAt(eye as V3, target as V3, _aimU, _aimM);
  return quat.fromRotationMatrix(_aimM, out) as Q4;
}

/** Rotate unit vector `from` towards `to` by fraction `w` of the angle with a stable axis (js/util.js turnToward).
    Exactly opposite directions turn through the horizon (axis = `up`). `out` may alias `from` or `to`. */
export function turnToward(from: V3, to: V3, w: number, up: V3, out: V3 = [0, 0, 0]): V3 {
  const d = clamp(vec3.dot(from, to), -1, 1);
  vec3.cross(from, to, _tA);
  if (vec3.lengthSq(_tA) < 1e-8) {
    if (d > 0) return vec3.copy(from, out) as V3;
    vec3.copy(up, _tA);
    vec3.addScaled(_tA, from, -vec3.dot(from, _tA), _tA);
    if (vec3.lengthSq(_tA) < 1e-8) vec3.cross(Z_AXIS, from, _tA);
  }
  vec3.normalize(_tA, _tA);
  quat.fromAxisAngle(_tA, Math.acos(d) * clamp(w, 0, 1), _tQ);
  quat.rotateVec3(_tQ, from, _tR);
  return vec3.normalize(_tR, out) as V3;
}

/** Limit the angle between `dir` and `up` so that |dir . up| <= sinMax, in place (js/util.js clampPitch). The
    result sits exactly on the limit; the decomposition avoids the "remove vertical and normalize" shrink. */
export function clampPitch(dir: V3, up: V3, sinMax: number): V3 {
  const d = vec3.dot(dir, up);
  if (Math.abs(d) <= sinMax) return dir;
  vec3.addScaled(dir, up, -d, _cpP);
  if (vec3.lengthSq(_cpP) < 1e-10) {
    vec3.set(0, 0, 1, _cpT);
    if (Math.abs(up[2]) > 0.9) vec3.set(1, 0, 0, _cpT);
    vec3.cross(up, _cpT, _cpP);
  }
  vec3.normalize(_cpP, _cpP);
  vec3.scale(up, Math.sign(d) * sinMax, dir);
  vec3.addScaled(dir, _cpP, Math.sqrt(Math.max(0, 1 - sinMax * sinMax)), dir);
  return vec3.normalize(dir, dir) as V3;
}

/** Remove roll and clamp pitch: the basis is rebuilt from the station "up" (js/controls.js levelCamera). Free-fly
    has nothing to level - roll is part of the control. */
export function levelCamera(pose: CameraPose, freeFly: boolean): CameraPose {
  if (freeFly) return pose;
  stationUp(pose.pos, _up);
  forward(pose.quat, _fwd);
  clampPitch(_fwd, _up, SIN_PITCH_MAX);
  vec3.cross(_fwd, _up, _right);
  if (vec3.lengthSq(_right) < 1e-8) return pose;
  vec3.normalize(_right, _right);
  vec3.cross(_right, _fwd, _up);
  vec3.normalize(_up, _up);
  vec3.negate(_fwd, _back);
  mat4.makeBasis(_right, _up, _back, _m4);
  quat.fromRotationMatrix(_m4, pose.quat);
  return pose;
}

/** Look input in radians: positive dYaw turns left (counter-clockwise seen from `up`), positive dPitch looks up.
    Pitch is clamped BEFORE rotating (js/controls.js updateControls), then the camera is levelled. */
export function applyLook(pose: CameraPose, dYaw: number, dPitch: number, freeFly: boolean): CameraPose {
  if (dYaw || dPitch) {
    frameUp(pose, freeFly, _up);
    quat.fromAxisAngle(_up, dYaw, _q);
    quat.multiply(_q, pose.quat, pose.quat);
    forward(pose.quat, _fwd);
    vec3.cross(_fwd, _up, _right);
    if (vec3.lengthSq(_right) > 1e-8) {
      vec3.normalize(_right, _right);
      const cur = Math.asin(clamp(vec3.dot(_fwd, _up), -1, 1));
      const lim = Math.asin(SIN_PITCH_MAX);
      quat.fromAxisAngle(_right, clamp(cur + dPitch, -lim, lim) - cur, _q);
      quat.multiply(_q, pose.quat, pose.quat);
    }
  }
  return levelCamera(pose, freeFly);
}

/** Move along the camera's forward / right / up. `fx` right, `fy` up (towards the axis in station mode),
    `fz` forward; `dist` = speed * dt. Positions only - collisions are collide.ts. */
export function moveLocal(pose: CameraPose, fx: number, fy: number, fz: number, dist: number, freeFly: boolean): CameraPose {
  forward(pose.quat, _fwd);
  frameUp(pose, freeFly, _up);
  vec3.cross(_fwd, _up, _right);
  vec3.normalize(_right, _right);
  vec3.addScaled(pose.pos, _fwd, fz * dist, pose.pos);
  vec3.addScaled(pose.pos, _right, fx * dist, pose.pos);
  vec3.addScaled(pose.pos, _up, fy * dist, pose.pos);
  return pose;
}

/** Station rotation seen from the static world: rotate the pose about Z by -angle (angle = omega * dt).
    `orientationOnly` keeps the position (a monorail ride: the cabin is fixed in the station frame, but the
    player's gaze direction stays fixed in the inertial frame, as in the legacy app). */
export function counterRotate(pose: CameraPose, angle: number, orientationOnly = false): CameraPose {
  if (!angle) return pose;
  const c = Math.cos(-angle), s = Math.sin(-angle);
  if (!orientationOnly) {
    const x = pose.pos[0], y = pose.pos[1];
    pose.pos[0] = c * x - s * y;
    pose.pos[1] = s * x + c * y;
  }
  quat.fromAxisAngle(Z_AXIS, -angle, _q);
  quat.multiply(_q, pose.quat, pose.quat);
  quat.normalize(pose.quat, pose.quat);
  return pose;
}

/** [theta deg, r, z] -> station-local xyz (js/util.js tpVec / surfacePos): x = r sin t, y = r cos t. */
export function tpVec(tp: ArrayLike<number>, out: V3 = [0, 0, 0]): V3 {
  const t = tp[0] * D2R;
  return vec3.set(Math.sin(t) * tp[1], Math.cos(t) * tp[1], tp[2], out) as V3;
}
