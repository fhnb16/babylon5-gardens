/* ═══════════════════════════════════════════════════════════════════════════
   Test scene + ray sets of the traversal smoke test (browser page and Node /
   Dawn runs). Pure: no DOM, no GPU. Deterministic (seeded mulberry32).

   Scene: a hull-like bumped cylinder (R 50, L 300, inward, one identity
   instance) + randomly rotated / non-uniformly scaled boxes (static batch,
   some mirrored, some camera-only or shadow-only) + low-poly spheres (dynamic
   batch, so the TLAS has a merge node).
   ═══════════════════════════════════════════════════════════════════════════ */

import {
  VIS_ALL, VIS_CAMERA, VIS_INDIRECT, VIS_SHADOW, buildPackedBlas, packScene,
  type InstanceBatch, type PackedBlas, type PackedScene
} from '../bvh/index.ts';
import { RAY_WORDS, T_INFINITE, writeRay } from '../rays.ts';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const HULL_R = 50;
export const HULL_L = 300;

interface Mesh { pos: Float32Array; idx: Uint16Array | Uint32Array }

/** Inward-facing cylinder (axis Z) with hills, nu × nv quads (same shape as the BVH tests' hull). */
export function hullMesh(nu: number, nv: number, R = HULL_R, L = HULL_L): Mesh {
  const pos = new Float32Array((nu + 1) * (nv + 1) * 3);
  let k = 0;
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      const th = (i / nu) * Math.PI * 2, z = (j / nv) * L - L / 2;
      const bump = 3 * Math.max(0, Math.sin(th * 7) * Math.cos(z * 0.07)) + 0.5 * Math.sin(th * 31 + z * 0.3);
      const r = R - bump;
      pos[k++] = r * Math.sin(th); pos[k++] = r * Math.cos(th); pos[k++] = z;
    }
  }
  const nVerts = (nu + 1) * (nv + 1);
  const idx = nVerts < 65536 ? new Uint16Array(nu * nv * 6) : new Uint32Array(nu * nv * 6);
  k = 0;
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
      // wound so that (v1−v0)×(v2−v0) points toward the axis: front faces seen from inside
      idx[k++] = a; idx[k++] = b; idx[k++] = c; idx[k++] = b; idx[k++] = d; idx[k++] = c;
    }
  }
  return { pos, idx };
}

/** Unit cube [-0.5, 0.5]^3, outward CCW. */
export function boxMesh(): Mesh {
  const pos = new Float32Array(24);
  for (let i = 0; i < 8; i++) {
    pos[i * 3] = (i & 1) - 0.5; pos[i * 3 + 1] = ((i >> 1) & 1) - 0.5; pos[i * 3 + 2] = ((i >> 2) & 1) - 0.5;
  }
  const idx = new Uint16Array([
    0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, // -z, +z
    0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7, // -y, +y
    0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5  // -x, +x
  ]);
  return { pos, idx };
}

/** UV sphere, radius 1. */
export function sphereMesh(nu: number, nv: number): Mesh {
  const pos = new Float32Array((nu + 1) * (nv + 1) * 3);
  let k = 0;
  for (let j = 0; j <= nv; j++) {
    const ph = (j / nv) * Math.PI;
    for (let i = 0; i <= nu; i++) {
      const th = (i / nu) * Math.PI * 2;
      pos[k++] = Math.sin(ph) * Math.cos(th); pos[k++] = Math.cos(ph); pos[k++] = Math.sin(ph) * Math.sin(th);
    }
  }
  const idx = new Uint16Array(nu * nv * 6);
  k = 0;
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
      idx[k++] = a; idx[k++] = b; idx[k++] = c; idx[k++] = b; idx[k++] = d; idx[k++] = c;
    }
  }
  return { pos, idx };
}

/** column-major T·R·S, random rotation, scale in [smin, smax], optional mirror */
function randomTRS(rnd: () => number, tx: number, ty: number, tz: number, smin: number, smax: number, mirror: boolean): Float32Array {
  let qx = rnd() * 2 - 1, qy = rnd() * 2 - 1, qz = rnd() * 2 - 1, qw = rnd() * 2 - 1;
  const ql = Math.hypot(qx, qy, qz, qw) || 1; qx /= ql; qy /= ql; qz /= ql; qw /= ql;
  const R = [
    1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy + qz * qw), 2 * (qx * qz - qy * qw),
    2 * (qx * qy - qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz + qx * qw),
    2 * (qx * qz + qy * qw), 2 * (qy * qz - qx * qw), 1 - 2 * (qx * qx + qy * qy)
  ];
  const s = [smin + rnd() * (smax - smin), smin + rnd() * (smax - smin), smin + rnd() * (smax - smin)];
  if (mirror) s[(rnd() * 3) | 0] *= -1;
  const m = new Float32Array(16);
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) m[c * 4 + r] = R[c * 3 + r] * s[c];
  m[12] = tx; m[13] = ty; m[14] = tz; m[15] = 1;
  return m;
}

export interface SmokeSceneOptions {
  seed?: number;
  hullU?: number;
  hullV?: number;
  boxes?: number;
  spheres?: number;
}

export interface SmokeScene {
  packed: PackedScene;
  blas: PackedBlas[];
  triCount: number;
  instanceCount: number;
  buildMs: number;
}

export function buildSmokeScene(opts: SmokeSceneOptions = {}): SmokeScene {
  const t0 = performance.now();
  const rnd = mulberry32(opts.seed ?? 1);
  const hull = hullMesh(opts.hullU ?? 512, opts.hullV ?? 192);
  const box = boxMesh();
  const sph = sphereMesh(16, 10);
  const blas = [hull, box, sph].map((m) => buildPackedBlas(m.pos, m.idx));

  const I = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const nBox = opts.boxes ?? 3000, nSph = opts.spheres ?? 500;
  const boxM = new Float32Array(nBox * 16), boxFlags = new Uint8Array(nBox), boxTint = new Float32Array(nBox * 3);
  for (let i = 0; i < nBox; i++) {
    const th = rnd() * Math.PI * 2, r = 28 + rnd() * 20, z = (rnd() - 0.5) * (HULL_L - 20);
    boxM.set(randomTRS(rnd, r * Math.sin(th), r * Math.cos(th), z, 0.5, 4, rnd() < 0.03), i * 16);
    const f = rnd();
    boxFlags[i] = f < 0.1 ? VIS_CAMERA | VIS_INDIRECT : f < 0.15 ? VIS_SHADOW : VIS_ALL;
    boxTint.set([rnd(), rnd(), rnd()], i * 3);
  }
  const sphM = new Float32Array(nSph * 16);
  for (let i = 0; i < nSph; i++) {
    const th = rnd() * Math.PI * 2, r = 8 + rnd() * 36, z = (rnd() - 0.5) * (HULL_L - 20);
    sphM.set(randomTRS(rnd, r * Math.sin(th), r * Math.cos(th), z, 0.4, 2.5, false), i * 16);
  }
  const batches: InstanceBatch[] = [
    { count: 1, blas: 0, matrices: I },
    { count: nBox, blas: 1, matrices: boxM, flags: boxFlags, tint: boxTint, matBase: 1 },
    { count: nSph, blas: 2, matrices: sphM, matBase: 2, dynamic: true }
  ];
  const packed = packScene(blas, batches);
  return {
    packed, blas,
    triCount: packed.triCount,
    instanceCount: packed.instanceCount,
    buildMs: performance.now() - t0
  };
}

/* ─── ray sets ────────────────────────────────────────────────────────────── */

export interface Camera {
  pos: [number, number, number];
  target: [number, number, number];
  /** "up" hint (toward the station axis at the bottom of the hull) */
  up: [number, number, number];
  fovY: number;
}

export const SMOKE_CAMERA: Camera = { pos: [0, -36, -120], target: [6, -18, 40], up: [0, 1, 0], fovY: 70 };

const norm = (v: number[]) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Pinhole camera grid, row 0 at the top, pixel centres; normalised directions. */
export function cameraRays(w: number, h: number, cam: Camera = SMOKE_CAMERA): Float32Array {
  const F = new Float32Array(w * h * RAY_WORDS);
  const fwd = norm([cam.target[0] - cam.pos[0], cam.target[1] - cam.pos[1], cam.target[2] - cam.pos[2]]);
  const right = norm(cross(fwd, cam.up));
  const up = cross(right, fwd);
  const th = Math.tan((cam.fovY * Math.PI) / 360), aspect = w / h;
  for (let y = 0; y < h; y++) {
    const sy = (1 - ((y + 0.5) / h) * 2) * th;
    for (let x = 0; x < w; x++) {
      const sx = (((x + 0.5) / w) * 2 - 1) * th * aspect;
      const d = norm([fwd[0] + right[0] * sx + up[0] * sy, fwd[1] + right[1] * sx + up[1] * sy, fwd[2] + right[2] * sx + up[2] * sy]);
      writeRay(F, y * w + x, cam.pos[0], cam.pos[1], cam.pos[2], d[0], d[1], d[2], 0, T_INFINITE);
    }
  }
  return F;
}

function randomDir(rnd: () => number): number[] {
  for (;;) {
    const x = rnd() * 2 - 1, y = rnd() * 2 - 1, z = rnd() * 2 - 1, l = Math.hypot(x, y, z);
    if (l > 1e-3 && l <= 1) return [x / l, y / l, z / l];
  }
}

function interiorPoint(rnd: () => number, rMax: number): number[] {
  const th = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * rMax;
  return [r * Math.sin(th), r * Math.cos(th), (rnd() - 0.5) * (HULL_L - 20)];
}

/** Incoherent closest-hit rays (stand-in for diffuse bounces): random interior origins and directions. */
export function diffuseRays(n: number, seed: number): Float32Array {
  const rnd = mulberry32(seed);
  const F = new Float32Array(n * RAY_WORDS);
  for (let i = 0; i < n; i++) {
    const o = interiorPoint(rnd, 45), d = randomDir(rnd);
    writeRay(F, i, o[0], o[1], o[2], d[0], d[1], d[2], 0, T_INFINITE);
  }
  return F;
}

/** Shadow rays: interior points → a point on the axis (half) or near the hull (half), tmax = dist·(1 − 1e-4). */
export function shadowRays(n: number, seed: number): Float32Array {
  const rnd = mulberry32(seed);
  const F = new Float32Array(n * RAY_WORDS);
  for (let i = 0; i < n; i++) {
    const o = interiorPoint(rnd, 47);
    let tgt: number[];
    if (i & 1) tgt = [0, 0, (rnd() - 0.5) * HULL_L];
    else { const p = interiorPoint(rnd, 1); const th = rnd() * Math.PI * 2; tgt = [49 * Math.sin(th), 49 * Math.cos(th), p[2]]; }
    const dx = tgt[0] - o[0], dy = tgt[1] - o[1], dz = tgt[2] - o[2], l = Math.hypot(dx, dy, dz) || 1;
    writeRay(F, i, o[0], o[1], o[2], dx / l, dy / l, dz / l, 0, l * (1 - 1e-4));
  }
  return F;
}
