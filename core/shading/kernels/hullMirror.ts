/* Analytic water reflection of the hull (RASTER ONLY — tracers have real
   reflections). Port of the `uMirror` branch of js/world.js
   patchHullMaterial (normal_fragment_maps).

   The legacy code sampled the hull albedo map at the reflected hit point
   (at the WRONG column: see hullUv below — fixed here and in the raster
   patch backends/three/materials/legacy.ts together).
   Kernels never sample textures, so this kernel returns the hit UV and its
   weight; the backend adds  sunEmissive + texture(map, hullUv).rgb * hullWeight
   to the emissive radiance.

   Nested `if`s become a chain of selects. Square roots and the division by
   qa are guarded (max(…, 0), max(qa, 1e-6)) so the not-taken branches stay
   finite — the guarded values are only ever used where the legacy branch
   condition holds, where the guards are no-ops. */

import { HULL_MIRROR } from '../contracts.ts';
import { defineKernel, input, one } from '../kernel.ts';
import type { NoOptions } from '../kernel.ts';

/** The signature lives in the contract; re-exported for existing imports. */
export { HULL_MIRROR };

export const MIRROR_CONST = {
  sunColor: [1.0, 0.94, 0.78],
  minMirror: 0.001, minWater: 0.02,
  minQa: 1e-6, minT: 0.05,
  fresnelPow: 4.0, fresnelF0: 0.04, fresnelK: 0.96,
  twoPi: 6.28318531,   // legacy literal
} as const;

export const hullMirror = defineKernel<NoOptions>(HULL_MIRROR, () => (K, i, u) => {
  const C = MIRROR_CONST;
  const theta = input(i, 'theta'), z = input(i, 'z'), slope = input(i, 'slope'), water = input(i, 'water');
  const R = one(u, 'hullR'), L = one(u, 'hullL'), sunR = one(u, 'sunR');

  const sT = K.sin(theta), cT = K.cos(theta);
  const Pw = K.vec3(sT.mul(R), cT.mul(R), z);
  const up = K.vec3(sT.mul(-1), cT.mul(-1), 0);
  const tu = K.vec3(cT, sT.mul(-1), 0);
  const tv = K.vec3(0, 0, 1);
  const Nw = K.normalize(up.add(tu.mul(slope.x).add(tv.mul(slope.y))));
  const Vw = K.normalize(Pw.sub(one(u, 'camObj')));
  const Rw = K.reflect(Vw, Nw);

  const qa = K.dot(Rw.xy, Rw.xy);
  const qaOk = K.greaterThan(qa, C.minQa);
  const qa2 = K.max(qa, C.minQa).mul(2);
  const qb = K.dot(Pw.xy, Rw.xy).mul(2);
  const pp = K.dot(Pw.xy, Pw.xy);
  const halfL = L.mul(0.5);

  /* axis tube: near root */
  const ds = qb.mul(qb).sub(qa.mul(4).mul(pp.sub(sunR.mul(sunR))));
  const ts = K.float(0).sub(qb).sub(K.sqrt(K.max(ds, 0))).div(qa2);
  const sunHit = K.and(K.and(qaOk, K.greaterThan(ds, 0)),
    K.and(K.greaterThan(ts, C.minT), K.lessThan(K.abs(Pw.z.add(Rw.z.mul(ts))), halfL)));

  /* hull: far root (we are inside the cylinder) */
  const dh = qb.mul(qb).sub(qa.mul(4).mul(pp.sub(R.mul(R))));
  const th2 = K.float(0).sub(qb).add(K.sqrt(K.max(dh, 0))).div(qa2);
  const hw = Pw.add(Rw.mul(th2));
  const hullHit = K.and(K.and(K.and(qaOk, K.not(sunHit)), K.greaterThan(dh, 0)),
    K.and(K.greaterThan(th2, C.minT), K.lessThan(K.abs(hw.z), halfL)));
  /* u ≡ θ/2π (the baked hull UV convention, θ = atan2(x, y)). Legacy wrote
     fract(0.5 − θ/2π) — the un-mirrored cylinder u, i.e. the hull at angle
     π − θ — a bug fixed in v2.12.0 (visible only where uMirror > 0). */
  const hullUv = K.vec2(
    K.fract(K.atan(hw.x, hw.y).div(C.twoPi)),
    hw.z.div(L).add(0.5));

  /* Fresnel */
  const fr = K.pow(K.float(1).sub(K.max(0, K.dot(Vw.mul(-1), Nw))), C.fresnelPow);
  const mirror = one(u, 'mirror');
  const on = K.and(K.greaterThan(mirror, C.minMirror), K.greaterThan(water, C.minWater));
  const w = K.select(on, water.mul(mirror).mul(fr.mul(C.fresnelK).add(C.fresnelF0)), 0);

  const sunEmissive = K.vec3(C.sunColor[0], C.sunColor[1], C.sunColor[2])
    .mul(one(u, 'sunGlow')).mul(K.select(sunHit, w, 0));
  const hullOn = K.and(on, hullHit);
  const hullWeight = K.select(hullOn, w, 0);
  return { sunEmissive, hullUv: K.select(hullOn, hullUv, K.vec2(0)), hullWeight };
}, { defaults: {} as NoOptions, typeName: 'B5HullMirror' });
