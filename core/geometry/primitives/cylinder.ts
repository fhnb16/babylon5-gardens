/* Faithful port of three.js r165 CylinderGeometry (Y axis, theta measured from +Z).
   Groups: 0 = torso, 1 = top cap, 2 = bottom cap (each only if generated).
   compat = 187 reproduces the later three change that drops the degenerate
   apex triangles when radiusTop or radiusBottom is 0 (only differs in that case). */

import type { GeometryGroup } from '../../scene/types.ts';
import { makeIndex, type MeshData, type ThreeCompat } from '../mesh.ts';

export function cylinder(
  radiusTop = 1, radiusBottom = 1, height = 1,
  radialSegments = 32, heightSegments = 1, openEnded = false,
  thetaStart = 0, thetaLength = Math.PI * 2, compat: ThreeCompat = 165
): MeshData {
  radialSegments = Math.floor(radialSegments);
  heightSegments = Math.floor(heightSegments);

  const indices: number[] = [];
  const vertices: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const groups: GeometryGroup[] = [];

  let index = 0;
  const indexArray: number[][] = [];
  const halfHeight = height / 2;
  let groupStart = 0;

  const generateTorso = (): void => {
    let groupCount = 0;
    const slope = (radiusBottom - radiusTop) / height;

    for (let y = 0; y <= heightSegments; y++) {
      const indexRow: number[] = [];
      const v = y / heightSegments;
      const radius = v * (radiusBottom - radiusTop) + radiusTop;

      for (let x = 0; x <= radialSegments; x++) {
        const u = x / radialSegments;
        const theta = u * thetaLength + thetaStart;
        const sinTheta = Math.sin(theta);
        const cosTheta = Math.cos(theta);

        vertices.push(radius * sinTheta, -v * height + halfHeight, radius * cosTheta);

        // normal.set(sinTheta, slope, cosTheta).normalize()
        const k = 1 / (Math.sqrt(sinTheta * sinTheta + slope * slope + cosTheta * cosTheta) || 1);
        normals.push(sinTheta * k, slope * k, cosTheta * k);

        uvs.push(u, 1 - v);
        indexRow.push(index++);
      }
      indexArray.push(indexRow);
    }

    for (let x = 0; x < radialSegments; x++) {
      for (let y = 0; y < heightSegments; y++) {
        const a = indexArray[y][x];
        const b = indexArray[y + 1][x];
        const c = indexArray[y + 1][x + 1];
        const d = indexArray[y][x + 1];
        if (compat === 165) {
          indices.push(a, b, d);
          indices.push(b, c, d);
          groupCount += 6;
        } else {
          if (radiusTop > 0 || y !== 0) { indices.push(a, b, d); groupCount += 3; }
          if (radiusBottom > 0 || y !== heightSegments - 1) { indices.push(b, c, d); groupCount += 3; }
        }
      }
    }

    groups.push({ start: groupStart, count: groupCount, slot: 0 });
    groupStart += groupCount;
  };

  const generateCap = (top: boolean): void => {
    const centerIndexStart = index;
    let groupCount = 0;
    const radius = top ? radiusTop : radiusBottom;
    const sign = top ? 1 : -1;

    // one centre vertex per segment (each face needs its own UV)
    for (let x = 1; x <= radialSegments; x++) {
      vertices.push(0, halfHeight * sign, 0);
      normals.push(0, sign, 0);
      uvs.push(0.5, 0.5);
      index++;
    }
    const centerIndexEnd = index;

    for (let x = 0; x <= radialSegments; x++) {
      const u = x / radialSegments;
      const theta = u * thetaLength + thetaStart;
      const cosTheta = Math.cos(theta);
      const sinTheta = Math.sin(theta);

      vertices.push(radius * sinTheta, halfHeight * sign, radius * cosTheta);
      normals.push(0, sign, 0);
      uvs.push(cosTheta * 0.5 + 0.5, sinTheta * 0.5 * sign + 0.5);
      index++;
    }

    for (let x = 0; x < radialSegments; x++) {
      const c = centerIndexStart + x;
      const i = centerIndexEnd + x;
      if (top) indices.push(i, i + 1, c);
      else indices.push(i + 1, i, c);
      groupCount += 3;
    }

    groups.push({ start: groupStart, count: groupCount, slot: top ? 1 : 2 });
    groupStart += groupCount;
  };

  generateTorso();
  if (!openEnded) {
    if (radiusTop > 0) generateCap(true);
    if (radiusBottom > 0) generateCap(false);
  }

  return {
    position: new Float32Array(vertices),
    normal: new Float32Array(normals),
    uv: new Float32Array(uvs),
    index: makeIndex(indices),
    groups
  };
}
