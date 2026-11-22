// ═══════════════════════════════════════════════════════════════════════════
// k_shadow_tr.wgsl — integrator shadow rays with thin-glass transmission
// (replaces k_shadow in the integrator; B5's k_shadow stays for pt-smoke).
// Output per ray: pack4x8unorm(transmittance.rgb, 1); 0 = occluded.
// group 0: scene, group 1: params / rays / output, group 2: surface
// resources (only b5_mats is read, via b5_surface_glass).
// ═══════════════════════════════════════════════════════════════════════════
//#include "common.wgsl"
//#include "tri.wgsl"
//#include "traverse.wgsl"
//#include "sampling.wgsl"
//#include "surface.wgsl"
//#include "pt_config.gen.wgsl"
//#include "bsdf_std.wgsl"
//#include "bsdf_glass.wgsl"
//#include "traverse_tr.wgsl"

override B5_WG_SIZE: u32 = 64u;

@group(1) @binding(0) var<uniform> b5_params: B5KernelParams;
@group(1) @binding(1) var<storage, read> b5_rays: array<B5Ray>;
@group(1) @binding(2) var<storage, read_write> b5_occluded: array<u32>;

@compute @workgroup_size(B5_WG_SIZE)
fn b5_k_shadow_tr(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let i = b5_linear_id(gid, nwg, B5_WG_SIZE);
  if (i >= b5_params.count) {
    return;
  }
  let T = b5_trace_transmittance(b5_rays[i], b5_params.mask, b5_params.root);
  b5_occluded[i] = select(pack4x8unorm(vec4f(T, 1.0)), 0u, b5_max3(T) <= 0.0);
}
