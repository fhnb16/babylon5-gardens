/* Foliage per-cell lightness dither — replaces per-face vertex colours
   (js/world.js foliageGeo: v = 1 - dither/2 + rnd()·dither) where vertex
   colours are unavailable (ThreeRT, path tracer).
   k ∈ [1 - amount/2, 1 + amount/2), constant over each cell floor(pWorld/cell).

   Hash: Dave Hoskins' hash13 (fract/dot only, no large-argument sin) — stable
   in f32 across GPUs; CPU (f64) and GPU (f32) agree to ~1e-5 except at rare
   fract() wrap points. */

import { FOLIAGE_DITHER } from '../contracts.ts';
import { defineKernel, input, one } from '../kernel.ts';
import type { NoOptions } from '../kernel.ts';

export const DITHER_CONST = { h1: 0.1031, h2: 31.32 } as const;

export const foliageDither = defineKernel<NoOptions>(FOLIAGE_DITHER, () => (K, i, u) => {
  const amount = one(u, 'amount');
  const c = K.floor(input(i, 'pWorld').div(one(u, 'cell')));
  const p3 = K.fract(c.mul(DITHER_CONST.h1));
  const q = p3.add(K.dot(p3, K.vec3(p3.z, p3.y, p3.x).add(DITHER_CONST.h2)));
  const h = K.fract(q.x.add(q.y).mul(q.z));
  return { k: amount.mul(-0.5).add(1).add(h.mul(amount)) };
}, { defaults: {} as NoOptions, typeName: 'B5FoliageDither' });
