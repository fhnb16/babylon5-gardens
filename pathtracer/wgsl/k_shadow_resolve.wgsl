// ═══════════════════════════════════════════════════════════════════════════
// k_shadow_resolve.wgsl — after k_shadow_tr: every unoccluded shadow ray adds
// its path's pending NEE contribution (B5Path.sL) × the glass transmittance
// (pack4x8unorm rgb; 0 = occluded) to the path radiance.
// At most one shadow ray per path per bounce, so no atomics on paths.
// group 1: frame, paths, queues, occlusion / transmittance words.
// ═══════════════════════════════════════════════════════════════════════════
//#include "common.wgsl"
//#include "pt_state.wgsl"

override B5_WG_SIZE: u32 = 64u;

@group(1) @binding(0) var<uniform> b5_wave: B5Frame;
@group(1) @binding(1) var<storage, read_write> b5_paths: array<B5Path>;
@group(1) @binding(2) var<storage, read_write> b5_queues: B5Queues;
@group(1) @binding(3) var<storage, read> b5_occluded: array<u32>;

@compute @workgroup_size(B5_WG_SIZE)
fn b5_k_shadow_resolve(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let j = b5_linear_id(gid, nwg, B5_WG_SIZE);
  if (j >= atomicLoad(&b5_queues.ctl[B5_Q_SHADOW_LIVE])) {
    return;
  }
  let o = b5_occluded[j];
  if (o == 0u) {
    return;
  }
  let p = b5_queues.idx[2u * b5_wave.capacity + j];
  b5_paths[p].L += b5_paths[p].sL * unpack4x8unorm(o).rgb;
}
