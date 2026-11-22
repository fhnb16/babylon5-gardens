/* ═══════════════════════════════════════════════════════════════════════════
   SceneDesc — CONTRACT between core/ and every consumer:
     backends/three (raster, WebGPU + WebGL2), pathtracer/ (WGSL compute),
     backends/threert (native HW ray tracing), tests and bake tools.

   Owner: lead. Other agents treat this file as read-only and request changes.

   Conventions (all consumers rely on them):
   • Station-local space. +Z runs along the axis. θ = atan2(x, y), i.e.
     x = r·sin θ, y = r·cos θ (same as the legacy surfacePos). 1 unit = 10 m.
   • Station rotation is NOT baked in: it is a root transform the backend
     applies (or, for ThreeRT, the camera counter-rotates instead).
   • Winding is CCW seen from the visible side. The hull is emitted facing the
     axis (inward normals) — nobody relies on BackSide.
   • UVs are v-up (three.js convention, row 0 of an image is the TOP: images
     carry origin 'top-left' and backends flip rows if they need to).
   • Colours in descriptors are LINEAR RGB floats unless the field name says
     `Srgb`. Images declare their own colour space.
   • Matrices are column-major Float32Array(16) (three.js / WGSL order).
   • Everything is plain data: typed arrays + JSON-able objects. No classes,
     no functions, no three.js objects. Must be structured-clone-able.
   ═══════════════════════════════════════════════════════════════════════════ */

export type V3 = [number, number, number];
export type Linear3 = [number, number, number];

export type QualityId = 'LOW' | 'HIGH' | 'ULTRAM' | 'ULTRA';
export type SeasonId = 'spring' | 'summer' | 'autumn' | 'winter';
export type PhaseId = 'DAY' | 'DUSK' | 'NIGHT';

/** Everything that determines the generated world. Same params ⇒ identical SceneDesc. */
export interface WorldParams {
  seed: number;
  quality: QualityId;
  season: SeasonId;
  /** palette saturation of crowns, bushes, hills (legacy CONFIG.SATURATION) */
  saturation: number;
  /** greenery density multiplier (legacy CONFIG.GREEN_K) */
  greenK: number;
}

export type ImageId = string;
export type GeoId = string;
export type MatId = string;

/* ─── images ──────────────────────────────────────────────────────────────── */

/** How to (re)generate an image. Generators are pure: same spec ⇒ same pixels. */
export interface TextureSpec {
  /** generator name in core/textures/registry.ts, e.g. 'hullAlbedo', 'facade' */
  gen: string;
  /** generator arguments (JSON-able) — include seed/quality-derived values here */
  args: Record<string, unknown>;
}

export interface ImageDesc {
  width: number;
  height: number;
  format: 'rgba8';
  colorSpace: 'srgb' | 'linear';
  wrap: 'repeat' | 'clamp';
  mipmaps: boolean;
  origin: 'top-left';
  /** max useful anisotropy; backends clamp to device limits / quality preset */
  anisotropyHint: number;
  source: TextureSpec;
  /** filled lazily (worker / bake). length = width*height*4 */
  data?: Uint8Array | Uint8ClampedArray;
}

/* ─── geometry ────────────────────────────────────────────────────────────── */

export interface GeometryGroup {
  start: number;   // first index (or vertex if non-indexed)
  count: number;
  /** index into MeshDesc.materials */
  slot: number;
}

export interface GeometryDesc {
  position: Float32Array;          // xyz
  normal: Float32Array;            // xyz, normalized
  uv: Float32Array;                // uv, v-up
  /** per-vertex linear RGB. NOTE: ThreeRT does not draw vertex colours — see MaterialDesc.flatDither */
  color?: Float32Array;
  index?: Uint16Array | Uint32Array;
  groups: GeometryGroup[];
  bounds: { center: V3; radius: number; min: V3; max: V3 };
}

/* ─── materials ───────────────────────────────────────────────────────────── */

/** A scalar that follows the lighting state: value = state[param]*scale + offset. */
export interface ParamRef {
  param: keyof LightingScalars | 'daylight';
  scale?: number;
  offset?: number;
}

/**
 * Palette channel: a named group of emitters whose power the day cycle
 * drives together. Raster maps it to emissiveIntensity, our path tracer to
 * the emitter power, ThreeRT to Object3D.power.
 */
export type PaletteChannel =
  | 'tube' | 'windows' | 'nav' | 'beacon' | 'towerGlass'
  | 'liftLamp' | 'liftGlass' | 'trafficBody' | 'trafficLamp' | 'cityGlow';

/** Shared shading kernels (core/shading/kernels). */
export type ShaderKernelId = 'hull' | 'wind' | 'fogFade' | 'foliageDither';

export type MaterialModel =
  | 'standard'   // MeshStandardMaterial-equivalent PBR (GGX, metal/rough)
  | 'unlit'      // emits its colour, no lighting (lamps, the tube in raster)
  | 'hull'       // standard + hull kernel (water, foam, ripples, detail, city glow)
  | 'thinGlass'  // thin dielectric (monorail cabins, tower glazing)
  | 'decal'      // multiplicative/alpha contact shadows — raster only
  | 'sprite';    // camera-facing billboards — raster only

export interface MaterialDesc {
  id: MatId;
  model: MaterialModel;
  baseColor: Linear3;
  map?: ImageId;
  normalMap?: ImageId;
  /**
   * AS-RENDERED normal-map scale with three.js FrontSide semantics (tangent frame
   * from UV derivatives, perturbNormal2Arb; n = TBN · ((map·2 − 1) · (sx, sy, 1))).
   * Images from heightToNormal are green-inverted; legacy facades render with
   * (1, 1), the hull with (−1, −1) (three negated it for BackSide). Every consumer
   * (raster, PT, ThreeRT) applies this value as-is — nobody negates by side.
   */
  normalScale?: [number, number];
  roughness: number;
  metalness: number;
  roughnessMap?: ImageId;
  emissive?: Linear3;
  emissiveMap?: ImageId;
  /** raster-relative intensity (legacy emissiveIntensity) */
  emissiveIntensity?: number | ParamRef;
  /** physical luminance at full channel power, cd/m² (nits). Used by PT & ThreeRT. */
  emissiveNits?: number;
  channel?: PaletteChannel;
  /**
   * Raster per-frame driver of emissiveIntensity (emissiveIntensity holds the
   * legacy INITIAL value). E.g. tower glass: {param: 'windowEmission', scale: 0.45};
   * lift glass: {param: 'liftGlassEmission'}. Drives that a ParamRef cannot
   * express are keyed by channel and implemented by the backend:
   *   'tube'   — colour = sunColor × sunEmission × CORE_CONFIG.SUN_HDR
   *   'beacon' — 0.2 + (1 − daylight) × flicker(time)
   */
  emissiveDrive?: ParamRef;
  side: 'front' | 'double';
  alpha: 'opaque' | { mask: number } | { blend: number | ParamRef; additive?: boolean };
  vertexColors?: boolean;
  instanceColors?: boolean;
  flatShading?: boolean;
  /** per-face lightness dither (legacy vertex colours on crowns); amplitude */
  flatDither?: number;
  toneMapped?: boolean;
  depthWrite?: boolean;
  renderOrder?: number;
  kernels?: ShaderKernelId[];
  /** thinGlass only */
  transmissionTint?: Linear3;
  ior?: number;
  /** hint: this surface exists only to fake something a tracer computes for real */
  rasterOnly?: boolean;
}

/* ─── meshes & instancing ─────────────────────────────────────────────────── */

/** Stable semantic tag. Backends set object.name = role. Tests select by role. */
export type Role = string;

export interface InstanceChunk {
  start: number;
  count: number;
  /** angular sector bucket (0..chunks−1) this chunk came from; empty buckets are
      skipped, so bucket ≠ chunk index. Raster names sectored meshes `<role>.s<bucket>`. */
  bucket?: number;
  /** bounding sphere of the chunk in station space: x, y, z, r */
  sphere: [number, number, number, number];
}

export interface InstanceSet {
  count: number;
  matrices: Float32Array;          // 16 * count
  colors?: Float32Array;           // 3 * count, linear
  /** per-instance wind params (2 * count): [0] phase (legacy m[12]·0.7 + m[14]·0.3),
      [1] amplitude multiplier (1 = legacy sway; 0 freezes the instance) */
  wind?: Float32Array;
  /** per-instance free data (4 * count) — ThreeRT customData / PT */
  custom?: Float32Array;
  chunks: InstanceChunk[];
}

export interface MeshDesc {
  role: Role;
  geometry: GeoId;
  /** one per geometry group slot (or a single entry) */
  materials: MatId[];
  /** static local→station transform; identity if absent */
  transform?: Float32Array;
  instances?: InstanceSet;
  /** matrices are rewritten each frame by stepDynamics */
  dynamic?: 'traffic' | 'lifts';
  /** raster: split into one draw per chunk with frustum culling by chunk sphere
      (legacy sectored InstancedMeshes). false/absent: one draw, culling off. */
  sectored?: boolean;
  /** participates in camera collision */
  collider?: boolean;
  /** 'station' rotates with the habitat; 'scene' is fixed (axis-symmetric things) */
  parent: 'station' | 'scene';
  /** emitted only for some backends */
  only?: 'raster' | 'trace';
}

/** Tree crowns: several geometric LOD levels over one instance population. */
export interface LodSetDesc {
  role: Role;
  levels: { geometry: GeoId; material: MatId; role: Role }[];
  near: number;
  mid: number;
  step: number;
  matrices: Float32Array;
  colors: Float32Array;
  centers: Float32Array;           // 3 * count, station space
  wind: Float32Array;              // 2 * count, same meaning as InstanceSet.wind
  chunks: InstanceChunk[];
}

export interface BillboardSetDesc {
  role: Role;                      // 'nav' | 'clouds' | 'motes' (glow = axial billboard mesh, MeshDesc role 'glow')
  positions: Float32Array;         // 3 * count, station or scene space (see parent)
  size: number | ParamRef;         // world units
  material: MatId;
  parent: 'station' | 'scene';
}

/* ─── lights ──────────────────────────────────────────────────────────────── */

/** Physical emitters for tracers. Raster ignores these (uses rasterLights). */
export type EmitterDesc =
  | {
      kind: 'tube';
      /** cylinder along Z, centred on the axis */
      radius: number;
      length: number;
      /** z of the tube START (its minimum z); the tube spans [z0, z0 + length] */
      z0: number;
      channel: 'tube';
      /** mesh role that renders it (so hits on that mesh resolve to this light) */
      role: Role;
    }
  | {
      /** emissive triangles of meshes with this role; sampled per triangle */
      kind: 'meshEmission';
      role: Role;
      channel?: PaletteChannel;
    };

/** Raster stand-ins: hemisphere + point lights on the axis. Tracers MUST ignore. */
export interface RasterLightDesc {
  hemisphere: true;
  /** z positions of axis point lights for the current quality */
  pointZ: number[];
  /** intensity multiplier per light so total output is independent of count */
  perLightScale: number;
  distance: number;
  decay: number;
}

/* ─── hull ────────────────────────────────────────────────────────────────── */

export interface HillDesc {
  theta: number;    // rad
  z: number;
  r: number;
  /** FINAL signed relief amplitude in units: >0 hill (= h), <0 dip (= −h·HILL.dipDepth) */
  rise: number;
  /** oval aspect and rotation (rad) — applied to every hill, not only ponds */
  ax: number;
  rot: number;
  /** water inside a dip (legacy pond record radius = r·HILL.pondFill) */
  pond?: { r: number };
}

/** Texture specs reference their sources as NESTED TextureSpecs (never by image id). */

export interface HullDesc {
  role: 'hull';
  mask: ImageId;          // r = water depth 0..1, g = grass, b = pavement
  detail: ImageId;
  detailRep: number;
  /** truss feet angles (rad) and spar z positions — raster-only analytic shadows */
  armAngles: number[];
  sparZ: number[];
  hills: HillDesc[];
}

/* ─── dynamics ────────────────────────────────────────────────────────────── */

export interface TrafficState {
  lanes: { theta: number; dir: 1 | -1; speed: number }[];
  /** per car: lane index, z. z is f64 holding fround(off) − L/2, where off is the
      legacy Float32 offset — stepping is then bit-exact with legacy updateTraffic. */
  lane: Uint16Array;
  z: Float64Array;
  role: Role;
}

export interface LiftState {
  count: number;
  railAngles: number[];
  speed: number;
  /** current z per lift (f64: long runs must not drift from the legacy doubles),
      direction per lift */
  z: Float64Array;
  dir: Int8Array;
  /** the lift meshes (body/lamp/glass) SHARE one InstanceSet.matrices array;
      stepDynamics writes it once per frame (structuredClone keeps the sharing) */
  roles: Role[];
}

/* ─── views ───────────────────────────────────────────────────────────────── */

export interface ViewDesc {
  ico: string;
  name: string;
  hint: string;
  /** [θ°, r, z] station-local */
  pos: V3;
  look: V3;
}

/* ─── root ────────────────────────────────────────────────────────────────── */

export interface SceneDesc {
  version: 1;
  params: WorldParams;
  frame: { R: number; L: number; metresPerUnit: 10 };
  images: Record<ImageId, ImageDesc>;
  geometries: Record<GeoId, GeometryDesc>;
  materials: Record<MatId, MaterialDesc>;
  meshes: MeshDesc[];
  lodSets: LodSetDesc[];
  billboards: BillboardSetDesc[];
  emitters: EmitterDesc[];
  rasterLights: RasterLightDesc;
  hull: HullDesc;
  dynamics: { traffic?: TrafficState; lifts: LiftState };
  views: ViewDesc[];
  /** stable hash of the layout (placement decisions), for cross-backend parity */
  layoutHash: string;
}

/**
 * A partial scene produced by one builder (core/scene/world.ts for js/world.js,
 * core/scene/structures.ts for js/structures.js). core/scene/build.ts merges
 * fragments: ids must not collide (prefix geometry/material ids by builder:
 * 'w.' for world, 's.' for structures); images are referenced by TEX ids
 * (core/textures/ids.ts) and resolved by the texture registry.
 */
export interface SceneFragment {
  geometries: Record<GeoId, GeometryDesc>;
  materials: Record<MatId, MaterialDesc>;
  meshes: MeshDesc[];
  lodSets?: LodSetDesc[];
  billboards?: BillboardSetDesc[];
  emitters?: EmitterDesc[];
  /** image ids this fragment references, with the spec to generate them */
  images: Record<ImageId, ImageDesc>;
}

/* ─── lighting state (output of core/lighting/phases.ts lightingAt) ──────── */

/** Scalars that ParamRef can point at. */
export interface LightingScalars {
  fogDensity: number;
  hemiIntensity: number;
  pointIntensity: number;
  sunEmission: number;
  glowOpacity: number;
  windowEmission: number;
  navIntensity: number;
  navSize: number;
  cityGlow: number;
  moteOpacity: number;
  sparShade: number;
  cloudOpacity: number;
  moteSize: number;
  blobOpacity: number;
  printOpacity: number;
  liftGlassEmission: number;
  trafficWindow: number;
  trafficLamp: number;
}

export interface LightingState extends LightingScalars {
  /** fractional phase 0..3 (0 DAY → 1 DUSK → 2 NIGHT → 3≡0) */
  phase: number;
  /** 0..1, "how much day" */
  daylight: number;
  /* raster colours, linear */
  fog: Linear3;
  hemiSky: Linear3;
  hemiGround: Linear3;
  pointColor: Linear3;
  sunColor: Linear3;
  moteColor: Linear3;
  waterTint: Linear3;
  /** physical palette for tracers (PT, ThreeRT) */
  phys: PhysState;
}

export interface PhysState {
  /** tube luminance, nits, and linear colour (normalized so max component = 1) */
  tubeNits: number;
  tubeColor: Linear3;
  /** camera exposure, EV100 */
  ev100: number;
  /** per palette channel: luminance in nits at the current phase */
  channelNits: Record<PaletteChannel, number>;
  fogColor: Linear3;
  /** extinction per station unit */
  fogDensity: number;
  waterTint: Linear3;
  cityGlow: number;
}
