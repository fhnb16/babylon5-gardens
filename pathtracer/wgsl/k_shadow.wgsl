// ═══════════════════════════════════════════════════════════════════════════
// k_shadow.wgsl — any hit (shadow / visibility rays): rays → occlusion flags
// (one u32 per ray, 1 = occluded). Shadow rays carry tmax = light distance ×
// (1 − ε) (DECISIONS.md #3); the mask is usually B5_VIS_SHADOW.
// ═══════════════════════════════════════════════════════════════════════════
//#include "common.wgsl"
//#include "tri.wgsl"
//#include "traverse.wgsl"

override B5_WG_SIZE: u32 = 64u;

@group(1) @binding(0) var<uniform> b5_params: B5KernelParams;
@group(1) @binding(1) var<storage, read> b5_rays: array<B5Ray>;
@group(1) @binding(2) var<storage, read_write> b5_occluded: array<u32>;

@compute @workgroup_size(B5_WG_SIZE)
fn b5_k_shadow(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let i = b5_linear_id(gid, nwg, B5_WG_SIZE);
  if (i >= b5_params.count) {
    return;
  }
  let twoLevel = (b5_params.mode & B5_MODE_SINGLE_LEVEL) == 0u;
  b5_occluded[i] = select(0u, 1u, b5_any_hit(b5_rays[i], b5_params.mask, b5_params.root, twoLevel));
}
