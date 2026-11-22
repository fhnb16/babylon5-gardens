/* ═══════════════════════════════════════════════════════════════════════════
   Node materials: MaterialDesc → MeshStandardNodeMaterial /
   MeshBasicNodeMaterial / SpriteNodeMaterial for three's WebGPURenderer
   (WebGPU and its WebGL2 fallback). The same parameters as
   materials/legacy.ts createLegacyMaterial; the legacy GLSL patches become
   node graphs built from the SHARED core kernels (tsl/*):

     'hull'     → tsl/hull.ts      colorNode / roughnessNode / normalNode /
                                   emissiveNode (+ hullMirror when mirror on)
     'wind'     → tsl/wind.ts      WindNodeMaterial.windNode (offset added before\n                                   three's instancing, like legacy begin_vertex)
     'fogFade'  → tsl/fogfade.ts   opacityNode, fog off
     sprite     → SpriteNodeMaterial (instanced quads: tsl/billboards.ts)
     'foliageDither' — raster draws the legacy per-face vertex colours instead

   Not ported (by design): roughness → frame alpha (photo mode keeps the
   classic renderer; the TSL photo mode will use MRT).

   ParamRef-driven values start at their DAY value; adapt/palette.ts drives
   color / opacity / emissiveIntensity on these materials exactly as on the
   legacy ones (same property names, read by the node system every frame).
   ═══════════════════════════════════════════════════════════════════════════ */

import * as THREE from 'three';
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial, SpriteNodeMaterial, type Texture } from 'three/webgpu';
import type { HullDesc, MaterialDesc } from '../../../core/scene/types.ts';
import { applyCommon, dayState, numOrRef } from './legacy.ts';
import { hullNodes, type HullNodeUniforms } from '../tsl/hull.ts';
import { WindNodeMaterial, windOffsetNode, type WindNodeUniforms } from '../tsl/wind.ts';
import { fogFadeOpacity } from '../tsl/fogfade.ts';
import type { TNode } from '../tsl/kernelBridge.ts';
import { displayOutputNode, type DisplayOutputUniforms } from '../tsl/displayOutput.ts';

export interface NodeMaterialContext {
  /** texture for an image id (placeholder until pixels arrive), null if unknown */
  texture(id: string | undefined): Texture | null;
  hull: HullDesc;
  hullN: HullNodeUniforms;
  windN: WindNodeUniforms;
  /** FogExp2 density of the world (fogFade) */
  fogDensity: TNode;
  /** compile the analytic water reflection into the hull */
  mirror: boolean;
  /** 'display' output mode (tsl/displayOutput.ts); null = 'hdr' (three's own fog,
      tone mapping by the renderer / RenderPipeline) */
  display: DisplayOutputUniforms | null;
}

const setLinear = (c: THREE.Color, v: readonly number[]): THREE.Color => c.setRGB(v[0], v[1], v[2]);

/** (Re)build the hull nodes of a hull material; `mirror` toggles the reflection branch. */
export function setHullNodes(mat: MeshStandardNodeMaterial, d: MaterialDesc, ctx: NodeMaterialContext, mirror: boolean): void {
  const h = hullNodes(ctx.hullN, {
    map: ctx.texture(d.map), mask: ctx.texture(ctx.hull.mask), detail: ctx.texture(ctx.hull.detail)
  }, { nArm: ctx.hull.armAngles.length, nSpar: ctx.hull.sparZ.length, mirror });
  mat.colorNode = h.colorNode;
  mat.roughnessNode = h.roughnessNode;
  mat.normalNode = h.normalNode;
  mat.emissiveNode = h.emissiveNode;
  mat.userData.b5Mirror = mirror;
  mat.needsUpdate = true;
}

export const isHullDesc = (d: MaterialDesc): boolean => d.model === 'hull' || !!d.kernels?.includes('hull');

/** Build the node material for a descriptor. */
export function createNodeMaterial(d: MaterialDesc, ctx: NodeMaterialContext): THREE.Material {
  const state = dayState();
  let mat: THREE.Material;
  switch (d.model) {
    case 'unlit':
    case 'decal': {
      const m = new MeshBasicNodeMaterial();
      setLinear(m.color, d.baseColor);
      m.map = ctx.texture(d.map);
      mat = m;
      break;
    }
    case 'sprite': {
      const m = new SpriteNodeMaterial();
      setLinear(m.color, d.baseColor);
      m.map = ctx.texture(d.map);
      mat = m;
      break;
    }
    default: {
      /* standard | hull | thinGlass (raster fakes glazing as dark metal) */
      const m = d.kernels?.includes('wind') ? new WindNodeMaterial() : new MeshStandardNodeMaterial();
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
  if (isHullDesc(d)) setHullNodes(mat as MeshStandardNodeMaterial, d, ctx, ctx.mirror);
  if (mat instanceof WindNodeMaterial) mat.windNode = windOffsetNode(ctx.windN);
  if (kernels.includes('fogFade')) {
    (mat as MeshBasicNodeMaterial).fog = false;
    (mat as MeshBasicNodeMaterial).opacityNode = fogFadeOpacity(ctx.fogDensity);
  }
  if (ctx.display) {
    const nm = mat as MeshBasicNodeMaterial;
    nm.outputNode = displayOutputNode(ctx.display, { toneMapped: nm.toneMapped, fog: nm.fog });
    nm.fog = false;
  }
  return mat;
}
