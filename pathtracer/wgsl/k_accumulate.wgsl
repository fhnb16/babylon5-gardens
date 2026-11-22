// ═══════════════════════════════════════════════════════════════════════════
// k_accumulate.wgsl — end of a wave: path i adds to its pixel (B5Path.pixel)
//   accum.rgb += L, accum.w += 1                      colour + sample count
//   half += luminance(L) for EVEN sample indices      convergence (k_tilestats)
//   aov[2p]   += (albedo, depth), aov[2p+1] += (world normal, 0)   (B5_F_AOV)
// A wave never holds two paths of the same pixel (waveSize ≤ pixels / active
// slots), so plain read-modify-write is race-free — no float atomics.
// Non-finite radiance is dropped (the sample still counts). Dead tile slots
// (pixel NO_INDEX) are skipped.
// group 1: frame, paths, accumulation, half buffer, AOV accumulation.
// ═══════════════════════════════════════════════════════════════════════════
//#include "common.wgsl"
//#include "pt_state.wgsl"

override B5_WG_SIZE: u32 = 64u;

@group(1) @binding(0) var<uniform> b5_wave: B5Frame;
@group(1) @binding(1) var<storage, read> b5_paths: array<B5Path>;
@group(1) @binding(2) var<storage, read_write> b5_accum: array<vec4f>;
@group(1) @binding(3) var<storage, read_write> b5_half: array<f32>;
@group(1) @binding(4) var<storage, read_write> b5_aov: array<vec4f>;

@compute @workgroup_size(B5_WG_SIZE)
fn b5_k_accumulate(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let i = b5_linear_id(gid, nwg, B5_WG_SIZE);
  if (i >= b5_wave.waveSize) {
    return;
  }
  let P = b5_paths[i];
  let pixel = P.pixel;
  if (pixel == B5_NO_INDEX) {
    return;
  }
  var L = P.L;
  if (!b5_finite3(L)) {
    L = vec3f(0.0);
  }
  b5_accum[pixel] += vec4f(L, 1.0);
  if ((P.sample & 1u) == 0u) {
    b5_half[pixel] += dot(L, vec3f(0.2126, 0.7152, 0.0722));
  }
  if ((b5_wave.flags & B5_F_AOV) != 0u) {
    let depth = unpack2x16float(P.aux).y;
    b5_aov[2u * pixel] += vec4f(unpack4x8unorm(P.alb).rgb, depth);
    if (P.nrm != 0u) {
      b5_aov[2u * pixel + 1u] += vec4f(b5_aov_oct_decode(unpack2x16snorm(P.nrm)), 0.0);
    }
  }
}
