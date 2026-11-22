/* ═══════════════════════════════════════════════════════════════════════════
   Coverage rasterizers.

   FILL: exact-area signed accumulation (the font-rs / stb_truetype-v2
   scheme). Every edge deposits its signed area into an accumulation row;
   a prefix sum along the row gives the winding-weighted coverage, which is
   folded into [0, 1] by the fill rule (nonzero: min(1, |w|); evenodd: a
   triangle wave). Rows are processed in bands so the scratch buffer stays
   small even for full-canvas paths.

   STROKE: the stroke is the union of pieces — one rectangle per segment,
   one wedge per join, caps at open ends — and coverage is the MAX over the
   pieces of a distance-based anti-aliased coverage. Max (not sum) is what
   makes a translucent self-overlapping stroke blend once, as in Canvas.
   Segments are cut hard (no AA) at internal vertices and the join wedge
   covers exactly the region beyond both cuts, so no seams appear.
   ═══════════════════════════════════════════════════════════════════════════ */

import type { Subpath } from './path.ts';

/** Integer pixel bounds, exclusive max. */
export interface IRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Receives a row span: pixels [x0, x0+n) of row y have coverage
 * cov[off .. off+n). The sink may modify cov in place; the buffer is
 * reused after the sink returns.
 */
export type RowSink = (y: number, x0: number, n: number, cov: Float32Array, off: number) => void;

export type LineCap = 'butt' | 'round' | 'square';
export type LineJoin = 'miter' | 'round' | 'bevel';

export interface StrokeStyle {
  /** half of the line width, device px */
  halfWidth: number;
  cap: LineCap;
  join: LineJoin;
  miterLimit: number;
  /** dash pattern in device px (even length) or null for solid */
  dash: number[] | null;
  dashOffset: number;
}

/** coverage below this is treated as empty (float noise of the prefix sum) */
const COV_EPS = 1 / 4096;
/** accumulation cells per band (rows × stride) */
const BAND_CELLS = 1 << 16;

let accBuf = new Float64Array(0);
let rowBuf = new Float32Array(0);

function ensureAcc(n: number): Float64Array {
  if (accBuf.length < n) accBuf = new Float64Array(Math.max(n, accBuf.length * 2));
  return accBuf;
}
function ensureRow(n: number): Float32Array {
  if (rowBuf.length < n) rowBuf = new Float32Array(Math.max(n, rowBuf.length * 2));
  return rowBuf;
}

/* ───────────────────────────── fill ───────────────────────────── */

/** Accumulate one edge (x already within [0, W], y within [0, bandH]). */
function rasterLine(acc: Float64Array, stride: number, x0: number, y0: number, x1: number, y1: number): void {
  if (y0 === y1) return;
  let dir = 1;
  if (y0 > y1) {
    dir = -1;
    let t = x0; x0 = x1; x1 = t;
    t = y0; y0 = y1; y1 = t;
  }
  const dxdy = (x1 - x0) / (y1 - y0);
  let x = x0;
  const yEnd = Math.ceil(y1);
  for (let y = Math.floor(y0); y < yEnd; y++) {
    const ls = y * stride;
    const dy = Math.min(y + 1, y1) - Math.max(y, y0);
    const xnext = x + dxdy * dy;
    const d = dy * dir;
    const xa = x < xnext ? x : xnext, xb = x < xnext ? xnext : x;
    const xaf = Math.floor(xa), xai = xaf | 0;
    const xbc = Math.ceil(xb);
    if (xbc <= xaf + 1) {
      const xmf = 0.5 * (x + xnext) - xaf;
      acc[ls + xai] += d - d * xmf;
      acc[ls + xai + 1] += d * xmf;
    } else {
      const s = 1 / (xb - xa);
      const xf = xa - xaf;
      const a0 = 0.5 * s * (1 - xf) * (1 - xf);
      const xbf = xb - xbc + 1;
      const am = 0.5 * s * xbf * xbf;
      acc[ls + xai] += d * a0;
      if (xbc === xaf + 2) {
        acc[ls + xai + 1] += d * (1 - a0 - am);
      } else {
        const a1 = s * (1.5 - xf);
        acc[ls + xai + 1] += d * (a1 - a0);
        for (let xi = xai + 2; xi < xbc - 1; xi++) acc[ls + xi] += d * s;
        const a2 = a1 + (xbc - xai - 3) * s;
        acc[ls + xbc - 1] += d * (1 - a2 - am);
      }
      acc[ls + xbc] += d * am;
    }
    x = xnext;
  }
}

/** Clip an edge to x ∈ [0, W] by splitting; outside parts are clamped onto the border. */
function addEdge(acc: Float64Array, stride: number, W: number, x0: number, y0: number, x1: number, y1: number): void {
  if (x0 >= 0 && x0 <= W && x1 >= 0 && x1 <= W) {
    rasterLine(acc, stride, x0, y0, x1, y1);
    return;
  }
  // split at x = 0 and x = W
  const ts: number[] = [0];
  const dx = x1 - x0;
  if (dx !== 0) {
    const ta = (0 - x0) / dx, tb = (W - x0) / dx;
    if (ta > 0 && ta < 1) ts.push(ta);
    if (tb > 0 && tb < 1) ts.push(tb);
    if (ts.length === 3 && ts[1] > ts[2]) { const t = ts[1]; ts[1] = ts[2]; ts[2] = t; }
  }
  ts.push(1);
  const dy = y1 - y0;
  for (let i = 0; i + 1 < ts.length; i++) {
    const ta = ts[i], tb = ts[i + 1];
    let xa = x0 + dx * ta, xb = x0 + dx * tb;
    const ya = y0 + dy * ta, yb = y0 + dy * tb;
    xa = xa < 0 ? 0 : xa > W ? W : xa;
    xb = xb < 0 ? 0 : xb > W ? W : xb;
    rasterLine(acc, stride, xa, ya, xb, yb);
  }
}

/**
 * Fill the (implicitly closed) subpaths with anti-aliasing.
 * `bounds` restricts output (canvas ∩ clip bounds).
 */
export function fillPath(pts: number[], subs: Subpath[], bounds: IRect, evenOdd: boolean, sink: RowSink): void {
  // collect edges
  const E: number[] = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of subs) {
    if (s.count < 2) continue;
    const o = s.start * 2, n = s.count;
    for (let i = 0; i < n; i++) {
      const p = o + i * 2, q = o + ((i + 1) % n) * 2;
      const ax = pts[p], ay = pts[p + 1], bx = pts[q], by = pts[q + 1];
      if (ax < minX) minX = ax; if (ax > maxX) maxX = ax;
      if (ay < minY) minY = ay; if (ay > maxY) maxY = ay;
      if (ay !== by) E.push(ax, ay, bx, by);
    }
  }
  if (!E.length) return;
  const ix0 = Math.max(bounds.x0, Math.floor(minX)), ix1 = Math.min(bounds.x1, Math.ceil(maxX));
  const iy0 = Math.max(bounds.y0, Math.floor(minY)), iy1 = Math.min(bounds.y1, Math.ceil(maxY));
  if (ix1 <= ix0 || iy1 <= iy0) return;
  const W = ix1 - ix0, stride = W + 2;
  const bandH = Math.max(1, Math.min(iy1 - iy0, Math.floor(BAND_CELLS / stride)));
  const acc = ensureAcc(stride * bandH);
  const cov = ensureRow(W);
  const ne = E.length;
  for (let by = iy0; by < iy1; by += bandH) {
    const bh = Math.min(bandH, iy1 - by);
    acc.fill(0, 0, stride * bh);
    for (let e = 0; e < ne; e += 4) {
      let x0 = E[e] - ix0, y0 = E[e + 1] - by, x1 = E[e + 2] - ix0, y1 = E[e + 3] - by;
      if ((y0 <= 0 && y1 <= 0) || (y0 >= bh && y1 >= bh)) continue;
      // clip to the band vertically
      const dxdy = (x1 - x0) / (y1 - y0);
      if (y0 < 0) { x0 -= y0 * dxdy; y0 = 0; } else if (y0 > bh) { x0 -= (y0 - bh) * dxdy; y0 = bh; }
      if (y1 < 0) { x1 -= y1 * dxdy; y1 = 0; } else if (y1 > bh) { x1 -= (y1 - bh) * dxdy; y1 = bh; }
      addEdge(acc, stride, W, x0, y0, x1, y1);
    }
    for (let r = 0; r < bh; r++) {
      const ls = r * stride;
      let s = 0, first = -1, last = -1;
      for (let x = 0; x < W; x++) {
        s += acc[ls + x];
        let c = s < 0 ? -s : s;
        if (evenOdd) { c = c % 2; if (c > 1) c = 2 - c; }
        else if (c > 1) c = 1;
        if (c < COV_EPS) c = 0;
        else { if (first < 0) first = x; last = x; }
        cov[x] = c;
      }
      if (first >= 0) sink(by + r, ix0 + first, last - first + 1, cov, first);
    }
  }
}

/* ───────────────────────────── stroke ───────────────────────────── */

const CUT = 0, BUTT = 1, SQUARE = 2, ROUND = 3;
const capKind = (c: LineCap): number => (c === 'round' ? ROUND : c === 'square' ? SQUARE : BUTT);
const DUP_EPS = 1e-9;
const CUT_EPS = 1e-7;

/** 1-D box-filtered coverage of a band |v| <= hw by a 1-px pixel footprint. */
function across(v: number, hw: number): number {
  const hi = v + 0.5 < hw ? v + 0.5 : hw;
  const lo = v - 0.5 > -hw ? v - 0.5 : -hw;
  return hi > lo ? hi - lo : 0;
}

function dedupe(src: number[], o: number, count: number): number[] {
  const L: number[] = [];
  for (let i = 0; i < count; i++) {
    const x = src[o + i * 2], y = src[o + i * 2 + 1];
    const n = L.length;
    if (n && Math.abs(L[n - 2] - x) < DUP_EPS && Math.abs(L[n - 1] - y) < DUP_EPS) continue;
    L.push(x, y);
  }
  return L;
}

/** Split polylines into dashes (open polylines). */
function applyDash(lines: number[][], closed: boolean[], dash: number[], offset: number): number[][] {
  let total = 0;
  for (const d of dash) total += d;
  if (!(total > 0)) return lines;
  const out: number[][] = [];
  for (let li = 0; li < lines.length; li++) {
    const P = lines[li].slice();
    if (closed[li]) P.push(P[0], P[1]);
    // initial phase
    let phase = ((offset % total) + total) % total;
    let idx = 0;
    while (phase >= dash[idx]) { phase -= dash[idx]; idx = (idx + 1) % dash.length; }
    let remain = dash[idx] - phase;
    let on = (idx & 1) === 0;
    let cur: number[] | null = on ? [P[0], P[1]] : null;
    for (let i = 0; i + 2 < P.length; i += 2) {
      const ax = P[i], ay = P[i + 1], bx = P[i + 2], by = P[i + 3];
      const L = Math.hypot(bx - ax, by - ay);
      let pos = 0;
      while (L - pos > 1e-12) {
        const step = Math.min(remain, L - pos);
        pos += step;
        remain -= step;
        const t = pos / L;
        const px = ax + (bx - ax) * t, py = ay + (by - ay) * t;
        if (on && cur) cur.push(px, py);
        if (remain <= 1e-12) {
          if (on && cur) { out.push(cur); cur = null; }
          idx = (idx + 1) % dash.length;
          remain = dash[idx];
          on = !on;
          if (on) cur = [px, py];
        }
      }
    }
    if (on && cur && cur.length >= 4) out.push(cur);
  }
  return out;
}

let strokeBuf = new Float32Array(0);

/**
 * Stroke the subpaths. Pieces are collected first (to know the bounding
 * box), then rasterized into a max-coverage buffer which is emitted row by row.
 */
export function strokePath(pts: number[], subs: Subpath[], st: StrokeStyle, bounds: IRect, sink: RowSink): void {
  const hw = st.halfWidth;
  if (!(hw > 0)) return;
  const cap = capKind(st.cap);

  // 1. polylines without consecutive duplicates
  let lines: number[][] = [];
  let closed: boolean[] = [];
  const dots: number[] = [];                       // zero-length subpaths: x, y
  for (const s of subs) {
    if (s.count < 2) continue;
    const L = dedupe(pts, s.start * 2, s.count);
    const isClosed = s.closed;
    if (isClosed && L.length >= 4) {
      const n = L.length;
      if (Math.abs(L[n - 2] - L[0]) < DUP_EPS && Math.abs(L[n - 1] - L[1]) < DUP_EPS) L.length = n - 2;
    }
    if (L.length < 4) {
      if (!isClosed && cap !== BUTT) dots.push(L[0], L[1]);
      continue;
    }
    lines.push(L);
    closed.push(isClosed);
  }
  if (st.dash) {
    const dashed = applyDash(lines, closed, st.dash, st.dashOffset);
    lines = [];
    for (const D of dashed) {
      const L = dedupe(D, 0, D.length / 2);
      if (L.length >= 4) lines.push(L);
      else if (cap !== BUTT) dots.push(L[0], L[1]);
    }
    closed = lines.map(() => false);
  }

  // 2. pieces
  // segment: ax, ay, bx, by, k0, k1 ; join: jx, jy, dAx, dAy, dBx, dBy
  const segs: number[] = [];
  const joins: number[] = [];
  const joinKind = st.join;
  for (let li = 0; li < lines.length; li++) {
    const P = lines[li], n = P.length / 2, cl = closed[li];
    const nseg = cl ? n : n - 1;
    for (let i = 0; i < nseg; i++) {
      const a = i * 2, b = ((i + 1) % n) * 2;
      const k0 = !cl && i === 0 ? cap : CUT;
      const k1 = !cl && i === nseg - 1 ? cap : CUT;
      segs.push(P[a], P[a + 1], P[b], P[b + 1], k0, k1);
    }
    const jStart = cl ? 0 : 1, jEnd = cl ? n : n - 1;
    for (let i = jStart; i < jEnd; i++) {
      const p = ((i - 1 + n) % n) * 2, j = i * 2, q = ((i + 1) % n) * 2;
      let ax = P[j] - P[p], ay = P[j + 1] - P[p + 1];
      let bx = P[q] - P[j], by = P[q + 1] - P[j + 1];
      const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
      ax /= la; ay /= la; bx /= lb; by /= lb;
      joins.push(P[j], P[j + 1], ax, ay, bx, by);
    }
  }
  for (let i = 0; i < dots.length; i += 2) segs.push(dots[i], dots[i + 1], dots[i], dots[i + 1], cap, cap);
  if (!segs.length) return;

  // 3. bounding box
  const capExt = cap === BUTT ? 0.5 : hw * Math.SQRT2 + 0.5;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (x: number, y: number, r: number): void => {
    if (x - r < minX) minX = x - r; if (x + r > maxX) maxX = x + r;
    if (y - r < minY) minY = y - r; if (y + r > maxY) maxY = y + r;
  };
  for (let i = 0; i < segs.length; i += 6) {
    const r0 = hw + 1 + (segs[i + 4] === CUT ? 0 : capExt), r1 = hw + 1 + (segs[i + 5] === CUT ? 0 : capExt);
    grow(segs[i], segs[i + 1], r0);
    grow(segs[i + 2], segs[i + 3], r1);
  }
  for (let i = 0; i < joins.length; i += 6) {
    let r = hw + 1;
    if (joinKind === 'miter') {
      const cosHalf = Math.sqrt(Math.max(0, (1 + joins[i + 2] * joins[i + 4] + joins[i + 3] * joins[i + 5]) / 2));
      if (cosHalf > 1e-9 && 1 / cosHalf <= st.miterLimit) r = hw / cosHalf + 1;
    }
    grow(joins[i], joins[i + 1], r + 1);
  }
  const bx0 = Math.max(bounds.x0, Math.floor(minX)), bx1 = Math.min(bounds.x1, Math.ceil(maxX));
  const by0 = Math.max(bounds.y0, Math.floor(minY)), by1 = Math.min(bounds.y1, Math.ceil(maxY));
  if (bx1 <= bx0 || by1 <= by0) return;
  const bw = bx1 - bx0, bh = by1 - by0;
  if (strokeBuf.length < bw * bh) strokeBuf = new Float32Array(Math.max(bw * bh, strokeBuf.length * 2));
  const buf = strokeBuf;
  buf.fill(0, 0, bw * bh);
  const rowMin = new Int32Array(bh).fill(bw), rowMax = new Int32Array(bh).fill(-1);
  const R: Raster = { buf, bw, bh, ox: bx0, oy: by0, rowMin, rowMax };

  // 4. rasterize pieces
  for (let i = 0; i < segs.length; i += 6) {
    drawSegment(R, hw, segs[i], segs[i + 1], segs[i + 2], segs[i + 3], segs[i + 4], segs[i + 5]);
  }
  for (let i = 0; i < joins.length; i += 6) {
    drawJoin(R, hw, joinKind, st.miterLimit, joins[i], joins[i + 1], joins[i + 2], joins[i + 3], joins[i + 4], joins[i + 5]);
  }

  // 5. emit
  for (let r = 0; r < bh; r++) {
    const a = rowMin[r], b = rowMax[r];
    if (b < a) continue;
    sink(by0 + r, bx0 + a, b - a + 1, buf, r * bw + a);
  }
}

interface Raster {
  buf: Float32Array;
  bw: number;
  bh: number;
  ox: number;
  oy: number;
  rowMin: Int32Array;
  rowMax: Int32Array;
}

/** x-range of a convex quad on the horizontal line y = yc. */
function quadSpan(qx: number[], qy: number[], yc: number, out: number[]): boolean {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) & 3;
    const y0 = qy[i], y1 = qy[j];
    if ((y0 <= yc && y1 >= yc) || (y1 <= yc && y0 >= yc)) {
      let x: number;
      if (y0 === y1) {
        x = qx[i]; if (x < lo) lo = x; if (x > hi) hi = x;
        x = qx[j];
      } else x = qx[i] + (qx[j] - qx[i]) * (yc - y0) / (y1 - y0);
      if (x < lo) lo = x; if (x > hi) hi = x;
    }
  }
  out[0] = lo; out[1] = hi;
  return hi >= lo;
}

const qxs = [0, 0, 0, 0], qys = [0, 0, 0, 0], span = [0, 0];

function drawSegment(R: Raster, hw: number, ax: number, ay: number, bx: number, by: number, k0: number, k1: number): void {
  const { buf, bw, bh, rowMin, rowMax } = R;
  ax -= R.ox; ay -= R.oy; bx -= R.ox; by -= R.oy;
  let tx = bx - ax, ty = by - ay;
  const L = Math.hypot(tx, ty);
  if (L > 0) { tx /= L; ty /= L; } else { tx = 1; ty = 0; }
  const nx = -ty, ny = tx;
  const ext = (k: number): number => (k === CUT ? CUT_EPS : k === BUTT ? 0.5 : hw + 0.5);
  const lo = -ext(k0), hi = L + ext(k1), side = hw + 0.5;
  // along-limits for the box-filtered caps
  const loB = k0 === BUTT ? 0 : k0 === SQUARE ? -hw : -Infinity;
  const hiB = k1 === BUTT ? L : k1 === SQUARE ? L + hw : Infinity;
  qxs[0] = ax + tx * lo + nx * side; qys[0] = ay + ty * lo + ny * side;
  qxs[1] = ax + tx * hi + nx * side; qys[1] = ay + ty * hi + ny * side;
  qxs[2] = ax + tx * hi - nx * side; qys[2] = ay + ty * hi - ny * side;
  qxs[3] = ax + tx * lo - nx * side; qys[3] = ay + ty * lo - ny * side;
  const ymin = Math.min(qys[0], qys[1], qys[2], qys[3]), ymax = Math.max(qys[0], qys[1], qys[2], qys[3]);
  const r0 = Math.max(0, Math.ceil(ymin - 0.5)), r1 = Math.min(bh - 1, Math.floor(ymax - 0.5));
  const round0 = k0 === ROUND, round1 = k1 === ROUND, cut0 = k0 === CUT, cut1 = k1 === CUT;
  for (let r = r0; r <= r1; r++) {
    const yc = r + 0.5;
    if (!quadSpan(qxs, qys, yc, span)) continue;
    const c0 = Math.max(0, Math.ceil(span[0] - 0.5)), c1 = Math.min(bw - 1, Math.floor(span[1] - 0.5));
    if (c1 < c0) continue;
    const px0 = c0 + 0.5 - ax, py = yc - ay;
    let u = px0 * tx + py * ty, v = px0 * nx + py * ny;
    const row = r * bw;
    let touched = false;
    for (let c = c0; c <= c1; c++, u += tx, v += nx) {
      let cov: number;
      if (u < 0) {
        if (cut0) { if (u < -CUT_EPS) continue; cov = across(v, hw); }
        else if (round0) cov = across(Math.sqrt(u * u + v * v), hw);
        else cov = across(v, hw) * alongCov(u, loB, hiB);
      } else if (u > L) {
        if (cut1) { if (u > L + CUT_EPS) continue; cov = across(v, hw); }
        else if (round1) { const du = u - L; cov = across(Math.sqrt(du * du + v * v), hw); }
        else cov = across(v, hw) * alongCov(u, loB, hiB);
      } else {
        cov = across(v, hw);
        if (u < 0.5 || u > L - 0.5) cov *= alongCov(u, loB, hiB);
      }
      if (cov <= 0) continue;
      if (cov > 1) cov = 1;
      const i = row + c;
      if (cov > buf[i]) buf[i] = cov;
      touched = true;
    }
    if (touched) {
      if (c0 < rowMin[r]) rowMin[r] = c0;
      if (c1 > rowMax[r]) rowMax[r] = c1;
    }
  }
}

function alongCov(u: number, lo: number, hi: number): number {
  const a = u + 0.5 < hi ? u + 0.5 : hi;
  const b = u - 0.5 > lo ? u - 0.5 : lo;
  const c = a - b;
  return c <= 0 ? 0 : c > 1 ? 1 : c;
}

function drawJoin(R: Raster, hw: number, kind: LineJoin, miterLimit: number,
  jx: number, jy: number, dax: number, day: number, dbx: number, dby: number): void {
  const cross = dax * dby - day * dbx, dot = dax * dbx + day * dby;
  if (Math.abs(cross) < 1e-9 && dot > 0) return;           // collinear: nothing to fill
  // outer normals: the side away from the turn
  let oax = -day, oay = dax, obx = -dby, oby = dbx;
  if (cross > 0) { oax = -oax; oay = -oay; obx = -obx; oby = -oby; }
  let mx = oax + obx, my = oay + oby;
  const mlen = Math.hypot(mx, my);
  const cosHalf = mlen / 2;
  if (mlen > 1e-9) { mx /= mlen; my /= mlen; } else { mx = dax; my = day; }
  let type = kind;
  if (type === 'miter' && (cosHalf < 1e-9 || 1 / cosHalf > miterLimit)) type = 'bevel';
  if (type === 'bevel' && cosHalf < 1e-6) return;

  // bounding box of the join region (+ AA margin)
  const rr = hw + 1;
  let x0 = Math.min(0, oax * rr, obx * rr), x1 = Math.max(0, oax * rr, obx * rr);
  let y0 = Math.min(0, oay * rr, oby * rr), y1 = Math.max(0, oay * rr, oby * rr);
  if (type === 'miter') {
    const tl = hw / cosHalf + 1;
    x0 = Math.min(x0, mx * tl); x1 = Math.max(x1, mx * tl);
    y0 = Math.min(y0, my * tl); y1 = Math.max(y1, my * tl);
  } else if (type === 'round') {
    // axis extremes of the circular sector between oA and oB
    const c = mlen > 1e-9 ? cosHalf : 0;
    if (mx >= c) x1 = Math.max(x1, rr);
    if (-mx >= c) x0 = Math.min(x0, -rr);
    if (my >= c) y1 = Math.max(y1, rr);
    if (-my >= c) y0 = Math.min(y0, -rr);
  }
  const { buf, bw, bh, rowMin, rowMax } = R;
  const lx = jx - R.ox, ly = jy - R.oy;
  const c0 = Math.max(0, Math.floor(lx + x0 - 1)), c1 = Math.min(bw - 1, Math.ceil(lx + x1 + 1));
  const r0 = Math.max(0, Math.floor(ly + y0 - 1)), r1 = Math.min(bh - 1, Math.ceil(ly + y1 + 1));
  const bevelD = hw * cosHalf + 0.5;
  for (let r = r0; r <= r1; r++) {
    const qy = r + 0.5 - ly;
    const row = r * bw;
    let touched = false, tmin = bw, tmax = -1;
    for (let c = c0; c <= c1; c++) {
      const qx = c + 0.5 - lx;
      if (qx * dax + qy * day < -CUT_EPS || qx * dbx + qy * dby > CUT_EPS) continue;
      let cov: number;
      if (type === 'round') cov = across(Math.sqrt(qx * qx + qy * qy), hw);
      else if (type === 'bevel') {
        cov = bevelD - (qx * mx + qy * my);
        // the two cut lines bound the triangle; stay within the stroke width too
        const e = Math.max(qx * oax + qy * oay, qx * obx + qy * oby);
        cov = Math.min(cov, hw + 0.5 - e);
      } else {
        cov = hw + 0.5 - Math.max(qx * oax + qy * oay, qx * obx + qy * oby);
      }
      if (cov <= 0) continue;
      if (cov > 1) cov = 1;
      const i = row + c;
      if (cov > buf[i]) buf[i] = cov;
      touched = true;
      if (c < tmin) tmin = c;
      if (c > tmax) tmax = c;
    }
    if (touched) {
      if (tmin < rowMin[r]) rowMin[r] = tmin;
      if (tmax > rowMax[r]) rowMax[r] = tmax;
    }
  }
}
