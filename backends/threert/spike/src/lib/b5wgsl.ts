// Stand-in for what core/shading/emit/wgsl.ts will emit: pure WGSL functions, every identifier prefixed b5_, no `$`.
// ONE shared string for every MaterialFunction: the renderer splices helpers deduplicated by exact text, so two
// functions that each carry their own copy of the same b5_* fn would redefine it (see f_matfn_dup.ts).
export const B5_WGSL = /* wgsl */ `
const B5_TAU: f32 = 6.283185307;
fn b5_hash21(p: vec2<f32>) -> f32 { return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453); }
fn b5_mod(x: f32, y: f32) -> f32 { return x - y * floor(x / y); }
fn b5_mix_tint(base: vec3<f32>, tint: vec3<f32>, k: f32) -> vec3<f32> { return mix(base, tint, clamp(k, 0.0, 1.0)); }
// Ripple slope (d/dx, d/dy of a sum of two travelling waves) at p (m), time t (s).
fn b5_ripple(p: vec2<f32>, t: f32, freq: f32) -> vec2<f32> {
  let a = p.x * freq + t * 1.7;
  let b = (p.x * 0.6 + p.y * 0.8) * freq * 1.3 - t * 1.1;
  return vec2<f32>(cos(a) + 0.6 * 0.6 * cos(b), 0.6 * 0.8 * cos(b));
}
`;
