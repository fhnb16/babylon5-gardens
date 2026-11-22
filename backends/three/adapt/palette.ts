/* ═══════════════════════════════════════════════════════════════════════════
   applyLighting(state): the day/night palette, legacy app/palette.ts
   (main.js applyPalette ~200–264) driven from data:

     fog colour/density, background          ← state.fog / fogDensity
     hemisphere sky/ground/intensity          ← hemiSky / hemiGround / hemiIntensity
     axis point lights                        ← pointColor, pointIntensity × perLightScale
     MaterialDesc.emissiveDrive (ParamRef)    → emissiveIntensity (windows,
                                                tower glass ×0.45, end caps ×0.45,
                                                lift glass, traffic windows)
     MaterialDesc.alpha.blend (ParamRef)      → opacity (nav, blob, print)
     BillboardSetDesc.size (ParamRef)         → BillboardTarget.setSize (nav; legacy
                                                PointsMaterial.size, node sprite uniform)
     channel 'tube'                           → colour = sunColor × sunEmission × SUN_HDR
     channel 'trafficLamp'                    → colour = baseColor × trafficLamp
                                                (multiplier keeps the rear lamps red)
     channel 'beacon'                         → per frame: 0.2 + (1 − daylight)·(1 + 0.6 sin 4t)
     hull uniforms                            ← sparShade, cityGlow, waterTint
     glow / clouds / motes (core ambient)     ← opacity/size by ParamRef (glowOpacity,
                                                cloudOpacity, moteOpacity, moteSize);
                                                colour by role: glow ← sunColor,
                                                motes ← moteColor
   Nothing is keyed by material id: every reaction is declared by the
   descriptors (or by the channel rules documented in core/scene/types.ts),
   except the two ambient colour drives, keyed by their contract roles.
   ═══════════════════════════════════════════════════════════════════════════ */

import * as THREE from 'three';
import { CORE_CONFIG } from '../../../core/config/index.ts';
import type { BillboardSetDesc, LightingState, Linear3, MaterialDesc } from '../../../core/scene/types.ts';
import { evalRef, type HullUniforms } from '../materials/legacy.ts';
import type { ThreeLights } from './lights.ts';

export interface DrivenMaterial {
  desc: MaterialDesc;
  mat: THREE.Material;
}

/**
 * A billboard set as the palette sees it — the one place where the legacy
 * (THREE.Points + PointsMaterial.size) and node (instanced Sprite + size
 * uniform, tsl/billboards.ts) flavours differ. Everything else the palette
 * drives (colour, opacity, emissiveIntensity, hull uniforms) has the same
 * property names on legacy and node materials; node materials pull the hull
 * uniforms from the same HullUniforms objects (tsl/kernelBridge.ts pulled()).
 */
export interface BillboardTarget {
  desc: BillboardSetDesc;
  /** world-space size (legacy PointsMaterial.size semantics) */
  setSize(v: number): void;
  /** material colour (motes are coloured by the phase) */
  color: THREE.Color;
}

/** Legacy flavour: THREE.Points with a PointsMaterial. */
export function pointsTarget(desc: BillboardSetDesc, points: THREE.Points): BillboardTarget {
  const pm = points.material as THREE.PointsMaterial;
  return { desc, setSize(v) { pm.size = v; }, color: pm.color };
}

export interface PaletteTargets {
  fog: THREE.FogExp2;
  background: THREE.Color;
  lights: ThreeLights;
  /** axial glow planes (MeshDesc role 'glow'): colour ← sunColor */
  glows: THREE.Mesh[];
  hullU: HullUniforms;
  materials: DrivenMaterial[];
  billboards: BillboardTarget[];
}

const setLin = (c: THREE.Color, v: Linear3, k = 1): THREE.Color => c.setRGB(v[0] * k, v[1] * k, v[2] * k);

type Colored = THREE.Material & { color: THREE.Color };
type Emissive = THREE.Material & { emissiveIntensity: number };

export function applyLighting(t: PaletteTargets, s: LightingState): void {
  setLin(t.fog.color, s.fog);
  t.background.copy(t.fog.color);
  t.fog.density = s.fogDensity;

  setLin(t.lights.hemi.color, s.hemiSky);
  setLin(t.lights.hemi.groundColor, s.hemiGround);
  t.lights.hemi.intensity = s.hemiIntensity;
  for (const l of t.lights.points) {
    setLin(l.color, s.pointColor);
    l.intensity = s.pointIntensity * t.lights.perLightScale;
  }

  for (const { desc: d, mat } of t.materials) {
    if (d.emissiveDrive) (mat as Emissive).emissiveIntensity = evalRef(d.emissiveDrive, s);
    if (typeof d.alpha === 'object' && 'blend' in d.alpha && typeof d.alpha.blend === 'object') {
      mat.opacity = evalRef(d.alpha.blend, s);
    }
    if (d.channel === 'tube') setLin((mat as Colored).color, s.sunColor, s.sunEmission * CORE_CONFIG.SUN_HDR);
    else if (d.channel === 'trafficLamp') setLin((mat as Colored).color, d.baseColor, s.trafficLamp);
  }
  for (const b of t.billboards) {
    if (typeof b.desc.size === 'object') b.setSize(evalRef(b.desc.size, s));
    /* colour drive by contract role (no colour ParamRef in MaterialDesc yet) */
    if (b.desc.role === 'motes') setLin(b.color, s.moteColor);
  }
  for (const g of t.glows) setLin((g.material as Colored).color, s.sunColor);

  t.hullU.uSparShade.value = s.sparShade;
  t.hullU.uCityGlow.value = s.cityGlow;
  setLin(t.hullU.uWaterTint.value, s.waterTint);
}

/* legacy beacon flicker (app/loop.ts) */
const BEACON = { base: 0.2, rate: 4, depth: 0.6 };

/** Per-frame channel drives that depend on time (the 'beacon' rule). */
export function driveFrame(t: PaletteTargets, daylight: number, time: number): void {
  for (const { desc: d, mat } of t.materials) {
    if (d.channel === 'beacon') {
      (mat as Emissive).emissiveIntensity = BEACON.base + (1 - daylight) * (1 + Math.sin(time * BEACON.rate) * BEACON.depth);
    }
  }
}
