/* Edge-adaptive upscale — TSL port of UPSCALE_FRAG (js/photo.js).

   FSR 1.0's EASU idea as the classic chain implements it: a 12-tap cross
   (4×3) around the bilinear footprint, the local luma gradient of four 2×2
   sub-windows decides the edge direction, and the bilinear weights are
   stretched along the edge and squeezed across it. Not AMD's full EASU
   (three r187 ships that as `fsr1()` — selectable with fsrImpl 'three').

   Works in linear HDR like the classic chain (upscale happens before bloom
   and tone mapping). `src` is a texture node at render resolution; the
   result is evaluated at `uvOut` (output-resolution UV, TSL convention:
   origin top-left). The kernel is symmetric under a vertical flip, so the
   GL (bottom-left) origin of the original shader changes nothing. */
import { vec2, vec3, float, floor, fract, clamp, mix, dot, length, abs, uv } from 'three/tsl';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TslNode = any;

const LUMA = [0.2126, 0.7152, 0.0722] as const;
/** Weight squeeze across a strong edge (UPSCALE_FRAG: mix(1, 0.28, …)). */
const EASU = { squeeze: 0.28, dirGain: 2.0, eps: 1e-5 };

const lum = (c: TslNode): TslNode => dot(c, vec3(...LUMA));

/** Upscaled linear colour of `src` at `uvOut`. */
export function easu(src: TslNode, uvOut: TslNode): TslNode {
  const srcRes = vec2(src.size()).toVar();
  const px = vec2(1.0).div(srcRes).toVar();
  const sp = uvOut.mul(srcRes).sub(0.5).toVar();
  const base = floor(sp).add(0.5).mul(px).toVar();
  const f = fract(sp).toVar();

  const tap = (x: number, y: number): TslNode => src.sample(base.add(px.mul(vec2(x, y)))).rgb.toVar();
  /* twelve taps in a 4×3 cross — the EASU neighbourhood */
  const b = tap(0, -1), c = tap(1, -1);
  const e = tap(-1, 0), fq = tap(0, 0), g = tap(1, 0), h = tap(2, 0);
  const i = tap(-1, 1), j = tap(0, 1), k = tap(1, 1), l = tap(2, 1);
  const n = tap(0, 2), o = tap(1, 2);

  const lb = lum(b), lc = lum(c), le = lum(e), lf = lum(fq);
  const lg = lum(g), lh = lum(h), li = lum(i), lj = lum(j);
  const lk = lum(k), ll = lum(l), ln = lum(n), lo = lum(o);

  /* four 2×2 sub-windows, one per corner: [centre, up, left, right, down] */
  const quads: TslNode[][] = [
    [lf, lb, le, lg, lj],
    [lg, lc, lf, lh, lk],
    [lj, lf, li, lk, ln],
    [lk, lg, lj, ll, lo]
  ];
  let dir: TslNode = vec2(0.0);
  let len: TslNode = float(0.0);
  for (const [, c1, c2, c3, c4] of quads) {
    const dx = c2.sub(c3);
    const dy = c1.sub(c4);
    const lq = float(1.0).sub(clamp(abs(dx).add(abs(dy)), 0.0, 1.0));
    dir = dir.add(vec2(dx, dy));
    len = len.add(lq.mul(lq));
  }
  len = len.mul(0.25);

  /* along the edge neighbours are taken readily, across it hardly at all */
  const dl = length(dir).add(EASU.eps);
  const d = dir.div(dl);
  const stretch = mix(float(1.0), float(EASU.squeeze), clamp(dl.mul(EASU.dirGain), 0.0, 1.0));
  const w = mix(vec2(1.0), vec2(stretch), abs(d));

  const t0 = f.mul(f).mul(vec2(3.0).sub(f.mul(2.0)));
  const t = mix(vec2(0.5), t0, mix(vec2(1.0), w, float(1.0).sub(len)));

  const top = mix(fq, g, t.x);
  const bot = mix(j, k, t.x);
  return mix(top, bot, t.y);
}

/** Convenience: upscale at the quad's own UV. */
export const easuAtUv = (src: TslNode): TslNode => easu(src, uv());
