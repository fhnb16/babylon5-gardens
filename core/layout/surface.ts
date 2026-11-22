/* ═══════════════════════════════════════════════════════════════════════════
   Station surface basis — port of js/util.js surfaceQuat / surfacePos.
   Local +Y points to the axis ("up"), +Z runs along the station.
   θ = atan2(x, y): x = r·sin θ, y = r·cos θ.
   ═══════════════════════════════════════════════════════════════════════════ */

import { fromRotationMatrix } from '../math/quat.ts';
import type { Quat } from '../math/quat.ts';
import type { Vec3 } from '../math/vec3.ts';

const _m = new Float64Array(16);

/** Orientation of an object standing on the hull at angle t (THREE: makeBasis(up × Z, up, Z)). */
export function surfaceQuat(t: number, out: Quat = [0, 0, 0, 1]): Quat {
  const ux = -Math.sin(t), uy = -Math.cos(t), uz = 0;
  // x = up × (0, 0, 1)  (Vector3.crossVectors)
  const xx = uy * 1 - uz * 0, xy = uz * 0 - ux * 1, xz = ux * 0 - uy * 0;
  _m[0] = xx; _m[4] = ux; _m[8] = 0;
  _m[1] = xy; _m[5] = uy; _m[9] = 0;
  _m[2] = xz; _m[6] = uz; _m[10] = 1;
  _m[3] = 0; _m[7] = 0; _m[11] = 0;
  _m[12] = 0; _m[13] = 0; _m[14] = 0; _m[15] = 1;
  return fromRotationMatrix(_m, out);
}

/** Point at angle t, radius r, axial z. */
export function surfacePos(t: number, r: number, z: number, out: Vec3 = [0, 0, 0]): Vec3 {
  out[0] = Math.sin(t) * r; out[1] = Math.cos(t) * r; out[2] = z;
  return out;
}

/** [θ°, r, z] → station-local vector (legacy tpVec). */
export function tpVec(v: readonly [number, number, number], out: Vec3 = [0, 0, 0]): Vec3 {
  return surfacePos(v[0] * (Math.PI / 180), v[1], v[2], out);
}
