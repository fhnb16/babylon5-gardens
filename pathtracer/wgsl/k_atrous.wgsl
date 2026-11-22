// ═══════════════════════════════════════════════════════════════════════════
// k_atrous.wgsl — SVGF-lite preview denoiser (PT-P4), no temporal part:
//   b5_k_atrous_prep   colour = accum.rgb / w, albedo = AOV mean (first
//                      non-delta vertex), demodulated illumination
//                      I = colour / max(albedo, albEps); luminance variance of
//                      the pixel MEAN from the half buffer: (A − B)² / 4,
//                      demodulated by lum(max(albedo, albEps))²
//   b5_k_atrous_pass   one à-trous level (5×5 B3-spline taps at ±2·step):
//                      w = h · max(0, n·n')^σn · exp(−|z − z'| / (σz·|∇z|·|Δ| + ε))
//                          · exp(−|l − l'| / (σl·√g3×3(var) + ε)),
//                      I' = Σ w I / Σ w, var' = Σ w² var / (Σ w)²
//   b5_k_atrous_final  colour = I × max(albedo, albEps) → rgba16float
// Edge-stopping guides come from the integrator's AOV accumulation (world
// normal sum, mean depth) — the same buffers the CPU mirror reads
// (pathtracer/denoise.ts atrousRef).
// group 0: params (dynamic offset per pass), accum, half, aov, src, dst, output.
// ═══════════════════════════════════════════════════════════════════════════

struct B5AtrousParams {
  width: u32,
  height: u32,
  stepPx: u32,     // tap spacing of this level (1, 2, 4, …)
  pad0: u32,
  sigmaN: f32,
  sigmaZ: f32,
  sigmaL: f32,
  albEps: f32,
}

@group(0) @binding(0) var<uniform> b5_ap: B5AtrousParams;
@group(0) @binding(1) var<storage, read> b5_accum: array<vec4f>;
@group(0) @binding(2) var<storage, read> b5_half: array<f32>;
@group(0) @binding(3) var<storage, read> b5_aov: array<vec4f>;
@group(0) @binding(4) var<storage, read> b5_src: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> b5_dst: array<vec4f>;
@group(0) @binding(6) var b5_out: texture_storage_2d<rgba16float, write>;

const B5_ATROUS_VAR_UNKNOWN: f32 = 1.0e6;

fn b5_lum(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

fn b5_at_albedo(p: u32) -> vec3f {
  let w = max(b5_accum[p].w, 1.0);
  return max(b5_aov[2u * p].rgb / w, vec3f(b5_ap.albEps));
}

fn b5_at_depth(p: u32) -> f32 {
  return b5_aov[2u * p].a / max(b5_accum[p].w, 1.0);
}

fn b5_at_normal(p: u32) -> vec3f {
  let n = b5_aov[2u * p + 1u].xyz;
  let l = length(n);
  return select(vec3f(0.0), n / l, l > 0.0);
}

@compute @workgroup_size(8, 8)
fn b5_k_atrous_prep(@builtin(global_invocation_id) gid: vec3u) {
  let P = b5_ap;
  if (gid.x >= P.width || gid.y >= P.height) {
    return;
  }
  let p = gid.y * P.width + gid.x;
  let a = b5_accum[p];
  let w = a.w;
  let alb = b5_at_albedo(p);
  let c = a.rgb / max(w, 1.0);
  var v = B5_ATROUS_VAR_UNKNOWN;
  if (w >= 2.0) {
    let nA = ceil(w * 0.5);
    let A = b5_half[p] / nA;
    let B = (b5_lum(a.rgb) - b5_half[p]) / (w - nA);
    let la = b5_lum(alb);
    v = (A - B) * (A - B) * 0.25 / (la * la);
  }
  b5_dst[p] = vec4f(c / alb, v);
}

fn b5_at_h(i: i32) -> f32 {
  let k = abs(i);
  return select(select(0.0625, 0.25, k == 1), 0.375, k == 0);
}

@compute @workgroup_size(8, 8)
fn b5_k_atrous_pass(@builtin(global_invocation_id) gid: vec3u) {
  let P = b5_ap;
  if (gid.x >= P.width || gid.y >= P.height) {
    return;
  }
  let W = i32(P.width);
  let H = i32(P.height);
  let x = i32(gid.x);
  let y = i32(gid.y);
  let p = gid.y * P.width + gid.x;
  let cp = b5_src[p];
  let lp = b5_lum(cp.rgb);
  let np = b5_at_normal(p);
  let zp = b5_at_depth(p);
  // depth gradient (pixels) and 3×3 Gaussian of the variance at the centre
  let px1 = u32(y) * P.width + u32(min(x + 1, W - 1));
  let py1 = u32(min(y + 1, H - 1)) * P.width + u32(x);
  let dz = max(abs(b5_at_depth(px1) - zp), abs(b5_at_depth(py1) - zp));
  var gv = 0.0;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let q = u32(clamp(y + j, 0, H - 1)) * P.width + u32(clamp(x + i, 0, W - 1));
      let k = select(0.25, 0.125, abs(i) + abs(j) == 1);
      gv += select(k, 0.0625, abs(i) + abs(j) == 2) * b5_src[q].a;
    }
  }
  let lden = P.sigmaL * sqrt(max(gv, 0.0)) + 1e-6;
  let s = i32(P.stepPx);
  var sum = vec3f(0.0);
  var sumW = 0.0;
  var sumV = 0.0;
  for (var j = -2; j <= 2; j++) {
    for (var i = -2; i <= 2; i++) {
      let qx = x + i * s;
      let qy = y + j * s;
      if (qx < 0 || qy < 0 || qx >= W || qy >= H) {
        continue;
      }
      let q = u32(qy) * P.width + u32(qx);
      let cq = b5_src[q];
      var w = b5_at_h(i) * b5_at_h(j);
      if (i != 0 || j != 0) {
        let nq = b5_at_normal(q);
        if (dot(np, np) > 0.0 && dot(nq, nq) > 0.0) {
          w *= pow(max(0.0, dot(np, nq)), P.sigmaN);
        }
        let dist = length(vec2f(f32(i * s), f32(j * s)));
        let zden = P.sigmaZ * max(dz * dist, 1e-3 * abs(zp)) + 1e-6;
        w *= exp(-abs(zp - b5_at_depth(q)) / zden);
        w *= exp(-abs(lp - b5_lum(cq.rgb)) / lden);
      }
      sum += w * cq.rgb;
      sumV += w * w * cq.a;
      sumW += w;
    }
  }
  b5_dst[p] = vec4f(sum / sumW, sumV / (sumW * sumW));
}

@compute @workgroup_size(8, 8)
fn b5_k_atrous_final(@builtin(global_invocation_id) gid: vec3u) {
  let P = b5_ap;
  if (gid.x >= P.width || gid.y >= P.height) {
    return;
  }
  let p = gid.y * P.width + gid.x;
  let c = min(b5_src[p].rgb * b5_at_albedo(p), vec3f(65000.0));
  textureStore(b5_out, gid.xy, vec4f(max(c, vec3f(0.0)), 1.0));
}
