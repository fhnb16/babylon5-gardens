/* GeometryDesc → THREE.BufferGeometry: attributes in the legacy order
   (position, normal, uv, color), index, material groups, and the bounds the
   core already computed (box + sphere, identical to three's own). Arrays are
   shared with the descriptor, except the index when `copyIndex` is set (the
   three-mesh-bvh build reorders it in place). */

import * as THREE from 'three';
import type { GeometryDesc } from '../../../core/scene/types.ts';

export interface GeometryOptions {
  /** copy the index array (needed when a BVH will reorder it) */
  copyIndex?: boolean;
}

export function toBufferGeometry(d: GeometryDesc, opts: GeometryOptions = {}): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(d.position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(d.normal, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(d.uv, 2));
  if (d.color) g.setAttribute('color', new THREE.BufferAttribute(d.color, 3));
  if (d.index) {
    const idx = opts.copyIndex ? d.index.slice() : d.index;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  for (const gr of d.groups) g.addGroup(gr.start, gr.count, gr.slot);
  const b = d.bounds;
  g.boundingBox = new THREE.Box3(new THREE.Vector3(...b.min), new THREE.Vector3(...b.max));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(...b.center), b.radius);
  return g;
}
