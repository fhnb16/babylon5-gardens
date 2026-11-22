// ═══════════════════════════════════════════════════════════════════════════
// bsdf_std.wgsl — common BSDF record + the MeshStandardMaterial-like lobe
// (pure functions). CPU mirror: pathtracer/bsdf-ref.ts.
//   f = cd · (1 − F(n·v)) / π                     (cd = albedo · (1 − metal))
//     + F(v·h) · D(h) · G2(v, l) / (4 n·l n·v)    (GGX, height-correlated Smith)
//   F = Schlick, F0 = mix(0.04, albedo, metal); alpha = max(rough², minAlpha)
//   (three r187: min roughness 0.045). The (1 − F(n·v)) diffuse weight keeps
//   the white furnace ≤ 1 (energy test: pathtracer/test/bsdf.test.ts).
//   Sampling: one-sample mixture of VNDF (Heitz 2018) and cosine lobes,
//   specular probability from the Fresnel luminance at n·v (clamped), the
//   pdf is the mixture pdf (MIS-ready).
// Lobes: B5_LOBE_STD (this file), B5_LOBE_GLASS (bsdf_glass.wgsl),
//        B5_LOBE_WATER (bsdf_water.wgsl); dispatch in bsdf.wgsl.
// Requires sampling.wgsl.
// ═══════════════════════════════════════════════════════════════════════════

const B5_LOBE_STD: u32 = 0u;
const B5_LOBE_GLASS: u32 = 1u;
const B5_LOBE_WATER: u32 = 2u;
const B5_F0_DIELECTRIC: f32 = 0.04;
const B5_SPEC_PROB_MIN: f32 = 0.1;
const B5_SPEC_PROB_MAX: f32 = 0.9;

struct B5Bsdf {
  n: vec3f,        // shading normal (on the side of wo)
  lobe: u32,
  cd: vec3f,       // std: diffuse colour; water: bed colour
  a: f32,          // GGX alpha
  f0: vec3f,       // std: Schlick F0
  pSpec: f32,      // probability of the specular sample
  tint: vec3f,     // glass: transmission tint; water: waterTint
  eta: f32,        // glass / water IOR
  depth: f32,      // water: optical depth at normal incidence (both ways)
  fBoost: f32,     // water: Fresnel multiplier
  pad0: f32,
  pad1: f32,
}

struct B5BsdfSample {
  wi: vec3f,
  pdf: f32,        // solid-angle pdf (0 for delta events)
  w: vec3f,        // throughput weight f·cos/pdf (delta: the event weight)
  delta: bool,     // delta event (no MIS, emission weight 1)
  through: bool,      // straight transmission (thin glass): keep the previous vertex for MIS
  ok: bool,
}

// Smith Λ for GGX
fn b5_ggx_lambda(c: f32, a: f32) -> f32 {
  let c2 = max(c * c, 1e-12);
  return 0.5 * (-1.0 + sqrt(1.0 + a * a * (1.0 - c2) / c2));
}

// height-correlated masking-shadowing
fn b5_ggx_g2(nv: f32, nl: f32, a: f32) -> f32 {
  return 1.0 / (1.0 + b5_ggx_lambda(nv, a) + b5_ggx_lambda(nl, a));
}

fn b5_ggx_g1l(nv: f32, a: f32) -> f32 {
  return 1.0 / (1.0 + b5_ggx_lambda(nv, a));
}

// unpolarised Fresnel reflectance of a dielectric interface (outside → eta), |cos| given
fn b5_fresnel_dielectric(cosI: f32, eta: f32) -> f32 {
  let c = clamp(cosI, 0.0, 1.0);
  let s2 = 1.0 - c * c;
  let t2 = 1.0 - s2 / (eta * eta);
  if (t2 <= 0.0) {
    return 1.0;
  }
  let ct = sqrt(t2);
  let rs = (c - eta * ct) / (c + eta * ct);
  let rp = (eta * c - ct) / (eta * c + ct);
  return 0.5 * (rs * rs + rp * rp);
}

fn b5_std_make(n: vec3f, albedo: vec3f, metal: f32, rough: f32, minAlpha: f32, nv: f32) -> B5Bsdf {
  var b: B5Bsdf;
  b.n = n;
  b.lobe = B5_LOBE_STD;
  b.cd = albedo * (1.0 - metal);
  b.f0 = mix(vec3f(B5_F0_DIELECTRIC), albedo, metal);
  b.a = max(rough * rough, minAlpha);
  let ws = b5_luminance(b5_schlick(b.f0, nv));
  let wd = b5_luminance(b.cd * (vec3f(1.0) - b5_schlick(b.f0, nv)));
  b.pSpec = select(1.0, clamp(ws / (ws + wd), B5_SPEC_PROB_MIN, B5_SPEC_PROB_MAX), wd > 0.0);
  b.tint = vec3f(1.0);
  b.eta = 1.5;
  b.depth = 0.0;
  b.fBoost = 1.0;
  return b;
}

// specular GGX part: f (rgb, F applied by `fres`) and its VNDF pdf; returns (D·G2/(4 nl nv), G1v·D/(4 nv))
fn b5_ggx_terms(n: vec3f, wo: vec3f, wi: vec3f, a: f32) -> vec3f {
  let nl = dot(n, wi);
  let nv = dot(n, wo);
  let h = normalize(wo + wi);
  let nh = max(dot(n, h), 0.0);
  let D = b5_ggx_d(nh, a);
  let G = b5_ggx_g2(nv, nl, a);
  let g1v = b5_ggx_g1l(nv, a);
  return vec3f(D * G / (4.0 * nl * nv), g1v * D / (4.0 * nv), max(dot(wo, h), 0.0));
}

fn b5_std_eval(b: B5Bsdf, wo: vec3f, wi: vec3f) -> vec4f {
  let nl = dot(b.n, wi);
  let nv = dot(b.n, wo);
  if (nl <= 0.0 || nv <= 0.0) {
    return vec4f(0.0);
  }
  // pSpec = 0: pure Lambert (furnace / B5_SPECULAR = false), no Fresnel weight
  let kd = select(vec3f(1.0), vec3f(1.0) - b5_schlick(b.f0, nv), b.pSpec > 0.0);
  var f = b.cd * kd * (1.0 / B5_PI);
  var pdf = (1.0 - b.pSpec) * nl * (1.0 / B5_PI);
  if (b.pSpec > 0.0) {
    let t = b5_ggx_terms(b.n, wo, wi, b.a);
    f += b5_schlick(b.f0, t.z) * t.x;
    pdf += b.pSpec * t.y;
  }
  return vec4f(f, pdf);
}

// reflection-side mixture sampling shared by std and water: u.x lobe, u.yz direction
fn b5_mix_direction(b: B5Bsdf, wo: vec3f, u: vec3f) -> vec3f {
  let onb = b5_onb(b.n);
  if (u.x < b.pSpec) {
    let woL = transpose(onb) * wo;
    let hL = b5_ggx_vndf_local(woL, b.a, u.yz);
    return onb * reflect(-woL, hL);
  }
  return onb * b5_cosine_local(u.yz);
}
