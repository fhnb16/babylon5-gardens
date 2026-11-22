/* Contrast-adaptive sharpen — TSL port of SHARP_FRAG (js/photo.js).

   The sharpen half of the classic FSR-style chain: an unsharp mask over the
   4-neighbour cross whose strength follows local contrast, so flat areas
   (where a lift would only raise grain) are left alone. Not AMD's RCAS
   proper (three r187 ships that inside `fsr1()` / `sharpen()`).

   `src` is a texture node at OUTPUT resolution (the upscaled image), the
   result is evaluated at `uvOut`; `amount` is a float node (uniform). */
import { vec2, vec3, float, clamp, min, max, dot, uv } from 'three/tsl';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TslNode = any;

const LUMA = [0.2126, 0.7152, 0.0722] as const;
/** Contrast → strength gain (SHARP_FRAG: clamp((mx − mn) · 4, 0, 1)). */
const CONTRAST_GAIN = 4.0;

const lum = (c: TslNode): TslNode => dot(c, vec3(...LUMA));

/** Sharpened linear colour of `src` at `uvOut`. */
export function rcas(src: TslNode, amount: TslNode, uvOut: TslNode = uv()): TslNode {
  const px = vec2(1.0).div(vec2(src.size())).toVar();
  const c = src.sample(uvOut).rgb.toVar();
  const n = src.sample(uvOut.add(vec2(0.0, px.y.negate()))).rgb.toVar();
  const s = src.sample(uvOut.add(vec2(0.0, px.y))).rgb.toVar();
  const w = src.sample(uvOut.add(vec2(px.x.negate(), 0.0))).rgb.toVar();
  const e = src.sample(uvOut.add(vec2(px.x, 0.0))).rgb.toVar();

  const lc = lum(c), ln = lum(n), ls = lum(s), lw = lum(w), le = lum(e);
  const mn = min(lc, min(min(ln, ls), min(lw, le)));
  const mx = max(lc, max(max(ln, ls), max(lw, le)));
  const contrast = clamp(mx.sub(mn).mul(CONTRAST_GAIN), 0.0, 1.0);

  const blur = n.add(s).add(w).add(e).mul(0.25);
  /* the classic unsharp mask, strength follows contrast */
  return c.add(c.sub(blur).mul(float(amount)).mul(contrast));
}
