// ═══════════════════════════════════════════════════════════════════════════
// light_tube.wgsl — axis tube emitter sampling (pure functions). CPU mirror:
// pathtracer/lights/tube.ts (formulas and derivation there).
//   • visible band from P: |Δφ| < acos(r/ρ), all z ∈ [z0, z0 + len];
//   • φ uniform in the projected width sin Δφ: pdf_φ = cos Δφ / (2 sin φmax);
//   • z equiangular about P at h = sqrt(ρ² − r²):
//       pdf_z = h / ((θ1 − θ0)(h² + (z − P.z)²));
//   • area pdf = pdf_z · pdf_φ / r, solid angle = area pdf · d² / cos θ_l.
//   b5_tube_sample / b5_tube_pdf (MIS of BSDF hits) / b5_tube_sample_uniform
//   (M1 uniform-area strategy, kept for comparisons) / b5_tube_importance
//   (light selection).
// Requires pt_config.gen.wgsl (B5_TUBE_INSIDE_EPS), common.wgsl (B5_PI).
// ═══════════════════════════════════════════════════════════════════════════

struct B5TubeSample {
  x: vec3f,      // point on the tube
  pdfW: f32,     // solid-angle pdf, 0 = no sample
  wi: vec3f,     // unit direction P → x
  d2: f32,       // squared distance
  n: vec3f,      // outward normal at x
  cosL: f32,     // cos(n, −wi)
}

struct B5TubeF {
  e: vec2f,
  rho: f32,
  sinMax: f32,
  h: f32,
  th0: f32,
  th1: f32,
  ok: bool,
}

fn b5_tube_frame(P: vec3f, r: f32, z0: f32, len: f32) -> B5TubeF {
  var f: B5TubeF;
  f.ok = false;
  let rho = length(P.xy);
  if (!(rho > r * (1.0 + B5_TUBE_INSIDE_EPS))) {
    return f;
  }
  let q = r / rho;
  f.rho = rho;
  f.e = P.xy / rho;
  f.sinMax = sqrt(max(0.0, 1.0 - q * q));
  f.h = sqrt(max(rho * rho - r * r, 0.0));
  f.th0 = atan((z0 - P.z) / f.h);
  f.th1 = atan((z0 + len - P.z) / f.h);
  f.ok = f.th1 > f.th0 && f.sinMax > 0.0;
  return f;
}

fn b5_tube_pdfz(f: B5TubeF, dz: f32) -> f32 {
  return f.h / ((f.th1 - f.th0) * (f.h * f.h + dz * dz));
}

fn b5_tube_finish(P: vec3f, x: vec3f, n2: vec2f, pdfA: f32) -> B5TubeSample {
  var o: B5TubeSample;
  let w = x - P;
  let d2 = dot(w, w);
  let wi = w * inverseSqrt(d2);
  o.x = x;
  o.wi = wi;
  o.d2 = d2;
  o.n = vec3f(n2, 0.0);
  o.cosL = -dot(n2, wi.xy);
  o.pdfW = select(0.0, pdfA * d2 / o.cosL, o.cosL > 0.0 && pdfA > 0.0);
  return o;
}

// equiangular z × projected-width φ over the visible band
fn b5_tube_sample(P: vec3f, r: f32, z0: f32, len: f32, u: vec2f) -> B5TubeSample {
  let f = b5_tube_frame(P, r, z0, len);
  if (!f.ok) {
    var o: B5TubeSample;
    o.pdfW = 0.0;
    return o;
  }
  let s = (2.0 * u.x - 1.0) * f.sinMax;
  let c = sqrt(max(0.0, 1.0 - s * s));
  let n2 = vec2f(f.e.x * c - f.e.y * s, f.e.y * c + f.e.x * s);
  let th = f.th0 + u.y * (f.th1 - f.th0);
  let z = P.z + f.h * tan(th);
  let pdfA = b5_tube_pdfz(f, z - P.z) * c / (2.0 * f.sinMax) / r;
  return b5_tube_finish(P, vec3f(n2 * r, z), n2, pdfA);
}

// solid-angle pdf of b5_tube_sample for the point x on the tube (0 outside the visible band)
fn b5_tube_pdf(P: vec3f, x: vec3f, r: f32, z0: f32, len: f32) -> f32 {
  let f = b5_tube_frame(P, r, z0, len);
  if (!f.ok || x.z < z0 || x.z > z0 + len) {
    return 0.0;
  }
  let l = max(length(x.xy), 1e-30);
  let c = dot(x.xy, f.e) / l;
  if (!(f.rho * c > r)) {
    return 0.0;
  }
  let pdfA = b5_tube_pdfz(f, x.z - P.z) * c / (2.0 * f.sinMax) / r;
  let w = x - P;
  let d2 = dot(w, w);
  let cosL = -dot(x.xy / l, w.xy) * inverseSqrt(d2);
  return select(0.0, pdfA * d2 / cosL, cosL > 0.0);
}

// M1 strategy: uniform over the whole lateral area
fn b5_tube_sample_uniform(P: vec3f, r: f32, z0: f32, len: f32, u: vec2f) -> B5TubeSample {
  let phi = 2.0 * B5_PI * u.x;
  let n2 = vec2f(cos(phi), sin(phi));
  return b5_tube_finish(P, vec3f(n2 * r, z0 + len * u.y), n2, 1.0 / (2.0 * B5_PI * r * len));
}

fn b5_tube_pdf_uniform(P: vec3f, x: vec3f, r: f32, len: f32) -> f32 {
  let l = max(length(x.xy), 1e-30);
  let w = x - P;
  let d2 = dot(w, w);
  let cosL = -dot(x.xy / l, w.xy) * inverseSqrt(d2);
  return select(0.0, d2 / (cosL * 2.0 * B5_PI * r * len), cosL > 0.0);
}

// irradiance-like importance: luminance × solid angle of a 2r strip along the axis
fn b5_tube_importance(P: vec3f, r: f32, z0: f32, len: f32, lum: f32) -> f32 {
  let rho = length(P.xy);
  if (!(rho > r * (1.0 + B5_TUBE_INSIDE_EPS))) {
    return 0.0;
  }
  let a = z0 - P.z;
  let b = z0 + len - P.z;
  let om = (2.0 * r / rho) * (b / sqrt(rho * rho + b * b) - a / sqrt(rho * rho + a * a));
  return lum * max(om, 0.0);
}
