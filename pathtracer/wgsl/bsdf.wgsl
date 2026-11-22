// ═══════════════════════════════════════════════════════════════════════════
// bsdf.wgsl — lobe dispatch: evaluation (f, mixture pdf) and sampling.
// Delta lobes (glass) evaluate to 0: they are never hit by NEE.
// Requires bsdf_std.wgsl, bsdf_glass.wgsl, bsdf_water.wgsl.
// ═══════════════════════════════════════════════════════════════════════════

fn b5_bsdf_eval(b: B5Bsdf, wo: vec3f, wi: vec3f) -> vec4f {
  if (b.lobe == B5_LOBE_WATER) {
    return b5_water_eval(b, wo, wi);
  }
  if (b.lobe == B5_LOBE_GLASS) {
    return vec4f(0.0);
  }
  return b5_std_eval(b, wo, wi);
}

fn b5_bsdf_is_delta(b: B5Bsdf) -> bool {
  return b.lobe == B5_LOBE_GLASS;
}

// u.x: lobe choice, u.yz: direction
fn b5_bsdf_sample(b: B5Bsdf, wo: vec3f, u: vec3f) -> B5BsdfSample {
  if (b.lobe == B5_LOBE_GLASS) {
    return b5_glass_sample(b, wo, u);
  }
  var s: B5BsdfSample;
  s.delta = false;
  s.through = false;
  s.ok = false;
  s.wi = b5_mix_direction(b, wo, u);
  let e = b5_bsdf_eval(b, wo, s.wi);
  let c = dot(b.n, s.wi);
  s.pdf = e.w;
  if (e.w > 0.0 && c > 0.0) {
    s.w = e.xyz * (c / e.w);
    s.ok = true;
  } else {
    s.w = vec3f(0.0);
  }
  return s;
}
