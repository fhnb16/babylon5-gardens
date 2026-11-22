/* ═══════════════════════════════════════════════════════════════════════════
   Wind sway of crowns, bushes and tufts on node materials.

   Legacy (patchWindMaterial) displaced the PRE-instance position
   (`transformed` in begin_vertex), so a vertex ended at M · (p + offset).
   three's material.positionNode runs AFTER instancing (positionLocal is
   already M · p there), so it would have to re-read the instance matrix to
   rotate the offset — 4 more vertex attributes, which with TAA's
   previous-matrix attributes push a crown to 18 > 16 (maxVertexAttributes on
   WebGL2 and WebGPU).

   So the offset is added where legacy added it: WindNodeMaterial overrides
   setupPosition() and adds the offset to positionLocal BEFORE three's own
   instancing transform (exactly the hook three uses for displacementMap).
   M then rotates it for free and normals stay untouched, like legacy.
     offset = core wind kernel at positionGeometry (= pGeom),
              phase / amplitude from the per-instance wind attribute
   The per-instance attribute (InstanceSet.wind / LodSetDesc.wind: phase,
   amplitude) is bound PER OBJECT (referenceAttribute on the rendered mesh,
   object.userData.b5Wind — adapt/instancing.ts, adapt/lod.ts), so one
   material serves every sector / LOD mesh, like three binds instanceMatrix.
   TAA velocity ignores the sway (positionPrevious is the rest pose).
   ═══════════════════════════════════════════════════════════════════════════ */

import * as TSL from 'three/tsl';
import { MeshStandardNodeMaterial, type NodeBuilder } from 'three/webgpu';
import { windOffset } from '../../../core/shading/kernels/wind.ts';
import type { WindUniforms } from '../materials/legacy.ts';
import { asT, pulled, runKernel, type TNode } from './kernelBridge.ts';

/** Object property path of the per-instance wind attribute (vec2: phase, amplitude). */
export const WIND_ATTRIBUTE = 'userData.b5Wind';

export interface WindNodeUniforms {
  time: TNode;
  wind: TNode;
}

export function createWindNodeUniforms(w: WindUniforms): WindNodeUniforms {
  return { time: pulled(() => w.uTime.value), wind: pulled(() => w.uWind.value) };
}

/** Pre-instance wind offset in geometry space (amplitude applied). */
export function windOffsetNode(U: WindNodeUniforms): TNode {
  const T = TSL;
  const params = asT(T.referenceAttribute(WIND_ATTRIBUTE, 'vec2'));
  const { offset } = runKernel(windOffset, {}, { pGeom: T.positionGeometry, phase: params.x }, { time: U.time, wind: U.wind });
  return offset.mul(params.y);
}

/** MeshStandardNodeMaterial whose `windNode` displaces the vertex before instancing. */
export class WindNodeMaterial extends MeshStandardNodeMaterial {
  /** geometry-space offset added to positionLocal before instancing; null = no wind */
  windNode: TNode | null = null;

  setupPosition(builder: NodeBuilder) {
    if (this.windNode) asT(TSL.positionLocal).addAssign(this.windNode);
    return super.setupPosition(builder);
  }
}
