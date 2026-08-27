import * as THREE from 'three';
import { CONFIG } from './config.js';

/* ═══════════════════════════════════════════════════════════════════════════
   ПОЛНАЯ ТРАССИРОВКА ПУТИ

   Экранная трассировка принципиально ограничена: луч видит только то, что
   попало в кадр. Отсюда и чёрные пятна по краям, и приходилось подпирать её
   аналитическими телами. Здесь считается настоящий путь света по дереву
   обхода всей геометрии — ни экрана, ни подпорок.

   Библиотека грузится ЛЕНИВО, по первому включению: она весит заметно
   больше самого проекта, и платить за неё при обычном запуске незачем.

   Дерево обхода строится один раз. Это возможно потому, что фото-режим уже
   останавливает вращение станции и ветер: сцена на время съёмки статична.
   Стоимость дерева растёт с числом треугольников — на ультре это сотни
   мегабайт. Если устройство не потянет, ловим отказ и честно говорим об
   этом, а обычный кадр остаётся доступен.
   ═══════════════════════════════════════════════════════════════════════════ */

export const pt = {
  active: false,      // трассировка идёт
  ready: false,       // дерево построено, идут выборки
  build: 0,           // прогресс постройки дерева, 0…1
  samples: 0,         // накоплено выборок
  error: null         // текст отказа, если не запустилось
};

let tracer = null, lib = null, R = null, S = null, C = null;
let savedWind = 1, windU = null, hidden = [];

/** Подгрузить библиотеку. Отдельной функцией, чтобы отказ был обрабатываем. */
async function load() {
  if (lib) return lib;
  lib = await import('three-gpu-pathtracer');
  return lib;
}

/** Объекты, которым в трассировке не место: спрайты, декали, дымка.
    Точки и прозрачные плоскости дерево обхода не описывает — они дали бы
    чёрные дыры там, где должен быть воздух. */
function hideNonSolid(scene) {
  hidden = [];
  scene.traverse(o => {
    if (!o.visible) return;
    const solid = o.isMesh && o.material && !o.material.transparent;
    if ((o.isPoints || o.isSprite || (o.isMesh && !solid)) && o !== scene) {
      hidden.push(o);
      o.visible = false;
    }
  });
}

function restoreHidden() {
  for (const o of hidden) o.visible = true;
  hidden = [];
}

/** Запустить трассировку. Возвращает false, если устройство не потянуло. */
export async function startPath(renderer, scene, camera, wind, mobile) {
  if (pt.active) return true;
  R = renderer; S = scene; C = camera; windU = wind;
  pt.error = null; pt.build = 0; pt.samples = 0; pt.ready = false;

  try {
    const { WebGLPathTracer } = await load();

    /* Ветер останавливаем: дерево описывает геометрию в покое, а кроны
       смещает вершинный шейдер — трассировщик этого смещения не увидит. */
    savedWind = windU.value;
    windU.value = 0;
    hideNonSolid(scene);

    tracer = new WebGLPathTracer(renderer);
    const P = CONFIG.PATH;
    tracer.renderScale = mobile ? P.mobileScale : P.scale;
    tracer.tiles.set(mobile ? P.mobileTiles : P.tiles, 1);
    tracer.bounces = mobile ? P.mobileBounces : P.bounces;
    tracer.minSamples = 1;
    tracer.renderDelay = 0;
    tracer.fadeDuration = 0;
    tracer.dynamicLowRes = false;
    tracer.textureSize.set(P.texSize, P.texSize);

    pt.active = true;
    await tracer.setSceneAsync(scene, camera, {
      onProgress: v => { pt.build = v; }
    });
    pt.build = 1;
    pt.ready = true;
    return true;
  } catch (e) {
    pt.error = String(e && e.message ? e.message : e);
    stopPath();
    return false;
  }
}

/** Сообщить, что камера сдвинулась: накопление начинается заново. */
export function pathCameraMoved() {
  if (pt.active && pt.ready && tracer) {
    tracer.updateCamera();
    pt.samples = 0;
  }
}

/** Один шаг накопления. Возвращает долю готовности 0…1.

    Набрав нужное, перестаём считать: кадр уже готов, и жечь GPU впустую
    незачем — путь стоит на порядок дороже обычной отрисовки. */
export function pathStep() {
  if (!pt.active || !pt.ready) return 0;
  const done = Math.min(1, pt.samples / CONFIG.PATH.samples);
  if (done >= 1) return 1;
  try {
    tracer.renderSample();
    pt.samples = tracer.samples;
  } catch (e) {
    pt.error = String(e && e.message ? e.message : e);
    stopPath();
    return 1;
  }
  return Math.min(1, pt.samples / CONFIG.PATH.samples);
}

export function stopPath() {
  if (windU) windU.value = savedWind;
  restoreHidden();
  if (tracer) {
    try { tracer.dispose?.(); } catch { /* нечего освобождать */ }
  }
  tracer = null;
  pt.active = false; pt.ready = false; pt.build = 0; pt.samples = 0;
  R = S = C = null;
}

/** Сообщение для индикатора: постройка дерева и накопление — разные фазы,
    и путать их нельзя. Дерево может строиться десятки секунд. */
export function pathLabel() {
  if (pt.error) return `путь недоступен · ${pt.error}`;
  if (!pt.ready) return `дерево обхода · ${(pt.build * 100) | 0}%`;
  const done = Math.min(1, pt.samples / CONFIG.PATH.samples);
  return done >= 1
    ? `готово · ${pt.samples} выборок пути`
    : `путь · ${(done * 100) | 0}% · выборок ${pt.samples}`;
}
