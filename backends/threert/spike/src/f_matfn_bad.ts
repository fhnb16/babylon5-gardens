// M0 (f) negative test 2: ONE MaterialFunction whose body calls an undefined WGSL function (a plain typo).
// Shows what a WGSL error in game code does to the client.
import { DirectionalLight, MaterialFunction, Mesh, MeshStandardMaterial, PerspectiveCamera, PlaneGeometry, Scene, SkyAtmosphere } from "@threert/scene";
import { defineGame } from "@threert/gameplay";

const H = "fn b5_hash21(p: vec2<f32>) -> f32 { return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453); }\n";
const A = new MaterialFunction("b5_bad_a", { helpers: H, code: "o.base = o.base * b5_no_such_fn(i.uv);" });
const B = new MaterialFunction("b5_bad_b", { helpers: H, code: "o.base = o.base * b5_hash21(i.uv);" });

export default defineGame({
  state: {},
  handlers: {},
  setup() {
    const scene = new Scene();
    const sun = new DirectionalLight(0xffffff, 80000).setSunAngles(35, -30);
    scene.add(sun);
    scene.environment = new SkyAtmosphere({ sun });
    const ma = new MeshStandardMaterial({ color: 0x888888 });
    ma.shader = A.with();
    const mb = new MeshStandardMaterial({ color: 0x888888 });
    mb.shader = B.with();
    const pa = new Mesh(new PlaneGeometry(4, 4), ma);
    pa.position.x = -2.5;
    const pb = new Mesh(new PlaneGeometry(4, 4), mb);
    pb.position.x = 2.5;
    scene.add(pa, pb);
    const camera = new PerspectiveCamera(50, 16 / 9, 0.05, 100);
    camera.position.set(0, 0, 9);
    scene.add(camera);
    return { scene, camera };
  },
});
