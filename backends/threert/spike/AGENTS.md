# b5spike — a ThreeRT game

ThreeRT path-traces three.js-style scene code in real time. This project is one game: `game.ts` (entry in
`threert.config.json`). The same file runs natively (ThreeRT for macOS / iPhone: every light traced) and as three.js in
any browser. You develop it through the `threert` CLI; never edit `.threert/` (build output).

## Loop

1. Keep a dev server running: `threert dev --detach` (bundles on every save, serves the game, reloads every client;
   `threert stop` ends it). It opens the game in ThreeRT for macOS.
2. Edit `game.ts`.
3. `threert check` — bundles, runs `setup` and three frames headless, typechecks; prints objects, lights, files the
   scene reads (and which are missing), handlers, keys, and the game's console output. Fix every error first.
4. `threert shot -o .threert/shot.png` — waits for the live view to settle and saves the traced frame. **Look at the
   image** (read the PNG) before you call a change done. `--camera '{"position":[x,y,z],"target":[x,y,z],"fov":40}'`
   to look from elsewhere; `threert camera reset` returns to the game camera.
5. Test gameplay like a player: `threert click <u> <v>` (image coordinates 0..1; it reports what was picked),
   `threert key L`, `threert event <handler> '<json>'`, `threert state`. `threert logs` shows the game's
   `console.log` lines and errors.
6. `threert render -o out.png --spp 256` for a converged still when the look matters.

Every command takes `--json`. `threert status` says what is open, the frame rate and the GPU time per frame (budget:
16.7 ms for 60 fps).

## Scene code

- Imports only from `@threert/scene` (classes as in three.js: `Scene`, `Mesh`, `*Geometry`, `MeshStandardMaterial`,
  `MeshPhysicalMaterial`, lights, `PerspectiveCamera`, `Color`, `Vector3`, `GLTFModel`, …) and `@threert/gameplay`
  (`defineGame`). No DOM, no `window`, no timers, no network: the code runs inside the engine.
- Physical units: sun `new DirectionalLight(0xffffff, 80000)` (lux) with `.setSunAngles(elevation, azimuth)` and
  `scene.environment = new SkyAtmosphere({ sun })`; point / spot lights in candela (hundreds to thousands); emissive
  surfaces in nits (`emissiveIntensity` 100–2000 glows and lights its surroundings). Night: sun below the horizon.
- There are no shadow maps, light probes or baking: shadows, bounce light and reflections come from tracing. Don't
  add fake fill lights to fake GI.
- Game state is plain JSON, changed only in `handlers` (`tx.state`, `tx.decide(cond, why)` to refuse). `frame(f)`
  reads `f.state` and sets the scene (`f.object(id)`, materials, lights, transforms, `f.time` for animation). Give
  objects you touch a stable `id`. `click` receives `{ target, point }` for the object under the cursor.
- Files (glTF models, textures) go in `assets/` and are referenced as `"assets/…"`; the dev server also serves the
  ThreeRT asset store (e.g. `assets/DamagedHelmet.glb`).
- Sound: `audio.play("assets/sounds/shot.ogg", { at: position, gain, pitch, falloff })` from `@threert/gameplay`
  (WAV, Ogg Vorbis, MP3 or FLAC in `assets/`; `audio.preload([...])` in setup; `loop` + `key` with `audio.move` /
  `audio.stop` for a sound that lasts). The camera is the listener. Play sounds from `frame` and host listeners, never
  from handlers. The engine mixes them the same way in every client (engine docs/RUNTIME.md "Sound").
- Reference: `C:/Users/fhnb16/AppData/Local/threert-portable/ThreeRT/Resources/sdk/engine/.claude/skills/threert-scene-authoring/SKILL.md` (materials, lighting, atmosphere values),
  `C:/Users/fhnb16/AppData/Local/threert-portable/ThreeRT/Resources/sdk/engine/compare/hello/threert/*.ts` (small scenes), `C:/Users/fhnb16/AppData/Local/threert-portable/ThreeRT/Resources/sdk/engine/games/` (full games),
  `C:/Users/fhnb16/AppData/Local/threert-portable/ThreeRT/Resources/sdk/engine/tests/three-compat/README.md` (what maps how from three.js).

## Real-time games: input, a HUD, rooms

A game that is played with the keyboard and the mouse every frame says so and gets them; the app that runs it draws
its HUD and owns its sockets. (Full text: `C:/Users/fhnb16/AppData/Local/threert-portable/ThreeRT/Resources/sdk/engine/docs/RUNTIME.md` "The host channel", "Input", "HUD";
`C:/Users/fhnb16/AppData/Local/threert-portable/ThreeRT/Resources/sdk/engine/games/fps/arena.game.ts` is a first-person game in one file to read first.)

```ts
import { defineGame, host, hud } from "@threert/gameplay";
import { createRoom, joinRoom, type Room } from "@threert/net";

let room: Room | null = null;
host.on("launch", (m) => {                       // once, after setup: how the game was opened
  const { room: code, name, player, token } = m.params as Record<string, string | undefined>;
  const me = { app: "my-game", name, id: player, token, angles: [3] };      // app: the game's name on threert.app
  room = code && code !== "new" ? joinRoom({ ...me, code }) : createRoom(me);
  room.on("event", (e) => { if (e.k === "tag") console.log(`${e.from} tagged`); });
});

export default defineGame({
  pointer: "look",                               // "look": mouse look, the pointer captured; "free": a visible pointer
  frame(f) {
    yaw -= f.input.look.dx;                      // radians; f.input.move is W A S D (or a stick), .down("Shift"), .pressed("Mouse0")
    if (room) {
      room.pose([x, y, z, yaw]);                 // where I am: sent at the room's rate
      room.update(f.now);                        // once a frame: everything of the room happens in here
      for (const peer of room.peers.values()) if (peer.pose) place(peer.pid, peer.pose);
      if (f.input.pressed("Mouse0")) room.send("tag", { at: [x, y, z] });   // an event: once, in order, to everyone
    }
    hud.set({ crosshair: { style: "cross" }, items: [{ type: "text", anchor: "top-left", label: "Room", text: room?.code ?? "-" }] });
  },
  ...
});
```

- **Input.** With `pointer` the camera is the game's own: set `f.camera` every frame. Keys are named by their place
  on a US keyboard (`"W"`, `"Space"`, `"Shift"`, `"Tab"`, `"Left"`, `"Mouse0"`). In ThreeRT for macOS a click on the
  picture captures the pointer (that click is not a shot) and Esc lets go.
- **HUD.** `hud.set({...})` every frame with the whole HUD (it is sent only when it changed): a `crosshair`, `items`
  at nine anchors (`text` with a label / tone / size, `bar`, `list` with `ttl` lines, `table`), a centre `message`;
  `hud.flash("hit" | "kill" | "damage", angle?)`. The app draws it; the top right corner also holds the app's own
  small readout, so the game's top-right items start under it.
- **Rooms.** `@threert/net` (`C:/Users/fhnb16/AppData/Local/threert-portable/ThreeRT/Resources/sdk/engine/../packages/net/README.md`): `host.launch.room` is the room a link or
  `threert open <name> --room <CODE>` named; without one (or `"new"`) the game makes a room with `createRoom` and
  shows `room.code` for others to join. `room.update(f.now)` every frame; poses for what is continuous, events for
  what happened, `room.state` / `room.set` (the host) for what everyone must agree on. `host.launch.player` is this
  player's stable id and `host.launch.name` their name: pass them as `id` and `name`.
- **The network is the app's.** A game may open `wss://` sockets and make `https://` requests to public hosts
  (8 sockets, 16 requests at once); under `threert dev` also `ws://` / `http://` to the dev server's own host. A room
  needs the game to exist on threert.app (`threert publish`); until then run the platform or a room server of your
  own on this machine and pass `endpoint`.
- **Testing without hands.** `threert dev --launch '{"room":"K7Q4MZ"}'` (or `threert open <dir> --room K7Q4MZ`)
  launches with parameters; `threert input '{"keys":["W"],"look":[0.4,0],"frames":60}'` holds keys and turns for 60
  frames (`"pressed":["Mouse0"]` taps), `threert hud` prints the HUD as the game last described it, `threert net`
  its sockets and what was refused, `threert status` the pointer mode. Two players: a second one as a Node script
  on the same `@threert/net` (it runs on `WebSocket` there).

## Sharing

- iPhone: `threert dev` prints a QR code; scan it with the ThreeRT app (same code, traced on the phone).
- Web: the dev server's root URL is the three.js version of the game. `threert pack` writes a static package
  (`dist/`) any web host can serve; `threert open https://…` opens it in a client.
- threert.app: `threert publish` puts the game on the platform under a name, its address
  (`https://<name>.threert.app`). It needs `threert login` once, done by the person in a browser. Without questions:
  `threert publish --yes --name <name> --summary "…"`. Publish only when the person asks for it.
