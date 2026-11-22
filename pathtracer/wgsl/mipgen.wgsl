// ═══════════════════════════════════════════════════════════════════════════
// mipgen.wgsl — one mip level of a texture_2d_array: 2×2 box filter.
// Source = level l−1 (rgba8unorm view, textureLoad), destination = level l
// (rgba8unorm storage view). B5_MIP_SRGB = 1: the texels hold sRGB-encoded
// colour (the texture is sampled through an rgba8unorm-srgb view), so rgb is
// decoded to linear, averaged and re-encoded; alpha is always linear.
// CPU mirror: pathtracer/textures.ts mipChainCpu(). Standalone module (no
// loader prelude needed). Dispatch: (ceil(w/8), ceil(h/8), layers).
// ═══════════════════════════════════════════════════════════════════════════

override B5_MIP_SRGB: u32 = 0u;

@group(0) @binding(0) var b5_mip_src: texture_2d_array<f32>;
@group(0) @binding(1) var b5_mip_dst: texture_storage_2d_array<rgba8unorm, write>;

fn b5_mip_to_linear(c: vec3f) -> vec3f {
  return select(pow((c + vec3f(0.055)) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045));
}

fn b5_mip_to_srgb(c: vec3f) -> vec3f {
  return select(1.055 * pow(c, vec3f(1.0 / 2.4)) - vec3f(0.055), c * 12.92, c <= vec3f(0.0031308));
}

fn b5_mip_load(p: vec2i, layer: i32) -> vec4f {
  let t = textureLoad(b5_mip_src, p, layer, 0);
  if (B5_MIP_SRGB != 0u) {
    return vec4f(b5_mip_to_linear(t.rgb), t.a);
  }
  return t;
}

@compute @workgroup_size(8, 8, 1)
fn b5_k_mipgen(@builtin(global_invocation_id) gid: vec3u) {
  let dim = textureDimensions(b5_mip_dst);
  if (gid.x >= dim.x || gid.y >= dim.y) {
    return;
  }
  let layer = i32(gid.z);
  let p = vec2i(gid.xy) * 2;
  let s = (b5_mip_load(p, layer) + b5_mip_load(p + vec2i(1, 0), layer) +
           b5_mip_load(p + vec2i(0, 1), layer) + b5_mip_load(p + vec2i(1, 1), layer)) * 0.25;
  var o = s;
  if (B5_MIP_SRGB != 0u) {
    o = vec4f(b5_mip_to_srgb(s.rgb), s.a);
  }
  textureStore(b5_mip_dst, vec2u(gid.xy), gid.z, clamp(o, vec4f(0.0), vec4f(1.0)));
}
