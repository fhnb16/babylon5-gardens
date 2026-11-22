/* ═══════════════════════════════════════════════════════════════════════════
   Billboards: BillboardSetDesc → THREE.Points (PointsMaterial size / sprite /
   additive, from the MaterialDesc; size and opacity are ParamRefs re-driven by
   applyLighting). Nav lights (station), clouds and dust motes (scene) — the
   latter two from core/scene/ambient.ts, like the 'glow' axial billboard
   mesh, which sceneGraph turns towards the camera every frame (faceGlow).
   ═══════════════════════════════════════════════════════════════════════════ */

import * as THREE from 'three';
import type { BillboardSetDesc } from '../../../core/scene/types.ts';
import { dayState, numOrRef } from '../materials/legacy.ts';

export function createBillboard(b: BillboardSetDesc, mat: THREE.PointsMaterial): THREE.Points {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(b.positions, 3));
  mat.size = numOrRef(b.size, dayState(), 1);
  const p = new THREE.Points(g, mat);
  p.name = b.role;
  return p;
}

/** Axial billboard (MeshDesc role 'glow'): turn the plane towards the camera around the axis. */
export function faceGlow(glow: THREE.Object3D, camWorld: THREE.Vector3): void {
  glow.rotation.z = Math.atan2(camWorld.x, -camWorld.y);
}
