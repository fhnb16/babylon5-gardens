// M0 (e): vertex colours; InstancedMesh with setColorAt; a 2-group geometry (2 materials) instanced; N icosahedra.
import {
  BufferAttribute, Color, DirectionalLight, IcosahedronGeometry, InstancedMesh, Matrix4, Mesh, MeshGeometry,
  MeshStandardMaterial, PerspectiveCamera, PlaneGeometry, Quaternion, Scene, SkyAtmosphere, Vector3,
} from "@threert/scene";
import { defineGame } from "@threert/gameplay";

const RealDate = Date;
const N = 4000; // icosahedra
const N2 = 400; // two-material boxes

/** A box-ish prism whose top faces are group 1 (material 1) and the rest group 0. */
function twoGroupGeometry(): MeshGeometry {
  // Two quads: bottom-ish "wall" quad (group 0) and a top "roof" quad (group 1), each as 2 triangles.
  const p = [
    -0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0, // wall (facing +z)
    -0.5, 1, 0, 0.5, 1, 0, 0.5, 1, -1, -0.5, 1, -1, // roof (facing +y)
  ];
  const idx = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7];
  const g = new MeshGeometry(p, idx);
  g.addGroup(0, 6, 0);
  g.addGroup(6, 6, 1);
  return g;
}

export default defineGame({
  state: {},
  handlers: {},
  setup() {
    const t0 = RealDate.now();
    const scene = new Scene();
    const sun = new DirectionalLight(0xffffff, 80000).setSunAngles(40, -30);
    scene.add(sun);
    scene.environment = new SkyAtmosphere({ sun });
    const ground = new Mesh(new PlaneGeometry(200, 200), new MeshStandardMaterial({ color: 0x777777, roughness: 0.9 }));
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);

    // 1) Vertex colours: a big quad with red/green/blue/white corners, material.vertexColors = true.
    const vq = new PlaneGeometry(6, 6, 1, 1);
    const cols = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 1]);
    vq.setAttribute("color", new BufferAttribute(cols, 3));
    const vmesh = new Mesh(vq, new MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.8 }));
    vmesh.position.set(-8, 3.2, -6);
    scene.add(vmesh);

    // 2) N icosahedra with per-instance colour (setColorAt).
    const ico = new IcosahedronGeometry(0.25, 1);
    const im = new InstancedMesh(ico, new MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 }), N);
    const m = new Matrix4(), q = new Quaternion(), s = new Vector3(1, 1, 1), c = new Color();
    for (let i = 0; i < N; i++) {
      const gx = i % 80, gz = Math.floor(i / 80);
      m.compose(new Vector3(-20 + gx * 0.5, 0.25 + 0.15 * Math.sin(i), -2 - gz * 0.5), q, s);
      im.setMatrixAt(i, m);
      im.setColorAt(i, c.setHSL((i % 80) / 80, 0.8, 0.5));
    }
    im.instanceMatrix.needsUpdate = true;
    scene.add(im);

    // 3) Two-group geometry (2 materials) as an InstancedMesh with colours.
    const g2 = twoGroupGeometry();
    const wall = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.7 });
    const roof = new MeshStandardMaterial({ color: 0x202020, emissive: 0xffaa33, emissiveIntensity: 50, roughness: 0.5 });
    const im2 = new InstancedMesh(g2, [wall, roof], N2);
    for (let i = 0; i < N2; i++) {
      m.compose(new Vector3(4 + (i % 20) * 1.3, 0, 2 - Math.floor(i / 20) * 1.6), q, s);
      im2.setMatrixAt(i, m);
      im2.setColorAt(i, c.setRGB(i % 2, (i >> 1) % 2, 1));
    }
    scene.add(im2);
    // Same geometry as a plain Mesh with a material array, for comparison.
    const m2 = new Mesh(g2, [wall, roof]);
    m2.position.set(0, 0, 4);
    m2.scale.set(3, 3, 3);
    scene.add(m2);

    const camera = new PerspectiveCamera(55, 16 / 9, 0.05, 500);
    camera.position.set(0, 9, 14);
    camera.lookAt(0, 0, -6);
    scene.add(camera);
    console.log(`[e] setup ${RealDate.now() - t0} ms, ${N} icosahedra + ${N2} two-material instances`);
    return { scene, camera };
  },
});
