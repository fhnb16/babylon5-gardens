/* Structure textures — line-for-line ports of js/textures.js
   makeEndCapTexture and makePanelTexture (same rnd() order and constants). */

import type { RasterCanvas } from '../raster/index.ts';
import { pick } from '../rng.ts';
import type { Rng } from '../rng.ts';
import { cv, TAU_2D } from './common.ts';

/** End cap: concentric belts split into sections with blocks, lit portholes in `emis`. */
export function makeEndCapTexture(size: number, rnd: Rng): { map: RasterCanvas; emis: RasterCanvas } {
  const S = size, C = S / 2;
  const a = cv(S, S), b = cv(S, S);
  a.g.fillStyle = '#7e848c';
  a.g.beginPath(); a.g.arc(C, C, C, 0, TAU_2D); a.g.fill();
  b.g.fillStyle = '#000'; b.g.fillRect(0, 0, S, S);

  const rings = 22;
  for (let i = rings; i >= 1; i--) {
    const r1 = C * (i / rings), r0 = C * ((i - 1) / rings);
    const seg = Math.max(6, Math.round(i * 2.6));
    for (let k = 0; k < seg; k++) {
      const a0 = (k / seg) * TAU_2D + rnd() * 0.01;
      const a1 = ((k + 1) / seg) * TAU_2D;
      const tone = 0.72 + rnd() * 0.5;
      const v = Math.round(132 * tone);
      a.g.fillStyle = `rgb(${v},${v + 4},${v + 9})`;
      a.g.beginPath();
      a.g.arc(C, C, r1, a0, a1);
      a.g.arc(C, C, r0, a1, a0, true);
      a.g.closePath();
      a.g.fill();

      const blocks = 1 + Math.floor(rnd() * 3);
      for (let m = 0; m < blocks; m++) {
        const rr = r0 + (r1 - r0) * (0.2 + rnd() * 0.6);
        const aa = a0 + (a1 - a0) * (0.15 + rnd() * 0.7);
        const bw = (r1 - r0) * (0.12 + rnd() * 0.3);
        const ba = Math.min((a1 - a0) * 0.7, bw * (0.7 + rnd() * 1.4) / Math.max(1, rr));
        a.g.fillStyle = rnd() < 0.5 ? 'rgba(48,54,62,.5)' : 'rgba(206,214,224,.34)';
        a.g.beginPath();
        a.g.arc(C, C, rr + bw, aa, aa + ba);
        a.g.arc(C, C, rr, aa + ba, aa, true);
        a.g.closePath();
        a.g.fill();
      }

      if (rnd() < 0.1) {
        const rr = r0 + (r1 - r0) * 0.5;
        const side = (r1 - r0) * 0.34;
        const ba = Math.min((a1 - a0) * 0.8, side / Math.max(1, rr));
        const aa = a0 + (a1 - a0) * 0.5 - ba / 2;
        b.g.fillStyle = pick(rnd, ['#ffe6b4', '#cfe0f2', '#ffd08a']);
        b.g.beginPath();
        b.g.arc(C, C, rr + side, aa, aa + ba);
        b.g.arc(C, C, rr, aa + ba, aa, true);
        b.g.closePath();
        b.g.fill();
      }
    }
    a.g.strokeStyle = 'rgba(38,44,52,.42)';
    a.g.lineWidth = 1.4;
    a.g.beginPath(); a.g.arc(C, C, r0, 0, TAU_2D); a.g.stroke();
  }

  for (let k = 0; k < 6; k++) {
    const ang = (k / 6) * TAU_2D + 0.26;
    a.g.save();
    a.g.translate(C, C);
    a.g.rotate(ang);
    a.g.fillStyle = 'rgba(150,158,168,.85)';
    a.g.fillRect(-C * 0.018, -C * 0.96, C * 0.036, C * 0.9);
    a.g.fillStyle = 'rgba(44,50,58,.5)';
    a.g.fillRect(-C * 0.02, -C * 0.96, C * 0.006, C * 0.9);
    a.g.restore();
  }

  a.g.fillStyle = '#6c727a';
  a.g.beginPath(); a.g.arc(C, C, C * 0.085, 0, TAU_2D); a.g.fill();
  a.g.strokeStyle = 'rgba(36,42,50,.6)'; a.g.lineWidth = 2;
  a.g.beginPath(); a.g.arc(C, C, C * 0.085, 0, TAU_2D); a.g.stroke();

  return { map: a.c, emis: b.c };
}

/** Technical hull plating for the axis tube, trusses and tower. */
export function makePanelTexture(rnd: Rng): RasterCanvas {
  const S = 512, { c, g } = cv(S, S);
  g.fillStyle = '#8e959d'; g.fillRect(0, 0, S, S);

  let y = 0;
  while (y < S) {
    const h = 26 + Math.floor(rnd() * 46);
    let x = -Math.floor(rnd() * 60);
    while (x < S) {
      const w = 34 + Math.floor(rnd() * 92);
      const tone = 0.78 + rnd() * 0.42;
      const base = Math.round(150 * tone);
      g.fillStyle = `rgb(${base},${base + 5},${base + 11})`;
      g.fillRect(x, y, w - 1, h - 1);

      g.fillStyle = 'rgba(255,255,255,.10)';
      g.fillRect(x, y, w - 1, 1);
      g.fillRect(x, y, 1, h - 1);
      g.fillStyle = 'rgba(24,30,38,.30)';
      g.fillRect(x, y + h - 2, w - 1, 1);
      g.fillRect(x + w - 2, y, 1, h - 1);
      x += w;
    }
    y += h;
  }

  for (let i = 0; i < 220; i++) {
    const sx = rnd() * S, sy = rnd() * S;
    const len = 12 + rnd() * 90, wdt = 1 + rnd() * 5;
    const gr = g.createLinearGradient(sx, sy, sx, sy + len);
    const dark = rnd() < 0.62;
    gr.addColorStop(0, dark ? 'rgba(38,44,52,.34)' : 'rgba(226,232,240,.20)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr;
    g.fillRect(sx, sy, wdt, len);
  }

  for (let i = 0; i < 130; i++) {
    const x2 = rnd() * S, y2 = rnd() * S;
    const w2 = 5 + rnd() * 22, h2 = 4 + rnd() * 12;
    g.fillStyle = rnd() < 0.5 ? 'rgba(56,64,74,.42)' : 'rgba(196,204,214,.28)';
    g.fillRect(x2, y2, w2, h2);
    g.strokeStyle = 'rgba(30,36,44,.35)'; g.lineWidth = 1;
    g.strokeRect(x2 + 0.5, y2 + 0.5, w2, h2);
  }

  for (let i = 0; i < 700; i++) {
    g.fillStyle = rnd() < 0.5 ? 'rgba(255,255,255,.16)' : 'rgba(28,34,42,.26)';
    g.beginPath(); g.arc(rnd() * S, rnd() * S, 1.2, 0, TAU_2D); g.fill();
  }

  for (let i = 0; i < 18; i++) {
    g.fillStyle = pick(rnd, ['rgba(228,232,238,.30)', 'rgba(40,46,54,.34)',
      'rgba(196,186,150,.22)']);
    g.fillRect(rnd() * S, rnd() * S, 8 + rnd() * 26, 2 + rnd() * 3);
  }
  return c;
}
