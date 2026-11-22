/* Faithful port of three.js r165 BoxGeometry: same vertex order, UVs, indices and groups
   (6 groups, material slots 0..5 = +x, -x, +y, -y, +z, -z). */

import type { GeometryGroup } from '../../scene/types.ts';
import { makeIndex, type MeshData } from '../mesh.ts';

export function box(
  width = 1, height = 1, depth = 1,
  widthSegments = 1, heightSegments = 1, depthSegments = 1
): MeshData {
  widthSegments = Math.floor(widthSegments);
  heightSegments = Math.floor(heightSegments);
  depthSegments = Math.floor(depthSegments);

  const indices: number[] = [];
  const vertices: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const groups: GeometryGroup[] = [];

  let numberOfVertices = 0;
  let groupStart = 0;

  // u, v, w are component indices (0 = x, 1 = y, 2 = z)
  const buildPlane = (
    u: number, v: number, w: number, udir: number, vdir: number,
    pw: number, ph: number, pd: number, gridX: number, gridY: number, materialIndex: number
  ): void => {
    const segmentWidth = pw / gridX;
    const segmentHeight = ph / gridY;
    const widthHalf = pw / 2;
    const heightHalf = ph / 2;
    const depthHalf = pd / 2;
    const gridX1 = gridX + 1;
    const gridY1 = gridY + 1;

    let vertexCounter = 0;
    let groupCount = 0;
    const vector = [0, 0, 0];

    for (let iy = 0; iy < gridY1; iy++) {
      const y = iy * segmentHeight - heightHalf;
      for (let ix = 0; ix < gridX1; ix++) {
        const x = ix * segmentWidth - widthHalf;

        vector[u] = x * udir;
        vector[v] = y * vdir;
        vector[w] = depthHalf;
        vertices.push(vector[0], vector[1], vector[2]);

        vector[u] = 0;
        vector[v] = 0;
        vector[w] = pd > 0 ? 1 : -1;
        normals.push(vector[0], vector[1], vector[2]);

        uvs.push(ix / gridX);
        uvs.push(1 - iy / gridY);

        vertexCounter += 1;
      }
    }

    for (let iy = 0; iy < gridY; iy++) {
      for (let ix = 0; ix < gridX; ix++) {
        const a = numberOfVertices + ix + gridX1 * iy;
        const b = numberOfVertices + ix + gridX1 * (iy + 1);
        const c = numberOfVertices + (ix + 1) + gridX1 * (iy + 1);
        const d = numberOfVertices + (ix + 1) + gridX1 * iy;
        indices.push(a, b, d);
        indices.push(b, c, d);
        groupCount += 6;
      }
    }

    groups.push({ start: groupStart, count: groupCount, slot: materialIndex });
    groupStart += groupCount;
    numberOfVertices += vertexCounter;
  };

  buildPlane(2, 1, 0, -1, -1, depth, height, width, depthSegments, heightSegments, 0); // px
  buildPlane(2, 1, 0, 1, -1, depth, height, -width, depthSegments, heightSegments, 1); // nx
  buildPlane(0, 2, 1, 1, 1, width, depth, height, widthSegments, depthSegments, 2); // py
  buildPlane(0, 2, 1, 1, -1, width, depth, -height, widthSegments, depthSegments, 3); // ny
  buildPlane(0, 1, 2, 1, -1, width, height, depth, widthSegments, heightSegments, 4); // pz
  buildPlane(0, 1, 2, -1, -1, width, height, -depth, widthSegments, heightSegments, 5); // nz

  return {
    position: new Float32Array(vertices),
    normal: new Float32Array(normals),
    uv: new Float32Array(uvs),
    index: makeIndex(indices),
    groups
  };
}
