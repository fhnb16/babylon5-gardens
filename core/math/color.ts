/* ═══════════════════════════════════════════════════════════════════════════
   color — RGB / HSL with the SAME semantics as THREE.Color in r165.

   • RGB triples are LINEAR working-space floats (number[] / Float32Array).
   • setHex() converts sRGB → linear (THREE.Color.setHex default colour space).
   • setHSL() / getHSL() operate directly on the stored (linear) components —
     THREE's default colorSpace argument is the working space, so no transfer
     function is applied. This is what the legacy `natural()` relies on.
   • Everything computes in doubles; storing into Float32Array rounds, exactly
     like Instance colour buffers do.
   Functions that write take `out` (+ optional offset `o` for packed buffers)
   and return `out`.
   ═══════════════════════════════════════════════════════════════════════════ */

import { clamp, euclideanModulo, lerp as lerpNum } from './scalar.ts';

export type Rgb = number[] | Float32Array | Float64Array;
export interface Hsl { h: number; s: number; l: number }

/** sRGB transfer → linear; identical to THREE SRGBToLinear (and lighting/phases.ts). */
export function srgbToLinear(c: number): number {
  return c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4);
}

/** Linear → sRGB transfer; identical to THREE LinearToSRGB (note the 0.41666 exponent). */
export function linearToSrgb(c: number): number {
  return c < 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 0.41666) - 0.055;
}

/** 0xRRGGBB (sRGB) → linear RGB (THREE.Color.setHex). */
export function setHex(hex: number, out: Rgb = [0, 0, 0], o = 0): Rgb {
  hex = Math.floor(hex);
  out[o] = srgbToLinear(((hex >> 16) & 255) / 255);
  out[o + 1] = srgbToLinear(((hex >> 8) & 255) / 255);
  out[o + 2] = srgbToLinear((hex & 255) / 255);
  return out;
}

/** Linear RGB → 0xRRGGBB (sRGB), rounded and clamped (THREE.Color.getHex). */
export function getHex(c: Rgb, o = 0): number {
  return Math.round(clamp(linearToSrgb(c[o]) * 255, 0, 255)) * 65536 +
    Math.round(clamp(linearToSrgb(c[o + 1]) * 255, 0, 255)) * 256 +
    Math.round(clamp(linearToSrgb(c[o + 2]) * 255, 0, 255));
}

/** Store linear components as-is (THREE.Color.setRGB in the working space). */
export function setRGB(r: number, g: number, b: number, out: Rgb = [0, 0, 0], o = 0): Rgb {
  out[o] = r; out[o + 1] = g; out[o + 2] = b;
  return out;
}

function hue2rgb(p: number, q: number, t: number): number {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * 6 * (2 / 3 - t);
  return p;
}

/** h, s, l in 0..1; written as linear working-space RGB (no transfer function). */
export function setHSL(h: number, s: number, l: number, out: Rgb = [0, 0, 0], o = 0): Rgb {
  h = euclideanModulo(h, 1);
  s = clamp(s, 0, 1);
  l = clamp(l, 0, 1);
  if (s === 0) {
    out[o] = out[o + 1] = out[o + 2] = l;
  } else {
    const p = l <= 0.5 ? l * (1 + s) : l + s - l * s;
    const q = 2 * l - p;
    out[o] = hue2rgb(q, p, h + 1 / 3);
    out[o + 1] = hue2rgb(q, p, h);
    out[o + 2] = hue2rgb(q, p, h - 1 / 3);
  }
  return out;
}

/** Linear working-space RGB → h, s, l in 0..1 (THREE.Color.getHSL, no transfer function). */
export function getHSL(c: Rgb, out: Hsl = { h: 0, s: 0, l: 0 }, o = 0): Hsl {
  const r = c[o], g = c[o + 1], b = c[o + 2];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let hue = 0, saturation = 0;
  const lightness = (min + max) / 2.0;
  if (min !== max) {
    const delta = max - min;
    saturation = lightness <= 0.5 ? delta / (max + min) : delta / (2 - max - min);
    switch (max) {
      case r: hue = (g - b) / delta + (g < b ? 6 : 0); break;
      case g: hue = (b - r) / delta + 2; break;
      default: hue = (r - g) / delta + 4; break;
    }
    hue /= 6;
  }
  out.h = hue; out.s = saturation; out.l = lightness;
  return out;
}

const _hslA: Hsl = { h: 0, s: 0, l: 0 };
const _hslB: Hsl = { h: 0, s: 0, l: 0 };

/** THREE.Color.offsetHSL: out = setHSL(h + dh, s + ds, l + dl) of `c`. */
export function offsetHSL(c: Rgb, dh: number, ds: number, dl: number, out: Rgb = [0, 0, 0], o = 0): Rgb {
  getHSL(c, _hslA);
  return setHSL(_hslA.h + dh, _hslA.s + ds, _hslA.l + dl, out, o);
}

/** Component-wise a + (b - a) * t in linear space (THREE.Color.lerp / lerpColors). */
export function lerp(a: Rgb, b: Rgb, t: number, out: Rgb = [0, 0, 0]): Rgb {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}

/** THREE.MathUtils.lerp: (1 - t) * x + t * y — NOT the same rounding as a + (b - a) * t. */
const mathLerp = (x: number, y: number, t: number): number => (1 - t) * x + t * y;

/** THREE.Color.lerpHSL. */
export function lerpHSL(a: Rgb, b: Rgb, t: number, out: Rgb = [0, 0, 0]): Rgb {
  getHSL(a, _hslA);
  getHSL(b, _hslB);
  return setHSL(mathLerp(_hslA.h, _hslB.h, t), mathLerp(_hslA.s, _hslB.s, t), mathLerp(_hslA.l, _hslB.l, t), out);
}

export function multiplyScalar(c: Rgb, s: number, out: Rgb = [0, 0, 0]): Rgb {
  out[0] = c[0] * s; out[1] = c[1] * s; out[2] = c[2] * s;
  return out;
}

const _nat: Hsl = { h: 0, s: 0, l: 0 };

/**
 * Port of js/util.js `natural`: pull saturation towards grey by `k` and move
 * lightness part-way to 0.42. hex is sRGB; HSL manipulation happens in LINEAR
 * space (like THREE.Color); result is linear RGB, written at `out[o..o+2]`.
 */
export function natural(hex: number, k: number, out: Rgb = [0, 0, 0], o = 0): Rgb {
  setHex(hex, out, o);
  getHSL(out, _nat, o);
  return setHSL(_nat.h, _nat.s * k, lerpNum(0.42, _nat.l, 0.5 + k * 0.5), out, o);
}
