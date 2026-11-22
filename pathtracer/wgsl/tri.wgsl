// ═══════════════════════════════════════════════════════════════════════════
// tri.wgsl — ray set-up and the watertight ray/triangle test
// (Woop, Benthin, Wald 2013, "Watertight Ray/Triangle Intersection"), f32.
// Mirrors pathtracer/bvh/traverse-ref.ts prepareRayF32 / intersectTriangleF32
// operation for operation (same evaluation order) — keep them in sync.
// Double-sided; frontFace = det > 0 = the geometric normal (v1−v0)×(v2−v0)
// faces the ray (object space, DECISIONS.md #4). No double-precision
// fallback for U/V/W = 0 (neither side uses it).
// ═══════════════════════════════════════════════════════════════════════════

// per-ray constants: origin, 1/d for the slab test, Woop permutation + shear
struct B5RayPre {
  o: vec3f,
  inv: vec3f,
  s: vec3f,
  k: vec3u,
}

struct B5TriHit {
  t: f32,
  u: f32,
  v: f32,
  front: bool,
}

// 1/x with |x| clamped to B5_DIR_EPS (keeps 1/d finite in f32)
fn b5_safe_inv(x: f32) -> f32 {
  let e = select(select(-B5_DIR_EPS, B5_DIR_EPS, x >= 0.0), x, abs(x) > B5_DIR_EPS);
  return 1.0 / e;
}

fn b5_prepare_ray(o: vec3f, d: vec3f) -> B5RayPre {
  var p: B5RayPre;
  p.o = o;
  p.inv = vec3f(b5_safe_inv(d.x), b5_safe_inv(d.y), b5_safe_inv(d.z));
  let a = abs(d);
  // kz = dominant axis (ties: x before y before z, as in the reference)
  var kz = 2u;
  if (a.x >= a.y) {
    if (a.x >= a.z) { kz = 0u; }
  } else if (a.y >= a.z) {
    kz = 1u;
  }
  var kx = select(kz + 1u, 0u, kz == 2u);
  var ky = select(kx + 1u, 0u, kx == 2u);
  let dkz = d[kz];
  // keep the winding: swap kx/ky when the dominant component is negative
  if (dkz < 0.0) {
    let tmp = kx;
    kx = ky;
    ky = tmp;
  }
  p.k = vec3u(kx, ky, kz);
  p.s = vec3f(d[kx] / dkz, d[ky] / dkz, 1.0 / dkz);
  return p;
}

// true when tmin < t < tmax; the hit goes to *h
fn b5_intersect_tri(p: B5RayPre, v0: vec3f, v1: vec3f, v2: vec3f, tmin: f32, tmax: f32,
                    h: ptr<function, B5TriHit>) -> bool {
  let A = v0 - p.o;
  let B = v1 - p.o;
  let C = v2 - p.o;
  let Az = A[p.k.z];
  let Bz = B[p.k.z];
  let Cz = C[p.k.z];
  let Ax = A[p.k.x] - p.s.x * Az;
  let Ay = A[p.k.y] - p.s.y * Az;
  let Bx = B[p.k.x] - p.s.x * Bz;
  let By = B[p.k.y] - p.s.y * Bz;
  let Cx = C[p.k.x] - p.s.x * Cz;
  let Cy = C[p.k.y] - p.s.y * Cz;
  let U = Cx * By - Cy * Bx;
  let V = Ax * Cy - Ay * Cx;
  let W = Bx * Ay - By * Ax;
  if ((U < 0.0 || V < 0.0 || W < 0.0) && (U > 0.0 || V > 0.0 || W > 0.0)) {
    return false;
  }
  let det = U + V + W;
  if (det == 0.0) {
    return false;
  }
  let T = (U * Az + V * Bz + W * Cz) * p.s.z;
  let t = T / det;
  if (!(t > tmin && t < tmax)) {
    return false;
  }
  (*h).t = t;
  (*h).u = V / det;
  (*h).v = W / det;
  (*h).front = det > 0.0;
  return true;
}
