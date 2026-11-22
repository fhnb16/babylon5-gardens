# Path tracer — design decisions log

Short, dated decisions that later units must follow. Owner: lead.

## 2026-11-18 — BVH / traversal (after unit A5)

Layouts are defined in `pathtracer/bvh/layout.ts` (single source of truth;
`emitWgslLayout()` produces the matching WGSL). BVH2 node 64 B, triangle
record 48 B (vertex form, `primId`, `slot`, `aux` = BLAS index), instance
record 64 B (worldToObject rows, `blasRoot`, `matBase`, RGB9E5 `tint`,
`flagsLight`).

Answers to the open questions for the WGSL traversal unit:

1. **Stack.** Private array of 32 entries (measured max: 6 hull, 15 two-level).
   On overflow, drop the farthest entry and count it in a debug counter
   (`b5_dbg.stackOverflow`). Revisit with a short-stack + restart scheme only
   if the counter is ever non-zero on real scenes. Make the size an `override`.
2. **f32 behaviour.** Add an f32-emulating mode to `traverse-ref.ts`
   (`Math.fround` at every arithmetic step of the slab and Woop tests), so GPU
   results can be compared bit-for-bit. Keep the f64 mode as the geometric oracle.
3. **tmax.** Rays always use a finite tmax (`1e30` for camera/indirect rays,
   the light distance × (1 − ε) for shadow rays).
4. **Facing.** Intersection stays double-sided. The hit returns a
   `frontFace` flag (sign of det in object space); shading flips the normal to
   face the incoming ray. Per-material culling: not needed.
5. **Attributes.** Gather per-triangle shading attributes in TRIANGLE-RECORD
   order into a parallel buffer (same index as the triangle record):
   3 × (oct16 normal, unorm16/f16 uv, unorm8×4 colour) + `materialSlot` +
   `lodConst` (ray-cone texture LOD) + `lightLocalIdx`. One fetch per hit, no
   indirection through `primId`. `primId`/`aux` stay for debugging and picking.
6. **Dynamic instances.** (see below)

## 2026-11-19 — WGSL traversal (after unit B5)

- **Stack size is a loader define, not an `override`**: WGSL allows
  override-sized arrays only in workgroup memory. Private stack size =
  `B5_TRAVERSE_STACK` (default 32). Overflow replaces the farthest entry at
  the current level or drops the new one, and increments `b5_dbg.stackOverflow`.
  `layout.ts` `B5_STACK_SIZE = 68` is the theoretical depth bound only — not
  used by kernels.
- **frontFace** = det > 0, i.e. (v1−v0)×(v2−v0) faces against the ray.
- **Misses** use the finite sentinel `B5_MISS = 3e38` (never inf).
- **Bind groups**: group 0 = static scene (nodes, tris, instances, debug
  counters); group 1 = per-dispatch (params, rays, output). Later kernels add
  group 2 = textures/materials, group 3 = accumulation/AOV outputs.
- **Device for wave 3**: `createDevice({ forThree: true })` and pass it to
  `new WebGPURenderer({ device })` — without `core-features-and-limits` three
  r187 drops to compatibility mode (no MSAA).
- Measured on RTX 3070 / Edge, 1080p, 197k tris / 3.5k instances, BVH2 +
  private stack: primary ~200 Mrays/s, incoherent ~85, shadow ~125. GPU vs
  f32 CPU reference: 100 % agreement, shadow bit-identical.

## 2026-11-19 — M1 interface between scene upload (U3) and integrator (U4)

U3 owns `pathtracer/scene-upload.ts`, `textures.ts`, `materials.ts` and
`wgsl/surface.wgsl`; U4 owns the integrator and kernels. The seam is ONE WGSL
function plus host-side bind group 2:

```wgsl
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
}
fn b5_surface(hit: B5HitRec, rayO: vec3f, rayD: vec3f, coneW: f32) -> B5Surface
```

- Group 2 (bind group layout exported by `scene-upload.ts` as
  `surfaceBindGroupLayoutEntries`): per-triangle attribute buffer (in
  triangle-record order, DECISIONS item 5), material table, instance-material
  table, texture arrays by size class + sampler, palette/frame uniform
  (lighting channels, time, emissive scale).
- Hull: `b5_surface` evaluates the shared kernel `b5_hull_surface` emitted by
  `core/shading/emit/wgsl.ts` with `raster: false` (truss shadow and mirror
  excluded); `far` = `farFromFootprint(coneW)`.
- Emission units: tracer works in "scene radiance" = nits × exposure
  (`exposureFromEv100(phys.ev100)`) so the output feeds the existing tonemap
  near 1.0.

## 2026-11-19 — after M1 (U3 + U4)

- **M1 reached**: the real station renders progressively (960×540, 64 spp in
  ~1.8 s on RTX 3070, ~80 Mrays/s incl. shadow rays); furnace test 0.014 %;
  tube MIS vs CPU reference within 1σ.
- **WGSL naming across include files**: every module-scope identifier is
  prefixed by its owner: `b5_` + area (`b5_surf_*`, `b5_trav_*`, `b5_int_*`,
  `b5_wave`, `b5_frame` = surface frame uniform …). Bindings are declared only
  in the file that owns the group (group 0 traverse, group 1 integrator,
  group 2 surface.wgsl, group 3 integrator).
- **Storage-buffer budget**: groups 0 + 2 use 6; devices must provide ≥ 8
  (`MIN_LIMITS`); we request min(adapter, 10).
- **Two `GpuScene` types** exist (`gpu-scene.ts` smoke helper vs
  `scene-upload.ts` real upload) — import the upload one as `GpuScene`, alias
  the smoke one. Rename the smoke one when convenient.
- **Output colour** = nits × exposure (contract `AOV_FORMATS.color`); the
  presenter/post chain applies exposure ≈ 1.
- **Known gaps → wave 4**: equiangular tube sampling; emissive-triangle light
  sampling (attr.light + prepared.emissiveTris exist; instance `lightBase`
  still NO_LIGHT); water/thin-glass BSDFs and glass shadow transmission;
  Sobol + adaptive stop; denoiser; splitting full-frame waves to keep submits
  ≤ 40 ms; PHYS palette calibration (NIGHT renders far too bright).

## 2026-11-19 — after PT-W4a (lights, BSDFs, calibration)

- **Tube**: equiangular in z + visible-band φ sampling (`light_tube.wgsl`,
  CPU `lights/tube.ts`), `b5_tube_pdf` for MIS; variance ×10–74 lower than
  uniform area at test points. Uniform area kept behind `tubeMode`.
- **Triangle lights**: `k_lightpower` (GPU power with the surface code) →
  alias table (L1) + light BVH with orientation cones (L2, pbrt-v4), built in a
  worker; p_tube = I_tube/(I_tube+I_root) clamped 0.05–0.95. Instance
  `lightBase`; light id = lightBase + attr.light. After `updateDynamics` call
  `integrator.updateLights()`.
- **BSDFs**: `bsdf_std` (Lambert·(1−metal)·(1−F) + GGX height-correlated,
  VNDF), `bsdf_glass` (thin, R′ = 2R/(1+R), delta), `bsdf_water` (IOR 1.33
  GGX interface + absorbed bed; equals raster mix at normal incidence),
  stochastic foam/water/dry blend. Shadow rays through `INST_GLASS`
  (= 1<<6) instances are attenuated (`k_shadow_tr` + `traverse_tr`).
- **Camera is a delta vertex** (`B5_PF_DELTA` in raygen) — fixes MIS weight 0
  for emitters seen through glass.
- **Layouts**: B5Surface += bed, foam, wtint, rough0; B5Path 128 B; B5Frame
  160 B. k_shade binds 9 storage buffers → `MIN_LIMITS` = 9 (RTX 3070: 10).
- **maxPaths default 2^18** (≈60 MB of wave buffers; avoids VRAM eviction when
  other processes hold the GPU) + per-region cost model keeps submits ≤ 40 ms.
- **PHYS calibrated** (`tools/calibrate.ts`) and moved into
  `CORE_CONFIG.PHYS`; first guess was ×4.4 too bright by day, ×57 at night.
  Traced vs raster displayed luminance: within ~±25 % where fog is weak; the
  rest is the raster's FogExp2 haze (tracer has no media yet).
- **Open**: sparse-window power estimate (16 points miss windows); p_tube often
  clamped at night (pbrt d² clamp inflates root importance); no fog; triangle
  lights sampled by area not solid angle; Sobol / adaptive stop / denoise;
  tower glass bands could be `openEnded` (caps inside concrete waste NEE).

## 2026-11-19 — after PT-P4 (sampling, convergence, denoise, public API)

- **Sampler**: Owen-scrambled Sobol (Burley 2020, Laine–Karras hash), 4-D
  groups; dims 0–1 pixel jitter, then 8 dims per bounce from `4 + 8·depth`
  (BSDF dir 2, lobe, layer, light pos 2, light pick, RR); sample index =
  pixel's own count (`accum.w`). PCG behind `B5_F_SOBOL` off. Station: ~4.7×
  lower variance at equal spp, ~20 % more GPU time.
- **Convergence**: half-buffer error with tonemap weighting, 16×16 tiles
  reduced on GPU each step (8 KB readback), converged tiles leave the active
  list (`B5_F_TILES`). `noiseNow()` = p95 tile error; `samplesNeeded()` =
  ceil(1e4/noise²) is the per-pixel cap. Sobol makes the half-buffer estimate
  read high → empirical `CONVERGENCE.sobolCalibration = 0.667`.
- **Regularization** (`regK`) available, OFF by default (biased; little gain here).
- **Layouts**: B5Frame 176 B (+ regK, tilesX, activeSlots, toneExp, convEps);
  B5Path pad words reused as aux/alb/nrm; per-pixel half buffer 4 B + AOV
  accumulation 32 B; `k_shade` binds ldata at binding 5, no storage textures.
- **Denoise** uses either à-trous / SVGF-lite (4 levels, σl 2) or the
  `oidn-webgpu` 0.6.0 adapter. See the application integration below.
- **Public API** in `pathtracer/index.ts` accepts a station-frame camera.
  `pt.samples` reports mean samples per pixel.

### Dynamic instances (from 2026-11-18) Rebuild of the dynamic TLAS via `updateDynamic`
   (< 1 ms for a few hundred instances) is the plan; refit via parent links
   only if profiling asks for it.

## 2026-11-22 — P-INT (2.13.0)

- Photo mode captures the camera, lighting phase and live traffic and lift
  matrices before asynchronous GPU setup. Each moving population supplies
  one frozen array for its bodies and lamps. Disabled traffic and the
  cabin glass hidden during a ride are excluded from the uploaded scene.
  Static geometry and texture descriptors retain their original storage.
- On WebGPU, three and the integrator share a device. The post chain samples
  raw or denoised HDR through r187's ExternalTexture and applies the raster
  exposure and tone mapping. Classic and WebGL2 display the WebGPU tracer
  on an overlay. Classic retains the legacy path on WebGL-only devices.
- Pause loads the selected denoiser. OIDN loads its model from the bundled
  `public/oidn` weights and uses the integrator's colour, albedo and normal
  textures. If OIDN fails, à-trous cleans the retained accumulation. Edge
  integration tests check the denoiser reported by the HUD and the saved PNG.
