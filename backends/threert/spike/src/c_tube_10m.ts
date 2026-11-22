// M0 (c): emitter distance cutoff, 1 unit = 10 m (R = 500 m).
import { defineGame } from "@threert/gameplay";
import { buildStation } from "./lib/station.ts";

export default defineGame({
  state: {},
  handlers: {},
  setup() {
    const s = buildStation({ k: 10 });
    return { scene: s.scene, camera: s.camera };
  },
});
