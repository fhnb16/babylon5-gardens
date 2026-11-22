import type { DynamicsOut } from '../core/scene/dynamics.ts';
import type { SceneDesc } from '../core/scene/types.ts';

/** Freeze the raster adapter's live instance transforms at shutter time.
    Static meshes, geometry and image data can be shared with the renderer. */
export function snapshotForPath(scene: SceneDesc, live: DynamicsOut, trafficOn: boolean, insideLift: boolean): SceneDesc {
  const matrices: DynamicsOut = {};
  const meshes: SceneDesc['meshes'] = [];
  for (const mesh of scene.meshes) {
    if ((!trafficOn && mesh.dynamic === 'traffic') || (insideLift && mesh.role === 'lift.glass')) continue;
    if (!mesh.dynamic || !mesh.instances) {
      meshes.push(mesh);
      continue;
    }
    const key = mesh.dynamic;
    const current = live[key];
    if (!current || current.length !== mesh.instances.matrices.length) {
      throw new Error(`Missing live transforms for ${mesh.role}`);
    }
    const frozen = matrices[key] ??= current.slice();
    meshes.push({ ...mesh, instances: { ...mesh.instances, matrices: frozen } });
  }
  return { ...scene, meshes };
}
