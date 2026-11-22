/* Sprites and decals — line-for-line ports of js/textures.js makeSoftSprite,
   makeBlobTexture, makeFootprintTexture, makeGlowTexture. No randomness. */

import type { RasterCanvas } from '../raster/index.ts';
import { cv } from './common.ts';

/** Soft round particle sprite; `hardness` moves the mid stop outwards. */
export function makeSoftSprite(hardness = 0): RasterCanvas {
  const S = 128, { c, g } = cv(S, S);
  const gr = g.createRadialGradient(S / 2, S / 2, S * 0.02, S / 2, S / 2, S / 2);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.25 + hardness * 0.4, 'rgba(255,255,255,.55)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, S, S);
  return c;
}

/** Contact-shadow blob. */
export function makeBlobTexture(): RasterCanvas {
  const S = 128, { c, g } = cv(S, S);
  const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  gr.addColorStop(0, 'rgba(0,0,0,.78)');
  gr.addColorStop(0.42, 'rgba(0,0,0,.44)');
  gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, S, S);
  return c;
}

/** Building footprint shadow: sharp across the street, long along the axis. */
export function makeFootprintTexture(): RasterCanvas {
  const S = 256, { c, g } = cv(S, S);
  const px = S / 2, py = S / 2;
  const halfX = S * 0.42, halfY = S * 0.21;
  g.clearRect(0, 0, S, S);
  for (let y = 0; y < S; y++) {
    const dy = Math.abs(y - py) / halfY;
    const fy = dy <= 1 ? 1 : Math.max(0, 1 - (dy - 1) / 1.35);
    if (fy <= 0) continue;
    for (let x = 0; x < S; x++) {
      const dx = Math.abs(x - px) / halfX;
      const fx = dx <= 1 ? 1 : Math.max(0, 1 - (dx - 1) / 0.16);
      if (fx <= 0) continue;
      let a2 = fx * fy * fy;
      const edge = Math.max(dx, dy);
      if (edge > 0.62 && edge <= 1.04) a2 = Math.min(1, a2 * 1.25);
      g.fillStyle = `rgba(0,0,0,${(a2 * 0.82).toFixed(3)})`;
      g.fillRect(x, y, 1, 1);
    }
  }
  return c;
}

/** Horizontal glow strip for the sun tube. */
export function makeGlowTexture(): RasterCanvas {
  const W = 64, H = 8, { c, g } = cv(W, H);
  const gr = g.createLinearGradient(0, 0, W, 0);
  gr.addColorStop(0, 'rgba(255,255,255,0)');
  gr.addColorStop(0.5, 'rgba(255,255,255,1)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, W, H);
  return c;
}
