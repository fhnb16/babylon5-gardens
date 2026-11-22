/* ═══════════════════════════════════════════════════════════════════════════
   Normal map from a finished albedo (port of js/textures.js heightToNormal).

   Height = luma of the albedo; central differences with wrap-around (the
   textures tile). The source is first drawn into a w×h canvas with
   drawImage, exactly like the legacy code — that is the downscale step when
   `size` is smaller than the source.
   ═══════════════════════════════════════════════════════════════════════════ */

import type { ImageSource, RasterCanvas } from '../raster/index.ts';
import { cv } from './common.ts';

export function heightToNormal(srcCanvas: ImageSource, strength = 1, size = 0): RasterCanvas {
  const w = size || srcCanvas.width, h = size || srcCanvas.height;
  const { c, g } = cv(w, h);
  g.drawImage(srcCanvas, 0, 0, w, h);
  const src = g.getImageData(0, 0, w, h).data;
  const out = g.createImageData(w, h);
  const d = out.data;

  const H = (x: number, y: number): number => {
    const i = ((((y % h) + h) % h) * w + (((x % w) + w) % w)) * 4;
    return (src[i] * 0.299 + src[i + 1] * 0.587 + src[i + 2] * 0.114) / 255;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (H(x + 1, y) - H(x - 1, y)) * strength;
      const dy = (H(x, y + 1) - H(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * w + x) * 4;
      d[i] = (-dx / len * 0.5 + 0.5) * 255;
      d[i + 1] = (-dy / len * 0.5 + 0.5) * 255;
      d[i + 2] = (1 / len * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  g.putImageData(out, 0, 0);
  return c;
}
