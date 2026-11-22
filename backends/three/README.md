# backends/three — растр на three.js r187

`SceneDesc` (ядро, `core/scene`) → объекты three для трёх рендереров:

| Режим | Рендерер | Материалы | Кадр |
|---|---|---|---|
| `classic` | `WebGLRenderer` (`three`) | `materials/legacy.ts` — GLSL-патчи `onBeforeCompile` | `js/photo.js` (постобработка, фото-режим) |
| `webgpu` | `WebGPURenderer` (`three/webgpu`) на устройстве из `pathtracer/device.ts` | `materials/node.ts` — узловые (TSL) на общих ядрах `core/shading` | `post/pipeline.ts` (R1b) |
| `webgl2` | `WebGPURenderer({ forceWebGL: true })` | те же узловые | то же |

Выбор в приложении: `?renderer=webgpu|webgl2|classic`, иначе настройка
«Рендерер» (prefs `renderer`), по умолчанию `classic` (`app/boot.ts`). Значение
по умолчанию останется `classic`, пока фоторежим не заработает под WebGPU
(см. [ROADMAP](../../docs/ROADMAP.md), «Что осталось»).

## Импорт three: одна копия ядра

`three` (`build/three.module.js`) и `three/webgpu` (`build/three.webgpu.js`)
оба импортируют **один и тот же** `build/three.core.js`; `three/tsl` — тоже.
Значит `Object3D`, `Mesh`, `InstancedMesh`, `BufferGeometry`, `Texture`,
`Color`, `Sprite`… — один и тот же класс, откуда его ни импортируй.
Различаются только рендереры и материалы:

- `WebGLRenderer` есть только в `three` (в `three/webgpu` его нет);
- `WebGPURenderer`, `*NodeMaterial`, `RenderPipeline` — только в `three/webgpu`;
- TSL — `three/tsl`.

Решение: **адаптер (`adapt/*`) импортирует ядро из `three`** и создаёт
объекты, годные для любого рендерера; узловые материалы и TSL берутся из
`three/webgpu` / `three/tsl` только в `materials/node.ts` и `tsl/*`. Никакого
параметра «пространство имён THREE» и никакого перевода всего приложения на
`three/webgpu` не нужно. `renderer.ts: assertSingleThree()` проверяет при
создании рендерера, что сборщик не раздвоил `three.core.js` (иначе сломались
бы `instanceof` и общий адаптер).

## Карта модулей

| Файл | Что |
|---|---|
| `renderer.ts` | `createRenderer({ mode })` → `{ renderer, info: { kind, sharedDevice, fallback, adapter, … }, device }`; всегда `await` (`renderer.init()`); WebGPU-устройство — `createDevice({ forThree: true })`, при отказе three берёт своё; без WebGPU — откат WebGL2 (`info.kind` говорит, что реально работает) |
| `adapt/sceneGraph.ts` | `createThreeWorld(scene, renderer, { materials: 'legacy' \| 'node', output, … })` — порядок объектов, LOD, динамика, палитра; по умолчанию `node` для `WebGPURenderer` |
| `adapt/palette.ts` | `applyLighting(state)`: один код для обоих видов материалов (одинаковые свойства `color`/`opacity`/`emissiveIntensity`); биллборды — через `BillboardTarget` (`setSize`, `color`) |
| `adapt/{geometry,instancing,lod,dynamics,lights,textures,billboards}.ts` | общие; `instancing`/`lod` вешают на объект `userData.b5Wind` (фаза, амплитуда ветра на экземпляр) |
| `materials/legacy.ts` | классические материалы и GLSL-патчи (корпус, ветер, затухание в тумане, шероховатость в альфе) |
| `materials/node.ts` | `MaterialDesc` → `MeshStandardNodeMaterial` / `MeshBasicNodeMaterial` / `SpriteNodeMaterial` (+ `WindNodeMaterial`) |
| `tsl/kernelBridge.ts` | `KT = TSL as K`, `runKernel()`, `arrayUniform()`, `pulled()` — узловые uniform'ы читают те же `HullUniforms` / `WindUniforms`, что и GLSL |
| `tsl/hull.ts` | корпус: ядро `hullSurface` (raster, с тенями ферм) → `colorNode` / `roughnessNode` / `normalNode` / `emissiveNode`; при включённом зеркале — `hullMirror` + выборка альбедо по `hullUv` |
| `tsl/wind.ts` | `WindNodeMaterial`: смещение ядра `windOffset` прибавляется к `positionLocal` **до** инстансинга three (как прежний `begin_vertex`) |
| `tsl/fogfade.ts` | `opacityNode` ядра `fogFade` (свечение, труба) |
| `tsl/billboards.ts` | Points → один инстансированный `Sprite` на набор |
| `tsl/displayOutput.ts` | режим вывода `display` — семантика прямого рендера классики (см. ниже) |
| `post/*` | цепочка кадра `RenderPipeline` (юнит R1b, свой README) |

## Отличия узлового пути от GLSL и почему

- **Ветер до инстансинга.** `material.positionNode` в r187 выполняется *после*
  инстансинга; повернуть смещение пришлось бы вторым чтением
  `instanceMatrix` (4 атрибута) — с атрибутами прошлой матрицы для TAA крона
  требовала 18 > 16 атрибутов (WebGL2 и WebGPU). `WindNodeMaterial`
  переопределяет `setupPosition()` и добавляет смещение к `positionLocal` до
  `instancedMesh()` (тот же крючок, что `displacementMap` в three) — матрицу
  применяет сам three, нормали не трогаются, ровно как в прежнем GLSL.
  Скорость для TAA ветра не видит (прошлая поза — покой).
- **Биллборды.** WebGPU не умеет `PointsMaterial.size > 1`: точки стали
  квадами `Sprite` того же экранного размера (`s = size · tan(fov/2)`).
  Точка классики отсекается **по центру** (вылез центр за кадр — пропала вся);
  квад остаётся на экране — поэтому масштаб схлопывается в 0, если центр вне
  объёма видимости (без этого 14 облаков у камеры застилали кадр).
- **Режимы вывода.** Прямой рендер классики в канвас (без постобработки)
  делает тонмаппинг и sRGB в шейдере, туман смешивает *после* них, в
  экранном пространстве, а прозрачное смешивает на закодированных значениях;
  фон — sRGB(туман) без тонмаппинга. Через свою постобработку (буфер) классика
  — линейный HDR, как всегда у `WebGPURenderer`.
  `output: 'hdr'` (по умолчанию, приложение) — линейный HDR, штатный туман
  three, тонмаппинг в `RenderPipeline`; `output: { mode: 'display', exposure }`
  (`tools/core-world`) — материалы сами делают ACES → sRGB → туман
  (`outputNode`), рендерер работает с `NoToneMapping` +
  `LinearSRGBColorSpace`, фон — закодированный туман. Так эталонные снимки
  `tests/browser/ref/core-world/` (прямой рендер классики) совпадают с узловым
  путём до ≤ 1.3/255.
- **Нет `toneMapped = false` в HDR-режиме**: тонмаппинг — общий проход
  цепочки; лампы и труба проходят ACES вместе со всеми (в `display` —
  уважается).
- **Шероховатость в альфе** (фото-режим классики) не переносится — экранной
  трассировке нового пути нужен MRT (волна 4).

## Проверки

- `test/node-materials.test.ts` (Node, без GPU): узловой материал для каждого
  `MaterialDesc` сцены HIGH, ядра подключены; все материалы на своих
  объектах (сектора с ветром, спрайты, корпус с зеркалом и без) собираются
  `WGSLNodeBuilder` и `GLSLNodeBuilder`; ветер добавляет ровно один вершинный
  вход; режим `display` собирается.
- `tests/browser/renderer.spec.ts` (Edge, RTX 3070): `tools/core-world.html`
  `?renderer=webgpu|webgl2`, 9 видов × день/ночь против эталонов классики
  (средняя |Δ| < 3/255, без ошибок валидации), время кадра на трёх рендерерах;
  приложение `?renderer=webgpu|webgl2`: первый кадр через цепочку, строка
  «Рендерер», выключенные кнопки фото-режима, снимок через render target.
