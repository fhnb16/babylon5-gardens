/* Fog fade for additive materials. Port of js/util.js fadeByFog:
   fogF = 1 - exp(-density² · depth²);  alpha *= 1 - clamp(fogF, 0, 1).
   Additive blending cannot be fogged by mixing in the fog colour (that ADDS
   light), so the material fades out by opacity instead. */

import { FOG_FADE } from '../contracts.ts';
import { defineKernel, input, one } from '../kernel.ts';
import type { NoOptions } from '../kernel.ts';

export const fogFade = defineKernel<NoOptions>(FOG_FADE, () => (K, i, u) => {
  const d = input(i, 'viewDist'), D = one(u, 'fogDensity');
  const fogF = K.float(1).sub(K.exp(D.mul(D).mul(d).mul(d).mul(-1)));
  return { opacity: input(i, 'opacity').mul(K.float(1).sub(K.clamp(fogF, 0, 1))) };
}, { defaults: {} as NoOptions, typeName: 'B5FogFade' });
