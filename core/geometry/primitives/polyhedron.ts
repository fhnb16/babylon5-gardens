/* Faithful port of three.js r165 PolyhedronGeometry: face subdivision, projection
   onto a sphere, spherical UVs with the two seam corrections (correctUVs,
   correctSeam), flat normals for detail 0 and smooth (radial) for detail > 0.
   The result is NON-indexed. All intermediate maths is in doubles (plain
   arrays) and rounded to Float32 only at the end, exactly like three. */

import { computeVertexNormals, normalizeNormals, type MeshData } from '../mesh.ts';

type V3 = [number, number, number];

const lerp3 = (a: V3, b: V3, t: number): V3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t
];

/** Angle around the Y axis, counter-clockwise seen from above. */
const azimuth = (x: number, z: number): number => Math.atan2(z, -x);
/** Angle above the XZ plane. */
const inclination = (x: number, y: number, z: number): number =>
  Math.atan2(-y, Math.sqrt(x * x + z * z));

export function polyhedron(
  vertices: ArrayLike<number>, indices: ArrayLike<number>, radius = 1, detail = 0
): MeshData {
  const vertexBuffer: number[] = [];
  const uvBuffer: number[] = [];

  const pushVertex = (v: V3): void => { vertexBuffer.push(v[0], v[1], v[2]); };

  const subdivideFace = (a: V3, b: V3, c: V3, det: number): void => {
    const cols = det + 1;
    const v: V3[][] = [];

    for (let i = 0; i <= cols; i++) {
      v[i] = [];
      const aj = lerp3(a, c, i / cols);
      const bj = lerp3(b, c, i / cols);
      const rows = cols - i;
      for (let j = 0; j <= rows; j++) {
        if (j === 0 && i === cols) v[i][j] = aj;
        else v[i][j] = lerp3(aj, bj, j / rows);
      }
    }

    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < 2 * (cols - i) - 1; j++) {
        const k = Math.floor(j / 2);
        if (j % 2 === 0) {
          pushVertex(v[i][k + 1]);
          pushVertex(v[i + 1][k]);
          pushVertex(v[i][k]);
        } else {
          pushVertex(v[i][k + 1]);
          pushVertex(v[i + 1][k + 1]);
          pushVertex(v[i + 1][k]);
        }
      }
    }
  };

  // subdivision creates the vertex buffer data
  for (let i = 0; i < indices.length; i += 3) {
    const get = (idx: number): V3 => [vertices[idx * 3], vertices[idx * 3 + 1], vertices[idx * 3 + 2]];
    subdivideFace(get(indices[i]), get(indices[i + 1]), get(indices[i + 2]), detail);
  }

  // all vertices lie on a sphere of the given radius
  for (let i = 0; i < vertexBuffer.length; i += 3) {
    const x = vertexBuffer[i], y = vertexBuffer[i + 1], z = vertexBuffer[i + 2];
    const k = 1 / (Math.sqrt(x * x + y * y + z * z) || 1);
    vertexBuffer[i] = x * k * radius;
    vertexBuffer[i + 1] = y * k * radius;
    vertexBuffer[i + 2] = z * k * radius;
  }

  // uv data
  for (let i = 0; i < vertexBuffer.length; i += 3) {
    const x = vertexBuffer[i], y = vertexBuffer[i + 1], z = vertexBuffer[i + 2];
    const u = azimuth(x, z) / 2 / Math.PI + 0.5;
    const v = inclination(x, y, z) / Math.PI + 0.5;
    uvBuffer.push(u, 1 - v);
  }

  // correctUVs
  for (let i = 0, j = 0; i < vertexBuffer.length; i += 9, j += 6) {
    const ax = vertexBuffer[i], az = vertexBuffer[i + 2];
    const bx = vertexBuffer[i + 3], bz = vertexBuffer[i + 5];
    const cx = vertexBuffer[i + 6], cz = vertexBuffer[i + 8];

    // centroid.copy(a).add(b).add(c).divideScalar(3)  (divideScalar = multiplyScalar(1/3));
    // only x and z matter for the azimuth
    const k3 = 1 / 3;
    const centroidX = (ax + bx + cx) * k3;
    const centroidZ = (az + bz + cz) * k3;
    const azi = azimuth(centroidX, centroidZ);

    const correctUV = (stride: number, vx: number, vz: number): void => {
      if (azi < 0 && uvBuffer[stride] === 1) uvBuffer[stride] = uvBuffer[stride] - 1;
      if (vx === 0 && vz === 0) uvBuffer[stride] = azi / 2 / Math.PI + 0.5;
    };
    correctUV(j + 0, ax, az);
    correctUV(j + 2, bx, bz);
    correctUV(j + 4, cx, cz);
  }

  // correctSeam: faces straddling the seam (see three.js #3269)
  for (let i = 0; i < uvBuffer.length; i += 6) {
    const x0 = uvBuffer[i + 0];
    const x1 = uvBuffer[i + 2];
    const x2 = uvBuffer[i + 4];
    const max = Math.max(x0, x1, x2);
    const min = Math.min(x0, x1, x2);
    // 0.9 is somewhat arbitrary
    if (max > 0.9 && min < 0.1) {
      if (x0 < 0.2) uvBuffer[i + 0] += 1;
      if (x1 < 0.2) uvBuffer[i + 2] += 1;
      if (x2 < 0.2) uvBuffer[i + 4] += 1;
    }
  }

  const mesh: MeshData = {
    position: new Float32Array(vertexBuffer),
    normal: new Float32Array(vertexBuffer),
    uv: new Float32Array(uvBuffer),
    groups: []
  };
  if (detail === 0) computeVertexNormals(mesh); // flat normals
  else normalizeNormals(mesh);                  // smooth normals
  return mesh;
}
