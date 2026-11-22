import * as THREE from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import { CONFIG } from './cfg.ts';
import { $, stage } from './dom.ts';
import { initScene } from './state.ts';
import { prefs } from './prefs.ts';
import { rebuild } from './scene.ts';
import { goTo } from './flight.ts';
import { createRenderer, parseRendererMode, type B5Renderer, type RendererMode } from '../backends/three/renderer.ts';
import { createRenderPipeline, type PostOptions, type PostPipeline } from '../backends/three/post/pipeline.ts';
import { axisSunScreen } from '../backends/three/post/axisRays.ts';
import { renderFrame } from '../js/photo.js';

/** Есть ли вообще WebGL: без него запускать нечего */
export function probeWebGL() {
  const probe = document.createElement('canvas');
  if (!(probe.getContext('webgl2') || probe.getContext('webgl'))) throw new Error('WebGL недоступен');
}

/* ═══════════════════════════════════════════════════════════════════════════
   РЕНДЕРЕР: какой из трёх и как им рисовать кадр

   • classic — прежний WebGLRenderer: материалы с GLSL-патчами, постобработка
     и экранные лучи из js/photo.js, резервный PT для устройств без WebGPU;
   • webgpu  — WebGPURenderer на устройстве из pathtracer/device.ts (его делит
     WGSL-трассировщик), узловые материалы на общих ядрах core
     (backends/three/materials/node.ts);
   • webgl2  — тот же WebGPURenderer на откате WebGL2.

   Выбор: ?renderer=webgpu|webgl2|classic в адресе перебивает настройку
   «Рендерер» (prefs 'renderer'); по умолчанию в 2.13.0 — классический. Смена рендерера — перезагрузка страницы:
   канвас и мир привязаны к нему.

   Новый путь рисует кадр через RenderPipeline из backends/three/post
   (юнит R1b): тонмаппинг ACES и sRGB делает сама цепочка (экспозиция —
   setExposure, renderer.toneMapping ей безразличен), сглаживание, свечение и
   лучи — её опции, цикл — renderer.setAnimationLoop. Экранные лучи и HDR-вывод пути на WebGPU используют ту же цепочку.
   ═══════════════════════════════════════════════════════════════════════════ */

export const RENDERER_LABELS: Record<RendererMode, string> = {
  webgpu: 'WebGPU',
  webgl2: 'WebGL2',
  classic: 'Классический WebGL'
};


/** Режим из адреса (?renderer=) или из настроек; по умолчанию классический */
export function wantedRendererMode(search = location.search): RendererMode {
  const url = parseRendererMode(new URLSearchParams(search).get('renderer'));
  return url ?? parseRendererMode(prefs.get('renderer', 'classic')) ?? 'classic';
}

/** true, если режим задан адресом — тогда настройка его не меняет */
export const rendererFromUrl = (search = location.search): boolean =>
  parseRendererMode(new URLSearchParams(search).get('renderer')) !== null;

let b5r: B5Renderer | null = null;
let post: PostPipeline | null = null;
/** опции цепочки, которые настройки успели сообщить до её создания */
let pendingPost: Partial<PostOptions> = {};

export const rendererInfo = () => b5r?.info ?? null;
/** классический путь: фото-режим, js/photo.js, js/pathtrace.js */
export const isClassic = (): boolean => !b5r || !b5r.isNode;
export const postInfo = () => post?.describe() ?? null;
export const pathSurface = () => b5r?.kind === 'webgpu' && post
  ? { post, device: b5r.device ?? ((b5r.renderer as WebGPURenderer).backend as unknown as { device: GPUDevice }).device }
  : null;

/** Опции сглаживания/свечения/лучей из настроек (новый путь) */
export function setPostOptions(o: Partial<PostOptions>) {
  if (post) post.setOptions(o);
  else pendingPost = { ...pendingPost, ...o };
}

const _sun = { uv: new THREE.Vector2(0.5, 0.5), visible: false };

/** Нарисовать обычный кадр. advance — вне цикла анимации (снимок): см. backends/three/post/README.md */
export function renderNow(renderer: unknown, scene: THREE.Scene, camera: THREE.Camera, worldRotZ: number, advance = false) {
  if (isClassic()) {
    renderFrame(renderer, scene, camera, worldRotZ);
    return;
  }
  if (!post) return;
  axisSunScreen(camera, CONFIG.L / 2, _sun);
  post.setSunScreen(_sun.uv, _sun.visible);
  post.render(advance);
}

/** Кадр нового пути в RGBA8, строки сверху вниз (снимок): render target + readRenderTargetPixelsAsync */
export async function readFrame(renderer: unknown, scene: THREE.Scene, camera: THREE.Camera, worldRotZ: number)
  : Promise<{ width: number; height: number; data: Uint8ClampedArray } | null> {
  if (isClassic() || !post) return null;
  const r = renderer as WebGPURenderer;
  const size = r.getDrawingBufferSize(new THREE.Vector2());
  const w = Math.max(1, size.x | 0), h = Math.max(1, size.y | 0);
  const rt = new THREE.RenderTarget(w, h, { depthBuffer: false });
  try {
    r.setRenderTarget(rt);
    renderNow(r, scene, camera, worldRotZ, true);
    r.setRenderTarget(null);
    const px = await r.readRenderTargetPixelsAsync(rt, 0, 0, w, h) as Uint8Array;
    const data = new Uint8ClampedArray(w * h * 4);
    /* WebGL2-откат читает снизу вверх, WebGPU — сверху вниз */
    const bottomUp = !(r.backend as unknown as { isWebGPUBackend?: boolean }).isWebGPUBackend;
    const row = w * 4;
    for (let y = 0; y < h; y++) {
      const src = bottomUp ? h - 1 - y : y;
      data.set(px.subarray(src * row, src * row + row), y * row);
    }
    return { width: w, height: h, data };
  } finally {
    r.setRenderTarget(null);
    rt.dispose();
  }
}

/** Цикл кадра: classic — requestAnimationFrame, новый путь — setAnimationLoop */
export function startLoop(renderer: unknown, frame: () => void) {
  if (isClassic()) {
    const tick = () => { requestAnimationFrame(tick); frame(); };
    tick();
  } else {
    void (renderer as WebGPURenderer).setAnimationLoop(frame);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   СЦЕНА
   Рендерер, сцена и камера создаются до интерфейса и ввода (их ждут
   обработчики), мир — асинхронно: описание строит ядро, текстуры считают
   workers. Пока мир не готов, кадр не рисуется и висит заставка (#loader);
   цикл ждёт мира сам. WebGPURenderer поднимается асинхронно (устройство,
   init()), поэтому и сам рендерер — bootRenderer() ждут до интерфейса.
   ═══════════════════════════════════════════════════════════════════════════ */
export async function bootRenderer(): Promise<void> {
  const mode = wantedRendererMode();
  /* MSAA берётся из буфера постобработки: у канваса он задаётся при
     создании и на лету не выключается, а «выкл» обязан выключать всё */
  try {
    b5r = await createRenderer({ mode, antialias: false, powerPreference: 'high-performance' });
  } catch (e) {
    /* WebGPURenderer не поднялся вовсе — работаем на классическом */
    console.warn(`renderer ${mode} failed, falling back to classic:`, e);
    b5r = await createRenderer({ mode: 'classic', antialias: false, powerPreference: 'high-performance' });
    b5r.info.fallback = `${mode}: ${(e as Error).message}`;
  }
  const renderer = b5r.renderer;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  /* экспозиция ACES; новому пути её передаём в цепочку (setExposure) */
  renderer.toneMappingExposure = 1.22;
  renderer.shadowMap.enabled = false;   // тени — контактные пятна и аналитика в шейдере
  /* updateStyle = false обязателен: иначе three прописывает канвасу инлайновые
     style.width/height в пикселях стартового окна, и они навсегда перебивают
     CSS width:100%. Именно поэтому в полном экране оставались чёрные поля. */
  /* Считать статистику сами: three обнуляет её на каждом render(), и с
     постобработкой в счётчик попадал последний проход — полноэкранный квад.
     Отсюда «draw 1, tri 0k» и полное безразличие цифр к пресету. */
  renderer.info.autoReset = false;
  renderer.setSize(innerWidth, innerHeight, false);
  stage.appendChild(renderer.domElement);
  b5r.device?.onLost(info => {
    $('fatal').classList.add('show');
    $('fatal').firstElementChild.innerHTML =
      `<b>Устройство WebGPU потеряно</b><br>${info.message || info.reason}. Обновите страницу.`;
  });

  const scene = new THREE.Scene();
  /* туман и фон до первой сборки; дальше их держит мир (world.fog) */
  scene.fog = new THREE.FogExp2(CONFIG.DAY.fog, CONFIG.DAY.fogD);
  scene.background = new THREE.Color(CONFIG.DAY.fog);

  const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.2, CONFIG.FAR);
  initScene({ renderer, scene, camera });
  if (!isClassic()) {
    post = createRenderPipeline(renderer as WebGPURenderer, scene, camera, {
      /* классическое свечение — точный порт прежнего и дешевле bloom() */
      bloomImpl: 'classic',
      exposure: renderer.toneMappingExposure,
      ...pendingPost
    });
    pendingPost = {};
  }
  /* камера на первой точке сразу: станция до сборки не вращается, и
     заглушка stationGroup даёт ту же систему координат, что и мир */
  goTo(0, true);
}

/** Мир: описание ядра → объекты three; заставка уходит, когда он готов */
export function boot(): Promise<void> {
  return rebuild().then(() => { $('loader')?.classList.add('done'); });
}
