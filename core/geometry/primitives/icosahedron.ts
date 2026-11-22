/* Port of three.js r165 IcosahedronGeometry (via polyhedron). Non-indexed;
   detail 0 = flat shaded 20 faces, detail n subdivides each edge into n+1. */

import type { MeshData } from '../mesh.ts';
import { polyhedron } from './polyhedron.ts';

export function icosahedron(radius = 1, detail = 0): MeshData {
  const t = (1 + Math.sqrt(5)) / 2;

  const vertices = [
    -1, t, 0, 1, t, 0, -1, -t, 0, 1, -t, 0,
    0, -1, t, 0, 1, t, 0, -1, -t, 0, 1, -t,
    t, 0, -1, t, 0, 1, -t, 0, -1, -t, 0, 1
  ];

  const indices = [
    0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11,
    1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
    3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9,
    4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1
  ];

  return polyhedron(vertices, indices, radius, detail);
}
