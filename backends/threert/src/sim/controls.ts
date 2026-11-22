/* ═══════════════════════════════════════════════════════════════════════════
   Controls: ThreeRT frame input -> camera motion with the legacy feel (js/controls.js updateControls).

   The adapter hands over `f.input` (a structural subset is declared below, so this file imports nothing from
   @threert/*). ThreeRT already turns mouse counts into radians (at 0.0025 rad/count x the player's sensitivity),
   so `look` is scaled by LOOK_GAIN to land on the legacy LOOK_SENS; `move` is the WASD / stick vector.
   ═══════════════════════════════════════════════════════════════════════════ */

import { clamp } from '../../../../core/math/scalar.ts';
import {
  KEYS, LOOK_GAIN, SPEED_BASE, SPEED_BOOST, SPEED_MAX, SPEED_MIN, SPEED_WHEEL_STEP, STICK_DEAD,
} from './constants.ts';
import { applyLook, moveLocal, type CameraPose } from './camera.ts';
import { collide, DEFAULT_COLLIDE, type CollideConfig, type Hill } from './collide.ts';

/** The part of ThreeRT's `f.input` (gameplay/src/input.ts) that the sim reads. */
export interface InputLike {
  /** x right, y forward, each -1..1, never longer than 1 */
  readonly move: { readonly x: number; readonly y: number };
  /** radians this frame: right and down are positive */
  readonly look: { readonly dx: number; readonly dy: number };
  /** wheel notches this frame, away from the player is positive */
  readonly wheel: number;
  down(key: string): boolean;
  pressed(key: string): boolean;
}

/** Persistent control state. */
export interface ControlState {
  /** false: the horizon follows the cylinder (station-up); true: ordinary first-person flight */
  freeFly: boolean;
  /** base speed, station units / s */
  speed: number;
}
export const newControlState = (freeFly = false): ControlState => ({ freeFly, speed: SPEED_BASE });

/** One frame of input, normalised. */
export interface Intent {
  /** strafe right */
  fx: number;
  /** up (towards the axis) */
  fy: number;
  /** forward */
  fz: number;
  /** yaw / pitch to apply, radians (left / up positive) */
  dYaw: number;
  dPitch: number;
  boost: boolean;
  /** base-speed change in notches */
  wheel: number;
  /** Space pressed: cancel a flight / tour / ride */
  cancel: boolean;
  /** toggle free-fly pressed */
  toggleFly: boolean;
}

const axis = (input: InputLike, neg: string, pos: string): number =>
  (input.down(pos) ? 1 : 0) - (input.down(neg) ? 1 : 0);

/** Stick dead zone, as in js/controls.js: below STICK_DEAD nothing, then rescaled to 0..1. */
export function stickRemap(x: number, y: number, out: { x: number; y: number } = { x: 0, y: 0 }): { x: number; y: number } {
  const len = Math.hypot(x, y);
  if (len > STICK_DEAD) {
    const g = (len - STICK_DEAD) / (1 - STICK_DEAD) / len;
    out.x = x * g; out.y = y * g;
  } else { out.x = 0; out.y = 0; }
  return out;
}

/** Read one frame of ThreeRT input into an Intent. */
export function readIntent(input: InputLike, out: Intent = emptyIntent()): Intent {
  const m = stickRemap(input.move.x, input.move.y);
  out.fx = m.x + axis(input, KEYS.arrowLeft, KEYS.arrowRight);
  out.fz = m.y + axis(input, KEYS.arrowDown, KEYS.arrowUp);
  out.fy = axis(input, KEYS.down, KEYS.up);
  out.dYaw = -input.look.dx * LOOK_GAIN;
  out.dPitch = -input.look.dy * LOOK_GAIN;
  out.boost = input.down(KEYS.boost);
  out.wheel = input.wheel;
  out.cancel = input.pressed(KEYS.cancel);
  out.toggleFly = input.pressed(KEYS.toggleFly);
  return out;
}
export const emptyIntent = (): Intent => ({
  fx: 0, fy: 0, fz: 0, dYaw: 0, dPitch: 0, boost: false, wheel: 0, cancel: false, toggleFly: false,
});

/** True if the intent would move the camera or turn it (used to cancel automatic modes). */
export const hasMotion = (i: Intent): boolean => !!(i.fx || i.fy || i.fz || i.dYaw || i.dPitch);

/** Apply one frame of an Intent to the pose: speed/mode changes, look (pitch clamped, then levelled), move at
    speed x boost x dt, then analytic collision. Returns true if the camera moved. */
export function stepControls(
  pose: CameraPose, st: ControlState, intent: Intent, dt: number,
  hills: readonly Hill[] = [], cfg: CollideConfig = DEFAULT_COLLIDE,
): boolean {
  if (intent.toggleFly) st.freeFly = !st.freeFly;
  if (intent.wheel) st.speed = clamp(st.speed + intent.wheel * SPEED_WHEEL_STEP, SPEED_MIN, SPEED_MAX);

  applyLook(pose, intent.dYaw, intent.dPitch, st.freeFly);

  const { fx, fy, fz } = intent;
  if (!fx && !fy && !fz) return false;
  const dist = st.speed * (intent.boost ? SPEED_BOOST : 1) * dt;
  moveLocal(pose, fx, fy, fz, dist, st.freeFly);
  collide(pose.pos, hills, cfg);
  return true;
}

/** Convenience: read + step. */
export function stepInput(
  pose: CameraPose, st: ControlState, input: InputLike, dt: number,
  hills: readonly Hill[] = [], cfg: CollideConfig = DEFAULT_COLLIDE,
): Intent {
  const intent = readIntent(input);
  stepControls(pose, st, intent, dt, hills, cfg);
  return intent;
}
