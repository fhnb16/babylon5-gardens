// ═══════════════════════════════════════════════════════════════════════════
// k_lightpower.wgsl — emitted "energy" of every emissive-triangle light for
// the light selectors (alias table / light BVH, built on the CPU):
//   phi = luminance(mean emission over the triangle) × world area,
// the mean taken over B5_POWER_SIDE² stratified area-uniform points, the
// emission evaluated by the SAME surface code as shading (b5_surface on a
// fake hit at t = 1 from 1 unit above the point, ray-cone width
// sqrt(area) · B5_POWER_CONE so the texture LOD averages over the triangle).
// Input: light rows (light-data.ts layout: v0+inst, v1+tri, v2+0).
// group 0: tris / instances, group 1: rows, output, params, group 2: surface.
// ═══════════════════════════════════════════════════════════════════════════
//#include "common.wgsl"
//#include "tri.wgsl"
//#include "traverse.wgsl"
//#include "sampling.wgsl"
//#include "surface.wgsl"
//#include "pt_config.gen.wgsl"

override B5_WG_SIZE: u32 = 64u;

@group(1) @binding(0) var<storage, read> b5_lp_rows: array<vec4f>;
@group(1) @binding(1) var<storage, read_write> b5_lp_out: array<f32>;
@group(1) @binding(2) var<uniform> b5_lp_params: vec4u;   // x = light count

@compute @workgroup_size(B5_WG_SIZE)
fn b5_k_lightpower(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let i = b5_linear_id(gid, nwg, B5_WG_SIZE);
  if (i >= b5_lp_params.x) {
    return;
  }
  let a = b5_lp_rows[i * 3u];
  let b = b5_lp_rows[i * 3u + 1u];
  let c = b5_lp_rows[i * 3u + 2u];
  let inst = bitcast<u32>(a.w);
  let tri = bitcast<u32>(b.w);
  let nc = cross(b.xyz - a.xyz, c.xyz - a.xyz);
  let area = 0.5 * length(nc);
  if (inst == B5_NO_INDEX || !(area > 0.0)) {
    b5_lp_out[i] = 0.0;
    return;
  }
  let n = nc / (2.0 * area);
  let cone = sqrt(area) * B5_POWER_CONE;
  var sum = vec3f(0.0);
  let side = f32(B5_POWER_SIDE);
  for (var y = 0u; y < B5_POWER_SIDE; y += 1u) {
    for (var x = 0u; x < B5_POWER_SIDE; x += 1u) {
      let bc = b5_tri_uniform(vec2f((f32(x) + 0.5) / side, (f32(y) + 0.5) / side));
      let p = a.xyz * (1.0 - bc.x - bc.y) + b.xyz * bc.x + c.xyz * bc.y;
      var hit: B5HitRec;
      hit.t = 1.0;
      hit.u = bc.x;
      hit.v = bc.y;
      hit.inst = inst;
      hit.tri = tri;
      hit.flags = 0u;
      let s = b5_surface(hit, p + n, -n, cone);
      sum += max(s.emission, vec3f(0.0));
    }
  }
  let e = sum / (side * side);
  let phi = b5_luminance(e) * area;
  b5_lp_out[i] = select(0.0, phi, phi > 0.0 && phi < 3.0e38);
}
