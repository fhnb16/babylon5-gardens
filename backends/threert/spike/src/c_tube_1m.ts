// M0 (c): emitter distance cutoff, 1 unit = 1 m (R = 50 m).
import { defineGame } from "@threert/gameplay";
import { buildStation } from "./lib/station.ts";

export default defineGame({
  state: {},
  handlers: {},
  setup() {
    const s = buildStation({ k: 1 });
    return { scene: s.scene, camera: s.camera };
  },
});
