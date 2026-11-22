/* ═══════════════════════════════════════════════════════════════════════════
   Shading-kernel CONTRACTS — I/O of the shared kernels in core/shading/kernels.

   Owner: lead. Read-only for other agents.

   A kernel is authored ONCE (core/shading/kernels/*.ts) against the
   TSL-compatible subset `K` (core/shading/kernel.ts) and consumed by:
     • backends/three   — K = real `three/tsl` → WGSL (WebGPU) and GLSL (WebGL2)
     • pathtracer/      — K = AST recorder → WGSL via core/shading/emit/wgsl.ts
     • backends/threert — same WGSL, wrapped into MaterialFunction bodies
     • tests            — K = CPU evaluator (core/shading/emit/cpu.ts)

   Rules:
   • Kernels never sample textures. Backends sample and pass VALUES in.
   • No camera-distance hacks inside kernels: the backend passes `far`
     (0 = full detail … 1 = fully faded), computed from distance in raster
     (legacy parity: smoothstep(25, 90, viewDist)) and from the ray-cone
     footprint in tracers (see farFromFootprint below).
   • Emitted WGSL: pure functions, identifiers prefixed b5_/B5, f32 only,
     no bindings, no `override`, no `enable`, no `$` (ThreeRT substitutes $Name),
     no recursion. GLSL mod() is floored: emit x - y*floor(x/y), never `%`.
   • smoothstep(lo, hi, x) only with lo < hi (WGSL leaves reversed edges
     undefined): write 1 - smoothstep(hi, lo, x) instead.
   • atan is the two-argument atan(y, x) (GLSL / r187 TSL order; WGSL atan2(y, x)).
   • Branches are expressed with select(cond, ifTrue, ifFalse) — both sides
     are evaluated in WGSL, so guard sqrt/division in the not-taken side.
   • Kernel `p` (hull surface coordinates) is TRUE arc length: x = u·2πR,
     y = v·L. Legacy GLSL used u·314 — a 0.05 % phase difference, accepted.
   • Raster-only effects are flagged and must be skipped by tracers:
     analytic truss shadows (tracers have real shadows) and analytic
     tube/hull reflections in water (tracers have real reflections).
   ═══════════════════════════════════════════════════════════════════════════ */

import type { Linear3 } from '../scene/types.ts';

/** Scalar / vector kinds used in kernel I/O declarations. */
export type KType = 'f32' | 'vec2' | 'vec3';

export interface KernelSignature {
  /** WGSL function name (b5_ prefix) */
  name: string;
  inputs: Record<string, KType>;
  /** array lengths here are DEFAULTS; kernels with options (e.g. HullKernelOptions
      nArm/nSpar) report the effective signature via kernel.signatureFor(opts) */
  uniforms: Record<string, KType | { array: 'f32'; length: number }>;
  outputs: Record<string, KType>;
  /** true: the whole kernel is raster-only (tracers must not use it);
      string[]: names of raster-only inputs/uniforms (unused when raster=false) */
  rasterOnly?: boolean | string[];
}

/* ─── hull surface ───────────────────────────────────────────────────────── */

/**
 * Hull (habitat floor) surface: detail modulation, water absorption, edge foam,
 * water roughness, ripple slope, city glow emission.
 * Ported from js/world.js patchHullMaterial (GLSL, lines ~91–194).
 */
export const HULL_SURFACE: KernelSignature = {
  name: 'b5_hull_surface',
  inputs: {
    /** albedo sampled from the hull map, linear */
    base: 'vec3',
    /** hull mask sample: r = water depth 0..1, g = grass, b = pavement */
    mask: 'vec3',
    /** detail texture .r at uv*detailRep and at uv*detailRep*0.31 */
    dGrass: 'f32',
    dPave: 'f32',
    /** base roughness (material roughness × roughness map) */
    baseRough: 'f32',
    /** surface coordinates in station units: x = arc length (u·2πR), y = axial (v·L) */
    p: 'vec2',
    /** 0 = full detail … 1 = far (fades fine ripples, widens water roughness) */
    far: 'f32',
    /** station-local angle θ and axial z of the point (for raster-only truss shadow) */
    theta: 'f32',
    z: 'f32',
  },
  uniforms: {
    time: 'f32',
    flow: 'f32',          // CONFIG.RIVER_FLOW
    foam: 'f32',          // CONFIG.WATER.foam
    ripple: 'f32',        // CONFIG.WATER.ripple
    waterTint: 'vec3',    // LightingState.waterTint (linear)
    cityGlow: 'f32',      // LightingState.cityGlow
    citySpill: 'f32',     // CONFIG.CITY.spill
    /* raster-only truss shadow */
    sparShade: 'f32',
    armW: 'f32',
    sparZW: 'f32',
    arms: { array: 'f32', length: 3 },     // CONFIG.AXIS.sparArms
    sparZ: { array: 'f32', length: 4 },    // CONFIG.AXIS.spars
  },
  rasterOnly: ['theta', 'z', 'sparShade', 'armW', 'sparZW', 'arms', 'sparZ'],
  outputs: {
    /** final albedo (linear), incl. water tint, foam; truss shadow only if raster */
    albedo: 'vec3',
    roughness: 'f32',
    /** ripple slope in the (arc, axis) tangent frame, amplitude applied.
        Perturbed normal = normalize(nGeom + tArc*slope.x + tAxis*slope.y),
        then mixed with the mapped normal by water weight. */
    slope: 'vec2',
    /** water weight 0..1 (= mask.r); tracers switch to the water BSDF by it */
    water: 'f32',
    /** emitted radiance from street lamps (raster-relative units) */
    emissive: 'vec3',
  },
};

/** Kernel build options (compile-time, not uniforms). */
export interface HullKernelOptions {
  /** include raster-only effects (truss shadow). Tracers pass false. */
  raster: boolean;
  nArm: number;
  nSpar: number;
}

/* ─── analytic water reflection (raster only) ────────────────────────────── */

/**
 * Port of the legacy `uMirror` branch: reflects the axis tube and the opposite
 * hull in water analytically (both are cylinders along the axis). Tracers get
 * real reflections and MUST NOT use it. The backend adds
 *   sunEmissive + texture(hullMap, hullUv).rgb * hullWeight
 * to the emissive radiance.
 */
export const HULL_MIRROR: KernelSignature = {
  name: 'b5_hull_mirror',
  inputs: {
    /** station-local angle θ and axial z of the hull point */
    theta: 'f32',
    z: 'f32',
    /** ripple slope from b5_hull_surface */
    slope: 'vec2',
    /** water weight from b5_hull_surface (= mask.r) */
    water: 'f32',
  },
  uniforms: {
    mirror: 'f32',     // legacy uMirror (0 disables)
    sunR: 'f32',       // CONFIG.SUN.r — radius of the axis light tube
    hullR: 'f32',      // CONFIG.R
    hullL: 'f32',      // CONFIG.L
    sunGlow: 'f32',    // legacy uSunGlow
    camObj: 'vec3',    // camera position in station space
  },
  outputs: {
    /** reflected axis-tube radiance, weighted (add to emissive) */
    sunEmissive: 'vec3',
    /** hull-map UV of the reflected hull hit (backend samples the albedo there) */
    hullUv: 'vec2',
    /** weight of that sample (0 when no hull hit) */
    hullWeight: 'f32',
  },
  rasterOnly: true,
};

/* ─── wind ───────────────────────────────────────────────────────────────── */

/**
 * Crown/bush/tuft sway. Offset is computed in PRE-instance (geometry) space;
 * three's positionNode runs after instancing, so the bridge adds the offset
 * rotated by the instance matrix. The per-instance phase comes from the
 * InstanceSet.wind attribute (phase, scale) — NOT from instanceMatrix[3].
 * Tracers freeze wind (rest pose).
 */
export const WIND_OFFSET: KernelSignature = {
  name: 'b5_wind_offset',
  inputs: {
    /** vertex position in geometry space */
    pGeom: 'vec3',
    /** per-instance phase (legacy: m[3][0]*0.7 + m[3][2]*0.3) */
    phase: 'f32',
  },
  uniforms: {
    time: 'f32',
    wind: 'f32',
  },
  outputs: {
    offset: 'vec3',
  },
};

/* ─── fog fade for additive billboards ───────────────────────────────────── */

export const FOG_FADE: KernelSignature = {
  name: 'b5_fog_fade',
  inputs: { viewDist: 'f32', opacity: 'f32' },
  uniforms: { fogDensity: 'f32' },
  outputs: { opacity: 'f32' },
};

/* ─── foliage per-face dither (ThreeRT: no vertex colours) ───────────────── */

export const FOLIAGE_DITHER: KernelSignature = {
  name: 'b5_foliage_dither',
  inputs: { pWorld: 'vec3' },
  uniforms: { amount: 'f32', cell: 'f32' },
  outputs: { k: 'f32' },
};

/* ─── shared helpers ─────────────────────────────────────────────────────── */

/** Legacy raster detail fade: smoothstep(25, 90, viewDist). */
export const FAR_NEAR_UNITS = 25;
export const FAR_FAR_UNITS = 90;

/**
 * Reference pixel angle used to translate a ray-cone footprint (world width
 * of one pixel, station units) into the legacy distance-based `far` value:
 * viewDist ≈ footprint / REF_PIXEL_ANGLE. Matches a 1080p, 70° vertical FOV view.
 */
export const REF_PIXEL_ANGLE = (2 * Math.tan((70 * Math.PI) / 360)) / 1080;

export function farFromFootprint(footprint: number): number {
  const d = footprint / REF_PIXEL_ANGLE;
  const t = Math.min(1, Math.max(0, (d - FAR_NEAR_UNITS) / (FAR_FAR_UNITS - FAR_NEAR_UNITS)));
  return t * t * (3 - 2 * t);
}

/* ─── AOV contract between pathtracer/ and the backends/three post chain ─── */

export const AOV_FORMATS = {
  color: 'rgba16float',     // linear HDR scene radiance = nits × exposureFromEv100(ev100)
                            // (exposure already applied; the post chain uses exposure ≈ 1)
  albedo: 'rgba8unorm',     // first non-specular vertex albedo
  normal: 'rgba16float',    // view-space normal xyz
  depth: 'r32float',        // linear view depth, station units
  motion: 'rg16float',      // screen-space motion (realtime phase)
  materialId: 'r16uint',
} as const;

export type AovName = keyof typeof AOV_FORMATS;

/** Constant foam colour used by the hull kernel (linear-ish legacy value). */
export const FOAM_COLOR: Linear3 = [0.55, 0.62, 0.66];
/** Street-lamp tint used by the hull kernel. */
export const LAMP_TINT: Linear3 = [1.0, 0.86, 0.66];
