// ═══════════════════════════════════════════════════════════════════════════
// k_hitviz.wgsl — smoke-test debug image: camera-grid hit records → colour
// (hash colour per instance, the hull is green with triangle edges, distance
// shading, back faces tinted red, misses dark blue). Writes rgba16float
// (AOV_FORMATS.color), presented by three-interop.ts createPresenter().
// ═══════════════════════════════════════════════════════════════════════════
//#include "common.wgsl"

struct B5VizParams {
  width: u32,
  height: u32,
  pad0: u32,
  pad1: u32,
}

@group(0) @binding(0) var<uniform> b5_viz: B5VizParams;
@group(0) @binding(1) var<storage, read> b5_hits: array<B5HitRec>;
@group(0) @binding(2) var b5_out: texture_storage_2d<rgba16float, write>;

fn b5_hash_color(x: u32) -> vec3f {
  let h = b5_pcg(x * 2654435761u + 1u);
  return vec3f(f32(h & 255u), f32((h >> 8u) & 255u), f32((h >> 16u) & 255u)) / 255.0 * 0.8 + 0.2;
}

@compute @workgroup_size(8, 8)
fn b5_k_hitviz(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= b5_viz.width || gid.y >= b5_viz.height) {
    return;
  }
  let h = b5_hits[gid.y * b5_viz.width + gid.x];
  var c = vec3f(0.02, 0.03, 0.08);
  if (h.tri != B5_NO_INDEX) {
    var base = b5_hash_color(h.inst);
    if (h.inst == 0u) {
      // hull: green with darker triangle edges (barycentric wireframe)
      let e = min(min(h.u, h.v), 1.0 - h.u - h.v);
      base = select(vec3f(0.45, 0.65, 0.4), vec3f(0.2, 0.3, 0.18), e < 0.04);
    }
    if ((h.flags & B5_HIT_FRONT) == 0u) {
      base = base * vec3f(1.0, 0.45, 0.45);
    }
    c = base * (1.6 / (1.0 + h.t * 0.008));
  }
  textureStore(b5_out, gid.xy, vec4f(c, 1.0));
}
