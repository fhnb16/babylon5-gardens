// ═══════════════════════════════════════════════════════════════════════════
// k_resolve.wgsl — accumulation → output colour texture (rgba16float,
// AOV_FORMATS.color): mean radiance per pixel, alpha = 1; and the AOV
// textures from the AOV accumulation (k_accumulate): mean albedo (rgba8),
// view-space normal of the normalized normal sum (rgba16f), mean linear view
// depth (r32f). 8×8 tiles.
// group 1: frame, accumulation, output, AOV accumulation, albedo, normal, depth.
// ═══════════════════════════════════════════════════════════════════════════
//#include "common.wgsl"
//#include "pt_state.wgsl"

@group(1) @binding(0) var<uniform> b5_wave: B5Frame;
@group(1) @binding(1) var<storage, read> b5_accum: array<vec4f>;
@group(1) @binding(2) var b5_out: texture_storage_2d<rgba16float, write>;
@group(1) @binding(3) var<storage, read> b5_aov: array<vec4f>;
@group(1) @binding(4) var b5_aov_albedo: texture_storage_2d<rgba8unorm, write>;
@group(1) @binding(5) var b5_aov_normal: texture_storage_2d<rgba16float, write>;
@group(1) @binding(6) var b5_aov_depth: texture_storage_2d<r32float, write>;

@compute @workgroup_size(8, 8)
fn b5_k_resolve(@builtin(global_invocation_id) gid: vec3u) {
  let f = b5_wave;
  if (gid.x >= f.width || gid.y >= f.height) {
    return;
  }
  let p = gid.y * f.width + gid.x;
  let a = b5_accum[p];
  let inv = 1.0 / max(a.w, 1.0);
  // f16 max is 65504: clamp so a hot pixel does not become inf in the output
  let c = min(a.rgb * inv, vec3f(65000.0));
  textureStore(b5_out, gid.xy, vec4f(c, 1.0));
  let a0 = b5_aov[2u * p];
  let n = b5_aov[2u * p + 1u].xyz;
  let ln = length(n);
  var nv = vec3f(0.0);
  if (ln > 0.0) {
    let nw = n / ln;
    nv = vec3f(dot(nw, normalize(f.camRight)), dot(nw, normalize(f.camUp)), -dot(nw, f.camFwd));
  }
  textureStore(b5_aov_albedo, gid.xy, vec4f(a0.rgb * inv, 1.0));
  textureStore(b5_aov_normal, gid.xy, vec4f(nv, 1.0));
  textureStore(b5_aov_depth, gid.xy, vec4f(a0.a * inv, 0.0, 0.0, 0.0));
}
