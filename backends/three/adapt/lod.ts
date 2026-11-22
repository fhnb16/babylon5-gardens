/* ═══════════════════════════════════════════════════════════════════════════
   LodSetDesc → per-chunk × per-level InstancedMesh, driven by the core's
   classifyLod (legacy js/world.js updateTreeLod):

   · one mesh per chunk and level, named `<level.role>.s<bucket>`, capacity =
     chunk.count, bounding sphere = chunk.sphere (legacy sectorSphere),
     frustumCulled; objects are created chunk-major (lod0, lod1, lod2 of a
     sector, then the next sector) like legacy;
   · before the first classification every instance sits on level 0 (legacy:
     "the world must be whole without a LOD pass");
   · update(camWorld, camStation, force): re-classifies only when the camera
     moved ≥ step in WORLD space since the last pass (legacy throttle), then
     copies matrices/colours into each level mesh and sets count/visible;
   · setFull(on): photo-mode switch — everything on level 0.
   ═══════════════════════════════════════════════════════════════════════════ */

import * as THREE from 'three';
import { classifyLod, createLodOut, lodNeedsUpdate, type LodOut } from '../../../core/scene/lod.ts';
import type { LodSetDesc } from '../../../core/scene/types.ts';
import { chunkBuckets } from './instancing.ts';

export interface ThreeLod {
  desc: LodSetDesc;
  /** meshes[chunk][level] */
  meshes: THREE.InstancedMesh[][];
  /** all meshes in creation (scene) order */
  objects: THREE.InstancedMesh[];
  /** returns true when a re-classification happened */
  update(camWorld: THREE.Vector3, camStation: THREE.Vector3, force?: boolean): boolean;
  setFull(on: boolean): void;
  readonly full: boolean;
}

export function createLod(desc: LodSetDesc, geos: THREE.BufferGeometry[], mats: THREE.Material[]): ThreeLod {
  const nL = desc.levels.length;
  const N = desc.matrices.length / 16;
  const buckets = chunkBuckets(desc.chunks);
  const meshes: THREE.InstancedMesh[][] = [];
  const objects: THREE.InstancedMesh[] = [];
  desc.chunks.forEach((ch, c) => {
    const row: THREE.InstancedMesh[] = [];
    for (let li = 0; li < nL; li++) {
      const im = new THREE.InstancedMesh(geos[li], mats[li], ch.count);
      im.name = desc.levels[li].role + '.s' + buckets[c];
      im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(ch.count * 3), 3);
      /* per-instance wind (phase, amplitude), reordered with the matrices (tsl/wind.ts) */
      im.userData.b5Wind = new THREE.InstancedBufferAttribute(new Float32Array(ch.count * 2), 2);
      im.count = 0;
      im.boundingSphere = new THREE.Sphere(new THREE.Vector3(ch.sphere[0], ch.sphere[1], ch.sphere[2]), ch.sphere[3]);
      im.frustumCulled = true;
      row.push(im);
      objects.push(im);
    }
    /* level 0 holds the whole chunk until the first pass */
    const im0 = row[0];
    im0.instanceMatrix.array.set(desc.matrices.subarray(ch.start * 16, (ch.start + ch.count) * 16));
    (im0.instanceColor as THREE.InstancedBufferAttribute).array.set(desc.colors.subarray(ch.start * 3, (ch.start + ch.count) * 3));
    (im0.userData.b5Wind as THREE.InstancedBufferAttribute).array.set(desc.wind.subarray(ch.start * 2, (ch.start + ch.count) * 2));
    im0.count = ch.count;
    meshes.push(row);
  });

  const out: LodOut = createLodOut(desc);
  const prev = [1e9, 1e9, 1e9];
  const cam = [0, 0, 0];
  let full = false;
  const M = desc.matrices, C = desc.colors, W = desc.wind;

  const lod: ThreeLod = {
    desc, meshes, objects,
    get full() { return full; },
    update(camWorld, camStation, force = false) {
      cam[0] = camWorld.x; cam[1] = camWorld.y; cam[2] = camWorld.z;
      if (!force && !lodNeedsUpdate(prev, cam, desc.step)) return false;
      prev[0] = cam[0]; prev[1] = cam[1]; prev[2] = cam[2];
      classifyLod(desc, [camStation.x, camStation.y, camStation.z], full, out);
      desc.chunks.forEach((ch, c) => {
        for (let li = 0; li < nL; li++) {
          const im = meshes[c][li];
          const cnt = out.counts[c * nL + li];
          const mm = im.instanceMatrix.array as Float32Array;
          const cc = (im.instanceColor as THREE.InstancedBufferAttribute).array as Float32Array;
          const wa = im.userData.b5Wind as THREE.InstancedBufferAttribute;
          const ww = wa.array as Float32Array;
          for (let i = 0; i < cnt; i++) {
            const src = out.order[li * N + ch.start + i];
            for (let j = 0; j < 16; j++) mm[i * 16 + j] = M[src * 16 + j];
            cc[i * 3] = C[src * 3]; cc[i * 3 + 1] = C[src * 3 + 1]; cc[i * 3 + 2] = C[src * 3 + 2];
            ww[i * 2] = W[src * 2]; ww[i * 2 + 1] = W[src * 2 + 1];
          }
          im.count = cnt;
          im.instanceMatrix.needsUpdate = true;
          (im.instanceColor as THREE.InstancedBufferAttribute).needsUpdate = true;
          wa.needsUpdate = true;
          im.visible = cnt > 0;
        }
      });
      return true;
    },
    setFull(on) {
      full = !!on;
      prev[0] = prev[1] = prev[2] = 1e9;       // force the next pass
    }
  };
  return lod;
}
