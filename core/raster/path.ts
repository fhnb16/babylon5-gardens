/* ═══════════════════════════════════════════════════════════════════════════
   2D affine matrices and path building.

   Like Canvas2D, points are transformed by the CURRENT transform when they
   are added, so a path built under one transform and filled under another
   keeps its original placement. Curves (quadratic/cubic Béziers, arcs,
   rotated ellipses) are flattened at build time in DEVICE space with a
   tolerance in pixels, so the polygon density follows the on-screen size.
   ═══════════════════════════════════════════════════════════════════════════ */

/** [a, b, c, d, e, f]: x' = a*x + c*y + e, y' = b*x + d*y + f (DOMMatrix order). */
export type Mat2D = [number, number, number, number, number, number];

export const identity = (): Mat2D => [1, 0, 0, 1, 0, 0];

/** m × n (apply n first, then m) — what ctx.transform(n) does to m. */
export function multiply(m: Mat2D, n: Mat2D): Mat2D {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5]
  ];
}

export function invert(m: Mat2D): Mat2D | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det || !isFinite(det)) return null;
  const id = 1 / det;
  return [
    m[3] * id, -m[1] * id, -m[2] * id, m[0] * id,
    (m[2] * m[5] - m[3] * m[4]) * id,
    (m[1] * m[4] - m[0] * m[5]) * id
  ];
}

/** Largest singular value: how much the matrix can stretch a length. */
export function maxScale(m: Mat2D): number {
  const p = m[0] * m[0] + m[1] * m[1] + m[2] * m[2] + m[3] * m[3];
  const det = m[0] * m[3] - m[1] * m[2];
  return Math.sqrt(Math.max(0, (p + Math.sqrt(Math.max(0, p * p - 4 * det * det))) / 2));
}

/** Geometric-mean scale (used for line widths under non-uniform transforms). */
export const meanScale = (m: Mat2D): number => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));

export const isAxisAligned = (m: Mat2D): boolean => m[1] === 0 && m[2] === 0;

/** Max distance (device px) between a curve and its flattened polyline. */
export const CURVE_TOLERANCE = 0.1;
/** Max sagitta (device px) of a flattened arc segment. */
export const ARC_TOLERANCE = 0.05;
const TAU = Math.PI * 2;
const MAX_SEGMENTS = 4096;

export interface Subpath {
  /** index of the first point (in points, not coordinates) */
  start: number;
  count: number;
  closed: boolean;
}

/** Flattened path in device coordinates. */
export class PathBuilder {
  /** x0, y0, x1, y1, … in device space */
  declare pts: number[];
  declare subs: Subpath[];

  constructor() {
    this.pts = [];
    this.subs = [];
  }

  clear(): void {
    this.pts.length = 0;
    this.subs.length = 0;
  }

  private cur(): Subpath | null {
    return this.subs.length ? this.subs[this.subs.length - 1] : null;
  }

  private pushDevice(x: number, y: number): void {
    this.pts.push(x, y);
    this.subs[this.subs.length - 1].count++;
  }

  private startDevice(x: number, y: number): void {
    const s = this.cur();
    if (s && s.count === 1 && !s.closed) {           // lone moveTo: just replace it
      this.pts[s.start * 2] = x; this.pts[s.start * 2 + 1] = y;
      return;
    }
    this.subs.push({ start: this.pts.length / 2, count: 0, closed: false });
    this.pushDevice(x, y);
  }

  /** last point in device space, or null when there is no subpath */
  lastPoint(): [number, number] | null {
    const s = this.cur();
    if (!s || s.count === 0) return null;
    const i = (s.start + s.count - 1) * 2;
    return [this.pts[i], this.pts[i + 1]];
  }

  moveTo(m: Mat2D, x: number, y: number): void {
    if (!isFinite(x) || !isFinite(y)) return;
    this.startDevice(m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]);
  }

  lineTo(m: Mat2D, x: number, y: number): void {
    if (!isFinite(x) || !isFinite(y)) return;
    const dx = m[0] * x + m[2] * y + m[4], dy = m[1] * x + m[3] * y + m[5];
    if (!this.cur()) this.startDevice(dx, dy);
    else this.pushDevice(dx, dy);
  }

  closePath(): void {
    const s = this.cur();
    if (!s || s.count === 0) return;
    s.closed = true;
    const i = s.start * 2;
    const x = this.pts[i], y = this.pts[i + 1];
    this.subs.push({ start: this.pts.length / 2, count: 0, closed: false });
    this.pushDevice(x, y);
  }

  quadraticCurveTo(m: Mat2D, cpx: number, cpy: number, x: number, y: number): void {
    if (!isFinite(cpx) || !isFinite(cpy) || !isFinite(x) || !isFinite(y)) return;
    if (!this.cur()) this.moveTo(m, cpx, cpy);
    const p0 = this.lastPoint() as [number, number];
    const x1 = m[0] * cpx + m[2] * cpy + m[4], y1 = m[1] * cpx + m[3] * cpy + m[5];
    const x2 = m[0] * x + m[2] * y + m[4], y2 = m[1] * x + m[3] * y + m[5];
    const ddx = p0[0] - 2 * x1 + x2, ddy = p0[1] - 2 * y1 + y2;
    const dev = 0.25 * Math.sqrt(ddx * ddx + ddy * ddy);
    const n = Math.min(MAX_SEGMENTS, Math.max(1, Math.ceil(Math.sqrt(dev / CURVE_TOLERANCE))));
    for (let i = 1; i <= n; i++) {
      const t = i / n, mt = 1 - t;
      const a = mt * mt, b = 2 * mt * t, c = t * t;
      this.pushDevice(a * p0[0] + b * x1 + c * x2, a * p0[1] + b * y1 + c * y2);
    }
  }

  bezierCurveTo(m: Mat2D, c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void {
    if (![c1x, c1y, c2x, c2y, x, y].every(isFinite)) return;
    if (!this.cur()) this.moveTo(m, c1x, c1y);
    const p0 = this.lastPoint() as [number, number];
    const x1 = m[0] * c1x + m[2] * c1y + m[4], y1 = m[1] * c1x + m[3] * c1y + m[5];
    const x2 = m[0] * c2x + m[2] * c2y + m[4], y2 = m[1] * c2x + m[3] * c2y + m[5];
    const x3 = m[0] * x + m[2] * y + m[4], y3 = m[1] * x + m[3] * y + m[5];
    const d1 = Math.hypot(p0[0] - 2 * x1 + x2, p0[1] - 2 * y1 + y2);
    const d2 = Math.hypot(x1 - 2 * x2 + x3, y1 - 2 * y2 + y3);
    const dev = 0.75 * Math.max(d1, d2);
    const n = Math.min(MAX_SEGMENTS, Math.max(1, Math.ceil(Math.sqrt(dev / CURVE_TOLERANCE))));
    for (let i = 1; i <= n; i++) {
      const t = i / n, mt = 1 - t;
      const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
      this.pushDevice(a * p0[0] + b * x1 + c * x2 + d * x3, a * p0[1] + b * y1 + c * y2 + d * y3);
    }
  }

  rect(m: Mat2D, x: number, y: number, w: number, h: number): void {
    if (![x, y, w, h].every(isFinite)) return;
    this.moveTo(m, x, y);
    this.lineTo(m, x + w, y);
    this.lineTo(m, x + w, y + h);
    this.lineTo(m, x, y + h);
    this.closePath();
  }

  arc(m: Mat2D, x: number, y: number, r: number, a0: number, a1: number, ccw: boolean): void {
    this.ellipse(m, x, y, r, r, 0, a0, a1, ccw);
  }

  /**
   * Canvas ellipse()/arc(): connects to the start point with a line when a
   * subpath exists. Angle normalization follows Chromium (adjustEndAngle):
   * a sweep of 2π or more draws the full ellipse; otherwise the sweep is
   * reduced modulo 2π in the requested direction.
   */
  ellipse(m: Mat2D, x: number, y: number, rx: number, ry: number, rot: number,
    a0: number, a1: number, ccw: boolean): void {
    if (![x, y, rx, ry, rot, a0, a1].every(isFinite)) return;
    if (rx < 0 || ry < 0) throw new RangeError('The radius provided is negative.');
    let sweep: number;
    if (!ccw && a1 - a0 >= TAU) sweep = TAU;
    else if (ccw && a0 - a1 >= TAU) sweep = -TAU;
    else if (!ccw && a0 > a1) sweep = TAU - ((a0 - a1) % TAU);
    else if (ccw && a0 < a1) sweep = -(TAU - ((a1 - a0) % TAU));
    else sweep = a1 - a0;

    const R = maxScale(m) * Math.max(rx, ry);
    let n: number;
    if (R <= ARC_TOLERANCE * 2) n = Math.ceil(Math.abs(sweep) / (Math.PI / 2));
    else n = Math.ceil(Math.abs(sweep) / (2 * Math.acos(1 - ARC_TOLERANCE / R)));
    n = Math.min(MAX_SEGMENTS, Math.max(1, n));

    const cr = Math.cos(rot), sr = Math.sin(rot);
    for (let i = 0; i <= n; i++) {
      const th = a0 + sweep * (i / n);
      const ex = rx * Math.cos(th), ey = ry * Math.sin(th);
      const ux = x + ex * cr - ey * sr, uy = y + ex * sr + ey * cr;
      const dx = m[0] * ux + m[2] * uy + m[4], dy = m[1] * ux + m[3] * uy + m[5];
      if (i === 0 && !this.cur()) this.startDevice(dx, dy);
      else this.pushDevice(dx, dy);
    }
  }

  /**
   * If the path is exactly one axis-aligned rectangle (in device space),
   * returns [x0, y0, x1, y1]; otherwise null. Used for the fast rect clip.
   */
  asDeviceRect(): [number, number, number, number] | null {
    let found: Subpath | null = null;
    for (const s of this.subs) {
      if (s.count <= 1) continue;
      if (found) return null;
      found = s;
    }
    if (!found) return null;
    let n = found.count;
    const P = this.pts, o = found.start * 2;
    if (n === 5 && P[o] === P[o + 8] && P[o + 1] === P[o + 9]) n = 4;
    if (n !== 4) return null;
    const x = [P[o], P[o + 2], P[o + 4], P[o + 6]], y = [P[o + 1], P[o + 3], P[o + 5], P[o + 7]];
    const hFirst = y[0] === y[1] && x[1] === x[2] && y[2] === y[3] && x[3] === x[0];
    const vFirst = x[0] === x[1] && y[1] === y[2] && x[2] === x[3] && y[3] === y[0];
    if (!hFirst && !vFirst) return null;
    return [Math.min(x[0], x[2]), Math.min(y[0], y[2]), Math.max(x[0], x[2]), Math.max(y[0], y[2])];
  }
}
