/* Fog fade by opacity (additive glow, the axis tube): the core fogFade kernel
   on TSL. Legacy fadeByFog replaced three's fog_fragment entirely — no fog
   colour mix, alpha ·= 1 − clamp(1 − exp(−d²·z²)) with z = view depth
   (vFogDepth = −mvPosition.z) — so the node material sets `fog = false` and
   uses this as its opacityNode. The density is pulled from the world's
   FogExp2 every render. */

import * as TSL from 'three/tsl';
import { fogFade } from '../../../core/shading/kernels/fogfade.ts';
import { asT, runKernel, type TNode } from './kernelBridge.ts';

export function fogFadeOpacity(fogDensity: TNode): TNode {
  const { opacity } = runKernel(fogFade, {}, {
    viewDist: TSL.positionView.z.negate(),
    opacity: TSL.materialOpacity
  }, { fogDensity });
  return asT(opacity);
}
