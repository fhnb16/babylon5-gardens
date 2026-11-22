/* ═══════════════════════════════════════════════════════════════════════════
   Core configuration — world-relevant constants, palettes, views.

   Owner: lead. Values are copied 1:1 from js/config.js (legacy, still used by
   the running app) and kept in sync by core/test/config-sync.test.ts until the
   legacy file is retired. UI / post-processing / photo-mode settings stay in
   js/config.js (app concerns), they are NOT part of the core.

   The core never mutates this object. Runtime choices (seed, quality, season,
   saturation, green density) travel as WorldParams.
   ═══════════════════════════════════════════════════════════════════════════ */

import type { PaletteChannel, PhaseId, QualityId, SeasonId, V3 } from '../scene/types.ts';

export interface QualityPreset {
  count: 0 | 1;
  foliage: 0 | 1 | 2;
  trees: number;
  hullTex: number;
  mask: number;
  aniso: number;
  dpr: number;
  footprint: boolean;
  normals: number;
  lights: 3 | 5;
  mirror: 0 | 1;
  chunks: number;
  rings: number;
}

export interface Palette {
  light: number;
  fog: number; fogD: number;
  hemiSky: number; hemiGround: number; hemiInt: number;
  pointCol: number; pointInt: number;
  sunCol: number; glowOp: number; sunEmis: number;
  winEmis: number; navInt: number; navSize: number;
  cityGlow: number;
  moteCol: number; moteOp: number;
  waterTint: number; sparShade: number;
}

/**
 * Physical palette for tracers (our WebGPU path tracer and ThreeRT).
 * INITIAL VALUES — to be calibrated in wave 4 so that the traced image at
 * exposure(ev100) matches the raster look. Luminances in cd/m² (nits).
 */
export interface PhysPalette {
  tubeNits: number;
  ev100: number;
  /** nits at full power, per palette channel */
  channelNits: Record<PaletteChannel, number>;
}

const QUALITY: Record<QualityId, QualityPreset> = {
  LOW:    { count: 1, foliage: 0, trees: 1.0,  hullTex: 1024, mask: 512,  aniso: 4,  dpr: 0, footprint: false, normals: 0,    lights: 3, mirror: 0, chunks: 4, rings: 40 },
  HIGH:   { count: 0, foliage: 1, trees: 1.0,  hullTex: 2048, mask: 1024, aniso: 8,  dpr: 4, footprint: true,  normals: 1024, lights: 5, mirror: 0, chunks: 8, rings: 96 },
  ULTRAM: { count: 0, foliage: 1, trees: 0.85, hullTex: 2048, mask: 2048, aniso: 8,  dpr: 3, footprint: true,  normals: 1024, lights: 3, mirror: 1, chunks: 4, rings: 64 },
  ULTRA:  { count: 0, foliage: 2, trees: 1.3,  hullTex: 2048, mask: 2048, aniso: 16, dpr: 4, footprint: true,  normals: 2048, lights: 5, mirror: 1, chunks: 8, rings: 128 },
};

const DAY: Palette = {
  light: 1.0,
  fog: 0xb8cfe0, fogD: 0.0020,
  hemiSky: 0xdcefff, hemiGround: 0x5c7f46, hemiInt: 1.35,
  pointCol: 0xfff0c4, pointInt: 0.95,
  sunCol: 0xfff7dc, glowOp: 0.85, sunEmis: 1.0,
  winEmis: 0.0, navInt: 0.2, navSize: 1.1,
  cityGlow: 0.0,
  moteCol: 0xffffff, moteOp: 0.25,
  waterTint: 0x1f4260, sparShade: 0.55,
};
const DUSK: Palette = {
  light: 0.5,
  fog: 0xc09068, fogD: 0.0026,
  hemiSky: 0xffc98f, hemiGround: 0x6d5334, hemiInt: 0.62,
  pointCol: 0xffb75f, pointInt: 0.46,
  sunCol: 0xffb066, glowOp: 1.0, sunEmis: 0.85,
  winEmis: 0.5, navInt: 0.55, navSize: 1.5,
  cityGlow: 0.35,
  moteCol: 0xffd9a0, moteOp: 0.5,
  waterTint: 0x2a4058, sparShade: 0.72,
};
const NIGHT: Palette = {
  light: 0.0,
  fog: 0x101a2e, fogD: 0.0032,
  hemiSky: 0x2c3d5e, hemiGround: 0x243248, hemiInt: 0.72,
  pointCol: 0x93b0da, pointInt: 0.26,
  sunCol: 0x537cb8, glowOp: 0.38, sunEmis: 0.32,
  winEmis: 0.9, navInt: 1.2, navSize: 2.3,
  cityGlow: 0.5,
  moteCol: 0xffd27a, moteOp: 0.45,
  waterTint: 0x0c1727, sparShade: 0.12,
};

/* Physical palette — CALIBRATED against the raster look (pathtracer/tools/
   calibrate.ts, 2026-11-19): raster floor irradiance (hemi + axis point lights,
   three r187 falloff) vs tube direct irradiance × interreflection gain G ≈ 1.24
   (ρ̄ = 0.22); emissive channels so that nits × exposure(ev100) equals the
   raster emissive intensity from the drives. EV100 kept from the first guess.
   pathtracer/test/calibrate.test.ts keeps this table equal to the tool output. */
const PHYS: Record<PhaseId, PhysPalette> = {
  DAY: {
    tubeNits: 33900, ev100: 12.5,
    channelNits: { tube: 33900, windows: 0, nav: 1390, beacon: 1390, towerGlass: 0,
      liftLamp: 6950, liftGlass: 2090, trafficBody: 348, trafficLamp: 834, cityGlow: 0 },
  },
  DUSK: {
    tubeNits: 7000, ev100: 11.0,
    channelNits: { tube: 7000, windows: 1230, nav: 1350, beacon: 1720, towerGlass: 553,
      liftLamp: 2460, liftGlass: 2090, trafficBody: 737, trafficLamp: 4080, cityGlow: 860 },
  },
  NIGHT: {
    tubeNits: 52.7, ev100: 6.5,
    channelNits: { tube: 52.7, windows: 97.8, nav: 109, beacon: 130, towerGlass: 44,
      liftLamp: 109, liftGlass: 152, trafficBody: 59.7, trafficLamp: 348, cityGlow: 54.3 },
  },
};

export const CORE_CONFIG = {
  SEED_DEFAULT: 1337,
  SEASON_DEFAULT: 'summer' as SeasonId,
  SATURATION_DEFAULT: 0.62,
  GREEN_K_DEFAULT: 1,

  R: 50, L: 300, HULL_SEG: 256,
  HULL_RINGS: 96,
  HULL_TEX: { HIGH: 2048, LOW: 1024 },
  MASK_TEX: 1024,
  DETAIL_REP: 70,

  SECT: {
    cities: [[5, 45], [125, 165], [245, 285]] as [number, number][],
    fields: [[170, 240]] as [number, number][],
    parks:  [[60, 110], [300, 355]] as [number, number][],
    rivers: [[112, 118], [292, 298]] as [number, number][],
  },

  AXIS: {
    spineR: 2.6, ribEvery: 25, liftR: 1.5, liftSpeed: 11,
    railAngles: [0, Math.PI],
    spars: [-105, -35, 35, 105],
    sparArms: 3, sparAngle: 84,
    trussW: 2.6, trussBay: 7, baseR: 6.0,
    column: { top: 0.62, bottom: 1.25, seg: 14, ringStep: 7.5, ringH: 0.7 },
    saddle: { r: 3.4, w: 3.2 },
  },

  TOWER: { deg: 25, z: 90, h: 22, modelH: 34, plinthR: 10 },
  G_MIN: 0.60,
  FLOOR_H: 0.35,
  FLOOR_W: [3, 9, 21, 27, 26, 10],
  RIVER_FLOW: 0.28,
  ROOF_TILE: 2.5,
  FACADE_TILE: 2.8,
  PANEL_TILE: 5.0,
  CITY: { cols: 34, rows: 32, street: 2.6, spill: 0.22 },
  BLD: [
    { floors: [2, 6], rows: 4, w: [3.0, 4.6] },
    { floors: [1, 5], rows: 4, w: [4.0, 5.4] },
    { floors: [2, 6], rows: 4, w: [3.2, 4.4] },
    { floors: [1, 5], rows: 4, w: [4.2, 5.4] },
  ],
  COUNT: { hills: [40, 24], trees: [3800, 1500], bushes: [1800, 700], bld: [70, 34] },
  HILL: {
    r: [5, 14], rise: [0.12, 0.22],
    hue: [0.19, 0.29], sat: [0.28, 0.46], lum: [0.26, 0.36],
    pondChance: 0.34, dipDepth: 0.55,
    pondAspect: [0.45, 1.8], pondGap: 0.95,
    shore: 1.6, pondFill: 0.62, endGap: 22, footGap: 9,
  },
  TREE: { h: [0.45, 1.5], trunk: 0.42, crown: 0.36, spacing: 1.05, bias: 1.3, tuft: 0.42 },
  BUSH: { s: [0.10, 0.32], flat: 0.68, spacing: 1.15 },
  FOLIAGE: { wobble: 0.22, dither: 0.34 },
  SEASONS: {
    spring: {
      name: 'Весна', accent: 0.30,
      greens: [0x6ea83f, 0x7fb84a, 0x5c9436, 0x8cc456, 0x4d8130],
      accents: [0xe8b4cf, 0xf2d6e4, 0xd98fb8, 0xf7e9a0, 0xffffff],
      bushes: [0x5f9438, 0x74ab45, 0x497f2c, 0xe0a8c6, 0xf4e6a2],
    },
    summer: {
      name: 'Лето', accent: 0.10,
      greens: [0x3f6b2a, 0x4c7c33, 0x355c25, 0x598a3c, 0x2c5320, 0x6a9a44, 0x7ba851],
      accents: [0xc8562a, 0xd8792c, 0xb03a22, 0xe0973a],
      bushes: [0x3d6b2c, 0x4f7f38, 0x2f5424, 0xa63a2c, 0xbf5a2e, 0x6f9440],
    },
    autumn: {
      name: 'Осень', accent: 0.72,
      greens: [0x4a6b2c, 0x5a7a33, 0x3a5624, 0x6b8a3e],
      accents: [0xc8562a, 0xd8792c, 0xb03a22, 0xe0973a, 0xa8452b, 0xd9a441, 0xe6c25a],
      bushes: [0xa63a2c, 0xbf5a2e, 0xd08a35, 0x8a5a24, 0x4f7f38],
    },
    winter: {
      name: 'Зима', accent: 0.55,
      greens: [0x2e4a30, 0x39563a, 0x25402a, 0x44614a],
      accents: [0xdfe7ee, 0xc8d4de, 0xeef4f8, 0xa9b8c4],
      bushes: [0x2f4a34, 0x3d5844, 0xd8e2ea, 0xbcc9d4],
    },
  } as Record<SeasonId, { name: string; accent: number; greens: number[]; accents: number[]; bushes: number[] }>,
  TOWER_CLEAR: 14,
  SUN: { r: 2.2, len: 300 - 16 * 2 + 8, clear: 1.2 },
  LIGHT_Z: [-120, -60, 0, 60, 120],
  LIGHT_Z_3: [-100, 0, 100],
  /** raster axis point lights: distance and decay (js/main.js buildLights) */
  POINT_LIGHT: { distance: 380, decay: 1.05 },

  PHASES: ['DAY', 'DUSK', 'NIGHT'] as PhaseId[],
  DAY, DUSK, NIGHT,
  PHYS,
  FADE: 3.5,
  AUTO_CYCLE_PERIOD: 40,
  ROT_PERIOD_DEFAULT: 240,
  ROT_PERIOD_CANON: 45,

  TP: [
    { ico: '🌅', name: 'Панорама Садов',    hint: 'Кривизна мира во весь кадр',    pos: [65, 30, -125] as V3, look: [65, 36, 75] as V3 },
    { ico: '🏙', name: 'Городская площадь',  hint: 'Башня снизу, из квартала',      pos: [25, 42, 126] as V3,  look: [24, 31, 84] as V3 },
    { ico: '🗼', name: 'Кабинет коммандора', hint: 'Остеклённая ротонда башни',     pos: [40, 34, 128] as V3,  look: [27, 30, 88] as V3 },
    { ico: '🛗', name: 'Осевой лифт',        hint: 'Спина станции и монорельс',     pos: [180, 8, 20] as V3,   look: [180, 5, 105] as V3 },
    { ico: '🕸', name: 'Силовая ферма',      hint: 'Опора уходит от оси к корпусу', pos: [100, 27, -30] as V3, look: [88, 24, 80] as V3 },
    { ico: '☀️', name: 'Над солнцем',        hint: 'Город уходит вниз и вверх',     pos: [90, 7, -20] as V3,   look: [270, 44, 60] as V3 },
    { ico: '🛸', name: 'Торец и спицы',      hint: 'Ступица и шесть спиц',          pos: [180, 24, 100] as V3, look: [180, 27, 148] as V3 },
    { ico: '🌳', name: 'Парковая аллея',     hint: 'Бреющий полёт над кронами',     pos: [308, 44, -50] as V3, look: [308, 46, 45] as V3 },
    { ico: '🌊', name: 'Вдоль реки',         hint: 'Русло и блик от солнца',        pos: [295, 41, -65] as V3, look: [295, 46, 60] as V3 },
  ],
  FLY: { min: 2.6, max: 6.5, speed: 42, corridor: 0.30, pull: 1.0, lead: 0.14, turn: 1.1, turnFrom: 0.25, pitchMax: 70 },
  TOUR_HOLD: 6.5,

  WATER: { foam: 0.18, ripple: 0.016 },
  RAILBEAM: { w: 0.85, h: 0.7, chord: 0.26, brace: 0.16, bay: 4.2 },
  LIFTCAR: {
    w: 2.6, h: 2.2, len: 7.2, floor: 0.14, pillar: 0.22, belt: 0.12, seat: 0.34,
    glass: 0.05, color: 0xb9c3cd, lamp: 2.6, insideOpacity: 0.1, eye: 0.15,
  },
  COLLIDE: { radius: 0.9, ahead: 2.2 },
  TREE_LOD: { near: 34, mid: 90, step: 6, blades: 3, lift: 0.35 },
  ENDCAP: { rings: 7, depth: 16, curve: 1.7, step: 0.34, spokeBite: 2.5 },
  PRINT: { across: 1.19, along: 1.9, dark: 0.72 },
  QUALITY,
  NORMALS: { hull: 1.6, facade: 2.2, panel: 1.4, endcap: 1.2, water: 1.5, roof: 1.8, leaf: 2.6 },
  TRAFFIC: { perLane: 26, speed: 7, w: 0.22, h: 0.2, len: 0.5, win: 0.55, lamp: 3.2 },
  CHUNKS: 8,
  GREEN: [5, 3.5, 2.5, 1.5, 1, 0.6, 0.35],
  /** raster: sun tube colour multiplier above 1 so bloom gets a real HDR source */
  SUN_HDR: 2.6,
  /** thin glazing for tracers (lift cabins, tower): transmission tint (linear) and IOR.
      Raster has no counterpart (it fakes glazing with a dark metallic surface). */
  GLASS: { tint: [0.9, 0.94, 0.97] as [number, number, number], ior: 1.5 },

  AUDIO: {
    volume: 0.55, hum: 0.26, wind: 0.18, water: 0.30,
    waterNear: 4, waterFar: 24, birdGap: [5, 16] as [number, number],
  },
} as const;

export type CoreConfig = typeof CORE_CONFIG;
