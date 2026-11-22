# backends/three/post — цепочка постобработки WebGPU-растра

`RenderPipeline` three r187 (бывший `PostProcessing`, переименован в r183) для
`WebGPURenderer`; работает и на WebGPU, и на его откате WebGL2 (`forceWebGL`).
Порядок проходов тот же, что у классической цепочки `js/photo.js`:

```text
pass(scene, camera, { samples })  HDR half-float, MSAA 0/2/4/8, масштаб = ssaa · fsr
  └ TRAA (MRT: output + velocity, depth)          линейный HDR, разрешение рендера
→ fsr < 1: EASU-порт → резкость-порт  |  ssaa > 1: box-даунсэмпл n×n
→ яркая выборка (½) → свечение: bloom() или классическое размытие (½) + лучи от оси (½)
→ композит: base·exposure + glow·glow/k + rays·rays/k → ACES → sRGB
→ SMAA → FXAA (по экранным значениям, как SMAAPass/FXAA классики)
```

`outputColorTransform = false`: тонмаппинг и sRGB делает сама цепочка, поэтому
`renderer.toneMapping` / `toneMappingExposure` ни на что не влияют — экспозиция
задаётся через `setExposure()`.

## API (`pipeline.ts`)

```ts
const pp = createRenderPipeline(renderer, scene, camera, { aa: 'taa', bloom: true });
pp.setSize(w, h, dpr);                 // renderer.setPixelRatio + setSize(…, false)
pp.setOptions({ fsr: 0.67, rays: true }); // структурные — пересборка графа, прочие — uniform
pp.setSunScreen(uvGl, visible);        // GL-UV (низ-лево = NDC·0.5+0.5), как классический setSunScreen
pp.setExposure(x);
pp.compositeExternal(hdrTextureNode, exposure); // выход PT вместо прохода сцены; null — назад
pp.render();                           // в setAnimationLoop; render(true) — вне его (см. ниже)
pp.describe();                         // { stages, renderScale, external } — для HUD/тестов
pp.dispose();
```

`axisSunScreen(camera, halfLength, out)` (`axisRays.ts`) — классический расчёт
положения «солнца»: ближайшая к лучу взгляда точка оси, зажатая к торцам.

Опции (`options.ts`, по умолчанию из живого `CONFIG`): `msaa` (`AA_MSAA`), `aa`
(`AA_FILTER`: none/fxaa/smaa/smaafxaa/taa/taafxaa/taasmaa/taasmaafxaa),
`ssaa` (`AA_SCALE`), `fsr` (`POST.FSR`, доля ≤ 1), `fsrImpl` (`b5` | `three`),
`sharpen` (null — формула приложения `POST.sharpen·(1−frac)/0.65`),
`bloom`, `bloomImpl` (`three` | `classic`), `rays`, `threshold/radius/glow/div`,
`rayStrength/raySteps/rayDensity/rayDecay` (`POST.*`), `brightScale`
(аналог `setBrightScale`: порог ×k, свечение и лучи ÷k), `tonemap`
(`b5` | `three` | `none`), `exposure`.

## Встроенное и своё

| Что | Реализация |
|---|---|
| проход сцены, MSAA, масштаб | `pass()` + `setResolutionScale()` |
| TAA | `TRAANode` (`three/addons/tsl/display/TRAANode.js`) через подкласс `ScaledTRAANode` (`taa.ts`) |
| SMAA, FXAA | `smaa()`, `fxaa()` (`three/addons/tsl/display/SMAANode.js`, `FXAANode.js`) |
| свечение | `bloom()` (`BloomNode.js`) или `classic` — порт BRIGHT_FRAG + BLUR_FRAG |
| лучи от оси | своё: `axisRays.ts` (порт RAYS_FRAG, `Loop` на `raySteps`) |
| масштабирование | своё: `fsrEasu.ts` (порт UPSCALE_FRAG) + `rcas.ts` (порт SHARP_FRAG); `fsrImpl: 'three'` — встроенный `fsr1()` (настоящие AMD EASU+RCAS, есть в r187) |
| SSAA | своё: box-даунсэмпл n×n (n = ⌈масштаб⌉) в композите |
| ACES + sRGB | своё (`tonemap.ts`) или `acesFilmicToneMapping` three с поправкой экспозиции |

## Калибровка ACES

`acesFilmicToneMapping` three — та же аппроксимация RRT+ODT с теми же матрицами,
что `TONEMAP_GLSL` классики, но экспонированный цвет делится на 0.6. Отсюда
**точная** (не подобранная) поправка: `three(x, e·0.6) = b5(x, e)`
(`ACES_THREE_EXPOSURE_SCALE`). Пробный тест (`tests/browser/post-pipeline.spec.ts`)
прогоняет HDR-рампу 0…16 через `compositeExternal` и сравнивает с CPU-портом
`toScreen` (`toScreenCpu`): максимум 0.56/255 (квантование 8 бит) на обоих
бэкендах, для `b5` и `three`, через render target и через канвас.

## Подводные камни

- **Кадр узлов двигает только rAF-цикл three.** Узлы-эффекты (`pass`, TRAA,
  bloom, SMAA, RTT) обновляются раз за «кадр узлов», а его счётчик растёт в
  цикле анимации рендерера. Несколько `render()` в одной задаче (скриншот,
  накопление, тесты) без `render(true)` перерисовывают только финальный квад.
- **TRAANode и масштаб прохода.** r187 берёт размер дрожания и проверку копии
  глубины из `getDrawingBufferSize()`. При `ssaa`/`fsr` ≠ 1 копия глубины
  пропускается, история отвергается, и TAA вырождается в мерцающий сырой кадр
  (тест: 3–4/255 межкадровой разницы против 0.05–0.2 с `ScaledTRAANode`).
- TRAA и MSAA несовместимы: при TAA `msaa` принудительно 0 (как в классике).
- Скорость берётся из MRT `velocity`: вращение мира перепроецируется само, но
  для InstancedMesh/ветра в вершинном шейдере velocity не знает смещений —
  проверить на реальной сцене (R1a).
- `trackTimestamp` на WebGL2-откате в r187 конфликтует с вложенными RTT-проходами
  (`beginQuery: a query is already active`) — замер таймстемпов только на WebGPU.
- `fsrImpl: 'three'` работает в линейном HDR (как и наш порт); AMD-шный RCAS
  рассчитан на значения ≤ 1 — на очень ярком может пересвечивать кромки.
- Встроенный `bloom()` (5 мипов) шире классического одного гаусса; радиус
  сопоставлен грубо (`bloomRadiusOf`), сила делится на 3 (сумма весов мипов).
  `bloomImpl: 'classic'` — точный порт и дешевле.

## Проверка

- `backends/three/test/post-pipeline.test.ts` (Node, без GPU): свои TSL-узлы
  компилируются `WGSLNodeBuilder` и `GLSLNodeBuilder`; граф собирается и
  выходной материал компилируется для всех сочетаний опций.
- `tools/post-lab.html` (dev-сервер) + `tests/browser/post-pipeline.spec.ts`:
  все режимы на WebGPU и WebGL2 без ошибок валидации, скриншоты и замеры в
  `test-results/post/`, проба тонмаппинга, устойчивость TAA при масштабе.
