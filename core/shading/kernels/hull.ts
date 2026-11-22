/* Hull (habitat floor) surface kernel.
   Faithful port of js/world.js patchHullMaterial: map_fragment (detail,
   absorption, foam, truss shadow), emissivemap_fragment (city lamps),
   roughnessmap_fragment (water gloss) and normal_fragment_maps (ripple slope).
   The analytic water reflection (uMirror branch) lives in hullMirror.ts.

   Deviations from the GLSL, all value-preserving:
   • `if (wDeep > 0.001)`, `if (zt > 0.002)`, `if (mask.r > 0.02)` → select.
     The truss early-out is therefore gone (both sides are evaluated).
   • smoothstep(0.20, 0.02, w) → 1 - smoothstep(0.02, 0.20, w) (identical
     maths; WGSL leaves low >= high implementation-defined).
   • Legacy surface coords were vMapUv * (314, 300); the contract input `p`
     is (arc, axis) in station units — the backend decides how to compute it. */

import { HULL_SURFACE, FOAM_COLOR, LAMP_TINT } from '../contracts.ts';
import type { HullKernelOptions } from '../contracts.ts';
import { defineKernel, input, many, one, unroll } from '../kernel.ts';
import type { KNode } from '../kernel.ts';
import { CORE_CONFIG } from '../../config/index.ts';

/** Shader constants of the legacy GLSL, kept together and named. */
export const HULL_CONST = {
  grassLo: 0.70, grassAmp: 0.60, grassMask: 0.9,
  paveLo: 0.86, paveAmp: 0.28, paveMask: 0.7,
  absorbK: 3.2,
  foamMinDepth: 0.001, foamEdgeLo: 0.02, foamEdgeHi: 0.20,
  foamFreqX: 14.0, foamFreqY: 3.1, foamWarp: 2.0, foamBase: 0.35, foamVar: 0.65,
  trussMinZt: 0.002, trussShadeMin: 0.25,
  lampLo: 0.10, lampHi: 0.75, lampBase: 0.5, lampDetail: 0.8,
  spillLo: 0.02, spillHi: 0.30,
  wetLo: 0.04, wetHi: 0.14, roughNear: 0.045, roughFar: 0.20,
  rippleMinDepth: 0.02, rippleNearBase: 0.45, rippleNearVar: 0.55,
  /** ripple terms: amplitude (arc, axis), wave vector, angular speed, `near`-faded */
  waves: [
    { a: [1.00, 0.14], k: [7.9, 1.1], w: 2.1, near: false },
    { a: [0.74, -0.11], k: [12.7, -1.9], w: -2.8, near: false },
    { a: [0.46, 0.08], k: [23.3, 3.1], w: 4.2, near: true },
    { a: [0.28, -0.06], k: [41.1, -4.7], w: -5.9, near: true },
    { a: [0.22, 0.55], k: [1.7, 0.9], w: 0.8, near: false }
  ]
} as const;

export const HULL_DEFAULTS: HullKernelOptions = {
  raster: true,
  nArm: CORE_CONFIG.AXIS.sparArms,
  nSpar: CORE_CONFIG.AXIS.spars.length
};

const PI = Math.PI;

export const hullSurface = defineKernel<HullKernelOptions>(HULL_SURFACE, (o) => (K, i, u) => {
  const C = HULL_CONST;
  const base = input(i, 'base'), mask = input(i, 'mask');
  const dGrass = input(i, 'dGrass'), dPave = input(i, 'dPave');
  const baseRough = input(i, 'baseRough'), p = input(i, 'p'), far = input(i, 'far');
  const time = one(u, 'time'), flow = one(u, 'flow');
  const wDeep = mask.x;

  /* detail: grass / pavement modulation */
  let c: KNode = base
    .mul(K.mix(1, dGrass.mul(C.grassAmp).add(C.grassLo), mask.y.mul(C.grassMask)))
    .mul(K.mix(1, dPave.mul(C.paveAmp).add(C.paveLo), mask.z.mul(C.paveMask)));

  /* absorption by water depth */
  const absorb = K.float(1).sub(K.exp(wDeep.mul(-C.absorbK)));
  c = K.mix(c, one(u, 'waterTint'), absorb);

  /* edge foam, advected by the river flow */
  const edge = K.float(1).sub(K.smoothstep(C.foamEdgeLo, C.foamEdgeHi, wDeep));
  const fpy = p.y.sub(time.mul(flow));
  const f = K.sin(p.x.mul(C.foamFreqX).add(K.sin(fpy.mul(C.foamFreqY)).mul(C.foamWarp))).mul(0.5).add(0.5);
  const foamK = edge.mul(f.mul(C.foamVar).add(C.foamBase)).mul(one(u, 'foam'));
  const foamCol = K.vec3(FOAM_COLOR[0], FOAM_COLOR[1], FOAM_COLOR[2]);
  c = c.add(foamCol.mul(K.select(K.greaterThan(wDeep, C.foamMinDepth), foamK, 0)));

  /* analytic truss shadow (raster only): angular gate × z locality */
  if (o.raster) {
    const theta = input(i, 'theta'), z = input(i, 'z');
    const sparZ = many(u, 'sparZ'), arms = many(u, 'arms');
    const sparZW = one(u, 'sparZW'), armW = one(u, 'armW'), sparShade = one(u, 'sparShade');
    const zt = unroll<KNode>(o.nSpar, K.float(0), (acc, j) =>
      K.max(acc, K.float(1).sub(K.smoothstep(0, sparZW, K.abs(z.sub(sparZ[j]))))));
    const shade = unroll<KNode>(o.nArm, K.float(1), (acc, j) => {
      const d = K.mod(theta.sub(arms[j]).add(PI), 2 * PI).sub(PI);
      return acc.sub(sparShade.mul(zt).mul(K.float(1).sub(K.smoothstep(0, armW, K.abs(d)))));
    });
    c = c.mul(K.select(K.greaterThan(zt, C.trussMinZt), K.clamp(shade, C.trussShadeMin, 1), 1));
  }

  /* city lamps: light the pavement (× albedo), soft spill past the city edge */
  const lamps = K.smoothstep(C.lampLo, C.lampHi, mask.z);
  const spill = K.smoothstep(C.spillLo, C.spillHi, mask.z).mul(one(u, 'citySpill'));
  const emissive = c.mul(one(u, 'cityGlow'))
    .mul(lamps.mul(dPave.mul(C.lampDetail).add(C.lampBase)).add(spill))
    .mul(K.vec3(LAMP_TINT[0], LAMP_TINT[1], LAMP_TINT[2]));

  /* water gloss: independent of depth, widened with distance */
  const wet = K.smoothstep(C.wetLo, C.wetHi, wDeep);
  const roughness = K.mix(baseRough, K.mix(C.roughNear, C.roughFar, far), wet);

  /* ripple slope in the (arc, axis) frame */
  const near = K.float(1).sub(far);
  const P = K.vec2(p.x, fpy);
  let rip: KNode | null = null;
  for (const w of C.waves) {
    let term = K.vec2(w.a[0], w.a[1]).mul(K.cos(K.dot(P, K.vec2(w.k[0], w.k[1])).add(time.mul(w.w))));
    if (w.near) term = term.mul(near);
    rip = rip ? rip.add(term) : term;
  }
  if (!rip) throw new Error('hull: no ripple terms');
  const amp = one(u, 'ripple').mul(wDeep).mul(near.mul(C.rippleNearVar).add(C.rippleNearBase));
  const slope = K.select(K.greaterThan(wDeep, C.rippleMinDepth), rip.mul(amp), K.vec2(0));

  return { albedo: c, roughness, slope, water: wDeep, emissive };
}, {
  defaults: HULL_DEFAULTS,
  typeName: 'B5Hull',
  arrayLengths: (o) => ({ arms: o.nArm, sparZ: o.nSpar })
});
