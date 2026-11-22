/* ═══════════════════════════════════════════════════════════════════════════
   Automatic camera modes: fly to a viewpoint, the tour, a monorail ride. Pure state machines over a CameraPose;
   the adapter decides when to call them. Ported from js/main.js (goTo, flyPoint, updateFly, setTour/updateTour,
   setRide/updateRide).

   All coordinates are station-local. In the legacy app the path is converted from the rotating group to the world
   every frame; here the world is static, so the path is simply used as is (no counter-rotation while flying).
   Order of a frame in the adapter:
     1. controls (unless busy)  2. stepFly / stepRide  3. counterRotate (not while flying; orientation only
     while riding)  4. write the pose to the camera.
   ═══════════════════════════════════════════════════════════════════════════ */

import * as vec3 from '../../../../core/math/vec3.ts';
import { clamp, easeInOut, lerp, TAU } from '../../../../core/math/scalar.ts';
import { CORE_CONFIG } from '../../../../core/config/index.ts';
import {
  aimAt, clampPitch, cameraUp, forward, levelCamera, stationUp, tpVec, turnToward,
  type CameraPose, type V3,
} from './camera.ts';
import { FLY_AIM_DIST, FLY_HULL_PAD, FLY_TUBE_PAD, FLY_UP_FROM } from './constants.ts';

export type FlyConfig = { [K in keyof typeof CORE_CONFIG.FLY]: number };
export interface StationConfig { R: number; sunKeep: number }
export const DEFAULT_STATION: StationConfig = { R: CORE_CONFIG.R, sunKeep: CORE_CONFIG.SUN.r + CORE_CONFIG.SUN.clear };

const smoothstep01 = (a: number, b: number, x: number): number => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/* ═══ fly to a viewpoint ═══════════════════════════════════════════════════ */

export interface FlyState {
  on: boolean;
  /** 0..1 progress (before easing), dur = seconds */
  t: number;
  dur: number;
  /** cylindrical path: start/end angle, signed shortest delta, start/end radius, z, corridor radius */
  a0: number; a1: number; da: number;
  r0: number; r1: number;
  z0: number; z1: number;
  rMid: number;
  /** smoothed view direction and the up the flight started with */
  dir: V3;
  up: V3;
  /** point to look at on arrival (station-local) */
  look: V3;
  /** arrival position (station-local) */
  target: V3;
}

export const newFly = (): FlyState => ({
  on: false, t: 0, dur: 3, a0: 0, a1: 0, da: 0, r0: 0, r1: 0, z0: 0, z1: 0, rMid: 20,
  dir: [0, 0, -1], up: [0, 1, 0], look: [0, 0, 0], target: [0, 0, 0],
});

/** Start a flight from the pose's current position to `target`, looking at `look` on arrival (station-local).
    The path is cylindrical: the angle takes the shortest arc, the radius bulges towards a corridor between the
    tube and the buildings (CORE_CONFIG.FLY.corridor), so it is clear of obstacles BY CONSTRUCTION. */
export function startFly(
  fly: FlyState, pose: CameraPose, target: V3, look: V3,
  F: FlyConfig = CORE_CONFIG.FLY, S: StationConfig = DEFAULT_STATION,
): FlyState {
  const p0 = pose.pos;
  vec3.copy(target, fly.target);
  vec3.copy(look, fly.look);

  fly.a0 = Math.atan2(p0[0], p0[1]);
  fly.a1 = Math.atan2(target[0], target[1]);
  fly.da = ((fly.a1 - fly.a0 + Math.PI) % TAU + TAU) % TAU - Math.PI;
  fly.r0 = Math.hypot(p0[0], p0[1]);
  fly.r1 = Math.hypot(target[0], target[1]);
  fly.z0 = p0[2]; fly.z1 = target[2];
  fly.rMid = clamp(Math.min(fly.r0, fly.r1, S.R * F.corridor), S.sunKeep + FLY_TUBE_PAD, S.R - FLY_HULL_PAD);

  /* duration follows the real path length, not the chord */
  const arc = Math.abs(fly.da) * (fly.r0 + fly.r1) * 0.5;
  const len = Math.hypot(arc, fly.z1 - fly.z0, fly.r1 - fly.r0);
  fly.dur = clamp(F.min + len / F.speed, F.min, F.max);

  /* the gaze starts where the camera looks now, otherwise the first frame snaps towards the destination */
  forward(pose.quat, fly.dir);
  cameraUp(pose.quat, fly.up);
  vec3.normalize(fly.up, fly.up);

  fly.t = 0; fly.on = true;
  return fly;
}

/** Point of the path at parameter e (may leave [0, 1]: the gaze looks ahead along the course). */
export function flyPoint(fly: FlyState, e: number, out: V3 = [0, 0, 0], F: FlyConfig = CORE_CONFIG.FLY): V3 {
  const bump = Math.sin(Math.PI * clamp(e, 0, 1));         // 0 at the ends, 1 in the middle
  const a = fly.a0 + fly.da * e;
  const rLine = lerp(fly.r0, fly.r1, e);
  const r = rLine + (fly.rMid - rLine) * bump * F.pull;
  return vec3.set(Math.sin(a) * r, Math.cos(a) * r, lerp(fly.z0, fly.z1, e), out) as V3;
}

const _p: V3 = [0, 0, 0], _ahead: V3 = [0, 0, 0], _look: V3 = [0, 0, 0], _dirA: V3 = [0, 0, 0], _dirB: V3 = [0, 0, 0];
const _upA: V3 = [0, 0, 0], _upB: V3 = [0, 0, 0], _aim: V3 = [0, 0, 0];

/** Advance a flight by dt and write the pose. Returns true on the frame it arrives (then the camera is levelled
    unless `freeFly`). The look direction interpolates DIRECTIONS (not points: a point travelling from ahead to
    behind passes through the camera and flips the gaze), is chased exponentially and pitch-limited. */
export function stepFly(
  fly: FlyState, pose: CameraPose, dt: number, freeFly = false, F: FlyConfig = CORE_CONFIG.FLY,
): boolean {
  if (!fly.on) return false;
  fly.t = Math.min(1, fly.t + dt / fly.dur);
  const e = easeInOut(fly.t);

  flyPoint(fly, e, _p, F);
  vec3.copy(_p, pose.pos);

  flyPoint(fly, e + F.lead, _ahead, F);
  vec3.sub(_ahead, _p, _dirA);
  if (vec3.lengthSq(_dirA) < 1e-6) vec3.copy(fly.dir, _dirA); else vec3.normalize(_dirA, _dirA);
  vec3.sub(fly.look, _p, _dirB);
  vec3.normalize(_dirB, _dirB);
  stationUp(_p, _upA);
  /* the start up blends into the station up: near the axis the latter turns eight degrees per unit of path */
  vec3.lerp(fly.up, _upA, smoothstep01(FLY_UP_FROM, 1, e), _upB);
  vec3.normalize(_upB, _upB);
  turnToward(_dirA, _dirB, smoothstep01(F.turnFrom, 1, e), _upA, _dirA);
  turnToward(fly.dir, _dirA, 1 - Math.exp(-dt * F.turn), _upA, fly.dir);
  clampPitch(fly.dir, _upB, Math.sin(F.pitchMax * Math.PI / 180));

  vec3.addScaled(_p, fly.dir, FLY_AIM_DIST, _aim);
  aimAt(_p, _aim, _upB, pose.quat);

  if (fly.t >= 1) {
    fly.on = false;
    levelCamera(pose, freeFly);
    return true;
  }
  return false;
}

export const cancelFly = (fly: FlyState): void => { fly.on = false; };

/** Jump to view `tp` ([theta deg, r, z]) at once and aim at `look` (legacy goTo(i, instant)). */
export function goToInstant(pose: CameraPose, pos: ArrayLike<number>, look: ArrayLike<number>, freeFly = false): CameraPose {
  tpVec(pos, pose.pos);
  stationUp(pose.pos, _upA);
  aimAt(pose.pos, tpVec(look, _look), _upA, pose.quat);
  return levelCamera(pose, freeFly);
}

/* ═══ tour ═════════════════════════════════════════════════════════════════ */

export interface TourState {
  on: boolean;
  /** index of the current viewpoint */
  idx: number;
  /** seconds left of the hold */
  wait: number;
}
export const newTour = (): TourState => ({ on: false, idx: 0, wait: 0 });

/** What the adapter should do after a tour step. */
export type TourAction =
  | { type: 'none' }
  | { type: 'hideCaption' }
  | { type: 'caption'; idx: number }
  | { type: 'goTo'; idx: number };

const NONE: TourAction = { type: 'none' };

/** Start the tour at viewpoint 0: the caller flies there (action goTo 0 is returned for convenience). */
export function startTour(tour: TourState, hold: number = CORE_CONFIG.TOUR_HOLD): TourAction {
  tour.on = true; tour.idx = 0; tour.wait = hold;
  return { type: 'goTo', idx: 0 };
}
export const stopTour = (tour: TourState): TourAction => { tour.on = false; return { type: 'hideCaption' }; };

/** Advance the tour: it waits `hold` seconds at each viewpoint (the caption is shown at the start of the hold),
    then asks for the next flight. While flying the timer is frozen and the caption hidden. */
export function stepTour(
  tour: TourState, dt: number, flying: boolean,
  count: number = CORE_CONFIG.TP.length, hold: number = CORE_CONFIG.TOUR_HOLD,
): TourAction {
  if (!tour.on) return NONE;
  if (flying) return { type: 'hideCaption' };
  let action: TourAction = NONE;
  if (tour.wait === hold) action = { type: 'caption', idx: tour.idx };
  tour.wait -= dt;
  if (tour.wait <= 0) {
    tour.idx = (tour.idx + 1) % count;
    tour.wait = hold;
    action = { type: 'goTo', idx: tour.idx };
  }
  return action;
}

/* ═══ monorail ride ════════════════════════════════════════════════════════ */

/** Pose of cabin `k` in station-local space: writes the seat position and the travel direction; false if the
    cabin does not exist. The adapter backs it with SceneDesc.dynamics.lifts. */
export type SeatFn = (k: number, outPos: V3, outDir: V3) => boolean;

export interface RideState {
  on: boolean;
  car: number;
}
export const newRide = (): RideState => ({ on: false, car: 0 });

/** Board the cabin nearest to the camera (so the jump does not look like a teleport). */
export function startRide(ride: RideState, pose: CameraPose, seat: SeatFn, count: number): RideState {
  ride.on = count > 0;
  if (!ride.on) return ride;
  const p: V3 = [0, 0, 0], d: V3 = [0, 0, 0];
  let best = 0, bestD = Infinity;
  for (let k = 0; k < count; k++) {
    if (!seat(k, p, d)) continue;
    const dd = vec3.distanceSq(p, pose.pos);
    if (dd < bestD) { bestD = dd; best = k; }
  }
  ride.car = best;
  return ride;
}

const _seat: V3 = [0, 0, 0], _seatDir: V3 = [0, 0, 0];

/** The cabin carries the camera; the gaze stays with the player. `eye` is the passenger's eye above the cabin
    floor (CORE_CONFIG.LIFTCAR.eye), added along +Y like the legacy updateRide. Ends the ride (returns false) if
    the cabin vanished. */
export function stepRide(ride: RideState, pose: CameraPose, seat: SeatFn, eye: number = CORE_CONFIG.LIFTCAR.eye): boolean {
  if (!ride.on) return false;
  if (!seat(ride.car, _seat, _seatDir)) { ride.on = false; return false; }
  _seat[1] += eye;
  vec3.copy(_seat, pose.pos);
  return true;
}
export const stopRide = (ride: RideState): void => { ride.on = false; };
