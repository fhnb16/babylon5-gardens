/* End caps — port of buildEndCaps() in js/structures.js: a stepped funnel
   (lathe) with radial UVs and a hub with six spokes. Both are drawn once and
   instanced twice (see endcapInstanceMatrices). */

import { CORE_CONFIG } from '../../config/index.ts';
import * as m4 from '../../math/mat4.ts';
import type { MeshData, ThreeCompat } from '../mesh.ts';
import { computeVertexNormals, mergeMeshes, rotateX, rotateZ, translate } from '../mesh.ts';
import { panelUV } from '../ops.ts';
import { box } from '../primitives/box.ts';
import { cylinder } from '../primitives/cylinder.ts';
import { lathe, type LathePoint } from '../primitives/lathe.ts';

const TAU = Math.PI * 2;
const LATHE_SEGMENTS = 72;
const MIN_PROFILE_R = 0.6;
const HUB = { r: 4.6, len: 18, seg: 18 };
const SPOKE = { count: 6, phase: 0.26, w: 1.7, h: 1.2 };

/** Funnel disc facing −Z (depth grows along −Z after the rotation). */
export function endcapDisc(compat: ThreeCompat = 187): MeshData {
  const R = CORE_CONFIG.R, E = CORE_CONFIG.ENDCAP;
  const prof: LathePoint[] = [];
  for (let k = 0; k <= E.rings; k++) {
    const u = k / E.rings;
    const r = R * (1 - u);
    const depth = E.depth * Math.pow(u, E.curve);
    prof.push([Math.max(MIN_PROFILE_R, r), depth]);
    if (k < E.rings) prof.push([Math.max(MIN_PROFILE_R, r - R / E.rings * E.step), depth]);
  }
  const cap = lathe(prof, LATHE_SEGMENTS, 0, TAU, compat);
  rotateX(cap, -Math.PI / 2);
  /* radial UVs: the texture is drawn as rings from the rim to the hub */
  const p = cap.position, uv = cap.uv;
  for (let k = 0; k < p.length / 3; k++) {
    const x = p[3 * k], y = p[3 * k + 1];
    const rr = Math.hypot(x, y) / R;
    const ang = Math.atan2(y, x);
    uv[2 * k] = 0.5 + Math.cos(ang) * rr * 0.5;
    uv[2 * k + 1] = 0.5 + Math.sin(ang) * rr * 0.5;
  }
  return computeVertexNormals(cap);
}

/** Hub cylinder along Z plus six spokes reaching into the hull wall. */
export function endcapHub(compat: ThreeCompat = 187): MeshData {
  const parts: MeshData[] = [];
  const hub = cylinder(HUB.r, HUB.r, HUB.len, HUB.seg, 1, false, 0, TAU, compat);
  rotateX(hub, Math.PI / 2);
  parts.push(hub);
  const spokeLen = CORE_CONFIG.R + CORE_CONFIG.ENDCAP.spokeBite - HUB.r;
  for (let k = 0; k < SPOKE.count; k++) {
    const a = (k / SPOKE.count) * TAU + SPOKE.phase;
    const spoke = box(SPOKE.w, SPOKE.h, spokeLen);
    rotateX(spoke, Math.PI / 2);
    translate(spoke, 0, HUB.r + spokeLen / 2, 0);
    rotateZ(spoke, -a);
    parts.push(spoke);
  }
  return panelUV(mergeMeshes(parts), CORE_CONFIG.PANEL_TILE);
}

/**
 * The two instance matrices (−z end first, as legacy): the disc is mirrored
 * in Z at the −z end and sits at ±HL; the hub is not mirrored and sits at
 * ±(HL − depth). Returns 32 floats.
 */
export function endcapInstanceMatrices(flipZ: boolean): Float32Array {
  const HL = CORE_CONFIG.L / 2, E = CORE_CONFIG.ENDCAP;
  const out = new Float32Array(32);
  [-1, 1].forEach((sign, k) => {
    const m = flipZ ? m4.makeScale(1, 1, sign) : m4.identity();
    m[12] = 0; m[13] = 0; m[14] = sign * (flipZ ? HL : HL - E.depth);
    for (let i = 0; i < 16; i++) out[16 * k + i] = m[i];
  });
  return out;
}
