/* ═══════════════════════════════════════════════════════════════════════════
   Hull (habitat floor) node graph: the core hull kernel (raster: true, truss
   shadow included) and, when the water mirror is on, the hullMirror kernel —
   both through tsl/kernelBridge.ts. The TSL twin of the legacy GLSL patch in
   materials/legacy.ts (patchHullMaterial); every input is computed the way
   the legacy shader computed it:

     base       color · map(uv)                      (legacy diffuseColor after map_fragment)
     mask       texture(uMask, uv).rgb
     dGrass     texture(uDetail, uv·detailRep).r
     dPave      texture(uDetail, uv·detailRep·0.31).r
     baseRough  material roughness (the hull has no roughness map)
     p          uv · (2πR, L)        (contract: true arc length; legacy 314, 300)
     far        smoothstep(25, 90, |viewPosition|)
     theta, z   VERTEX atan(x, y) and z of the object-space position, interpolated
                (legacy vTh / vZo varyings — same seam behaviour)

   Outputs → node material slots:
     colorNode     kernel albedo
     roughnessNode kernel roughness
     normalNode    legacy normal_fragment_maps: where water > 0.02,
                   normalize(mix(mapped, normalize(nGeom + tU·slope.x + tV·slope.y), water));
                   tU / tV = VIEW-space tangents along the arc and the axis from θ,
                   computed per vertex and interpolated without renormalising
                   (legacy vTanU / vTanV); nGeom = geometric view normal
     emissiveNode  material emissive + kernel city glow
                   (+ mirror: sunEmissive + map(hullUv)·hullWeight)
   ═══════════════════════════════════════════════════════════════════════════ */

import * as TSL from 'three/tsl';
import type { Texture, UniformNode } from 'three/webgpu';
import { CORE_CONFIG } from '../../../core/config/index.ts';
import { FAR_FAR_UNITS, FAR_NEAR_UNITS } from '../../../core/shading/contracts.ts';
import { HULL_CONST, hullSurface } from '../../../core/shading/kernels/hull.ts';
import { hullMirror } from '../../../core/shading/kernels/hullMirror.ts';
import type { HullUniforms } from '../materials/legacy.ts';
import { arrayUniform, asT, pulled, runKernel, type TNode } from './kernelBridge.ts';

/** Node uniforms of one world's hull — pulled from the legacy uniform objects. */
export interface HullNodeUniforms {
  time: UniformNode<'float', number>;
  flow: UniformNode<'float', number>;
  foam: UniformNode<'float', number>;
  ripple: UniformNode<'float', number>;
  waterTint: TNode;
  cityGlow: UniformNode<'float', number>;
  citySpill: UniformNode<'float', number>;
  sparShade: UniformNode<'float', number>;
  armW: UniformNode<'float', number>;
  sparZW: UniformNode<'float', number>;
  arms: TNode[];
  sparZ: TNode[];
  detailRep: UniformNode<'float', number>;
  mirror: UniformNode<'float', number>;
  sunR: UniformNode<'float', number>;
  hullR: UniformNode<'float', number>;
  hullL: UniformNode<'float', number>;
  sunGlow: UniformNode<'float', number>;
  camObj: TNode;
}

export function createHullNodeUniforms(h: HullUniforms): HullNodeUniforms {
  return {
    time: pulled(() => h.uTime.value),
    flow: pulled(() => h.uFlow.value),
    foam: pulled(() => h.uFoam.value),
    ripple: pulled(() => h.uRipple.value),
    /* the Color / Vector3 objects are shared: palette and update() mutate them in place */
    waterTint: asT(TSL.uniform(h.uWaterTint.value)),
    cityGlow: pulled(() => h.uCityGlow.value),
    citySpill: pulled(() => h.uCitySpill.value),
    sparShade: pulled(() => h.uSparShade.value),
    armW: pulled(() => h.uArmW.value),
    sparZW: pulled(() => h.uSparZW.value),
    arms: arrayUniform(h.uArm.value),
    sparZ: arrayUniform(h.uSparZ.value),
    detailRep: pulled(() => h.uDetailRep.value),
    mirror: pulled(() => h.uMirror.value),
    sunR: pulled(() => h.uSunR.value),
    hullR: pulled(() => h.uHullR.value),
    hullL: pulled(() => h.uHullL.value),
    sunGlow: pulled(() => h.uSunGlow.value),
    camObj: asT(TSL.uniform(h.uCamObj.value))
  };
}

export interface HullTextures {
  map: Texture | null;
  mask: Texture | null;
  detail: Texture | null;
}

export interface HullNodeSet {
  colorNode: TNode;
  roughnessNode: TNode;
  normalNode: TNode;
  emissiveNode: TNode;
}

const DETAIL_PAVE_SCALE = 0.31;           // legacy literal: vMapUv * uDetailRep * 0.31

/** Build the hull node set. `mirror` compiles the analytic water reflection in. */
export function hullNodes(U: HullNodeUniforms, tex: HullTextures, opts: { nArm: number; nSpar: number; mirror: boolean }): HullNodeSet {
  const T = TSL;
  const C = CORE_CONFIG;
  const uv = T.uv();
  const tx = (t: Texture | null, at: TNode): TNode => (t ? asT(T.texture(t, at)) : asT(T.vec4(0)));

  const base = asT(T.materialColor).xyz;
  const mask = tx(tex.mask, uv).xyz;
  const rep = uv.mul(U.detailRep);
  const dGrass = tx(tex.detail, rep).x;
  const dPave = tx(tex.detail, rep.mul(DETAIL_PAVE_SCALE)).x;
  const p = uv.mul(T.vec2(2 * Math.PI * C.R, C.L));
  const far = T.smoothstep(FAR_NEAR_UNITS, FAR_FAR_UNITS, T.positionView.length());

  /* per-vertex θ / z / tangents (legacy varyings) */
  const thV = T.atan(T.positionGeometry.x, T.positionGeometry.y);
  const theta = asT(T.varying(thV, 'vB5Th'));
  const z = asT(T.varying(T.positionGeometry.z, 'vB5Zo'));
  const tanU = asT(T.varying(T.transformNormalToView(T.vec3(T.cos(thV), T.sin(thV).negate(), 0)).normalize(), 'vB5TanU'));
  const tanV = asT(T.varying(T.transformNormalToView(T.vec3(0, 0, 1)).normalize(), 'vB5TanV'));

  const o = runKernel(hullSurface, { raster: true, nArm: opts.nArm, nSpar: opts.nSpar }, {
    base, mask, dGrass, dPave, baseRough: T.materialRoughness, p, far, theta, z
  }, {
    time: U.time, flow: U.flow, foam: U.foam, ripple: U.ripple, waterTint: U.waterTint,
    cityGlow: U.cityGlow, citySpill: U.citySpill,
    sparShade: U.sparShade, armW: U.armW, sparZW: U.sparZW, arms: U.arms, sparZ: U.sparZ
  });

  const slope = o.slope;
  const wn = T.normalViewGeometry.add(tanU.mul(slope.x).add(tanV.mul(slope.y))).normalize();
  const mapped = asT(T.materialNormal);
  const normalNode = asT(T.select(o.water.greaterThan(HULL_CONST.rippleMinDepth),
    T.mix(mapped, wn, o.water).normalize(), mapped));

  let emissiveNode = asT(T.materialEmissive).add(o.emissive);
  if (opts.mirror) {
    const m = runKernel(hullMirror, {}, { theta, z, slope, water: o.water }, {
      mirror: U.mirror, sunR: U.sunR, hullR: U.hullR, hullL: U.hullL, sunGlow: U.sunGlow, camObj: U.camObj
    });
    emissiveNode = emissiveNode.add(m.sunEmissive).add(tx(tex.map, m.hullUv).xyz.mul(m.hullWeight));
  }
  return { colorNode: o.albedo, roughnessNode: o.roughness, normalNode, emissiveNode };
}
