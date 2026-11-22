// ═══════════════════════════════════════════════════════════════════════════
// k_intersect.wgsl — closest hit for a batch of rays: rays → hits.
// group 0: scene (traverse.wgsl), group 1: params, rays, hits (rays.ts layouts).
// ═══════════════════════════════════════════════════════════════════════════
//#include "common.wgsl"
//#include "tri.wgsl"
//#include "traverse.wgsl"

override B5_WG_SIZE: u32 = 64u;

@group(1) @binding(0) var<uniform> b5_params: B5KernelParams;
@group(1) @binding(1) var<storage, read> b5_rays: array<B5Ray>;
@group(1) @binding(2) var<storage, read_write> b5_hits: array<B5HitRec>;

@compute @workgroup_size(B5_WG_SIZE)
fn b5_k_intersect(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let i = b5_linear_id(gid, nwg, B5_WG_SIZE);
  if (i >= b5_params.count) {
    return;
  }
  let twoLevel = (b5_params.mode & B5_MODE_SINGLE_LEVEL) == 0u;
  let h = b5_closest_hit(b5_rays[i], b5_params.mask, b5_params.root, twoLevel);
  var o: B5HitRec;
  o.t = h.t;
  o.u = h.u;
  o.v = h.v;
  o.inst = h.inst;
  o.tri = h.tri;
  o.flags = select(0u, B5_HIT_FRONT, h.front);
  b5_hits[i] = o;
}
