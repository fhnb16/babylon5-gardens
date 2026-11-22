# AGENTS.md — guide for AI coding agents and contributors

Read this before touching code. It is short on purpose: rules first, details
in the linked docs.

## Purpose

**babylon5-gardens** is a browser flythrough of an O'Neill cylinder space
station (the gardens of *Babylon 5* — the TV series; this is **not**
Babylon.js). R = 50, L = 300 units, **1 unit = 10 m**. Everything is
procedural: Canvas2D textures, primitive-built structures, WebAudio sound —
scene assets are generated. The packaged app also ships launcher artwork and licensed OIDN weights.

Current state (v2.13.0): three.js r187. The app shell is TypeScript in `app/`
(entry `app/main.ts`, loaded by `index.html`). **The world is built by
`core/` `buildScene()` + `backends/three` `createThreeWorld()`**; the legacy
`js/world.js`, `structures.js`, `textures.js`, `util.js` and `app/lights.ts`
are deleted (copies survive only as test oracles in `test/legacy-oracle/`).
The default renderer is still the **classic `WebGLRenderer`**; a WebGPU /
WebGL2 `WebGPURenderer` path (`?renderer=webgpu|webgl2`) exists but is opt-in
(see rule 9). Built with Vite + TypeScript (`allowJs`) + Vitest + ESLint +
Playwright (`npm run test:browser`, system Edge). Architecture: an
engine-agnostic `core/` emits plain data (`SceneDesc`), consumed by the three.js
r187 backend, our own WGSL path tracer (`pathtracer/`), and a native ThreeRT
backend. Android packages the web build for phones, tablets, Android TV and its interactive DreamService. Plan and status: [docs/ROADMAP.md](docs/ROADMAP.md).

| Doc | Language | What |
|---|---|---|
| [README.md](README.md) | Russian | user-facing overview, features, controls, quick start |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Russian | approved plan: architecture decisions, waves 0–5, verification, risks |
| [docs/design-log.md](docs/design-log.md) | Russian | historical design log up to v2.10.x — *why* the code is the way it is; search it before "fixing" something odd |

## Repo map

Status: **now** = exists, **wip** = in progress, **planned** = later waves.

| Path | Status | Role |
|---|---|---|
| `index.html`, `style.css` | now | entry page (loads `app/main.ts`), HUD, settings/teleport/help/TV-menu sheets |
| `js/version.js` | now | `VERSION` + `HISTORY` changelog — single source of the version |
| `js/config.js` | now | `CONFIG`: every number (geometry, sectors, palettes, presets, teleports) |
| `js/controls.js` | now | camera input *state* (`ctl`), its application and camera collision only |
| `js/audio.js` | now | synthesized ambience; pure level functions + WebAudio graph |
| `js/photo.js` | now | classic post chain: screen-space trace, bloom, axis rays, AA, FSR1, denoisers (classic renderer only) |
| `js/pathtrace.js`, `js/pathtrace-bvh.worker.js` | now | legacy `three-gpu-pathtracer` adapter + BVH module worker; used on classic when a WebGPU device is unavailable |
| ~~`js/{world,structures,textures,util}.js`~~, ~~`app/lights.ts`~~ | **deleted** (v2.12.0) | replaced by `core/` + `backends/three`; see `test/legacy-oracle/` |
| `app/main.ts` | now | entry: wires modules, registers the service worker (this file replaced `js/main.js`) |
| `app/{state,boot,scene,palette,perf,loop,prefs}.ts`, `app/{cfg,dom}.ts` | now | shared state, startup (builds the world via `buildScene` + `createThreeWorld`, picks the renderer), scene, lighting phases, quality adaptation, frame loop, persisted prefs |
| `app/{flight,tour,ride,photo-mode,shot}.ts` | now | flights (camera looks along the flight direction), tour, monorail ride, photo mode, screenshots |
| `app/commands.ts` | now | one handler + label per action; registers everything with the action layer |
| `app/input/actions.ts` | now | **input action layer**: `ACTIONS`, `dispatch`, key/remote/gamepad maps, OK long-press |
| `app/input/{keyboard,remote,pointer,touch,gamepad}.ts` | now | device front-ends that map input onto actions (analog flight/look stays in `ctl`) |
| `app/tv-mode.ts`, `app/tv.ts` | now | TV/kiosk mode: pure part (`?mode=tv` parse, `TV` constants, overlay navigation) and DOM part (Wake Lock, auto-tour/cycle) |
| `app/ui/{sheets,hud,teleport-menu,settings,help,tv-overlay}.ts` | now | UI sheets, HUD, teleport menu, settings, help, D-pad TV overlay |
| `app/workers/{textures.worker,texturePool}.ts` | now | texture generation off the main thread |
| `sw.js`, `manifest.webmanifest`, `icons/` | now (root) | PWA; SW imports `VERSION`, has **no cache**; `vite.config.ts` copies/builds them into `dist/` |
| `test.mjs`, `test/dom-stub.mjs`, `views.mjs` | now | legacy self-test (~70 blocks, the de-facto spec), DOM stub, viewpoint metrics; also enforces that `js/`, `app/`, `core/` and the adapter never import the old world or `test/legacy-oracle/` |
| `test/legacy-oracle/{world,structures,textures,util}.js` | now | the **deleted legacy world code, kept only as test oracles** (parity of `core/` against the old output). Never imported by app code |
| `test/actions.test.ts`, `test/flight.test.ts` | now | Vitest: action layer + TV-mode helpers; flight camera looks along the flight direction |
| `tests/browser/*.spec.ts` | now | Playwright (system Edge): `smoke` (boot, teleport, phase change, TV-mode scenario, SMAA + legacy path tracing), `core-world` / `renderer` (adapter and WebGPU/WebGL2 vs reference images), `post-pipeline` (RenderPipeline modes, ACES probe, TAA scale), `pt-smoke`, `pt-unit`, `pt-surface`, `pt-output`, `pt-view` (path tracer: traversal vs CPU, surface, output, view) |
| `tests/browser/ref/core-world/` | now | 18 reference PNGs (9 views × day/night) captured from the classic direct render; the WebGPU/WebGL2 path must match them (mean ≤ ~1.3/255) |
| `core/scene/types.ts` | now | **contract**: `SceneDesc`, `WorldParams`, roles, lighting state |
| `core/shading/contracts.ts` | now | **contract**: kernel I/O signatures, `farFromFootprint`, `AOV_FORMATS` |
| `core/config/index.ts` | now | `CORE_CONFIG` (mirror of `CONFIG` data + physical palette `PHYS`) |
| `core/lighting/phases.ts` | now | `lightingAt(phase)`, `exposureFromEv100`, colour helpers |
| `core/scene/{build,world,world-shapes,structures,structuresDynamics,ambient,lod,dynamics,serialize}.ts` | now | `buildScene()` (world + structures + ambient fragments), tree LOD, traffic/lift dynamics, serialization; bit-exact with the legacy oracle. `ambient.ts` = clouds, motes, glow (now part of `SceneDesc`). `MaterialDesc.normalScale` is **as rendered** (hull `(−1,−1)`); `InstanceChunk.bucket` + `MeshDesc.sectored` describe sector chunking |
| `core/{rng,math,geometry,raster}` | now | seeded RNG, vec/mat/quat/colour math, three-primitive ports, software Context2D subset |
| `core/{textures,layout,camera,audio}` | now | texture generators over `core/raster`, world layout (`rnd()` order preserved), flight/tour/ride maths, audio level field |
| `core/shading/{kernel.ts,kernels,emit}` | now | shader kernels (TSL subset) + WGSL / CPU emitters |
| `core/test/*.test.ts` | now | Vitest: config sync, purity, parity with three, raster, textures, layout, shading, scene, camera |
| `android/`, `.github/workflows/android.yml` | now | Android WebView Activity and TV DreamService, verified self-updates from GitHub Releases, APK build and optional keystore signing on push | 
| `vite.config.ts`, `tsconfig.json`, `eslint.config.js`, `vitest.config.ts`, `playwright.config.ts` | now | tooling |
| `tools/snapshot-world.mjs`, `tools/snapshot-lib.mjs`, `test/golden/` | now | golden world snapshots, **captured from the adapter** (`createThreeWorld`), not the legacy code |
| `tools/{core-world,post-lab}.{html,ts}` | now | dev pages for adapter / pipeline checks (used by the Playwright specs) |
| `tools/texture-diff.*` | now | texture comparison page |
| `pathtracer/bvh/` | now | BVH builder (SAH, TLAS/BLAS, packing, CPU reference traversal) |
| `pathtracer/{device,three-interop,scene-upload,gpu-scene,textures,materials,rays,kernels,integrator}.ts`, `pathtracer/wgsl/` | now | WebGPU device (shareable with three), scene/material/texture upload, wavefront integrator and kernels; WGSL: traversal, `surface`, `bsdf_{std,glass,water}`, light kernels, accumulate/resolve; CPU references `*-ref.ts` |
| `pathtracer/lights/` | now | light sampling: equiangular tube (`tube.ts`), alias tables, light tree (`light-tree.ts`), packing worker |
| `pathtracer/{sampler,convergence,denoise,oidn}.ts`, `pathtracer/config.ts` | now / wip | Sobol–Owen sampler, adaptive tile convergence (noise target), à-trous denoiser; `oidn.ts` = OIDN via `oidn-webgpu` with local weights; calibrated `PHYS` lives in `core/` |
| `pathtracer/index.ts` | now | **public API** (`startPath`, `pathStep`, `stopPath`, `setNoiseTarget`, `pathLabel`, `cleanPath`, …) mirroring the old `js/pathtrace.js`; `app/path-session.ts` routes the photo UI to the shared HDR pipeline, an overlay, or the classic fallback. Decisions: `pathtracer/DECISIONS.md` |
| `pathtracer/{smoke,test,tools}/` | now | browser smoke pages, Vitest CPU/Node tests (BVH, BSDF, lights, sampler, convergence, denoise, calibration), tooling |
| `backends/threert/` | now / wip | ThreeRT spike results (README), `src/sim/` (camera, controls, collide, modes), `tools/bake.mjs`, `tools/shots.mjs`; native station adapter, material functions, game entry, and offline validation tools |
| `backends/three/renderer.ts` | now | `createRenderer({ mode: 'webgpu' \| 'webgl2' \| 'classic' })`; on WebGPU shares the `GPUDevice` with the path tracer; `info.kind` reports what actually runs |
| `backends/three/adapt/` | now | `SceneDesc` → three objects (`createThreeWorld`, instancing, LOD, dynamics, palette, textures, billboards); imports `three` only |
| `backends/three/materials/{legacy,node}.ts` | now | classic GLSL `onBeforeCompile` materials / node (TSL) materials (`MeshStandardNodeMaterial`, `WindNodeMaterial`, `SpriteNodeMaterial`) |
| `backends/three/tsl/` | now | node-material pieces over `core/shading` kernels: `kernelBridge`, `hull`, `wind`, `fogfade`, `billboards`, `displayOutput` — the only place (with `materials/node.ts`) that imports `three/webgpu` / `three/tsl` |
| `backends/three/post/` | now | `createRenderPipeline` (RenderPipeline: traa/smaa/fxaa/bloom, axis rays, FSR EASU/RCAS, ACES); own README |
| `backends/three/{collision.ts,index.ts,test/}` | now | camera collision, public exports, Node tests (adapter golden, node materials, pipeline) |
| `docs/` | now | ROADMAP, design log |

## Commands

Requires **Node 24+**. If `node` is not on PATH (maintainer's machine uses a
portable Node), prepend `%LOCALAPPDATA%\node-portable`:

```powershell
$env:PATH = "$env:LOCALAPPDATA\node-portable;$env:PATH"
```

| Command | What |
|---|---|
| `npm install` | install deps (three and friends come from npm, not CDN) |
| `npm run dev` | Vite dev server |
| `npm run build` | static site in `dist/` (`base: './'`) |
| `npm run preview` | serve `dist/` |
| `npm test` | Vitest: core tests + legacy suite wrapper + world snapshots |
| `npm run test:legacy` | `node test.mjs` only |
| `npm run test:browser` | Playwright smoke on system Edge (`tests/browser/`; builds and previews the site) |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `node tools/snapshot-world.mjs --check` | compare world generation with `test/golden/` |
| `node tools/snapshot-world.mjs --write` | regenerate golden snapshots (intentional changes only) |

Before reporting work as done: `npm test`, `npm run lint`, `npm run typecheck`,
and `npm run build` must pass for the paths you touched.

## Hard rules

### 1. Git

- **Do not** run `git commit`, `git push`, `git branch`, `git checkout -b`,
  `git reset`, rebase, stash, or anything else that changes history or refs.
  The maintainer commits.
- Read-only git (`git status`, `git diff`, `git log`, `git show`) is fine.

### 2. Layer dependencies

```text
core/  ←  backends/three/, pathtracer/, backends/threert/, app/, tools/
```

- `core/**` imports **nothing** from `three`, the DOM, WebAudio, `window`,
  timers (`setTimeout`, `requestAnimationFrame`), `fetch`, workers or Node
  built-ins. Enforced by ESLint `no-restricted-imports` and
  `core/test/purity.test.ts`. Core tests may import `three` only to
  check parity.
- Backends, `pathtracer/` and `app/` import `core/` **read-only**. Need a
  change in core? Report it; don't patch it from a backend task.
- **Contracts** — `core/scene/types.ts` and `core/shading/contracts.ts` — are
  edited **only by the lead**. Propose changes in your report.
- Data crosses the boundary as plain, structured-clone-able data: typed arrays
  and JSON-able objects. No classes, closures or three.js objects in
  `SceneDesc`.

### 3. Determinism

- Randomness comes only from seeded `mulberry32`. Never `Math.random()` in
  world generation, textures or layout.
- **Preserve the order of `rnd()` calls** when porting or refactoring world
  generation and texture generators. Reordering, adding or skipping a call
  changes the whole world.
- Golden snapshots (`tools/snapshot-world.mjs --check`, tolerance 1e-5) must
  pass.
- Update snapshots **only intentionally** with `--write`, and say in your
  report *what* changed in the world and *why*.
- Layout for ThreeRT is baked in Node (V8), not computed under QuickJS:
  `Math.sin/exp/pow` may differ by an ulp between engines.

### 4. Core must be QuickJS-safe

- ES2020 target. No top-level `await`, no `import.meta`, no `Intl`, no DOM,
  no `structuredClone`/`TextEncoder` assumptions, no Node APIs.
- Use typed arrays for bulk data (positions, matrices, pixels).
- Use explicit `.ts` extensions in relative imports inside `core/` (existing
  convention).
- Pure functions where possible: same input ⇒ same output, no hidden state.

### 5. WGSL hygiene for shared shading

Applies to WGSL emitted from `core/shading/` (consumed by our path tracer and
by ThreeRT `MaterialFunction`s):

- pure functions only; no bindings, no `override`, no `enable`, no recursion;
- every identifier prefixed `b5_` (types/constants `B5`);
- **no `$`** anywhere (ThreeRT substitutes `$Name`);
- `f32` only; GLSL `mod()` is floored — emit `x - y*floor(x/y)`, never `%`;
- kernels never sample textures; the backend samples and passes values in;
- distance fade goes through the `far` / `footprint` input, not camera hacks;
- raster-only effects (analytic truss shadows, analytic tube/hull reflections)
  are flagged and skipped by tracers.

### 6. ThreeRT

- Client: Windows portable 0.4.3 at `%LOCALAPPDATA%\threert-portable\ThreeRT\`
  (CLI `bin\threert.exe`, not on PATH). Spike findings: `backends/threert/README.md`.
- **Do NOT `npm install @threert/*`** anywhere in or above the game project:
  the CLI bundler then picks npm 0.1.1 over the newer SDK bundled with the
  client and the build breaks. The client SDK is the source of truth.
- Only `backends/threert/src/adapter/*` may use the `@threert/*` API. Everything
  else in the backend talks to the adapter.
- **A WGSL error crashes the whole client** and `threert check` does not compile
  WGSL — validate MaterialFunction WGSL offline before it reaches ThreeRT.
  `$Name` substitution applies only in the body (never in helpers); any `$X`
  in the body must be a declared param; helper strings must be byte-identical.
- InstancedMesh ignores geometry groups (one InstancedMesh per material).
  Vertex colours DO render. HUD on Windows shows no Cyrillic/emoji — Latin only.
- Core must stay `erasableSyntaxOnly` (no enums/namespaces/parameter
  properties) — the ThreeRT bundler typechecks imported core files with it.
- **Never run `threert publish`** (or any upload/deploy) without explicit
  consent from the user in the conversation.
- Run `threert check` and the QuickJS checks after every change there.
- ThreeRT works in **1 unit = 1 m** (emitters beyond 120 m are culled in live
  mode); core stays in station units.

### 7. Input action layer

- **All discrete input goes through `app/input/actions.ts`**: keyboard, UI
  buttons, touch, gamepad and the TV remote map their input onto an `Action`
  and call `dispatch()`. Nothing calls app code directly from an input handler.
- A **new command** needs: an entry in `ACTIONS` and `ACTION_LABELS`
  (`app/input/actions.ts`), a handler in `app/commands.ts` (`onAction`), and a
  binding in `KEYBOARD_MAP` / `REMOTE_MAP` / `GAMEPAD_MAP` if it has a key.
  Update the help sheet, README controls and `test/actions.test.ts` with it.
- Hotkeys are by `KeyboardEvent.code` (layout-independent, works on a Russian
  layout); remote keys are by normalized `key`. Continuous input (WASD, mouse
  and stick look, touch joystick) is **not** an action: it stays analog state
  in `ctl` (`js/controls.js`).
- TV mode (`?mode=tv`): the D-pad layout wins over movement keys. TV and
  gamepad constants live in `CONFIG.TV` (`overlayIdleMs`, `longPressMs`,
  `tourHolds`) and `CONFIG.GAMEPAD` (`dead`, `lookRate`) in `js/config.js`;
  `app/tv-mode.ts` and `app/input/actions.ts` only re-export them.

### 8. Parallel-agent etiquette

- You own **only** the paths assigned in your task. Do not edit, format,
  rename or delete files outside them — not even "obvious" fixes.
- If you need a change elsewhere, finish what you can and list the needed
  change (file, what, why) in your report.
- Do not reformat files you only read. Keep diffs minimal.
- Never revert someone else's in-progress changes.

### 9. Renderer default and legacy oracle

- **The renderer default stays `classic`** (`app/boot.ts`, prefs `renderer`)
  until photo mode works on WebGPU (path tracer integrated, screen-space trace
  ported or retired). Do not flip it, and do not remove `materials/legacy.ts`,
  `js/photo.js` or `js/pathtrace.js`, before that.
- **App code must never import `test/legacy-oracle/`** (or the deleted
  `js/{world,structures,textures,util}.js`). The oracle exists for tests only;
  `test.mjs` fails the build if `app/`, `js/`, `core/` or the adapter reference it.
- Backends import three as follows: the adapter and app use `three`; only
  `backends/three/materials/node.ts`, `tsl/*` and `post/*` use `three/webgpu`
  and `three/tsl`. Both entry points share one `three.core.js`
  (`renderer.ts: assertSingleThree()` checks it).

## Testing tiers

| Tier | Where | Runs |
|---|---|---|
| core | `core/test/**` (Vitest) | pure logic, no three (except parity checks) |
| app | `test/actions.test.ts`, `test/flight.test.ts` (Vitest) | action maps, long-press, TV-mode helpers; flight camera direction |
| legacy | `test.mjs` via Vitest wrapper / `npm run test:legacy` | silent-breakage checks on the current app: shader injection order, truss shadow angles, draw budget, UV mirror, viewpoints, flight smoothness, audio levels, settings layout, version |
| snapshots | `tools/snapshot-world.mjs` + `test/golden/` | world generation unchanged per seed × quality; captured from the adapter via `tools/snapshot-lib.mjs` |
| pathtracer CPU | `pathtracer/test/**` (Vitest) | BVH vs brute force, WGSL traversal vs CPU, BSDF / lights / alias / sampler / convergence / denoise / calibration, kernel and WGSL parsing |
| backend-three | `backends/three/test/**` (Vitest, Node, no GPU) | adapter vs golden, node materials compile under `WGSLNodeBuilder` / `GLSLNodeBuilder`, pipeline graph builds |
| browser | `tests/browser/*.spec.ts` — Playwright, system Edge (`npm run test:browser`) | `smoke`, `core-world` + `renderer` (9 views × day/night vs `ref/core-world/`, WebGPU and WebGL2), `post-pipeline`, `pt-*` (path tracer on the GPU) |
| ThreeRT | `threert check`, `tools/qjs-check.mjs`, `tools/shots.mjs` | QuickJS timing/hash parity, forbidden globals, 9 views × 3 phases ΔE |

Legacy tests read source text in places (regex over JS/HTML/CSS). If you move
or rename code they check, update the test in the same change only if you own
`test.mjs`; otherwise report it.

## Code style

- ES modules everywhere.
- Existing JS: comments in **Russian**, explaining *why* (see the design log
  for the reasoning style). Keep that when editing those files.
- New TS code: comments in English or Russian — **consistent within a file**.
- No magic numbers in code: numbers live in `CONFIG` / `CORE_CONFIG`.
- User-facing docs (README, docs/) — Russian. AGENTS.md — English.

## Versioning

- `js/version.js` holds `VERSION` (`major.minor.patch`) and the `HISTORY`
  array; the last `HISTORY` entry must equal `VERSION`.
  - major — new way of computing the image, new external dependency,
    incompatible restructuring;
  - minor — new capability;
  - patch — fix, number tuning, polish.
- `README.md` **must contain the current version string** (checked by
  `test.mjs`).
- The service worker imports `VERSION` (never duplicates it as a string), so a
  bump forces the browser to update the worker.
- Bump the version only if your task says so; then update `VERSION`,
  `HISTORY` and the README together.

## Pitfalls

- **Hull is `BackSide` with mirrored UVs.** Every hull map (albedo, normal,
  roughness, ripple) needs the same `repeat.x = -1`, `offset.x = 0.5`;
  a map without it lands in counter-phase (water where grass is). The core
  bakes correct θ-direction UVs so the hack disappears — don't reintroduce it
  in new backends. The hull mirror-reflection lookup uses θ/2π (fixed in
  v2.12.0); keep it consistent with the albedo UV.
- **`CONFIG` is a mutable global.** The UI mutates `SEED`, `SEASON`,
  `SATURATION`, `GREEN_K`, etc. at runtime; tests and snapshot tools must set
  and restore what they rely on. `core/test/config-sync.test.ts` keeps
  `CORE_CONFIG` in sync with `js/config.js` — change both together.
- **Pinned versions: three 0.187.0, three-mesh-bvh 0.9.18,
  three-gpu-pathtracer 0.0.28** (since v2.11.0). The legacy GLSL
  `onBeforeCompile` patches anchor on r187 `#include <...>` chunk names (all
  verified) and the classic WebGLRenderer is still the default (the legacy path
  tracer adapter still uses `three-gpu-pathtracer` until P-INT lands). Don't bump
  versions casually: re-verify chunk anchors, the path-tracer adapter and the
  golden snapshots on every upgrade. (The historic r165 pin came from
  `realism-effects`/`postprocessing` supporting only ≤ 0.163; never adopted.)
- **r187 shading differences vs r165:** minimum roughness 0.045 (was 0.0525),
  new DFG LUT + multi-scatter energy compensation — near water highlights are a
  touch sharper, rough metals slightly brighter.
- **`THREE.Clock` is deprecated** — use `THREE.Timer` (`update()` once per frame).
- **WebGPU `positionNode` runs after instancing.** The wind offset therefore
  must be applied **before** three's instancing: `WindNodeMaterial` hooks
  `setupPosition()` and adds the offset to `positionLocal` (same hook as
  `displacementMap`). Applying it after instancing needs a second read of the
  instance matrix → 18 vertex attributes, over the limits (> 16 WebGL2,
  > 8 vertex buffers WebGPU). Consequence: TAA velocity ignores wind sway.
  Mind the attribute count whenever you add a per-instance attribute.
- **Points are not points on WebGPU** (point size is ignored): billboards
  (clouds, motes, glow) are instanced `Sprite`s there, scaled to 0 when the
  centre leaves the frustum (the classic point is culled by its centre).
- **Two output modes.** `output: 'hdr'` (the app): linear HDR, the pipeline
  tone-maps. `output: { mode: 'display' }` (`tools/core-world`, reference
  parity): materials do ACES → sRGB → fog themselves. Don't mix them.
- **Pipeline nodes advance once per animation-loop tick.** Extra renders in
  one tick (screenshots, accumulation, tests) need `pipeline.render(true)`,
  otherwise only the final quad is redrawn. `trackTimestamp` conflicts with
  nested RTTs on the WebGL2 fallback.
- **`MaterialDesc.normalScale` is as rendered** (hull `(−1,−1)` because of the
  BackSide mirror): apply it as is, don't re-derive or negate it.
- **Playwright reuses an existing server on port 4173.** A stale `preview`
  serves an old `dist/`: kill it or rebuild (`npm run build`) before
  `npm run test:browser`, or you test yesterday's code.
- **Path-tracer timings are unreliable while other GPU processes run**
  (LLM servers, CUDA, a second browser): VRAM contention pushes allocations to
  shared memory and inflates every number. Check `nvidia-smi` / free VRAM
  before quoting performance; compare only relative numbers from one session.
- **ACES exposure differs** between three's `acesFilmicToneMapping` and ours
  by exactly the factor 0.6 (`ACES_THREE_EXPOSURE_SCALE`; matches within
  0.56/255); verify with a probe pixel. The path tracer has its own exposure (`PATH.exposure`):
  never "fix" path-traced overexposure by changing the raster day palette.
- **Fragment-bound, not vertex-bound.** The hull covers the whole screen, so
  per-fragment work (axis-light loop, truss-shadow loop, normal maps) dominates;
  triangles are cheap. Avoid new per-fragment loops; add early-outs.
- **`renderer.info` resets on every `render()`**; with post-processing it shows
  only the last full-screen pass unless `autoReset = false`.
- **Optional chaining hides missing APIs** (`computeBoundsTree`,
  `setBVHWorker`): a `?.` call on a missing method silently does nothing.
  Check explicitly.
- **Exported-but-not-imported names** pass `node --check` and crash only in the
  browser render loop; `test.mjs` checks imports.
- **`Color.setHSL` works in linear space** by default; pass
  `THREE.SRGBColorSpace` when the values are meant as sRGB.
- **`Object3D.lookAt` on a non-camera points +Z**, a camera looks down −Z.
- **Instance callbacks get the index within a sector/chunk**, not a global
  index — keep per-object data in the item itself, no parallel arrays.
- **Vertex colours multiply diffuse, not emission**; the path tracer drops
  them. Lamps use separate material groups.
- **`three-gpu-pathtracer` reads only standard material properties**;
  `onBeforeCompile` shader patches are invisible to it.
- **The service worker must not cache** (`caches` / `respondWith` are
  forbidden by a test).
- **`up` is toward the station axis**, not world +Y; use the station-up basis.
