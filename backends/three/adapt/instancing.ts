/* ═══════════════════════════════════════════════════════════════════════════
   InstanceSet → THREE.InstancedMesh, legacy layout:

   · MeshDesc.sectored (legacy js/world.js `instance()`): one InstancedMesh per
     chunk, named `<role>.s<bucket>` with InstanceChunk.bucket (empty buckets
     are skipped by the core, so bucket ≠ chunk index), capacity = count =
     chunk.count, bounding sphere = chunk.sphere (the core reproduces
     InstancedMesh.computeBoundingSphere exactly), frustumCulled.
   · everything else (structures' truss/end caps, dynamic traffic/lifts):
     one InstancedMesh named `<role>`, frustumCulled = false, no bounding
     sphere — like legacy.
   ═══════════════════════════════════════════════════════════════════════════ */

import * as THREE from 'three';
import { CORE_CONFIG } from '../../../core/config/index.ts';
import type { InstanceChunk, QualityId } from '../../../core/scene/types.ts';

/** Sector bucket count of a quality preset (legacy `Q.chunks || CONFIG.CHUNKS`). */
export function sectorCount(quality: QualityId): number {
  const Q = CORE_CONFIG.QUALITY[quality] || CORE_CONFIG.QUALITY.HIGH;
  return Q.chunks || CORE_CONFIG.CHUNKS;
}

/** Legacy bucket numbers of the chunks (InstanceChunk.bucket; chunk index if absent). */
export function chunkBuckets(chunks: readonly InstanceChunk[]): number[] {
  return chunks.map((ch, i) => ch.bucket ?? i);
}

export interface InstancedOptions {
  name: string;
  matrices: Float32Array;
  colors?: Float32Array | null;
  /** per-instance wind params (phase, amplitude) — bound per object for the node
      wind kernel (tsl/wind.ts reads object.userData.b5Wind) */
  wind?: Float32Array | null;
  /** capacity (defaults to the instance count of `matrices`) */
  capacity?: number;
  count?: number;
  sphere?: readonly number[] | null;
  frustumCulled: boolean;
  renderOrder?: number;
}

/** InstancedMesh whose attributes WRAP the given arrays (no copy). */
export function makeInstanced(geo: THREE.BufferGeometry, mat: THREE.Material | THREE.Material[], o: InstancedOptions): THREE.InstancedMesh {
  const cap = o.capacity ?? o.matrices.length / 16;
  const im = new THREE.InstancedMesh(geo, mat, cap);
  im.instanceMatrix = new THREE.InstancedBufferAttribute(o.matrices, 16);
  if (o.colors) im.instanceColor = new THREE.InstancedBufferAttribute(o.colors, 3);
  if (o.wind) im.userData.b5Wind = new THREE.InstancedBufferAttribute(o.wind, 2);
  im.count = o.count ?? cap;
  im.name = o.name;
  im.frustumCulled = o.frustumCulled;
  if (o.sphere) im.boundingSphere = new THREE.Sphere(new THREE.Vector3(o.sphere[0], o.sphere[1], o.sphere[2]), o.sphere[3]);
  if (o.renderOrder) im.renderOrder = o.renderOrder;
  return im;
}
