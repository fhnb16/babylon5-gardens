// M0 spike: a bare O'Neill-cylinder test rig (hull + axis tube + a few blocks) at a chosen scale.
// k = metres per station unit: k = 1 -> R = 50 m (the planned ThreeRT convention), k = 10 -> R = 500 m (true size).
import {
  BoxGeometry, Color, CylinderGeometry, Mesh, MeshGeometry, MeshStandardMaterial, PerspectiveCamera, Scene, SkyColor,
} from "@threert/scene";

export const R_UNITS = 50;
export const L_UNITS = 300;
export const TUBE_R_UNITS = 2.2;
export const TUBE_L_UNITS = 276;
export const TUBE_NITS = 1.5e5; // core/config PHYS.day.tubeNits
export const DAY_EV100 = 12.5;

/** Inward-facing open cylinder along +Z, centred at the origin. Front faces (CCW) and normals point at the axis. */
export function hullGeometry(radius: number, length: number, nTheta: number, nZ: number): MeshGeometry {
  const vc = (nTheta + 1) * (nZ + 1);
  const pos = new Float32Array(vc * 3);
  const nor = new Float32Array(vc * 3);
  const uv = new Float32Array(vc * 2);
  let p = 0, q = 0;
  for (let j = 0; j <= nZ; j++) {
    const z = -length / 2 + (length * j) / nZ;
    for (let i = 0; i <= nTheta; i++) {
      const th = (2 * Math.PI * i) / nTheta;
      const c = Math.cos(th), s = Math.sin(th);
      pos[p] = radius * c; pos[p + 1] = radius * s; pos[p + 2] = z;
      nor[p] = -c; nor[p + 1] = -s; nor[p + 2] = 0;
      p += 3;
      uv[q++] = i / nTheta; uv[q++] = j / nZ;
    }
  }
  const idx = new Uint32Array(nTheta * nZ * 6);
  let k = 0;
  const at = (i: number, j: number) => j * (nTheta + 1) + i;
  for (let j = 0; j < nZ; j++)
    for (let i = 0; i < nTheta; i++) {
      const a = at(i, j), b = at(i, j + 1), c = at(i + 1, j), d = at(i + 1, j + 1);
      // cross(Z, T) points inward: (a, b, c) and (c, b, d) are CCW seen from the axis.
      idx[k++] = a; idx[k++] = b; idx[k++] = c;
      idx[k++] = c; idx[k++] = b; idx[k++] = d;
    }
  return new MeshGeometry(pos, idx, nor, uv);
}

export interface StationOpts {
  k: number;
  tubeSegments?: number; // lengthwise segments of the emissive tube
  tubeNits?: number;
  ev100?: number;
}

export interface Station {
  scene: Scene;
  camera: PerspectiveCamera;
  hull: Mesh;
  tube: Mesh;
  hullMat: MeshStandardMaterial;
  tubeMat: MeshStandardMaterial;
  R: number;
  L: number;
}

export function buildStation(o: StationOpts): Station {
  const k = o.k;
  const R = R_UNITS * k, L = L_UNITS * k;
  const scene = new Scene();
  scene.environment = new SkyColor(0x000000, 0); // black: the tube is the only light

  const hullMat = new MeshStandardMaterial({ name: "hull", color: new Color().setRGB(0.35, 0.36, 0.33), roughness: 0.9 });
  const hull = new Mesh(hullGeometry(R, L, 128, 60), hullMat);
  hull.id = "hull";
  scene.add(hull);

  const tubeMat = new MeshStandardMaterial({ name: "tube", color: 0x000000, emissive: new Color().setRGB(1, 0.95, 0.85), emissiveIntensity: o.tubeNits ?? TUBE_NITS });
  const tube = new Mesh(new CylinderGeometry(TUBE_R_UNITS * k, TUBE_R_UNITS * k, TUBE_L_UNITS * k, 32, o.tubeSegments ?? 56, true), tubeMat);
  tube.id = "tube";
  tube.rotation.x = Math.PI / 2; // three's cylinder is along Y; the station axis is Z
  scene.add(tube);

  // Reference blocks on the floor (y = -R), 4 x 4 x 4 units, every 30 units along the axis.
  const blockMat = new MeshStandardMaterial({ name: "block", color: new Color().setRGB(0.7, 0.68, 0.62), roughness: 0.6 });
  const box = new BoxGeometry(4 * k, 4 * k, 4 * k);
  for (let z = -120; z <= 120; z += 30) {
    const b = new Mesh(box, blockMat);
    b.position.set((z / 30) % 2 ? 6 * k : -6 * k, -R + 2 * k, z * k);
    scene.add(b);
  }

  const camera = new PerspectiveCamera(70, 16 / 9, 0.05 * k, 2 * L);
  camera.position.set(0, -R + 1.7 * k, -0.42 * L);
  camera.lookAt(0, -R + 6 * k, 0.5 * L);
  camera.setManualExposure(o.ev100 ?? DAY_EV100);
  scene.add(camera);
  return { scene, camera, hull, tube, hullMat, tubeMat, R, L };
}
