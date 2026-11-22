// ═══════════════════════════════════════════════════════════════════════════
// bsdf_glass.wgsl — thin dielectric sheet (glazing of lift cabins / tower),
// smooth, both events delta. CPU mirror: pathtracer/bsdf-ref.ts.
//   R = Fresnel(|cos|, ior); a thin slab with all internal bounces reflects
//   R' = 2R / (1 + R) and transmits 1 − R' (= (1 − R)/(1 + R));
//   transmission is STRAIGHT (no offset — the sheet is thin) and tinted.
//   Sampling: reflect with probability R' (weight 1), else transmit
//   (weight = tint). Shadow rays through glazing multiply
//   b5_glass_transmittance (k_shadow_tr.wgsl) instead of being occluded, so
//   transmitted paths keep the previous vertex for MIS ("through").
// Requires bsdf_std.wgsl.
// ═══════════════════════════════════════════════════════════════════════════

fn b5_glass_make(n: vec3f, tint: vec3f, ior: f32) -> B5Bsdf {
  var b: B5Bsdf;
  b.n = n;
  b.lobe = B5_LOBE_GLASS;
  b.cd = vec3f(0.0);
  b.a = 0.0;
  b.f0 = vec3f(0.0);
  b.pSpec = 0.0;
  b.tint = tint;
  b.eta = ior;
  b.depth = 0.0;
  b.fBoost = 1.0;
  return b;
}

fn b5_glass_reflectance(cosI: f32, ior: f32) -> f32 {
  let r = b5_fresnel_dielectric(max(abs(cosI), B5_GLASS_MIN_COS), ior);
  return 2.0 * r / (1.0 + r);
}

fn b5_glass_transmittance(tint: vec3f, cosI: f32, ior: f32) -> vec3f {
  return tint * (1.0 - b5_glass_reflectance(cosI, ior));
}

fn b5_glass_sample(b: B5Bsdf, wo: vec3f, u: vec3f) -> B5BsdfSample {
  var s: B5BsdfSample;
  s.pdf = 0.0;
  s.delta = true;
  s.ok = true;
  let rp = b5_glass_reflectance(dot(b.n, wo), b.eta);
  if (u.x < rp) {
    s.wi = reflect(-wo, b.n);
    s.w = vec3f(1.0);
    s.through = false;
  } else {
    s.wi = -wo;
    s.w = b.tint;
    s.through = true;
  }
  return s;
}
