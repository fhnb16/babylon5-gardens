/* ═══════════════════════════════════════════════════════════════════════════
   Camera maths without THREE — ports of js/util.js aimAt / turnToward /
   clampPitch, js/controls.js stationUp, and the teleport flight of
   js/main.js (goTo / flyPoint / updateFly). Vectors are [x, y, z] arrays,
   quaternions [x, y, z, w]; functions write into `out` and return it.

   Frames: the station rotates about Z. Flight paths are planned in station-
   local coordinates; stepFlight takes the station's current rotation angle
   (rotZ) and works in the fixed scene frame like legacy did (the camera's
   look direction and up are kept there between frames).
   ═══════════════════════════════════════════════════════════════════════════ */

import { CORE_CONFIG } from '../config/index.ts';
import { clamp, easeInOut, lerp, TAU } from '../math/scalar.ts';
import { lookAt } from '../math/mat4.ts';
import { fromAxisAngle, fromRotationMatrix, rotateVec3, type Quat } from '../math/quat.ts';
import type { Vec3 } from '../math/vec3.ts';

const len2 = (v: ArrayLike<number>): number => v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
function normalizeIn(v: number[] | Vec3): void {
  const l = Math.sqrt(len2(v)) || 1;
  v[0] /= l; v[1] /= l; v[2] /= l;
}
const dot3 = (a: ArrayLike<number>, b: ArrayLike<number>): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** "Up" at a position: towards the axis; +Y on the axis itself. */
export function stationUp(pos: ArrayLike<number>, out: Vec3 = [0, 0, 0]): Vec3 {
  out[0] = -pos[0]; out[1] = -pos[1]; out[2] = 0;
  if (len2(out) < 1e-4) { out[0] = 0; out[1] = 1; out[2] = 0; return out; }
  normalizeIn(out);
  return out;
}

export const smoothstep01 = (a: number, b: number, x: number): number => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

const _aimM = new Float64Array(16);

/**
 * Camera orientation looking from `eye` at `target` (camera looks down −Z).
 * `up` is orthogonalized to the view; near-degenerate cases fall back to the
 * station axis (legacy thresholds). Leaves `out` untouched if eye ≈ target.
 */
export function aimAt(eye: ArrayLike<number>, target: ArrayLike<number>, up: ArrayLike<number>, out: Quat = [0, 0, 0, 1]): Quat {
  const F = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
  if (len2(F) < 1e-12) return out;
  normalizeIn(F);
  const d = dot3(up, F);
  const U = [up[0] - F[0] * d, up[1] - F[1] * d, up[2] - F[2] * d];
  if (len2(U) < 0.02) {
    const T = Math.abs(F[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
    U[0] = T[1] * F[2] - T[2] * F[1];
    U[1] = T[2] * F[0] - T[0] * F[2];
    U[2] = T[0] * F[1] - T[1] * F[0];
    if (len2(U) < 1e-8) { U[0] = 1; U[1] = 0; U[2] = 0; }
  }
  normalizeIn(U);
  _aimM.fill(0); _aimM[0] = _aimM[5] = _aimM[10] = _aimM[15] = 1;
  lookAt(eye as Vec3, target as Vec3, U, _aimM);
  return fromRotationMatrix(_aimM, out);
}

/**
 * Rotate unit direction `from` towards `to` by fraction w (0..1) about a
 * stable axis; turning exactly back goes "through the horizon" (about `up`).
 * `out` may alias `from`.
 */
export function turnToward(from: ArrayLike<number>, to: ArrayLike<number>, w: number, up: ArrayLike<number>, out: Vec3 = [0, 0, 0]): Vec3 {
  const fx = from[0], fy = from[1], fz = from[2];
  const d = clamp(fx * to[0] + fy * to[1] + fz * to[2], -1, 1);
  const A = [fy * to[2] - fz * to[1], fz * to[0] - fx * to[2], fx * to[1] - fy * to[0]];
  if (len2(A) < 1e-8) {
    if (d > 0) { out[0] = fx; out[1] = fy; out[2] = fz; return out; }
    const k = fx * up[0] + fy * up[1] + fz * up[2];
    A[0] = up[0] - fx * k; A[1] = up[1] - fy * k; A[2] = up[2] - fz * k;
    if (len2(A) < 1e-8) { A[0] = -fy; A[1] = fx; A[2] = 0; }   // (0,0,1) × from
  }
  normalizeIn(A);
  const q = fromAxisAngle(A, Math.acos(d) * clamp(w, 0, 1), [0, 0, 0, 1]);
  rotateVec3(q, [fx, fy, fz], out);
  normalizeIn(out);
  return out;
}

/**
 * Limit the angle between `dir` and `up`: |dir·up| ≤ sinMax, rebuilt exactly
 * on the limit (no shrink-and-renormalize drift). Modifies and returns `dir`.
 */
export function clampPitch(dir: Vec3, up: ArrayLike<number>, sinMax: number): Vec3 {
  const d = dot3(dir, up);
  if (Math.abs(d) <= sinMax) return dir;
  const P = [dir[0] - up[0] * d, dir[1] - up[1] * d, dir[2] - up[2] * d];
  if (len2(P) < 1e-10) {
    const T = Math.abs(up[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
    P[0] = up[1] * T[2] - up[2] * T[1];
    P[1] = up[2] * T[0] - up[0] * T[2];
    P[2] = up[0] * T[1] - up[1] * T[0];
  }
  normalizeIn(P);
  const s = Math.sign(d) * sinMax, c = Math.sqrt(Math.max(0, 1 - sinMax * sinMax));
  dir[0] = up[0] * s + P[0] * c; dir[1] = up[1] * s + P[1] * c; dir[2] = up[2] * s + P[2] * c;
  normalizeIn(dir);
  return dir;
}

/* ─── teleport flight ─────────────────────────────────────────────────────── */

export interface FlightState {
  /** station-local start / destination / look target */
  p0: Vec3;
  p2: Vec3;
  look: Vec3;
  a0: number;
  da: number;
  r0: number;
  r1: number;
  z0: number;
  z1: number;
  rMid: number;
  /** seconds */
  dur: number;
  /** progress 0..1 */
  t: number;
  /** current look direction and starting up, scene frame */
  dir: Vec3;
  up: Vec3;
  on: boolean;
}

/**
 * Plan a flight (legacy goTo, non-instant). Path in cylindrical coordinates:
 * shortest arc in θ, radius pulled towards the free corridor between the
 * Tower and the sun tube, duration by path length. `camDir` / `camUp` are the
 * camera's current forward / up (scene frame).
 */
export function planFlight(p0: ArrayLike<number>, target: ArrayLike<number>, look: ArrayLike<number>,
  camDir: ArrayLike<number>, camUp: ArrayLike<number>): FlightState {
  const F = CORE_CONFIG.FLY, R = CORE_CONFIG.R;
  const a0 = Math.atan2(p0[0], p0[1]);
  const a1 = Math.atan2(target[0], target[1]);
  const da = ((a1 - a0 + Math.PI) % TAU + TAU) % TAU - Math.PI;
  const r0 = Math.hypot(p0[0], p0[1]);
  const r1 = Math.hypot(target[0], target[1]);
  const rMid = clamp(Math.min(r0, r1, R * F.corridor), CORE_CONFIG.SUN.r + CORE_CONFIG.SUN.clear + 2, R - 8);
  const arc = Math.abs(da) * (r0 + r1) * 0.5;
  const len = Math.hypot(arc, target[2] - p0[2], r1 - r0);
  const up: Vec3 = [camUp[0], camUp[1], camUp[2]];
  normalizeIn(up);
  return {
    p0: [p0[0], p0[1], p0[2]], p2: [target[0], target[1], target[2]], look: [look[0], look[1], look[2]],
    a0, da, r0, r1, z0: p0[2], z1: target[2], rMid,
    dur: clamp(F.min + len / F.speed, F.min, F.max),
    t: 0, dir: [camDir[0], camDir[1], camDir[2]], up, on: true
  };
}

/** Station-local point of the path at eased progress e (e may leave [0, 1]: look-ahead). */
export function flyPoint(st: FlightState, e: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const bump = Math.sin(Math.PI * clamp(e, 0, 1));
  const a = st.a0 + st.da * e;
  const rLine = lerp(st.r0, st.r1, e);
  const r = rLine + (st.rMid - rLine) * bump * CORE_CONFIG.FLY.pull;
  out[0] = Math.sin(a) * r; out[1] = Math.cos(a) * r; out[2] = lerp(st.z0, st.z1, e);
  return out;
}

const rotZ3 = (v: Vec3, c: number, s: number): Vec3 => {
  const x = v[0], y = v[1];
  v[0] = x * c - y * s; v[1] = x * s + y * c;
  return v;
};

/** Distance of the aim point along the look direction (any positive value gives the same orientation). */
const AIM_AHEAD = 60;

export interface CameraPose { pos: Vec3; quat: Quat }

/**
 * Advance the flight by dt (legacy updateFly). `rotZ` = current station
 * rotation (scene = Rz(rotZ)·local). Writes the camera pose (scene frame)
 * into `out`; sets st.on = false on arrival.
 *
 * Legacy aimed at a never-assigned vector (main.js `_v2` = origin); this port
 * aims along the computed st.dir, as app/flight.ts does.
 */
export function stepFlight(st: FlightState, dt: number, rotZ: number, out: CameraPose): CameraPose {
  const F = CORE_CONFIG.FLY;
  const c = Math.cos(rotZ), s = Math.sin(rotZ);
  st.t = Math.min(1, st.t + dt / st.dur);
  const e = easeInOut(st.t);
  const pos = rotZ3(flyPoint(st, e, [0, 0, 0]), c, s);
  const ahead = rotZ3(flyPoint(st, e + F.lead, [0, 0, 0]), c, s);
  const dirA: Vec3 = [ahead[0] - pos[0], ahead[1] - pos[1], ahead[2] - pos[2]];
  if (len2(dirA) < 1e-6) { dirA[0] = st.dir[0]; dirA[1] = st.dir[1]; dirA[2] = st.dir[2]; } else normalizeIn(dirA);
  const lookW = rotZ3([st.look[0], st.look[1], st.look[2]], c, s);
  const dirB: Vec3 = [lookW[0] - pos[0], lookW[1] - pos[1], lookW[2] - pos[2]];
  normalizeIn(dirB);
  const upA = stationUp(pos);
  const k = smoothstep01(0.2, 1, e);
  const upB: Vec3 = [st.up[0] + (upA[0] - st.up[0]) * k, st.up[1] + (upA[1] - st.up[1]) * k, st.up[2] + (upA[2] - st.up[2]) * k];
  normalizeIn(upB);
  turnToward(dirA, dirB, smoothstep01(F.turnFrom, 1, e), upA, dirA);
  turnToward(st.dir, dirA, 1 - Math.exp(-dt * F.turn), upA, st.dir);
  clampPitch(st.dir, upB, Math.sin(F.pitchMax * Math.PI / 180));
  const tgt = [pos[0] + st.dir[0] * AIM_AHEAD, pos[1] + st.dir[1] * AIM_AHEAD, pos[2] + st.dir[2] * AIM_AHEAD];
  out.pos[0] = pos[0]; out.pos[1] = pos[1]; out.pos[2] = pos[2];
  aimAt(pos, tgt, upB, out.quat);
  if (st.t >= 1) st.on = false;
  return out;
}

/** Instant teleport pose to view [θ°, r, z] → look (legacy goTo(i, true)), scene frame. */
export function viewPose(pos: readonly [number, number, number], look: readonly [number, number, number], rotZ = 0,
  out: CameraPose = { pos: [0, 0, 0], quat: [0, 0, 0, 1] }): CameraPose {
  const D = Math.PI / 180;
  const c = Math.cos(rotZ), s = Math.sin(rotZ);
  const p = rotZ3([Math.sin(pos[0] * D) * pos[1], Math.cos(pos[0] * D) * pos[1], pos[2]], c, s);
  const l = rotZ3([Math.sin(look[0] * D) * look[1], Math.cos(look[0] * D) * look[1], look[2]], c, s);
  out.pos[0] = p[0]; out.pos[1] = p[1]; out.pos[2] = p[2];
  aimAt(p, l, stationUp(p), out.quat);
  return out;
}

/* ─── sun on screen ───────────────────────────────────────────────────────── */

/**
 * The point of the sun tube (the axis x = y = 0, |z| ≤ L/2) nearest to the
 * view ray from `p` along unit `f` (legacy setSunScreen, scene frame).
 */
export function sunAxisPoint(p: ArrayLike<number>, f: ArrayLike<number>, out: Vec3 = [0, 0, 0]): Vec3 {
  const denom = 1 - f[2] * f[2];
  const zAxis = denom < 1e-4 ? p[2] + Math.sign(f[2] || 1) * 100
    : p[2] + f[2] * (-(p[0] * f[0] + p[1] * f[1])) / denom;
  out[0] = 0; out[1] = 0; out[2] = clamp(zAxis, -CORE_CONFIG.L / 2, CORE_CONFIG.L / 2);
  return out;
}

/**
 * Project the sun axis point with a view-projection matrix (column-major):
 * returns screen UV (0..1), NDC depth and the legacy visibility rule.
 */
export function sunScreen(p: ArrayLike<number>, f: ArrayLike<number>, viewProj: ArrayLike<number>):
  { u: number; v: number; z: number; visible: boolean } {
  const q = sunAxisPoint(p, f);
  const m = viewProj;
  const x = q[0], y = q[1], z = q[2];
  const w = 1 / (m[3] * x + m[7] * y + m[11] * z + m[15]);
  const nx = (m[0] * x + m[4] * y + m[8] * z + m[12]) * w;
  const ny = (m[1] * x + m[5] * y + m[9] * z + m[13]) * w;
  const nz = (m[2] * x + m[6] * y + m[10] * z + m[14]) * w;
  return { u: nx * 0.5 + 0.5, v: ny * 0.5 + 0.5, z: nz, visible: nz < 1 && Math.abs(nx) < 2.5 && Math.abs(ny) < 2.5 };
}

/** Rotate a quaternion's forward (−Z) into a direction (camera.getWorldDirection). */
export function forwardOf(q: Quat, out: Vec3 = [0, 0, 0]): Vec3 {
  return rotateVec3(q, [0, 0, -1], out);
}
