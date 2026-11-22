/* BVH builder / packer / reference traversal (PT P1-U1).
   Oracles: brute force over all triangles (same watertight test, flattened
   world-space geometry for the two-level scene) and three-mesh-bvh
   raycastFirst. three is used here ONLY as a test oracle. */
import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import {
  BLAS_MAX_DEPTH, EMPTY_LEAF, INST_BYTES, INST_OFFSETS, INST_W, NODE_BYTES, NODE_OFFSETS, NODE_W,
  NODE_WORDS, STRUCTS, TLAS_MAX_DEPTH, TRI_BYTES, TRI_OFFSETS, TRI_W, VIS_ALL, VIS_CAMERA, VIS_SHADOW,
  RAY_PRE_SIZE, buildBlas, buildPackedBlas, bvhSahCost, createBvhPool, createTraverser,
  decodeRgb9e5, emitWgslLayout, encodeRgb9e5, handleBuildRequest, instanceWorldBounds, intersectTriangleRaw,
  isLeaf, leafCount, leafOffset, makeLeaf, packScene, prepareRay, triangleBounds, updateDynamic, validateBvh,
  buildTlas, type Hit, type InstanceBatch, type PackedBlas, type Ray, type WorkerLike
} from '../bvh/index.ts';

/* ─── helpers ─────────────────────────────────────────────────────────────── */

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Mesh { pos: Float32Array; idx?: Uint16Array | Uint32Array; triCount: number }

/** Inward-facing cylinder (axis Z) with hills, nu × nv quads. */
function cylinderMesh(nu: number, nv: number, R = 50, L = 300): Mesh {
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
      idx[k++] = a; idx[k++] = c; idx[k++] = b; idx[k++] = b; idx[k++] = c; idx[k++] = d;
    }
  }
  return { pos, idx, triCount: nu * nv * 2 };
}

/** Random triangle soup in [0,1]^3, non-indexed. */
function soupMesh(n: number, seed: number, size = 0.15): Mesh {
  const rnd = mulberry32(seed);
  const pos = new Float32Array(n * 9);
  for (let t = 0; t < n; t++) {
    const cx = rnd(), cy = rnd(), cz = rnd();
    for (let v = 0; v < 3; v++) {
      pos[t * 9 + v * 3] = cx + (rnd() - 0.5) * size;
      pos[t * 9 + v * 3 + 1] = cy + (rnd() - 0.5) * size;
      pos[t * 9 + v * 3 + 2] = cz + (rnd() - 0.5) * size;
    }
  }
  return { pos, triCount: n };
}

/** Heightfield grid with Uint16 index. */
function gridMesh(n: number, seed: number): Mesh {
  const rnd = mulberry32(seed);
  const pos = new Float32Array((n + 1) * (n + 1) * 3);
  let k = 0;
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
    pos[k++] = i / n - 0.5; pos[k++] = (rnd() - 0.5) * 0.1; pos[k++] = j / n - 0.5;
  }
  const idx = new Uint16Array(n * n * 6);
  k = 0;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
    idx[k++] = a; idx[k++] = c; idx[k++] = b; idx[k++] = b; idx[k++] = c; idx[k++] = d;
  }
  return { pos, idx, triCount: n * n * 2 };
}

function triVerts(m: Mesh, t: number, out: Float64Array, o = 0) {
  for (let v = 0; v < 3; v++) {
    const vi = m.idx ? m.idx[t * 3 + v] : t * 3 + v;
    out[o + v * 3] = m.pos[vi * 3]; out[o + v * 3 + 1] = m.pos[vi * 3 + 1]; out[o + v * 3 + 2] = m.pos[vi * 3 + 2];
  }
}

/** Flattened world-space triangle list with chunk boxes for a fast exact brute force. */
interface Flat {
  v: Float64Array; inst: Int32Array; prim: Uint32Array; n: number;
  chunks: { s: number; e: number; box: Float64Array }[];
}

function makeFlat(parts: { mesh: Mesh; m?: Float32Array; inst: number }[], chunk = 64): Flat {
  let n = 0;
  for (const p of parts) n += p.mesh.triCount;
  const v = new Float64Array(n * 9), inst = new Int32Array(n), prim = new Uint32Array(n);
  const chunks: Flat['chunks'] = [];
  const tv = new Float64Array(9);
  let o = 0;
  for (const p of parts) {
    for (let t = 0; t < p.mesh.triCount; t++, o++) {
      triVerts(p.mesh, t, tv);
      for (let k = 0; k < 3; k++) {
        const x = tv[k * 3], y = tv[k * 3 + 1], z = tv[k * 3 + 2];
        if (p.m) {
          const m = p.m;
          v[o * 9 + k * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
          v[o * 9 + k * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
          v[o * 9 + k * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
        } else { v[o * 9 + k * 3] = x; v[o * 9 + k * 3 + 1] = y; v[o * 9 + k * 3 + 2] = z; }
      }
      inst[o] = p.inst; prim[o] = t;
    }
  }
  for (let s = 0; s < n; s += chunk) {
    const e = Math.min(n, s + chunk), box = new Float64Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
    for (let i = s * 9; i < e * 9; i += 3) for (let a = 0; a < 3; a++) {
      box[a] = Math.min(box[a], v[i + a]); box[3 + a] = Math.max(box[3 + a], v[i + a]);
    }
    const pad = 1e-6 * (Math.max(Math.abs(box[0]), Math.abs(box[3]), Math.abs(box[1]), Math.abs(box[4]), Math.abs(box[2]), Math.abs(box[5])) + 1);
    for (let a = 0; a < 3; a++) { box[a] -= pad; box[3 + a] += pad; }
    chunks.push({ s, e, box });
  }
  return { v, inst, prim, n, chunks };
}

const pre = new Float64Array(RAY_PRE_SIZE);
const hOut = new Float64Array(3);

function bruteForce(f: Flat, r: Ray): Hit | null {
  prepareRay(pre, r.ox, r.oy, r.oz, r.dx, r.dy, r.dz);
  let best: Hit | null = null, tmax = r.tmax;
  for (const c of f.chunks) {
    // conservative slab against the padded chunk box
    let tn = r.tmin, tf = tmax;
    const o = [r.ox, r.oy, r.oz], d = [r.dx, r.dy, r.dz];
    let miss = false;
    for (let a = 0; a < 3 && !miss; a++) {
      if (Math.abs(d[a]) < 1e-30) { if (o[a] < c.box[a] || o[a] > c.box[3 + a]) miss = true; continue; }
      let t0 = (c.box[a] - o[a]) / d[a], t1 = (c.box[3 + a] - o[a]) / d[a];
      if (t0 > t1) { const t = t0; t0 = t1; t1 = t; }
      tn = Math.max(tn, t0); tf = Math.min(tf, t1 * (1 + 1e-9));
      if (tn > tf) miss = true;
    }
    if (miss) continue;
    for (let i = c.s; i < c.e; i++) {
      const w = i * 9, v = f.v;
      if (intersectTriangleRaw(pre, v[w], v[w + 1], v[w + 2], v[w + 3], v[w + 4], v[w + 5], v[w + 6], v[w + 7], v[w + 8], r.tmin, tmax, hOut)) {
        tmax = hOut[0];
        best = { t: hOut[0], instance: f.inst[i], prim: f.prim[i], tri: i, u: hOut[1], v: hOut[2] };
      }
    }
  }
  return best;
}

type Verdict = 'ok' | 'tie' | 'edge' | 'fail';
const nearEdge = (h: Hit, eps = 1e-4) => Math.min(h.u, h.v, 1 - h.u - h.v) < eps;

/** |Δt| ≤ tol · max(t, floor); floor = scene length scale when f32 instance transforms are involved */
function compareHits(a: Hit | null, b: Hit | null, tol = 1e-5, floor = 1e-2): Verdict {
  if (!a && !b) return 'ok';
  if (a && b) {
    const close = Math.abs(a.t - b.t) <= tol * Math.max(Math.abs(b.t), floor);
    if (a.prim === b.prim && a.instance === b.instance) return close ? 'ok' : 'fail';
    if (close) return 'tie';
    return nearEdge(a) || nearEdge(b) ? 'edge' : 'fail';
  }
  return nearEdge((a ?? b)!) ? 'edge' : 'fail';
}

function tally(vs: Verdict[]) {
  const c = { ok: 0, tie: 0, edge: 0, fail: 0 };
  for (const v of vs) c[v]++;
  return c;
}

function randomDir(rnd: () => number): [number, number, number] {
  for (;;) {
    const x = rnd() * 2 - 1, y = rnd() * 2 - 1, z = rnd() * 2 - 1, l = Math.hypot(x, y, z);
    if (l > 1e-3 && l <= 1) return [x / l, y / l, z / l];
  }
}

function rayTo(ox: number, oy: number, oz: number, tx: number, ty: number, tz: number): Ray {
  const dx = tx - ox, dy = ty - oy, dz = tz - oz, l = Math.hypot(dx, dy, dz);
  return { ox, oy, oz, dx: dx / l, dy: dy / l, dz: dz / l, tmin: 0, tmax: 1e30 };
}

/** column-major T·R·S with a random rotation and (possibly mirrored) non-uniform scale */
function randomMatrix(rnd: () => number, spread: number): Float32Array {
  let qx = rnd() * 2 - 1, qy = rnd() * 2 - 1, qz = rnd() * 2 - 1, qw = rnd() * 2 - 1;
  const ql = Math.hypot(qx, qy, qz, qw); qx /= ql; qy /= ql; qz /= ql; qw /= ql;
  const R = [
    1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy + qz * qw), 2 * (qx * qz - qy * qw),
    2 * (qx * qy - qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz + qx * qw),
    2 * (qx * qz + qy * qw), 2 * (qy * qz - qx * qw), 1 - 2 * (qx * qx + qy * qy)
  ];
  const s = [0.3 + rnd() * 3, 0.3 + rnd() * 3, 0.3 + rnd() * 3];
  if (rnd() < 0.2) s[(rnd() * 3) | 0] *= -1;
  const m = new Float32Array(16);
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) m[c * 4 + r] = R[c * 3 + r] * s[c];
  m[12] = (rnd() - 0.5) * spread; m[13] = (rnd() - 0.5) * spread; m[14] = (rnd() - 0.5) * spread; m[15] = 1;
  return m;
}

function singleScene(mesh: Mesh) {
  const pb = buildPackedBlas(mesh.pos, mesh.idx);
  const scene = packScene([pb], [{ count: 1, blas: 0, matrices: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) }]);
  return { pb, scene, tr: createTraverser(scene) };
}

/* ─── layout ──────────────────────────────────────────────────────────────── */

describe('layout', () => {
  test('emitted WGSL structs match the JS offset tables (WGSL alignment rules)', () => {
    const wgsl = emitWgslLayout();
    const sizes: Record<string, [number, number]> = { vec3f: [12, 16], vec4f: [16, 16], u32: [4, 4], f32: [4, 4] };
    const parsed: Record<string, { size: number; fields: Record<string, number> }> = {};
    for (const m of wgsl.matchAll(/struct\s+(\w+)\s*\{([^}]*)\}/g)) {
      let off = 0, maxAlign = 1;
      const fields: Record<string, number> = {};
      for (const f of m[2].matchAll(/(\w+)\s*:\s*(\w+)\s*,/g)) {
        const [size, align] = sizes[f[2]];
        expect(size, `unknown type ${f[2]}`).toBeDefined();
        off = Math.ceil(off / align) * align;
        fields[f[1]] = off;
        off += size;
        maxAlign = Math.max(maxAlign, align);
      }
      parsed[m[1]] = { size: Math.ceil(off / maxAlign) * maxAlign, fields };
    }
    const tables: [string, number, Record<string, number>, Record<string, number>][] = [
      ['B5BvhNode', NODE_BYTES, NODE_OFFSETS, NODE_W],
      ['B5Tri', TRI_BYTES, TRI_OFFSETS, TRI_W],
      ['B5Instance', INST_BYTES, INST_OFFSETS, INST_W]
    ];
    for (const [name, bytes, offs, words] of tables) {
      expect(parsed[name], name).toBeDefined();
      expect(parsed[name].size).toBe(bytes);
      expect(parsed[name].fields).toEqual(offs);
      for (const k of Object.keys(offs)) expect(words[k] * 4).toBe(offs[k]);
    }
    expect(STRUCTS.map((s) => s.name).sort()).toEqual(Object.keys(parsed).sort());
    // hygiene: no '$', B5/b5_ prefixes
    expect(wgsl.includes('$')).toBe(false);
    for (const m of wgsl.matchAll(/\b(?:const|fn|struct)\s+(\w+)/g)) expect(m[1]).toMatch(/^(B5|b5_)/);
  });

  test('leaf encoding', () => {
    const r = makeLeaf(15, (1 << 27) - 1);
    expect(isLeaf(r)).toBe(true);
    expect(leafCount(r)).toBe(15);
    expect(leafOffset(r)).toBe((1 << 27) - 1);
    expect(isLeaf(12345)).toBe(false);
    expect(leafCount(EMPTY_LEAF)).toBe(0);
    expect(() => makeLeaf(16, 0)).toThrow();
    expect(() => makeLeaf(1, 1 << 27)).toThrow();
  });

  test('rgb9e5 round trip', () => {
    const rnd = mulberry32(7);
    const out = [0, 0, 0];
    expect(decodeRgb9e5(encodeRgb9e5(1, 1, 1), out)).toEqual([1, 1, 1]);
    expect(decodeRgb9e5(encodeRgb9e5(0, 0, 0), out)).toEqual([0, 0, 0]);
    expect(decodeRgb9e5(encodeRgb9e5(-1, NaN, 0.5), out)).toEqual([0, 0, 0.5]);
    for (let i = 0; i < 2000; i++) {
      const c = [rnd() ** 3 * 4, rnd() ** 3 * 4, rnd() ** 3];
      decodeRgb9e5(encodeRgb9e5(c[0], c[1], c[2]), out);
      const mx = Math.max(...c);
      for (let k = 0; k < 3; k++) expect(Math.abs(out[k] - c[k])).toBeLessThanOrEqual(mx * 2 ** -9 + 1e-12);
    }
  });
});

/* ─── builder invariants ──────────────────────────────────────────────────── */

describe('builder', () => {
  const cyl = cylinderMesh(256, 96);
  const soup = soupMesh(5000, 1);

  test('invariants: random soup, cylinder hull, indexed grid', { timeout: 60000 }, () => {
    for (const m of [soup, cyl, gridMesh(60, 3)]) {
      const boxes = triangleBounds(m.pos, m.idx);
      const b = buildBlas(m.pos, m.idx);
      expect(validateBvh(b, boxes)).toBeNull();
      expect(b.maxDepth).toBeLessThanOrEqual(BLAS_MAX_DEPTH);
      expect(b.nodeCount).toBeLessThanOrEqual(Math.max(1, m.triCount - 1));
      // leaves mostly 2–4 tris
      expect(m.triCount / b.leafCount).toBeGreaterThanOrEqual(1.5);
      expect(m.triCount / b.leafCount).toBeLessThanOrEqual(4);
    }
  });

  test('SAH cost beats the median-split baseline (random and real meshes)', () => {
    const knot = new THREE.TorusKnotGeometry(10, 3, 200, 32);
    const real: Mesh = { pos: knot.attributes.position.array as Float32Array, idx: knot.index!.array as Uint16Array | Uint32Array, triCount: knot.index!.count / 3 };
    const rows: string[] = [];
    for (const [name, m] of [['soup', soup], ['cylinder', cyl], ['torusKnot', real]] as [string, Mesh][]) {
      const sah = bvhSahCost(buildBlas(m.pos, m.idx));
      const med = bvhSahCost(buildBlas(m.pos, m.idx, { strategy: 'median' }));
      rows.push(`${name}: SAH ${sah.toFixed(2)} vs median ${med.toFixed(2)}`);
      expect(sah).toBeLessThan(med);
    }
    console.log('[bvh] SAH cost —', rows.join('; '));
  }, 60000);

  test('degenerate inputs', { timeout: 60000 }, () => {
    // empty
    const e = buildBlas(new Float32Array(0));
    expect(e.nodeCount).toBe(1);
    expect(validateBvh(e, new Float32Array(0))).toBeNull();
    const eu = new Uint32Array(e.nodes);
    expect(eu[NODE_W.child0]).toBe(EMPTY_LEAF);
    expect(eu[NODE_W.child1]).toBe(EMPTY_LEAF);
    // single triangle
    const one = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const b1 = buildBlas(one);
    expect(validateBvh(b1, triangleBounds(one))).toBeNull();
    const t1 = createTraverser({ nodes: b1.nodes, tris: buildPackedBlas(one).tris });
    expect(t1.closestHitBlas(0, { ox: 0.2, oy: 0.2, oz: 1, dx: 0, dy: 0, dz: -1, tmin: 0, tmax: 1e30 })?.t).toBeCloseTo(1, 12);
    expect(t1.closestHitBlas(0, { ox: 0.2, oy: 0.2, oz: 1, dx: 0, dy: 0, dz: 1, tmin: 0, tmax: 1e30 })).toBeNull();

    // 3000 identical triangles: identical centroids ⇒ median fallback, depth bounded
    const same = new Float32Array(3000 * 9);
    for (let t = 0; t < 3000; t++) same.set([0, 0, 0, 1, 0, 0, 0, 1, 0], t * 9);
    const bs = buildBlas(same);
    expect(validateBvh(bs, triangleBounds(same))).toBeNull();
    expect(bs.medianSplits).toBeGreaterThan(0);
    expect(bs.maxDepth).toBeLessThanOrEqual(BLAS_MAX_DEPTH);
    const ps = buildPackedBlas(same);
    const ts = createTraverser({ nodes: ps.nodes, tris: ps.tris });
    expect(ts.closestHitBlas(0, { ox: 0.2, oy: 0.2, oz: 1, dx: 0, dy: 0, dz: -1, tmin: 0, tmax: 1e30 })?.t).toBeCloseTo(1, 12);

    // zero-area (collinear, point) + non-finite triangles mixed with normal ones
    const m = soupMesh(500, 9);
    const mix = new Float32Array(m.pos.length + 4 * 9);
    mix.set(m.pos);
    mix.set([0.5, 0.5, 0.5, 0.6, 0.6, 0.6, 0.7, 0.7, 0.7], m.pos.length);            // collinear
    mix.set([0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3], m.pos.length + 9);        // point
    mix.set([NaN, 0, 0, 1, 1, 1, 0, 1, 0], m.pos.length + 18);                       // NaN
    mix.set([Infinity, 0, 0, 1, 1, 1, 0, 1, 0], m.pos.length + 27);                  // Inf
    const bm = buildBlas(mix);
    expect(validateBvh(bm, triangleBounds(mix))).toBeNull();
    const pm = buildPackedBlas(mix);
    const tm = createTraverser({ nodes: pm.nodes, tris: pm.tris });
    const rnd = mulberry32(5);
    for (let i = 0; i < 500; i++) {
      const h = tm.closestHitBlas(0, rayTo(rnd() * 2 - 0.5, rnd() * 2 - 0.5, -1, rnd(), rnd(), rnd()));
      if (h) expect(h.prim).toBeLessThan(500);
    }
  });

  test('depth limit with median fallback (tight limit, exponential distribution)', { timeout: 60000 }, () => {
    const m = soupMesh(4000, 11);
    const b = buildBlas(m.pos, undefined, { maxDepth: 12 });
    expect(validateBvh(b, triangleBounds(m.pos), 12)).toBeNull();
    expect(b.maxDepth).toBeLessThanOrEqual(12);
    expect(b.medianSplits).toBeGreaterThan(0);
    expect(() => buildBlas(m.pos, undefined, { maxDepth: 8 })).toThrow(); // 4000/4 > 2^8 leaves impossible

    // SAH likes to peel one tiny triangle at a time off a geometric sequence
    const n = 3000, geo = new Float32Array(n * 9);
    for (let t = 0; t < n; t++) {
      const x = 1.02 ** t, s = x * 0.01;
      geo.set([x, 0, 0, x + s, 0, 0, x, s, 0], t * 9);
    }
    const bg = buildBlas(geo);
    expect(validateBvh(bg, triangleBounds(geo))).toBeNull();
    expect(bg.maxDepth).toBeLessThanOrEqual(BLAS_MAX_DEPTH);
    const bg2 = buildBlas(geo, undefined, { maxDepth: 14, maxLeaf: 2 });
    expect(validateBvh(bg2, triangleBounds(geo), 14)).toBeNull();
  });

  test('maxLeaf up to 15 encodes correctly', () => {
    const b = buildBlas(soup.pos, undefined, { maxLeaf: 15, intersectCost: 0.2 });
    expect(validateBvh(b, triangleBounds(soup.pos))).toBeNull();
    let maxC = 0;
    const u = new Uint32Array(b.nodes);
    for (let i = 0; i < b.nodeCount; i++) for (const w of [NODE_W.child0, NODE_W.child1]) {
      const r = u[i * NODE_WORDS + w];
      if (isLeaf(r)) maxC = Math.max(maxC, leafCount(r));
    }
    expect(maxC).toBeGreaterThan(4);
    expect(maxC).toBeLessThanOrEqual(15);
  });
});

/* ─── traversal vs brute force ────────────────────────────────────────────── */

const RAYS = 10000;

describe('traversal vs brute force', () => {
  test('random triangle soup', () => {
    const m = soupMesh(2000, 21);
    const { tr, scene } = singleScene(m);
    const flat = makeFlat([{ mesh: m, inst: 0 }]);
    const rnd = mulberry32(22);
    const vs: Verdict[] = [];
    let hits = 0;
    for (let i = 0; i < RAYS; i++) {
      const r = rayTo(rnd() * 2 - 0.5, rnd() * 2 - 0.5, rnd() * 2 - 0.5, rnd(), rnd(), rnd());
      const a = tr.closestHit(r), bf = bruteForce(flat, r), s = tr.closestHitBlas(scene.blasRoots[0], r);
      if (a) hits++;
      vs.push(compareHits(a, bf));
      // single-level and two-level (identity instance) agree exactly
      expect(s?.t).toBe(a?.t);
      expect(s?.prim).toBe(a?.prim);
      // any-hit consistency
      expect(tr.anyHit(r)).toBe(!!a);
      if (a) {
        expect(tr.anyHit({ ...r, tmax: a.t * (1 - 1e-9) })).toBe(false);
        expect(tr.anyHit({ ...r, tmax: a.t * (1 + 1e-9) })).toBe(true);
      }
    }
    const c = tally(vs);
    console.log('[bvh] soup:', c, 'hits', hits);
    expect(c.fail).toBe(0);
    expect(c.edge).toBe(0);
    expect(hits).toBeGreaterThan(RAYS / 4);
  }, 120000);

  const hull = cylinderMesh(256, 96);
  const hullScene = singleScene(hull);

  test('cylinder hull 256×96 with bumps (inside + outside rays)', () => {
    const flat = makeFlat([{ mesh: hull, inst: 0 }]);
    const rnd = mulberry32(31);
    const vs: Verdict[] = [];
    let hits = 0;
    const tr = hullScene.tr;
    tr.stats.nodes = tr.stats.tris = 0;
    for (let i = 0; i < RAYS; i++) {
      let r: Ray;
      if (i % 5 === 4) { // outside, aimed at a random point on the axis
        const th = rnd() * Math.PI * 2;
        r = rayTo(80 * Math.sin(th), 80 * Math.cos(th), (rnd() - 0.5) * 400, 0, 0, (rnd() - 0.5) * 300);
      } else {
        const th = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()) * 44;
        const [dx, dy, dz] = randomDir(rnd);
        r = { ox: rr * Math.sin(th), oy: rr * Math.cos(th), oz: (rnd() - 0.5) * 280, dx, dy, dz, tmin: 0, tmax: 1e30 };
      }
      const a = tr.closestHit(r), bf = bruteForce(flat, r);
      if (a) hits++;
      vs.push(compareHits(a, bf));
      expect(tr.anyHit(r)).toBe(!!a);
    }
    const c = tally(vs);
    console.log('[bvh] hull:', c, 'hits', hits, `avg nodes/ray ${(tr.stats.nodes / RAYS).toFixed(1)}, tris/ray ${(tr.stats.tris / RAYS).toFixed(1)}, maxStack ${tr.stats.maxStack}`);
    expect(c.fail).toBe(0);
    expect(c.edge).toBe(0);
    expect(hits).toBeGreaterThan(RAYS * 0.75);
  }, 120000);

  test('three-mesh-bvh raycastFirst agrees on the cylinder hull', () => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(hull.pos, 3));
    geo.setIndex(new THREE.BufferAttribute(hull.idx!.slice(), 1));
    const mbvh = new MeshBVH(geo, { indirect: true });
    const rnd = mulberry32(41);
    const ray = new THREE.Ray();
    const vs: Verdict[] = [];
    for (let i = 0; i < RAYS; i++) {
      const th = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()) * 44;
      const [dx, dy, dz] = randomDir(rnd);
      const r: Ray = { ox: rr * Math.sin(th), oy: rr * Math.cos(th), oz: (rnd() - 0.5) * 280, dx, dy, dz, tmin: 0, tmax: 1e30 };
      ray.origin.set(r.ox, r.oy, r.oz);
      ray.direction.set(r.dx, r.dy, r.dz);
      const h3 = mbvh.raycastFirst(ray, THREE.DoubleSide);
      const a = hullScene.tr.closestHit(r);
      const b: Hit | null = h3 ? { t: h3.distance, instance: 0, prim: h3.faceIndex!, tri: -1, u: 1 / 3, v: 1 / 3 } : null;
      let v = compareHits(a, b);
      if (v === 'fail' && a && b && nearEdge(a, 1e-3)) v = 'edge'; // three's test is not watertight
      vs.push(v);
    }
    const c = tally(vs);
    console.log('[bvh] vs three-mesh-bvh:', c);
    expect(c.fail).toBe(0);
    expect(c.edge).toBeLessThanOrEqual(RAYS * 1e-3);
  }, 120000);

  test('two-level scene with random instance transforms (non-uniform scale, mirrors) vs flattened brute force', () => {
    const rnd = mulberry32(51);
    const meshes = [soupMesh(300, 52, 0.3), cylinderMesh(24, 8, 1, 3), gridMesh(16, 53), soupMesh(1, 54, 0.5)];
    const blas = meshes.map((m) => buildPackedBlas(m.pos, m.idx, { groups: [{ start: 0, count: m.triCount * 3, slot: 2 }] }));
    const SPREAD = 40;
    const mk = (count: number, dynamic: boolean): InstanceBatch => {
      const ids = new Uint32Array(count), mats = new Float32Array(count * 16), tint = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        ids[i] = (rnd() * meshes.length) | 0;
        mats.set(randomMatrix(rnd, SPREAD), i * 16);
        tint.set([rnd(), rnd(), rnd()], i * 3);
      }
      return { count, blas: ids, matrices: mats, tint, matBase: 7, dynamic };
    };
    const batches = [mk(120, false), mk(30, true), mk(60, false)];
    const scene = packScene(blas, batches);
    expect(scene.tlasStaticDepth).toBeLessThanOrEqual(TLAS_MAX_DEPTH);
    expect(scene.tlasDynamicDepth).toBeLessThanOrEqual(TLAS_MAX_DEPTH);
    expect(scene.instanceCount).toBe(210);
    expect(Array.from(scene.batchInstanceBase)).toEqual([0, 180, 120]);

    const flatten = (bs: InstanceBatch[]) => {
      const parts: { mesh: Mesh; m: Float32Array; inst: number }[] = [];
      bs.forEach((b, bi) => {
        for (let i = 0; i < b.count; i++) {
          const id = typeof b.blas === 'number' ? b.blas : b.blas[i];
          parts.push({ mesh: meshes[id], m: b.matrices.subarray(i * 16, i * 16 + 16), inst: scene.batchInstanceBase[bi] + i });
        }
      });
      return makeFlat(parts, 16);
    };

    /* exact oracle: every instance, ray moved to object space through the PACKED f32
       worldToObject rows (same arithmetic as the traversal), all triangles tested */
    const meshBox = meshes.map((m) => {
      const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (let i = 0; i < m.pos.length; i += 3) for (let a = 0; a < 3; a++) {
        b[a] = Math.min(b[a], m.pos[i + a]); b[3 + a] = Math.max(b[3 + a], m.pos[i + a]);
      }
      return b.map((x, k) => x + (k < 3 ? -1e-6 : 1e-6));
    });
    const opre = new Float64Array(RAY_PRE_SIZE), tv = new Float64Array(9);
    const instancedBruteForce = (r: Ray): Hit | null => {
      const IF = new Float32Array(scene.instances), IU = new Uint32Array(scene.instances);
      let best: Hit | null = null, tmax = r.tmax;
      for (let i = 0; i < scene.instanceCount; i++) {
        const w = i * 16;
        if (((IU[w + INST_W.flagsLight] >>> 24) & VIS_ALL) === 0) continue;
        const row = (k: number, x: number, y: number, z: number, h: number) => IF[w + k * 4] * x + IF[w + k * 4 + 1] * y + IF[w + k * 4 + 2] * z + IF[w + k * 4 + 3] * h;
        const o = [row(0, r.ox, r.oy, r.oz, 1), row(1, r.ox, r.oy, r.oz, 1), row(2, r.ox, r.oy, r.oz, 1)];
        const d = [row(0, r.dx, r.dy, r.dz, 0), row(1, r.dx, r.dy, r.dz, 0), row(2, r.dx, r.dy, r.dz, 0)];
        const mi = scene.instanceBlas[i], m = meshes[mi], bx = meshBox[mi];
        let tn = 0, tf = tmax, miss = false;
        for (let a = 0; a < 3 && !miss; a++) {
          if (Math.abs(d[a]) < 1e-30) { if (o[a] < bx[a] || o[a] > bx[3 + a]) miss = true; continue; }
          let t0 = (bx[a] - o[a]) / d[a], t1 = (bx[3 + a] - o[a]) / d[a];
          if (t0 > t1) { const t = t0; t0 = t1; t1 = t; }
          tn = Math.max(tn, t0); tf = Math.min(tf, t1 * (1 + 1e-9));
          if (tn > tf) miss = true;
        }
        if (miss) continue;
        prepareRay(opre, o[0], o[1], o[2], d[0], d[1], d[2]);
        for (let t = 0; t < m.triCount; t++) {
          triVerts(m, t, tv);
          if (intersectTriangleRaw(opre, tv[0], tv[1], tv[2], tv[3], tv[4], tv[5], tv[6], tv[7], tv[8], r.tmin, tmax, hOut)) {
            tmax = hOut[0];
            best = { t: hOut[0], instance: i, prim: t, tri: -1, u: hOut[1], v: hOut[2] };
          }
        }
      }
      return best;
    };

    const check = (label: string, nRays: number) => {
      const flat = flatten(batches);
      const tr = createTraverser(scene);
      const vs: Verdict[] = [];
      const exact: Verdict[] = [];
      let hits = 0;
      for (let i = 0; i < nRays; i++) {
        let r: Ray;
        if (i & 1) {
          const [dx, dy, dz] = randomDir(rnd);
          r = { ox: (rnd() - 0.5) * SPREAD * 1.5, oy: (rnd() - 0.5) * SPREAD * 1.5, oz: (rnd() - 0.5) * SPREAD * 1.5, dx, dy, dz, tmin: 0, tmax: 1e30 };
        } else {
          const t = (rnd() * flat.n) | 0, w = t * 9; // aim at a random triangle
          const a = rnd(), b = rnd() * (1 - a);
          const tx = flat.v[w] * (1 - a - b) + flat.v[w + 3] * a + flat.v[w + 6] * b;
          const ty = flat.v[w + 1] * (1 - a - b) + flat.v[w + 4] * a + flat.v[w + 7] * b;
          const tz = flat.v[w + 2] * (1 - a - b) + flat.v[w + 5] * a + flat.v[w + 8] * b;
          const [dx, dy, dz] = randomDir(rnd);
          r = rayTo(tx - dx * SPREAD, ty - dy * SPREAD, tz - dz * SPREAD, tx, ty, tz);
        }
        const a = tr.closestHit(r), bf = bruteForce(flat, r);
        if (a) hits++;
        exact.push(compareHits(a, instancedBruteForce(r), 1e-12));
        // World-space oracle: the traversal sees each instance through an f32 worldToObject,
        // so its t carries cond(M)·ε32·|o| of error, amplified by 1/cosθ at grazing incidence:
        // compare relative to max(t, |o|, 1) / max(cosθ, 0.02).
        let cos = 1;
        if (bf) {
          const v = flat.v, w = bf.tri * 9;
          const e1 = [v[w + 3] - v[w], v[w + 4] - v[w + 1], v[w + 5] - v[w + 2]];
          const e2 = [v[w + 6] - v[w], v[w + 7] - v[w + 1], v[w + 8] - v[w + 2]];
          const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
          cos = Math.abs(n[0] * r.dx + n[1] * r.dy + n[2] * r.dz) / (Math.hypot(n[0], n[1], n[2]) || 1);
        }
        vs.push(compareHits(a, bf, 1e-5, Math.max(1, Math.hypot(r.ox, r.oy, r.oz)) / Math.max(cos, 0.02)));
        expect(tr.anyHit(r)).toBe(!!a);
        if (a) {
          expect(tr.anyHit({ ...r, tmax: a.t * (1 - 1e-6) })).toBe(false);
        }
      }
      const c = tally(vs), cx = tally(exact);
      console.log(`[bvh] two-level ${label}: vs flattened world`, c, 'vs instance-space brute force', cx, 'hits', hits, 'maxStack', tr.stats.maxStack);
      expect(cx.fail).toBe(0);
      expect(cx.edge).toBe(0);
      expect(c.fail).toBe(0);
      expect(c.edge).toBeLessThanOrEqual(nRays * 5e-4);
      expect(hits).toBeGreaterThan(nRays / 3);
    };
    check('static+dynamic', RAYS);

    // material slot from groups, instance record fields
    const tu = new Uint32Array(scene.tris);
    expect(tu[TRI_W.slot]).toBe(2);
    for (let b = 0; b < meshes.length; b++) expect(tu[scene.blasTriBase[b] * 12 + TRI_W.aux]).toBe(b);
    const iu = new Uint32Array(scene.instances);
    expect(iu[INST_W.matBase]).toBe(7);
    expect(iu[180 * 16 + INST_W.flagsLight] >>> 24).toBe(VIS_ALL | 32); // dynamic flag

    // move the dynamic instances and check again
    const moved = batches[1];
    for (let i = 0; i < moved.count; i++) moved.matrices.set(randomMatrix(rnd, SPREAD), i * 16);
    const dirty = updateDynamic(scene, [moved]);
    expect(dirty.nodes.length).toBe(2);
    expect(dirty.instances).toEqual([180 * INST_BYTES, 30 * INST_BYTES]);
    check('after updateDynamic', 3000);
  }, 120000);

  test('instance visibility mask and singular matrices', () => {
    const m = gridMesh(4, 1);
    const pb = buildPackedBlas(m.pos, m.idx);
    const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const at = (y: number) => { const a = I.slice(); a[13] = y; return a; };
    const scene = packScene([pb], [
      { count: 1, blas: 0, matrices: new Float32Array(at(0)), flags: VIS_CAMERA },          // camera only
      { count: 1, blas: 0, matrices: new Float32Array(at(-1)), flags: VIS_SHADOW },         // shadow only
      { count: 1, blas: 0, matrices: new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 1]) } // singular
    ]);
    const tr = createTraverser(scene);
    const down: Ray = { ox: 0.1, oy: 5, oz: 0.1, dx: 0, dy: -1, dz: 0, tmin: 0, tmax: 1e30 };
    expect(tr.closestHit(down, VIS_CAMERA)?.instance).toBe(0);
    expect(tr.closestHit(down, VIS_SHADOW)?.instance).toBe(1);
    expect(tr.anyHit(down, VIS_SHADOW)).toBe(true);
    expect(tr.anyHit({ ...down, tmax: 5.5 }, VIS_SHADOW)).toBe(false);
    expect(tr.closestHit(down, 1 << 3)).toBeNull();
    // the singular instance (index 2) is invisible to every mask
    expect(new Uint32Array(scene.instances)[2 * 16 + INST_W.flagsLight] >>> 24 & VIS_ALL).toBe(0);
  });

  test('scenes without instances, with only dynamic instances, with an empty BLAS', () => {
    const m = gridMesh(4, 1);
    const pb = buildPackedBlas(m.pos, m.idx);
    const empty = buildPackedBlas(new Float32Array(0));
    const down: Ray = { ox: 0.1, oy: 5, oz: 0.1, dx: 0, dy: -1, dz: 0, tmin: 0, tmax: 1e30 };
    const none = packScene([pb], []);
    expect(createTraverser(none).closestHit(down)).toBeNull();
    const I = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const dynOnly = packScene([empty, pb], [{ count: 1, blas: 1, matrices: I, dynamic: true }, { count: 2, blas: 0, matrices: new Float32Array([...I, ...I]) }]);
    expect(dynOnly.tlasDynamicRoot).not.toBe(0xffffffff);
    const tr = createTraverser(dynOnly);
    expect(tr.closestHit(down)?.instance).toBe(2);
    const h0 = tr.closestHit(down)!;
    expect(h0.t).toBeGreaterThan(4.9); // grid heights are within ±0.05
    expect(h0.t).toBeLessThan(5.1);
    updateDynamic(dynOnly, [{ count: 1, blas: 1, matrices: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 2, 0, 1]) }]);
    const h = createTraverser(dynOnly).closestHit(down);
    expect(h?.instance).toBe(2);
    expect(h!.t).toBeLessThan(3.2);
  });
});

/* ─── TLAS ────────────────────────────────────────────────────────────────── */

describe('tlas', () => {
  test('world bounds contain transformed vertices; TLAS valid', () => {
    const rnd = mulberry32(61);
    const m = soupMesh(200, 62);
    const b = buildBlas(m.pos);
    const n = 500;
    const mats = new Float32Array(n * 16);
    for (let i = 0; i < n; i++) mats.set(randomMatrix(rnd, 100), i * 16);
    const wb = instanceWorldBounds(b.bounds, 0, mats, n);
    let outside = 0;
    for (let i = 0; i < n; i++) {
      const M = mats.subarray(i * 16);
      for (let v = 0; v < m.pos.length; v += 3) {
        const x = m.pos[v], y = m.pos[v + 1], z = m.pos[v + 2];
        const p = [M[0] * x + M[4] * y + M[8] * z + M[12], M[1] * x + M[5] * y + M[9] * z + M[13], M[2] * x + M[6] * y + M[10] * z + M[14]];
        for (let a = 0; a < 3; a++) if (p[a] < wb[i * 6 + a] || p[a] > wb[i * 6 + 3 + a]) outside++;
      }
    }
    expect(outside).toBe(0);
    const t = buildTlas(wb, 10);
    expect(validateBvh(t, wb, TLAS_MAX_DEPTH)).toBeNull();
    expect(t.nodeCount).toBe(n - 1);
  }, 60000);
});

/* ─── worker / pool ───────────────────────────────────────────────────────── */

describe('worker & pool', () => {
  const m = cylinderMesh(32, 16);

  test('handleBuildRequest = buildPackedBlas', () => {
    const { response, transfer } = handleBuildRequest({ id: 3, positions: m.pos, index: m.idx });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const ref = buildPackedBlas(m.pos, m.idx);
    expect(response.id).toBe(3);
    expect(new Uint8Array(response.nodes)).toEqual(new Uint8Array(ref.nodes));
    expect(new Uint8Array(response.tris)).toEqual(new Uint8Array(ref.tris));
    expect(transfer.length).toBe(2);
    const bad = handleBuildRequest({ id: 4, positions: m.pos, options: { maxDepth: 0.5 } as never });
    expect(bad.response.id).toBe(4);
  });

  test('pool: synchronous fallback without Worker', async () => {
    const pool = createBvhPool();
    expect(pool.threaded).toBe(typeof Worker !== 'undefined');
    const res = await pool.buildAll([{ positions: m.pos, index: m.idx }, { positions: soupMesh(100, 1).pos }]);
    expect(res[0].triCount).toBe(m.triCount);
    expect(res[1].triCount).toBe(100);
    pool.terminate();
  });

  test('pool: queue over (mock) workers', async () => {
    let created = 0, maxBusy = 0, busy = 0;
    const factory = (): WorkerLike => {
      created++;
      const w: WorkerLike = {
        onmessage: null, onerror: null,
        postMessage(msg) {
          busy++; maxBusy = Math.max(maxBusy, busy);
          setTimeout(() => {
            busy--;
            const { response } = handleBuildRequest(msg as Parameters<typeof handleBuildRequest>[0]);
            w.onmessage?.({ data: response });
          }, 1);
        },
        terminate() {}
      };
      return w;
    };
    const pool = createBvhPool({ size: 2, createWorker: factory });
    expect(pool.threaded).toBe(true);
    const inputs = Array.from({ length: 7 }, (_, i) => ({ positions: soupMesh(50 + i, i).pos }));
    const res: PackedBlas[] = await pool.buildAll(inputs);
    expect(created).toBe(2);
    expect(maxBusy).toBe(2);
    expect(res.map((r) => r.triCount)).toEqual(inputs.map((_, i) => 50 + i));
    pool.terminate();
  });
});

/* ─── timings (printed, not asserted) ─────────────────────────────────────── */

describe('timings', () => {
  test('build times', () => {
    const now = () => performance.now();
    const rows: string[] = [];
    for (const [label, m] of [['65k hull', cylinderMesh(256, 128)], ['400k hull', cylinderMesh(640, 320)], ['400k soup', soupMesh(400000, 3, 0.01)]] as [string, Mesh][]) {
      buildBlas(m.pos, m.idx); // warm-up
      let best = Infinity, pack = Infinity;
      for (let i = 0; i < 3; i++) {
        const t0 = now();
        const b = buildBlas(m.pos, m.idx);
        const t1 = now();
        buildPackedBlas(m.pos, m.idx);
        const t2 = now();
        best = Math.min(best, t1 - t0);
        pack = Math.min(pack, t2 - t1);
        if (i === 0) rows.push(`${label} (${m.triCount} tris, ${b.nodeCount} nodes, depth ${b.maxDepth}, SAH ${bvhSahCost(b).toFixed(1)})`);
      }
      rows.push(`  build ${best.toFixed(1)} ms, build+pack ${pack.toFixed(1)} ms`);
    }
    // TLAS over 20k instances
    const rnd = mulberry32(5);
    const n = 20000, mats = new Float32Array(n * 16);
    for (let i = 0; i < n; i++) mats.set(randomMatrix(rnd, 300), i * 16);
    const bb = new Float32Array([-1, -1, -1, 1, 1, 1]);
    let tl = Infinity, depth = 0;
    for (let i = 0; i < 3; i++) {
      const t0 = now();
      const t = buildTlas(instanceWorldBounds(bb, 0, mats, n));
      tl = Math.min(tl, now() - t0);
      depth = t.maxDepth;
    }
    rows.push(`TLAS 20k instances: ${tl.toFixed(1)} ms (depth ${depth})`);
    console.log('[bvh] timings\n' + rows.join('\n'));
    expect(rows.length).toBeGreaterThan(0);
  }, 180000);
});
