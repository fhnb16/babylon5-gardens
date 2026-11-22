/* Crown/bush/tuft sway. Port of js/world.js patchWindMaterial.
   The legacy shader edited `transformed` in place; the leaf rustle reads the
   ALREADY swayed position (x and z moved). We reproduce that order and return
   the total offset (swayed + rustle − pGeom), built without cancellation so
   wind = 0 gives an exact zero. Phase comes in as an input (contract), not
   from instanceMatrix. */

import { WIND_OFFSET } from '../contracts.ts';
import { defineKernel, input, one } from '../kernel.ts';
import type { NoOptions } from '../kernel.ts';

export const WIND_CONST = {
  swayW1: 1.7, swayW2: 2.9, swayA2: 0.5, swayPh2: 1.7,
  amp: 0.035, ampBase: 0.9,
  zW: 1.3, zK: 0.6,
  leafW: 3.6, leafKy: 5.3, leafKx: 3.1, leafKz: 2.7, leafAmp: 0.055,
} as const;

export const windOffset = defineKernel<NoOptions>(WIND_OFFSET, () => (K, i, u) => {
  const C = WIND_CONST;
  const p = input(i, 'pGeom'), ph = input(i, 'phase');
  const t = one(u, 'time'), wind = one(u, 'wind');

  const sway = K.sin(t.mul(C.swayW1).add(ph))
    .add(K.sin(t.mul(C.swayW2).add(ph.mul(C.swayPh2))).mul(C.swayA2));
  const amp = wind.mul(C.amp).mul(p.y.add(C.ampBase));
  const dx = sway.mul(amp);
  const dz = K.cos(t.mul(C.zW).add(ph)).mul(amp).mul(C.zK);
  const sx = p.x.add(dx), sz = p.z.add(dz);

  const leafPh = ph.add(p.y.mul(C.leafKy)).add(sx.mul(C.leafKx)).add(sz.mul(C.leafKz));
  const leaf = K.normalize(K.vec3(sx, p.y, sz))
    .mul(K.sin(t.mul(C.leafW).add(leafPh)).mul(C.leafAmp).mul(wind));

  return { offset: K.vec3(dx, 0, dz).add(leaf) };
}, { defaults: {} as NoOptions, typeName: 'B5Wind' });
