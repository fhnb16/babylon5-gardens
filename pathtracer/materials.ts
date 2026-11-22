/* ═══════════════════════════════════════════════════════════════════════════
   Materials of the path tracer: MaterialDesc → packed 64-byte material
   record, and the per-frame palette / surface uniform (B5SurfaceFrame).

   Material record, 64 B (storage buffer `b5_mats`, array stride 64):
     byte  0  baseColor  vec3f  linear base colour (× albedo map × tints)
     byte 12  kindFlags  u32    bits 0..3  kind (MAT_KIND: 0 standard, 1 unlit,
                                           2 hull, 3 thinGlass — = B5Surface.kind)
                                bits 4..7  flags (MAT_FLAG: vertexColors,
                                           instanceColors, flatShading, doubleSided)
                                bits 8..15 palette channel (CHANNELS index,
                                           CH_NONE = static emitter)
                                bits 16..31 material id (index of the MaterialDesc
                                           in SceneDesc.materials key order) — the
                                           value of B5Surface.matId / the matId AOV
     byte 16  emissive   vec3f  linear emission colour; multiplied by the
                                emissive (unlit: albedo) texture and by
                                frame.channels[channel].rgb. For CH_NONE it is
                                pre-multiplied by emissiveNits on the CPU.
     byte 28  rough      f32    roughness (× roughness map .g)
     byte 32  tint       vec3f  thinGlass transmission tint (1,1,1 otherwise)
     byte 44  metal      f32    metalness
     byte 48  texA       u32    albedo texture index (bits 0..15) | normal map (16..31)
     byte 52  texB       u32    roughness map (0..15) | emissive map (16..31);
                                kind = hull: hull mask (0..15) | detail (16..31)
     byte 56  nScale     u32    normalScale.xy as pack2x16float
     byte 60  ior        f32    thinGlass IOR (1.5 when unspecified)
   Texture index = entry of the texture table (textures.ts, B5TexRef);
   NO_TEX (0xFFFF) = no texture.

   Emission units (DECISIONS.md M1): tracer radiance = nits × exposure,
   exposure = exposureFromEv100(phys.ev100). paletteUniform() writes per
   channel rgb = channelNits[ch] × exposure (channel 'tube': tubeColor ×
   tubeNits × exposure — the tube's colour follows the phase, so its
   material colour is forced to white), so a surface of luminance L nits
   lands at L × exposure ≈ the raster value at tonemap exposure 1.
   Material colours are plain linear multipliers of the channel luminance
   (no renormalisation; wave 4 calibrates).
   ═══════════════════════════════════════════════════════════════════════════ */

import type { LightingState, MaterialDesc, PaletteChannel } from '../core/scene/types.ts';
import { CORE_CONFIG } from '../core/config/index.ts';
import { exposureFromEv100 } from '../core/lighting/phases.ts';

/* ─── material record ─────────────────────────────────────────────────────── */

export const MAT_BYTES = 64;
export const MAT_WORDS = 16;
export const MAT_OFFSETS = {
  baseColor: 0, kindFlags: 12, emissive: 16, rough: 28, tint: 32, metal: 44,
  texA: 48, texB: 52, nScale: 56, ior: 60
} as const;
export const MAT_W = {
  baseColor: 0, kindFlags: 3, emissive: 4, rough: 7, tint: 8, metal: 11,
  texA: 12, texB: 13, nScale: 14, ior: 15
} as const;

/** B5Surface.kind values */
export const MAT_KIND = { standard: 0, unlit: 1, hull: 2, thinGlass: 3 } as const;
export type MatKindName = keyof typeof MAT_KIND;

export const MAT_FLAG = { vertexColors: 1, instanceColors: 2, flatShading: 4, doubleSided: 8 } as const;

export const NO_TEX = 0xffff;
export const MAX_MATERIAL_ID = 0xffff;

/** Palette channel order (index into B5SurfaceFrame.channels). */
export const CHANNELS: readonly PaletteChannel[] = [
  'tube', 'windows', 'nav', 'beacon', 'towerGlass',
  'liftLamp', 'liftGlass', 'trafficBody', 'trafficLamp', 'cityGlow'
];
/** "no channel": static emitter, frame.channels[CH_NONE] = exposure */
export const CH_NONE = CHANNELS.length;
export const CH_CITY_GLOW = CHANNELS.indexOf('cityGlow');
export const CH_TUBE = CHANNELS.indexOf('tube');
/** channels array length in the frame uniform (10 channels + none + reserved) */
export const CHANNEL_SLOTS = 12;

/** Texture references of one material, as texture-table indices (NO_TEX = none). */
export interface MaterialTextures {
  albedo: number;
  normal: number;
  rough: number;
  emissive: number;
  /** hull only */
  mask?: number;
  detail?: number;
}

/** Decoded material record (CPU mirror of the WGSL struct). */
export interface PackedMaterial {
  baseColor: [number, number, number];
  kind: number;
  flags: number;
  channel: number;
  id: number;
  emissive: [number, number, number];
  rough: number;
  tint: [number, number, number];
  metal: number;
  tex: MaterialTextures;
  normalScale: [number, number];
  ior: number;
}

export function materialKind(m: MaterialDesc): number {
  switch (m.model) {
    case 'standard': return MAT_KIND.standard;
    case 'unlit': return MAT_KIND.unlit;
    case 'hull': return MAT_KIND.hull;
    case 'thinGlass': return MAT_KIND.thinGlass;
    default: throw new Error(`material ${m.id}: model '${m.model}' is raster-only`);
  }
}

/** Materials the tracer skips (decals, sprites, rasterOnly hints). */
export function isRasterOnlyMaterial(m: MaterialDesc): boolean {
  return m.model === 'decal' || m.model === 'sprite' || !!m.rasterOnly;
}

/** True when the material emits light in the tracer. */
export function isEmissiveMaterial(m: MaterialDesc): boolean {
  if (isRasterOnlyMaterial(m)) return false;
  if (m.channel !== undefined) return m.model === 'unlit' || !!m.emissive;
  return (m.emissiveNits ?? 0) > 0 && (m.model === 'unlit' || !!m.emissive);
}

/** Build the CPU-side record of one material. */
export function describeMaterial(m: MaterialDesc, id: number, tex: MaterialTextures): PackedMaterial {
  if (id < 0 || id > MAX_MATERIAL_ID) throw new RangeError(`material id ${id} out of range`);
  const kind = materialKind(m);
  let flags = 0;
  if (m.vertexColors) flags |= MAT_FLAG.vertexColors;
  if (m.instanceColors) flags |= MAT_FLAG.instanceColors;
  if (m.flatShading) flags |= MAT_FLAG.flatShading;
  if (m.side === 'double') flags |= MAT_FLAG.doubleSided;
  const channel = m.channel !== undefined ? CHANNELS.indexOf(m.channel) : CH_NONE;
  if (channel < 0) throw new Error(`material ${m.id}: unknown palette channel ${m.channel}`);
  /* emission colour: unlit → its base colour (the albedo map modulates it in
     the shader), others → `emissive`. The tube follows frame.tubeColor. */
  let em: [number, number, number] = kind === MAT_KIND.unlit ? [...m.baseColor] : m.emissive ? [...m.emissive] : [0, 0, 0];
  if (channel === CH_TUBE) em = [1, 1, 1];
  if (channel === CH_NONE) {
    const nits = m.emissiveNits ?? 0;
    em = [em[0] * nits, em[1] * nits, em[2] * nits];
  }
  return {
    baseColor: [...m.baseColor],
    kind, flags, channel, id,
    emissive: em,
    rough: m.roughness,
    tint: m.transmissionTint ? [...m.transmissionTint] : [1, 1, 1],
    metal: m.metalness,
    tex: { ...tex },
    normalScale: m.normalScale ? [m.normalScale[0], m.normalScale[1]] : [1, 1],
    ior: m.ior ?? 1.5
  };
}

/* f16 pack/unpack (pack2x16float rounding: round to nearest even) */
const f32buf = new Float32Array(1);
const u32buf = new Uint32Array(f32buf.buffer);
export function toHalf(x: number): number {
  f32buf[0] = x;
  const b = u32buf[0];
  const sign = (b >>> 16) & 0x8000;
  const exp = (b >>> 23) & 0xff;
  let mant = b & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
  let e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - e;
    let h = mant >>> shift;
    const rem = mant & ((1 << shift) - 1), half = 1 << (shift - 1);
    if (rem > half || (rem === half && (h & 1))) h++;
    return sign | h;
  }
  let h = (e << 10) | (mant >>> 13);
  const rem = mant & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && (h & 1))) h++;
  if (((h >>> 10) & 0x1f) === 0x1f) { e = 0x1f; h = e << 10; }
  return sign | h;
}
export function fromHalf(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >>> 10) & 0x1f, m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 0x1f) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

/** Write one record at index `i` of a material buffer. */
export function writeMaterial(buf: ArrayBuffer, i: number, p: PackedMaterial): void {
  const F = new Float32Array(buf, i * MAT_BYTES, MAT_WORDS);
  const U = new Uint32Array(buf, i * MAT_BYTES, MAT_WORDS);
  F.set(p.baseColor, MAT_W.baseColor);
  U[MAT_W.kindFlags] = ((p.kind & 0xf) | ((p.flags & 0xf) << 4) | ((p.channel & 0xff) << 8) | ((p.id & 0xffff) << 16)) >>> 0;
  F.set(p.emissive, MAT_W.emissive);
  F[MAT_W.rough] = p.rough;
  F.set(p.tint, MAT_W.tint);
  F[MAT_W.metal] = p.metal;
  const t = p.tex;
  const isHull = p.kind === MAT_KIND.hull;
  U[MAT_W.texA] = ((t.albedo & 0xffff) | ((t.normal & 0xffff) << 16)) >>> 0;
  U[MAT_W.texB] = isHull
    ? (((t.mask ?? NO_TEX) & 0xffff) | (((t.detail ?? NO_TEX) & 0xffff) << 16)) >>> 0
    : ((t.rough & 0xffff) | ((t.emissive & 0xffff) << 16)) >>> 0;
  U[MAT_W.nScale] = (toHalf(p.normalScale[0]) | (toHalf(p.normalScale[1]) << 16)) >>> 0;
  F[MAT_W.ior] = p.ior;
}

/** Decode record `i` (tests, surface-ref). */
export function readMaterial(buf: ArrayBuffer, i: number): PackedMaterial {
  const F = new Float32Array(buf, i * MAT_BYTES, MAT_WORDS);
  const U = new Uint32Array(buf, i * MAT_BYTES, MAT_WORDS);
  const kf = U[MAT_W.kindFlags];
  const kind = kf & 0xf;
  const a = U[MAT_W.texA], b = U[MAT_W.texB], ns = U[MAT_W.nScale];
  const isHull = kind === MAT_KIND.hull;
  return {
    baseColor: [F[0], F[1], F[2]],
    kind, flags: (kf >>> 4) & 0xf, channel: (kf >>> 8) & 0xff, id: kf >>> 16,
    emissive: [F[4], F[5], F[6]],
    rough: F[MAT_W.rough],
    tint: [F[8], F[9], F[10]],
    metal: F[MAT_W.metal],
    tex: isHull
      ? { albedo: a & 0xffff, normal: a >>> 16, rough: NO_TEX, emissive: NO_TEX, mask: b & 0xffff, detail: b >>> 16 }
      : { albedo: a & 0xffff, normal: a >>> 16, rough: b & 0xffff, emissive: b >>> 16 },
    normalScale: [fromHalf(ns & 0xffff), fromHalf(ns >>> 16)],
    ior: F[MAT_W.ior]
  };
}

/* ─── surface frame uniform (palette + hull parameters) ───────────────────── */

/*
   B5SurfaceFrame, 256 B (uniform, group 2):
     byte   0  channels   array<vec4f, 12>  rgb = radiance scale per palette
                                            channel (CHANNELS order), [10] =
                                            CH_NONE (exposure), [11] reserved
     byte 192  waterTint  vec3f   phys.waterTint (hull kernel)
     byte 204  time       f32     seconds (hull ripples / foam; frozen in photo mode)
     byte 208  flow       f32     CONFIG.RIVER_FLOW
     byte 212  foam       f32     CONFIG.WATER.foam
     byte 216  ripple     f32     CONFIG.WATER.ripple
     byte 220  citySpill  f32     CONFIG.CITY.spill
     byte 224  detailRep  f32     HullDesc.detailRep
     byte 228  hullR      f32     CONFIG.R  (hull p.x = u · 2πR)
     byte 232  hullL      f32     CONFIG.L  (hull p.y = v · L)
     byte 236  exposure   f32     exposureFromEv100(phys.ev100)
     byte 240  lodBias    f32     added to every ray-cone texture LOD
     byte 244  r0, r1, r2 f32     reserved (0)
*/
export const FRAME_BYTES = 256;
export const FRAME_FLOATS = 64;
export const FRAME_OFFSETS = {
  channels: 0, waterTint: 192, time: 204, flow: 208, foam: 212, ripple: 216, citySpill: 220,
  detailRep: 224, hullR: 228, hullL: 232, exposure: 236, lodBias: 240, r0: 244, r1: 248, r2: 252
} as const;
export const FRAME_F = Object.fromEntries(Object.entries(FRAME_OFFSETS).map(([k, v]) => [k, v / 4])) as
  { readonly [K in keyof typeof FRAME_OFFSETS]: number };

export interface FrameOptions {
  /** seconds (default 0) */
  time?: number;
  /** HullDesc.detailRep (default CORE_CONFIG.DETAIL_REP) */
  detailRep?: number;
  /** texture LOD bias (default 0) */
  lodBias?: number;
}

/** Emission scale of every palette channel (CHANNEL_SLOTS × rgb). */
export function channelScales(state: LightingState): Float32Array {
  const ph = state.phys;
  const exposure = exposureFromEv100(ph.ev100);
  const out = new Float32Array(CHANNEL_SLOTS * 4);
  CHANNELS.forEach((ch, i) => {
    const s = (ch === 'tube' ? ph.tubeNits : ph.channelNits[ch]) * exposure;
    const c = ch === 'tube' ? ph.tubeColor : [1, 1, 1];
    out[i * 4] = c[0] * s; out[i * 4 + 1] = c[1] * s; out[i * 4 + 2] = c[2] * s; out[i * 4 + 3] = s;
  });
  out[CH_NONE * 4] = out[CH_NONE * 4 + 1] = out[CH_NONE * 4 + 2] = out[CH_NONE * 4 + 3] = exposure;
  return out;
}

/** The B5SurfaceFrame uniform for a lighting state (64 floats = 256 B). */
export function paletteUniform(state: LightingState, opts: FrameOptions = {}): Float32Array {
  const f = new Float32Array(FRAME_FLOATS);
  f.set(channelScales(state), FRAME_F.channels);
  const wt = state.phys.waterTint;
  f[FRAME_F.waterTint] = wt[0]; f[FRAME_F.waterTint + 1] = wt[1]; f[FRAME_F.waterTint + 2] = wt[2];
  f[FRAME_F.time] = opts.time ?? 0;
  f[FRAME_F.flow] = CORE_CONFIG.RIVER_FLOW;
  f[FRAME_F.foam] = CORE_CONFIG.WATER.foam;
  f[FRAME_F.ripple] = CORE_CONFIG.WATER.ripple;
  f[FRAME_F.citySpill] = CORE_CONFIG.CITY.spill;
  f[FRAME_F.detailRep] = opts.detailRep ?? CORE_CONFIG.DETAIL_REP;
  f[FRAME_F.hullR] = CORE_CONFIG.R;
  f[FRAME_F.hullL] = CORE_CONFIG.L;
  f[FRAME_F.exposure] = exposureFromEv100(state.phys.ev100);
  f[FRAME_F.lodBias] = opts.lodBias ?? 0;
  return f;
}

/** WGSL declarations of the material record + frame uniform (+ constants). */
export function emitWgslMaterials(): string {
  const L: string[] = ['// generated by pathtracer/materials.ts — do not edit'];
  for (const [k, v] of Object.entries(MAT_KIND)) L.push(`const B5_KIND_${k.toUpperCase()}: u32 = ${v}u;`);
  L.push(`const B5_MATF_VERTEX_COLORS: u32 = ${MAT_FLAG.vertexColors}u;`);
  L.push(`const B5_MATF_INSTANCE_COLORS: u32 = ${MAT_FLAG.instanceColors}u;`);
  L.push(`const B5_MATF_FLAT: u32 = ${MAT_FLAG.flatShading}u;`);
  L.push(`const B5_MATF_DOUBLE: u32 = ${MAT_FLAG.doubleSided}u;`);
  L.push(`const B5_NO_TEX: u32 = 0x${NO_TEX.toString(16)}u;`);
  L.push(`const B5_CH_NONE: u32 = ${CH_NONE}u;`);
  L.push(`const B5_CH_CITY_GLOW: u32 = ${CH_CITY_GLOW}u;`);
  L.push(`const B5_CHANNEL_SLOTS: u32 = ${CHANNEL_SLOTS}u;`);
  L.push('',
    `// size ${MAT_BYTES} B`,
    'struct B5Material {',
    `  baseColor: vec3f, // @${MAT_OFFSETS.baseColor}`,
    `  kindFlags: u32, // @${MAT_OFFSETS.kindFlags}`,
    `  emissive: vec3f, // @${MAT_OFFSETS.emissive}`,
    `  rough: f32, // @${MAT_OFFSETS.rough}`,
    `  tint: vec3f, // @${MAT_OFFSETS.tint}`,
    `  metal: f32, // @${MAT_OFFSETS.metal}`,
    `  texA: u32, // @${MAT_OFFSETS.texA}`,
    `  texB: u32, // @${MAT_OFFSETS.texB}`,
    `  nScale: u32, // @${MAT_OFFSETS.nScale}`,
    `  ior: f32, // @${MAT_OFFSETS.ior}`,
    '}',
    '',
    `// size ${FRAME_BYTES} B`,
    'struct B5SurfaceFrame {',
    `  channels: array<vec4f, ${CHANNEL_SLOTS}>, // @0`,
    `  waterTint: vec3f, // @${FRAME_OFFSETS.waterTint}`,
    `  time: f32, // @${FRAME_OFFSETS.time}`,
    `  flow: f32, // @${FRAME_OFFSETS.flow}`,
    `  foam: f32, // @${FRAME_OFFSETS.foam}`,
    `  ripple: f32, // @${FRAME_OFFSETS.ripple}`,
    `  citySpill: f32, // @${FRAME_OFFSETS.citySpill}`,
    `  detailRep: f32, // @${FRAME_OFFSETS.detailRep}`,
    `  hullR: f32, // @${FRAME_OFFSETS.hullR}`,
    `  hullL: f32, // @${FRAME_OFFSETS.hullL}`,
    `  exposure: f32, // @${FRAME_OFFSETS.exposure}`,
    `  lodBias: f32, // @${FRAME_OFFSETS.lodBias}`,
    `  r0: f32, // @${FRAME_OFFSETS.r0}`,
    `  r1: f32, // @${FRAME_OFFSETS.r1}`,
    `  r2: f32, // @${FRAME_OFFSETS.r2}`,
    '}',
    ''
  );
  return L.join('\n');
}
