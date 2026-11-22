/* Detail noise and foliage — line-for-line ports of js/textures.js
   makeDetailTexture / makeLeafTexture (same rnd() order and constants). */

import type { RasterCanvas } from '../raster/index.ts';
import type { Rng } from '../rng.ts';
import { cv, TAU_2D } from './common.ts';

/** Detail noise, tiled 70×70 over the hull (grass fibres + large blotches). */
export function makeDetailTexture(rnd: Rng): RasterCanvas {
  const S = 256, { c, g } = cv(S, S);
  g.fillStyle = '#808080'; g.fillRect(0, 0, S, S);
  for (let i = 0; i < 5000; i++) {
    const x = rnd() * S, y = rnd() * S, len = 2 + rnd() * 6, ang = rnd() * Math.PI;
    g.strokeStyle = rnd() < 0.5 ? 'rgba(255,255,255,.22)' : 'rgba(0,0,0,.22)';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(x, y);
    g.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    g.stroke();
  }
  for (let i = 0; i < 90; i++) {
    g.fillStyle = rnd() < 0.5 ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.1)';
    g.beginPath();
    g.ellipse(rnd() * S, rnd() * S, 6 + rnd() * 26, 6 + rnd() * 26, 0, 0, 6.2832);
    g.fill();
  }
  return c;
}

/** Crown silhouette on a transparent background + leaf strokes + trunk. */
export function makeLeafTexture(rnd: Rng): RasterCanvas {
  const S = 256, { c, g } = cv(S, S);
  g.clearRect(0, 0, S, S);

  const blobs: number[][] = [];
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * TAU_2D + rnd() * 0.5;
    const rr = S * (0.16 + rnd() * 0.14);
    blobs.push([S / 2 + Math.cos(a) * S * 0.2 * rnd(),
      S * 0.42 + Math.sin(a) * S * 0.18 * rnd(), rr]);
  }
  g.fillStyle = '#5c8a3a';
  for (const [x, y, rr] of blobs) {
    g.beginPath(); g.arc(x, y, rr, 0, TAU_2D); g.fill();
  }

  for (let i = 0; i < 900; i++) {
    const b = blobs[(rnd() * blobs.length) | 0];
    const a = rnd() * TAU_2D, d = rnd() * b[2];
    const x = b[0] + Math.cos(a) * d, y = b[1] + Math.sin(a) * d;
    const v = 60 + rnd() * 90;
    g.fillStyle = `rgba(${(v * 0.55) | 0},${v},${(v * 0.42) | 0},.75)`;
    g.save();
    g.translate(x, y);
    g.rotate(rnd() * TAU_2D);
    g.beginPath();
    g.ellipse(0, 0, 2 + rnd() * 5, 1 + rnd() * 2.4, 0, 0, TAU_2D);
    g.fill();
    g.restore();
  }

  g.fillStyle = '#6b5236';
  g.fillRect(S / 2 - S * 0.022, S * 0.55, S * 0.044, S * 0.42);
  return c;
}
