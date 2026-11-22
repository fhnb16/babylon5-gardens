// M0 (f): MaterialFunction with params + a texture slot + module-scope helpers (b5_* WGSL), two functions sharing
// the same helpers text. Hull-like: albedo mixed toward a tint by a mask, normal perturbed by a ripple where masked.
import {
  Color, DataTexture, DirectionalLight, MaterialFunction, Mesh, MeshStandardMaterial, PerspectiveCamera, PlaneGeometry,
  Scene, SkyAtmosphere, SphereGeometry,
} from "@threert/scene";
import { defineGame, type FrameContext } from "@threert/gameplay";
import { B5_WGSL } from "./lib/b5wgsl.ts";

const HULL = new MaterialFunction("b5_hull", {
  params: { Tint: [0.05, 0.18, 0.25, 1], MaskAmt: 1, RippleAmp: 0.35, RippleFreq: 6 },
  textures: ["Mask"],
  helpers: B5_WGSL,
  code: /* wgsl */ `
    let mask = msample(m, i, $Mask, i.uv, exp2(i.uvd)).r;
    o.base = b5_mix_tint(o.base, $Tint.rgb, mask * $MaskAmt);
    o.roughness = mix(o.roughness, 0.05, mask);
    if (i.near) {
      let d = b5_ripple(i.wp.xz, i.time, $RippleFreq) * $RippleAmp * mask;
      o.normal = tangent_normal(i, normalize(vec3<f32>(-d.x, -d.y, 1.0)));
      o.animated = mask > 0.0;
    }`,
});

// Second function, same helpers string (deduplicated by the renderer): emission pulsing with customData.x.
const GLOW = new MaterialFunction("b5_glow", {
  params: { Nits: 400 },
  helpers: B5_WGSL,
  code: /* wgsl */ `
    let s = 0.5 + 0.5 * sin(B5_TAU * b5_mod(i.custom.x, 1.0));
    o.emissive = vec3<f32>(1.0, 0.6, 0.2) * $Nits * s * i.power;`,
});

function maskTexture(n: number): DataTexture {
  const px = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const o = (y * n + x) * 4;
      const v = Math.floor(x / (n / 4)) % 2 === 1 ? 255 : 0; // vertical stripes: "water" every other quarter
      px[o] = px[o + 1] = px[o + 2] = v;
      px[o + 3] = 255;
    }
  return new DataTexture(n, n, px, "linear");
}

let ball: Mesh | null = null;
function frame(f: FrameContext<Record<string, never>>) {
  if (ball) ball.customData = [f.time * 0.5, 0, 0, 0];
}

export default defineGame({
  state: {},
  handlers: {},
  setup() {
    const scene = new Scene();
    const sun = new DirectionalLight(0xffffff, 80000).setSunAngles(35, -30);
    scene.add(sun);
    scene.environment = new SkyAtmosphere({ sun });

    const ground = new MeshStandardMaterial({ name: "hullish", color: new Color().setRGB(0.25, 0.35, 0.12), roughness: 0.8 });
    ground.shader = HULL.with({ RippleAmp: 0.4 }, { Mask: maskTexture(256) });
    const plane = new Mesh(new PlaneGeometry(20, 20), ground);
    plane.rotation.x = -Math.PI / 2;
    scene.add(plane);

    const gm = new MeshStandardMaterial({ name: "glow", color: 0x111111, emissive: new Color().setRGB(1, 0.6, 0.2), emissiveIntensity: 400 });
    gm.shader = GLOW.with();
    ball = new Mesh(new SphereGeometry(0.8, 48, 32), gm);
    ball.position.set(2, 1.2, -1);
    scene.add(ball);

    const camera = new PerspectiveCamera(50, 16 / 9, 0.05, 200);
    camera.position.set(0, 4, 9);
    camera.lookAt(0, 0, -1);
    scene.add(camera);
    return { scene, camera };
  },
  frame,
});
