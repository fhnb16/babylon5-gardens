/* ═══════════════════════════════════════════════════════════════════════════
   Legacy materials: MaterialDesc → MeshStandardMaterial / MeshBasicMaterial /
   PointsMaterial with the parameters of the legacy js/world.js +
   js/structures.js (since v2.12.0 only in test/legacy-oracle/), and the
   legacy GLSL onBeforeCompile patches MOVED here:

     hull kernel     ← js/world.js patchHullMaterial   (uniform object per world)
     wind kernel     ← js/world.js patchWindMaterial
     fogFade kernel  ← js/util.js  fadeByFog
     photo mode      ← js/world.js patchRoughnessAlpha (roughness → frame alpha)

   Classic WebGLRenderer only (r187 #include anchors). The WebGPU path gets
   TSL materials (materials/node.ts, wave 3).

   Hull: the core emits the hull FRONT-facing with inward normals, reversed
   winding and baked UVs u' = 0.5 − u_cyl (= what legacy sampled through
   map.repeat.x = −1, offset.x = 0.5). The patch is unchanged because every
   input it reads is identical to the legacy BackSide setup:
     · vMapUv: legacy = mapTransform(uv) = 0.5 − u_cyl; now = baked uv, identity
       transform ⇒ same value, so mask/detail/foam/ripple coordinates match;
     · vNormal / nonPerturbedNormal: legacy outward normals were negated by
       FLIP_SIDED (defaultnormal_vertex); now the geometry is inward ⇒ same;
     · normal map TBN: getTangentFrame(−vViewPosition, normal, vNormalMapUv)
       gets the same position, normal and uv; faceDirection only matters for
       DOUBLE_SIDED, so gl_FrontFacing flipping from false to true is inert;
     · three negates the normalScale UNIFORM of BackSide materials
       (WebGLMaterials: `if (material.side === BackSide) normalScale.negate()`),
       so the legacy hull's relief rendered with (−1, −1). MaterialDesc.
       normalScale is AS-RENDERED with FrontSide semantics (types.ts), and the
       core hull carries (−1, −1) itself: applied as is, nobody negates by side.
       Convention note: heightToNormal writes G = −dH/dy with canvas y DOWN,
       i.e. +dH/dv — a green-inverted map for three's (−dH/du, −dH/dv)
       convention. Facades/roof/panel/leaf/endcap use (1, 1) (green inverted),
       the hull (−1, −1) (red inverted); the self-consistent value would be
       (1, −1). Kept as legacy rendered it.
     · vTh, vZo, vTanU, vTanV are computed from object-space position ⇒ same;
     · mirror branch: it samples `map` at its OWN huv (raw image coordinates,
       no map transform involved). BEHAVIOUR FIX (v2.12.0): legacy wrote huv.x
       = fract(0.5 − θ/2π) — the un-mirrored cylinder u — while the albedo
       column of world angle θ is θ/2π (the baked UV), so the reflected hull
       was sampled at angle π − θ. Now huv.x = fract(θ/2π), together with
       core/shading/kernels/hullMirror.ts. Visible only where uMirror > 0
       (ULTRA / ULTRAM water reflections).
   ═══════════════════════════════════════════════════════════════════════════ */

import * as THREE from 'three';
import { CORE_CONFIG } from '../../../core/config/index.ts';
import { hexToLinear, lightingAt } from '../../../core/lighting/phases.ts';
import type { HullDesc, LightingState, MaterialDesc, ParamRef } from '../../../core/scene/types.ts';

/* ─── parameter references ────────────────────────────────────────────────── */

/** value = state[param]·scale + offset */
export function evalRef(ref: ParamRef, state: LightingState): number {
  const v = ref.param === 'daylight' ? state.daylight : state[ref.param];
  return v * (ref.scale ?? 1) + (ref.offset ?? 0);
}

/** number | ParamRef → number (ParamRefs are evaluated at `state`, default DAY). */
export function numOrRef(v: number | ParamRef | undefined, state: LightingState, def: number): number {
  if (v === undefined) return def;
  return typeof v === 'number' ? v : evalRef(v, state);
}

let _day: LightingState | null = null;
/** LightingState of phase 0 (DAY) — the legacy constructor state. */
export const dayState = (): LightingState => (_day ??= lightingAt(0));

/* ─── uniforms ────────────────────────────────────────────────────────────── */

/* Legacy constants of the hull patch (js/world.js hullU / buildWorld). */
const SPAR_Z_WIDTH = 30.0;
const SUN_GLOW = 3.2;
const ARM_WIDTH_K = 1.4;

export interface HullUniforms {
  [k: string]: THREE.IUniform;
  uMask: THREE.IUniform<THREE.Texture | null>;
  uDetail: THREE.IUniform<THREE.Texture | null>;
  uTime: THREE.IUniform<number>;
  uDetailRep: THREE.IUniform<number>;
  uArm: THREE.IUniform<number[]>;
  uArmW: THREE.IUniform<number>;
  uSparZ: THREE.IUniform<number[]>;
  uSparZW: THREE.IUniform<number>;
  uSparShade: THREE.IUniform<number>;
  uFlow: THREE.IUniform<number>;
  uFoam: THREE.IUniform<number>;
  uRipple: THREE.IUniform<number>;
  uMirror: THREE.IUniform<number>;
  uSunR: THREE.IUniform<number>;
  uHullR: THREE.IUniform<number>;
  uHullL: THREE.IUniform<number>;
  uSunGlow: THREE.IUniform<number>;
  uCamObj: THREE.IUniform<THREE.Vector3>;
  uCityGlow: THREE.IUniform<number>;
  uCitySpill: THREE.IUniform<number>;
  uWaterTint: THREE.IUniform<THREE.Color>;
}

export interface WindUniforms {
  [k: string]: THREE.IUniform;
  uTime: THREE.IUniform<number>;
  uWind: THREE.IUniform<number>;
}

/** Fresh hull uniforms (legacy hullU after buildWorld). One object per world. */
export function createHullUniforms(hull: HullDesc): HullUniforms {
  const C = CORE_CONFIG;
  const tint = hexToLinear(C.DAY.waterTint);
  return {
    uMask: { value: null }, uDetail: { value: null },
    uTime: { value: 0 }, uDetailRep: { value: hull.detailRep },
    uArm: { value: hull.armAngles.slice() }, uArmW: { value: C.AXIS.trussW / C.R * ARM_WIDTH_K },
    uSparZ: { value: hull.sparZ.slice() }, uSparZW: { value: SPAR_Z_WIDTH },
    uSparShade: { value: C.DAY.sparShade },
    uFlow: { value: C.RIVER_FLOW },
    uFoam: { value: C.WATER.foam },
    uRipple: { value: C.WATER.ripple },
    uMirror: { value: 0 },
    uSunR: { value: C.SUN.r }, uHullR: { value: C.R },
    uHullL: { value: C.L }, uSunGlow: { value: SUN_GLOW },
    uCamObj: { value: new THREE.Vector3() },
    uCityGlow: { value: C.DAY.cityGlow },
    uCitySpill: { value: C.CITY.spill },
    uWaterTint: { value: new THREE.Color().setRGB(tint[0], tint[1], tint[2]) }
  };
}

/** Wind uniforms share uTime with the hull (legacy windU). */
export function createWindUniforms(hullU: HullUniforms): WindUniforms {
  return { uTime: hullU.uTime, uWind: { value: 1 } };
}

/* ─── GLSL patches (verbatim from js/world.js / js/util.js) ───────────────── */

type Shader = THREE.WebGLProgramParametersWithUniforms;

export function patchHullMaterial(mat: THREE.Material, hullU: HullUniforms, nArm: number, nSpar: number): void {
  mat.onBeforeCompile = (s: Shader) => {
    Object.assign(s.uniforms, hullU);

    s.vertexShader = s.vertexShader
      .replace('#include <common>', `#include <common>
        varying float vTh;
        varying float vZo;
        varying vec3 vTanU;
        varying vec3 vTanV;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vTh = atan( position.x, position.y );
        vZo = position.z;
        // касательные корпуса в видовом пространстве: вдоль дуги и вдоль оси.
        // Возмущать нормаль без них нельзя — во фрагментном шейдере normal
        // задан в видовых координатах, и рябь поехала бы вместе с камерой.
        vTanU = normalize( normalMatrix * vec3( cos( vTh ), -sin( vTh ), 0.0 ) );
        vTanV = normalize( normalMatrix * vec3( 0.0, 0.0, 1.0 ) );`);

    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vTh;
        varying float vZo;
        varying vec3 vTanU;
        varying vec3 vTanV;
        uniform sampler2D uMask;
        uniform sampler2D uDetail;
        uniform float uTime, uDetailRep, uArmW, uSparZW, uSparShade, uCityGlow, uFlow;
        uniform float uCitySpill;
        uniform float uMirror, uSunR, uHullR, uHullL, uSunGlow, uFoam, uRipple;
        uniform vec3 uCamObj;   // камера в системе станции
        uniform float uArm[${nArm}];
        uniform float uSparZ[${nSpar}];
        uniform vec3 uWaterTint;
        vec3 hullMask;`)

      /* --- альбедо: детальный шум + тонировка воды + тени ферм --- */
      .replace('#include <map_fragment>', `#include <map_fragment>
        hullMask = texture2D( uMask, vMapUv ).rgb;
        float dGrass = texture2D( uDetail, vMapUv * uDetailRep ).r;
        float dPave  = texture2D( uDetail, vMapUv * uDetailRep * 0.31 ).r;
        diffuseColor.rgb *= mix( 1.0, 0.70 + 0.60 * dGrass, hullMask.g * 0.9 );
        diffuseColor.rgb *= mix( 1.0, 0.86 + 0.28 * dPave,  hullMask.b * 0.7 );
        float wDeep = hullMask.r;
        float absorb = 1.0 - exp( -wDeep * 3.2 );
        diffuseColor.rgb = mix( diffuseColor.rgb, uWaterTint, absorb );

        if ( wDeep > 0.001 ) {
          float edge = smoothstep( 0.20, 0.02, wDeep );
          vec2 fp = vec2( vMapUv.x * 314.0, vMapUv.y * 300.0 - uTime * uFlow );
          float f = sin( fp.x * 14.0 + sin( fp.y * 3.1 ) * 2.0 ) * 0.5 + 0.5;
          diffuseColor.rgb += vec3( 0.55, 0.62, 0.66 ) * edge * ( 0.35 + 0.65 * f ) * uFoam;
        }

        // тень фермы: угловой створ × локальность по z
        float zt = 0.0;
        for ( int j = 0; j < ${nSpar}; j++ )
          zt = max( zt, 1.0 - smoothstep( 0.0, uSparZW, abs( vZo - uSparZ[j] ) ) );

        if ( zt > 0.002 ) {
          float shade = 1.0;
          for ( int i = 0; i < ${nArm}; i++ ) {
            float d = vTh - uArm[i];
            d = mod( d + PI, 2.0 * PI ) - PI;
            shade -= uSparShade * zt * ( 1.0 - smoothstep( 0.0, uArmW, abs( d ) ) );
          }
          diffuseColor.rgb *= clamp( shade, 0.25, 1.0 );
        }`)

      /* --- ночью улицы и площади светятся сами --- */
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float lamps = smoothstep( 0.10, 0.75, hullMask.b );
        float spill = smoothstep( 0.02, 0.30, hullMask.b ) * uCitySpill;
        totalEmissiveRadiance += uCityGlow * diffuseColor.rgb
          * ( lamps * ( 0.5 + 0.8 * dPave ) + spill )
          * vec3( 1.0, 0.86, 0.66 );`)

      /* --- вода зеркальна --- */
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        float wFar = smoothstep( 25.0, 90.0, length( vViewPosition ) );
        float wet = smoothstep( 0.04, 0.14, hullMask.r );
        roughnessFactor = mix( roughnessFactor, mix( 0.045, 0.20, wFar ), wet );`)

      /* --- рябь на воде: возмущаем нормаль, блик солнца сам поедет --- */
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        if ( hullMask.r > 0.02 ) {
          vec2 P = vec2( vMapUv.x * 314.0, vMapUv.y * 300.0 );
          P.y -= uTime * uFlow;
          float t = uTime;
          float near = 1.0 - wFar;

          vec2 rip = vec2( 0.0 );
          rip += vec2( 1.00, 0.14 ) * cos( dot( P, vec2(  7.9,  1.1 ) ) + t * 2.1 );
          rip += vec2( 0.74, -0.11 ) * cos( dot( P, vec2( 12.7, -1.9 ) ) - t * 2.8 );
          rip += vec2( 0.46, 0.08 ) * cos( dot( P, vec2( 23.3,  3.1 ) ) + t * 4.2 ) * near;
          rip += vec2( 0.28, -0.06 ) * cos( dot( P, vec2( 41.1, -4.7 ) ) - t * 5.9 ) * near;
          rip += vec2( 0.22, 0.55 ) * cos( dot( P, vec2( 1.7, 0.9 ) ) + t * 0.8 );

          float amp = uRipple * hullMask.r * ( 0.45 + 0.55 * near );
          vec3 wn = normalize( nonPerturbedNormal + ( vTanU * rip.x + vTanV * rip.y ) * amp );
          normal = normalize( mix( normal, wn, hullMask.r ) );

          if ( uMirror > 0.001 && hullMask.r > 0.02 ) {
            float sT = sin( vTh ), cT = cos( vTh );
            vec3 Pw = vec3( sT * uHullR, cT * uHullR, vZo );
            vec3 up = vec3( -sT, -cT, 0.0 );
            vec3 tu = vec3( cT, -sT, 0.0 );
            vec3 tv = vec3( 0.0, 0.0, 1.0 );
            vec3 Nw = normalize( up + ( tu * rip.x + tv * rip.y ) * amp );
            vec3 Vw = normalize( Pw - uCamObj );
            vec3 Rw = reflect( Vw, Nw );

            vec3 got = vec3( 0.0 );
            float found = 0.0;
            float qa = dot( Rw.xy, Rw.xy );
            if ( qa > 1e-6 ) {
              float qb = 2.0 * dot( Pw.xy, Rw.xy );
              float ds = qb * qb - 4.0 * qa * ( dot( Pw.xy, Pw.xy ) - uSunR * uSunR );
              if ( ds > 0.0 ) {
                float ts = ( -qb - sqrt( ds ) ) / ( 2.0 * qa );
                if ( ts > 0.05 && abs( Pw.z + Rw.z * ts ) < uHullL * 0.5 ) {
                  got = vec3( 1.0, 0.94, 0.78 ) * uSunGlow;
                  found = 1.0;
                }
              }
              if ( found < 0.5 ) {
                float dh = qb * qb - 4.0 * qa * ( dot( Pw.xy, Pw.xy ) - uHullR * uHullR );
                if ( dh > 0.0 ) {
                  float th2 = ( -qb + sqrt( dh ) ) / ( 2.0 * qa );
                  vec3 hw = Pw + Rw * th2;
                  if ( th2 > 0.05 && abs( hw.z ) < uHullL * 0.5 ) {
                    // u = θ/2π — запечённая развёртка корпуса (v2.12.0: было
                    // 0.5 − θ/2π, то есть корпус под углом π − θ)
                    vec2 huv = vec2( fract( atan( hw.x, hw.y ) / 6.28318531 ),
                                     hw.z / uHullL + 0.5 );
                    got = texture2D( map, huv ).rgb;
                    found = 1.0;
                  }
                }
              }
            }
            float fr = pow( 1.0 - max( 0.0, dot( -Vw, Nw ) ), 4.0 );
            totalEmissiveRadiance += got * found * hullMask.r * uMirror
              * ( 0.04 + 0.96 * fr );
          }
        }`);
  };
  mat.customProgramCacheKey = () => 'b5-hull';
}

/** Wind in crowns/bushes/tufts: phase from the instance matrix (legacy patchWindMaterial). */
export function patchWindMaterial(mat: THREE.Material, windU: WindUniforms): void {
  mat.onBeforeCompile = (s: Shader) => {
    Object.assign(s.uniforms, windU);
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\n uniform float uTime, uWind;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          float ph = instanceMatrix[3][0] * 0.7 + instanceMatrix[3][2] * 0.3;
          float sway = sin( uTime * 1.7 + ph ) + 0.5 * sin( uTime * 2.9 + ph * 1.7 );
          float amp = 0.035 * uWind * ( transformed.y + 0.9 );
          transformed.x += sway * amp;
          transformed.z += cos( uTime * 1.3 + ph ) * amp * 0.6;
          float leafPh = ph + transformed.y * 5.3 + transformed.x * 3.1 + transformed.z * 2.7;
          transformed += normalize( transformed ) * sin( uTime * 3.6 + leafPh ) * 0.055 * uWind;
        #endif`);
  };
  mat.customProgramCacheKey = () => 'b5-wind';
}

/** Additive/translucent surfaces fade out in fog by alpha (legacy fadeByFog). */
export function fadeByFog<M extends THREE.Material>(mat: M): M {
  (mat as unknown as { fog: boolean }).fog = true;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (s: Shader, r: THREE.WebGLRenderer) => {
    prev?.call(mat, s, r);
    s.fragmentShader = s.fragmentShader.replace('#include <fog_fragment>', `
      #ifdef USE_FOG
        float fogF = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
        gl_FragColor.a *= 1.0 - clamp( fogF, 0.0, 1.0 );
      #endif`);
  };
  const key = mat.customProgramCacheKey;
  mat.customProgramCacheKey = () => (key ? key.call(mat) : '') + '-fogfade';
  return mat;
}

/** Roughness into the frame alpha for the photo-mode tracer (legacy patchRoughnessAlpha). */
export function patchRoughnessAlpha<M extends THREE.Material>(mat: M): M {
  if (mat.userData.__ra) return mat;
  mat.userData.__ra = true;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (s: Shader, r: THREE.WebGLRenderer) => {
    prev?.call(mat, s, r);
    s.fragmentShader = s.fragmentShader.replace('#include <dithering_fragment>',
      '#include <dithering_fragment>\n gl_FragColor.a = roughnessFactor;');
  };
  const key = mat.customProgramCacheKey;
  mat.customProgramCacheKey = () => (key ? key.call(mat) : '') + '-ra';
  return mat;
}

/* ─── MaterialDesc → three ────────────────────────────────────────────────── */

export interface LegacyMaterialContext {
  /** texture for an image id (placeholder until pixels arrive), null if unknown */
  texture(id: string | undefined): THREE.Texture | null;
  hull: HullDesc;
  hullU: HullUniforms;
  windU: WindUniforms;
  /** legacy patchAllRoughness: roughness → alpha on opaque standard materials */
  roughnessAlpha: boolean;
}

const sideOf = (s: MaterialDesc['side']): THREE.Side => (s === 'double' ? THREE.DoubleSide : THREE.FrontSide);
const setLinear = (c: THREE.Color, v: readonly number[]): THREE.Color => c.setRGB(v[0], v[1], v[2]);

/** Apply alpha/depth/tone flags common to every material kind (legacy and node). */
export function applyCommon(m: THREE.Material, d: MaterialDesc, state: LightingState): void {
  m.side = sideOf(d.side);
  if (d.alpha === 'opaque') {
    m.transparent = false;
  } else if ('mask' in d.alpha) {
    m.alphaTest = d.alpha.mask;
  } else {
    m.transparent = true;
    m.opacity = numOrRef(d.alpha.blend, state, 1);
    if (d.alpha.additive) m.blending = THREE.AdditiveBlending;
  }
  if (d.depthWrite !== undefined) m.depthWrite = d.depthWrite;
  if (d.toneMapped !== undefined) m.toneMapped = d.toneMapped;
  m.name = d.id;
}

/**
 * Build the classic-WebGL material for a descriptor. ParamRef-driven values
 * start at their DAY value (legacy constructors used the DAY palette;
 * applyLighting re-drives them every phase change).
 */
export function createLegacyMaterial(d: MaterialDesc, ctx: LegacyMaterialContext): THREE.Material {
  const state = dayState();
  let mat: THREE.Material;
  switch (d.model) {
    case 'unlit':
    case 'decal': {
      const m = new THREE.MeshBasicMaterial();
      setLinear(m.color, d.baseColor);
      m.map = ctx.texture(d.map);
      mat = m;
      break;
    }
    case 'sprite': {
      const m = new THREE.PointsMaterial();
      setLinear(m.color, d.baseColor);
      m.map = ctx.texture(d.map);
      mat = m;
      break;
    }
    default: {
      /* standard | hull | thinGlass (raster fakes glazing as dark metal) */
      const m = new THREE.MeshStandardMaterial();
      setLinear(m.color, d.baseColor);
      m.roughness = d.roughness;
      m.metalness = d.metalness;
      m.map = ctx.texture(d.map);
      m.normalMap = ctx.texture(d.normalMap);
      /* AS-RENDERED with FrontSide semantics (types.ts): applied as is */
      if (d.normalScale) m.normalScale.set(d.normalScale[0], d.normalScale[1]);
      m.roughnessMap = d.model === 'hull' ? null : ctx.texture(d.roughnessMap);
      if (d.emissive) setLinear(m.emissive, d.emissive);
      m.emissiveMap = ctx.texture(d.emissiveMap);
      m.emissiveIntensity = numOrRef(d.emissiveIntensity, state, 1);
      m.flatShading = !!d.flatShading;
      mat = m;
    }
  }
  mat.vertexColors = !!d.vertexColors;
  applyCommon(mat, d, state);

  const kernels = d.kernels || [];
  if (d.model === 'hull' || kernels.includes('hull')) {
    patchHullMaterial(mat, ctx.hullU, ctx.hull.armAngles.length, ctx.hull.sparZ.length);
  }
  if (kernels.includes('wind')) patchWindMaterial(mat, ctx.windU);
  if (kernels.includes('fogFade')) fadeByFog(mat);
  /* 'foliageDither' — raster draws the legacy per-face vertex colours instead */
  if (ctx.roughnessAlpha && !mat.transparent && (mat as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
    patchRoughnessAlpha(mat);
  }
  return mat;
}
