/* Faithful port of three.js r165 LatheGeometry, including its own normal
   computation (averaged adjacent profile-segment normals; NOT computeVertexNormals).
   `points` are [radius(x), height(y)] pairs of the profile. No groups.
   r165 quirk kept: the LAST profile vertex gets an UNNORMALIZED normal (its
   length is |dx,dy| of the previous segment). compat = 187 normalizes it, as
   later three versions do. */

import { makeIndex, type MeshData, type ThreeCompat } from '../mesh.ts';

export type LathePoint = readonly [number, number];

export function lathe(
  points: ReadonlyArray<LathePoint> = [[0, -0.5], [0.5, 0], [0, 0.5]],
  segments = 12, phiStart = 0, phiLength = Math.PI * 2, compat: ThreeCompat = 165
): MeshData {
  segments = Math.floor(segments);
  // clamp phiLength to [0, 2PI]
  phiLength = Math.max(0, Math.min(Math.PI * 2, phiLength));

  const indices: number[] = [];
  const vertices: number[] = [];
  const uvs: number[] = [];
  const initNormals: number[] = [];
  const normals: number[] = [];

  const inverseSegments = 1.0 / segments;
  const n = points.length;

  // pre-compute normals for the initial "meridian"
  let prevX = 0, prevY = 0;      // prevNormal (z is always 0)
  for (let j = 0; j <= n - 1; j++) {
    if (j === 0) {
      // first vertex on the path
      const dx = points[j + 1][0] - points[j][0];
      const dy = points[j + 1][1] - points[j][1];
      let nx = dy * 1.0;
      let ny = -dx;
      prevX = nx; prevY = ny;
      const k = 1 / (Math.sqrt(nx * nx + ny * ny) || 1);
      nx *= k; ny *= k;
      initNormals.push(nx, ny, 0);
    } else if (j === n - 1) {
      // last vertex on the path
      if (compat === 165) {
        initNormals.push(prevX, prevY, 0);
      } else {
        const k = 1 / (Math.sqrt(prevX * prevX + prevY * prevY) || 1);
        initNormals.push(prevX * k, prevY * k, 0);
      }
    } else {
      const dx = points[j + 1][0] - points[j][0];
      const dy = points[j + 1][1] - points[j][1];
      let nx = dy * 1.0;
      let ny = -dx;
      const curX = nx, curY = ny;
      nx += prevX;
      ny += prevY;
      const k = 1 / (Math.sqrt(nx * nx + ny * ny) || 1);
      nx *= k; ny *= k;
      initNormals.push(nx, ny, 0);
      prevX = curX; prevY = curY;
    }
  }

  // vertices, uvs and normals
  for (let i = 0; i <= segments; i++) {
    const phi = phiStart + i * inverseSegments * phiLength;
    const sin = Math.sin(phi);
    const cos = Math.cos(phi);

    for (let j = 0; j <= n - 1; j++) {
      vertices.push(points[j][0] * sin, points[j][1], points[j][0] * cos);
      uvs.push(i / segments, j / (n - 1));
      normals.push(initNormals[3 * j + 0] * sin, initNormals[3 * j + 1], initNormals[3 * j + 0] * cos);
    }
  }

  // indices
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < n - 1; j++) {
      const base = j + i * n;
      const a = base;
      const b = base + n;
      const c = base + n + 1;
      const d = base + 1;
      indices.push(a, b, d);
      indices.push(c, d, b);
    }
  }

  return {
    position: new Float32Array(vertices),
    normal: new Float32Array(normals),
    uv: new Float32Array(uvs),
    index: makeIndex(indices),
    groups: []
  };
}
