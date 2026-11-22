// ═══════════════════════════════════════════════════════════════════════════
// k_raygen.wgsl — start one wave. Path i (i < waveSize) takes slot
// g = waveStart + i:
//   whole frame : pixel g % pixels
//   B5_F_TILES  : slot s = g % activeSlots of the active tile list (256 slots
//                 per 16×16 tile, row-major inside the tile); slots of edge
//                 tiles outside the image become dead paths (pixel NO_INDEX,
//                 an empty ray: tmin > tmax).
// The sample index is the pixel's accumulated count (accum.w): exact under
// adaptive sampling, and the Sobol index of the pixel. Writes the path state,
// the camera ray rays[i] and queue A[i] = i; invocation 0 resets the queue
// control words (input count = waveSize, parity 0).
// group 0: unused (empty), group 1: frame, paths, queues, rays, accum, tiles.
// ═══════════════════════════════════════════════════════════════════════════
//#include "common.wgsl"
//#include "sampling.wgsl"
//#include "camera.wgsl"
//#include "pt_state.wgsl"

override B5_WG_SIZE: u32 = 64u;

@group(1) @binding(0) var<uniform> b5_wave: B5Frame;
@group(1) @binding(1) var<storage, read_write> b5_paths: array<B5Path>;
@group(1) @binding(2) var<storage, read_write> b5_queues: B5Queues;
@group(1) @binding(3) var<storage, read_write> b5_rays: array<B5Ray>;
@group(1) @binding(4) var<storage, read> b5_accum: array<vec4f>;
@group(1) @binding(5) var<storage, read> b5_active: array<u32>;

// pixel of path slot g (B5_NO_INDEX = outside the image)
fn b5_slot_pixel(g: u32) -> u32 {
  let f = b5_wave;
  if ((f.flags & B5_F_TILES) == 0u) {
    return g % f.pixels;
  }
  let s = g % max(f.activeSlots, 1u);
  let tile = b5_active[s / (B5_TILE * B5_TILE)];
  let l = s % (B5_TILE * B5_TILE);
  let x = (tile % f.tilesX) * B5_TILE + l % B5_TILE;
  let y = (tile / f.tilesX) * B5_TILE + l / B5_TILE;
  if (x >= f.width || y >= f.height) {
    return B5_NO_INDEX;
  }
  return y * f.width + x;
}

@compute @workgroup_size(B5_WG_SIZE)
fn b5_k_raygen(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let i = b5_linear_id(gid, nwg, B5_WG_SIZE);
  let f = b5_wave;
  if (i == 0u) {
    atomicStore(&b5_queues.ctl[B5_Q_COUNT], f.waveSize);
    atomicStore(&b5_queues.ctl[B5_Q_NEXT], 0u);
    atomicStore(&b5_queues.ctl[B5_Q_SHADOW], 0u);
    atomicStore(&b5_queues.ctl[B5_Q_SHADOW_LIVE], 0u);
    atomicStore(&b5_queues.ctl[B5_Q_PARITY], 0u);
    atomicStore(&b5_queues.ctl[B5_Q_BOUNCE], 0u);
    atomicAdd(&b5_queues.ctl[B5_Q_RAYS], f.waveSize);
  }
  if (i >= f.waveSize) {
    return;
  }
  let pixel = b5_slot_pixel(f.waveStart + i);
  var p: B5Path;
  var r: B5Ray;
  p.pixel = pixel;
  p.thr = vec3f(1.0);
  p.L = vec3f(0.0);
  p.sL = vec3f(0.0);
  p.depth = 0u;
  p.pdf = 0.0;
  p.aux = 0u;
  p.alb = 0u;
  p.nrm = 0u;
  p.pn = vec3f(0.0);
  p.coneW = 0.0;
  p.coneS = f.coneSpread;
  if (pixel == B5_NO_INDEX) {
    p.o = f.camPos;
    p.d = f.camFwd;
    p.rng = 0u;
    p.sample = 0u;
    p.flags = B5_PF_DELTA;
    p.pp = f.camPos;
    b5_paths[i] = p;
    r.o = f.camPos;
    r.tmin = 1.0;
    r.d = f.camFwd;
    r.tmax = 0.0;
    b5_rays[i] = r;
    b5_queues.idx[i] = i;
    return;
  }
  let sample = u32(b5_accum[pixel].w);
  var rng = b5_sampler_start((f.flags & B5_F_SOBOL) != 0u, pixel, sample, f.salt);
  var jit = vec2f(0.5);
  if ((f.flags & B5_F_JITTER) != 0u) {
    jit = b5_rnd2(&rng);
  }
  let px = vec2f(f32(pixel % f.width), f32(pixel / f.width)) + jit;
  let d = b5_camera_dir(f.camFwd, f.camRight, f.camUp, px, vec2f(f32(f.width), f32(f.height)));

  p.o = f.camPos;
  p.d = d;
  p.rng = rng;
  p.sample = sample;
  // the camera is a delta vertex: emitters reached through thin glass straight from
  // the camera (no NEE there) keep MIS weight 1 until the first real scattering
  p.flags = B5_PF_DELTA;
  p.pp = f.camPos;
  b5_paths[i] = p;

  r.o = f.camPos;
  r.tmin = 0.0;
  r.d = d;
  r.tmax = B5_T_INFINITE;
  b5_rays[i] = r;
  b5_queues.idx[i] = i;
}
