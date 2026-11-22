// ═══════════════════════════════════════════════════════════════════════════
// bsdf_water.wgsl — water surface over a Lambertian bed (hull kind with a
// water weight). CPU mirror: pathtracer/bsdf-ref.ts.
//   top interface: dielectric, IOR B5_WATER_IOR, GGX with the hull kernel's
//     wet roughness and the ripple shading normal (b5_surface ns);
//     F = min(1, Fresnel(v·h) · B5_WATER_F0_BOOST);
//   below: the light refracts in, crosses the water column to the bed and
//     back, Beer–Lambert toward the water colour:
//       Tr = exp(−τ · (1/cosT_o + 1/cosT_i) / 2),  τ = absorbK · water
//       ρ  = bed · Tr + waterTint · (1 − Tr)     (normal incidence: the
//            raster's mix(bed, waterTint, 1 − exp(−absorbK · water)))
//     and leaves as a diffuse lobe weighted by both interface transmissions:
//       f_d = (1 − F(n·v)) (1 − F(n·l)) ρ / π     (reciprocal, ≤ 1 in total)
//   Foam and the dry / wet blend are chosen stochastically in k_shade
//   (b5_bsdf_from_surface) — this lobe is the wet part only.
// Requires bsdf_std.wgsl, pt_config.gen.wgsl.
// ═══════════════════════════════════════════════════════════════════════════

fn b5_water_f(c: f32, eta: f32, boost: f32) -> f32 {
  return min(1.0, b5_fresnel_dielectric(c, eta) * boost);
}

fn b5_water_cos_t(c: f32, eta: f32) -> f32 {
  return sqrt(max(1e-6, 1.0 - (1.0 - c * c) / (eta * eta)));
}

fn b5_water_rho(b: B5Bsdf, nv: f32, nl: f32) -> vec3f {
  let tr = exp(-b.depth * 0.5 * (1.0 / b5_water_cos_t(nv, b.eta) + 1.0 / b5_water_cos_t(nl, b.eta)));
  return b.cd * tr + b.tint * (1.0 - tr);
}

fn b5_water_make(n: vec3f, bed: vec3f, waterTint: vec3f, rough: f32, depth: f32, minAlpha: f32, nv: f32) -> B5Bsdf {
  var b: B5Bsdf;
  b.n = n;
  b.lobe = B5_LOBE_WATER;
  b.cd = bed;
  b.a = max(rough * rough, minAlpha);
  b.f0 = vec3f(0.0);
  b.tint = waterTint;
  b.eta = B5_WATER_IOR;
  b.depth = depth;
  b.fBoost = B5_WATER_F0_BOOST;
  let fo = b5_water_f(nv, b.eta, b.fBoost);
  let wd = (1.0 - fo) * b5_luminance(b5_water_rho(b, nv, nv));
  b.pSpec = select(1.0, clamp(fo / (fo + wd), B5_SPEC_PROB_MIN, B5_SPEC_PROB_MAX), wd > 0.0);
  return b;
}

fn b5_water_eval(b: B5Bsdf, wo: vec3f, wi: vec3f) -> vec4f {
  let nl = dot(b.n, wi);
  let nv = dot(b.n, wo);
  if (nl <= 0.0 || nv <= 0.0) {
    return vec4f(0.0);
  }
  let fo = b5_water_f(nv, b.eta, b.fBoost);
  let fi = b5_water_f(nl, b.eta, b.fBoost);
  var f = (1.0 - fo) * (1.0 - fi) * b5_water_rho(b, nv, nl) * (1.0 / B5_PI);
  var pdf = (1.0 - b.pSpec) * nl * (1.0 / B5_PI);
  if (b.pSpec > 0.0) {
    let t = b5_ggx_terms(b.n, wo, wi, b.a);
    f += vec3f(b5_water_f(t.z, b.eta, b.fBoost) * t.x);
    pdf += b.pSpec * t.y;
  }
  return vec4f(f, pdf);
}
