/* ═══════════════════════════════════════════════════════════════════════════
   Hull albedo + channel mask (R = water depth, G = vegetation, B = pavement).
   Line-for-line port of js/textures.js makeHullMaps: same drawing calls,
   same constants, same order and number of rnd() calls.

   Pixels are the legacy pixels (u = θ/360° left to right). The legacy app
   mirrors the hull UVs at material level (repeat.x = -1); the core bakes
   θ-correct UVs into the geometry instead, so the image itself is NOT
   flipped here.

   Hidden legacy inputs made explicit: CONFIG.SEED (read by cellInfo) is
   `worldSeed`, CONFIG.DEBUG_UV_MARKER is `debugUvMarker`.
   ═══════════════════════════════════════════════════════════════════════════ */

import type { RasterCanvas } from '../raster/index.ts';
import { CORE_CONFIG } from '../config/index.ts';
import { pick } from '../rng.ts';
import type { Rng } from '../rng.ts';
import { cv, tint, smoothLine, cityBlock, cityCenter, cellInfo, cellUsable, TAU_2D } from './common.ts';
import type { Context2D } from '../raster/index.ts';

/** A pond cut into a hull dip (js/world.js: hullHills.filter(h => h.dip)). */
export interface Pond {
  /** angle around the axis, radians */
  t: number;
  /** position along the axis, units */
  z: number;
  /** radius, units (already × 0.62 in world.js) */
  r: number;
  /** aspect (stretch along the arc) */
  ax: number;
  /** rotation, radians */
  rot: number;
}

export interface HullMapsOptions {
  /** CONFIG.SEED of the legacy app (cellInfo reads it). */
  worldSeed: number;
  /** CONFIG.DEBUG_UV_MARKER (red stripe over θ ∈ [0°, 10°]). */
  debugUvMarker?: boolean;
}

export interface HullMaps { albedo: RasterCanvas; mask: RasterCanvas }

type Street = ['v' | 'h', number, number, number, boolean];

export function makeHullMaps(size: number, maskSize: number, rnd: Rng, ponds: Pond[], opts: HullMapsOptions): HullMaps {
  const CONFIG = CORE_CONFIG;
  const W = size, H = size, A = cv(W, H);
  const M = cv(maskSize, maskSize);
  const X = (deg: number): number => (deg / 360) * W;
  const a = A.g, m = M.g;
  const mh = M.c.height;

  /* mask: everything is vegetation by default */
  m.fillStyle = '#00ff00'; m.fillRect(0, 0, M.c.width, mh);

  /* base soil of transition zones */
  a.fillStyle = '#54703c'; a.fillRect(0, 0, W, H);
  for (let i = 0; i < 6000; i++) {
    a.fillStyle = pick(rnd, ['#5e7a42', '#4b653a', '#66834a', '#48603a', '#6d8a4e']);
    a.globalAlpha = 0.3 + rnd() * 0.45;
    const s = 4 + rnd() * 26;
    a.fillRect(rnd() * W, rnd() * H, s, s * (0.4 + rnd()));
  }
  a.globalAlpha = 1;

  /* ── fields: patchwork of plots ── */
  const fieldPal = ['#7d8f3e', '#96a24a', '#6d8438', '#b5ab52', '#c9bd63', '#5f7a33', '#8ea04a', '#a89b45', '#d0c778'];
  for (const [s0, s1] of CONFIG.SECT.fields) {
    const x0 = X(s0), x1 = X(s1);
    a.save(); a.beginPath(); a.rect(x0, 0, x1 - x0, H); a.clip();
    let y = -40;
    while (y < H + 40) {
      const bh = 46 + rnd() * 120;
      let x = x0 - 30;
      while (x < x1 + 30) {
        const bw = 44 + rnd() * 130, j = 8;
        a.fillStyle = pick(rnd, fieldPal);
        a.beginPath();
        a.moveTo(x + (rnd() - .5) * j, y + (rnd() - .5) * j);
        a.lineTo(x + bw + (rnd() - .5) * j, y + (rnd() - .5) * j);
        a.lineTo(x + bw + (rnd() - .5) * j, y + bh + (rnd() - .5) * j);
        a.lineTo(x + (rnd() - .5) * j, y + bh + (rnd() - .5) * j);
        a.closePath(); a.fill();
        a.globalAlpha = 0.13; a.strokeStyle = '#31401f'; a.lineWidth = 1;
        const step = 5 + rnd() * 8, horiz = rnd() < 0.5;
        a.beginPath();
        if (horiz) for (let k = y + step; k < y + bh; k += step) { a.moveTo(x, k); a.lineTo(x + bw, k); }
        else for (let k = x + step; k < x + bw; k += step) { a.moveTo(k, y); a.lineTo(k, y + bh); }
        a.stroke();
        a.globalAlpha = 0.22; a.strokeStyle = '#4d5f2c'; a.lineWidth = 3; a.strokeRect(x, y, bw, bh);
        a.globalAlpha = 1;
        x += bw;
      }
      y += bh;
    }
    a.globalAlpha = 0.3; a.strokeStyle = '#b9b08a'; a.lineWidth = 3;
    for (let i = 0; i < 8; i++) {
      const yy = rnd() * H;
      a.beginPath(); a.moveTo(x0, yy); a.lineTo(x1, yy + (rnd() - .5) * 40); a.stroke();
    }
    a.globalAlpha = 1; a.restore();
  }

  /* ── parks ── */
  for (const [s0, s1] of CONFIG.SECT.parks) {
    const x0 = X(s0), x1 = X(s1);
    a.save(); a.beginPath(); a.rect(x0, 0, x1 - x0, H); a.clip();
    a.fillStyle = '#42682f'; a.fillRect(x0, 0, x1 - x0, H);
    for (let i = 0; i < 1800; i++) {
      a.fillStyle = pick(rnd, ['#4d7536', '#385c28', '#598040', '#6b8f45', '#2f4f22']);
      a.globalAlpha = 0.5 + rnd() * 0.5;
      a.beginPath();
      a.ellipse(x0 + rnd() * (x1 - x0), rnd() * H, 8 + rnd() * 44, 6 + rnd() * 32, rnd() * Math.PI, 0, 6.2832);
      a.fill();
    }
    a.globalAlpha = 0.5;
    for (let i = 0; i < 30; i++) {
      a.fillStyle = '#7d9a4e';
      a.beginPath();
      a.ellipse(x0 + rnd() * (x1 - x0), rnd() * H, 14 + rnd() * 48, 10 + rnd() * 36, rnd() * Math.PI, 0, 6.2832);
      a.fill();
    }
    /* gravel paths — also into the mask as weak pavement */
    a.globalAlpha = 0.4; a.strokeStyle = '#c4b894'; a.lineWidth = 3;
    m.strokeStyle = '#000040'; m.lineWidth = 2;
    for (let i = 0; i < 14; i++) {
      const base = x0 + rnd() * (x1 - x0);
      const ph0 = rnd() * 6.2832, ph1 = rnd() * 6.2832;
      const am0 = 16 + rnd() * 30, am1 = 5 + rnd() * 11;
      const fr0 = 0.005 + rnd() * 0.004, fr1 = 0.017 + rnd() * 0.011;
      const drift = (rnd() - 0.5) * 0.25;
      const pts: number[][] = [];
      for (let py = -20; py <= H + 20; py += 16) {
        pts.push([base + py * drift
          + Math.sin(py * fr0 + ph0) * am0
          + Math.sin(py * fr1 + ph1) * am1, py]);
      }
      smoothLine(a, pts);
      smoothLine(m, pts, M.c.width / W, mh / H);
    }
    a.globalAlpha = 1; a.restore();
  }

  /* ── cities: the same block grid the buildings are placed on ── */
  {
    const B = cityBlock(), C = CONFIG.CITY;
    const circ = 2 * Math.PI * CONFIG.R;
    const pxT = W / circ, pxZ = H / CONFIG.L;
    const hw = B.wT * pxT / 2, hh = B.wZ * pxZ / 2;
    const kx = M.c.width / W, ky = mh / H;
    const colW = B.stepT * pxT, rowH = B.stepZ * pxZ;
    const streets: Street[] = [];

    for (let i = 0; i < C.cols; i++) {
      const rows: number[] = [];
      for (let j = 0; j < C.rows; j++) if (cellUsable(i, j)) rows.push(j);
      if (!rows.length) continue;

      const cx = (cityCenter(i, 0).t / (2 * Math.PI)) * W;
      const y0 = (cityCenter(i, rows[0]).z + CONFIG.L / 2) * pxZ - rowH / 2;
      const y1 = (cityCenter(i, rows[rows.length - 1]).z + CONFIG.L / 2) * pxZ + rowH / 2;

      a.fillStyle = '#4e5359';
      a.fillRect(cx - colW / 2, y0, colW, y1 - y0);
      m.fillStyle = '#000040';
      m.fillRect((cx - colW / 2) * kx, y0 * ky, colW * kx, (y1 - y0) * ky);

      streets.push(['v', cx - colW / 2, y0, y1, i % 3 === 0]);
      if (i === C.cols - 1 || !cellUsable(i + 1, rows[0])) {
        streets.push(['v', cx + colW / 2, y0, y1, false]);
      }
      for (const j of rows) {
        const cy = (cityCenter(i, j).z + CONFIG.L / 2) * pxZ;
        streets.push(['h', cy - rowH / 2, cx - colW / 2, cx + colW / 2, j % 3 === 0]);

        const info = cellInfo(i, j, opts.worldSeed);
        const x = cx - hw, y = cy - hh, bw = hw * 2, bh = hh * 2;
        const shade = 0.92 + info.tint * 0.16;

        if (info.kind === 'park') {
          a.fillStyle = pick(rnd, ['#4f7038', '#5b7d3f', '#456630']);
          a.fillRect(x, y, bw, bh);
          a.globalAlpha = 0.3; a.fillStyle = '#6f9048';
          for (let k = 0; k < 12; k++) {
            a.beginPath();
            a.ellipse(x + rnd() * bw, y + rnd() * bh, 2 + rnd() * 6, 2 + rnd() * 5, 0, 0, 6.2832);
            a.fill();
          }
          a.globalAlpha = 0.25; a.strokeStyle = '#c4b894'; a.lineWidth = 2;
          a.beginPath(); a.moveTo(x, y + bh * (0.3 + info.w * 0.4));
          a.lineTo(x + bw, y + bh * (0.3 + info.d * 0.4)); a.stroke();
          a.globalAlpha = 1;
          m.fillStyle = '#00ff00'; m.fillRect(x * kx, y * ky, bw * kx, bh * ky);
          continue;
        }

        a.fillStyle = tint('#6f757b', shade); a.fillRect(x, y, bw, bh);
        a.fillStyle = tint('#7e848a', shade);
        a.fillRect(x, y, bw, 2); a.fillRect(x, y + bh - 2, bw, 2);
        a.fillRect(x, y, 2, bh); a.fillRect(x + bw - 2, y, 2, bh);

        if (info.kind === 'plaza') {
          a.globalAlpha = 0.55; a.fillStyle = '#8b9197';
          a.beginPath(); a.arc(x + bw / 2, y + bh / 2, Math.min(bw, bh) * 0.38, 0, 6.2832); a.fill();
          a.globalAlpha = 0.22; a.strokeStyle = '#565c62'; a.lineWidth = 1.4;
          for (let k = 1; k <= 3; k++) {
            a.beginPath();
            a.arc(x + bw / 2, y + bh / 2, Math.min(bw, bh) * 0.38 * k / 3.4, 0, 6.2832);
            a.stroke();
          }
          a.globalAlpha = 0.4; a.fillStyle = '#54763a';
          for (let k = 0; k < 4; k++) {
            const ang = (k / 4) * 6.2832 + info.w * 3;
            a.beginPath();
            a.arc(x + bw / 2 + Math.cos(ang) * bw * 0.34,
              y + bh / 2 + Math.sin(ang) * bh * 0.34, bw * 0.07, 0, 6.2832);
            a.fill();
          }
          a.globalAlpha = 1;
        } else if (info.kind === 'lot') {
          a.fillStyle = tint('#5a6066', shade);
          a.fillRect(x + 3, y + 3, bw - 6, bh - 6);
          a.globalAlpha = 0.3; a.strokeStyle = '#cfd5da'; a.lineWidth = 1.1;
          a.beginPath();
          const vert = info.spin % 2 === 0;
          for (let k = 8; k < (vert ? bw : bh) - 6; k += 5) {
            if (vert) {
              a.moveTo(x + k, y + 7); a.lineTo(x + k, y + bh * 0.44);
              a.moveTo(x + k, y + bh * 0.56); a.lineTo(x + k, y + bh - 7);
            } else {
              a.moveTo(x + 7, y + k); a.lineTo(x + bw * 0.44, y + k);
              a.moveTo(x + bw * 0.56, y + k); a.lineTo(x + bw - 7, y + k);
            }
          }
          a.stroke(); a.globalAlpha = 1;
        } else {
          /* built block: lawn around, paved pad under the house */
          const g = Math.min(bw, bh) * (0.11 + info.w * 0.06);
          a.fillStyle = tint('#547239', shade);
          a.fillRect(x + g, y + g, bw - g * 2, bh - g * 2);
          const px = bw * (0.2 + info.d * 0.06), py = bh * (0.2 + info.w * 0.06);
          a.fillStyle = tint('#767c82', shade);
          a.fillRect(x + px, y + py, bw - px * 2, bh - py * 2);
          a.globalAlpha = 0.35; a.strokeStyle = '#bfb694'; a.lineWidth = 2;
          a.beginPath();
          if (info.spin % 2) { a.moveTo(x + bw / 2, y + g); a.lineTo(x + bw / 2, y + bh - g); }
          else { a.moveTo(x + g, y + bh / 2); a.lineTo(x + bw - g, y + bh / 2); }
          a.stroke(); a.globalAlpha = 1;
        }
      }
    }

    /* streets over the blocks; in the mask a soft ridge of three passes */
    for (const [dir, p, q0, q1, main] of streets) {
      const wide = main ? C.street * pxT * 1.15 : C.street * pxT * 0.9;
      a.strokeStyle = main ? '#3a3f44' : '#44494f';
      a.lineWidth = wide;
      a.beginPath();
      if (dir === 'v') { a.moveTo(p, q0); a.lineTo(p, q1); }
      else { a.moveTo(q0, p); a.lineTo(q1, p); }
      a.stroke();
      if (main) {
        a.globalAlpha = 0.5; a.strokeStyle = '#e8d98a'; a.lineWidth = 1.3;
        a.setLineDash([9, 7]);
        a.beginPath();
        if (dir === 'v') { a.moveTo(p, q0); a.lineTo(p, q1); }
        else { a.moveTo(q0, p); a.lineTo(q1, p); }
        a.stroke();
        a.setLineDash([]); a.globalAlpha = 1;
      }
      m.strokeStyle = '#0000ff';
      for (const [mul, alpha] of [[2.1, 0.22], [1.4, 0.45], [0.75, 1]]) {
        m.globalAlpha = alpha * (main ? 1 : 0.75);
        m.lineWidth = Math.max(1.5, wide * kx * mul);
        m.beginPath();
        if (dir === 'v') { m.moveTo(p * kx, q0 * ky); m.lineTo(p * kx, q1 * ky); }
        else { m.moveTo(q0 * kx, p * ky); m.lineTo(q1 * kx, p * ky); }
        m.stroke();
      }
      m.globalAlpha = 1;
    }
  }

  /* ── rivers: albedo + water channel in the mask ── */
  for (const [s0, s1] of CONFIG.SECT.rivers) {
    const cx = X((s0 + s1) / 2), half = (X(s1) - X(s0)) / 2;
    const pts: number[][] = [];
    for (let y = -20; y <= H + 20; y += 24) pts.push([cx + Math.sin(y * 0.011 + s0) * half * 0.55 + (rnd() - .5) * 6, y]);
    const stroke = (ctx: Context2D, w: number, col: string, sx: number, sy: number): void => {
      ctx.strokeStyle = col; ctx.lineWidth = w; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      smoothLine(ctx, pts, sx, sy);
    };
    stroke(a, half * 2 + 22, '#a8a173', 1, 1);
    stroke(a, half * 2 + 11, '#7f9a55', 1, 1);
    stroke(a, half * 2 - 2, '#3a5c47', 1, 1);
    stroke(a, half * 1.5, '#2c4c5e', 1, 1);
    a.globalAlpha = 0.35; stroke(a, half * 0.7, '#20384a', 1, 1); a.globalAlpha = 1;
    /* water mask in three passes: R becomes depth (0 at the bank, 1 mid-stream) */
    const kw = M.c.width / W, kh = mh / H;
    stroke(m, (half * 2 - 4) * kw, '#330000', kw, kh);
    stroke(m, (half * 1.45) * kw, '#990000', kw, kh);
    stroke(m, (half * 0.75) * kw, '#ff0000', kw, kh);
  }

  /* ── technical rim at the end caps ── */
  const edge = H * 0.022;
  a.fillStyle = '#6a6d72'; a.fillRect(0, 0, W, edge); a.fillRect(0, H - edge, W, edge);
  m.fillStyle = '#000040';
  m.fillRect(0, 0, M.c.width, edge / H * mh); m.fillRect(0, mh - edge / H * mh, M.c.width, edge / H * mh);
  a.globalAlpha = 0.5; a.strokeStyle = '#3a3e44'; a.lineWidth = 2;
  for (let x = 0; x < W; x += W / CONFIG.HULL_SEG) {
    a.beginPath(); a.moveTo(x, 0); a.lineTo(x, edge); a.moveTo(x, H - edge); a.lineTo(x, H); a.stroke();
  }
  a.globalAlpha = 1;

  if (opts.debugUvMarker) { a.fillStyle = '#ff0033'; a.fillRect(X(0), 0, X(10) - X(0), H); }

  /* ─── ponds: plain fills like the rivers (not additive) ─── */
  for (const p of ponds) {
    const u = ((p.t / TAU_2D) % 1 + 1) % 1;
    const v = p.z / CONFIG.L + 0.5;
    const ellipse = (ctx: Context2D, size2: number, rr: number, fill: string): void => {
      const rxp = p.r * rr * p.ax / (TAU_2D * CONFIG.R) * size2;
      const ryp = p.r * rr / p.ax / CONFIG.L * size2;
      const big = Math.max(rxp, ryp);
      ctx.save();
      ctx.translate(u * size2, v * size2);
      ctx.rotate(p.rot);
      ctx.scale(rxp / big, ryp / big);
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.arc(0, 0, big, 0, TAU_2D);
      ctx.fill();
      ctx.restore();
    };

    /* smooth shore/depth gradient from many translucent rings */
    const band = (ctx: Context2D, size2: number, from: number, to: number,
      colFrom: number[], colTo: number[], steps: number): void => {
      for (let k = 0; k <= steps; k++) {
        const uu = k / steps;
        const rr = from + (to - from) * uu;
        const mix = colFrom.map((vv, i) => Math.round(vv + (colTo[i] - vv) * uu));
        ctx.globalAlpha = 0.5;
        ellipse(ctx, size2, rr, `rgb(${mix[0]},${mix[1]},${mix[2]})`);
      }
      ctx.globalAlpha = 1;
    };

    band(a, W, 1.22, 1.02, [168, 161, 115], [122, 148, 88], 6);
    band(a, W, 1.02, 0.5, [58, 92, 71], [32, 56, 74], 12);
    band(m, M.c.width, 1.0, 0.42, [40, 0, 0], [255, 0, 0], 14);
  }

  return { albedo: A.c, mask: M.c };
}
