/* Station surface frame — port of js/util.js surfacePos / surfaceQuat.

   θ = atan2(x, y): x = r·sin θ, y = r·cos θ (scene/types.ts convention).
   The local basis at θ: +Y points at the axis ("station up"), +Z runs along
   the axis, +X = up × Z. Same maths as THREE (makeBasis → setFromRotationMatrix
   → compose), so instance matrices match the legacy ones bit for bit. */

import type { Mat4 } from '../../math/mat4.ts';
import * as m4 from '../../math/mat4.ts';
import * as q4 from '../../math/quat.ts';
import type { Quat } from '../../math/quat.ts';
import type { Vec3 } from '../../math/vec3.ts';
import * as v3 from '../../math/vec3.ts';

const Z_AXIS: Vec3 = [0, 0, 1];
const ONE: Vec3 = [1, 1, 1];

/** Point on the cylinder of radius r at angle t (rad) and axial position z. */
export function surfacePos(t: number, r: number, z: number, out: Vec3 = [0, 0, 0]): Vec3 {
  return v3.set(Math.sin(t) * r, Math.cos(t) * r, z, out);
}

/** Orientation whose local +Y points at the axis from angle t (legacy surfaceQuat). */
export function surfaceQuat(t: number, out: Quat = [0, 0, 0, 1]): Quat {
  const up: Vec3 = [-Math.sin(t), -Math.cos(t), 0];
  const xAx = v3.cross(up, Z_AXIS);
  return q4.fromRotationMatrix(m4.makeBasis(xAx, up, Z_AXIS), out);
}

/** compose(surfacePos(t, r, z), surfaceQuat(t), scale) — the legacy instance matrix. */
export function surfaceMatrix(t: number, r: number, z: number, scale: Vec3 = ONE, out?: Mat4): Mat4 {
  return m4.compose(surfacePos(t, r, z), surfaceQuat(t), scale, out);
}
