/* ═══════════════════════════════════════════════════════════════════════════
   mat4 — column-major 4x4 matrices (number[] / Float32Array / Float64Array),
   the same layout as THREE.Matrix4.elements and WGSL mat4x4<f32>:
     element (row r, col c) lives at index c*4 + r; translation = [12,13,14].
   Ports of THREE.Matrix4 / Matrix3.getNormalMatrix; `out` may alias inputs
   (all reads happen before writes). Pass plain number[] when bit-parity with
   three's double-precision maths matters; Float32Array rounds on store.

   Normal matrices are 3x3 column-major (`Mat3`), as THREE.Matrix3.elements.
   ═══════════════════════════════════════════════════════════════════════════ */

import type { Vec3 } from './vec3.ts';
import type { Quat } from './quat.ts';
import { fromRotationMatrix } from './quat.ts';

export type Mat4 = number[] | Float32Array | Float64Array;
export type Mat3 = number[] | Float32Array | Float64Array;

const newMat4 = (): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Row-major argument order like THREE.Matrix4.set, stored column-major. */
export function set(
  n11: number, n12: number, n13: number, n14: number,
  n21: number, n22: number, n23: number, n24: number,
  n31: number, n32: number, n33: number, n34: number,
  n41: number, n42: number, n43: number, n44: number,
  out: Mat4 = newMat4()
): Mat4 {
  out[0] = n11; out[4] = n12; out[8] = n13; out[12] = n14;
  out[1] = n21; out[5] = n22; out[9] = n23; out[13] = n24;
  out[2] = n31; out[6] = n32; out[10] = n33; out[14] = n34;
  out[3] = n41; out[7] = n42; out[11] = n43; out[15] = n44;
  return out;
}

export function identity(out: Mat4 = newMat4()): Mat4 {
  return set(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, out);
}

export function copy(a: Mat4, out: Mat4 = newMat4()): Mat4 {
  for (let i = 0; i < 16; i++) out[i] = a[i];
  return out;
}

/** out = a * b (apply b first, then a). */
export function multiply(a: Mat4, b: Mat4, out: Mat4 = newMat4()): Mat4 {
  const a11 = a[0], a12 = a[4], a13 = a[8], a14 = a[12];
  const a21 = a[1], a22 = a[5], a23 = a[9], a24 = a[13];
  const a31 = a[2], a32 = a[6], a33 = a[10], a34 = a[14];
  const a41 = a[3], a42 = a[7], a43 = a[11], a44 = a[15];

  const b11 = b[0], b12 = b[4], b13 = b[8], b14 = b[12];
  const b21 = b[1], b22 = b[5], b23 = b[9], b24 = b[13];
  const b31 = b[2], b32 = b[6], b33 = b[10], b34 = b[14];
  const b41 = b[3], b42 = b[7], b43 = b[11], b44 = b[15];

  out[0] = a11 * b11 + a12 * b21 + a13 * b31 + a14 * b41;
  out[4] = a11 * b12 + a12 * b22 + a13 * b32 + a14 * b42;
  out[8] = a11 * b13 + a12 * b23 + a13 * b33 + a14 * b43;
  out[12] = a11 * b14 + a12 * b24 + a13 * b34 + a14 * b44;

  out[1] = a21 * b11 + a22 * b21 + a23 * b31 + a24 * b41;
  out[5] = a21 * b12 + a22 * b22 + a23 * b32 + a24 * b42;
  out[9] = a21 * b13 + a22 * b23 + a23 * b33 + a24 * b43;
  out[13] = a21 * b14 + a22 * b24 + a23 * b34 + a24 * b44;

  out[2] = a31 * b11 + a32 * b21 + a33 * b31 + a34 * b41;
  out[6] = a31 * b12 + a32 * b22 + a33 * b32 + a34 * b42;
  out[10] = a31 * b13 + a32 * b23 + a33 * b33 + a34 * b43;
  out[14] = a31 * b14 + a32 * b24 + a33 * b34 + a34 * b44;

  out[3] = a41 * b11 + a42 * b21 + a43 * b31 + a44 * b41;
  out[7] = a41 * b12 + a42 * b22 + a43 * b32 + a44 * b42;
  out[11] = a41 * b13 + a42 * b23 + a43 * b33 + a44 * b43;
  out[15] = a41 * b14 + a42 * b24 + a43 * b34 + a44 * b44;
  return out;
}

export function determinant(m: Mat4): number {
  const n11 = m[0], n12 = m[4], n13 = m[8], n14 = m[12];
  const n21 = m[1], n22 = m[5], n23 = m[9], n24 = m[13];
  const n31 = m[2], n32 = m[6], n33 = m[10], n34 = m[14];
  const n41 = m[3], n42 = m[7], n43 = m[11], n44 = m[15];
  return (
    n41 * (
      + n14 * n23 * n32
      - n13 * n24 * n32
      - n14 * n22 * n33
      + n12 * n24 * n33
      + n13 * n22 * n34
      - n12 * n23 * n34
    ) +
    n42 * (
      + n11 * n23 * n34
      - n11 * n24 * n33
      + n14 * n21 * n33
      - n13 * n21 * n34
      + n13 * n24 * n31
      - n14 * n23 * n31
    ) +
    n43 * (
      + n11 * n24 * n32
      - n11 * n22 * n34
      - n14 * n21 * n32
      + n12 * n21 * n34
      + n14 * n22 * n31
      - n12 * n24 * n31
    ) +
    n44 * (
      - n13 * n22 * n31
      - n11 * n23 * n32
      + n11 * n22 * n33
      + n13 * n21 * n32
      - n12 * n21 * n33
      + n12 * n23 * n31
    )
  );
}

/** General inverse; a singular matrix yields all zeros (as THREE). */
export function invert(m: Mat4, out: Mat4 = newMat4()): Mat4 {
  const n11 = m[0], n21 = m[1], n31 = m[2], n41 = m[3];
  const n12 = m[4], n22 = m[5], n32 = m[6], n42 = m[7];
  const n13 = m[8], n23 = m[9], n33 = m[10], n43 = m[11];
  const n14 = m[12], n24 = m[13], n34 = m[14], n44 = m[15];

  const t11 = n23 * n34 * n42 - n24 * n33 * n42 + n24 * n32 * n43 - n22 * n34 * n43 - n23 * n32 * n44 + n22 * n33 * n44;
  const t12 = n14 * n33 * n42 - n13 * n34 * n42 - n14 * n32 * n43 + n12 * n34 * n43 + n13 * n32 * n44 - n12 * n33 * n44;
  const t13 = n13 * n24 * n42 - n14 * n23 * n42 + n14 * n22 * n43 - n12 * n24 * n43 - n13 * n22 * n44 + n12 * n23 * n44;
  const t14 = n14 * n23 * n32 - n13 * n24 * n32 - n14 * n22 * n33 + n12 * n24 * n33 + n13 * n22 * n34 - n12 * n23 * n34;

  const det = n11 * t11 + n21 * t12 + n31 * t13 + n41 * t14;
  if (det === 0) {
    for (let i = 0; i < 16; i++) out[i] = 0;
    return out;
  }
  const detInv = 1 / det;

  out[0] = t11 * detInv;
  out[1] = (n24 * n33 * n41 - n23 * n34 * n41 - n24 * n31 * n43 + n21 * n34 * n43 + n23 * n31 * n44 - n21 * n33 * n44) * detInv;
  out[2] = (n22 * n34 * n41 - n24 * n32 * n41 + n24 * n31 * n42 - n21 * n34 * n42 - n22 * n31 * n44 + n21 * n32 * n44) * detInv;
  out[3] = (n23 * n32 * n41 - n22 * n33 * n41 - n23 * n31 * n42 + n21 * n33 * n42 + n22 * n31 * n43 - n21 * n32 * n43) * detInv;

  out[4] = t12 * detInv;
  out[5] = (n13 * n34 * n41 - n14 * n33 * n41 + n14 * n31 * n43 - n11 * n34 * n43 - n13 * n31 * n44 + n11 * n33 * n44) * detInv;
  out[6] = (n14 * n32 * n41 - n12 * n34 * n41 - n14 * n31 * n42 + n11 * n34 * n42 + n12 * n31 * n44 - n11 * n32 * n44) * detInv;
  out[7] = (n12 * n33 * n41 - n13 * n32 * n41 + n13 * n31 * n42 - n11 * n33 * n42 - n12 * n31 * n43 + n11 * n32 * n43) * detInv;

  out[8] = t13 * detInv;
  out[9] = (n14 * n23 * n41 - n13 * n24 * n41 - n14 * n21 * n43 + n11 * n24 * n43 + n13 * n21 * n44 - n11 * n23 * n44) * detInv;
  out[10] = (n12 * n24 * n41 - n14 * n22 * n41 + n14 * n21 * n42 - n11 * n24 * n42 - n12 * n21 * n44 + n11 * n22 * n44) * detInv;
  out[11] = (n13 * n22 * n41 - n12 * n23 * n41 - n13 * n21 * n42 + n11 * n23 * n42 + n12 * n21 * n43 - n11 * n22 * n43) * detInv;

  out[12] = t14 * detInv;
  out[13] = (n13 * n24 * n31 - n14 * n23 * n31 + n14 * n21 * n33 - n11 * n24 * n33 - n13 * n21 * n34 + n11 * n23 * n34) * detInv;
  out[14] = (n14 * n22 * n31 - n12 * n24 * n31 - n14 * n21 * n32 + n11 * n24 * n32 + n12 * n21 * n34 - n11 * n22 * n34) * detInv;
  out[15] = (n12 * n23 * n31 - n13 * n22 * n31 + n13 * n21 * n32 - n11 * n23 * n32 - n12 * n21 * n33 + n11 * n22 * n33) * detInv;
  return out;
}

export function transpose(m: Mat4, out: Mat4 = newMat4()): Mat4 {
  const m1 = m[1], m2 = m[2], m3 = m[3], m4 = m[4], m6 = m[6], m7 = m[7];
  const m8 = m[8], m9 = m[9], m11 = m[11], m12 = m[12], m13 = m[13], m14 = m[14];
  out[0] = m[0]; out[5] = m[5]; out[10] = m[10]; out[15] = m[15];
  out[1] = m4; out[4] = m1;
  out[2] = m8; out[8] = m2;
  out[6] = m9; out[9] = m6;
  out[3] = m12; out[12] = m3;
  out[7] = m13; out[13] = m7;
  out[11] = m14; out[14] = m11;
  return out;
}

export function makeTranslation(x: number, y: number, z: number, out: Mat4 = newMat4()): Mat4 {
  return set(1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1, out);
}

export function makeScale(x: number, y: number, z: number, out: Mat4 = newMat4()): Mat4 {
  return set(x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1, out);
}

export function makeRotationX(theta: number, out: Mat4 = newMat4()): Mat4 {
  const c = Math.cos(theta), s = Math.sin(theta);
  return set(1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, out);
}

export function makeRotationY(theta: number, out: Mat4 = newMat4()): Mat4 {
  const c = Math.cos(theta), s = Math.sin(theta);
  return set(c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1, out);
}

export function makeRotationZ(theta: number, out: Mat4 = newMat4()): Mat4 {
  const c = Math.cos(theta), s = Math.sin(theta);
  return set(c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, out);
}

/** `axis` must be normalized. */
export function makeRotationAxis(axis: Vec3, angle: number, out: Mat4 = newMat4()): Mat4 {
  const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  const x = axis[0], y = axis[1], z = axis[2];
  const tx = t * x, ty = t * y;
  return set(
    tx * x + c, tx * y - s * z, tx * z + s * y, 0,
    tx * y + s * z, ty * y + c, ty * z - s * x, 0,
    tx * z - s * y, ty * z + s * x, t * z * z + c, 0,
    0, 0, 0, 1, out
  );
}

/** Columns are the given axes, no translation (THREE.Matrix4.makeBasis). */
export function makeBasis(xAxis: Vec3, yAxis: Vec3, zAxis: Vec3, out: Mat4 = newMat4()): Mat4 {
  return set(
    xAxis[0], yAxis[0], zAxis[0], 0,
    xAxis[1], yAxis[1], zAxis[1], 0,
    xAxis[2], yAxis[2], zAxis[2], 0,
    0, 0, 0, 1, out
  );
}

const ZERO3: Vec3 = [0, 0, 0];
const ONE3: Vec3 = [1, 1, 1];

/** Rotation only (compose with zero position, unit scale). */
export function makeRotationFromQuaternion(q: Quat, out: Mat4 = newMat4()): Mat4 {
  return compose(ZERO3, q, ONE3, out);
}

/** out = T(position) * R(quaternion) * S(scale). */
export function compose(position: Vec3, quaternion: Quat, scl: Vec3, out: Mat4 = newMat4()): Mat4 {
  const x = quaternion[0], y = quaternion[1], z = quaternion[2], w = quaternion[3];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const sx = scl[0], sy = scl[1], sz = scl[2];

  out[0] = (1 - (yy + zz)) * sx;
  out[1] = (xy + wz) * sx;
  out[2] = (xz - wy) * sx;
  out[3] = 0;

  out[4] = (xy - wz) * sy;
  out[5] = (1 - (xx + zz)) * sy;
  out[6] = (yz + wx) * sy;
  out[7] = 0;

  out[8] = (xz + wy) * sz;
  out[9] = (yz - wx) * sz;
  out[10] = (1 - (xx + yy)) * sz;
  out[11] = 0;

  out[12] = position[0];
  out[13] = position[1];
  out[14] = position[2];
  out[15] = 1;
  return out;
}

const _dec: Mat4 = newMat4();

/** Inverse of compose. A negative determinant flips the sign of scale.x (as THREE). */
export function decompose(
  m: Mat4,
  position: Vec3 = [0, 0, 0],
  quaternion: Quat = [0, 0, 0, 1],
  scl: Vec3 = [1, 1, 1]
): { position: Vec3; quaternion: Quat; scale: Vec3 } {
  let sx = Math.sqrt(m[0] * m[0] + m[1] * m[1] + m[2] * m[2]);
  const sy = Math.sqrt(m[4] * m[4] + m[5] * m[5] + m[6] * m[6]);
  const sz = Math.sqrt(m[8] * m[8] + m[9] * m[9] + m[10] * m[10]);
  if (determinant(m) < 0) sx = -sx;

  position[0] = m[12];
  position[1] = m[13];
  position[2] = m[14];

  copy(m, _dec);
  const invSX = 1 / sx, invSY = 1 / sy, invSZ = 1 / sz;
  _dec[0] *= invSX; _dec[1] *= invSX; _dec[2] *= invSX;
  _dec[4] *= invSY; _dec[5] *= invSY; _dec[6] *= invSY;
  _dec[8] *= invSZ; _dec[9] *= invSZ; _dec[10] *= invSZ;
  fromRotationMatrix(_dec, quaternion);

  scl[0] = sx; scl[1] = sy; scl[2] = sz;
  return { position, quaternion, scale: scl };
}

/**
 * Camera-style basis (THREE.Matrix4.lookAt): z = normalize(eye - target), so
 * the local -Z axis looks from `eye` towards `target`. Writes ONLY the 3x3
 * rotation part of `out`; translation / bottom row are left untouched (as
 * THREE). Default `out` is an identity matrix.
 */
export function lookAt(eye: Vec3, target: Vec3, up: Vec3, out: Mat4 = newMat4()): Mat4 {
  let zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
  if (zx * zx + zy * zy + zz * zz === 0) zz = 1;

  let l = 1 / (Math.sqrt(zx * zx + zy * zy + zz * zz) || 1);
  zx *= l; zy *= l; zz *= l;

  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;

  if (xx * xx + xy * xy + xz * xz === 0) {
    // up and z are parallel
    if (Math.abs(up[2]) === 1) zx += 0.0001; else zz += 0.0001;
    l = 1 / (Math.sqrt(zx * zx + zy * zy + zz * zz) || 1);
    zx *= l; zy *= l; zz *= l;
    xx = up[1] * zz - up[2] * zy;
    xy = up[2] * zx - up[0] * zz;
    xz = up[0] * zy - up[1] * zx;
  }

  l = 1 / (Math.sqrt(xx * xx + xy * xy + xz * xz) || 1);
  xx *= l; xy *= l; xz *= l;

  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;

  out[0] = xx; out[4] = yx; out[8] = zx;
  out[1] = xy; out[5] = yy; out[9] = zy;
  out[2] = xz; out[6] = yz; out[10] = zz;
  return out;
}

/** Transform a point (applies translation, divides by w) — THREE.Vector3.applyMatrix4. */
export function transformPoint(m: Mat4, p: Vec3, out: Vec3 = [0, 0, 0]): Vec3 {
  const x = p[0], y = p[1], z = p[2];
  const w = 1 / (m[3] * x + m[7] * y + m[11] * z + m[15]);
  out[0] = (m[0] * x + m[4] * y + m[8] * z + m[12]) * w;
  out[1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) * w;
  out[2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) * w;
  return out;
}

/** Transform a direction with the upper 3x3 and NORMALIZE (THREE.Vector3.transformDirection). */
export function transformDirection(m: Mat4, d: Vec3, out: Vec3 = [0, 0, 0]): Vec3 {
  const x = d[0], y = d[1], z = d[2];
  const rx = m[0] * x + m[4] * y + m[8] * z;
  const ry = m[1] * x + m[5] * y + m[9] * z;
  const rz = m[2] * x + m[6] * y + m[10] * z;
  const k = 1 / (Math.sqrt(rx * rx + ry * ry + rz * rz) || 1);
  out[0] = rx * k; out[1] = ry * k; out[2] = rz * k;
  return out;
}

/** Transform a vector with the upper 3x3, no normalization. */
export function transformVector(m: Mat4, d: Vec3, out: Vec3 = [0, 0, 0]): Vec3 {
  const x = d[0], y = d[1], z = d[2];
  out[0] = m[0] * x + m[4] * y + m[8] * z;
  out[1] = m[1] * x + m[5] * y + m[9] * z;
  out[2] = m[2] * x + m[6] * y + m[10] * z;
  return out;
}

/** Normal matrix = transpose(inverse(upper 3x3)) (THREE.Matrix3.getNormalMatrix). Column-major 3x3. */
export function normalMatrix(m: Mat4, out: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1]): Mat3 {
  // setFromMatrix4
  const n11 = m[0], n21 = m[1], n31 = m[2];
  const n12 = m[4], n22 = m[5], n32 = m[6];
  const n13 = m[8], n23 = m[9], n33 = m[10];

  // invert
  const t11 = n33 * n22 - n32 * n23;
  const t12 = n32 * n13 - n33 * n12;
  const t13 = n23 * n12 - n22 * n13;
  const det = n11 * t11 + n21 * t12 + n31 * t13;
  if (det === 0) {
    for (let i = 0; i < 9; i++) out[i] = 0;
    return out;
  }
  const detInv = 1 / det;
  const i0 = t11 * detInv;
  const i1 = (n31 * n23 - n33 * n21) * detInv;
  const i2 = (n32 * n21 - n31 * n22) * detInv;
  const i3 = t12 * detInv;
  const i4 = (n33 * n11 - n31 * n13) * detInv;
  const i5 = (n31 * n12 - n32 * n11) * detInv;
  const i6 = t13 * detInv;
  const i7 = (n21 * n13 - n23 * n11) * detInv;
  const i8 = (n22 * n11 - n21 * n12) * detInv;

  // transpose
  out[0] = i0; out[1] = i3; out[2] = i6;
  out[3] = i1; out[4] = i4; out[5] = i7;
  out[6] = i2; out[7] = i5; out[8] = i8;
  return out;
}

/** v' = normalize(N * v) (THREE.Vector3.applyNormalMatrix). */
export function applyNormalMatrix(n: Mat3, v: Vec3, out: Vec3 = [0, 0, 0]): Vec3 {
  const x = v[0], y = v[1], z = v[2];
  const rx = n[0] * x + n[3] * y + n[6] * z;
  const ry = n[1] * x + n[4] * y + n[7] * z;
  const rz = n[2] * x + n[5] * y + n[8] * z;
  const k = 1 / (Math.sqrt(rx * rx + ry * ry + rz * rz) || 1);
  out[0] = rx * k; out[1] = ry * k; out[2] = rz * k;
  return out;
}
