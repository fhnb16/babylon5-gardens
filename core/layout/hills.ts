/* ═══════════════════════════════════════════════════════════════════════════
   Hills, dips and ponds — port of js/world.js `displaceHills` (placement +
   hull displacement) and the `relief` / `inPond` helpers of buildWorld.
   rnd order is preserved exactly: per attempt rad, t, z, then (only if the
   spot is clear) dip, then (only if accepted) rise, aspect, rotation.
   ═══════════════════════════════════════════════════════════════════════════ */

import { CORE_CONFIG } from '../config/index.ts';
import type { Rng } from '../rng.ts';
import { TAU } from '../math/scalar.ts';
import type { MeshData } from '../geometry/mesh.ts';
import { zoneAt } from './zones.ts';

/** Legacy hill record (exactly what buildWorld returns as `hills`). */
export interface Hill {
  /** angle, rad */
  t: number;
  z: number;
  r: number;
  /** height (positive); dips sink by h · HILL.dipDepth */
  h: number;
  dip: boolean;
  /** oval aspect and rotation (applied to every hill, not only ponds) */
  ax: number;
  rot: number;
}

/** Legacy pond record (water inside a dip). */
export interface Pond {
  t: number;
  z: number;
  r: number;
  ax: number;
  rot: number;
}

/** Truss feet on the hull: where the support columns meet the floor. */
export function trussFeet(): { t: number; z: number }[] {
  const A = CORE_CONFIG.AXIS;
  const feet: { t: number; z: number }[] = [];
  for (const sz of A.spars) {
    for (let k = 0; k < A.sparArms; k++) {
      feet.push({ t: (k / A.sparArms) * TAU + A.sparAngle * Math.PI / 180, z: sz });
    }
  }
  return feet;
}

/** Place hills and dips (legacy displaceHills, placement part). `rnd` = mulberry32(seed + 404). */
export function placeHills(rnd: Rng, R: number, L: number): Hill[] {
  const H = CORE_CONFIG.HILL;
  const hills: Hill[] = [];
  const want = CORE_CONFIG.COUNT.hills.reduce((a, b) => a + b, 0);
  const A = CORE_CONFIG.AXIS;
  const feet = trussFeet();
  const footClear = A.baseR + H.footGap;

  const clearOf = (t: number, z: number, rad: number): boolean => {
    const half = rad / R;
    for (let d = -half; d <= half + 1e-6; d += half / 8) {
      const deg = (((t + d) / TAU * 360) % 360 + 360) % 360;
      const zone = zoneAt(deg);
      if (zone === 'river' || zone === 'city') return false;
    }
    for (const f of feet) {
      const dt = ((t - f.t + Math.PI) % TAU + TAU) % TAU - Math.PI;
      if (Math.hypot(dt * R, z - f.z) < rad + footClear) return false;
    }
    return true;
  };

  for (let i = 0, guard = 0; i < want && guard < want * 60; guard++) {
    const rad = H.r[0] + rnd() * (H.r[1] - H.r[0]);
    const t = rnd() * TAU;
    const z = (rnd() - 0.5) * (L - rad * 4 - H.endGap * 2);
    if (!clearOf(t, z, rad)) continue;
    const dip = rnd() < H.pondChance;
    if (dip) {
      let clash = false;
      for (const o of hills) {
        if (!o.dip) continue;
        const dt = ((t - o.t + Math.PI) % TAU + TAU) % TAU - Math.PI;
        if (Math.hypot(dt * R, z - o.z) < (rad + o.r) * H.pondGap) { clash = true; break; }
      }
      if (clash) continue;
    }
    const h = rad * (H.rise[0] + rnd() * (H.rise[1] - H.rise[0]));
    const ax = H.pondAspect[0] + rnd() * (H.pondAspect[1] - H.pondAspect[0]);
    const rot = rnd() * TAU;
    hills.push({ t, z, r: rad, h, dip, ax, rot });
    i++;
  }
  return hills;
}

/**
 * Push hull vertices towards the axis by the hill bells. `mesh` is the
 * THREE-style cylinder along +Y BEFORE the rotateX(90°) that lays it along
 * Z — the angle is computed in the FINAL frame: t = atan2(x, −z), z = y.
 * Positions are written back through the Float32Array (as setXYZ).
 */
export function displaceHull(mesh: MeshData, hills: readonly Hill[], R: number): void {
  const H = CORE_CONFIG.HILL;
  const p = mesh.position;
  const n = p.length / 3;
  /* precomputed per-hill constants (same values the legacy loop recomputed) */
  const cs = hills.map(h => Math.cos(h.rot)), sn = hills.map(h => Math.sin(h.rot));
  for (let k = 0; k < n; k++) {
    const vx = p[3 * k], vy = p[3 * k + 1], vz = p[3 * k + 2];
    const t = Math.atan2(vx, -vz);
    const z = vy;
    let lift = 0;
    for (let i = 0; i < hills.length; i++) {
      const hl = hills[i];
      const dt = ((t - hl.t + Math.PI) % TAU + TAU) % TAU - Math.PI;
      let dx = dt * R, dz = z - hl.z;
      if (hl.ax && hl.ax !== 1) {
        const px = dx * cs[i] + dz * sn[i], py = -dx * sn[i] + dz * cs[i];
        dx = px / hl.ax; dz = py * hl.ax;
      }
      const d = Math.hypot(dx, dz);
      if (d >= hl.r) continue;
      const u = d / hl.r;
      const f = (1 - u * u) * (1 - u * u);
      lift += hl.dip ? -hl.h * H.dipDepth * f : hl.h * f;
    }
    if (lift !== 0) {
      const rr = Math.hypot(vx, vz);
      const k2 = (rr - lift) / rr;
      p[3 * k] = vx * k2; p[3 * k + 1] = vy; p[3 * k + 2] = vz * k2;
    }
  }
}

/** Water in the dips (legacy `ponds`). */
export function pondsOf(hills: readonly Hill[]): Pond[] {
  return hills.filter(h => h.dip)
    .map(h => ({ t: h.t, z: h.z, r: h.r * 0.62, ax: h.ax || 1, rot: h.rot || 0 }));
}

/** Relief list [θ, z, r, signed rise] as buildWorld builds it for `relief`. */
export type ReliefHill = [number, number, number, number];

export function reliefList(hills: readonly Hill[]): ReliefHill[] {
  const dd = CORE_CONFIG.HILL.dipDepth;
  return hills.map(h => [h.t, h.z, h.r, h.dip ? -h.h * dd : h.h] as ReliefHill);
}

/**
 * Height of the hill dome at (t, z) — same bell as the hull displacement but
 * on CIRCLES (legacy `relief` ignores the oval; kept for parity).
 */
export function reliefAt(list: readonly ReliefHill[], t: number, z: number, R: number): number {
  let up = 0;
  for (let k = 0; k < list.length; k++) {
    const [ht, hz, hr, hh] = list[k];
    const d = Math.hypot(Math.abs(((t - ht + Math.PI) % TAU + TAU) % TAU - Math.PI) * R, z - hz);
    if (d >= hr) continue;
    const u = d / hr, f = (1 - u * u) * (1 - u * u);
    up += hh * f;
  }
  return up;
}

/** Is a disc (t, z, r) inside a pond bowl incl. shore margin (legacy `inPond`)? */
export function inPond(ponds: readonly Pond[], t: number, z: number, r: number, R: number): boolean {
  const H = CORE_CONFIG.HILL;
  for (const pd of ponds) {
    const dt0 = ((t - pd.t + Math.PI) % TAU + TAU) % TAU - Math.PI;
    let dx = dt0 * R, dz = z - pd.z;
    if (pd.ax && pd.ax !== 1) {
      const cs = Math.cos(pd.rot), sn = Math.sin(pd.rot);
      const px = dx * cs + dz * sn, py = -dx * sn + dz * cs;
      dx = px / pd.ax; dz = py * pd.ax;
    }
    if (Math.hypot(dx, dz) < pd.r / H.pondFill + r + H.shore) return true;
  }
  return false;
}
