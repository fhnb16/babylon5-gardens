// ═══════════════════════════════════════════════════════════════════════════
// pt-surface.wgsl — debug kernel of the surface smoke (pt-surface.html):
// hits of k_intersect → b5_surface → one AOV record per ray.
// group 0: scene, group 1: params / rays / hits / aov (below), group 2: surface.
// Primary-ray cone: coneW = spread · t · |d| (spread = pixel angle).
// ═══════════════════════════════════════════════════════════════════════════
//#include "surface.wgsl"

override B5_WG_SIZE: u32 = 64u;

struct B5SurfDbgParams {
  count: u32,
  r0: u32,
  spread: f32,
  r1: f32,
}

// size 80 B
struct B5SurfAov {
  albedo: vec3f,   // @0
  kind: u32,       // @12
  ns: vec3f,       // @16
  rough: f32,      // @28
  emission: vec3f, // @32
  metal: f32,      // @44
  ng: vec3f,       // @48
  water: f32,      // @60
  matId: u32,      // @64
  frontFace: u32,  // @68
  coneW: f32,      // @72
  hit: u32,        // @76
}

@group(1) @binding(0) var<uniform> b5_sdp: B5SurfDbgParams;
@group(1) @binding(1) var<storage, read> b5_srays: array<B5Ray>;
@group(1) @binding(2) var<storage, read> b5_shits: array<B5HitRec>;
@group(1) @binding(3) var<storage, read_write> b5_aov: array<B5SurfAov>;

@compute @workgroup_size(B5_WG_SIZE)
fn b5_k_surface_dbg(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let i = b5_linear_id(gid, nwg, B5_WG_SIZE);
  if (i >= b5_sdp.count) {
    return;
  }
  let h = b5_shits[i];
  var o: B5SurfAov;
  if (h.tri == B5_NO_INDEX) {
    o.hit = 0u;
    b5_aov[i] = o;
    return;
  }
  let r = b5_srays[i];
  let coneW = b5_sdp.spread * h.t * length(r.d);
  let s = b5_surface(h, r.o, r.d, coneW);
  o.albedo = s.albedo;
  o.kind = s.kind;
  o.ns = s.ns;
  o.rough = s.rough;
  o.emission = s.emission;
  o.metal = s.metal;
  o.ng = s.ng;
  o.water = s.water;
  o.matId = s.matId;
  o.frontFace = s.frontFace;
  o.coneW = s.coneW;
  o.hit = 1u;
  b5_aov[i] = o;
}
