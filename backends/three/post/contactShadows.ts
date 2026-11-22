import type { Mesh, Object3D } from 'three';

// Raster contact shadows and atmospheric billboards have no matching surface depth.
const overlayMaterials = new Set(['w.blob', 'w.print', 'a.glow', 'a.clouds', 'a.motes']);

export function renderScreenRaySurfaces(scene: Object3D, render: () => void): void {
  const hidden: Object3D[] = [];
  scene.traverseVisible(object => {
    const material = (object as Mesh).material;
    if (!material || Array.isArray(material) || !overlayMaterials.has(material.name)) return;
    hidden.push(object);
    object.visible = false;
  });
  try {
    render();
  } finally {
    for (const object of hidden) object.visible = true;
  }
}
