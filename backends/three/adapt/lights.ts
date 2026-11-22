/* RasterLightDesc → HemisphereLight + point lights on the axis (legacy
   app/lights.ts buildLights): intensity = pointIntensity × perLightScale so
   the total output does not depend on the light count. Both live in the
   fixed 'scene' group (the hemisphere's "up" is world +Y, as in legacy). */

import * as THREE from 'three';
import { CORE_CONFIG } from '../../../core/config/index.ts';
import { hexToLinear } from '../../../core/lighting/phases.ts';
import type { RasterLightDesc } from '../../../core/scene/types.ts';

export interface ThreeLights {
  hemi: THREE.HemisphereLight;
  points: THREE.PointLight[];
  perLightScale: number;
  objects: THREE.Object3D[];
}

const lin = (hex: number): THREE.Color => {
  const c = hexToLinear(hex);
  return new THREE.Color().setRGB(c[0], c[1], c[2]);
};

export function createLights(d: RasterLightDesc): ThreeLights {
  const D = CORE_CONFIG.DAY;
  const hemi = new THREE.HemisphereLight(lin(D.hemiSky), lin(D.hemiGround), D.hemiInt);
  hemi.name = 'hemi';
  const k = d.perLightScale;
  const points = d.pointZ.map((z, i) => {
    const l = new THREE.PointLight(lin(D.pointCol), D.pointInt * k, d.distance, d.decay);
    l.position.set(0, 0, z);
    l.name = 'axisLight.' + i;
    return l;
  });
  return { hemi, points, perLightScale: k, objects: [hemi, ...points] };
}
