// b5spike — a ThreeRT game. The scene is three.js-style code (`@threert/scene`): ThreeRT path-traces it natively at
// 60 fps (macOS, iPhone), and the very same file runs as three.js in any browser. Game state changes only in handlers;
// `frame` shows the state in the scene every frame.
//
// Click an orb to light it (its glow lights the ground and its neighbours: every emitter is a light). L: day / night.
import { Color, CylinderGeometry, DirectionalLight, Mesh, MeshStandardMaterial, PerspectiveCamera, PlaneGeometry, Scene, SkyAtmosphere, SphereGeometry } from "@threert/scene";
import { defineGame, type FrameContext } from "@threert/gameplay";

interface State {
  lit: Record<string, boolean>;
  night: boolean;
  score: number;
}

const ORBS = ["orb_0", "orb_1", "orb_2", "orb_3", "orb_4"];
const HUES: [number, number, number][] = [[1, 0.42, 0.12], [1, 0.75, 0.3], [0.35, 0.7, 1], [0.95, 0.3, 0.6], [0.45, 1, 0.55]];

function frame(f: FrameContext<State>) {
  const sun = f.object("sun") as DirectionalLight;
  sun.setSunAngles(f.state.night ? -6 : 35, -30);
  ORBS.forEach((id, i) => {
    const orb = f.object(id) as Mesh;
    const on = !!f.state.lit[id];
    const m = orb.material as MeshStandardMaterial;
    m.emissive.setRGB(...HUES[i]);
    m.emissiveIntensity = on ? 2500 : 0;
    // Lit orbs float.
    orb.position.y = 1.0 + (on ? 0.08 * Math.sin(f.time * 2 + i) : 0);
  });
}

export default defineGame<State>({
  state: { lit: {}, night: false, score: 0 },

  setup() {
    const scene = new Scene();
    const sun = new DirectionalLight(0xffffff, 80000).setSunAngles(35, -30);
    sun.id = "sun";
    scene.add(sun);
    // dynamic: the sun moves at run time (L), the sky re-bakes in place instead of rebuilding the scene.
    scene.environment = new SkyAtmosphere({ sun, dynamic: true, glow: 0x6b7fb3, glowIntensity: 0.02 });

    const ground = new Mesh(new PlaneGeometry(400, 400), new MeshStandardMaterial({ color: 0x6f6a62, roughness: 0.8 }));
    ground.id = "ground";
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);

    const stone = new MeshStandardMaterial({ color: 0xd9d4cc, roughness: 0.35 });
    ORBS.forEach((id, i) => {
      const x = (i - 2) * 1.1;
      const z = -Math.abs(i - 2) * 0.35;
      const pedestal = new Mesh(new CylinderGeometry(0.22, 0.26, 0.7, 64), stone);
      pedestal.position.set(x, 0.35, z);
      scene.add(pedestal);
      const orb = new Mesh(new SphereGeometry(0.28, 64, 48), new MeshStandardMaterial({ color: new Color().setRGB(0.9, 0.9, 0.9), roughness: 0.15 }));
      orb.id = id;
      orb.position.set(x, 1.0, z);
      scene.add(orb);
    });

    const camera = new PerspectiveCamera(38, 16 / 9, 0.05, 200);
    camera.position.set(0, 2.1, 5.4);
    camera.lookAt(0, 0.8, -0.3);
    scene.add(camera);
    return { scene, camera };
  },

  frame,

  handlers: {
    click(tx, ev: { target: string }) {
      tx.decide(ORBS.includes(ev.target), `nothing happens when you click ${ev.target}`);
      const on = !tx.state.lit[ev.target];
      tx.state.lit[ev.target] = on;
      if (on) tx.state.score += 1;
    },
    night(tx) {
      tx.state.night = !tx.state.night;
    },
  },

  keys: { L: "night" },
});
