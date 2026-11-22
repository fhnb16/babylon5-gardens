/* Water maps derived from the hull mask — ports of js/textures.js
   makeWaterRoughness / makeWaterNormal. Both first drawImage the mask into
   a size×size canvas (the legacy downscale step), then work per pixel. */

import type { ImageSource, RasterCanvas } from '../raster/index.ts';
import { cv } from './common.ts';
import { heightToNormal } from './normals.ts';

/** R = water fraction (mirror film), G = roughness (three reads it from G). */
export function makeWaterRoughness(mask: ImageSource, size: number): RasterCanvas {
  const { c, g } = cv(size, size);
  g.drawImage(mask, 0, 0, size, size);
  const d = g.getImageData(0, 0, size, size);
  const px = d.data;
  for (let i = 0; i < px.length; i += 4) {
    const water = px[i] / 255;
    const wet = Math.min(1, Math.max(0, (water - 0.04) / 0.10));
    const s = wet * wet * (3 - 2 * wet);
    px[i] = Math.round(s * 255);
    px[i + 1] = Math.round((0.95 - s * 0.90) * 255);
    px[i + 2] = 0;
    px[i + 3] = 255;
  }
  g.putImageData(d, 0, 0);
  return c;
}

/** Ripple normal map: five sine waves scaled by water depth, then heightToNormal. */
export function makeWaterNormal(mask: ImageSource, size: number, strength: number): RasterCanvas {
  const { c, g } = cv(size, size);
  g.drawImage(mask, 0, 0, size, size);
  const src = g.getImageData(0, 0, size, size).data;
  const out = g.createImageData(size, size);
  const d = out.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const water = src[i] / 255;
      const u = x / size * Math.PI * 2, v = y / size * Math.PI * 2;
      let h = 0;
      h += Math.sin(u * 120 + v * 14) * 0.5;
      h += Math.sin(u * 74 - v * 31) * 0.36;
      h += Math.sin(u * 191 + v * 7) * 0.24;
      h += Math.sin(v * 143 + u * 5) * 0.3;
      h += Math.sin(u * 47 + v * 61) * 0.2;
      const val = 128 + h * 60 * water;
      d[i] = d[i + 1] = d[i + 2] = Math.max(0, Math.min(255, val));
      d[i + 3] = 255;
    }
  }
  g.putImageData(out, 0, 0);
  return heightToNormal(c, strength, size);
}
