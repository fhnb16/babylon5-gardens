/* Faithful port of three.js r165 TorusGeometry (ring in the XY plane, tube section around it). No groups. */

import { makeIndex, type MeshData } from '../mesh.ts';

export function torus(
  radius = 1, tube = 0.4, radialSegments = 12, tubularSegments = 48, arc = Math.PI * 2
): MeshData {
  radialSegments = Math.floor(radialSegments);
  tubularSegments = Math.floor(tubularSegments);

  const indices: number[] = [];
  const vertices: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];

  for (let j = 0; j <= radialSegments; j++) {
    for (let i = 0; i <= tubularSegments; i++) {
      const u = i / tubularSegments * arc;
      const v = j / radialSegments * Math.PI * 2;

      const vx = (radius + tube * Math.cos(v)) * Math.cos(u);
      const vy = (radius + tube * Math.cos(v)) * Math.sin(u);
      const vz = tube * Math.sin(v);
      vertices.push(vx, vy, vz);

      // normal = normalize(vertex - ringCentre)
      const nx0 = vx - radius * Math.cos(u);
      const ny0 = vy - radius * Math.sin(u);
      const k = 1 / (Math.sqrt(nx0 * nx0 + ny0 * ny0 + vz * vz) || 1);
      normals.push(nx0 * k, ny0 * k, vz * k);

      uvs.push(i / tubularSegments);
      uvs.push(j / radialSegments);
    }
  }

  for (let j = 1; j <= radialSegments; j++) {
    for (let i = 1; i <= tubularSegments; i++) {
      const a = (tubularSegments + 1) * j + i - 1;
      const b = (tubularSegments + 1) * (j - 1) + i - 1;
      const c = (tubularSegments + 1) * (j - 1) + i;
      const d = (tubularSegments + 1) * j + i;
      indices.push(a, b, d);
      indices.push(b, c, d);
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
