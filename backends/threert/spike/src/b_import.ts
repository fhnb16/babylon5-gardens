// M0 (b): import engine-agnostic core straight from the repo (outside the project dir): `.ts` extensions, `import type`.
import { defineGame } from "@threert/gameplay";
import { exposureFromEv100, lightingAt } from "../../../../core/lighting/phases.ts";
import { CORE_CONFIG } from "../../../../core/config/index.ts";
import type { LightingState } from "../../../../core/scene/types.ts";
import { buildStation } from "./lib/station.ts";
import { OUTSIDE_TAG } from "../../spike-outside/tag.ts"; // outside the project dir, watched by dev?

export default defineGame({
  state: {},
  handlers: {},
  setup() {
    const L: LightingState = lightingAt(0.5);
    console.log("core lightingAt(0.5) keys:", Object.keys(L).join(","));
    console.log("core exposureFromEv100(12.5) =", exposureFromEv100(12.5), "R =", CORE_CONFIG.R, "L =", CORE_CONFIG.L);
    console.log("core PHYS.DAY.tubeNits =", CORE_CONFIG.PHYS.DAY.tubeNits);
    console.log("outside tag", OUTSIDE_TAG);
    const s = buildStation({ k: 1, tubeNits: CORE_CONFIG.PHYS.DAY.tubeNits, ev100: CORE_CONFIG.PHYS.DAY.ev100 });
    return { scene: s.scene, camera: s.camera };
  },
});
