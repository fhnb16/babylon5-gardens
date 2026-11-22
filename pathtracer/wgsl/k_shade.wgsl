// ═══════════════════════════════════════════════════════════════════════════
// k_shade.wgsl — shade (PT-W4a), one invocation per queued ray of this bounce:
//   • emission of the hit surface, MIS (power heuristic) against NEE when the
//     hit is on the tube or on an emissive-triangle light (pdf evaluated at
//     the path's last scattering vertex pp/pn: tube pdf / light-tree or
//     alias pmf × 1/area → solid angle); weight 1 at depth 0, after delta
//     events and for emitters NEE does not sample (hull city glow, caps);
//   • AOVs into the path (PT-P4): albedo + normal of the first non-delta
//     vertex, linear view depth of the first hit (k_accumulate sums them);
//   • sampler dimensions per vertex depth (sampling.wgsl, sampler.ts), path
//     regularization (regK);
//   • BSDF from the surface (b5_bsdf_from_surface): standard GGX + Lambert,
//     thin glass (delta), hull = stochastic foam / water / dry component;
//   • NEE: one light per vertex — the tube with probability p_tube
//     (b5_ptube: analytic tube importance vs light-tree root importance,
//     clamped), sampled equiangular (or uniform area, tubeMode), else an
//     emissive triangle (tree or alias, lightMode) sampled uniformly by area,
//     its emission evaluated with b5_surface; one shadow ray (k_shadow_tr:
//     thin glass transmits), MIS against the BSDF pdf;
//   • BSDF sample → extension ray; thin-glass transmission passes straight
//     through and keeps pp / pn / pdf (MIS through glazing);
//   • Russian roulette from rrDepth, firefly clamp on indirect;
//   • compaction with one global atomic per workgroup.
// group 0: scene (b5_tris / b5_insts, used by b5_surface)
// group 1: frame, paths, hits, queues, rays, light data
// group 2: surface resources (surface.wgsl)
// Loader define B5_SPECULAR (bool): false = pure Lambert (furnace test).
// ═══════════════════════════════════════════════════════════════════════════
//#include "common.wgsl"
//#include "tri.wgsl"
//#include "traverse.wgsl"
//#include "sampling.wgsl"
//#include "pt_state.wgsl"
//#include "surface.wgsl"
//#include "pt_config.gen.wgsl"
//#include "lights.gen.wgsl"
//#include "light_tube.wgsl"
//#include "light_tree.wgsl"
//#include "bsdf_std.wgsl"
//#include "bsdf_glass.wgsl"
//#include "bsdf_water.wgsl"
//#include "bsdf.wgsl"

override B5_WG_SIZE: u32 = 64u;

const B5_RR_MAX: f32 = 0.95;
// the hit lies on the analytic tube's lateral surface (tessellation slack
// of the radius both ways: chords sit inside the circle)
const B5_TUBE_SLACK: f32 = 0.05;

@group(1) @binding(0) var<uniform> b5_wave: B5Frame;
@group(1) @binding(1) var<storage, read_write> b5_paths: array<B5Path>;
@group(1) @binding(2) var<storage, read> b5_hits: array<B5HitRec>;
@group(1) @binding(3) var<storage, read_write> b5_queues: B5Queues;
@group(1) @binding(4) var<storage, read_write> b5_rays: array<B5Ray>;
@group(1) @binding(5) var<storage, read> b5_ldata: array<vec4f>;

var<workgroup> b5_wg_rays: atomic<u32>;
var<workgroup> b5_wg_shadows: atomic<u32>;
var<workgroup> b5_wg_ray_base: u32;
var<workgroup> b5_wg_shadow_base: u32;

struct B5ShadeOut {
  p: u32,
  wantRay: bool,
  wantShadow: bool,
  ray: B5Ray,
  shadow: B5Ray,
}

struct B5LightSample {
  x: vec3f,      // point on the light
  pdf: f32,      // solid-angle pdf incl. the selection probability (0 = none)
  wi: vec3f,
  dist: f32,
  Le: vec3f,
}

fn b5_on_tube(p: vec3f) -> bool {
  let f = b5_wave;
  let rho = length(p.xy);
  let slack = f.tubeR * B5_TUBE_SLACK;
  return f.tubeOn != 0u && rho <= f.tubeR + slack && rho >= f.tubeR - slack &&
         p.z >= f.tubeZ0 - slack && p.z <= f.tubeZ0 + f.tubeLen + slack;
}

fn b5_clamp_ind(c: vec3f, depth: u32) -> vec3f {
  let m = b5_max3(c);
  let k = b5_wave.clampInd;
  if (depth == 0u || k <= 0.0 || m <= k) {
    return c;
  }
  return c * (k / m);
}

fn b5_offset(p: vec3f, n: vec3f) -> vec3f {
  let s = 1.0 + max(abs(p.x), max(abs(p.y), abs(p.z)));
  return p + n * (b5_wave.rayEps * s);
}

// AOV of the path (accumulated per pixel by k_accumulate): albedo + world normal of
// the first non-delta vertex (a delta vertex — thin glass — writes a provisional
// value that the next vertex replaces); `done` closes it
fn b5_path_aov(P: ptr<function, B5Path>, albedo: vec3f, n: vec3f, done: bool) {
  if (((*P).alb >> 24u) != 0u) {
    return;
  }
  (*P).alb = pack4x8unorm(vec4f(clamp(albedo, vec3f(0.0), vec3f(1.0)), select(0.0, 1.0, done)));
  (*P).nrm = pack2x16snorm(b5_aov_oct_encode(n));
}

fn b5_p_tube(p: vec3f, n: vec3f) -> f32 {
  let f = b5_wave;
  return b5_ptube(f.tubeOn != 0u, f.tubeLum, f.tubeR, f.tubeZ0, f.tubeLen, f.lightMode, p, n);
}

fn b5_tube_pdf_mode(P: vec3f, x: vec3f) -> f32 {
  let f = b5_wave;
  if (f.tubeMode == B5_TUBE_UNIFORM) {
    return b5_tube_pdf_uniform(P, x, f.tubeR, f.tubeLen);
  }
  return b5_tube_pdf(P, x, f.tubeR, f.tubeZ0, f.tubeLen);
}

// solid-angle pdf with which NEE at (pp, pn) would have produced this emitter hit
fn b5_light_pdf_hit(pp: vec3f, pn: vec3f, s: B5Surface, h: B5HitRec) -> f32 {
  if (b5_on_tube(s.p)) {
    return b5_p_tube(pp, pn) * b5_tube_pdf_mode(pp, s.p);
  }
  let mode = b5_wave.lightMode;
  if (mode == B5_LIGHTS_NONE) {
    return 0.0;
  }
  let id = b5_surface_light(h);
  if (id == B5_NO_LIGHT || id >= b5_lights_count()) {
    return 0.0;
  }
  let pmf = b5_light_pmf(mode, pp, pn, id);
  if (!(pmf > 0.0)) {
    return 0.0;
  }
  let d = s.p - pp;
  let d2 = dot(d, d);
  let cosL = abs(dot(s.ng, d)) * inverseSqrt(d2);
  if (!(cosL > 0.0)) {
    return 0.0;
  }
  return (1.0 - b5_p_tube(pp, pn)) * pmf * d2 / (b5_light_area(id) * cosL);
}

// pick one light (tube vs emissive triangles) and sample a point on it
fn b5_sample_light(P: vec3f, n: vec3f, coneW: f32, coneS: f32, uSel: f32, u: vec2f) -> B5LightSample {
  let f = b5_wave;
  var o: B5LightSample;
  o.pdf = 0.0;
  let pt = b5_p_tube(P, n);
  if (uSel < pt) {
    var t: B5TubeSample;
    if (f.tubeMode == B5_TUBE_UNIFORM) {
      t = b5_tube_sample_uniform(P, f.tubeR, f.tubeZ0, f.tubeLen, u);
    } else {
      t = b5_tube_sample(P, f.tubeR, f.tubeZ0, f.tubeLen, u);
    }
    if (t.pdfW > 0.0) {
      o.x = t.x;
      o.wi = t.wi;
      o.dist = sqrt(t.d2);
      o.pdf = pt * t.pdfW;
      o.Le = f.tubeLe;
    }
    return o;
  }
  let pick = b5_light_pick(f.lightMode, P, n, min((uSel - pt) / (1.0 - pt), B5_ONE_MINUS_EPS));
  if (pick.light == B5_NO_INDEX || !(pick.pmf > 0.0)) {
    return o;
  }
  let lt = b5_light_tri(pick.light);
  let bc = b5_tri_uniform(u);
  let x = lt.v0 * (1.0 - bc.x - bc.y) + lt.v1 * bc.x + lt.v2 * bc.y;
  let nc = cross(lt.v1 - lt.v0, lt.v2 - lt.v0);
  let area = 0.5 * length(nc);
  let w = x - P;
  let d2 = dot(w, w);
  let dist = sqrt(d2);
  let wi = w / dist;
  let cosL = abs(dot(nc, wi)) / max(2.0 * area, 1e-30);
  if (!(cosL > 0.0) || !(area > 0.0) || !(d2 > 0.0)) {
    return o;
  }
  // emission at x through the shared surface code (fake hit at t = 1 along x − P)
  var hit: B5HitRec;
  hit.t = 1.0;
  hit.u = bc.x;
  hit.v = bc.y;
  hit.inst = lt.inst;
  hit.tri = lt.tri;
  hit.flags = 0u;
  o.x = x;
  o.wi = wi;
  o.dist = dist;
  o.Le = b5_surface_emission(hit, w, coneW + coneS * dist);
  o.pdf = (1.0 - pt) * pick.pmf * d2 / (area * cosL);
  return o;
}

fn b5_bsdf_from_surface(s: B5Surface, ns: vec3f, nv: f32, u: f32) -> B5Bsdf {
  let ma = b5_wave.minAlpha;
  if (!B5_SPECULAR) {
    var b = b5_std_make(ns, s.albedo, 0.0, 1.0, ma, nv);
    b.cd = s.albedo;
    b.pSpec = 0.0;
    b.f0 = vec3f(0.0);
    return b;
  }
  if (s.kind == B5_KIND_THINGLASS) {
    return b5_glass_make(ns, s.tint, s.ior);
  }
  if (s.kind == B5_KIND_HULL) {
    let fc = clamp(s.foam, 0.0, 1.0);
    if (u < fc) {
      return b5_std_make(ns, B5_FOAM_COLOR, 0.0, 1.0, ma, nv);
    }
    let u2 = (u - fc) / max(1.0 - fc, 1e-6);
    let wet = smoothstep(B5_HULL_WET_LO, B5_HULL_WET_HI, s.water);
    if (u2 < wet) {
      return b5_water_make(ns, s.bed, s.wtint, s.rough, B5_HULL_ABSORB_K * s.water, ma, nv);
    }
    return b5_std_make(ns, max(s.albedo - B5_FOAM_COLOR * s.foam, vec3f(0.0)), s.metal, s.rough0, ma, nv);
  }
  return b5_std_make(ns, s.albedo, s.metal, s.rough, ma, nv);
}

fn b5_shade_one(j: u32) -> B5ShadeOut {
  let f = b5_wave;
  let parity = atomicLoad(&b5_queues.ctl[B5_Q_PARITY]);
  let p = b5_queues.idx[parity * f.capacity + j];
  var P = b5_paths[p];
  let h = b5_hits[j];
  var out: B5ShadeOut;
  out.p = p;
  out.wantRay = false;
  out.wantShadow = false;
  let depth = P.depth;
  let aov = (f.flags & B5_F_AOV) != 0u;

  if (h.tri == B5_NO_INDEX || P.pixel == B5_NO_INDEX) {
    // closed station: no environment light (dead tile slots end here too)
    return out;
  }

  let coneW = P.coneW + P.coneS * h.t;
  var s = b5_surface(h, P.o, P.d, coneW);
  let wo = -P.d;

  // sampler: this vertex's dimensions (Sobol) or the path's PCG stream, drawn
  // in the allocation order of sampler.ts SAMPLER_DIMS
  var rng = b5_sampler_bounce((f.flags & B5_F_SOBOL) != 0u, P.pixel, P.sample, f.salt, depth, P.rng);
  let uDir = b5_rnd2(&rng);
  let uLobe = b5_rnd(&rng);
  let uLayer = b5_rnd(&rng);
  let ul = b5_rnd2(&rng);
  let uSel = b5_rnd(&rng);
  let uRR = b5_rnd(&rng);
  let us = vec3f(uLobe, uDir);
  P.rng = rng;

  // path regularization (biased, f.regK > 0): after a rough vertex the next
  // one is at least regK × as rough — kills caustic fireflies through glossy chains
  let auxv = unpack2x16float(P.aux);
  if (f.regK > 0.0 && depth > 0u) {
    let rmin = f.regK * auxv.x;
    s.rough = max(s.rough, rmin);
    s.rough0 = max(s.rough0, rmin);
  }
  var aovDepth = auxv.y;
  if (depth == 0u) {
    aovDepth = h.t * dot(P.d, f.camFwd);
  }

  // emission (MIS against NEE)
  if (b5_max3(s.emission) > 0.0) {
    var w = 1.0;
    if (depth > 0u && (P.flags & B5_PF_DELTA) == 0u) {
      let pdfL = b5_light_pdf_hit(P.pp, P.pn, s, h);
      if (pdfL > 0.0) {
        w = b5_power_heuristic(P.pdf, pdfL);
      }
    }
    P.L += b5_clamp_ind(P.thr * s.emission * w, depth);
  }
  P.aux = pack2x16float(vec2f(auxv.x, aovDepth));
  if (s.kind == B5_KIND_UNLIT || depth >= f.maxDepth) {
    if (aov) {
      // emitters: white albedo (no demodulation of their radiance)
      b5_path_aov(&P, select(s.albedo, vec3f(1.0), s.kind == B5_KIND_UNLIT), s.ns, true);
    }
    b5_paths[p] = P;
    return out;
  }

  // BSDF frame: a shading normal facing away from the viewer falls back to ng
  var ns = s.ns;
  if (dot(ns, wo) <= 0.0) {
    ns = s.ng;
  }
  let nv = max(dot(ns, wo), 1e-6);
  let b = b5_bsdf_from_surface(s, ns, nv, uLayer);
  let pOff = b5_offset(s.p, s.ng);
  if (aov) {
    let delta = b5_bsdf_is_delta(b);
    b5_path_aov(&P, select(s.albedo, s.tint, delta), ns, !delta);
  }
  if (!b5_bsdf_is_delta(b)) {
    // regularization reference of the next vertex
    P.aux = pack2x16float(vec2f(select(s.rough, s.rough0, s.kind == B5_KIND_HULL && b.lobe != B5_LOBE_WATER), aovDepth));
  }

  // NEE: one light (tube or emissive triangle)
  if (!b5_bsdf_is_delta(b) && (f.tubeOn != 0u || f.lightMode != B5_LIGHTS_NONE)) {
    let ls = b5_sample_light(s.p, ns, coneW, P.coneS, uSel, ul);
    if (ls.pdf > 0.0 && dot(ls.wi, s.ng) > 0.0 && b5_max3(ls.Le) > 0.0) {
      let e = b5_bsdf_eval(b, wo, ls.wi);
      let cosS = dot(ns, ls.wi);
      if (e.w > 0.0 && cosS > 0.0) {
        let w = b5_power_heuristic(ls.pdf, e.w);
        let c = b5_clamp_ind(P.thr * e.xyz * ls.Le * (cosS * w / ls.pdf), depth);
        if (b5_max3(c) > 0.0 && b5_finite3(c)) {
          P.sL = c;
          out.wantShadow = true;
          let dl = ls.x - pOff;
          let dist = length(dl);
          out.shadow.o = pOff;
          out.shadow.tmin = 0.0;
          out.shadow.d = dl / dist;
          out.shadow.tmax = dist * (1.0 - f.shadowEps);
        }
      }
    }
  }

  // BSDF sample
  let bs = b5_bsdf_sample(b, wo, us);
  if (!bs.ok || !b5_finite3(bs.w)) {
    b5_paths[p] = P;
    return out;
  }
  var thr = P.thr * bs.w;
  var origin = pOff;
  if (bs.through) {
    // straight through thin glass: the previous scattering vertex stays the MIS reference
    origin = b5_offset(s.p, -s.ng);
  } else {
    if (!bs.delta && dot(bs.wi, s.ng) <= 0.0) {
      b5_paths[p] = P;
      return out;
    }
    P.pp = s.p;
    P.pn = ns;
    P.pdf = bs.pdf;
    P.flags = select(P.flags & ~B5_PF_DELTA, P.flags | B5_PF_DELTA, bs.delta);
  }

  // Russian roulette
  if (depth + 1u >= f.rrDepth) {
    let q = min(b5_max3(thr), B5_RR_MAX);
    if (uRR >= q) {
      b5_paths[p] = P;
      return out;
    }
    thr = thr / q;
  }
  if (!b5_finite3(thr)) {
    b5_paths[p] = P;
    return out;
  }

  P.o = origin;
  P.d = bs.wi;
  P.coneW = coneW;
  if (!bs.delta && us.x >= b.pSpec) {
    P.coneS = max(P.coneS, f.diffuseSpread);
  }
  P.thr = thr;
  P.depth = depth + 1u;
  b5_paths[p] = P;
  out.wantRay = true;
  out.ray.o = origin;
  out.ray.tmin = 0.0;
  out.ray.d = bs.wi;
  out.ray.tmax = B5_T_INFINITE;
  return out;
}

@compute @workgroup_size(B5_WG_SIZE)
fn b5_k_shade(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_index) lid: u32,
              @builtin(num_workgroups) nwg: vec3u) {
  if (lid == 0u) {
    atomicStore(&b5_wg_rays, 0u);
    atomicStore(&b5_wg_shadows, 0u);
  }
  workgroupBarrier();
  let j = b5_linear_id(gid, nwg, B5_WG_SIZE);
  var res: B5ShadeOut;
  res.p = B5_NO_INDEX;
  res.wantRay = false;
  res.wantShadow = false;
  if (j < atomicLoad(&b5_queues.ctl[B5_Q_COUNT])) {
    res = b5_shade_one(j);
  }
  var rSlot = 0u;
  var sSlot = 0u;
  if (res.wantRay) {
    rSlot = atomicAdd(&b5_wg_rays, 1u);
  }
  if (res.wantShadow) {
    sSlot = atomicAdd(&b5_wg_shadows, 1u);
  }
  workgroupBarrier();
  if (lid == 0u) {
    b5_wg_ray_base = atomicAdd(&b5_queues.ctl[B5_Q_NEXT], atomicLoad(&b5_wg_rays));
    b5_wg_shadow_base = atomicAdd(&b5_queues.ctl[B5_Q_SHADOW], atomicLoad(&b5_wg_shadows));
  }
  workgroupBarrier();
  let cap = b5_wave.capacity;
  if (res.wantRay) {
    let k = b5_wg_ray_base + rSlot;
    let parity = atomicLoad(&b5_queues.ctl[B5_Q_PARITY]);
    b5_rays[k] = res.ray;
    b5_queues.idx[(1u - parity) * cap + k] = res.p;
  }
  if (res.wantShadow) {
    let k = b5_wg_shadow_base + sSlot;
    b5_rays[cap + k] = res.shadow;
    b5_queues.idx[2u * cap + k] = res.p;
  }
}
