import type { PassNode, PerspectiveCamera } from 'three/webgpu';
import { rtt, vec3, vec4 } from 'three/tsl';
import { ssgi } from 'three/addons/tsl/display/SSGINode.js';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { CONFIG } from '../../../js/config.js';

/** The hull's shading already provides the analytic tube and hull reflection on water. */
export function screenRays(pass: PassNode, camera: PerspectiveCamera, debug: number,
  keep: <T extends { dispose(): void }>(node: T) => T) {
  const beauty = pass.getTextureNode('output');
  const depth = pass.getTextureNode('depth');
  const surface = pass.getTextureNode('surface');
  const light = keep(ssgi(beauty, depth, surface, camera));
  light.radius.value = CONFIG.PHOTO.radius;
  light.giIntensity.value = CONFIG.PHOTO.bounce;
  light.aoIntensity.value = CONFIG.PHOTO.intensity;
  // In the mirror path r187 multiplies each hit by metalnessNode, including water.
  const mirror = surface.a.oneMinus().smoothstep(CONFIG.PHOTO.mirrorMin, 1);
  const reflect = keep(ssr(beauty, depth, surface as unknown as Parameters<typeof ssr>[2], {
    roughnessNode: surface.a, metalnessNode: mirror, camera
  }));
  reflect.maxDistance.value = CONFIG.PHOTO.aoFar;
  const reflected = reflect.getTextureNode();
  const specular = reflected.rgb.mul(CONFIG.PHOTO.reflect);
  const ao = light.getAONode().r;
  const gi = light.getGINode().rgb;
  const layers = [beauty.rgb.mul(ao).add(gi).add(specular), vec3(ao), gi, specular,
    beauty.rgb, vec3(surface.a), vec3(reflected.a.greaterThan(0))];
  return keep(rtt(vec4(layers[debug] ?? layers[0], 1)));
}
