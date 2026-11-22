/* City textures — line-for-line ports of js/textures.js makeFacade,
   makeRoofTexture, makeCarWindows (same rnd() order and constants). */

import type { RasterCanvas } from '../raster/index.ts';
import { CORE_CONFIG } from '../config/index.ts';
import { pick } from '../rng.ts';
import type { Rng } from '../rng.ts';
import { cv, TAU_2D } from './common.ts';

/** Building facade (4 variants) + a paired lit-window mask with the same UVs. */
export function makeFacade(rnd: Rng, variant: number): { map: RasterCanvas; emis: RasterCanvas } {
  const W = 256, H = 256;
  const a = cv(W, H), b = cv(W, H);
  const base = ['#8d949c', '#7a838d', '#98a0a8', '#a08a7c'][variant];
  a.g.fillStyle = base; a.g.fillRect(0, 0, W, H);
  b.g.fillStyle = '#000'; b.g.fillRect(0, 0, W, H);

  /* vertical pilasters */
  a.g.globalAlpha = 0.16;
  for (let x = 0; x < W; x += 18) {
    a.g.fillStyle = rnd() < 0.5 ? '#ffffff' : '#20262e';
    a.g.fillRect(x, 0, 3, H);
  }
  a.g.globalAlpha = 1;

  /* top 12 % — the roof band (roofUV in world.js maps horizontal faces here) */
  const ROOF = Math.round(H * 0.12);
  a.g.fillStyle = '#6f7580'; a.g.fillRect(0, 0, W, ROOF);
  for (let i = 0; i < 260; i++) {
    a.g.fillStyle = pick(rnd, ['#7b818c', '#646a74', '#868d98', '#5b616a']);
    a.g.fillRect(rnd() * W, rnd() * ROOF, 2 + rnd() * 9, 2 + rnd() * 7);
  }
  for (let x = 4; x < W - 6; x += 21) {
    const hh = 7 + (rnd() * 5 | 0);
    a.g.fillStyle = '#4d535c'; a.g.fillRect(x, 5, 15, hh);
    a.g.fillStyle = 'rgba(255,255,255,.14)'; a.g.fillRect(x, 5, 15, 1.5);
    a.g.fillStyle = 'rgba(25,30,38,.55)';
    for (let s = 0; s < hh - 2; s += 3) a.g.fillRect(x + 1, 7 + s, 13, 1.4);
  }
  a.g.strokeStyle = 'rgba(35,40,48,.45)'; a.g.lineWidth = 1.5;
  for (let x = 0; x < W; x += 32) { a.g.beginPath(); a.g.moveTo(x, 0); a.g.lineTo(x, ROOF); a.g.stroke(); }
  a.g.fillStyle = 'rgba(30,36,44,.5)'; a.g.fillRect(0, ROOF - 3, W, 3);
  for (let i = 0; i < 3; i++) {
    const x = 12 + rnd() * (W - 24), y = 4 + rnd() * (ROOF - 10);
    a.g.fillStyle = '#8a3a30'; a.g.fillRect(x, y, 3, 3);
    b.g.fillStyle = '#ff5a3c'; b.g.fillRect(x, y, 3, 3);
  }

  const cols = [8, 7, 9, 8][variant], rows = CORE_CONFIG.BLD[variant].rows;
  const mx = 10, my = ROOF + 8;
  const cw = (W - mx * 2) / cols, ch = (H - my - 14) / rows;
  const ww = cw * 0.66, wh = ch * 0.52;
  const glow = ['#ffd9a0', '#ffc477', '#ffeccb', '#f0dcbc', '#cfe0f2'];
  for (let r = 0; r < rows; r++) {
    if (r % 3 === 0) {
      a.g.fillStyle = 'rgba(30,40,54,.28)';
      a.g.fillRect(0, my + r * ch - 2, W, 3);
    }
    for (let c2 = 0; c2 < cols; c2++) {
      const x = mx + c2 * cw + (cw - ww) / 2, y = my + r * ch + (ch - wh) / 2;
      a.g.fillStyle = pick(rnd, ['#2b3644', '#354252', '#222b36', '#3d4c5e']);
      a.g.fillRect(x, y, ww, wh);
      a.g.fillStyle = 'rgba(255,255,255,.14)';
      a.g.fillRect(x, y, ww, 1.5);
      if (rnd() < 0.4) {
        b.g.fillStyle = pick(rnd, glow);
        b.g.fillRect(x, y, ww, wh);
      }
    }
  }
  /* soft contact darkening over the bottom eighth of the wall */
  const foot = Math.round(H * 0.13);
  for (let y = 0; y < foot; y++) {
    const k = y / foot;
    a.g.fillStyle = `rgba(14,19,26,${(0.62 * Math.pow(1 - k, 1.7)).toFixed(3)})`;
    a.g.fillRect(0, H - foot + y, W, 1);
  }
  a.g.fillStyle = 'rgba(20,26,34,.5)';
  a.g.fillRect(0, H - 3, W, 3);

  return { map: a.c, emis: b.c };
}

/** Roof: felt strips, puddle stains, vents, pipes, parapet. */
export function makeRoofTexture(rnd: Rng): RasterCanvas {
  const S = 256, { c, g } = cv(S, S);
  const base = 52 + Math.floor(rnd() * 16);
  g.fillStyle = `rgb(${base},${base + 3},${base + 6})`;
  g.fillRect(0, 0, S, S);

  for (let y = 0; y < S; y += 26) {
    const v = base + 6 + Math.floor(rnd() * 12);
    g.fillStyle = `rgb(${v},${v + 3},${v + 6})`;
    g.fillRect(0, y, S, 24);
    g.fillStyle = 'rgba(20,24,30,.35)';
    g.fillRect(0, y + 24, S, 2);
  }

  for (let i = 0; i < 26; i++) {
    const x = rnd() * S, y = rnd() * S, r = 8 + rnd() * 34;
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, 'rgba(28,34,42,.30)');
    gr.addColorStop(1, 'rgba(28,34,42,0)');
    g.fillStyle = gr;
    g.beginPath(); g.arc(x, y, r, 0, TAU_2D); g.fill();
  }

  for (let i = 0; i < 22; i++) {
    const w = 8 + rnd() * 26, h = 8 + rnd() * 22;
    const x = rnd() * (S - w), y = rnd() * (S - h);
    const v = 96 + Math.floor(rnd() * 46);
    g.fillStyle = `rgb(${v},${v + 4},${v + 10})`;
    g.fillRect(x, y, w, h);
    g.fillStyle = 'rgba(255,255,255,.14)';
    g.fillRect(x, y, w, 1.5);
    g.fillStyle = 'rgba(16,20,26,.45)';
    g.fillRect(x, y + h - 2, w, 2);
    if (w > 18) {
      g.fillStyle = 'rgba(18,22,28,.45)';
      for (let k = 3; k < w - 2; k += 4) g.fillRect(x + k, y + 3, 1.5, h - 7);
    }
  }

  g.strokeStyle = 'rgba(120,128,138,.55)';
  g.lineWidth = 2.5;
  for (let i = 0; i < 7; i++) {
    g.beginPath();
    const y = rnd() * S;
    g.moveTo(0, y);
    g.lineTo(S, y + (rnd() - 0.5) * 26);
    g.stroke();
  }

  g.strokeStyle = 'rgba(150,158,168,.6)';
  g.lineWidth = 5;
  g.strokeRect(2.5, 2.5, S - 5, S - 5);
  return c;
}

/** Window strip on a car body (box UVs are 0…1 per face). */
export function makeCarWindows(): RasterCanvas {
  const S = 32, { c, g } = cv(S, S);
  g.fillStyle = '#000'; g.fillRect(0, 0, S, S);
  g.fillStyle = '#cfe0f2';
  g.fillRect(0, S * 0.30, S, S * 0.26);
  g.fillStyle = '#000';
  for (let x = 2; x < S; x += 9) g.fillRect(x, S * 0.30, 2, S * 0.26);
  return c;
}
