// ═══════════════════════════════════════════════════════════════════════════
// surface_stub.wgsl — stand-in for U3's surface.wgsl with the SAME seam
// (pathtracer/DECISIONS.md, "M1 interface"): struct B5Surface and
//   fn b5_surface(hit: B5HitRec, rayO: vec3f, rayD: vec3f, coneW: f32) -> B5Surface
// Lambert grey from the triangle's geometric normal (object → world through
// the instance's worldToObject rows), instance tint × B5_STUB_ALBEDO, constant
// emission B5_STUB_EMISSION (the furnace test uses albedo ρ and emission Le on
// every surface). Instances flagged INST_EMISSIVE are unlit emitters (kind 1)
// of radiance = instance tint (RGB9E5, HDR). No group-2 bindings.
// Loader defines (integrator.ts):
//   B5_STUB_ALBEDO, B5_STUB_EMISSION (f32 or integer — cast with f32()).
// Requires traverse.wgsl (b5_tris, b5_insts).
// ═══════════════════════════════════════════════════════════════════════════

// material kinds (surface_layout.gen.wgsl defines them for the real surface)
const B5_KIND_STANDARD: u32 = 0u;
const B5_KIND_UNLIT: u32 = 1u;
const B5_KIND_HULL: u32 = 2u;
const B5_KIND_THINGLASS: u32 = 3u;

struct B5Surface {
  p: vec3f,          // world (station) position
  kind: u32,         // 0 standard, 1 unlit/emissive-only, 2 hull, 3 thinGlass
  ng: vec3f,         // geometric normal, facing the incoming ray
  matId: u32,
  ns: vec3f,         // shading normal, same hemisphere as ng
  rough: f32,
  albedo: vec3f,     // linear
  metal: f32,
  emission: vec3f,   // linear radiance, scene units
  water: f32,
  tint: vec3f,
  ior: f32,
  slope: vec2f,
  coneW: f32,
  frontFace: u32,
  bed: vec3f,
  foam: f32,
  wtint: vec3f,
  rough0: f32,
}

fn b5_surface(hit: B5HitRec, rayO: vec3f, rayD: vec3f, coneW: f32) -> B5Surface {
  let tr = b5_tris[hit.tri];
  let nObj = cross(tr.v1 - tr.v0, tr.v2 - tr.v0);
  var nW = nObj;
  var tint = vec3f(1.0);
  if (hit.inst != B5_NO_INDEX) {
    let ins = b5_insts[hit.inst];
    // normal matrix = transpose(worldToObject 3×3)
    nW = vec3f(ins.w2o0.x, ins.w2o1.x, ins.w2o2.x) * nObj.x +
         vec3f(ins.w2o0.y, ins.w2o1.y, ins.w2o2.y) * nObj.y +
         vec3f(ins.w2o0.z, ins.w2o1.z, ins.w2o2.z) * nObj.z;
    tint = b5_rgb9e5_decode(ins.tint);
  }
  nW = normalize(nW);
  let ng = select(-nW, nW, dot(nW, rayD) < 0.0);
  var emissive = false;
  if (hit.inst != B5_NO_INDEX) {
    emissive = (b5_inst_flags(b5_insts[hit.inst].flagsLight) & B5_INST_EMISSIVE) != 0u;
  }
  var s: B5Surface;
  s.p = rayO + rayD * hit.t;
  s.kind = 0u;
  s.ng = ng;
  s.matId = tr.slot;
  s.ns = ng;
  s.rough = 1.0;
  s.albedo = clamp(tint * f32(B5_STUB_ALBEDO), vec3f(0.0), vec3f(1.0));
  s.metal = 0.0;
  s.emission = vec3f(f32(B5_STUB_EMISSION));
  if (emissive) {
    // INST_EMISSIVE instances: unlit emitters of radiance = instance tint
    s.kind = 1u;
    s.albedo = vec3f(0.0);
    s.emission = tint;
  }
  s.water = 0.0;
  s.tint = vec3f(1.0);
  s.ior = 1.5;
  s.slope = vec2f(0.0);
  s.coneW = coneW;
  s.frontFace = hit.flags & B5_HIT_FRONT;
  s.bed = s.albedo;
  s.foam = 0.0;
  s.wtint = vec3f(0.0);
  s.rough0 = s.rough;
  return s;
}

// the stub has no emissive-triangle lights
fn b5_surface_emission(hit: B5HitRec, rayD: vec3f, coneW: f32) -> vec3f {
  return vec3f(0.0);
}

fn b5_surface_light(hit: B5HitRec) -> u32 {
  return B5_NO_LIGHT;
}

// the stub has no thin glass (never flagged INST_GLASS)
fn b5_surface_glass(inst: u32, tri: u32) -> vec4f {
  return vec4f(1.0, 1.0, 1.0, 1.5);
}
