// ═══════════════════════════════════════════════════════════════════════════
// common.wgsl — constants and small helpers shared by the path tracer kernels.
// The loader (pathtracer/kernels.ts) prepends, before any file:
//   defines (B5_TRAVERSE_STACK, …), bvh/layout.ts emitWgslLayout(),
//   rays.ts emitWgslRays().
// Module-scope identifiers are prefixed b5_/B5 (repo WGSL hygiene), and no
// dollar sign anywhere (ThreeRT substitutes dollar-names).
// ═══════════════════════════════════════════════════════════════════════════

// "no intersection" entry distance: larger than any finite ray tmax (≤ 1e30)
// and finite (no inf literals in WGSL; fast-math compilers may assume no inf).
const B5_MISS: f32 = 3.0e38;

const B5_PI: f32 = 3.14159265358979;

// ─── rng placeholder ─────────────────────────────────────────────────────────
// PCG hash (Jarzynski & Olano 2020). The integrator unit replaces this with
// its sampler (Sobol / blue noise); the signature stays.
fn b5_pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}

fn b5_rng_seed(pixel: vec2u, frame: u32) -> u32 {
  return b5_pcg(pixel.x ^ b5_pcg(pixel.y ^ b5_pcg(frame)));
}

// uniform float in [0, 1)
fn b5_rng_next(state: ptr<function, u32>) -> f32 {
  *state = b5_pcg(*state);
  return f32(*state >> 8u) * (1.0 / 16777216.0);
}

// linear invocation index of a 2-D dispatch of 1-D workgroups (dispatchSize()
// in kernels.ts splits large counts over x and y: x ≤ maxComputeWorkgroupsPerDimension)
fn b5_linear_id(gid: vec3u, nwg: vec3u, wgSize: u32) -> u32 {
  return gid.x + gid.y * nwg.x * wgSize;
}
