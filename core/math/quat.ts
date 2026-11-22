/* ═══════════════════════════════════════════════════════════════════════════
   quat — quaternions as [x, y, z, w] (number[] / Float32Array / Float64Array).
   Ports of THREE.Quaternion; `out` may alias inputs.
   ═══════════════════════════════════════════════════════════════════════════ */

import type { Vec3 } from './vec3.ts';

export type Quat = number[] | Float32Array | Float64Array;
/** Column-major 4x4 (same layout as mat4.ts); declared here to avoid an import cycle. */
type Mat4Like = ArrayLike<number>;

export function identity(out: Quat = [0, 0, 0, 1]): Quat {
  out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 1;
  return out;
}

export function set(x: number, y: number, z: number, w: number, out: Quat = [0, 0, 0, 1]): Quat {
  out[0] = x; out[1] = y; out[2] = z; out[3] = w;
  return out;
}

export function copy(a: Quat, out: Quat = [0, 0, 0, 1]): Quat {
  out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; out[3] = a[3];
  return out;
}

/** `axis` must be normalized. */
export function fromAxisAngle(axis: Vec3, angle: number, out: Quat = [0, 0, 0, 1]): Quat {
  const half = angle / 2, s = Math.sin(half);
  out[0] = axis[0] * s; out[1] = axis[1] * s; out[2] = axis[2] * s; out[3] = Math.cos(half);
  return out;
}

/** Upper 3x3 of the column-major matrix must be a pure rotation (THREE.Quaternion.setFromRotationMatrix). */
export function fromRotationMatrix(m: Mat4Like, out: Quat = [0, 0, 0, 1]): Quat {
  const m11 = m[0], m12 = m[4], m13 = m[8];
  const m21 = m[1], m22 = m[5], m23 = m[9];
  const m31 = m[2], m32 = m[6], m33 = m[10];
  const trace = m11 + m22 + m33;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1.0);
    out[3] = 0.25 / s;
    out[0] = (m32 - m23) * s;
    out[1] = (m13 - m31) * s;
    out[2] = (m21 - m12) * s;
  } else if (m11 > m22 && m11 > m33) {
    const s = 2.0 * Math.sqrt(1.0 + m11 - m22 - m33);
    out[3] = (m32 - m23) / s;
    out[0] = 0.25 * s;
    out[1] = (m12 + m21) / s;
    out[2] = (m13 + m31) / s;
  } else if (m22 > m33) {
    const s = 2.0 * Math.sqrt(1.0 + m22 - m11 - m33);
    out[3] = (m13 - m31) / s;
    out[0] = (m12 + m21) / s;
    out[1] = 0.25 * s;
    out[2] = (m23 + m32) / s;
  } else {
    const s = 2.0 * Math.sqrt(1.0 + m33 - m11 - m22);
    out[3] = (m21 - m12) / s;
    out[0] = (m13 + m31) / s;
    out[1] = (m23 + m32) / s;
    out[2] = 0.25 * s;
  }
  return out;
}

/** Shortest rotation taking unit vector `from` to unit vector `to`. */
export function fromUnitVectors(from: Vec3, to: Vec3, out: Quat = [0, 0, 0, 1]): Quat {
  let r = from[0] * to[0] + from[1] * to[1] + from[2] * to[2] + 1;
  if (r < Number.EPSILON) {
    r = 0;
    if (Math.abs(from[0]) > Math.abs(from[2])) {
      out[0] = -from[1]; out[1] = from[0]; out[2] = 0; out[3] = r;
    } else {
      out[0] = 0; out[1] = -from[2]; out[2] = from[1]; out[3] = r;
    }
  } else {
    out[0] = from[1] * to[2] - from[2] * to[1];
    out[1] = from[2] * to[0] - from[0] * to[2];
    out[2] = from[0] * to[1] - from[1] * to[0];
    out[3] = r;
  }
  return normalize(out, out);
}

export function length(a: Quat): number {
  return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2] + a[3] * a[3]);
}

/** Zero length gives identity (as THREE). */
export function normalize(a: Quat, out: Quat = [0, 0, 0, 1]): Quat {
  let l = length(a);
  if (l === 0) {
    out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 1;
  } else {
    l = 1 / l;
    out[0] = a[0] * l; out[1] = a[1] * l; out[2] = a[2] * l; out[3] = a[3] * l;
  }
  return out;
}

/** Conjugate (= inverse for unit quaternions). */
export function conjugate(a: Quat, out: Quat = [0, 0, 0, 1]): Quat {
  out[0] = -a[0]; out[1] = -a[1]; out[2] = -a[2]; out[3] = a[3];
  return out;
}

export function dot(a: Quat, b: Quat): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
}

/** out = a * b (THREE.Quaternion.multiplyQuaternions). */
export function multiply(a: Quat, b: Quat, out: Quat = [0, 0, 0, 1]): Quat {
  const qax = a[0], qay = a[1], qaz = a[2], qaw = a[3];
  const qbx = b[0], qby = b[1], qbz = b[2], qbw = b[3];
  out[0] = qax * qbw + qaw * qbx + qay * qbz - qaz * qby;
  out[1] = qay * qbw + qaw * qby + qaz * qbx - qax * qbz;
  out[2] = qaz * qbw + qaw * qbz + qax * qby - qay * qbx;
  out[3] = qaw * qbw - qax * qbx - qay * qby - qaz * qbz;
  return out;
}

/**
 * Shortest-arc slerp, ported from THREE r187 Quaternion.slerp (the installed
 * oracle; r165 used a numerically different but equivalent formulation).
 * Falls back to normalized lerp when the angle is tiny (dot >= 0.9995).
 */
export function slerp(a: Quat, b: Quat, t: number, out: Quat = [0, 0, 0, 1]): Quat {
  let x = b[0], y = b[1], z = b[2], w = b[3];
  let d = a[0] * x + a[1] * y + a[2] * z + a[3] * w;
  if (d < 0) {
    x = -x; y = -y; z = -z; w = -w;
    d = -d;
  }
  let s = 1 - t;
  if (d < 0.9995) {
    const theta = Math.acos(d);
    const sin = Math.sin(theta);
    s = Math.sin(s * theta) / sin;
    t = Math.sin(t * theta) / sin;
    out[0] = a[0] * s + x * t;
    out[1] = a[1] * s + y * t;
    out[2] = a[2] * s + z * t;
    out[3] = a[3] * s + w * t;
    return out;
  }
  out[0] = a[0] * s + x * t;
  out[1] = a[1] * s + y * t;
  out[2] = a[2] * s + z * t;
  out[3] = a[3] * s + w * t;
  return normalize(out, out);
}
/** Rotate vector v by unit quaternion q (THREE.Vector3.applyQuaternion). */
export function rotateVec3(q: Quat, v: Vec3, out: Vec3 = [0, 0, 0]): Vec3 {
  const vx = v[0], vy = v[1], vz = v[2];
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  out[0] = vx + qw * tx + qy * tz - qz * ty;
  out[1] = vy + qw * ty + qz * tx - qx * tz;
  out[2] = vz + qw * tz + qx * ty - qy * tx;
  return out;
}
