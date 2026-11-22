// ═══════════════════════════════════════════════════════════════════════════
// light_tree.wgsl — emissive-triangle light selection over the light data
// buffer (layout: pathtracer/lights/light-data.ts). CPU mirror:
// pathtracer/lights/light-tree.ts + alias.ts (keep in step).
//   • L2 light BVH: stochastic traversal (b5_lt_sample), pmf by walking up
//     from the light's leaf (b5_lt_pmf), root importance (tube selection);
//   • L1 Vose alias table (b5_alias_sample / b5_alias_pmf);
//   • triangle records (world vertices) and uniform area sampling.
// The including kernel declares `b5_ldata: array<vec4f>` (its own group).
// Requires lights.gen.wgsl.
// ═══════════════════════════════════════════════════════════════════════════

struct B5LNode {
  bmin: vec3f,
  phi: f32,
  bmax: vec3f,
  cosO: f32,
  w: vec3f,
  cosE: f32,
  child0: u32,
  child1: u32,
  parent: u32,
  flags: u32,
}

struct B5LightTri {
  v0: vec3f,
  inst: u32,
  v1: vec3f,
  tri: u32,
  v2: vec3f,
  leaf: u32,
}

struct B5LightPick {
  light: u32,   // B5_NO_INDEX = nothing
  pmf: f32,
}

fn b5_ld_u(row: u32, c: u32) -> u32 {
  return bitcast<u32>(b5_ldata[row][c]);
}

fn b5_lights_count() -> u32 {
  return b5_ld_u(0u, 0u);
}

fn b5_lt_node(i: u32) -> B5LNode {
  let r = b5_ld_u(0u, 2u) + i * B5_LNODE_ROWS;
  let a = b5_ldata[r];
  let b = b5_ldata[r + 1u];
  let c = b5_ldata[r + 2u];
  let d = bitcast<vec4u>(b5_ldata[r + 3u]);
  return B5LNode(a.xyz, a.w, b.xyz, b.w, c.xyz, c.w, d.x, d.y, d.z, d.w);
}

fn b5_light_tri(id: u32) -> B5LightTri {
  let r = b5_ld_u(0u, 3u) + id * B5_LIGHT_ROWS;
  let a = b5_ldata[r];
  let b = b5_ldata[r + 1u];
  let c = b5_ldata[r + 2u];
  return B5LightTri(a.xyz, bitcast<u32>(a.w), b.xyz, bitcast<u32>(b.w), c.xyz, bitcast<u32>(c.w));
}

// (q, alias, pmf, area)
fn b5_alias_row(id: u32) -> vec4f {
  return b5_ldata[b5_ld_u(1u, 0u) + id];
}

fn b5_cos_sub(sA: f32, cA: f32, sB: f32, cB: f32) -> f32 {
  return select(cA * cB + sA * sB, 1.0, cA > cB);
}

fn b5_sin_sub(sA: f32, cA: f32, sB: f32, cB: f32) -> f32 {
  return select(sA * cB - cA * sB, 0.0, cA > cB);
}

// pbrt-v4 LightBounds::Importance; n = 0: no receiver term
fn b5_lt_importance(b: B5LNode, p: vec3f, n: vec3f) -> f32 {
  if (!(b.phi > 0.0)) {
    return 0.0;
  }
  let c = (b.bmin + b.bmax) * 0.5;
  let dv = p - c;
  let ext = b.bmax - b.bmin;
  let halfDiag = 0.5 * length(ext);
  let dl2 = dot(dv, dv);
  let d2 = max(dl2, halfDiag);
  let dl = sqrt(dl2);
  var wi = vec3f(0.0, 0.0, 1.0);
  if (dl > 0.0) {
    wi = dv / dl;
  }
  var cosW = dot(b.w, wi);
  if ((b.flags & B5_LNODE_TWO_SIDED) != 0u) {
    cosW = abs(cosW);
  }
  let sinW = sqrt(max(0.0, 1.0 - cosW * cosW));
  let r2 = halfDiag * halfDiag;
  var cosB = -1.0;
  if (dl2 >= r2) {
    cosB = sqrt(max(0.0, 1.0 - r2 / dl2));
  }
  let sinB = sqrt(max(0.0, 1.0 - cosB * cosB));
  let sinO = sqrt(max(0.0, 1.0 - b.cosO * b.cosO));
  let cosX = b5_cos_sub(sinW, cosW, sinO, b.cosO);
  let sinX = b5_sin_sub(sinW, cosW, sinO, b.cosO);
  let cosP = b5_cos_sub(sinX, cosX, sinB, cosB);
  if (cosP <= b.cosE) {
    return 0.0;
  }
  var imp = b.phi * cosP / d2;
  if (any(n != vec3f(0.0))) {
    let cosI = abs(dot(wi, n));
    let sinI = sqrt(max(0.0, 1.0 - cosI * cosI));
    imp *= b5_cos_sub(sinI, cosI, sinB, cosB);
  }
  return max(imp, 0.0);
}

const B5_ONE_MINUS_EPS: f32 = 0.99999994;

fn b5_lt_sample(p: vec3f, n: vec3f, u0: f32) -> B5LightPick {
  var out = B5LightPick(B5_NO_INDEX, 0.0);
  if (b5_ld_u(0u, 1u) == 0u) {
    return out;
  }
  var u = u0;
  var i = 0u;
  var pmf = 1.0;
  loop {
    let nd = b5_lt_node(i);
    if ((nd.flags & B5_LNODE_LEAF) != 0u) {
      out.light = nd.child0;
      out.pmf = pmf;
      return out;
    }
    let i0 = b5_lt_importance(b5_lt_node(nd.child0), p, n);
    let i1 = b5_lt_importance(b5_lt_node(nd.child1), p, n);
    if (!(i0 + i1 > 0.0)) {
      return out;
    }
    let p0 = i0 / (i0 + i1);
    if (u < p0) {
      i = nd.child0;
      u = min(u / p0, B5_ONE_MINUS_EPS);
      pmf *= p0;
    } else {
      i = nd.child1;
      u = min((u - p0) / (1.0 - p0), B5_ONE_MINUS_EPS);
      pmf *= 1.0 - p0;
    }
  }
}

fn b5_lt_pmf(p: vec3f, n: vec3f, light: u32) -> f32 {
  var i = b5_light_tri(light).leaf;
  if (i == B5_NO_NODE) {
    return 0.0;
  }
  var pmf = 1.0;
  loop {
    let par = b5_lt_node(i).parent;
    if (par == B5_NO_NODE) {
      break;
    }
    let pn = b5_lt_node(par);
    let i0 = b5_lt_importance(b5_lt_node(pn.child0), p, n);
    let i1 = b5_lt_importance(b5_lt_node(pn.child1), p, n);
    if (!(i0 + i1 > 0.0)) {
      return 0.0;
    }
    pmf *= select(i1, i0, pn.child0 == i) / (i0 + i1);
    i = par;
  }
  return pmf;
}

fn b5_lt_root_importance(p: vec3f, n: vec3f) -> f32 {
  if (b5_ld_u(0u, 1u) == 0u) {
    return 0.0;
  }
  let r = b5_lt_node(0u);
  if ((r.flags & B5_LNODE_LEAF) != 0u) {
    return b5_lt_importance(r, p, n);
  }
  return b5_lt_importance(b5_lt_node(r.child0), p, n) + b5_lt_importance(b5_lt_node(r.child1), p, n);
}

fn b5_alias_sample(u: f32) -> B5LightPick {
  let n = b5_lights_count();
  var out = B5LightPick(B5_NO_INDEX, 0.0);
  if (n == 0u || !(bitcast<f32>(b5_ld_u(1u, 1u)) > 0.0)) {
    return out;
  }
  let x = u * f32(n);
  let i = min(u32(x), n - 1u);
  let row = b5_alias_row(i);
  var id = i;
  if (!(x - f32(i) < row.x)) {
    id = bitcast<u32>(row.y);
  }
  out.light = id;
  out.pmf = b5_alias_row(id).z;
  if (!(out.pmf > 0.0)) {
    out.light = B5_NO_INDEX;
  }
  return out;
}

fn b5_alias_pmf(light: u32) -> f32 {
  return b5_alias_row(light).z;
}

fn b5_light_area(light: u32) -> f32 {
  return b5_alias_row(light).w;
}

// selection pmf of `light` with the active strategy (lightMode)
fn b5_light_pmf(mode: u32, p: vec3f, n: vec3f, light: u32) -> f32 {
  if (mode == B5_LIGHTS_TREE) {
    return b5_lt_pmf(p, n, light);
  }
  if (mode == B5_LIGHTS_ALIAS) {
    return b5_alias_pmf(light);
  }
  return 0.0;
}

fn b5_light_pick(mode: u32, p: vec3f, n: vec3f, u: f32) -> B5LightPick {
  if (mode == B5_LIGHTS_TREE) {
    return b5_lt_sample(p, n, u);
  }
  if (mode == B5_LIGHTS_ALIAS) {
    return b5_alias_sample(u);
  }
  return B5LightPick(B5_NO_INDEX, 0.0);
}

// probability of picking the tube (vs the triangle lights) at (p, n)
fn b5_ptube(tubeOn: bool, tubeLum: f32, r: f32, z0: f32, len: f32, mode: u32, p: vec3f, n: vec3f) -> f32 {
  if (!tubeOn) {
    return 0.0;
  }
  if (mode == B5_LIGHTS_NONE) {
    return 1.0;
  }
  let it = b5_tube_importance(p, r, z0, len, tubeLum);
  let il = b5_lt_root_importance(p, n);
  if (!(il > 0.0)) {
    return 1.0;
  }
  if (!(it > 0.0)) {
    return 0.0;
  }
  return clamp(it / (it + il), B5_PTUBE_MIN, B5_PTUBE_MAX);
}
