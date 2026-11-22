import { Color, MaterialFunction, MeshPhysicalMaterial, MeshStandardMaterial, Texture } from '@threert/scene';
import { lightingAt } from '../../../../core/lighting/phases.ts';
import { CORE_CONFIG } from '../../../../core/config/index.ts';
import type { MaterialDesc, SceneDesc } from '../../../../core/scene/types.ts';
import { helpers, foliageBody, hullBody, tubeBody } from '../materials.ts';

const hull = new MaterialFunction('b5_station_hull', {
  helpers, code: hullBody, textures: ['Mask', 'Detail'],
  params: { Tint: [1, 1, 1, 1], Glow: 0, Repeat: 1, Street: 1,
    Size: [2 * Math.PI * CORE_CONFIG.R, CORE_CONFIG.L, 0, 0] }
});
const tube = new MaterialFunction('b5_station_tube', {
  helpers, code: tubeBody, params: { Tint: [1, 1, 1, 1], Nits: 1 }
});
const foliage = new MaterialFunction('b5_station_leaves', {
  helpers, code: foliageBody, params: { Amount: CORE_CONFIG.FOLIAGE.dither, Cell: CORE_CONFIG.TREE.crown }
});

export function makeMaterials(desc: SceneDesc) {
  const textures = new Map<string, Texture>();
  function image(id?: string) {
    if (!id) return null;
    let result = textures.get(id);
    if (!result) {
      result = new Texture('assets/tex/' + id + '.png', desc.images[id].colorSpace);
      result.wrap = desc.images[id].wrap;
      textures.set(id, result);
    }
    return result;
  }
  const mats = new Map<string, MeshStandardMaterial>();
  function get(d: MaterialDesc) {
    const found = mats.get(d.id);
    if (found) return found;
    const Kind = d.model === 'thinGlass' ? MeshPhysicalMaterial : MeshStandardMaterial;
    const material = new Kind({
      name: d.id, color: new Color().setRGB(...d.baseColor),
      metalness: d.metalness, roughness: d.roughness,
      emissive: new Color().setRGB(...(d.emissive ?? (d.channel ? d.baseColor : [0, 0, 0] as const))),
      vertexColors: d.vertexColors ?? false, flatShading: d.flatShading ?? false
    });
    material.side = d.side;
    material.map = image(d.map);
    material.normalMap = image(d.normalMap);
    material.normalScale = d.normalScale ?? [1, 1];
    material.emissiveMap = image(d.emissiveMap);
    material.roughnessMap = image(d.roughnessMap);
    if (typeof d.alpha === 'object' && 'mask' in d.alpha) material.alphaTest = d.alpha.mask;
    if (material instanceof MeshPhysicalMaterial) { material.transmission = 1; material.ior = d.ior ?? 1.5; }
    if (d.kernels?.includes('foliageDither') || d.flatDither) {
      material.shader = foliage.with({ Amount: d.flatDither ?? CORE_CONFIG.FOLIAGE.dither });
    }
    mats.set(d.id, material);
    return material;
  }
  function phase(index: number) {
    const { phys } = lightingAt(index);
    for (const [id, material] of mats) {
      const d = desc.materials[id];
      material.emissiveIntensity = d.channel ? phys.channelNits[d.channel] : d.emissiveNits ?? 0;
      if (d.model === 'hull') material.shader = hull.with({
        Tint: [...phys.waterTint, 1], Repeat: desc.hull.detailRep, Glow: phys.cityGlow, Street: phys.channelNits.cityGlow
      }, { Mask: image(desc.hull.mask)!, Detail: image(desc.hull.detail)! });
      if (d.channel === 'tube') {
        material.color.setRGB(0, 0, 0);
        material.emissive.setRGB(...phys.tubeColor);
        material.emissiveIntensity = phys.tubeNits;
        material.shader = tube.with({ Tint: [...phys.tubeColor, 1], Nits: phys.tubeNits });
      }
    }
    return phys;
  }
  return { get, phase };
}
