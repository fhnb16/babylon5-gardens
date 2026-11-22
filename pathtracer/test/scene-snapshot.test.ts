import { expect, it } from 'vitest';
import { buildScene } from '../../core/scene/build.ts';
import { createDynamics } from '../../backends/three/adapt/dynamics.ts';
import { snapshotForPath } from '../scene-snapshot.ts';

it('freezes moving populations and applies the visibility of the photographed frame', () => {
  const scene = buildScene({ seed: 1337, quality: 'LOW', season: 'summer', greenK: 1, saturation: 1 });
  const live = createDynamics(scene);
  live.step(3);
  const snapshot = snapshotForPath(scene, live.arrays, true, false);
  expect(snapshot.images).toBe(scene.images);
  expect(snapshot.geometries).toBe(scene.geometries);
  const staticMesh = scene.meshes.find(mesh => !mesh.dynamic)!;
  expect(snapshot.meshes).toContain(staticMesh);
  for (const key of ['traffic', 'lifts'] as const) {
    const initial = scene.meshes.find(mesh => mesh.dynamic === key)!.instances!.matrices;
    const moving = snapshot.meshes.filter(mesh => mesh.dynamic === key);
    const captured = moving[0].instances!.matrices;
    expect(captured).toEqual(live.arrays[key]);
    expect(captured).not.toEqual(initial);
    expect(captured).not.toBe(live.arrays[key]);
    for (const mesh of moving) expect(mesh.instances!.matrices).toBe(captured);
  }
  const inside = snapshotForPath(scene, live.arrays, false, true);
  expect(inside.meshes.some(mesh => mesh.dynamic === 'traffic' || mesh.role === 'lift.glass')).toBe(false);
  expect(inside.meshes.some(mesh => mesh.role === 'lift.body')).toBe(true);
  expect(snapshot.meshes.some(mesh => mesh.role === 'lift.glass')).toBe(true);
  live.step(1);
  expect(snapshot.meshes.find(mesh => mesh.dynamic === 'lifts')!.instances!.matrices).not.toEqual(live.arrays.lifts);
});
