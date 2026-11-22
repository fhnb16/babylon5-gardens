// ═══════════════════════════════════════════════════════════════════════════
// k_probe.wgsl — GPU probes of the pure BSDF / light-sampling modules for
// pathtracer/smoke/pt-unit.ts (CPU mirrors: bsdf-ref.ts, lights/*.ts). The
// same inputs (incl. the random numbers) go to both sides; results must agree
// to f32 precision.
//   b5_k_probe_bsdf   : per record → B5Bsdf from its fields, sample(wo, u),
//                       eval(wo, wi2)
//   b5_k_probe_lights : per query (p, n, u) → tree sample + pmf, tree pmf of a
//                       given light, alias sample, tube sample / pdf, p_tube
// ═══════════════════════════════════════════════════════════════════════════
//#include "common.wgsl"
//#include "sampling.wgsl"
//#include "pt_config.gen.wgsl"
//#include "lights.gen.wgsl"
//#include "light_tube.wgsl"
//#include "light_tree.wgsl"
//#include "bsdf_std.wgsl"
//#include "bsdf_glass.wgsl"
//#include "bsdf_water.wgsl"
//#include "bsdf.wgsl"

const B5_PROBE_BSDF_IN: u32 = 28u;
const B5_PROBE_BSDF_OUT: u32 = 12u;
const B5_PROBE_LIGHT_IN: u32 = 12u;
const B5_PROBE_LIGHT_OUT: u32 = 16u;

@group(0) @binding(0) var<storage, read> b5_pin: array<f32>;
@group(0) @binding(1) var<storage, read_write> b5_pout: array<f32>;
@group(0) @binding(2) var<uniform> b5_pparams: vec4f;   // x = count; lights: y = tube r, z = z0, w = len
@group(0) @binding(3) var<storage, read> b5_ldata: array<vec4f>;

fn b5_pv3(i: u32) -> vec3f {
  return vec3f(b5_pin[i], b5_pin[i + 1u], b5_pin[i + 2u]);
}

@compute @workgroup_size(64)
fn b5_k_probe_bsdf(@builtin(global_invocation_id) gid: vec3u) {
  let k = gid.x;
  if (k >= u32(b5_pparams.x)) {
    return;
  }
  let i = k * B5_PROBE_BSDF_IN;
  var b: B5Bsdf;
  b.n = b5_pv3(i);
  b.lobe = u32(b5_pin[i + 3u]);
  b.cd = b5_pv3(i + 4u);
  b.a = b5_pin[i + 7u];
  b.f0 = b5_pv3(i + 8u);
  b.pSpec = b5_pin[i + 11u];
  b.tint = b5_pv3(i + 12u);
  b.eta = b5_pin[i + 15u];
  b.depth = b5_pin[i + 16u];
  b.fBoost = b5_pin[i + 17u];
  let wo = b5_pv3(i + 18u);
  let u = b5_pv3(i + 21u);
  let wi2 = b5_pv3(i + 24u);
  let s = b5_bsdf_sample(b, wo, u);
  let e = b5_bsdf_eval(b, wo, wi2);
  let o = k * B5_PROBE_BSDF_OUT;
  b5_pout[o] = s.wi.x;
  b5_pout[o + 1u] = s.wi.y;
  b5_pout[o + 2u] = s.wi.z;
  b5_pout[o + 3u] = s.pdf;
  b5_pout[o + 4u] = s.w.x;
  b5_pout[o + 5u] = s.w.y;
  b5_pout[o + 6u] = s.w.z;
  b5_pout[o + 7u] = f32(select(0u, 1u, s.delta) | select(0u, 2u, s.through) | select(0u, 4u, s.ok));
  b5_pout[o + 8u] = e.x;
  b5_pout[o + 9u] = e.y;
  b5_pout[o + 10u] = e.z;
  b5_pout[o + 11u] = e.w;
}

@compute @workgroup_size(64)
fn b5_k_probe_lights(@builtin(global_invocation_id) gid: vec3u) {
  let k = gid.x;
  if (k >= u32(b5_pparams.x)) {
    return;
  }
  let i = k * B5_PROBE_LIGHT_IN;
  let p = b5_pv3(i);
  let n = b5_pv3(i + 3u);
  let u = b5_pv3(i + 6u);
  let light = u32(b5_pin[i + 9u]);
  let r = b5_pparams.y;
  let z0 = b5_pparams.z;
  let len = b5_pparams.w;
  let ts = b5_lt_sample(p, n, u.x);
  let al = b5_alias_sample(u.x);
  let tu = b5_tube_sample(p, r, z0, len, u.yz);
  let o = k * B5_PROBE_LIGHT_OUT;
  b5_pout[o] = select(-1.0, f32(ts.light), ts.light != B5_NO_INDEX);
  b5_pout[o + 1u] = ts.pmf;
  b5_pout[o + 2u] = b5_lt_pmf(p, n, light);
  b5_pout[o + 3u] = select(-1.0, f32(al.light), al.light != B5_NO_INDEX);
  b5_pout[o + 4u] = al.pmf;
  b5_pout[o + 5u] = tu.x.x;
  b5_pout[o + 6u] = tu.x.y;
  b5_pout[o + 7u] = tu.x.z;
  b5_pout[o + 8u] = tu.pdfW;
  b5_pout[o + 9u] = select(0.0, b5_tube_pdf(p, tu.x, r, z0, len), tu.pdfW > 0.0);
  b5_pout[o + 10u] = b5_ptube(true, 10.0, r, z0, len, B5_LIGHTS_TREE, p, n);
  b5_pout[o + 11u] = b5_lt_root_importance(p, n);
  b5_pout[o + 12u] = b5_tube_importance(p, r, z0, len, 10.0);
  b5_pout[o + 13u] = 0.0;
  b5_pout[o + 14u] = 0.0;
  b5_pout[o + 15u] = 0.0;
}
