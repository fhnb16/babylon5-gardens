/* ═══════════════════════════════════════════════════════════════════════════
   Analytic camera collision. No BVH, no raycasts: the native backend has no CPU triangle soup to ray-cast, and
   the station is a cylinder with a tube on its axis, so the walls are formulas.

   Keep-in volume (station-local, station units):
     tubeKeep  <=  r  <=  min(R - HULL_MARGIN, terrainRadius(theta, z) - COLLIDE.radius)
     -(L/2 - END_MARGIN)  <=  z  <=  L/2 - END_MARGIN
   with r = hypot(x, y), theta = atan2(x, y).

   terrainRadiusAt() reproduces the hull the legacy js/world.js displaceHills() builds: the cylinder wall at R is
   pushed towards the axis by a smooth bell (1 - u^2)^2 per hill (u = d / r, an oval when `aspect` is set), ponds
   push the other way and are shallower (dipDepth). Buildings and trees are NOT part of this volume (the legacy
   BVH ray also hit them); pass `extra` to collide() if a backend wants to add its own checks.
   ═══════════════════════════════════════════════════════════════════════════ */

import { CORE_CONFIG } from '../../../../core/config/index.ts';
import { TAU } from '../../../../core/math/scalar.ts';
import { END_MARGIN, HULL_MARGIN } from './constants.ts';

/** One hill or pond. Same data as SceneDesc.HillDesc plus the oval rotation. */
export interface Hill {
  /** centre angle, rad, theta = atan2(x, y) */
  theta: number;
  z: number;
  /** radius on the surface */
  r: number;
  /** signed displacement at the centre towards the axis: > 0 hill, < 0 pond (the dip depth already applied) */
  rise: number;
  /** oval stretch (legacy `ax`): undefined or 1 = circle */
  aspect?: number;
  /** oval rotation, rad (legacy `rot`) */
  rot?: number;
}

/** js/world.js hill record -> Hill. `h` is the hill height, a pond sinks by h * dipDepth. */
export interface LegacyHill { t: number; z: number; r: number; h: number; dip: boolean; ax?: number; rot?: number }
export function hillsFromLegacy(list: readonly LegacyHill[], dipDepth: number = CORE_CONFIG.HILL.dipDepth): Hill[] {
  return list.map(h => ({
    theta: h.t, z: h.z, r: h.r,
    rise: h.dip ? -h.h * dipDepth : h.h,
    aspect: h.ax, rot: h.rot,
  }));
}

/** Displacement of the wall towards the axis at (theta, z): positive on a hill, negative in a pond. */
export function hillLift(theta: number, z: number, hills: readonly Hill[], R: number = CORE_CONFIG.R): number {
  let lift = 0;
  for (const hl of hills) {
    const dt = ((theta - hl.theta + Math.PI) % TAU + TAU) % TAU - Math.PI;
    let dx = dt * R, dz = z - hl.z;
    if (hl.aspect && hl.aspect !== 1) {
      const cs = Math.cos(hl.rot ?? 0), sn = Math.sin(hl.rot ?? 0);
      const px = dx * cs + dz * sn, py = -dx * sn + dz * cs;
      dx = px / hl.aspect; dz = py * hl.aspect;
    }
    const d = Math.hypot(dx, dz);
    if (d >= hl.r) continue;
    const u = d / hl.r;
    const f = (1 - u * u) * (1 - u * u);
    lift += hl.rise * f;
  }
  return lift;
}

/** Distance of the hull surface from the axis at (theta, z). R on flat ground, less on a hill, more in a pond. */
export function terrainRadiusAt(theta: number, z: number, hills: readonly Hill[], R: number = CORE_CONFIG.R): number {
  return R - hillLift(theta, z, hills, R);
}

export interface CollideConfig {
  R: number;
  L: number;
  /** minimum radius: the tube is solid (SUN.r + SUN.clear) */
  tubeKeep: number;
  /** stay this far inside the nominal hull radius */
  hullMargin: number;
  /** stay this far above the terrain (legacy COLLIDE.radius) */
  terrainMargin: number;
  /** stay this far from the end caps */
  endMargin: number;
}

export const DEFAULT_COLLIDE: CollideConfig = {
  R: CORE_CONFIG.R,
  L: CORE_CONFIG.L,
  tubeKeep: CORE_CONFIG.SUN.r + CORE_CONFIG.SUN.clear,
  hullMargin: HULL_MARGIN,
  terrainMargin: CORE_CONFIG.COLLIDE.radius,
  endMargin: END_MARGIN,
};

/** Largest allowed radius at (theta, z). */
export function maxRadiusAt(theta: number, z: number, hills: readonly Hill[], cfg: CollideConfig = DEFAULT_COLLIDE): number {
  return Math.min(cfg.R - cfg.hullMargin, terrainRadiusAt(theta, z, hills, cfg.R) - cfg.terrainMargin);
}

/** Push `pos` (in place) back inside the keep-in volume. Order: end caps, hull/terrain, then the tube keep-out
    last so the inner bound is exact (on the axis itself the position is moved sideways to +x).
    `extra(pos)` runs afterwards for backend-specific obstacles. Returns true if the position changed. */
export function collide(
  pos: number[], hills: readonly Hill[] = [], cfg: CollideConfig = DEFAULT_COLLIDE,
  extra?: (pos: number[]) => void,
): boolean {
  const x0 = pos[0], y0 = pos[1], z0 = pos[2];

  const zMax = cfg.L / 2 - cfg.endMargin;
  pos[2] = pos[2] < -zMax ? -zMax : pos[2] > zMax ? zMax : pos[2];

  let r = Math.hypot(pos[0], pos[1]);
  if (r > 1e-9) {
    const rMax = maxRadiusAt(Math.atan2(pos[0], pos[1]), pos[2], hills, cfg);
    if (r > rMax) {
      const f = rMax / r;
      pos[0] *= f; pos[1] *= f; r = rMax;
    }
  }
  if (r < cfg.tubeKeep) {
    if (r < 1e-4) { pos[0] = cfg.tubeKeep; pos[1] = 0; }
    else {
      const k = cfg.tubeKeep / r;
      pos[0] *= k; pos[1] *= k;
    }
  }

  if (extra) extra(pos);
  return pos[0] !== x0 || pos[1] !== y0 || pos[2] !== z0;
}
