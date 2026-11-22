// M0 (g): a 2048x2048 RGBA8 DataTexture generated in setup (QuickJS) next to the same pattern as a PNG asset
// (assets/tex2048.png, written by tools/make-png.mjs in Node). Left plane: DataTexture. Right plane: PNG.
import { DataTexture, DirectionalLight, Mesh, MeshStandardMaterial, PerspectiveCamera, PlaneGeometry, Scene, SkyAtmosphere, Texture } from "@threert/scene";
import { defineGame } from "@threert/gameplay";
import { fillPattern } from "./lib/pattern.ts";

const RealDate = Date;
const N = 2048;

export default defineGame({
  state: {},
  handlers: {},
  setup() {
    const t0 = RealDate.now();
    const px = new Uint8Array(N * N * 4);
    const t1 = RealDate.now();
    fillPattern(px, N);
    const t2 = RealDate.now();
    const dtex = new DataTexture(N, N, px, "srgb");
    console.log(`[g] alloc ${t1 - t0} ms, fill ${N}x${N} RGBA8 ${t2 - t1} ms (${(px.length / 1048576).toFixed(0)} MiB)`);

    const scene = new Scene();
    const sun = new DirectionalLight(0xffffff, 80000).setSunAngles(50, -20);
    scene.add(sun);
    scene.environment = new SkyAtmosphere({ sun });
    const a = new Mesh(new PlaneGeometry(8, 8), new MeshStandardMaterial({ map: dtex, roughness: 0.8 }));
    a.position.set(-4.3, 4, 0);
    const b = new Mesh(new PlaneGeometry(8, 8), new MeshStandardMaterial({ map: new Texture("assets/tex2048.png", "srgb"), roughness: 0.8 }));
    b.position.set(4.3, 4, 0);
    scene.add(a, b);
    const camera = new PerspectiveCamera(50, 16 / 9, 0.05, 100);
    camera.position.set(0, 4, 13);
    camera.lookAt(0, 4, 0);
    scene.add(camera);
    console.log(`[g] setup total ${RealDate.now() - t0} ms`);
    return { scene, camera };
  },
});
