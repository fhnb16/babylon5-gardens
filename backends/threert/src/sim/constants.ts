/* ═══════════════════════════════════════════════════════════════════════════
   Camera / controls constants that are NOT in CORE_CONFIG.

   core/config/index.ts deliberately leaves app concerns (input feel, UI) in the legacy js/config.js. The
   native backend needs a few of them, so they are copied here 1:1. If js/config.js changes, change this file
   (test/sim.test.ts compares them with the legacy file).
   Everything is in STATION units (1 unit = 1 m in the ThreeRT scene while ENGINE_M_PER_UNIT = 1).
   ═══════════════════════════════════════════════════════════════════════════ */

/* js/config.js lines 260-262 */
export const SPEED_BASE = 12;
export const SPEED_MIN = 5;
export const SPEED_MAX = 40;
export const SPEED_BOOST = 3;
/** mobile turtle / rabbit buttons (unused by the desktop client, kept for parity) */
export const SPEED_TURTLE = 8;
export const SPEED_RABBIT = 26;
/** js/config.js LOOK_SENS, radians per mouse count */
export const LOOK_SENS = 0.0022;
/** js/config.js STICK_DEAD: dead zone of a move stick, 0..1 */
export const STICK_DEAD = 0.12;

/** One wheel notch changes the base speed by this much (js/controls.js: `speed - sign(deltaY) * 2`). */
export const SPEED_WHEEL_STEP = 2;

/** ThreeRT converts mouse counts to radians at 0.0025 rad/count x the player's sensitivity (spike row i).
    Multiplying `input.look` by this gain reproduces the legacy LOOK_SENS feel at sensitivity 1. */
export const THREERT_RAD_PER_COUNT = 0.0025;
export const LOOK_GAIN = LOOK_SENS / THREERT_RAD_PER_COUNT;

/** Pitch limit around the "up" axis: sin(84 deg). At 89 deg the right vector is 0.017 long and the basis
    shakes near the zenith (js/controls.js SIN_MAX). */
export const SIN_PITCH_MAX = Math.sin(84 * Math.PI / 180);

/** js/controls.js: the camera is held this far inside the hull (R - 1.2) ... */
export const HULL_MARGIN = 1.2;
/** ... and this far from the end caps (L/2 - 2). */
export const END_MARGIN = 2;

/** Fly path: the corridor radius never goes closer to the tube than SUN.r + SUN.clear + this, and never
    farther than R - this (js/main.js goTo). */
export const FLY_TUBE_PAD = 2;
export const FLY_HULL_PAD = 8;
/** js/main.js updateFly: station-up blends in from this fraction of the path ... */
export const FLY_UP_FROM = 0.2;
/** ... and the look target of the aim is this far ahead (test.mjs 3h21 uses 60). */
export const FLY_AIM_DIST = 60;

/** ThreeRT key names (US layout, spike row i). One place to adapt if the client renames them. */
export const KEYS = {
  up: 'R',
  down: 'F',
  boost: 'Shift',
  arrowUp: 'ArrowUp',
  arrowDown: 'ArrowDown',
  arrowLeft: 'ArrowLeft',
  arrowRight: 'ArrowRight',
  /** new in the ThreeRT build: skip/cancel an automatic flight, tour or ride (legacy: tap during flight) */
  cancel: 'Space',
  /** new in the ThreeRT build: toggle free-fly <-> station-up (legacy: a settings switch) */
  toggleFly: 'G',
} as const;
