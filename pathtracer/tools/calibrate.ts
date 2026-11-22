/* ═══════════════════════════════════════════════════════════════════════════
   PHYS calibration (PT-W4a): physical palette values for which the TRACED
   image matches the RASTER look at the same exposure (the tracer outputs
   the raster's pre-tonemap radiance, DECISIONS.md M1).

   Tube (per phase):
     raster floor irradiance  E_r(p) = hemi(n) + Σ_axis points   (three r187
       physical lights: hemi = mix(ground, sky, ½ n·Y + ½) · hemiInt — the
       HemisphereLight points along world +Y; point = colour · intensity ·
       perLightScale · cos · d^−decay · saturate(1 − (d/distance)⁴)²);
     traced floor irradiance  E_t(p) = Le · E₁(p) · G, E₁ = direct irradiance
       of a unit-radiance tube (numerical quadrature, lights/tube.ts), G = the
       indirect multiplier of a closed Lambert cylinder of mean albedo ρ̄:
       G = 1 / (1 − ρ̄ · (1 − f_tube)), f_tube = wall → tube view factor
       (checked against the CPU reference integrator in calibrate.test.ts);
     both averaged (luminance) over hull floor points θ ∈ [0, 2π), z ∈
     [−zSpan, zSpan] with the inward normal; Le = Ē_r / (Ē₁ · G) is the
     scene-radiance tube luminance, tubeNits = Le / (lum(tubeColor) ·
     exposure(ev100)) with ev100 kept from the first guess.
   Channels: nits × exposure = the raster emissive intensity of the channel
   (the drives of core/scene: emissiveDrive ParamRefs, plus the channel-keyed
   drives of types.ts: beacon 0.2 + night·flicker(0) = 1.2 − daylight, lift
   lamp constant 1 (its colour is HDR), traffic lamp = trafficLamp (colour
   multiplier), nav = navIntensity (sprite opacity), cityGlow = cityGlow).
   ═══════════════════════════════════════════════════════════════════════════ */

import { CORE_CONFIG, type PhysPalette } from '../../core/config/index.ts';
import { exposureFromEv100, lightingAt } from '../../core/lighting/phases.ts';
import type { LightingState, Linear3, PaletteChannel, PhaseId, RasterLightDesc } from '../../core/scene/types.ts';
import { tubeIrradianceQuad, type TubeGeom } from '../lights/tube.ts';

export const CALIBRATION = {
  /** luminance-mean albedo of the habitat for the indirect multiplier (grass / pavement / roofs / water) */
  meanAlbedo: 0.22,
  /** floor sample grid */
  thetaSteps: 48,
  zSteps: 9,
  zSpan: 120,
  /** significant digits of the proposed table */
  digits: 3
} as const;

const lum = (c: ArrayLike<number>) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/** Raster stand-in lights of the HIGH preset (core/scene buildScene rasterLights). */
export const RASTER_LIGHTS_HIGH: RasterLightDesc = {
  hemisphere: true, pointZ: [...CORE_CONFIG.LIGHT_Z], perLightScale: 1,
  distance: CORE_CONFIG.POINT_LIGHT.distance, decay: CORE_CONFIG.POINT_LIGHT.decay
};

/** three r187 getDistanceAttenuation */
export function threeDistanceAttenuation(d: number, cutoff: number, decay: number): number {
  let f = 1 / Math.max(d ** decay, 0.01);
  if (cutoff > 0) f *= Math.max(0, Math.min(1, 1 - (d / cutoff) ** 4)) ** 2;
  return f;
}

/** Raster irradiance (linear rgb) at p with normal n: hemisphere + axis point lights. */
export function rasterIrradiance(p: ArrayLike<number>, n: ArrayLike<number>, s: LightingState, rl: RasterLightDesc): Linear3 {
  const w = 0.5 * n[1] + 0.5; // HemisphereLight up = world +Y
  const out: Linear3 = [0, 0, 0];
  for (let c = 0; c < 3; c++) out[c] = (s.hemiGround[c] + (s.hemiSky[c] - s.hemiGround[c]) * w) * s.hemiIntensity;
  for (const z of rl.pointZ) {
    const lx = -p[0], ly = -p[1], lz = z - p[2];
    const d = Math.hypot(lx, ly, lz);
    const cos = Math.max(0, (n[0] * lx + n[1] * ly + n[2] * lz) / d);
    const k = s.pointIntensity * rl.perLightScale * cos * threeDistanceAttenuation(d, rl.distance, rl.decay);
    for (let c = 0; c < 3; c++) out[c] += s.pointColor[c] * k;
  }
  return out;
}

/** Wall → coaxial tube view factor of an infinite cylinder pair (r/R), the tube's share of the wall's hemisphere. */
export const tubeViewFactor = (r: number, R: number): number => r / R;

/** Indirect multiplier of a closed Lambert cylinder (radiosity, uniform): 1 / (1 − ρ̄ (1 − f_tube)). */
export function giFactor(meanAlbedo: number, tube: TubeGeom, R: number): number {
  return 1 / (1 - meanAlbedo * (1 - tubeViewFactor(tube.radius, R)));
}

export interface FloorAverage {
  /** raster irradiance luminance, mean over the floor */
  raster: number;
  /** direct irradiance of a unit-radiance tube, mean over the floor */
  tubeUnit: number;
}

export function floorAverages(s: LightingState, tube: TubeGeom, rl = RASTER_LIGHTS_HIGH, R: number = CORE_CONFIG.R): FloorAverage {
  const C = CALIBRATION;
  let er = 0, et = 0, n = 0;
  for (let i = 0; i < C.thetaSteps; i++) {
    const th = ((i + 0.5) / C.thetaSteps) * 2 * Math.PI;
    const p = [R * Math.cos(th), R * Math.sin(th), 0];
    const nrm = [-Math.cos(th), -Math.sin(th), 0];
    for (let j = 0; j < C.zSteps; j++) {
      p[2] = -C.zSpan + (2 * C.zSpan * j) / (C.zSteps - 1);
      er += lum(rasterIrradiance(p, nrm, s, rl));
      if (i === 0) et += tubeIrradianceQuad(p, nrm, tube, 1, 64, 256); // independent of θ
      n++;
    }
  }
  return { raster: er / n, tubeUnit: et / C.zSteps };
}

/** Raster emissive intensity of a palette channel at a lighting state (scene radiance, pre-tonemap). */
export function rasterChannelIntensity(ch: PaletteChannel, s: LightingState): number {
  switch (ch) {
    case 'tube': return lum(s.sunColor) * s.sunEmission * CORE_CONFIG.SUN_HDR;
    case 'windows': return s.windowEmission;
    case 'towerGlass': return s.windowEmission * 0.45; // structures.ts emissiveDrive {windowEmission, 0.45} (glass + endcap)
    case 'liftGlass': return s.liftGlassEmission;
    case 'trafficBody': return s.trafficWindow;
    case 'trafficLamp': return s.trafficLamp;
    case 'liftLamp': return 1; // HDR base colour, toneMapped: false, no drive
    case 'beacon': return 0.2 + (1 - s.daylight); // 0.2 + night · flicker(t = 0)
    case 'nav': return s.navIntensity;
    case 'cityGlow': return s.cityGlow;
  }
}

export interface PhaseCalibration {
  phase: PhaseId;
  ev100: number;
  exposure: number;
  rasterFloorE: number;
  tubeUnitE: number;
  gi: number;
  /** scene-radiance tube luminance that matches the raster */
  tubeLe: number;
  tubeNits: number;
  /** first guess (CORE_CONFIG.PHYS) for comparison */
  tubeNitsCore: number;
  /** visible tube: raster sun radiance vs traced tube luminance (scene units) */
  rasterSunLe: number;
  palette: PhysPalette;
}

const round = (x: number, d: number) => (x === 0 ? 0 : Number(x.toPrecision(d)));

/** Calibrate every phase; ev100 kept from CORE_CONFIG.PHYS (policy: the camera stays, luminances move). */
export function calibrate(tube: TubeGeom, meanAlbedo: number = CALIBRATION.meanAlbedo): Record<PhaseId, PhaseCalibration> {
  const out = {} as Record<PhaseId, PhaseCalibration>;
  const R = CORE_CONFIG.R;
  CORE_CONFIG.PHASES.forEach((id, i) => {
    const s = lightingAt(i);
    const ev100 = CORE_CONFIG.PHYS[id].ev100;
    const exposure = exposureFromEv100(ev100);
    const fa = floorAverages(s, tube);
    const gi = giFactor(meanAlbedo, tube, R);
    const tubeLe = fa.raster / (fa.tubeUnit * gi);
    const tubeNits = round(tubeLe / (lum(s.phys.tubeColor) * exposure), CALIBRATION.digits);
    const channelNits = {} as Record<PaletteChannel, number>;
    for (const ch of Object.keys(CORE_CONFIG.PHYS[id].channelNits) as PaletteChannel[]) {
      channelNits[ch] = ch === 'tube' ? tubeNits : round(rasterChannelIntensity(ch, s) / exposure, CALIBRATION.digits);
    }
    out[id] = {
      phase: id, ev100, exposure, rasterFloorE: fa.raster, tubeUnitE: fa.tubeUnit, gi, tubeLe, tubeNits,
      tubeNitsCore: CORE_CONFIG.PHYS[id].tubeNits,
      rasterSunLe: rasterChannelIntensity('tube', s),
      palette: { tubeNits, ev100, channelNits }
    };
  });
  return out;
}

/** The proposed table as TypeScript source (to paste into CORE_CONFIG.PHYS / config.ts PHYS_OVERRIDE). */
export function formatPhysTable(c: Record<PhaseId, PhaseCalibration>): string {
  const lines = ['{'];
  for (const id of CORE_CONFIG.PHASES) {
    const p = c[id].palette;
    const chs = Object.entries(p.channelNits).map(([k, v]) => `${k}: ${v}`).join(', ');
    lines.push(`  ${id}: { tubeNits: ${p.tubeNits}, ev100: ${p.ev100}, channelNits: { ${chs} } },`);
  }
  lines.push('}');
  return lines.join('\n');
}
