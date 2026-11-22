/* ═══════════════════════════════════════════════════════════════════════════
   Biome zones by station angle θ — port of js/util.js `zoneAt` and the
   angle helpers used by js/world.js placement. Same formulas, same order of
   operations (the placement decisions depend on exact float behaviour at
   sector borders).
   ═══════════════════════════════════════════════════════════════════════════ */

import { CORE_CONFIG } from '../config/index.ts';
import { D2R, TAU, inRanges } from '../math/scalar.ts';

export type ZoneId = 'river' | 'city' | 'field' | 'park' | 'edge';
export type SectorKind = keyof typeof CORE_CONFIG.SECT;

/** Zone at angle θ in DEGREES (any range). Priority: river > city > field > park > edge. */
export function zoneAt(deg: number): ZoneId {
  const S = CORE_CONFIG.SECT;
  deg = ((deg % 360) + 360) % 360;
  if (inRanges(deg, S.rivers)) return 'river';
  if (inRanges(deg, S.cities)) return 'city';
  if (inRanges(deg, S.fields)) return 'field';
  if (inRanges(deg, S.parks)) return 'park';
  return 'edge';
}

/** Signed shortest angular difference a − b in (−π, π] (legacy `((a-b+π)%τ+τ)%τ-π`). */
export const angDiff = (a: number, b: number): number => ((a - b + Math.PI) % TAU + TAU) % TAU - Math.PI;

/** |shortest angular difference| (legacy `angGap`). */
export const angGap = (a: number, b: number): number => Math.abs(((a - b + Math.PI) % TAU + TAU) % TAU - Math.PI);

/** Angle wrapped into [0, τ) (legacy instance bucketing). */
export const wrapAngle = (t: number): number => ((t % TAU) + TAU) % TAU;

/**
 * Does the angular span of a disc of radius r at angle t (rad) overlap a
 * sector of one of the given kinds? Port of the `spanHits` closure in
 * buildWorld (compares whole intervals, with wrap-around).
 */
export function spanHits(t: number, r: number, R: number, kinds: readonly SectorKind[]): boolean {
  const half = (r / R) / D2R;
  const c = ((t / D2R) % 360 + 360) % 360;
  for (const kind of kinds) {
    for (const [a, b] of CORE_CONFIG.SECT[kind]) {
      for (const off of [-360, 0, 360]) {
        if (c + half >= a + off && c - half <= b + off) return true;
      }
    }
  }
  return false;
}
