// M0 (d): per-frame parameter updates. Modes (threert event mode '{"m":"..."}'):
//   none   - nothing changes
//   params - tube power, tube emissiveIntensity, hull customData, camera manual exposure, fog density: every frame
//   move   - params + a block's position every frame (structural: expected to rebuild)
import { ExponentialHeightFog, type Mesh, type MeshStandardMaterial } from "@threert/scene";
import { defineGame, type FrameContext } from "@threert/gameplay";
import { buildStation, DAY_EV100, TUBE_NITS } from "./lib/station.ts";

const RealDate = Date; // setup/handlers swap Date for a frozen one; module scope keeps the real clock
interface State { m: string }

let frames = 0, scriptMs = 0, lastLog = 0;
let fog: ExponentialHeightFog | null = null;

function frame(f: FrameContext<State>) {
  const t0 = RealDate.now();
  const m = f.state.m;
  if (m !== "none") {
    const t = f.time;
    const tube = f.object("tube") as Mesh;
    tube.power = 0.8 + 0.2 * Math.sin(t * 3);
    (tube.material as MeshStandardMaterial).emissiveIntensity = TUBE_NITS * (0.9 + 0.1 * Math.sin(t * 2));
    (f.object("hull") as Mesh).customData = [t, Math.sin(t), 0, 0];
    f.camera.setManualExposure(DAY_EV100 + 0.2 * Math.sin(t));
    if (fog) fog.density = 0.002 + 0.0015 * Math.sin(t * 1.5);
    if (m === "move") (f.object("mover") as Mesh).position.x = 10 * Math.sin(t);
  }
  frames++;
  scriptMs += RealDate.now() - t0;
  if (frames - lastLog >= 300) {
    console.log(`[d] mode=${m} frames=${frames} avg frame-script ${(scriptMs / (frames - lastLog)).toFixed(3)} ms`);
    lastLog = frames;
    scriptMs = 0;
  }
}

export default defineGame<State>({
  state: { m: "params" },
  setup() {
    const s = buildStation({ k: 1 });
    fog = new ExponentialHeightFog(0.002, 0, 0xffffff);
    fog.intensity = 0; // pure extinction: the tube's light scatters only if volumetric is on
    s.scene.fog = fog;
    const blocks = s.scene.children.filter((o) => o.type === "Mesh" && o.id !== "hull" && o.id !== "tube");
    blocks[blocks.length - 3].id = "mover"; // z = +60: in view, not in front of the camera
    return { scene: s.scene, camera: s.camera };
  },
  frame,
  handlers: {
    mode(tx, ev: { m: string }) {
      tx.state.m = ev.m;
    },
  },
});
