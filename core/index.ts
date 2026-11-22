/* ═══════════════════════════════════════════════════════════════════════════
   core/ public barrel. Sub-libraries are namespaced (they share helper
   names such as surfacePos / cityBlock / lerp); the scene pipeline is
   exported flat.
   ═══════════════════════════════════════════════════════════════════════════ */

export type * from './scene/types.ts';
export { CORE_CONFIG } from './config/index.ts';
export type { CoreConfig, QualityPreset } from './config/index.ts';
export { mulberry32, pick } from './rng.ts';
export type { Rng } from './rng.ts';

export * as math from './math/index.ts';
export * as geometry from './geometry/index.ts';
export * as layout from './layout/index.ts';
export * as camera from './camera/index.ts';
export * as audio from './audio/field.ts';
export * as textures from './textures/index.ts';
export * as lighting from './lighting/phases.ts';

export { buildScene, defaultParams, mergeFragments, layoutHash, rasterLightsFor, viewsOf } from './scene/build.ts';
export { buildWorldFragment } from './scene/world.ts';
export type { WorldResult, WorldLayout, TreeData } from './scene/world.ts';
export { buildStructuresFragment } from './scene/structures.ts';
export { classifyLod, createLodOut, applyLod, lodNeedsUpdate } from './scene/lod.ts';
export type { LodOut } from './scene/lod.ts';
export { stepDynamics, stepTraffic, trafficMatrices } from './scene/dynamics.ts';
export type { DynamicsState, DynamicsOut } from './scene/dynamics.ts';
export { serializeScene, deserializeScene } from './scene/serialize.ts';
