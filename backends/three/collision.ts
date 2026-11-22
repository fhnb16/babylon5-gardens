/* ═══════════════════════════════════════════════════════════════════════════
   Camera collision against the hull: three-mesh-bvh, like legacy
   (js/world.js computeBoundsTree({ targetLeafSize: 8 }) on the hull geometry,
   js/controls.js setCollider + a first-hit ray along the move).

   The BVH extension is installed on the prototypes explicitly: without it
   `computeBoundsTree` does not exist and an optional call would silently do
   nothing (AGENTS.md pitfall). The hull is FrontSide with inward faces now;
   the raycast respects material.side, so a camera inside hits exactly the
   triangles the legacy BackSide hull exposed.

   prepareCollider(mesh)   — builds the BVH (reorders the index in place;
                             sceneGraph passes a copied index).
   createCollision(mesh)   — sweep(prev, next, radius): legacy controls.js
                             step — stop `radius` short of the first hit.
   The mesh can also be handed to js/controls.js setCollider() as is.
   ═══════════════════════════════════════════════════════════════════════════ */

import * as THREE from 'three';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';

/* legacy targetLeafSize of the hull BVH */
const LEAF = 8;

type BvhGeometry = THREE.BufferGeometry & {
  computeBoundsTree?: (o?: { targetLeafSize?: number }) => unknown;
  disposeBoundsTree?: () => void;
  boundsTree?: unknown;
};

function installBvh(): void {
  const G = THREE.BufferGeometry.prototype as unknown as Record<string, unknown>;
  if (G.computeBoundsTree !== computeBoundsTree) G.computeBoundsTree = computeBoundsTree;
  if (G.disposeBoundsTree !== disposeBoundsTree) G.disposeBoundsTree = disposeBoundsTree;
  const M = THREE.Mesh.prototype as unknown as Record<string, unknown>;
  if (M.raycast !== acceleratedRaycast) M.raycast = acceleratedRaycast;
}

/** Build the BVH on the mesh geometry. Returns the mesh. */
export function prepareCollider<T extends THREE.Mesh>(mesh: T): T {
  installBvh();
  const g = mesh.geometry as BvhGeometry;
  if (typeof g.computeBoundsTree !== 'function') throw new Error('collision: three-mesh-bvh not installed');
  if (!g.boundsTree) g.computeBoundsTree({ targetLeafSize: LEAF });
  return mesh;
}

export interface Collision {
  mesh: THREE.Mesh;
  /**
   * Move from `prev` to `next` (world space); if the hull is closer than
   * `radius` along the way, `next` is pulled back to stop `radius` short.
   * Returns true on a hit.
   */
  sweep(prev: THREE.Vector3, next: THREE.Vector3, radius: number): boolean;
  dispose(): void;
}

export function createCollision(mesh: THREE.Mesh): Collision {
  prepareCollider(mesh);
  const ray = new THREE.Raycaster();
  (ray as THREE.Raycaster & { firstHitOnly?: boolean }).firstHitOnly = true;
  const dir = new THREE.Vector3();
  return {
    mesh,
    sweep(prev, next, radius) {
      dir.copy(next).sub(prev);
      const dist = dir.length();
      if (dist <= 1e-5) return false;
      dir.divideScalar(dist);
      ray.set(prev, dir);
      ray.far = dist + radius;
      const hit = ray.intersectObject(mesh, false)[0];
      if (hit && hit.distance < dist + radius) {
        next.copy(prev).addScaledVector(dir, Math.max(0, hit.distance - radius));
        return true;
      }
      return false;
    },
    dispose() {
      (mesh.geometry as BvhGeometry).disposeBoundsTree?.();
    }
  };
}
