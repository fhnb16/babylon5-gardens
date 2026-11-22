import * as THREE from 'three';
import { CONFIG } from './cfg.ts';
import { $ } from './dom.ts';
import { app, renderer, scene, camera, worldGroup, world } from './state.ts';
import { sunLevelNow } from './palette.ts';
import { closeSheets } from './ui/sheets.ts';
import { resize } from './perf.ts';
import { setDetailFull } from './scene.ts';
import { TEX } from '../core/textures/ids.ts';
import { isMobile } from '../js/controls.js';
import { startPath, setPaused } from '../js/pathtrace.js';
import { pt, stopPath, pathLabel, samplesNeeded, pathClock, noiseNow, startModern,
  modernPath, pathStarting } from './path-session.ts';
import { trace, tracePlan, startTrace, stopTrace, renderFrame, composite, setDenoise, forcePost,
  setBrightScale, setDenoiseGuide, renderGuide, denoisePasses,
  setTraceDebug, DEBUG_NAMES } from '../js/photo.js';
import { isClassic, renderNow, rendererInfo, setPostOptions } from './boot.ts';

/* ═══════════════════════════════════════════════════════════════════════════
   ФОТО-РЕЖИМ
   Снимок берётся сразу после отрисовки кадра: так не нужен
   preserveDrawingBuffer, который стоит производительности всё время.
   ═══════════════════════════════════════════════════════════════════════════ */
/* Экранные лучи используют MRT на WebGPU и отдельные проходы в classic. */
const PHOTO_HINT = 'доступно в WebGPU и классическом WebGL';
const supportsScreenRays = () => isClassic() || rendererInfo()?.kind === 'webgpu';
const SCREEN_RAY_BUTTONS = ['bTrace', 'bDebug'];
let pathRequest = 0;

/** На откате WebGL2 объясняем, какие режимы поддерживают экранные лучи. */
export function markPhotoButtons() {
  if (supportsScreenRays()) return;
  for (const id of SCREEN_RAY_BUTTONS) {
    const el = $(id) as HTMLElement | null;
    if (!el) continue;
    el.setAttribute('aria-disabled', 'true');
    el.style.opacity = '0.4';
    el.title = `${el.title} — ${PHOTO_HINT}`;
  }
}

/** true — режим съёмки доступен; иначе показывает подсказку */
function screenRaysAvailable(): boolean {
  if (supportsScreenRays()) return true;
  showTrace(`Фото-режим: ${PHOTO_HINT}\n(настройки → Рендерер)`);
  return false;
}

export function setClean(on: boolean) {
  app.cleanView = on;
  document.body.classList.toggle('clean', on);
  if (on) {
    closeSheets();
    /* Станцию останавливаем: снимок делается с неподвижного кадра, а
       вращение к тому же обнуляет накопление трассировки. Скорость
       запоминаем и возвращаем на выходе. */
    app.omegaSaved = app.omega;
    app.omega = 0;
  } else {
    app.omega = app.omegaSaved;
    /* Выход обязан снять ВСЁ, что включает фото-режим, иначе трассировка
       продолжает считать в фоне, цепочка постобработки висит поднятой, а на
       экране остаётся последний её кадр. */
    exitPhotoModes();
  }
}

/** Снять все режимы съёмки разом. Раньше выход гасил только экранные лучи:
    трассировка пути оставалась активной, а её результат — на канвасе. */
function exitPhotoModes() {
  pathRequest++;
  setTraceDebug(0);
  setTrace(false);
  stopPath();
  setDetailFull(false);
  if (isClassic()) forcePost(renderer, false);
  setBrightScale(1);
  setDenoise(false);
  app.traceHeld = false;
  for (const id of ['bDebug', 'bPath', 'bPause', 'bTrace']) {
    $(id)?.classList.remove('on');
  }
  $('traceInfo').classList.remove('show');
  /* и сразу перерисовываем обычный кадр: иначе на экране висит последний
     кадр трассировки, пока не наступит следующий тик */
  if (!isClassic()) { renderNow(renderer, scene, camera, worldGroup.rotation.z, true); return; }
  renderFrame(renderer, scene, camera, worldGroup.rotation.z);
}

/* Трассировка идёт только по неподвижному кадру: любое движение мира или
   камеры обнулило бы накопленное. Поэтому на время съёмки мир замирает. */
/** Единственное место, где пишется строка индикатора: раньше её ставили в
    трёх местах по-разному, и сообщение об отказе терялось. */
export function showTrace(text: string) {
  const el = $('traceInfo');
  el.textContent = text;
  el.classList.add('show');
}

/** Развёрнутая сводка о съёмке. Одной строки не хватало: там уживались
    прогресс, шум, время дерева и способ очистки, и прочитать её на ходу было
    нельзя. Здесь по строке на смысл. */
export function traceReport() {
  const rows: string[] = [];
  const secs = pathClock() / 1000;

  if (pt.active) {
    rows.push(pt.ready
      ? `путь · шум ${noiseNow().toFixed(2)}% из ${app.noiseWant}%`
      : 'строится дерево обхода…');
    if (pt.ready) {
      rows.push(`выборок ${pt.samples | 0} из ${samplesNeeded()} · ${secs.toFixed(0)} с`);
      if (pt.buildMs) {
        rows.push(`дерево ${(pt.buildMs / 1000).toFixed(1)} с${pt.threaded ? ' в потоке' : ''}`
          + ` · отскоков ${CONFIG.PATH.bounces}`);
      }
    }
    if (pt.paused) {
      const denoised = modernPath()?.pt.showing;
      rows.push(denoised === 'oidn' ? 'пауза · Open Image Denoise' :
        denoised === 'atrous' ? 'пауза · à-trous' : 'пауза · счёт остановлен');
    }
  } else if (trace.active) {
    rows.push(`лучи · ${(trace.sample / Math.max(1, trace.total) * 100) | 0}%`);
    rows.push(`выборок ${trace.sample} из ${trace.total} · ${trace.rays} лучей`);
  }

  /* Разрешения: на чём считаем, что видит экран, во что растянули. */
  const s = renderer.getDrawingBufferSize(new THREE.Vector2());
  const css = `${innerWidth | 0}×${innerHeight | 0}`;
  rows.push(`счёт ${s.x | 0}×${s.y | 0} · экран ${css}`);

  const dn = denoisePasses();
  const r = renderer.info.render;
  rows.push(`граней ${(r.triangles / 1000) | 0}k · вызовов ${r.calls}`
    + (dn ? ` · очистка ×${dn}` : ''));

  if (pt.error) rows.push(`отказ: ${pt.error}`);
  return rows.join('\n');
}

export function setTrace(on: boolean) {
  if (on && (!screenRaysAvailable() || !world)) return;
  const info = $('traceInfo'), btn = $('bTrace');
  if (on && !trace.active) {
    if (pt.active || pathStarting) {
      pathRequest++; stopPath();
      $('bPath').classList.remove('on'); $('bPause').classList.remove('on');
    }
    app.shotBoost = CONFIG.SHOT.scale;      // трассируем сразу в масштабе снимка
    resize();
    /* на время съёмки все деревья на полной детализации: сцена
       неподвижна, а крест из плоскостей выдаёт себя на снимке */
    setDetailFull(true);
    if (!isClassic()) {
      const plan = tracePlan(isMobile);
      Object.assign(trace, { active: true, sample: 0, total: plan.samples, rays: plan.rays, debug: 0 });
      app.traceHeld = false;
      setPostOptions({ screenTrace: 0, traceClean: false });
    } else if (world) startTrace(renderer, scene, camera, world.windUniforms.uWind, isMobile);
  } else if (!on && trace.active) {
    if (isClassic()) stopTrace(world ? world.windUniforms.uWind : { value: app.windNow });
    else {
      trace.active = false;
      app.traceHeld = false;
      setPostOptions({ screenTrace: -1, traceClean: false });
    }
    setDetailFull(false);
    app.shotBoost = 1;
    resize();
  }
  btn.classList.toggle('on', trace.active);
  info.classList.toggle('show', trace.active);
  if (!trace.active) info.textContent = '';
}
export const stopTracing = () => { if (trace.active) setTrace(false); };

/* Пауза с очисткой: накопление останавливается, кадр проходит через
   шумоподавитель. Деталей, которых ещё нет, он не создаст, но зерно уберёт
   и снимок можно делать раньше. Повторное нажатие возвращает расчёт. */
export function toggleDenoisePause() {
  const modern = modernPath();
  if (modern?.pt.active) {
    if (!modern.pt.ready) return;
    const on = !modern.pt.paused;
    modern.setPaused(on, $('sPathClean').value === 'atrous' ? 'atrous' : 'oidn');
    $('bPause').classList.toggle('on', on);
    return;
  }
  if (!isClassic()) {
    if (!trace.active || !screenRaysAvailable()) return;
    app.traceHeld = !app.traceHeld;
    setPostOptions({ traceClean: app.traceHeld });
    renderNow(renderer, scene, camera, worldGroup.rotation.z, true);
    $('bPause').classList.toggle('on', app.traceHeld);
    return;
  }
  const bPause = $('bPause');
  const on = !pt.paused && !app.traceHeld;
  if (pt.active) setPaused(on);
  app.traceHeld = pt.active ? false : on;
  /* Цепочка обязана существовать и здесь. При экранной трассировке
     forcePost не вызывался, буферов очистки не было вовсе — и фильтр
     молча не выполнялся ни разу. */
  if (on) forcePost(renderer, true);
  /* Направляющий кадр снимаем один раз при включении: сцена неподвижна,
     пересчитывать его каждый кадр незачем. Порядок важен: до forcePost
     материала фильтра ещё нет, и кадр было бы некуда положить. */
  setDenoiseGuide(on ? renderGuide(renderer, scene, camera) : null);
  setDenoise(on);
  if (!on && !pt.active) forcePost(renderer, false);
  bPause.classList.toggle('on', on);
}

/* Полная трассировка пути: считает настоящий путь света по дереву обхода
   всей геометрии, без экранных ограничений. Библиотека грузится по первому
   включению — она весит больше самого проекта. */
export async function togglePath() {
  const request = ++pathRequest;
  const bPath = $('bPath');
  if (pt.active || pt.error || pathStarting) {
    stopPath();
    if (isClassic()) forcePost(renderer, false);
    setBrightScale(1);
    setDetailFull(false);
    bPath.classList.remove('on');
    $('bPause').classList.remove('on');
    $('traceInfo').classList.remove('show');
    return;
  }
  setTrace(false);
  setTraceDebug(0);
  bPath.classList.add('on');
  /* сразу показываем, что нажатие принято: библиотека грузится с сети и
     дерево строится не мгновенно, без отклика это выглядит как поломка */
  /* Порядок важен: сперва надпись, потом долгая работа. Постройка дерева
     блокирует поток на секунды, и без заранее отрисованного предупреждения
     это неотличимо от зависшей вкладки. */
  showTrace('загрузка библиотеки…');
  /* Полную детализацию включаем ДО постройки дерева обхода: оно
     строится по той геометрии, что видно в этот момент. */
  setDetailFull(true);
  let modern: boolean | null;
  try {
    modern = await startModern(showTrace);
  } catch (error) {
    if (request !== pathRequest) return;
    stopPath();
    setDetailFull(false);
    bPath.classList.remove('on');
    showTrace(`Ошибка запуска: ${String(error)}`);
    return;
  }
  if (request !== pathRequest) return;
  if (modern !== null || !isClassic()) {
    if (!modern) {
      setDetailFull(false);
      bPath.classList.remove('on');
      showTrace(modern === null ? 'Для трассировки пути требуется WebGPU или классический WebGL.' : pathLabel());
    }
    return;
  }
  /* Цепочка постобработки должна существовать: результат пути идёт
     через неё, а при выключенном сглаживании её просто не было. */
  forcePost(renderer, true);
  /* эмиссия в трассировке усилена — порог свечения обязан подняться */
  setBrightScale(CONFIG.PATH.emitBoost * CONFIG.PATH.brightRatio);
  if (!world) { bPath.classList.remove('on'); return; }
  const w = world;
  /* Корпус — тот, с которым сталкивается камера; труба — роль axis.sun.
     Корпус ядра смотрит внутрь (FrontSide) с запечённой развёрткой θ, и его
     normalScale уже «как отрисовано» (−1, −1): трассировщик строит базис
     касательных по той же развёртке, что и растр, поэтому ни сторону, ни
     масштаб рельефа подменять не нужно (прежний корпус BackSide с
     repeat.x = −1 давал трассировщику перевёрнутую касательную). */
  const hullMat = (w.collider?.material ?? w.materialOf('hull')) as THREE.Material | null;
  const sunMat = w.materialOf('axis.sun');
  /* станцию и ветер уже остановил фото-режим — сцена статична */
  const okStart = await startPath(renderer, scene, camera, w.windUniforms.uWind, isMobile,
    showTrace, sunMat, w.lights.hemi,
    /* Результат пути идёт через ту же постобработку, что и обычный кадр:
       библиотека рисует прямо в канвас и минует свечение, лучи от оси и
       всё сглаживание. */
    /* Своя экспозиция: труба здесь площадной источник, а в обычном кадре
       не светит вовсе, и общая экспозиция для них не годится. */
    (texture: THREE.Texture) => composite(renderer, texture,
      renderer.toneMappingExposure * CONFIG.PATH.exposure),
    hullMat, w.textures.get(TEX.waterRough),
    w.hullUniforms.uCityGlow.value > 0.2 ? 0xffd9a0 : 0xcfe0ff,
    /* яркость трубы берём из текущей фазы, иначе день выбеливает */
    sunMat ? Math.max(0.25, sunLevelNow()) : 1,
    /* периметральная подсветка — ночная деталь */
    /* waterNormal в JS объявлен с «= null»: выведенный тип уже настоящего */
    1 - app.daylight, w.textures.get(TEX.waterNormal) as unknown as null);
  if (!okStart) {
    bPath.classList.remove('on');
    setDetailFull(false);
    forcePost(renderer, false);
    setBrightScale(1);
    showTrace(pathLabel());
  }
}

/* Наглядный ответ на вопрос «а точно ли это считается лучами»: показываем
   ТОЛЬКО вклад трассировки, без исходной картинки. Видно и что посчитано,
   и как оно сходится с каждым кадром. */
export function cycleTraceDebug() {
  if (!screenRaysAvailable()) return;
  const bDebug = $('bDebug');
  if (!trace.active) setTrace(true);
  setTraceDebug((trace.debug + 1) % DEBUG_NAMES.length);
  if (!isClassic() && trace.active) {
    setPostOptions({ screenTrace: trace.debug });
    trace.sample = 0;
    if (app.traceHeld) renderNow(renderer, scene, camera, worldGroup.rotation.z, true);
  }
  bDebug.classList.toggle('on', trace.debug > 0);
}
