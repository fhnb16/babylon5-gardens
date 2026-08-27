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
  build: 0,           // 0 — дерево строится, 1 — построено
  buildMs: 0,         // сколько заняла постройка
  samples: 0,         // накоплено выборок
  error: null         // текст отказа, если не запустилось
};

/** Отдать кадр браузеру, чтобы он успел отрисовать предупреждение */
const nextFrame = () => new Promise(r => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => r());
  else setTimeout(r, 16);
});

let tracer = null, lib = null, R = null, S = null, C = null;
let savedWind = 1, windU = null, hidden = [];
let expanded = [], clones = [], swapped = [];
let prevEnv = null, envTex = null;

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

/* ─── Инстансы ───
   Сборщик геометрии проверяет только `isMesh` и берёт у объекта ОДНУ
   геометрию, не разворачивая матрицы экземпляров. Для InstancedMesh это
   значит, что все 3800 деревьев схлопываются в одно в начале координат: в
   дерево обхода попадало 3.76% сцены, оно строилось за 0.2 с, а кадр выходил
   пустым. Разворачиваем инстансы в обычные меши на время съёмки. */
function expandInstances(scene) {
  const src = [];
  scene.traverse(o => { if (o.isInstancedMesh && o.visible && o.count > 0) src.push(o); });

  const m = new THREE.Matrix4();
  const col = new THREE.Color();
  const byColor = new Map();
  for (const im of src) {
    const holder = new THREE.Group();
    holder.matrixAutoUpdate = false;
    for (let k = 0; k < im.count; k++) {
      im.getMatrixAt(k, m);
      const mesh = new THREE.Mesh(im.geometry, im.material);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(m);
      /* Цвет экземпляра переносим в материал, иначе вся роща выйдет одного
         оттенка. Но клонировать материал на КАЖДЫЙ экземпляр нельзя — это
         десять тысяч материалов на сцену. Оттенки берутся из небольших
         палитр, поэтому различных цветов на тип всего десяток: заводим по
         одному материалу на цвет и переиспользуем. */
      if (im.instanceColor) {
        im.getColorAt(k, col);
        const key = col.getHex();
        let mat = byColor.get(im.material.uuid + ':' + key);
        if (!mat) {
          mat = im.material.clone();
          mat.color.copy(col);
          byColor.set(im.material.uuid + ':' + key, mat);
          clones.push(mat);
        }
        mesh.material = mat;
      }
      holder.add(mesh);
    }
    im.parent.add(holder);
    holder.matrix.copy(im.matrixWorld);
    holder.matrix.premultiply(m.copy(im.parent.matrixWorld).invert());
    expanded.push({ holder, im, wasVisible: im.visible });
    im.visible = false;
  }
}

function collapseInstances() {
  for (const e of expanded) {
    e.holder.parent?.remove(e.holder);
    e.im.visible = e.wasVisible;
  }
  for (const mm of clones) mm.dispose();
  expanded = []; clones = [];
}

/* ─── Свет ───
   Две вещи, без которых кадр выходит чёрным.

   Первая: полусферный источник библиотека не поддерживает вовсе — в её
   списке только точечные, направленные, прожекторы и площадные. Рассеянный
   свет заменяем окружением того же цвета: однопиксельная карта, растянутая
   на всю сферу, даёт ровно ту же равномерную подсветку.

   Вторая: солнце у нас — базовый материал. В трассировке он не светит, а
   просто окрашен: базовый материал не участвует в переносе света. На время
   съёмки труба получает светящийся материал, и именно он становится главным
   источником, как и должно быть. */
function lightForPath(scene, sunMat, hemi) {
  swapped = [];

  if (sunMat) {
    const lit = new THREE.MeshStandardMaterial({
      color: 0x000000,
      emissive: sunMat.color.clone(),
      emissiveIntensity: CONFIG.PATH.sunEmit,
      side: THREE.DoubleSide
    });
    clones.push(lit);
    scene.traverse(o => {
      if (o.isMesh && o.material === sunMat) {
        swapped.push({ mesh: o, prev: o.material });
        o.material = lit;
      }
    });
  }

  prevEnv = scene.environment;
  if (hemi) {
    const c = new THREE.Color().copy(hemi.color).lerp(hemi.groundColor, 0.4)
      .multiplyScalar(hemi.intensity * CONFIG.PATH.envScale);
    /* однопиксельная равноугольная карта: ровная подсветка со всех сторон */
    const tex = new THREE.DataTexture(
      new Float32Array([c.r, c.g, c.b, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.needsUpdate = true;
    envTex = tex;
    scene.environment = tex;
  }
}

function restoreLight(scene) {
  for (const s of swapped) s.mesh.material = s.prev;
  swapped = [];
  if (scene) scene.environment = prevEnv;
  envTex?.dispose();
  envTex = null;
}

/** Запустить трассировку. Возвращает false, если устройство не потянуло. */
export async function startPath(renderer, scene, camera, wind, mobile, onPhase, sunMat, hemi) {
  if (pt.active) return true;
  R = renderer; S = scene; C = camera; windU = wind;
  pt.error = null; pt.build = 0; pt.samples = 0; pt.ready = false;

  try {
    const { WebGLPathTracer } = await load();
    onPhase?.('строится дерево обхода, это займёт время…');

    /* Ветер останавливаем: дерево описывает геометрию в покое, а кроны
       смещает вершинный шейдер — трассировщик этого смещения не увидит. */
    savedWind = windU.value;
    windU.value = 0;
    hideNonSolid(scene);
    expandInstances(scene);
    lightForPath(scene, sunMat, hemi);
    scene.updateMatrixWorld(true);

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

    /* Дерево обхода строится СИНХРОННО. Асинхронная сборка требует worker'а
       (`setBVHWorker`), а worker не наследует карту импортов страницы: ему
       пришлось бы разрешать 'three' и 'three-mesh-bvh' самому. Городить это
       ради полосы прогресса не стоит — проще честно предупредить и подождать.

       Перед постройкой отдаём кадр браузеру, иначе предупреждение не успеет
       отрисоваться и пауза будет выглядеть зависанием. */
    await nextFrame();
    await nextFrame();
    const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
    tracer.setScene(scene, camera);
    pt.buildMs = ((typeof performance !== 'undefined' ? performance : Date).now() - t0) | 0;

    pt.build = 1;
    pt.ready = true;
    return true;
  } catch (e) {
    /* Отказ нельзя проглатывать. Раньше здесь вызывался stopPath(), он снимал
       pt.active — а сообщение показывалось только пока флаг взведён. Итог:
       нажатие не давало ни картинки, ни ошибки, ни следа в консоли. */
    fail(e);
    return false;
  }
}

/** Записать отказ так, чтобы его было видно и на экране, и в консоли */
function fail(e) {
  pt.error = String(e && e.message ? e.message : e);
  console.error('[трассировка пути]', e);
  cleanup();
  pt.active = false;
  pt.ready = false;
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
    fail(e);
    return 1;
  }
  return Math.min(1, pt.samples / CONFIG.PATH.samples);
}

/** Вернуть сцену в исходное состояние. Отдельно от stopPath, потому что при
    отказе состояние вернуть надо, а сообщение — сохранить. */
function cleanup() {
  if (windU) windU.value = savedWind;
  restoreLight(S);
  collapseInstances();
  restoreHidden();
  if (tracer) {
    try { tracer.dispose?.(); } catch { /* нечего освобождать */ }
  }
  tracer = null;
  R = S = C = null;
}

export function stopPath() {
  cleanup();
  pt.active = false; pt.ready = false; pt.build = 0; pt.samples = 0;
  pt.buildMs = 0; pt.error = null;
}

/** Сообщение для индикатора: постройка дерева и накопление — разные фазы,
    и путать их нельзя. Дерево может строиться десятки секунд. */
export function pathLabel() {
  if (pt.error) return `путь недоступен · ${pt.error}`;
  /* Постройка дерева блокирует поток: честно предупреждаем, что это надолго,
     а не рисуем прогресс, которого у синхронной сборки нет. */
  if (!pt.ready) return 'строится дерево обхода, это займёт время…';
  const done = Math.min(1, pt.samples / CONFIG.PATH.samples);
  const built = pt.buildMs ? ` · дерево ${(pt.buildMs / 1000).toFixed(1)} с` : '';
  return done >= 1
    ? `готово · ${pt.samples} выборок пути${built}`
    : `путь · ${(done * 100) | 0}% · выборок ${pt.samples}${built}`;
}
