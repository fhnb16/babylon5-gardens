import type { Mesh, Object3D } from 'three';

/** Screen rays already shade contacts. A raster shadow decal can also overwrite
 * the roughness and normal MRT while depth still describes the ground. */
export function renderWithoutContactShadows(scene: Object3D, render: () => void): void {
  const hidden: Object3D[] = [];
  scene.traverseVisible(object => {
    const material = (object as Mesh).material;
    if (Array.isArray(material) || (material?.name !== 'w.blob' && material?.name !== 'w.print')) return;
    hidden.push(object);
    object.visible = false;
  });
  try {
    render();
  } finally {
    for (const object of hidden) object.visible = true;
  }
}
