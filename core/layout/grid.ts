/* ═══════════════════════════════════════════════════════════════════════════
   Spatial grid of reserved discs on the hull (θ wraps, z bounded).

   Replaces the legacy O(n²) `fits` scan over the `taken` list. The decision
   is IDENTICAL: the per-pair test is the same expression
       hypot(angGap(t, o.t)·R, z − o.z) < r + o.r
   and the grid only skips discs that cannot possibly satisfy it (their
   cells lie beyond r + maxR in both arc and z, with a whole-cell margin so
   float rounding at cell borders can never drop a candidate). Any-of is
   order-independent, so the visiting order does not matter.
   ═══════════════════════════════════════════════════════════════════════════ */

import { TAU } from '../math/scalar.ts';
import { angGap } from './zones.ts';

export class DiscGrid {
  readonly R: number;
  private readonly nT: number;
  private readonly nZ: number;
  private readonly cellA: number;   // angular cell size, rad
  private readonly cellZ: number;
  private readonly z0: number;
  private readonly cells: number[][];
  /** flat storage: t, z, r per disc */
  private readonly data: number[] = [];
  private maxR = 0;

  /** zMin..zMax: axial extent covered by the cells (outside it clamps to the end rows) */
  constructor(R: number, zMin: number, zMax: number, cell = 4) {
    this.R = R;
    this.nT = Math.max(1, Math.floor(TAU * R / cell));
    this.cellA = TAU / this.nT;
    this.nZ = Math.max(1, Math.ceil((zMax - zMin) / cell));
    this.cellZ = (zMax - zMin) / this.nZ;
    this.z0 = zMin;
    this.cells = [];
    for (let k = 0; k < this.nT * this.nZ; k++) this.cells.push([]);
  }

  get size(): number { return this.data.length / 3; }

  private col(t: number): number {
    const w = ((t % TAU) + TAU) % TAU;
    return Math.min(this.nT - 1, Math.floor(w / this.cellA));
  }

  private row(z: number): number {
    const j = Math.floor((z - this.z0) / this.cellZ);
    return j < 0 ? 0 : j >= this.nZ ? this.nZ - 1 : j;
  }

  add(t: number, z: number, r: number): void {
    const id = this.data.length / 3;
    this.data.push(t, z, r);
    if (r > this.maxR) this.maxR = r;
    this.cells[this.row(z) * this.nT + this.col(t)].push(id);
  }

  /** True when the disc (t, z, r) overlaps no stored disc (legacy `fits`). */
  fits(t: number, z: number, r: number): boolean {
    const reach = r + this.maxR;
    const D = this.data, R = this.R;
    /* angular reach in cells (+1 margin); the whole ring if it wraps over */
    const spanA = Math.ceil(reach / R / this.cellA) + 1;
    const c0 = this.col(t);
    const fullRing = 2 * spanA + 1 >= this.nT;
    const ca = fullRing ? 0 : c0 - spanA, cb = fullRing ? this.nT - 1 : c0 + spanA;
    const spanZ = Math.ceil(reach / this.cellZ) + 1;
    const r0 = this.row(z);
    const ra = Math.max(0, r0 - spanZ), rb = Math.min(this.nZ - 1, r0 + spanZ);
    for (let j = ra; j <= rb; j++) {
      const base = j * this.nT;
      for (let c = ca; c <= cb; c++) {
        const cell = this.cells[base + ((c % this.nT) + this.nT) % this.nT];
        for (let k = 0; k < cell.length; k++) {
          const o = cell[k] * 3;
          if (Math.hypot(angGap(t, D[o]) * R, z - D[o + 1]) < r + D[o + 2]) return false;
        }
      }
    }
    return true;
  }

  /** Reference O(n) scan — same answer as `fits`; for tests. */
  fitsBrute(t: number, z: number, r: number): boolean {
    const D = this.data, R = this.R;
    for (let o = 0; o < D.length; o += 3) {
      if (Math.hypot(angGap(t, D[o]) * R, z - D[o + 1]) < r + D[o + 2]) return false;
    }
    return true;
  }
}
