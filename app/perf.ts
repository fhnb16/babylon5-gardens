import { CONFIG } from './cfg.ts';
import { $, stage } from './dom.ts';
import { app, renderer, camera, currentQuality } from './state.ts';
import { isMobile } from '../js/controls.js';
import { resizePost, setSharpen, setUpscaleFrom } from '../js/photo.js';
import { isClassic, rendererInfo, RENDERER_LABELS } from './boot.ts';

/* ═══════════════════════════════════════════════════════════════════════════
   ПРОИЗВОДИТЕЛЬНОСТЬ: плотность пикселей, адаптация по времени кадра
   ═══════════════════════════════════════════════════════════════════════════ */
/* На ТВ пресет LOW начинается с 1×. Более низкие ступени берём из действующих
   пресетов FSR, чтобы адаптация работала и на экране с devicePixelRatio = 1. */
const tvFractions = (CONFIG.POST.FSR as { v: number }[]).map(item => item.v)
  .filter(v => v > 0 && v < 1).sort((a, b) => a - b);
const tvDprSteps = [...tvFractions, ...CONFIG.DPR_STEPS];
const dprSteps = () => app.tv ? tvDprSteps : CONFIG.DPR_STEPS;
export const capForQuality = () => Math.min(CONFIG.QUALITY[currentQuality()].dpr, isMobile ? 3 : 4)
  + (app.tv ? tvFractions.length : 0);
export const startDpr = () => app.quality === 'AUTO' && isMobile && !app.tv ? Math.min(2, capForQuality()) : capForQuality();
/* Множитель суперсэмплинга применяется ПОВЕРХ плотности экрана. Раньше здесь
   стоял min(devicePixelRatio, шаг) — на обычном мониторе 1× он намертво
   запирал рендер на 1×, и никакого сглаживания сверх MSAA получить было
   нельзя. Адаптив по-прежнему двигает шаг, а не множитель. */
export const renderScale = () => Math.min(
  CONFIG.SSAA_MAX * CONFIG.SHOT.max,
  Math.min(devicePixelRatio || 1, dprSteps()[app.dprIndex]) * app.ssaa * app.shotBoost);
/** Задать плотность пикселей и подстроить растяжение под неё.

    Адаптация плотности в проекте была и раньше: при просадке кадра она
    падала на ступень. Но падала молча — картинка просто размывалась
    билинейно. Теперь та же ступень включает масштабирование с сохранением
    кромок и резкость, а на родной плотности они выключены.

    Это и есть пространственная половина FSR: считать меньше пикселей и
    растянуть с сохранением кромок дешевле, чем считать все. Временные
    варианты (DLSS, XeSS, FSR 2) в браузере недоступны — им нужны либо
    тензорные ядра, либо вычислительные шейдеры WebGPU. */
export const applyDpr = () => {
  const native = Math.min(devicePixelRatio || 1, dprSteps()[app.dprCap]);
  /* Заданная вручную доля перебивает адаптацию: человек попросил явно. */
  const want = app.fsrFixed > 0 ? native * app.fsrFixed : renderScale();
  renderer.setPixelRatio(want);
  /* доля от родной плотности: по ней и решаем, растягивать ли */
  const frac = Math.min(1, want / Math.max(0.001, native));
  setUpscaleFrom(frac);
  setSharpen(frac < 0.999 ? CONFIG.POST.sharpen * (1 - frac) / 0.65 : 0);
};

/** Начальная ступень плотности под текущий пресет */
export function resetDpr() {
  app.dprCap = capForQuality();
  app.dprIndex = startDpr();
}

/* Размер берём у самого контейнера, а не у окна. При входе в полноэкранный
   режим окно ещё не пересчитано в момент события resize, и рендер оставался
   прежнего размера — отсюда чёрные поля справа и снизу. ResizeObserver
   срабатывает тогда, когда элемент действительно изменился. */
export function resize() {
  const w = stage.clientWidth || innerWidth;
  const h = stage.clientHeight || innerHeight;
  if (!w || !h) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
  applyDpr();
  /* цепочка нового пути берёт размер буфера у рендерера сама */
  if (isClassic()) resizePost(renderer);
}

const rendererLabel = () => {
  const i = rendererInfo();
  return i ? RENDERER_LABELS[i.kind] : '';
};

/* Средний FPS за секунду прячет рывки: один кадр по 60 мс среди
   шестидесяти по 16 даёт «58 fps», а рукой это чувствуется как провал.
   Поэтому копим и худший кадр окна. */
let frames = 0, winT = 0, upT = 0, worstDt = 0;
export function adaptFrame(dt: number) {
  frames++; winT += dt;
  worstDt = Math.max(worstDt, dt);
  if (winT >= CONFIG.ADAPT.window) {
    const fps = frames / winT;
    if (fps < CONFIG.ADAPT.down && app.dprIndex > 0) { app.dprIndex--; applyDpr(); upT = 0; }
    else if (fps > CONFIG.ADAPT.up) {
      upT += winT;
      if (upT >= CONFIG.ADAPT.upHold && app.dprIndex < app.dprCap) { app.dprIndex++; applyDpr(); upT = 0; }
    } else upT = 0;
    if (app.showFps) {
      const r = renderer.info.render;
      const worstFps = 1 / Math.max(1e-3, worstDt);
      $('fps').textContent =
        `${fps.toFixed(0)} fps   худший кадр ${(worstDt * 1000).toFixed(0)} мс (${worstFps.toFixed(0)} fps)\n`
        + `рендер ×${renderScale().toFixed(2)}   ${app.aaLabel}   ${rendererLabel()}\n`
        + `draw ${r.calls}   tri ${(r.triangles / 1000).toFixed(0)}k`;
    }
    frames = 0; winT = 0; worstDt = 0;
  }
}
