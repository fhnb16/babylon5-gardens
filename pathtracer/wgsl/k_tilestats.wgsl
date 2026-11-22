// ═══════════════════════════════════════════════════════════════════════════
// k_tilestats.wgsl — convergence statistics per 16×16 tile (PT-P4), one
// 8×8 workgroup per tile, 2×2 pixels per invocation. CPU mirror:
// pathtracer/convergence.ts (pixelError / tileStatsRef).
//
// Half buffer: k_accumulate adds the luminance of every EVEN sample (sample
// index 0, 2, 4, …) to half[pixel]. With w samples, A = mean of the
// ⌈w/2⌉ even samples, B = mean of the ⌊w/2⌋ odd ones (from the full sum):
// two independent estimates. Per pixel, in display space a = T(A·exposure),
// b = T(B·exposure), T(x) = x / (1 + x) (tonemap weighting: blown-out
// highlights do not hold back convergence):
//     e = |a − b| / (a + b + ε) · √(π/2)
// E|A − B| = √(2/π) · 2σ/√w and a + b ≈ 2μ, so e estimates the RELATIVE
// standard error of the pixel mean (the legacy "noise %" = 100/√spp of a
// unit-contrast estimator). Tile error = mean e over the tile's pixels with
// w ≥ 2 (one |A − B| is a 1-dof estimate; the tile average is stable).
// Output per tile: vec4f(error, minW, maxW, valid pixel count);
// error = B5_TILE_UNKNOWN when no pixel has 2 samples yet.
// group 1: frame (width, height, tilesX, toneExp, convEps), accum, half, tiles.
// ═══════════════════════════════════════════════════════════════════════════
//#include "common.wgsl"
//#include "pt_state.wgsl"

const B5_TILE_UNKNOWN: f32 = 1.0e9;
const B5_TILE_W_MAX: f32 = 3.0e38;
// √(π/2): E|N(0, 1)| → σ
const B5_MEAN_ABS_TO_RMS: f32 = 1.2533141;

@group(1) @binding(0) var<uniform> b5_wave: B5Frame;
@group(1) @binding(1) var<storage, read> b5_accum: array<vec4f>;
@group(1) @binding(2) var<storage, read> b5_half: array<f32>;
@group(1) @binding(3) var<storage, read_write> b5_tiles: array<vec4f>;

var<workgroup> b5_wg_stats: array<vec4f, 64>;

fn b5_tonemap_l(x: f32) -> f32 {
  return x / (1.0 + x);
}

// (error, valid) of one pixel
fn b5_pixel_error(acc: vec4f, half: f32, exposure: f32, eps: f32) -> vec2f {
  let w = acc.w;
  if (w < 2.0) {
    return vec2f(0.0, 0.0);
  }
  let nA = ceil(w * 0.5);
  let nB = w - nA;
  let lum = dot(acc.rgb, vec3f(0.2126, 0.7152, 0.0722));
  let A = max(half / nA, 0.0);
  let B = max((lum - half) / nB, 0.0);
  let a = b5_tonemap_l(A * exposure);
  let b = b5_tonemap_l(B * exposure);
  return vec2f(abs(a - b) / (a + b + eps) * B5_MEAN_ABS_TO_RMS, 1.0);
}

@compute @workgroup_size(8, 8)
fn b5_k_tilestats(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_id) lid: vec3u,
                  @builtin(local_invocation_index) li: u32) {
  let f = b5_wave;
  // (error sum, valid count, min w, max w)
  var s = vec4f(0.0, 0.0, B5_TILE_W_MAX, 0.0);
  for (var k = 0u; k < 4u; k++) {
    let x = wid.x * 16u + lid.x * 2u + (k & 1u);
    let y = wid.y * 16u + lid.y * 2u + (k >> 1u);
    if (x < f.width && y < f.height) {
      let p = y * f.width + x;
      let acc = b5_accum[p];
      let e = b5_pixel_error(acc, b5_half[p], f.toneExp, f.convEps);
      s = vec4f(s.x + e.x, s.y + e.y, min(s.z, acc.w), max(s.w, acc.w));
    }
  }
  b5_wg_stats[li] = s;
  workgroupBarrier();
  for (var n = 32u; n > 0u; n >>= 1u) {
    if (li < n) {
      let o = b5_wg_stats[li + n];
      let m = b5_wg_stats[li];
      b5_wg_stats[li] = vec4f(m.x + o.x, m.y + o.y, min(m.z, o.z), max(m.w, o.w));
    }
    workgroupBarrier();
  }
  if (li == 0u) {
    let t = b5_wg_stats[0];
    let err = select(B5_TILE_UNKNOWN, t.x / max(t.y, 1.0), t.y > 0.0);
    b5_tiles[wid.y * f.tilesX + wid.x] = vec4f(err, t.z, t.w, t.y);
  }
}
