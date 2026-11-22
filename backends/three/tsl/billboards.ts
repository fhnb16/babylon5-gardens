/* ═══════════════════════════════════════════════════════════════════════════
   Billboards for the node path: BillboardSetDesc → ONE instanced THREE.Sprite
   (count = number of points) with a SpriteNodeMaterial. WebGPU has no point
   size (PointsMaterial.size > 1 is ignored), so the legacy THREE.Points
   become camera-facing quads of the same on-screen size:

     legacy point:  P_px = size · (H/2) / depth          (sizeAttenuation)
     sprite quad:   P_px = s · (H/2) / (depth · tan(fov/2))
     ⇒ s = size · tan(fov/2)   — `sizeK` (tan of the camera half-FOV) is a
       uniform the world updates from the camera every frame.

   Points are clipped by their CENTRE: a legacy point whose centre leaves the
   view volume disappears whole, however large it is (a sprite quad would
   still cover the screen — 14 clouds of size 52 next to the camera turned
   the whole view hazy). So the scale collapses to 0 when the centre is
   outside the clip volume or the near/far range.

   Per-instance centre: positionNode = instancedBufferAttribute(positions).
   Size: per set uniform (palette drives it through setSize, the ParamRef in
   BillboardSetDesc.size); colour: the material colour (motes).
   ═══════════════════════════════════════════════════════════════════════════ */

import * as THREE from 'three';
import * as TSL from 'three/tsl';
import type { SpriteNodeMaterial } from 'three/webgpu';
import type { BillboardSetDesc } from '../../../core/scene/types.ts';
import { asT, type TNode } from './kernelBridge.ts';

export interface SpriteBillboard {
  object: THREE.Sprite;
  material: SpriteNodeMaterial;
  setSize(v: number): void;
  color: THREE.Color;
  /** frees the per-instance centre buffer */
  dispose(): void;
}

export function createSpriteBillboard(b: BillboardSetDesc, mat: SpriteNodeMaterial, sizeK: TNode, size: number): SpriteBillboard {
  const n = b.positions.length / 3;
  const centres = new THREE.InstancedBufferAttribute(b.positions, 3);
  const sizeU = TSL.uniform(size);
  const T = TSL;
  const centre = asT(T.instancedBufferAttribute(centres, 'vec3'));
  const mv = T.modelViewMatrix.mul(T.vec4(centre, 1));
  const clip = T.cameraProjectionMatrix.mul(mv);
  const depth = mv.z.negate();
  const inside = T.abs(clip.x).lessThanEqual(clip.w).and(T.abs(clip.y).lessThanEqual(clip.w))
    .and(depth.greaterThan(T.cameraNear)).and(depth.lessThan(T.cameraFar));
  mat.positionNode = centre;
  mat.scaleNode = T.select(inside, asT(sizeU).mul(sizeK), 0);
  const s = new THREE.Sprite(mat as unknown as THREE.SpriteMaterial);
  s.count = n;
  s.name = b.role;
  /* the sprite's own bounds are a unit quad at its origin: never cull the set */
  s.frustumCulled = false;
  return {
    object: s, material: mat,
    setSize(v) { sizeU.value = v; },
    color: mat.color,
    dispose() { centres.dispose(); }
  };
}
