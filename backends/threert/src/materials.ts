import { CORE_CONFIG as C } from '../../../core/config/index.ts';
import { FAR_NEAR_UNITS, FAR_FAR_UNITS, REF_PIXEL_ANGLE } from '../../../core/shading/contracts.ts';
import { emitWgslLibrary } from '../../../core/shading/emit/wgsl.ts';
import { hullSurface, HULL_DEFAULTS } from '../../../core/shading/kernels/hull.ts';
import { foliageDither } from '../../../core/shading/kernels/foliageDither.ts';

export const helpers = emitWgslLibrary([
  { kernel: hullSurface, options: { ...HULL_DEFAULTS, raster: false } },
  { kernel: foliageDither }
]);

export const hullBody = `
  let footprint = exp2(i.uvd);
  let maskValue = msample(m, i, $Mask, i.uv, footprint).rgb;
  let highDetail = msample(m, i, $Detail, i.uv * $Repeat, footprint * $Repeat).r;
  let lowDetail = msample(m, i, $Detail, i.uv * $Repeat * 0.31, footprint * $Repeat * 0.31).r;
  let stationSize = $Size.xy;
  let farWeight = smoothstep(${FAR_NEAR_UNITS * REF_PIXEL_ANGLE}, ${FAR_FAR_UNITS * REF_PIXEL_ANGLE}, footprint * stationSize.y);
  let h = b5_hull_surface(B5HullIn(o.base, maskValue, highDetail, lowDetail, o.roughness,
    i.uv * stationSize, farWeight, 0.0, i.wp.z), B5HullUniforms(0.0, ${C.RIVER_FLOW}, ${C.WATER.foam}, ${C.WATER.ripple},
    $Tint.rgb, $Glow, ${C.CITY.spill}, 0.0, 1.0, 1.0, array<f32,3>(), array<f32,4>()));
  o.base = h.albedo;
  o.roughness = h.roughness;
  o.emissive += h.emissive * $Street;
  if (h.water > 0.0) {
    o.normal = normalize(mix(o.normal, tangent_normal(i, normalize(vec3<f32>(h.slope, 1.0))), h.water));
  }`;

export const foliageBody = `
  let surface = b5_foliage_dither(B5FoliageDitherIn(i.wp), B5FoliageDitherUniforms($Amount, $Cell));
  o.base *= surface.k;`;

export const tubeBody = 'o.emissive = $Tint.rgb * $Nits * i.power;';
