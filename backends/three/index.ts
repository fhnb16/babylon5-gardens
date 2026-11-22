/* backends/three — three.js r187 raster backend (see README.md).
   Renderers: renderer.ts (WebGPU / WebGL2 via WebGPURenderer / classic).
   Materials: materials/legacy.ts (classic GLSL patches), materials/node.ts
   (TSL node materials from the shared core kernels, tsl/*). Post: post/* (R1b). */

export { createRenderer, parseRendererMode, assertSingleThree, isWebGPURenderer, RENDERER_MODES } from './renderer.ts';
export type { RendererMode, RendererInfo, B5Renderer, AnyRenderer, CreateRendererOptions } from './renderer.ts';
export { createThreeWorld } from './adapt/sceneGraph.ts';
export type { ThreeWorld, ThreeWorldOptions, MaterialFlavour } from './adapt/sceneGraph.ts';
export { applyLighting, driveFrame, pointsTarget } from './adapt/palette.ts';
export type { BillboardTarget, PaletteTargets } from './adapt/palette.ts';
export { createNodeMaterial, setHullNodes } from './materials/node.ts';
export type { NodeMaterialContext } from './materials/node.ts';
export { WindNodeMaterial, windOffsetNode } from './tsl/wind.ts';
export { hullNodes, createHullNodeUniforms } from './tsl/hull.ts';
export { displayOutputNode } from './tsl/displayOutput.ts';
export { KT, runKernel } from './tsl/kernelBridge.ts';
export { createTextureSet, createTexture, fillTexture, flipRows, maxAnisotropyOf } from './adapt/textures.ts';
export type { TextureSet, RendererLike } from './adapt/textures.ts';
export { toBufferGeometry } from './adapt/geometry.ts';
export { chunkBuckets, makeInstanced, sectorCount } from './adapt/instancing.ts';
export { createLod } from './adapt/lod.ts';
export type { ThreeLod } from './adapt/lod.ts';
export { createDynamics } from './adapt/dynamics.ts';
export { createBillboard, faceGlow } from './adapt/billboards.ts';
export { createLights } from './adapt/lights.ts';
export {
  createLegacyMaterial, createHullUniforms, createWindUniforms, patchHullMaterial, patchWindMaterial,
  fadeByFog, patchRoughnessAlpha, evalRef, applyCommon
} from './materials/legacy.ts';
export { prepareCollider, createCollision } from './collision.ts';
export type { Collision } from './collision.ts';
