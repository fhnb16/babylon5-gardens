import { CONFIG } from './cfg.ts';
import { app, renderer, scene, camera, worldGroup } from './state.ts';
import { resize } from './perf.ts';
import { pt, modernPath, overlayPath } from './path-session.ts';
import { trace, renderFrame } from '../js/photo.js';
import { isClassic, readFrame } from './boot.ts';

/* ═══════════════════════════════════════════════════════════════════════════
   СНИМОК
   Берётся сразу после отрисовки кадра (цикл зовёт grabShot, когда
   app.shotPending): так не нужен preserveDrawingBuffer.
   ═══════════════════════════════════════════════════════════════════════════ */
function saveCanvas(w: number, h: number, src: CanvasImageSource = renderer.domElement) {
  /* Ужимаем крупный кадр до нативного размера: каждый пиксель усредняет
     scale² отсчётов — то же, что делает суперсэмплинг, только без платы
     за него в реальном времени. */
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, w, h);
  c.toBlob(saveBlob, 'image/png');
}

function saveBlob(blob: Blob | null) {
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `babylon5-${CONFIG.SEED}-${Date.now()}.png`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* Новый путь (WebGPURenderer): кадр рисуется в render target и читается
   readRenderTargetPixelsAsync — без preserveDrawingBuffer и без чтения
   канваса WebGPU. Чтение асинхронное, поэтому увеличенный кадр собирается
   и возвращается к обычному размеру внутри этой функции. */
async function grabShotNode(accumulated = false) {
  const nw = renderer.domElement.width, nh = renderer.domElement.height;
  if (!accumulated) { app.shotBoost = CONFIG.SHOT.scale; resize(); }
  try {
    const f = await readFrame(renderer, scene, camera, worldGroup.rotation.z);
    if (!f) return;
    const big = document.createElement('canvas');
    big.width = f.width; big.height = f.height;
    big.getContext('2d')!.putImageData(new ImageData(f.data as Uint8ClampedArray<ArrayBuffer>, f.width, f.height), 0, 0);
    saveCanvas(nw, nh, big);
  } finally {
    if (!accumulated) { app.shotBoost = 1; resize(); }
  }
}

export function grabShot() {
  const modern = modernPath();
  if (modern?.pt.active) {
    if (!modern.pt.ready || !modern.pt.samples) return;
    if (overlayPath()) void modern.pathSnapshot().then(saveBlob);
    else void grabShotNode(true).catch(err => console.error('shot:', err));
    return;
  }
  if (!isClassic()) {
    grabShotNode(trace.active).catch(err => console.error('shot:', err));
    return;
  }
  /* Накопленный кадр — хоть путём, хоть экранными лучами — пересобирать
     нельзя: перерисовка стёрла бы всё накопленное. Просто ужимаем то, что
     уже на канвасе. */
  if (pt.active) { saveCanvas(renderer.domElement.width, renderer.domElement.height); return; }
  if (trace.active) {
    saveCanvas(Math.round(renderer.domElement.width / CONFIG.SHOT.scale),
      Math.round(renderer.domElement.height / CONFIG.SHOT.scale));
    return;
  }
  const nw = renderer.domElement.width, nh = renderer.domElement.height;
  app.shotBoost = CONFIG.SHOT.scale;
  resize();
  renderFrame(renderer, scene, camera, worldGroup.rotation.z);
  saveCanvas(nw, nh);
  app.shotBoost = 1;
  resize();
}
