// ═══════════════════════════════════════════════════════════════════════════
// surface.wgsl — hit → shading surface (DECISIONS.md "M1 interface"):
//   fn b5_surface(hit: B5HitRec, rayO: vec3f, rayD: vec3f, coneW: f32) -> B5Surface
// Reads group 0 (b5_tris, b5_insts from traverse.wgsl) and group 2 (below,
// layout = scene-upload.ts surfaceBindGroupLayoutEntries). CPU mirror:
// pathtracer/surface-ref.ts — keep both in step.
//
// Requires the loader prelude (layout.ts, rays.ts) and the generated sources
// of scene-upload.ts surfaceSources(): surface_layout.gen.wgsl (B5Material,
// B5SurfaceFrame, B5TexRef, B5TriAttr) and hull_kernel.gen.wgsl
// (b5_hull_surface, raster: false).
//
// Steps
//   1. fetch triangle record, attribute record, instance, material
//      (material = b5_mats[instance.matBase + tri.slot]);
//   2. p = rayO + t·rayD; geometric normal from the triangle's object-space
//      vertices, to world with the transpose of worldToObject (normals are
//      covectors: n_w = W2Oᵀ n_o); face-forwarded against the ray;
//   3. interpolated vertex normal / uv / vertex colour (barycentrics
//      w0 = 1−u−v, w1 = u, w2 = v); flatShading uses the geometric normal;
//   4. ray-cone texture LOD (Akenine-Möller et al. 2021, "Improved Shader and
//      Texture Level of Detail Using Ray Cones", JCGT 10(1)):
//        λ = Δ + log2(coneW) − log2|n̂g·d̂| + lodBias,
//        Δ = 0.5·log2(texelArea / worldArea)
//          = attr.lodConst (0.5·log2(uvArea / objectArea))
//          + (1/3)·log2|det W2O|   (object → world area scale of the instance,
//                                   exact for uniform scale)
//          + texref.lodOffset       (log2(class size) + uv-transform scale);
//        |n̂g·d̂| is clamped at B5_LOD_MIN_COS so grazing hits stay finite;
//   5. tangent frame per hit from the triangle's dP/du, dP/dv (object space,
//      to world with W2O⁻¹ — nothing stored); normal maps are tangent-space,
//      OpenGL (+Y = +v) convention, xy × normalScale, like three's
//      perturbNormal; the frame is built on the un-flipped normal and the
//      result is flipped with the face;
//   6. albedo = baseColor × map × instance tint (× vertex colour if the
//      material says vertexColors); roughness × roughnessMap.g; emission =
//      material.emissive × (unlit: albedo map | other: emissive map) ×
//      frame.channels[channel].rgb (unlit surfaces report albedo for AOVs
//      but must not reflect: kind 1);
//   7. kind = hull: b5_hull_surface (shared kernel) with mask/detail samples,
//      p = (u·2πR, v·L), far = farFromFootprint(coneW); city glow emission ×
//      frame.channels[cityGlow]; ripple normal = normalize(n + T·slope.x +
//      B·slope.y) mixed with the mapped normal by the water weight;
//   8. ns is moved into the hemisphere of ng when interpolation/mapping
//      pushed it below the surface.
// ═══════════════════════════════════════════════════════════════════════════
//#include "common.wgsl"
//#include "tri.wgsl"
//#include "traverse.wgsl"
//#include "surface_layout.gen.wgsl"
//#include "hull_kernel.gen.wgsl"
//#include "pt_config.gen.wgsl"

@group(2) @binding(0) var<storage, read> b5_attrs: array<B5TriAttr>;
@group(2) @binding(1) var<storage, read> b5_mats: array<B5Material>;
@group(2) @binding(2) var<uniform> b5_texrefs: B5TexTable;
@group(2) @binding(3) var<uniform> b5_frame: B5SurfaceFrame;
@group(2) @binding(4) var b5_samp_repeat: sampler;
@group(2) @binding(5) var b5_samp_clamp: sampler;
@group(2) @binding(6) var b5_tex_s0: texture_2d_array<f32>;
@group(2) @binding(7) var b5_tex_s1: texture_2d_array<f32>;
@group(2) @binding(8) var b5_tex_s2: texture_2d_array<f32>;
@group(2) @binding(9) var b5_tex_s3: texture_2d_array<f32>;
@group(2) @binding(10) var b5_tex_l0: texture_2d_array<f32>;
@group(2) @binding(11) var b5_tex_l1: texture_2d_array<f32>;
@group(2) @binding(12) var b5_tex_l2: texture_2d_array<f32>;
@group(2) @binding(13) var b5_tex_l3: texture_2d_array<f32>;

// smallest |n̂g·d̂| in the ray-cone LOD (≈ 89.4°)
const B5_LOD_MIN_COS: f32 = 0.01;
const B5_TAU: f32 = 6.28318530717959;

struct B5Surface {
  p: vec3f,          // world (station) position
  kind: u32,         // 0 standard, 1 unlit/emissive-only, 2 hull, 3 thinGlass
  ng: vec3f,         // geometric normal, facing the incoming ray
  matId: u32,
  ns: vec3f,         // shading normal (normal map / ripple applied), same hemisphere as ng
  rough: f32,
  albedo: vec3f,     // linear
  metal: f32,
  emission: vec3f,   // linear radiance, scene units (palette channel × nits already applied)
  water: f32,        // hull water weight 0..1 (kind 2)
  tint: vec3f,       // thinGlass transmission tint
  ior: f32,
  slope: vec2f,      // hull ripple slope (kind 2), for the water BSDF
  coneW: f32,        // ray-cone width at hit, for texture LOD (input copy)
  frontFace: u32,
  // PT-W4a (water BSDF): hull bed colour without water absorption / foam,
  // foam amount (× B5_FOAM_COLOR in the hull albedo), water tint, dry roughness
  bed: vec3f,
  foam: f32,
  wtint: vec3f,
  rough0: f32,
}

// octahedral snorm16×2 → unit vector
fn b5_oct_decode(p: u32) -> vec3f {
  let e = unpack2x16snorm(p);
  var n = vec3f(e.x, e.y, 1.0 - abs(e.x) - abs(e.y));
  let t = max(-n.z, 0.0);
  n.x += select(t, -t, n.x >= 0.0);
  n.y += select(t, -t, n.y >= 0.0);
  return normalize(n);
}

// legacy distance fade from a footprint (core/shading/contracts.ts farFromFootprint)
fn b5_far_from_footprint(footprint: f32) -> f32 {
  return smoothstep(B5_FAR_NEAR, B5_FAR_FAR, footprint / B5_REF_PIXEL_ANGLE);
}

fn b5_tex_array(slot: u32, clampW: bool, uv: vec2f, layer: u32, lod: f32) -> vec4f {
  if (clampW) {
    switch slot {
      case 0u: { return textureSampleLevel(b5_tex_s0, b5_samp_clamp, uv, layer, lod); }
      case 1u: { return textureSampleLevel(b5_tex_s1, b5_samp_clamp, uv, layer, lod); }
      case 2u: { return textureSampleLevel(b5_tex_s2, b5_samp_clamp, uv, layer, lod); }
      case 3u: { return textureSampleLevel(b5_tex_s3, b5_samp_clamp, uv, layer, lod); }
      case 4u: { return textureSampleLevel(b5_tex_l0, b5_samp_clamp, uv, layer, lod); }
      case 5u: { return textureSampleLevel(b5_tex_l1, b5_samp_clamp, uv, layer, lod); }
      case 6u: { return textureSampleLevel(b5_tex_l2, b5_samp_clamp, uv, layer, lod); }
      default: { return textureSampleLevel(b5_tex_l3, b5_samp_clamp, uv, layer, lod); }
    }
  }
  switch slot {
    case 0u: { return textureSampleLevel(b5_tex_s0, b5_samp_repeat, uv, layer, lod); }
    case 1u: { return textureSampleLevel(b5_tex_s1, b5_samp_repeat, uv, layer, lod); }
    case 2u: { return textureSampleLevel(b5_tex_s2, b5_samp_repeat, uv, layer, lod); }
    case 3u: { return textureSampleLevel(b5_tex_s3, b5_samp_repeat, uv, layer, lod); }
    case 4u: { return textureSampleLevel(b5_tex_l0, b5_samp_repeat, uv, layer, lod); }
    case 5u: { return textureSampleLevel(b5_tex_l1, b5_samp_repeat, uv, layer, lod); }
    case 6u: { return textureSampleLevel(b5_tex_l2, b5_samp_repeat, uv, layer, lod); }
    default: { return textureSampleLevel(b5_tex_l3, b5_samp_repeat, uv, layer, lod); }
  }
}

// sample texture-table entry `idx` at mesh uv with surface LOD `lod`
fn b5_tex_sample(idx: u32, uv: vec2f, lod: f32) -> vec4f {
  let r = b5_texrefs.e[idx];
  let cls = (r.loc >> B5_LOC_CLASS_SHIFT) & 3u;
  let slot = cls + select(4u, 0u, (r.loc & B5_LOC_SRGB) != 0u);
  let uvT = uv * r.xform.xy + r.xform.zw;
  return b5_tex_array(slot, (r.loc & B5_LOC_CLAMP) != 0u, uvT, r.loc & B5_LOC_LAYER_MASK, lod + r.lodOffset);
}

fn b5_tex_ok(idx: u32) -> bool {
  return idx != B5_NO_TEX;
}

// tangent-space normal map → world normal around `n` with frame (t, b)
fn b5_apply_normal_map(n: vec3f, t: vec3f, b: vec3f, tn: vec3f, scale: vec2f) -> vec3f {
  let m = vec3f(tn.xy * scale, tn.z);
  let tt = t - n * dot(n, t);
  let bb = b - n * dot(n, b);
  let lt = length(tt);
  let lb = length(bb);
  if (lt < 1e-12 || lb < 1e-12) {
    return n;
  }
  return normalize(tt / lt * m.x + bb / lb * m.y + n * m.z);
}

fn b5_surface(hit: B5HitRec, rayO: vec3f, rayD: vec3f, coneW: f32) -> B5Surface {
  var s: B5Surface;
  let tri = b5_tris[hit.tri];
  let at = b5_attrs[hit.tri];
  let inst = b5_insts[hit.inst];
  let m = b5_mats[inst.matBase + tri.slot];
  let kind = m.kindFlags & 0xfu;
  let mflags = (m.kindFlags >> 4u) & 0xfu;
  let ch = min((m.kindFlags >> 8u) & 0xffu, B5_CHANNEL_SLOTS - 1u);
  s.kind = kind;
  s.matId = m.kindFlags >> 16u;
  s.frontFace = hit.flags & B5_HIT_FRONT;
  s.coneW = coneW;
  s.p = rayO + rayD * hit.t;
  let d = normalize(rayD);

  // instance transforms: W2O rows r0..r2 (3×3 part); normals: W2Oᵀ; directions: W2O⁻¹
  let r0 = inst.w2o0.xyz;
  let r1 = inst.w2o1.xyz;
  let r2 = inst.w2o2.xyz;
  let nrmM = mat3x3f(r0, r1, r2);                       // columns = rows of W2O → W2Oᵀ
  let c12 = cross(r1, r2);
  let det = dot(r0, c12);
  let invDet = 1.0 / select(det, 1e-30, det == 0.0);
  let dirM = mat3x3f(c12, cross(r2, r0), cross(r0, r1)) * invDet; // W2O⁻¹

  // geometric normal, face-forwarded
  let e1 = tri.v1 - tri.v0;
  let e2 = tri.v2 - tri.v0;
  let ngW = normalize(nrmM * cross(e1, e2));
  let flip = dot(ngW, d) > 0.0;
  let sgn = select(1.0, -1.0, flip);
  s.ng = ngW * sgn;

  // interpolated attributes
  let w0 = 1.0 - hit.u - hit.v;
  let nO = b5_oct_decode(at.n0) * w0 + b5_oct_decode(at.n1) * hit.u + b5_oct_decode(at.n2) * hit.v;
  var nI = normalize(nrmM * nO);
  if ((mflags & B5_MATF_FLAT) != 0u) {
    nI = ngW;
  }
  let uv = at.uv0 * w0 + at.uv1 * hit.u + at.uv2 * hit.v;

  // tangent frame from uv derivatives (object space → world)
  let duv1 = at.uv1 - at.uv0;
  let duv2 = at.uv2 - at.uv0;
  let uvDet = duv1.x * duv2.y - duv1.y * duv2.x;
  let hasFrame = abs(uvDet) > 1e-20;
  let r = 1.0 / select(1.0, uvDet, hasFrame);
  let tW = dirM * ((e1 * duv2.y - e2 * duv1.y) * r);
  let bW = dirM * ((e2 * duv1.x - e1 * duv2.x) * r);

  // ray-cone LOD
  let cosT = max(abs(dot(ngW, d)), B5_LOD_MIN_COS);
  let lod = at.lodConst + log2(max(abs(det), 1e-30)) / 3.0 + log2(max(coneW, 1e-12)) - log2(cosT) + b5_frame.lodBias;

  // material
  let texAlb = m.texA & 0xffffu;
  let texNrm = m.texA >> 16u;
  let texB0 = m.texB & 0xffffu;
  let texB1 = m.texB >> 16u;
  var albedoTex = vec3f(1.0);
  if (b5_tex_ok(texAlb)) {
    albedoTex = b5_tex_sample(texAlb, uv, lod).rgb;
  }
  var base = m.baseColor * albedoTex * b5_rgb9e5_decode(inst.tint);
  if ((mflags & B5_MATF_VERTEX_COLORS) != 0u) {
    base *= b5_rgb9e5_decode(at.c0) * w0 + b5_rgb9e5_decode(at.c1) * hit.u + b5_rgb9e5_decode(at.c2) * hit.v;
  }
  var nMap = nI;
  if (b5_tex_ok(texNrm) && hasFrame) {
    let tn = b5_tex_sample(texNrm, uv, lod).rgb * 2.0 - 1.0;
    nMap = b5_apply_normal_map(nI, tW, bW, tn, unpack2x16float(m.nScale));
  }
  var rough = m.rough;
  var emission = vec3f(0.0);
  var water = 0.0;
  var slope = vec2f(0.0);
  var ns = nMap;
  let chScale = b5_frame.channels[ch].rgb;
  s.foam = 0.0;
  s.wtint = vec3f(0.0);
  s.rough0 = rough;

  if (kind == B5_KIND_HULL) {
    var hi: B5HullIn;
    hi.base = base;
    if (b5_tex_ok(texB0)) {
      hi.mask = b5_tex_sample(texB0, uv, lod).rgb;
    }
    let rep = b5_frame.detailRep;
    if (b5_tex_ok(texB1)) {
      hi.dGrass = b5_tex_sample(texB1, uv * rep, lod + log2(rep)).r;
      hi.dPave = b5_tex_sample(texB1, uv * (rep * 0.31), lod + log2(rep * 0.31)).r;
    } else {
      hi.dGrass = 1.0;
      hi.dPave = 1.0;
    }
    hi.baseRough = rough;
    hi.p = vec2f(uv.x * B5_TAU * b5_frame.hullR, uv.y * b5_frame.hullL);
    hi.far = b5_far_from_footprint(coneW);
    var hu: B5HullUniforms;
    hu.time = b5_frame.time;
    hu.flow = b5_frame.flow;
    hu.foam = b5_frame.foam;
    hu.ripple = b5_frame.ripple;
    hu.waterTint = b5_frame.waterTint;
    hu.cityGlow = 1.0;
    hu.citySpill = b5_frame.citySpill;
    let ho = b5_hull_surface(hi, hu);
    // water BSDF inputs: undo the kernel's foam and absorption terms
    // (albedo = mix(bed, waterTint, a) + FOAM · foamK, a = 1 − exp(−absorbK · w))
    let wd = ho.water;
    let fpy = hi.p.y - hu.time * hu.flow;
    let fw = sin(hi.p.x * B5_HULL_FOAM_FX + sin(fpy * B5_HULL_FOAM_FY) * B5_HULL_FOAM_WARP) * 0.5 + 0.5;
    let edge = 1.0 - smoothstep(B5_HULL_FOAM_EDGE_LO, B5_HULL_FOAM_EDGE_HI, wd);
    s.foam = select(0.0, edge * (fw * B5_HULL_FOAM_VAR + B5_HULL_FOAM_BASE) * hu.foam, wd > B5_HULL_FOAM_MIN_DEPTH);
    let ab = 1.0 - exp(-B5_HULL_ABSORB_K * wd);
    let dry = max(ho.albedo - B5_FOAM_COLOR * s.foam, vec3f(0.0));
    s.bed = clamp((dry - hu.waterTint * ab) / max(1.0 - ab, 1e-3), vec3f(0.0), vec3f(1.0));
    s.wtint = hu.waterTint;
    base = ho.albedo;
    rough = ho.roughness;
    water = ho.water;
    slope = ho.slope;
    emission = ho.emissive * b5_frame.channels[B5_CH_CITY_GLOW].rgb;
    if (hasFrame && water > 0.0) {
      let tA = normalize(tW);
      let tZ = normalize(bW);
      let nRip = normalize(nI + tA * slope.x + tZ * slope.y);
      ns = normalize(mix(nMap, nRip, water));
    }
  } else if (kind == B5_KIND_UNLIT) {
    emission = m.emissive * albedoTex * chScale;
    rough = 1.0;
  } else {
    var emTex = vec3f(1.0);
    if (b5_tex_ok(texB1)) {
      emTex = b5_tex_sample(texB1, uv, lod).rgb;
    }
    emission = m.emissive * emTex * chScale;
    if (b5_tex_ok(texB0)) {
      rough *= b5_tex_sample(texB0, uv, lod).g;
    }
  }

  // face-forward, keep ns in the hemisphere of ng
  ns = ns * sgn;
  let dn = dot(ns, s.ng);
  if (dn < 1e-3) {
    ns = normalize(ns + s.ng * (1e-3 - dn));
  }
  s.ns = ns;
  s.albedo = base;
  s.rough = rough;
  s.metal = select(m.metal, 0.0, kind == B5_KIND_UNLIT);
  s.emission = emission;
  s.water = water;
  s.slope = slope;
  s.tint = m.tint;
  s.ior = m.ior;
  if (kind != B5_KIND_HULL) {
    s.bed = base;
  }
  return s;
}

// Emission only (NEE on emissive-triangle lights): the same material fetch,
// ray-cone LOD and texture samples as b5_surface's non-hull branches, without
// normals / hull kernel (keeps k_shade to ONE full b5_surface instance —
// register pressure). Hull triangles are never lights → 0.
fn b5_surface_emission(hit: B5HitRec, rayD: vec3f, coneW: f32) -> vec3f {
  let tri = b5_tris[hit.tri];
  let at = b5_attrs[hit.tri];
  let inst = b5_insts[hit.inst];
  let m = b5_mats[inst.matBase + tri.slot];
  let kind = m.kindFlags & 0xfu;
  if (kind == B5_KIND_HULL) {
    return vec3f(0.0);
  }
  let ch = min((m.kindFlags >> 8u) & 0xffu, B5_CHANNEL_SLOTS - 1u);
  let r0 = inst.w2o0.xyz;
  let r1 = inst.w2o1.xyz;
  let r2 = inst.w2o2.xyz;
  let det = dot(r0, cross(r1, r2));
  let ngW = normalize(mat3x3f(r0, r1, r2) * cross(tri.v1 - tri.v0, tri.v2 - tri.v0));
  let cosT = max(abs(dot(ngW, normalize(rayD))), B5_LOD_MIN_COS);
  let lod = at.lodConst + log2(max(abs(det), 1e-30)) / 3.0 + log2(max(coneW, 1e-12)) - log2(cosT) + b5_frame.lodBias;
  let uv = at.uv0 * (1.0 - hit.u - hit.v) + at.uv1 * hit.u + at.uv2 * hit.v;
  var tex = vec3f(1.0);
  let ti = select(m.texB >> 16u, m.texA & 0xffffu, kind == B5_KIND_UNLIT);
  if (b5_tex_ok(ti)) {
    tex = b5_tex_sample(ti, uv, lod).rgb;
  }
  return m.emissive * tex * b5_frame.channels[ch].rgb;
}

// global emissive-triangle light id of a hit (instance lightBase + attr.light), B5_NO_LIGHT if none
fn b5_surface_light(hit: B5HitRec) -> u32 {
  let lb = b5_inst_light_base(b5_insts[hit.inst].flagsLight);
  let l = b5_attrs[hit.tri].light;
  if (lb == B5_NO_LIGHT || l == B5_NO_LIGHT) {
    return B5_NO_LIGHT;
  }
  return lb + l;
}

// thin-glass material of a hit triangle (shadow transmission): tint.rgb, ior
fn b5_surface_glass(inst: u32, tri: u32) -> vec4f {
  let m = b5_mats[b5_insts[inst].matBase + b5_tris[tri].slot];
  return vec4f(m.tint, m.ior);
}
