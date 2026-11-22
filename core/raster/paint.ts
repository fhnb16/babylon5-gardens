/* ═══════════════════════════════════════════════════════════════════════════
   Paint: CSS colour parsing, Canvas gradients, per-row shaders.

   Colours are r,g,b in 0..255 (integers) and a in 0..1 quantized to 8 bits
   (Chromium keeps fill colours as 8-bit RGBA). Gradient stops are
   interpolated in non-premultiplied sRGB (Skia's default for canvas
   gradients) and evaluated through a lookup table.
   ═══════════════════════════════════════════════════════════════════════════ */

import type { Mat2D } from './path.ts';
import type { PixelImage } from './image.ts';

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

const NAMED: { [k: string]: number } = {
  black: 0x000000, white: 0xffffff, red: 0xff0000, lime: 0x00ff00, green: 0x008000,
  blue: 0x0000ff, yellow: 0xffff00, cyan: 0x00ffff, aqua: 0x00ffff, magenta: 0xff00ff,
  fuchsia: 0xff00ff, gray: 0x808080, grey: 0x808080, silver: 0xc0c0c0, maroon: 0x800000,
  olive: 0x808000, purple: 0x800080, teal: 0x008080, navy: 0x000080, orange: 0xffa500
};

const NUM = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?(%|deg|rad|turn)?$/;
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const q8 = (a: number): number => Math.round(clamp01(a) * 255) / 255;

function parseComponent(s: string, scale: number): number {
  const m = NUM.exec(s);
  if (!m) return NaN;
  const v = parseFloat(s);
  if (m[3] === '%') return (v / 100) * scale;
  return v;
}

function parseHex(h: string): RGBA | null {
  if (!/^[0-9a-f]+$/.test(h)) return null;
  const x = (i: number, n: number): number => parseInt(h.slice(i, i + n), 16);
  switch (h.length) {
    case 3: return { r: x(0, 1) * 17, g: x(1, 1) * 17, b: x(2, 1) * 17, a: 1 };
    case 4: return { r: x(0, 1) * 17, g: x(1, 1) * 17, b: x(2, 1) * 17, a: (x(3, 1) * 17) / 255 };
    case 6: return { r: x(0, 2), g: x(2, 2), b: x(4, 2), a: 1 };
    case 8: return { r: x(0, 2), g: x(2, 2), b: x(4, 2), a: x(6, 2) / 255 };
    default: return null;
  }
}

function hueToRgb(p: number, q: number, t: number): number {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function parseFunctional(fn: string, body: string): RGBA | null {
  let parts: string[];
  let alpha: string | undefined;
  if (body.indexOf(',') >= 0) {
    parts = body.split(',').map(s => s.trim());
    if (parts.length === 4) alpha = parts.pop();
  } else {
    const slash = body.split('/');
    if (slash.length > 2) return null;
    parts = slash[0].trim().split(/\s+/);
    if (slash.length === 2) alpha = slash[1].trim();
  }
  if (parts.length !== 3) return null;
  let a = 1;
  if (alpha !== undefined) {
    a = parseComponent(alpha, 1);
    if (!isFinite(a)) return null;
  }
  if (fn === 'rgb' || fn === 'rgba') {
    const c = parts.map(p => parseComponent(p, 255));
    if (!c.every(isFinite)) return null;
    const ch = (v: number): number => Math.round(Math.max(0, Math.min(255, v)));
    return { r: ch(c[0]), g: ch(c[1]), b: ch(c[2]), a: q8(a) };
  }
  // hsl / hsla
  let h = parseFloat(parts[0]);
  if (!NUM.test(parts[0]) || /%$/.test(parts[0])) return null;
  if (/rad$/.test(parts[0])) h = (h * 180) / Math.PI;
  else if (/turn$/.test(parts[0])) h *= 360;
  if (!/%$/.test(parts[1]) || !/%$/.test(parts[2])) return null;
  const s = clamp01(parseComponent(parts[1], 1)), l = clamp01(parseComponent(parts[2], 1));
  if (!isFinite(h) || !isFinite(s) || !isFinite(l)) return null;
  h = (((h % 360) + 360) % 360) / 360;
  let r: number, g: number, b: number;
  if (s === 0) r = g = b = l;
  else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    r = hueToRgb(p, q, h + 1 / 3); g = hueToRgb(p, q, h); b = hueToRgb(p, q, h - 1 / 3);
  }
  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255), a: q8(a) };
}

function parseColorUncached(input: string): RGBA | null {
  const s = input.trim().toLowerCase();
  if (s[0] === '#') {
    const c = parseHex(s.slice(1));
    if (c) c.a = q8(c.a);
    return c;
  }
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const named = NAMED[s];
  if (named !== undefined) return { r: named >> 16, g: (named >> 8) & 255, b: named & 255, a: 1 };
  const m = /^(rgba?|hsla?)\((.*)\)$/.exec(s);
  if (!m) return null;
  return parseFunctional(m[1], m[2]);
}

const CACHE_LIMIT = 4096;
let cache = new Map<string, RGBA | null>();

/**
 * Parse a CSS colour (#rgb, #rgba, #rrggbb, #rrggbbaa, rgb(), rgba(), hsl(),
 * hsla(), a few named colours, 'transparent'). Returns null when invalid —
 * Canvas then ignores the assignment. The returned object is shared: do not
 * mutate it.
 */
export function parseColor(input: string): RGBA | null {
  let c = cache.get(input);
  if (c !== undefined) return c;
  c = parseColorUncached(input);
  if (cache.size >= CACHE_LIMIT) cache = new Map();
  cache.set(input, c);
  return c;
}

/** Serialize like browsers do: '#rrggbb' when opaque, otherwise 'rgba(r, g, b, a)'. */
export function colorToString(c: RGBA): string {
  if (c.a >= 1) {
    const h = (v: number): string => (v < 16 ? '0' : '') + v.toString(16);
    return '#' + h(c.r) + h(c.g) + h(c.b);
  }
  /* shortest decimal that maps back to the same 8-bit alpha, like Chromium */
  const a8 = Math.round(c.a * 255);
  let a = Math.round(c.a * 100) / 100;
  if (Math.round(a * 255) !== a8) a = Math.round(c.a * 1000) / 1000;
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${a})`;
}

/* ───────────────────────────── gradients ───────────────────────────── */

const LUT_SIZE = 1024;

interface Stop {
  offset: number;
  color: RGBA;
}

/** Equivalent of CanvasGradient (linear or two-circle radial). */
export class RasterGradient {
  declare readonly kind: 'linear' | 'radial';
  /** linear: x0,y0,x1,y1; radial: x0,y0,r0,x1,y1,r1 */
  declare readonly coords: number[];
  declare private stops: Stop[];
  declare private lut: Float32Array | null;

  constructor(kind: 'linear' | 'radial', coords: number[]) {
    this.kind = kind;
    this.coords = coords.slice();
    this.stops = [];
    this.lut = null;
  }

  addColorStop(offset: number, color: string): void {
    if (!isFinite(offset) || offset < 0 || offset > 1) throw new RangeError('IndexSizeError: offset outside [0, 1]');
    const c = parseColor(color);
    if (!c) throw new SyntaxError(`SyntaxError: invalid colour '${color}'`);
    let i = this.stops.length;
    while (i > 0 && this.stops[i - 1].offset > offset) i--;
    this.stops.splice(i, 0, { offset, color: c });
    this.lut = null;
  }

  get stopCount(): number {
    return this.stops.length;
  }

  /** LUT_SIZE entries of r,g,b (0..255), a (0..1). */
  getLut(): Float32Array {
    if (this.lut) return this.lut;
    const L = new Float32Array(LUT_SIZE * 4);
    const st = this.stops;
    for (let i = 0; i < LUT_SIZE; i++) {
      const t = i / (LUT_SIZE - 1);
      let c0: RGBA, c1: RGBA, f = 0;
      if (t <= st[0].offset) { c0 = c1 = st[0].color; }
      else if (t >= st[st.length - 1].offset) { c0 = c1 = st[st.length - 1].color; }
      else {
        let k = 0;
        while (k + 1 < st.length && st[k + 1].offset <= t) k++;
        const a = st[k], b = st[k + 1];
        c0 = a.color; c1 = b.color;
        f = b.offset > a.offset ? (t - a.offset) / (b.offset - a.offset) : 1;
      }
      L[i * 4] = c0.r + (c1.r - c0.r) * f;
      L[i * 4 + 1] = c0.g + (c1.g - c0.g) * f;
      L[i * 4 + 2] = c0.b + (c1.b - c0.b) * f;
      L[i * 4 + 3] = c0.a + (c1.a - c0.a) * f;
    }
    this.lut = L;
    return L;
  }
}

/* ───────────────────────────── shaders ───────────────────────────── */

/**
 * Source colour per device pixel. `solid` non-null means a constant colour
 * (fast path). Otherwise shadeRow fills out[i*4..] with r,g,b (0..255) and
 * a (0..1) for pixel centres (x0+i+0.5, y+0.5).
 */
export interface Shader {
  solid: RGBA | null;
  shadeRow(y: number, x0: number, n: number, out: Float32Array): void;
}

export function solidShader(c: RGBA): Shader {
  return { solid: c, shadeRow: () => { /* unused for solid shaders */ } };
}

/**
 * Shader sampling `img`'s rectangle (sx,sy,sw,sh) mapped onto the user-space
 * rectangle (dx,dy,dw,dh); `inv` maps device → user. Bilinear (or nearest)
 * in premultiplied space, clamped to the source rectangle. Used by
 * drawImage under rotating/skewing transforms.
 */
export function imageShader(img: PixelImage, sx: number, sy: number, sw: number, sh: number,
  dx: number, dy: number, dw: number, dh: number, inv: Mat2D, nearest: boolean): Shader {
  const [ia, ib, ic, id, ie, iff] = inv;
  const kx = sw / dw, ky = sh / dh;
  const xmin = Math.floor(sx), xmax = Math.max(xmin, Math.ceil(sx + sw) - 1);
  const ymin = Math.floor(sy), ymax = Math.max(ymin, Math.ceil(sy + sh) - 1);
  const D = img.data, W = img.width;
  return {
    solid: null,
    shadeRow(y, xs, n, out) {
      const py = y + 0.5;
      for (let i = 0; i < n; i++) {
        const px = xs + i + 0.5, o = i * 4;
        const ux = ia * px + ic * py + ie, uy = ib * px + id * py + iff;
        let s = sx + (ux - dx) * kx, t = sy + (uy - dy) * ky;
        if (nearest) {
          const X = Math.min(xmax, Math.max(xmin, Math.floor(s))), Y = Math.min(ymax, Math.max(ymin, Math.floor(t)));
          const p = (Y * W + X) * 4;
          out[o] = D[p]; out[o + 1] = D[p + 1]; out[o + 2] = D[p + 2]; out[o + 3] = D[p + 3] / 255;
          continue;
        }
        s -= 0.5; t -= 0.5;
        if (s < xmin) s = xmin; if (s > xmax) s = xmax;
        if (t < ymin) t = ymin; if (t > ymax) t = ymax;
        const x0 = Math.floor(s), y0 = Math.floor(t);
        const x1 = Math.min(xmax, x0 + 1), y1 = Math.min(ymax, y0 + 1);
        const fx = s - x0, fy = t - y0;
        let r = 0, g = 0, b = 0, a = 0;
        for (let k = 0; k < 4; k++) {
          const w = (k & 1 ? fx : 1 - fx) * (k & 2 ? fy : 1 - fy);
          if (w <= 0) continue;
          const p = ((k & 2 ? y1 : y0) * W + (k & 1 ? x1 : x0)) * 4, aw = D[p + 3] * w / 255;
          r += D[p] * aw; g += D[p + 1] * aw; b += D[p + 2] * aw; a += aw;
        }
        if (a > 1e-9) { out[o] = r / a; out[o + 1] = g / a; out[o + 2] = b / a; out[o + 3] = a; }
        else out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
      }
    }
  };
}

/**
 * Shader for a gradient drawn under device→user matrix `inv` (the inverse
 * of the CTM at draw time). Returns null when the gradient paints nothing
 * (no stops, or degenerate geometry — Canvas then draws nothing).
 */
export function gradientShader(g: RasterGradient, inv: Mat2D): Shader | null {
  if (g.stopCount === 0) return null;
  const lut = g.getLut();
  const N1 = LUT_SIZE - 1;
  const k = g.coords;
  const [ia, ib, ic, id, ie, iff] = inv;
  if (g.kind === 'linear') {
    const x0 = k[0], y0 = k[1], dx = k[2] - k[0], dy = k[3] - k[1];
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return null;
    return {
      solid: null,
      shadeRow(y, xs, n, out) {
        const py = y + 0.5;
        for (let i = 0; i < n; i++) {
          const px = xs + i + 0.5;
          const ux = ia * px + ic * py + ie - x0, uy = ib * px + id * py + iff - y0;
          let t = (ux * dx + uy * dy) / len2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const li = ((t * N1 + 0.5) | 0) * 4, o = i * 4;
          out[o] = lut[li]; out[o + 1] = lut[li + 1]; out[o + 2] = lut[li + 2]; out[o + 3] = lut[li + 3];
        }
      }
    };
  }
  const x0 = k[0], y0 = k[1], r0 = k[2];
  const cdx = k[3] - x0, cdy = k[4] - y0, dr = k[5] - r0;
  if (cdx === 0 && cdy === 0 && dr === 0) return null;
  const A = cdx * cdx + cdy * cdy - dr * dr;
  return {
    solid: null,
    shadeRow(y, xs, n, out) {
      const py = y + 0.5;
      for (let i = 0; i < n; i++) {
        const px = xs + i + 0.5;
        const pdx = ia * px + ic * py + ie - x0, pdy = ib * px + id * py + iff - y0;
        const B = pdx * cdx + pdy * cdy + r0 * dr;
        const C = pdx * pdx + pdy * pdy - r0 * r0;
        let w = NaN;
        if (Math.abs(A) < 1e-12) {
          if (B !== 0) {
            w = C / (2 * B);
            if (r0 + w * dr < 0) w = NaN;
          }
        } else {
          const D = B * B - A * C;
          if (D >= 0) {
            const s = Math.sqrt(D);
            const w1 = (B + s) / A, w2 = (B - s) / A;
            const hi = w1 > w2 ? w1 : w2, lo = w1 > w2 ? w2 : w1;
            if (r0 + hi * dr >= 0) w = hi;
            else if (r0 + lo * dr >= 0) w = lo;
          }
        }
        const o = i * 4;
        if (w !== w) { out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0; continue; }
        const t = w < 0 ? 0 : w > 1 ? 1 : w;
        const li = ((t * N1 + 0.5) | 0) * 4;
        out[o] = lut[li]; out[o + 1] = lut[li + 1]; out[o + 2] = lut[li + 2]; out[o + 3] = lut[li + 3];
      }
    }
  };
}
