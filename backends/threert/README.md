# backends/threert — native ThreeRT backend

Рабочий проект находится в этой папке. `game.ts` загружает адаптер ThreeRT, который читает запечённый в Node мир. В составе игры есть корпус, осевой излучатель, город, деревья, трафик, монорельс, телепорты и три фазы освещения. Эксперименты M0 сохранены в [spike](spike/).

## Сборка и запуск

Из корня репозитория с Node 24+ и Windows portable ThreeRT 0.4.3:

```powershell
$env:PATH = "$env:LOCALAPPDATA\node-portable;$env:PATH"
$cli = "$env:LOCALAPPDATA\threert-portable\ThreeRT\bin\threert.exe"
node backends/threert/tools/bake.mjs
node backends/threert/tools/qjs-check.mjs
& $cli open backends/threert
```

Запекание создаёт геометрию, матрицы экземпляров, текстуры, петлю звука и локальные пути к SDK. Для другой установки задайте `THREERT_SDK` (каталог `engine`) и `THREERT_CLI` (исполняемый файл). Команда проверки компилирует WGSL через WebGPU системного Edge, затем проверяет типы, контрольную сумму раскладки и запуск трёх кадров в ThreeRT. Игра запускается локально.

WASD и мышь управляют полётом, R/F меняют высоту, Shift ускоряет. Клавиши 1–9 запускают перелёт к точке, H показывает их список, T включает тур, Y сажает в ближайшую кабину, Space останавливает автоматический режим. L меняет фазу освещения, C запускает смену фаз, M включает или выключает звук.

Для снимка отдельной вехи запеките с `--milestone 1`, `2`, `3` или `4` и запустите `node backends/threert/tools/shots.mjs --views 0 --phases DAY`. Значение 1 оставляет корпус, торцы и трубу, 2 добавляет застройку и растительность, 3 включает игровое управление, 4 даёт финальную сборку. Обычный вызов bake восстанавливает веху 4. Запуск shots без фильтра снимает девять точек в трёх фазах.

ThreeRT = MeshyAI's MIT path tracer (Rust + wgpu, hardware ray queries). Scenes are TypeScript against
`@threert/scene` (three.js-like) + `@threert/gameplay`, run in embedded QuickJS (no DOM / Canvas / WebAudio /
timers; setup budget 120 s, frame 50 ms, 1 GiB heap). Docs: <https://threert.dev/docs/>,
<https://github.com/meshy-dev/ThreeRT> (`docs/RUNTIME.md`, `docs/MATERIAL_FUNCTIONS.md`, `docs/ROADMAP.md`). The
client ships the SDK it builds games with at `%LOCALAPPDATA%\threert-portable\ThreeRT\Resources\sdk\engine`
(`packages/scene/src`, `packages/gameplay/src`, `docs/RUNTIME.md`, `.claude/skills/threert-scene-authoring`): read
that, not npm, for the API that actually runs.

## Spike results (M0)

Machine: Windows 11 Pro 26200, RTX 3070 8 GB (driver 616.64), DX12 hardware ray queries (`status.hwrt = true`),
ThreeRT Windows portable client **0.4.3**, Node 24.22.3. Date: 2026-11-18.

> **Performance caveat (read first).** During the whole spike another process (`llama-server`, OfflineChatter,
> CUDA) held **~6.0 GB of the 8 GB VRAM**; ThreeRT got ~160 MB dedicated and ~820 MB in shared (system) memory
> (`Get-Counter '\GPU Process Memory(*)\*'`). Every scene, including the 5-orb template, ran at **~10 fps / 72–100
> GPU ms** at 50 % render scale, and still ~72 ms with `threert rt off` (camera rays only), so the time is memory
> starvation, not tracing. **All absolute frame times below are invalid**; functional results and *relative*
> comparisons stand. Re-measure with the VRAM free before judging real-time viability.

| # | Question | Answer | Evidence |
|---|---|---|---|
| a | `threert check` on a minimal game? `render` headless path-traced PNG? Timing | **check works**: bundle (esbuild) + `tsc` + setup + 3 frames headless in **1.4–2.4 s** (+ setup time). **`render` works but is NOT offline on Windows 0.4.3**: it starts the client and saves the *live* view after N accumulated frames (`--spp N` ≈ frames): "live view, 259 frames; build the offline renderer with `bun engine/renderer/build.ts` for --spp renders". Time: client cold start + kernel compile **18–33 s per new feature mask** (DXIL cached in `%LOCALAPPDATA%\ThreeRT\Cache\dxil`; reopen 0.2–0.7 s), then frames at the (starved) ~10 fps: 25–42 s for 256 frames. A window opens (the client), it is not truly headless. | `./spike.ps1 game check`, `./spike.ps1 c_tube_1m render -o shots/c_tube_1m.png --spp 256` (34.7 s); `shots/a_template_spp64.png`; `threert logs`: "opened b5spike in 21618 ms … setup 29 ms" |
| b | Import TS from outside the project (`../../../../core/lighting/phases.ts`, `.ts` extensions, `import type`)? | **Yes for bundle, typecheck and run** (SDK `tsconfig.base.json` has `allowImportingTsExtensions`, `verbatimModuleSyntax`, `erasableSyntaxOnly`; esbuild follows relative paths anywhere). `lightingAt`, `exposureFromEv100`, `CORE_CONFIG.PHYS` all ran in QuickJS. **But `threert dev` only watches the project dir**: editing an outside file does not rebuild; the change is picked up at the next rebuild caused by an inside file. | `src/b_import.ts`: check prints `core PHYS.DAY.tubeNits = 150000`; dev test with `../../spike-outside/tag.ts`: v1→v2 edit gave no rebuild, re-saving `src/lib/bench.ts` → "built 701db153 … outside tag v2" (`.threert/dev.log`) |
| c | Emitter distance cutoff: hull R=50/L=300 inward, tube r=2.2/L=276, black sky, floor camera; 1 u = 1 m vs 1 u = 10 m | **Floor is lit at both scales, same brightness** (mean linear luminance 0.405 vs 0.399, bottom band 0.365 vs 0.361 at the same EV100 12.5, tube 1.5e5 nits): illuminance from the tube is scale-invariant as predicted. **At 1 u = 10 m the image is ~3.7× noisier** (high-frequency metric 0.48 vs 0.13 on the floor band): the live light tree does not propose emitter nodes wholly beyond **120 m** from the shading point, so at R = 500 m the tube's light arrives only through BSDF rays (unbiased, noisy; fog in-scattering from culled emitters is lost entirely per the upstream ROADMAP). `render` cannot differ from live here because on Windows `render` *is* the live view (row a). Tessellation matters too: the same tube as **one** 276 m lengthwise segment is 1.8× noisier (0.24 vs 0.13) at equal brightness. | `src/c_tube_1m.ts`, `src/c_tube_10m.ts`, `src/c_tube_1m_seg1.ts`; `shots/c_tube_1m.png`, `shots/c_tube_10m.png`, `shots/c_tube_1m_seg1.png`; `node tools/pngstat.mjs shots/c_tube_*.png`; upstream `docs/ROADMAP.md` ("nodes wholly beyond 120 m from the shading point are not proposed", `emitter_lod` 60 m cull for the CDF path) |
| d | Per-frame `mesh.power`, `emissiveIntensity`, `customData`, `camera.setManualExposure`, `scene.fog.density`: rebuild hitches? | **No hitch measurable**: GPU ms in modes none / params / params+move: 90.9 / 90.4 / 87.7 avg (all inside the starvation noise); frame script itself **0.010–0.017 ms**. Upstream classifies all five as in-place GPU-table rewrites; position / visible / add-remove rebuild (ms on small scenes, ~0.7 s on Kabukichō). **Side effect:** while anything lighting-related changes every frame, the live temporal history is held at **32 frames** (static: it climbs 32→87…), so a continuously animated day cycle stays noisier. | `src/d_updates.ts`; `threert event mode '{"m":"params"}'` etc. + `threert status --json` (`gpu_ms`, `history`); logs `[d] … avg frame-script 0.017 ms`; `shots/d_updates_move.png`, `shots/d_updates_none.png`; SDK `skills/.../frame-scripts.md` |
| e | Vertex colours? InstancedMesh + `setColorAt` + 2-group geometry (2 materials)? Max instances | **Vertex colours render** (despite the SDK comment "not drawn yet"; the binding sends the `color` attribute). **`InstancedMesh` + `setColorAt` works.** **Groups are ignored on an `InstancedMesh` of triangle geometry: only `materials[0]` is drawn** (plain `Mesh` with the same 2-group geometry + `[wall, roof]` works). Workarounds: one `InstancedMesh` per group (split geometry), or a `MaterialFunction` branching on a per-vertex/UV tag, or `ProceduralGeometry`. **4 000 icosahedra: setup 15 ms; 100 000 (8.0 M triangles instanced): setup 365 ms, opened in 678 ms**, no change in (starved) GPU ms. | `src/e_instances.ts`, `src/e_instances_100k.ts`; `shots/e_instances.png` (RGB-gradient quad, rainbow icosahedra), `shots/e_instances_twogroup_closeup.png` (roofs take the wall material), `shots/e_instances_100k.png`; SDK `engine.ts:172` "`InstancedMesh`: … triangle geometry (`materials[0]`)" |
| f | `MaterialFunction` with params + texture + helpers; exact signature; helper fns; `$` pitfalls | **Compiles and renders** (`b5_hull`: albedo → tint by a mask texture, ripple normal; `b5_glow`: emission from `i.custom`). Signature (from `renderer/shaders/pathtrace.wgsl` + `packages/scene/src/engine.ts`): body runs in `fn mf_<name>(i: MatIn, m: Material, base: MatOut) -> MatOut { var o = base; <code> return o; }`. `MatIn { wp, n, ng, t, b: vec3f; uv: vec2f; uvd: f32; view, op, ob: vec3f; time, wetness, rain, lod: f32; depth: u32; power: f32; near: bool; custom: vec4f }`. `MatOut { base: vec3f; roughness, metallic, specular: f32; emissive, normal: vec3f; opacity: f32; animated: bool }`. `msample(m: Material, i: MatIn, slot: u32, uv: vec2f, uv_per_m: f32) -> vec4f` (linear; returns 1 for an empty slot), `msample_color(...)` (sRGB→linear), `tangent_normal(i, tn)`, `ue_pos/ue_vec/from_ue_vec`. Limits: 8 vec4 of params (scalars packed 4 per slot), 8 textures. **`helpers` = module-scope WGSL: helper functions and `const`s work.** Pitfalls: (1) `$Name` is substituted **only in `code`, never in `helpers`** (helpers must take params as arguments); (2) any `$Ident` in `code`, *comments included*, must be a declared param/texture or the binding throws; (3) helpers are de-duplicated **by exact string**, so two functions carrying different helper strings that define the same `b5_*` fn redefine it; (4) **any WGSL error (redefinition or a plain typo) crashes the whole client** (process exits, `threert open` times out), and `threert check` does **not** compile WGSL; (5) first use of a new function/feature set costs a 20–35 s kernel compile. | `src/f_matfn.ts`, `src/lib/b5wgsl.ts` → `shots/f_matfn.png`; `src/f_matfn_dup.ts` and `src/f_matfn_bad.ts` (both: client gone, "ThreeRT is not running"); upstream `gpu.rs` `Kernel::new` (`seen.insert(helpers.clone())`), SDK `engine.ts:1212` regex `\$([A-Za-z_][A-Za-z0-9_]*)` |
| g | 2048² RGBA8 `DataTexture` in setup: time, memory; PNG asset alternative | **Works**, but the fill loop costs **2.35–2.40 s in QuickJS** (same loop in Node: 78 ms, ~31×); 16 MiB `Uint8Array`, far under the 1 GiB cap; pixels go to the engine raw (no PNG encode in JS). **PNG asset 2048² works identically** (`new Texture("assets/tex2048.png")`, 8.6 MiB file for a noisy pattern; Node encode 333 ms). No measurable change in the client's GPU memory counters for the two 2048² maps. | `src/g_textures.ts`, `src/lib/pattern.ts`, `tools/make-png.mjs`; check: `[g] fill 2048x2048 RGBA8 2397 ms (16 MiB)`; `shots/g_textures.png` (left DataTexture, right PNG) |
| h | HUD `hud.set` with Cyrillic and emoji | **Data round-trips intact** (`threert hud` shows correct UTF-8), **but the Windows client draws Cyrillic, emoji, CJK and Arabic as tofu boxes** — only Latin, digits and a few symbols (`—`, `·`, `°`) are drawn; labels are upper-cased. Not usable for Russian UI on Windows 0.4.3. `threert shot` does not include the HUD (window capture needed). | `src/h_hud_input.ts`; `shots/h_hud_window.png` (via `tools/capture-window.ps1`); `threert hud` |
| i | Input in `pointer: "look"`; `threert input` | Works. `f.input.move` = WASD `{x,y}` (≤1), `f.input.look.dx/dy` = radians this frame (right/down positive; app converts 0.0025 rad/count × sensitivity), `down("Shift")`, `pressed("Mouse0")`; keys named by US-layout position. With `pointer` the camera is the game's: set `f.camera` every frame. Simulated: `threert input '{"keys":["W"],"frames":60}'` moved 23.7 m at 4 m/s (60 client frames, dt≈0.1 s at the starved rate); `{"look":[0.5,0],"frames":1}` turned exactly 0.5 rad right; `"pressed":["Mouse0"]` taps. In the client a click captures the pointer, Esc releases. (PowerShell 7: pass JSON as `'{"m":"x"}'`, not `\"`-escaped.) | `src/h_hud_input.ts`; `threert status --json` → `camera` before/after; `threert hud` bottom-left `-16.8 -71.9 yaw 151°` |
| j | QuickJS speed vs Node | `1e6 × Math.sin` + `Float32Array` writes: **QuickJS 79–80 ms vs Node 8–9 ms (~10×)**; layout-like loop (1e5 × mulberry32 + 16-float matrices): **85 ms vs 5.7 ms (~15×)**; texture fill (row g) ~31×. Results bit-identical in these tests. Available: `performance`, `TextEncoder`, `structuredClone`, `console`; absent: `setTimeout`, `Intl`, `WebAssembly`. `Date`/`Math.random` are frozen/seeded inside setup and handlers (capture `const RealDate = Date` at module scope to time things). | `src/j_qjs.ts` (check output), `tools/qjs-bench.mjs` |

### Other findings

- **npm `@threert/*` 0.1.1 must not be installed in (or above) a game project.** With
  `node_modules/@threert/*` present the CLI's esbuild resolves it instead of the client SDK (tsconfig paths):
  `ERROR: No matching export … for import "hud"` and, at setup, `Error: unsupported environment` (SkyAtmosphere).
  npm 0.1.1 is older than the SDK in client 0.4.3 (no `host`/`input`/`hud`/`audio`). The spike's `package.json`
  therefore records the npm pins under `threert.npmPinnedButNotInstalled` and pins the **client** (0.4.3), which is
  the real API version. The repo root `node_modules` has no `@threert` (checked).
- `defineGame` requires `handlers` at runtime ("defineGame: handlers are required") even though the TS type and the
  docs say it is optional with `on`; pass `handlers: {}`.
- `threert dev` serves on `127.0.0.1:8790` **and on the LAN address** (printed `http://172.19.0.1:8790`, a QR code for
  iPhones). Stop it (`threert stop`) when not needed.
- `material.side = BackSide` is drawn double-sided; build inward-facing geometry with inward winding instead
  (`spike/src/lib/station.ts` `hullGeometry`).
- Client control API listens on `127.0.0.1:8791`; `threert status --json` gives `gpu_ms`, `fps`, `history`,
  `scale` (dynamic resolution floor 0.5), `traced` size, triangle count, camera, pointer mode.

### Blockers / risks

1. **No offline renderer in the Windows client** → `render --spp N` uses live-view accumulation (live light-tree
   culling, 2 bounces, live denoiser). The M4 comparison uses Windows live captures with an explicit settling interval.
2. **A WGSL mistake kills the client.** Our core-emitted WGSL must be validated *before* it reaches ThreeRT
   (e.g. `tools/wgsl-check`: wrap helpers + bodies in a stub prelude with `MatIn`/`MatOut`/`Material`/`msample`
   declarations and validate with naga or Tint/Dawn).
3. **HUD cannot show Russian text on Windows** (tofu). Options: Latin-only HUD on ThreeRT, draw text into
   textures with `core/raster` (in-world signs), or report upstream.
4. **Performance unknown on this machine** until re-measured with the VRAM free (see the caveat). Upstream numbers
   (Apple M5) are 15–34 ms/frame for city-sized scenes at 60–100 % scale.
5. Instanced multi-material needs one `InstancedMesh` per material group.

## Recommended conventions (for M1+)

**Units.** ThreeRT scene in **metres with 1 station unit = 1 m** (R = 50 m, L = 300 m): every floor point is within
50 m of the tube, inside the live 120 m light cut, and the measured floor illuminance equals the full-scale one.
Core keeps station units; the adapter scales by `k = 1` today (keep `k` a single constant so 10 m can be retried).
The tube uses the calibrated nits from `CORE_CONFIG.PHYS` (33,900 cd/m² by day). The native camera applies display offsets of 1.5 stops in DAY and 0.75 in DUSK, with the core EV100 in NIGHT. The M0 experiment used an earlier 150,000 cd/m² daylight setting.

**Tube tessellation.** Emissive tube as an open `CylinderGeometry` (or core-built mesh) with **≥ 32 radial and
lengthwise segments of ≤ ~5 m** (56 × 4.9 m in the spike); one long segment doubled the noise. No caps needed;
colour via `emissive` × `emissiveIntensity` (nits), `color` black. Same rule for any long emitter (light strips).

**Update mechanisms.**
- In `frame(f)` per frame, cheap (GPU tables in place): object `power`, `customData` (→ `i.custom` in material
  functions), material `emissiveIntensity`/`color`/`roughness`, material-function params (`shader` rebinding),
  light intensity/colour, `camera.setManualExposure`, fog density, `scene.wetness`/`rain`.
- Write them only when the value actually changes (quantize slow ramps such as the day cycle): every change caps
  the live history at 32 frames.
- Structural (position/visible/add/remove/geometry): rebuild; avoid per frame. Moving things in bulk → `InstancedMesh`
  matrices (`instanceMatrix.needsUpdate`, TLAS only) or physics bodies.
- Station rotation: rotate the camera and keep the world static — consistent with the above.
- Game state only in `handlers`; `frame` derives the scene. Pass `handlers: {}` when empty.

**Import strategy.** Import `core/**` **directly by relative path** from `backends/threert/src/adapter/*`
(works with `.ts` extensions and `import type`; core must stay `erasableSyntaxOnly`: no enums, namespaces or
parameter properties). When a change in `core/` affects the station, run bake again and reopen the game to include it.
The game project lives in `backends/threert/`. Keep `@threert/*` out of `node_modules` throughout the path.
Node bakes the layout and instance matrices into `generated/` and writes the texture and audio assets.

**Texture strategy.** Bake textures in Node (`core/raster` → PNG via zlib, ~0.3 s encode per 2048²) into
`assets/` and load with `new Texture("assets/…", "srgb" | "linear")`. Keep `DataTexture` for small or truly dynamic
maps (masks ≤ 512², 1×1 neutrals): a 2048² generated in QuickJS costs ~2.4 s of the 120 s setup budget per map.
Generated PNGs are build outputs (gitignored), regenerated by the bake step.

**Material functions.** One shared helpers string for all functions (the whole `b5_*` WGSL module emitted by
`core/shading/emit/wgsl.ts`, byte-identical), function names prefixed `b5_`, params passed to `b5_*` helpers as
arguments, no `$` in emitted WGSL or comments, cheaper paths at `i.depth > 0`, set `o.animated` when the shading moves
with `i.time`, and validate offline before shipping (blocker 2).

## Layout

```
backends/threert/
  README.md              this file (spike results above stay as the M0 record)
  tsconfig.json          typechecks the adapter and simulation using the SDK paths written by bake
  src/adapter/           ThreeRT material bindings, scene adapter and game entry
  vitest.config.ts       npx vitest run --config backends/threert/vitest.config.ts
  .gitignore             generated/, assets/tex/, .threert/, shots/out/
  src/sim/               engine-independent simulation, pure TS (core/math + core/config only), runs in Node and QuickJS
    constants.ts           SPEED_*, LOOK_SENS, STICK_DEAD, pitch/margin literals copied from js/config.js / js/controls.js
    units.ts               ENGINE_M_PER_UNIT = 1 (the adapter's k) + position / speed / fog density / matrix helpers
    camera.ts              station-frame pose, stationUp, aimAt, turnToward, clampPitch, levelCamera, applyLook,
                           moveLocal, counterRotate (the station rotation: pose rotated by -omega*dt about Z)
    controls.ts            ThreeRT f.input -> Intent -> camera motion at the legacy speeds, + analytic collision
    collide.ts             terrainRadiusAt (legacy displaceHills bell), tube keep-out, hull and end-cap clamps
    modes.ts               fly-to-viewpoint (goTo/flyPoint), tour, monorail ride (cabin pose via a SeatFn argument)
    index.ts               barrel
  test/                  sim.test.ts (vs the legacy js/ modules under test/dom-stub.mjs), tools.test.ts
  tools/
    bake.mjs             node backends/threert/tools/bake.mjs --seed 1337 --quality HIGH [--dry-run|--force]
    shots.mjs            node backends/threert/tools/shots.mjs [--dry-run] [--views 0,3] [--phases DAY,NIGHT]
    lib/png.mjs          PNG encoder/decoder on node:zlib, CIE76 delta E
  generated/, assets/tex/, assets/sound/  bake outputs (gitignored)
  shots/ref/             reference shots (committed once a render is blessed), shots/out/ = latest run (gitignored)
  spike/                 the M0 spike, throwaway, read-only
```

### sim (src/sim)

- Works in **station units**; the adapter converts at the boundary with `units.ts` (`ENGINE_M_PER_UNIT = 1`:
  1 unit = 1 m, SceneDesc says 10 m per unit but the 120 m emitter cut rules that out, see row c). Fog density is
  per unit in core and per metre in ThreeRT; nits and EV100 are not scaled.
- The world is static in ThreeRT. The legacy app rotates the station by `+omega*dt` while the camera is inertial; here
  every frame the camera pose is rotated by `-omega*dt` about Z (`counterRotate`), `omega = 2*pi / ROT_PERIOD`.
  Frame order: controls -> `stepFly` / `stepRide` -> `counterRotate` (not while flying; `orientationOnly` while riding,
  the cabin is fixed to the station but the gaze is inertial) -> write `f.camera`. test/sim.test.ts proves that 600
  frames of random controls + rotation equal the legacy inertial camera (positions to 1e-7, orientation to 1e-9).
- Input mapping: `move` (WASD/stick, legacy dead zone), `look` radians x `LOOK_GAIN` (= LOOK_SENS / 0.0025 rad per count),
  R/F up/down, Shift boost x3, wheel notches change the base speed by 2 (5..40), arrows as in the legacy.
  New in the ThreeRT build: **Space** cancels a flight/tour/ride, **G** toggles free-fly (KEYS in constants.ts).
- Collision is analytic: `tubeKeep (SUN.r + SUN.clear) <= r <= min(R - 1.2, terrainRadius - COLLIDE.radius)` and
  `|z| <= L/2 - 2`. `terrainRadiusAt` reproduces the displaced hull to 1e-4 (float32 vertices) over every vertex of the
  legacy `displaceHills` mesh. Buildings and trees are not collided (the legacy BVH ray hit them); `collide(..., extra)`
  is the hook if wanted.
- No `core/camera/**` existed when this was written (checked): the camera maths lives in `sim/camera.ts`. When it
  appears, import it there and delete `stationUp / aimAt / turnToward / clampPitch / levelCamera` (the tests then become
  the parity check between the two).

### bake (tools/bake.mjs)

Core is TypeScript, Node 24 strips the types. Probes the core modules at run time and lists what is missing (exit 0).
With `core/scene/build.ts` present (it appeared while this was written) it runs `buildScene(params)` and writes
`generated/layout.json` (SceneDesc without pixels; typed arrays replaced by `{"$ta":"Float32Array","offset":o,"length":n}`
into `generated/layout.bin`, 8-byte aligned; `--no-geometry` leaves the geometries out) and bakes `scene.images` to
`assets/tex/<id>.png` + `generated/textures.json` (HIGH: 31 images, 3.2 MiB layout.bin, ~1.7 s; unchanged specs are
skipped, `--force` re-encodes; all qualities share `assets/tex`, the manifest describes the last bake). Without
`build.ts` it falls back to `hills.json` + the registry's `standardImages()` (ponds from `core/layout/hills.ts`); a missing
module is listed and skipped (exit 0). `buildScene` currently gives `panel.normal` / `endcap.normal` a string `src`
(image id) where the registry wants a nested TextureSpec; bake resolves ids through `scene.images`. PNGs are RGBA8,
row 0 = top (`origin: 'top-left'`), colour space only in the manifest (`new Texture(path, "srgb" | "linear")`).

### Снимки и сравнение M4

Из корня репозитория:

```powershell
node backends/threert/tools/shots.mjs --out backends/threert/shots/out/M4-repeat
```

Скрипт запускает игру с `{"shots":true}`, отключает вращение, движение и управление, задаёт фазы через `setPhase` и
ракурсы через `setView`. Камера ориентируется относительно оси станции. После каждой команды смены ракурса скрипт
дожидается 32 отрисованных кадров (`--history`), поскольку клиент может сохранить накопление предыдущего вида или
фазы. Затем ThreeRT сохраняет кадр, а скрипт сравнивает его с одноимённым PNG в `shots/ref` по среднему CIE76 ΔE.
Порог по умолчанию равен 6. Карты отличий `*.diff.png` сохраняются рядом с кадрами.

Для обновления референсов перенесите в `shots/ref` уже осмотренные `view<i>_<PHASE>.png`, затем снимите независимый
повтор в новый каталог. `--write-ref` захватывает новые кадры и сразу записывает их в каталог референсов.
Для проекта spike скрипт использует команду `threert camera`.

## Running the spike

```powershell
$env:PATH = "$env:LOCALAPPDATA\node-portable;$env:PATH"
cd backends/threert/spike
./spike.ps1 c_tube_1m check                       # points threert.config.json at src/c_tube_1m.ts, runs check
./spike.ps1 c_tube_1m render -o shots/x.png --spp 128
& "$env:LOCALAPPDATA\threert-portable\ThreeRT\bin\threert.exe" status --json
node tools/pngstat.mjs shots/c_tube_1m.png         # mean luminance / noise per band
node tools/make-png.mjs                            # regenerates assets/tex2048.png for g_textures
& "$env:LOCALAPPDATA\threert-portable\ThreeRT\bin\threert.exe" quit
```

Scenes: `game.ts` (template, row a), `src/b_import.ts`, `src/c_tube_{1m,10m,1m_seg1}.ts`, `src/d_updates.ts`,
`src/e_instances{,_100k}.ts`, `src/f_matfn{,_dup,_bad}.ts` (the last two crash the client on purpose),
`src/g_textures.ts`, `src/h_hud_input.ts`, `src/j_qjs.ts`; helpers in `src/lib/`. `spike-outside/tag.ts` is the
outside-the-project import used by the dev-watch test. `spike/AGENTS.md`/`CLAUDE.md` were written by `threert
create` and describe the generic ThreeRT loop. Never run `threert publish`/`login`/`pair` from here
(`spike.ps1` refuses them).
