/* ═══════════════════════════════════════════════════════════════════════════
   Ambience levels — pure port of the level functions of js/audio.js. The
   WebAudio synthesis stays in the app; these decide how loud each layer is
   at a point of the station, so they can be tested (and baked for ThreeRT)
   without an AudioContext.
   ═══════════════════════════════════════════════════════════════════════════ */

import { CORE_CONFIG } from '../config/index.ts';
import { clamp, D2R } from '../math/scalar.ts';
import { zoneAt } from '../layout/zones.ts';

/**
 * Flight speed at which the rush of air saturates (legacy CONFIG.SPEED_MAX,
 * a controls setting that is not part of CORE_CONFIG).
 */
export const SPEED_MAX_DEFAULT = 40;

export interface Field {
  /** angle θ = atan2(x, y), rad */
  t: number;
  /** distance from the axis */
  r: number;
  z: number;
  /** height above the hull floor (R − r) */
  alt: number;
}

const smooth = (a: number, b: number, x: number): number => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Station-local point → station coordinates. */
export function fieldAt(p: ArrayLike<number>): Field {
  const r = Math.hypot(p[0], p[1]);
  return { t: Math.atan2(p[0], p[1]), r, z: p[2], alt: CORE_CONFIG.R - r };
}

/** Arc distance (units) to the nearest river sector. */
function riverArc(tDeg: number): number {
  let best = Infinity;
  for (const [a, b] of CORE_CONFIG.SECT.rivers) {
    const d = tDeg < a ? a - tDeg : tDeg > b ? tDeg - b : 0;
    best = Math.min(best, Math.min(d, 360 - d));
  }
  return best * D2R * CORE_CONFIG.R;
}

/** Water babble: only near a river, by arc and by height. */
export function waterLevel(f: Field): number {
  const tDeg = ((f.t / D2R) % 360 + 360) % 360;
  const d = Math.hypot(riverArc(tDeg), f.alt);
  return 1 - smooth(CORE_CONFIG.AUDIO.waterNear, CORE_CONFIG.AUDIO.waterFar, d);
}

/** Wind: stronger near the ground in the open, plus the rush of flight. */
export function windLevel(f: Field, speed: number, speedMax = SPEED_MAX_DEFAULT): number {
  const open = 1 - smooth(3, 34, f.alt);
  const rush = clamp(speed / speedMax, 0, 1);
  return clamp(0.22 + 0.5 * open + 0.35 * rush, 0, 1);
}

/** Station hum: everywhere, louder near the axis machinery. */
export function humLevel(f: Field): number {
  return 0.42 + 0.58 * (1 - smooth(8, 46, f.r));
}

/** Birds: by day, near the ground, only where things grow. */
export function birdLevel(f: Field, dayMix: number): number {
  const zone = zoneAt(f.t / D2R);
  if (zone === 'city' || zone === 'river') return 0;
  const near = 1 - smooth(4, 30, f.alt);
  return near * clamp(dayMix, 0, 1) * (zone === 'park' ? 1 : 0.55);
}

/** All four layer levels × their CORE_CONFIG.AUDIO mix gains (what updateAudio ramps towards). */
export function ambienceTargets(p: ArrayLike<number>, speed: number, dayMix: number, speedMax = SPEED_MAX_DEFAULT):
  { wind: number; water: number; hum: number; birds: number } {
  const f = fieldAt(p);
  const A = CORE_CONFIG.AUDIO;
  return {
    wind: windLevel(f, speed, speedMax) * A.wind,
    water: waterLevel(f) * A.water,
    hum: humLevel(f) * A.hum,
    birds: birdLevel(f, dayMix)
  };
}
