/* ═══════════════════════════════════════════════════════════════════════════
   vec3 — plain 3-component vectors (number[] / Float32Array / Float64Array).
   Every function takes an optional `out` (default: a fresh array) and returns
   it; `out` may alias any input. Formulas mirror THREE.Vector3 so results are
   bit-identical in double precision (normalize = multiplyScalar(1/(len||1))).
   ═══════════════════════════════════════════════════════════════════════════ */

export type Vec3 = number[] | Float32Array | Float64Array;

export function set(x: number, y: number, z: number, out: Vec3 = [0, 0, 0]): Vec3 {
  out[0] = x; out[1] = y; out[2] = z;
  return out;
}

export function copy(a: Vec3, out: Vec3 = [0, 0, 0]): Vec3 {
  out[0] = a[0]; out[1] = a[1]; out[2] = a[2];
  return out;
}

export function add(a: Vec3, b: Vec3, out: Vec3 = [0, 0, 0]): Vec3 {
  out[0] = a[0] + b[0]; out[1] = a[1] + b[1]; out[2] = a[2] + b[2];
  return out;
}

export function sub(a: Vec3, b: Vec3, out: Vec3 = [0, 0, 0]): Vec3 {
  out[0] = a[0] - b[0]; out[1] = a[1] - b[1]; out[2] = a[2] - b[2];
  return out;
}

export function scale(a: Vec3, s: number, out: Vec3 = [0, 0, 0]): Vec3 {
  out[0] = a[0] * s; out[1] = a[1] * s; out[2] = a[2] * s;
  return out;
}

/** out = a + b * s  (THREE.Vector3.addScaledVector) */
export function addScaled(a: Vec3, b: Vec3, s: number, out: Vec3 = [0, 0, 0]): Vec3 {
  out[0] = a[0] + b[0] * s; out[1] = a[1] + b[1] * s; out[2] = a[2] + b[2] * s;
  return out;
}

export function negate(a: Vec3, out: Vec3 = [0, 0, 0]): Vec3 {
  out[0] = -a[0]; out[1] = -a[1]; out[2] = -a[2];
  return out;
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** out = a × b */
export function cross(a: Vec3, b: Vec3, out: Vec3 = [0, 0, 0]): Vec3 {
  const ax = a[0], ay = a[1], az = a[2];
  const bx = b[0], by = b[1], bz = b[2];
  out[0] = ay * bz - az * by;
  out[1] = az * bx - ax * bz;
  out[2] = ax * by - ay * bx;
  return out;
}

export function lengthSq(a: Vec3): number {
  return a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
}

export function length(a: Vec3): number {
  return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
}

export function distanceSq(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}

export function distance(a: Vec3, b: Vec3): number {
  return Math.sqrt(distanceSq(a, b));
}

/** Zero vectors stay zero (length || 1), exactly like THREE. */
export function normalize(a: Vec3, out: Vec3 = [0, 0, 0]): Vec3 {
  const k = 1 / (Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]) || 1);
  out[0] = a[0] * k; out[1] = a[1] * k; out[2] = a[2] * k;
  return out;
}

/** out = a + (b - a) * t */
export function lerp(a: Vec3, b: Vec3, t: number, out: Vec3 = [0, 0, 0]): Vec3 {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}

export function min(a: Vec3, b: Vec3, out: Vec3 = [0, 0, 0]): Vec3 {
  out[0] = Math.min(a[0], b[0]); out[1] = Math.min(a[1], b[1]); out[2] = Math.min(a[2], b[2]);
  return out;
}

export function max(a: Vec3, b: Vec3, out: Vec3 = [0, 0, 0]): Vec3 {
  out[0] = Math.max(a[0], b[0]); out[1] = Math.max(a[1], b[1]); out[2] = Math.max(a[2], b[2]);
  return out;
}

export function equals(a: Vec3, b: Vec3): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}
