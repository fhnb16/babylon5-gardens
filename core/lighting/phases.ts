/* ═══════════════════════════════════════════════════════════════════════════
   lightingAt(phase) — the day cycle as pure data.

   Port of js/main.js applyPalette (lines ~200–264). Colours are lerped in
   LINEAR space, exactly like the legacy code (THREE.Color.setHex converts
   sRGB → linear working space, then .lerp()).

   Owner: lead (contract). Backends read the returned LightingState and map
   it onto their own objects; nobody hard-codes which material reacts.
   ═══════════════════════════════════════════════════════════════════════════ */

import type { LightingState, Linear3, PaletteChannel, PhaseId, PhysState } from '../scene/types.ts';
import { CORE_CONFIG, type Palette, type PhysPalette } from '../config/index.ts';

/** sRGB transfer → linear, identical to three.js SRGBToLinear. */
export function srgbToLinear(c: number): number {
  return c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4);
}

/** 0xRRGGBB (sRGB) → linear RGB triple. */
export function hexToLinear(hex: number): Linear3 {
  return [
    srgbToLinear(((hex >> 16) & 255) / 255),
    srgbToLinear(((hex >> 8) & 255) / 255),
    srgbToLinear((hex & 255) / 255),
  ];
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const mix3 = (a: Linear3, b: Linear3, t: number): Linear3 =>
  [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Normalize so the max component is 1 (colour only, power travels separately). */
function chroma(c: Linear3): Linear3 {
  const m = Math.max(c[0], c[1], c[2], 1e-9);
  return [c[0] / m, c[1] / m, c[2] / m];
}

/** Interpolate in log space: luminances and EV are perceptually log-like. */
const lerpLog = (a: number, b: number, t: number): number =>
  a <= 0 || b <= 0 ? lerp(a, b, t) : Math.exp(lerp(Math.log(a), Math.log(b), t));

function physAt(A: PhysPalette, B: PhysPalette, t: number, cA: Palette, cB: Palette): PhysState {
  const channels = Object.keys(A.channelNits) as PaletteChannel[];
  const channelNits = {} as Record<PaletteChannel, number>;
  for (const k of channels) channelNits[k] = lerpLog(A.channelNits[k], B.channelNits[k], t);
  return {
    tubeNits: lerpLog(A.tubeNits, B.tubeNits, t),
    tubeColor: chroma(mix3(hexToLinear(cA.sunCol), hexToLinear(cB.sunCol), t)),
    ev100: lerp(A.ev100, B.ev100, t),
    channelNits,
    fogColor: mix3(hexToLinear(cA.fog), hexToLinear(cB.fog), t),
    fogDensity: lerp(cA.fogD, cB.fogD, t),
    waterTint: mix3(hexToLinear(cA.waterTint), hexToLinear(cB.waterTint), t),
    cityGlow: lerp(cA.cityGlow, cB.cityGlow, t),
  };
}

/**
 * @param phase fractional phase: 0 DAY → 1 DUSK → 2 NIGHT → 3 ≡ 0 (wraps).
 */
export function lightingAt(phase: number, cfg = CORE_CONFIG): LightingState {
  const P = cfg.PHASES;
  const n = P.length;
  const fl = Math.floor(phase);
  const i = ((fl % n) + n) % n;
  const idA: PhaseId = P[i];
  const idB: PhaseId = P[(i + 1) % n];
  const A = cfg[idA] as Palette;
  const B = cfg[idB] as Palette;
  const t = phase - fl;
  const f = (k: keyof Palette): number => lerp(A[k], B[k], t);
  const c = (k: keyof Palette): Linear3 => mix3(hexToLinear(A[k]), hexToLinear(B[k]), t);

  const daylight = f('light');
  return {
    phase,
    daylight,
    fog: c('fog'),
    fogDensity: f('fogD'),
    hemiSky: c('hemiSky'),
    hemiGround: c('hemiGround'),
    hemiIntensity: f('hemiInt'),
    pointColor: c('pointCol'),
    pointIntensity: f('pointInt'),
    sunColor: c('sunCol'),
    sunEmission: f('sunEmis'),
    glowOpacity: f('glowOp'),
    windowEmission: f('winEmis'),
    navIntensity: clamp(f('navInt'), 0, 1),
    navSize: f('navSize'),
    cityGlow: f('cityGlow'),
    moteColor: c('moteCol'),
    moteOpacity: f('moteOp'),
    waterTint: c('waterTint'),
    sparShade: f('sparShade'),
    cloudOpacity: lerp(0.06, 0.22, daylight),
    moteSize: lerp(0.72, 0.55, daylight),
    blobOpacity: lerp(0.22, cfg.PRINT.dark * 0.85, daylight),
    printOpacity: lerp(0.24, cfg.PRINT.dark, daylight),
    liftGlassEmission: lerp(1.4, 0.3, daylight),
    trafficWindow: lerp(cfg.TRAFFIC.win, 0.05, daylight),
    trafficLamp: lerp(cfg.TRAFFIC.lamp, 0.12, daylight),
    phys: physAt(cfg.PHYS[idA], cfg.PHYS[idB], t, A, B),
  };
}

/** Physical exposure scale for a given EV100 (Lagarde & de Rousiers 2014). */
export function exposureFromEv100(ev100: number): number {
  return 1 / (1.2 * Math.pow(2, ev100));
}
