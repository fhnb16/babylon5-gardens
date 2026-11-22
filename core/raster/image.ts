/* ═══════════════════════════════════════════════════════════════════════════
   PixelImage: RGBA8 raster, row 0 = top, NON-premultiplied (same layout as
   the DOM ImageData), plus separable resampling used by drawImage().

   Resampling is done in premultiplied float space (like browsers, so fully
   transparent texels do not bleed their colour). Downscale uses an
   area-weighted box filter; upscale uses bilinear (tent) filtering. For the
   exact 2x downscales the generators do, the box filter is identical to what
   Chrome's bilinear drawImage produces.
   ═══════════════════════════════════════════════════════════════════════════ */

export interface PixelImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** 'box' = area average when shrinking, bilinear when enlarging. */
export type ResampleFilter = 'box' | 'bilinear' | 'nearest';

export function createPixelImage(width: number, height: number, data?: Uint8ClampedArray): PixelImage {
  const w = Math.max(0, Math.floor(width)), h = Math.max(0, Math.floor(height));
  if (data && data.length !== w * h * 4) throw new RangeError('PixelImage: data length mismatch');
  return { width: w, height: h, data: data || new Uint8ClampedArray(w * h * 4) };
}

export function copyPixelImage(src: PixelImage): PixelImage {
  return { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data) };
}

/** Per-destination-pixel source taps along one axis. */
export interface AxisWeights {
  /** first source index of each destination pixel's taps */
  start: Int32Array;
  /** number of taps of each destination pixel */
  count: Int32Array;
  /** offset of each destination pixel's weights in `w` */
  offs: Int32Array;
  /** normalized weights */
  w: Float32Array;
  /** smallest / largest source index referenced */
  min: number;
  max: number;
}

/**
 * Taps for destination pixels i in [i0, i1). The destination interval
 * [d0, d1] (device px) maps linearly onto the source interval [s0, s1].
 */
export function axisWeights(
  i0: number, i1: number, d0: number, d1: number, s0: number, s1: number,
  filter: ResampleFilter
): AxisWeights {
  const n = Math.max(0, i1 - i0);
  const start = new Int32Array(n), count = new Int32Array(n), offs = new Int32Array(n);
  const ratio = (s1 - s0) / (d1 - d0);
  const kmin = Math.floor(s0), kmax = Math.max(kmin, Math.ceil(s1) - 1);
  const box = filter === 'box' && ratio > 1;
  const cap = box ? n * (Math.ceil(ratio) + 2) : n * 2;
  const w = new Float32Array(Math.max(1, cap));
  let used = 0, mn = kmax, mx = kmin;
  for (let j = 0; j < n; j++) {
    const pos = s0 + (i0 + j + 0.5 - d0) * ratio;
    offs[j] = used;
    if (filter === 'nearest') {
      const k = Math.min(kmax, Math.max(kmin, Math.floor(pos)));
      start[j] = k; count[j] = 1; w[used++] = 1;
    } else if (box) {
      let lo = pos - ratio / 2, hi = pos + ratio / 2;
      if (lo < s0) lo = s0;
      if (hi > s1) hi = s1;
      if (hi - lo < 1e-9) {
        const k = Math.min(kmax, Math.max(kmin, Math.floor(pos)));
        start[j] = k; count[j] = 1; w[used++] = 1;
      } else {
        const ka = Math.floor(lo), kb = Math.ceil(hi) - 1;
        let sum = 0;
        for (let k = ka; k <= kb; k++) {
          const ww = Math.min(k + 1, hi) - Math.max(k, lo);
          w[used + k - ka] = ww; sum += ww;
        }
        for (let k = ka; k <= kb; k++) w[used + k - ka] /= sum;
        start[j] = ka; count[j] = kb - ka + 1; used += kb - ka + 1;
      }
    } else {
      let u = pos - 0.5;
      if (u < kmin) u = kmin;
      if (u > kmax) u = kmax;
      const k0 = Math.floor(u), f = u - k0;
      if (f > 0 && k0 + 1 <= kmax) {
        start[j] = k0; count[j] = 2; w[used++] = 1 - f; w[used++] = f;
      } else {
        start[j] = k0; count[j] = 1; w[used++] = 1;
      }
    }
    if (start[j] < mn) mn = start[j];
    if (start[j] + count[j] - 1 > mx) mx = start[j] + count[j] - 1;
  }
  return { start, count, offs, w, min: mn, max: mx };
}

/**
 * Receives one destination row: `shade` holds n pixels as r,g,b (0..255,
 * non-premultiplied) and a (0..1, already multiplied by the destination
 * rectangle's edge coverage).
 */
export type ShadeRowSink = (y: number, x0: number, n: number, shade: Float32Array) => void;

/**
 * Resample the source rectangle (sx,sy,sw,sh) onto the device rectangle
 * [X0,X1]x[Y0,Y1] for destination pixels [ix0,ix1)x[iy0,iy1).
 * Fractional destination edges produce partial alpha (anti-aliased edges).
 */
export function resampleRows(
  src: PixelImage, sx: number, sy: number, sw: number, sh: number,
  X0: number, Y0: number, X1: number, Y1: number,
  ix0: number, iy0: number, ix1: number, iy1: number,
  filter: ResampleFilter, sink: ShadeRowSink
): void {
  if (ix1 <= ix0 || iy1 <= iy0 || sw <= 0 || sh <= 0 || X1 <= X0 || Y1 <= Y0) return;
  const wx = axisWeights(ix0, ix1, X0, X1, sx, sx + sw, filter);
  const wy = axisWeights(iy0, iy1, Y0, Y1, sy, sy + sh, filter);
  const n = ix1 - ix0;
  const cmin = Math.max(0, wx.min), cmax = Math.min(src.width - 1, wx.max);
  const span = cmax - cmin + 1;
  if (span <= 0) return;
  const row = new Float32Array(span * 4);
  const shade = new Float32Array(n * 4);
  const covX = new Float32Array(n);
  for (let j = 0; j < n; j++) {
    const x = ix0 + j;
    covX[j] = Math.max(0, Math.min(x + 1, X1) - Math.max(x, X0));
  }
  const sd = src.data, SW = src.width;
  for (let jy = 0; jy < iy1 - iy0; jy++) {
    const y = iy0 + jy;
    const covY = Math.max(0, Math.min(y + 1, Y1) - Math.max(y, Y0));
    if (covY <= 0) continue;
    row.fill(0);
    const ty0 = wy.start[jy], tyn = wy.count[jy], tyo = wy.offs[jy];
    for (let t = 0; t < tyn; t++) {
      const ky = ty0 + t;
      if (ky < 0 || ky >= src.height) continue;
      const wt = wy.w[tyo + t];
      let p = (ky * SW + cmin) * 4;
      for (let q = 0; q < span * 4; q += 4, p += 4) {
        const a = sd[p + 3] * wt * (1 / 255);
        if (a === 0) continue;
        row[q] += sd[p] * a; row[q + 1] += sd[p + 1] * a; row[q + 2] += sd[p + 2] * a; row[q + 3] += a;
      }
    }
    for (let j = 0; j < n; j++) {
      const tx0 = wx.start[j], txn = wx.count[j], txo = wx.offs[j];
      let r = 0, g = 0, b = 0, a = 0;
      for (let t = 0; t < txn; t++) {
        const kx = tx0 + t;
        if (kx < cmin || kx > cmax) continue;
        const wt = wx.w[txo + t], q = (kx - cmin) * 4;
        r += row[q] * wt; g += row[q + 1] * wt; b += row[q + 2] * wt; a += row[q + 3] * wt;
      }
      const o = j * 4;
      if (a > 1e-9) {
        shade[o] = r / a; shade[o + 1] = g / a; shade[o + 2] = b / a;
        shade[o + 3] = Math.min(1, a) * covX[j] * covY;
      } else {
        shade[o] = shade[o + 1] = shade[o + 2] = shade[o + 3] = 0;
      }
    }
    sink(y, ix0, n, shade);
  }
}

/** Whole-image resize (default: box filter when shrinking, bilinear when enlarging). */
export function resamplePixelImage(src: PixelImage, width: number, height: number, filter: ResampleFilter = 'box'): PixelImage {
  const out = createPixelImage(width, height);
  const d = out.data, W = out.width;
  resampleRows(src, 0, 0, src.width, src.height, 0, 0, out.width, out.height, 0, 0, out.width, out.height, filter,
    (y, x0, n, shade) => {
      let p = (y * W + x0) * 4;
      for (let j = 0; j < n * 4; j += 4, p += 4) {
        d[p] = shade[j]; d[p + 1] = shade[j + 1]; d[p + 2] = shade[j + 2]; d[p + 3] = shade[j + 3] * 255;
      }
    });
  return out;
}
