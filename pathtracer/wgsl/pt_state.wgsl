// ═══════════════════════════════════════════════════════════════════════════
// pt_state.wgsl — wavefront integrator state shared by the k_* integrator
// kernels. Byte layouts are mirrored in pathtracer/integrator.ts (FRAME_*,
// PATH_*, Q_*) and checked by pathtracer/test/integrator.test.ts.
//
// Frame uniform (one 256-byte slot per wave, bound with a dynamic offset):
// camera in the STATION frame (right/up pre-scaled by tan(fov/2)·aspect and
// tan(fov/2): dir = normalize(fwd + right·sx + up·sy)), the wave's pixel
// range (global path index g = waveStart + i → pixel g % pixels, sample
// g / pixels), the tube emitter and integrator knobs.
//
// Queues buffer: 16 control words (atomics) + idx[3·capacity]:
//   idx[0 .. cap)        queue A of path indices   ┐ ping-pong by ctl[PARITY]:
//   idx[cap .. 2cap)     queue B                   ┘ in = parity, out = 1 − parity
//   idx[2cap .. 3cap)    path index of each shadow ray
// Rays buffer: rays[0 .. cap) = extension rays (k_intersect input, compacted),
// rays[cap .. 2cap) = shadow rays (k_shadow input, compacted).
// ═══════════════════════════════════════════════════════════════════════════

struct B5Frame {
  camPos: vec3f,      // @0
  waveStart: u32,     // @12 global index of the wave's first path
  camRight: vec3f,    // @16 right · tan(fovY/2) · aspect
  waveSize: u32,      // @28 paths in this wave (≤ capacity, ≤ pixels)
  camUp: vec3f,       // @32 up · tan(fovY/2)
  pixels: u32,        // @44 width · height
  camFwd: vec3f,      // @48 unit forward
  width: u32,         // @60
  tubeLe: vec3f,      // @64 tube radiance (scene radiance units)
  height: u32,        // @76
  tubeR: f32,         // @80
  tubeZ0: f32,        // @84
  tubeLen: f32,       // @88
  tubeOn: u32,        // @92
  maxDepth: u32,      // @96 bounces (vertex depth ≥ maxDepth only collects emission)
  rrDepth: u32,       // @100 Russian roulette from this vertex depth on
  clampInd: f32,      // @104 firefly clamp of indirect contributions (max component), 0 = off
  flags: u32,         // @108 B5_F_*
  coneSpread: f32,    // @112 camera ray-cone spread angle per pixel (rad)
  maxDim: u32,        // @116 maxComputeWorkgroupsPerDimension
  capacity: u32,      // @120 path capacity (queue / ray region size)
  salt: u32,          // @124 sampler salt
  rayEps: f32,        // @128 relative origin offset (× (1 + max |p|))
  diffuseSpread: f32, // @132 ray-cone spread after a diffuse bounce (rad)
  shadowEps: f32,     // @136 shadow tmax = distance · (1 − shadowEps)
  minAlpha: f32,      // @140 GGX alpha floor
  tubeMode: u32,      // @144 B5_TUBE_UNIFORM | B5_TUBE_EQUIANGULAR
  lightMode: u32,     // @148 B5_LIGHTS_NONE | _ALIAS | _TREE (emissive triangles)
  tubeLum: f32,       // @152 luminance of tubeLe (light selection)
  regK: f32,          // @156 path regularization: rough = max(rough, regK · previous rough); 0 = off
  tilesX: u32,        // @160 16×16 tiles per row (convergence)
  activeSlots: u32,   // @164 B5_F_TILES: active tiles × 256 path slots of the active tile list
  toneExp: f32,       // @168 exposure of the tonemap weighting (k_tilestats)
  convEps: f32,       // @172 display-space floor of the pixel error (k_tilestats)
}

const B5_F_AOV: u32 = 1u;      // accumulate AOVs (albedo / normal of the first non-delta vertex, depth)
const B5_F_JITTER: u32 = 2u;   // jitter the pixel position
const B5_F_SOBOL: u32 = 4u;    // Owen-scrambled Sobol sampler (else PCG)
const B5_F_TILES: u32 = 8u;    // adaptive: paths map onto the active tile list (else the whole frame)
const B5_TILE: u32 = 16u;      // convergence tile edge (convergence.ts CONVERGENCE.tile)

// B5Path.flags
const B5_PF_DELTA: u32 = 1u;   // the last scattering event was a delta (glass reflection): emission weight 1

// path state, 128 B
struct B5Path {
  o: vec3f,       // @0 current ray origin
  coneW: f32,     // @12 ray-cone width at o
  d: vec3f,       // @16 current ray direction (unit)
  coneS: f32,     // @28 ray-cone spread angle
  thr: vec3f,     // @32 throughput
  pixel: u32,     // @44
  L: vec3f,       // @48 accumulated radiance
  rng: u32,       // @60 sampler state
  sL: vec3f,      // @64 pending shadow-ray contribution (NEE)
  depth: u32,     // @76 vertex depth of the next hit
  pdf: f32,       // @80 solid-angle pdf of the last BSDF sample (MIS)
  sample: u32,    // @84 sample index of this pixel
  flags: u32,     // @88 B5_PF_*
  aux: u32,       // @92 pack2x16float(roughness of the last vertex (regularization), AOV depth)
  pp: vec3f,      // @96 last scattering vertex (MIS light pdfs; thin-glass transmission keeps it)
  alb: u32,       // @108 AOV albedo pack4x8unorm(rgb, done = 1 at the first non-delta vertex)
  pn: vec3f,      // @112 its shading normal (light-tree importance)
  nrm: u32,       // @124 AOV world normal, octahedral pack2x16snorm (0 = none)
}

// octahedral normal encoding of the AOV normal
fn b5_aov_oct_encode(n: vec3f) -> vec2f {
  let p = n.xy / (abs(n.x) + abs(n.y) + abs(n.z));
  if (n.z >= 0.0) {
    return p;
  }
  return (vec2f(1.0) - abs(p.yx)) * select(vec2f(-1.0), vec2f(1.0), p >= vec2f(0.0));
}

fn b5_aov_oct_decode(e: vec2f) -> vec3f {
  var n = vec3f(e, 1.0 - abs(e.x) - abs(e.y));
  let t = max(-n.z, 0.0);
  n = vec3f(n.x + select(t, -t, n.x >= 0.0), n.y + select(t, -t, n.y >= 0.0), n.z);
  return normalize(n);
}

const B5_Q_COUNT: u32 = 0u;        // rays in the input queue (this bounce)
const B5_Q_NEXT: u32 = 1u;         // rays appended to the output queue
const B5_Q_SHADOW: u32 = 2u;       // shadow rays appended this bounce
const B5_Q_SHADOW_LIVE: u32 = 3u;  // shadow rays of the last bounce (k_shadow, resolve)
const B5_Q_PARITY: u32 = 4u;
const B5_Q_BOUNCE: u32 = 5u;
const B5_Q_RAYS: u32 = 6u;         // statistics: extension rays traced (this step)
const B5_Q_SHADOWS: u32 = 7u;      // statistics: shadow rays traced (this step)
const B5_Q_CTL: u32 = 16u;

struct B5Queues {
  ctl: array<atomic<u32>, 16>,
  idx: array<u32>,
}

// non-finite (inf / NaN) test that fast-math cannot fold away
fn b5_finite3(c: vec3f) -> bool {
  let e = vec3u(bitcast<u32>(c.x), bitcast<u32>(c.y), bitcast<u32>(c.z)) & vec3u(0x7f800000u);
  return all(e != vec3u(0x7f800000u));
}
