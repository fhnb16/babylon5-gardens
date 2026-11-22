// M0 (h) + (i): HUD with Cyrillic + emoji text; pointer:"look" first-person walk (W A S D + mouse look) in the
// 1 m station rig. Simulate with: threert input '{"keys":["W"],"look":[0.3,0],"frames":60}'
import { defineGame, hud, type FrameContext } from "@threert/gameplay";
import { buildStation } from "./lib/station.ts";

let yaw = 0, pitch = 0;
let px = 0, py = 0, pz = 0;
let frames = 0;

function frame(f: FrameContext<Record<string, never>>) {
  const inp = f.input;
  yaw -= inp.look.dx;
  pitch = Math.max(-1.4, Math.min(1.4, pitch - inp.look.dy));
  const speed = inp.down("Shift") ? 12 : 4; // m/s
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw); // forward on the floor (camera looks down -Z at yaw 0)
  const rx = Math.cos(yaw), rz = -Math.sin(yaw);
  px += (fx * inp.move.y + rx * inp.move.x) * speed * f.dt;
  pz += (fz * inp.move.y + rz * inp.move.x) * speed * f.dt;
  const cam = f.camera;
  cam.position.set(px, py, pz);
  cam.lookAt(px + fx * Math.cos(pitch), py + Math.sin(pitch), pz + fz * Math.cos(pitch));
  frames++;
  hud.set({
    crosshair: { style: "dot" },
    items: [
      { type: "text", anchor: "top-left", label: "Панорама Садов", text: "Вавилон-5 · сады 🌿🚀✨" },
      { type: "text", anchor: "bottom-left", label: "pos", text: `${px.toFixed(1)} ${pz.toFixed(1)} yaw ${(yaw * 57.2958).toFixed(0)}°` },
      { type: "list", anchor: "bottom-right", lines: ["Ёжик в тумане — ёлка, щука, Юля", "日本語 / العربية / emoji 👩‍🚀🇺🇦"] },
    ],
    message: frames < 600 ? { title: "Добро пожаловать", subtitle: "WASD — ходьба, мышь — обзор 🖱️" } : undefined,
  });
}

export default defineGame({
  state: {},
  handlers: {},
  pointer: "look",
  setup() {
    const s = buildStation({ k: 1 });
    px = 0; py = -s.R + 1.7; pz = -0.42 * s.L;
    yaw = Math.PI; // look toward +Z
    return { scene: s.scene, camera: s.camera };
  },
  frame,
});
