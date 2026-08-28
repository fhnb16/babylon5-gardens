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
  threaded: false,    // дерево собрано в отдельном потоке
  worker: null,       // сам поток, чтобы закрыть его при выходе
  paused: false,      // накопление остановлено, показывается очищенный кадр
  samples: 0,         // накоплено выборок
  error: null         // текст отказа, если не запустилось
};

/** Отдать кадр браузеру, чтобы он успел отрисовать предупреждение */
const nextFrame = () => new Promise(r => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => r());
  else setTimeout(r, 16);
});

let tracer = null, lib = null, R = null, S = null, C = null;
let WebGLPathTracer = null;
let savedWind = 1, windU = null, hidden = [];
let expanded = [], clones = [], swapped = [];
let starting = false;   // замок от повторного нажатия во время сборки
let composeOut = null;  // вывод через общую цепочку постобработки
const geoCache = new Map(), matCache = new Map(), groupCache = new Map();
let subGeos = [];
let normalized = [];
let prevEnv = null, envTex = null, waterSaved = null;
let emitSaved = [], rimAdded = [], axisSaved = [];

/* ═══════════════════════════════════════════════════════════════════════════
   ПОСТРОЙКА ДЕРЕВА В ОТДЕЛЬНОМ ПОТОКЕ

   Дерево обхода считается на процессоре и занимает секунды. В главном потоке
   это замораживает интерфейс целиком: кнопки не отвечают, снимок не сделать.

   Штатный worker библиотеки не подходит: worker НЕ наследует карту импортов
   страницы, и `import 'three'` внутри него не разрешится. Поэтому собираем
   свой — из строки, с АБСОЛЮТНЫМИ адресами тех же сборок, взятыми прямо из
   карты импортов страницы. Интерфейс от него нужен ровно один: метод
   generate(geometry), возвращающий обещание с готовым деревом.

   Выборки пути в поток выносить незачем: вызов renderSample уходит на GPU за
   микросекунды, поток при этом свободен. Вязкость там от загруженной
   видеокарты, а не от занятого потока.
   ═══════════════════════════════════════════════════════════════════════════ */

/** Абсолютный адрес модуля из карты импортов страницы */
function resolveUrl(name) {
  try {
    return new URL(import.meta.resolve(name), location.href).href;
  } catch {
    return null;
  }
}

const workerSource = (threeUrl, bvhUrl) => `
import { BufferGeometry, BufferAttribute } from '${threeUrl}';
import { MeshBVH } from '${bvhUrl}';

self.onmessage = e => {
  const { position, index, options } = e.data;
  try {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(position, 3));
    if (index) geo.setIndex(new BufferAttribute(index, 1));
    const bvh = new MeshBVH(geo, options || {});
    const packed = MeshBVH.serialize(bvh, { cloneBuffers: false });
    const move = [packed.index.buffer, ...packed.roots];
    self.postMessage({ ok: true, packed }, move);
  } catch (err) {
    self.postMessage({ ok: false, error: String((err && err.message) || err) });
  }
};
`;

/** Настройки трассировщика. Отдельной функцией, потому что при откате на
    синхронную сборку он создаётся заново и настройки нужны те же. */
function applyTracerSettings(t, mobile, onComposite) {
  const P = CONFIG.PATH;
  t.renderScale = scaleWanted || (mobile ? P.mobileScale : P.scale);
  t.tiles.set(mobile ? P.mobileTiles : P.tiles, 1);
  t.bounces = mobile ? P.mobileBounces : P.bounces;
  t.minSamples = 1;
  t.renderDelay = 0;
  t.fadeDuration = 0;
  t.dynamicLowRes = false;
  t.textureSize.set(P.texSize, P.texSize);

  /* Перехватываем вывод: библиотека рисует результат прямо в канвас и минует
     всю нашу постобработку — ни свечения, ни лучей от оси, ни сглаживания.
     Отдаём её цель в общую цепочку, и всё это возвращается. */
  composeOut = onComposite;
  t.renderToCanvasCallback = (target, renderer2, quad) => {
    if (onComposite && onComposite(target.texture)) return;
    const auto = renderer2.autoClear;
    renderer2.autoClear = false;
    quad.render(renderer2);
    renderer2.autoClear = auto;
  };
}

/** Обёртка с тем интерфейсом, который ждёт библиотека: generate(geometry) */
function makeBvhWorker(MeshBVHClass) {
  const threeUrl = resolveUrl('three');
  const bvhUrl = resolveUrl('three-mesh-bvh');
  if (!threeUrl || !bvhUrl || typeof Worker === 'undefined') return null;

  const blob = new Blob([workerSource(threeUrl, bvhUrl)], { type: 'text/javascript' });
  const url = URL.createObjectURL(blob);
  const worker = new Worker(url, { type: 'module' });
  URL.revokeObjectURL(url);

  return {
    running: false,
    generate(geometry, options = {}) {
      this.running = true;
      return new Promise((resolve, reject) => {
        worker.onmessage = ev => {
          this.running = false;
          if (!ev.data.ok) { reject(new Error(ev.data.error)); return; }
          /* дерево возвращается упакованным — разворачиваем на месте */
          resolve(MeshBVHClass.deserialize(ev.data.packed, geometry, { setIndex: true }));
        };
        worker.onerror = err => { this.running = false; reject(err); };

        /* буферы уходят В worker без копирования: у нас их сотни мегабайт */
        const pos = geometry.attributes.position.array;
        const idx = geometry.index ? geometry.index.array : null;
        worker.postMessage({ position: pos, index: idx, options }, [pos.buffer,
          ...(idx ? [idx.buffer] : [])]);
      });
    },
    terminate() { worker.terminate(); }
  };
}

/** Подгрузить библиотеку. Отдельной функцией, чтобы отказ был обрабатываем. */
let GradientTex = null;
async function load() {
  if (lib) return lib;
  lib = await import('three-gpu-pathtracer');
  GradientTex = lib.GradientEquirectTexture;
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
/* Сборщик сливает все геометрии в один буфер, и разнобой в атрибутах его
   ломает: «Invalid typed array length». В сцене четыре разных набора — с
   цветом вершин и без, с индексом и без. Приводим к одному: позиция,
   нормаль, UV, с индексом. Цвет вершин при этом теряется, но он у нас даёт
   лишь мелкое подкрашивание граней, а цвет экземпляра всё равно переезжает
   в материал. */
const NEEDED = ['position', 'normal', 'uv'];
function normalizeGeo(geo) {
  let g = geoCache.get(geo.uuid);
  if (g) return g;
  const extra = Object.keys(geo.attributes).filter(a => !NEEDED.includes(a));
  const needIndex = !geo.index;
  if (!extra.length && !needIndex) { geoCache.set(geo.uuid, geo); return geo; }

  g = geo.clone();
  for (const a of extra) g.deleteAttribute(a);
  if (!g.attributes.uv) {
    const n = g.attributes.position.count;
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  }
  if (!g.index) {
    const n = g.attributes.position.count;
    const idx = new Uint32Array(n);
    for (let k = 0; k < n; k++) idx[k] = k;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  geoCache.set(geo.uuid, g);
  return g;
}

/** Материал без вершинных цветов: атрибут мы убрали, флаг должен уйти с ним.

    Работает и с массивом: у дома два материала — стены и кровля, — и прежняя
    версия возвращала сам массив, у которого нет ни vertexColors, ни clone. */
function flatMat(mat) {
  if (Array.isArray(mat)) return mat.map(flatMat);
  if (!mat || !mat.vertexColors) return mat;
  let m = matCache.get(mat.uuid);
  if (!m) {
    m = mat.clone();
    m.vertexColors = false;
    matCache.set(mat.uuid, m);
    clones.push(m);
  }
  return m;
}

/** Разбить геометрию с группами на отдельные геометрии — по одной на группу.

    Сборщик присваивает КАЖДОМУ мешу один номер материала по его порядку в
    списке и собственные группы геометрии не читает вовсе. Дом с массивом
    [стены, кровля] попадает туда одним мешем, получает один номер — и дальше
    номера всех последующих мешей едут: колонне достаётся материал дома, дому
    материал травы. Отсюда и красные колонны, и пропавший корпус.

    Поэтому перед сборкой каждая группа становится своим мешем с одним
    материалом. Атрибуты общие, копируется только список индексов. */
function splitByGroups(geo) {
  const key = geo.uuid;
  let parts = groupCache.get(key);
  if (parts) return parts;
  if (!geo.groups || geo.groups.length < 2) { groupCache.set(key, null); return null; }

  const idx = geo.index;
  parts = geo.groups.map(gr => {
    const g = new THREE.BufferGeometry();
    for (const name of Object.keys(geo.attributes)) g.setAttribute(name, geo.attributes[name]);
    const sub = new Uint32Array(gr.count);
    for (let k = 0; k < gr.count; k++) sub[k] = idx.getX(gr.start + k);
    g.setIndex(new THREE.BufferAttribute(sub, 1));
    subGeos.push(g);
    return { geo: g, materialIndex: gr.materialIndex };
  });
  groupCache.set(key, parts);
  return parts;
}

/** Клон материала или массива материалов */
function cloneMat(mat) {
  if (Array.isArray(mat)) return mat.map(m => m.clone());
  return mat.clone();
}

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
      const baseGeo = normalizeGeo(im.geometry);
      const flat = flatMat(im.material);
      const parts = Array.isArray(flat) ? splitByGroups(baseGeo) : null;
      /* группы разъезжаются при сборке, поэтому меш на каждую */
      const made = parts
        ? parts.map(pp => new THREE.Mesh(pp.geo, flat[pp.materialIndex] || flat[0]))
        : [new THREE.Mesh(baseGeo, Array.isArray(flat) ? flat[0] : flat)];
      const mesh = made[0];
      for (const one of made) {
        one.matrixAutoUpdate = false;
        one.matrix.copy(m);
      }
      /* Цвет экземпляра переносим в материал, иначе вся роща выйдет одного
         оттенка. Но клонировать материал на КАЖДЫЙ экземпляр нельзя — это
         десять тысяч материалов на сцену. Оттенки берутся из небольших
         палитр, поэтому различных цветов на тип всего десяток: заводим по
         одному материалу на цвет и переиспользуем. */
      if (im.instanceColor) {
        im.getColorAt(k, col);
        const key = col.getHex();
        /* ключ строим по всем материалам объекта: у дома их два */
        const uid = Array.isArray(im.material)
          ? im.material.map(m => m.uuid).join('+') : im.material.uuid;
        let mat = byColor.get(uid + ':' + key);
        if (!mat) {
          mat = cloneMat(flatMat(im.material));
          for (const m of (Array.isArray(mat) ? mat : [mat])) {
            m.vertexColors = false;
            m.color.copy(col);
            clones.push(m);
          }
          byColor.set(uid + ':' + key, mat);
        }
        made.forEach((one, mi) => {
          one.material = Array.isArray(mat) ? (mat[mi] || mat[0]) : mat;
        });
      }
      for (const one of made) holder.add(one);
    }
    im.parent.add(holder);
    holder.matrix.copy(im.matrixWorld);
    holder.matrix.premultiply(m.copy(im.parent.matrixWorld).invert());
    expanded.push({ holder, im, wasVisible: im.visible });
    im.visible = false;
  }
}

/** Привести к единому виду и одиночные меши: разнобой ломает сборку так же */
function normalizeSolids(scene) {
  normalized = [];
  const list = [];
  scene.traverse(o => { if (o.isMesh && !o.isInstancedMesh && o.visible) list.push(o); });

  for (const o of list) {
    const g = normalizeGeo(o.geometry);
    const m = flatMat(o.material);

    /* Одиночный меш с массивом материалов разъедется так же, как инстанс:
       сборщик читает один номер на меш. Прячем его и подставляем по мешу на
       каждую группу. */
    if (Array.isArray(m)) {
      const parts = splitByGroups(g);
      if (parts) {
        const holder = new THREE.Group();
        holder.matrixAutoUpdate = false;
        holder.matrix.copy(o.matrix);
        for (const pp of parts) {
          const one = new THREE.Mesh(pp.geo, m[pp.materialIndex] || m[0]);
          one.matrixAutoUpdate = false;
          holder.add(one);
        }
        o.parent.add(holder);
        expanded.push({ holder, im: o, wasVisible: o.visible });
        o.visible = false;
        continue;
      }
    }

    const changed = Array.isArray(m)
      ? m.some((x, i) => x !== o.material[i])
      : m !== o.material;
    if (g !== o.geometry || changed) {
      normalized.push({ mesh: o, geo: o.geometry, mat: o.material });
      o.geometry = g;
      o.material = m;
    }
  }
}

function restoreSolids() {
  for (const n of normalized) { n.mesh.geometry = n.geo; n.mesh.material = n.mat; }
  normalized = [];
}

function collapseInstances() {
  for (const e of expanded) {
    e.holder.parent?.remove(e.holder);
    e.im.visible = e.wasVisible;
  }
  for (const mm of clones) mm.dispose();
  for (const g of subGeos) g.dispose();
  subGeos = []; groupCache.clear();
  geoCache.clear(); matCache.clear();
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
/** Вода: подсовываем корпусу карту шероховатости и усиливаем рельеф.
    Волны из патча шейдера трассировщику недоступны, но карта нормалей у
    корпуса уже есть — поднимаем её вклад, чтобы рябь читалась. */
function waterForPath(hullMat, roughMap, normalMap) {
  if (!hullMat) return;
  waterSaved = {
    mat: hullMat,
    rough: hullMat.roughnessMap,
    roughVal: hullMat.roughness,
    metal: hullMat.metalness,
    normal: hullMat.normalMap,
    scale: hullMat.normalScale ? hullMat.normalScale.clone() : null
  };
  /* Рельеф подменяем волновой картой: рябь живёт в патче шейдера, которого
     трассировщик не видит, и вода выходила зеркально-гладкой. */
  if (normalMap) hullMat.normalMap = normalMap;
  if (roughMap) { hullMat.roughnessMap = roughMap; hullMat.roughness = 1; }
  /* Металличность воде противопоказана: металл красит отражение в свой цвет,
     а альбедо реки тёмно-синее — получалось чёрное пятно вместо зеркала.
     Вода диэлектрик: гладкая поверхность и без металличности отражает по
     Френелю, как ей и положено. */
  hullMat.metalness = 0;
  hullMat.normalScale?.multiplyScalar(CONFIG.PATH.normalBoost);
  hullMat.needsUpdate = true;
}

function restoreWater() {
  const s = waterSaved;
  if (!s) return;
  s.mat.roughnessMap = s.rough;
  s.mat.roughness = s.roughVal;
  s.mat.metalness = s.metal;
  s.mat.normalMap = s.normal;
  if (s.scale) s.mat.normalScale.copy(s.scale);
  s.mat.needsUpdate = true;
  waterSaved = null;
}

function lightForPath(scene, sunMat, hemi, sunLevel = 1) {
  if (!GradientTex) return;
  swapped = [];

  if (sunMat) {
    /* Яркость трубы следует фазе. Постоянное число пересвечивало день:
       полусфера там и так даёт 1.35, а труба площадью 2.2 × 276 с
       фиксированной яркостью добавляла сверху столько же, сколько ночью, —
       кадр выбеливало. Опорная величина берётся из палитры (sunEmis), она же
       управляет трубой в обычном кадре. */
    const lit = new THREE.MeshStandardMaterial({
      color: 0x000000,
      emissive: sunMat.color.clone(),
      emissiveIntensity: CONFIG.PATH.sunEmit * sunLevel,
      /* непрозрачный: прозрачное со сцены снимается, а источник должен остаться */
      transparent: false, side: THREE.DoubleSide
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
    /* Берём штатный генератор библиотеки, а не самодельную карту.
       Самодельная была 1×1, и three писал в шейдер `CUBEUV_TEXEL_WIDTH` как
       1/ширина = 1 — целое там, где GLSL ждёт float, и фрагментный шейдер
       переставал компилироваться. Заодно градиент «небо-земля» точнее
       передаёт полусферный источник, чем один усреднённый цвет. */
    const k = hemi.intensity * CONFIG.PATH.envScale;
    const tex = new GradientTex(CONFIG.PATH.envRes);
    tex.topColor.copy(hemi.color).multiplyScalar(k);
    tex.bottomColor.copy(hemi.groundColor).multiplyScalar(k);
    tex.exponent = 1.4;
    tex.update();
    envTex = tex;
    scene.environment = tex;
  }
}

/** Поднять эмиссию всем светящимся материалам сцены.

    Трассировщик находит источник, только если луч в него случайно попал.
    Окно — несколько пикселей текстуры, фара — и того меньше: шанс попадания
    ничтожен, и они не освещают ничего. Поднимаем силу эмиссии на время
    съёмки: редкие попадания начинают давать заметный вклад. */
function boostEmissive(scene) {
  const k = CONFIG.PATH.emitBoost;
  const seen = new Set();
  scene.traverse(o => {
    const list = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of list) {
      if (!m || seen.has(m.uuid)) continue;
      seen.add(m.uuid);
      if (m.emissiveIntensity > 0.001) {
        emitSaved.push({ mat: m, v: m.emissiveIntensity });
        m.emissiveIntensity *= k;
      } else if (m.isMeshBasicMaterial && !m.transparent) {
        /* базовые материалы ламп в переносе света не участвуют вовсе —
           подменяем их светящимися, иначе фары просто окрашены */
        const lit = new THREE.MeshStandardMaterial({
          color: 0x000000, emissive: 0xffffff,
          emissiveIntensity: CONFIG.PATH.lampEmit,
          vertexColors: m.vertexColors, side: m.side
        });
        clones.push(lit);
        scene.traverse(o2 => {
          if (o2.isMesh && o2.material === m) {
            swapped.push({ mesh: o2, prev: m });
            o2.material = lit;
          }
        });
      }
    }
  });
}

/** Кольцевая подсветка у торцов и вдоль земли.

    Она нарисована в текстурах как эмиссия, и трассировщик находит её только
    случайным лучом — то есть практически никогда. Настоящие точечные
    источники он выбирает явно, поэтому на время съёмки добавляем кольцо у
    каждого торца. Они снимаются при выходе и в обычном кадре не участвуют. */
function addRimLights(scene, palette, level) {
  const P = CONFIG.PATH;
  /* Мощность соизмеряется с осевыми источниками сцены. Первый раз я задал её
     числом «на глаз» — вышло в 274 раза ярче каждого осевого, а их вдвадцатеро
     больше: кольцо светило в тысячу раз сильнее всего остального и выбеливало
     кадр. Плюс периметральная подсветка — ночная деталь, днём её гасим. */
  if (level < 0.02) return;
  const R = CONFIG.R - 3, HL = CONFIG.L / 2;
  for (const sign of [-1, 1]) {
    for (let k = 0; k < P.rimLights; k++) {
      const a = (k / P.rimLights) * Math.PI * 2;
      const l = new THREE.PointLight(palette.rim, P.rimPower * level, P.rimRange, 1.4);
      l.position.set(Math.sin(a) * R, Math.cos(a) * R, sign * (HL - P.rimInset));
      scene.add(l);
      rimAdded.push(l);
    }
  }
}

function removeRimLights() {
  for (const l of rimAdded) l.parent?.remove(l);
  rimAdded = [];
}

/** Приглушить осевые источники на время съёмки.

    В растре труба — базовый материал и сцену не освещает вовсе: её свет
    ИЗОБРАЖАЮТ пять точечных источников вдоль оси. В трассировке труба светит
    сама, и вместе с ними выходит двойной счёт — отсюда пересвеченный день.
    Гасим их, оставляя малую долю: она заменяет многократные переотражения,
    которых при сотне выборок ещё не набралось. */
function dimAxisLights(scene) {
  scene.traverse(o => {
    if (!o.isPointLight || rimAdded.includes(o)) return;
    axisSaved.push({ light: o, v: o.intensity });
    o.intensity *= CONFIG.PATH.axisKeep;
  });
}

function restoreAxisLights() {
  for (const a of axisSaved) a.light.intensity = a.v;
  axisSaved = [];
}

function restoreEmissive() {
  for (const e of emitSaved) e.mat.emissiveIntensity = e.v;
  emitSaved = [];
}

function restoreLight(scene) {
  for (const s of swapped) s.mesh.material = s.prev;
  swapped = [];
  if (scene) scene.environment = prevEnv;
  envTex?.dispose();
  envTex = null;
}

/** Запустить трассировку. Возвращает false, если устройство не потянуло. */
export async function startPath(renderer, scene, camera, wind, mobile, onPhase, sunMat, hemi, onComposite, hullMat, roughMap, rimColor, sunLevel = 1, rimLevel = 0, waterNormal = null) {
  /* Два замка. Первый — от повторного нажатия: сборка дерева длится секунды,
     и второй запуск застаёт генератор занятым, отвечая «BVH is already
     building asynchronously». */
  if (pt.active || starting) return true;
  starting = true;
  R = renderer; S = scene; C = camera; windU = wind;
  pt.error = null; pt.build = 0; pt.samples = 0; pt.ready = false;

  try {
    ({ WebGLPathTracer } = await load());
    onPhase?.('строится дерево обхода, это займёт время…');

    /* Ветер останавливаем: дерево описывает геометрию в покое, а кроны
       смещает вершинный шейдер — трассировщик этого смещения не увидит. */
    /* Сперва отдаём браузеру два кадра — он успевает отрисовать надпись и
       ОБЫЧНУЮ сцену. Подменять материалы до этого нельзя: замерший кадр
       остался бы с погашенным солнцем и снятой дымкой, что и выглядело
       «плоско, без эффектов». */
    await nextFrame();
    await nextFrame();

    savedWind = windU.value;
    windU.value = 0;

    /* Порядок обязателен. Труба-солнце помечена прозрачной — она гаснет в
       тумане, — и hideNonSolid убрал бы её вместе с дымкой: главный источник
       просто исчезал из сцены. Сперва меняем ей материал на непрозрачный
       светящийся, и только потом прячем всё остальное прозрачное. */
    lightForPath(scene, sunMat, hemi, sunLevel);
    boostEmissive(scene);
    dimAxisLights(scene);
    addRimLights(scene, { rim: rimColor || 0xffd9a0 }, rimLevel);
    waterForPath(hullMat, roughMap, waterNormal);
    hideNonSolid(scene);
    expandInstances(scene);
    normalizeSolids(scene);
    scene.updateMatrixWorld(true);

    tracer = new WebGLPathTracer(renderer);
    applyTracerSettings(tracer, mobile, onComposite);

    pt.active = true;

    /* Дерево обхода строится СИНХРОННО. Асинхронная сборка требует worker'а
       (`setBVHWorker`), а worker не наследует карту импортов страницы: ему
       пришлось бы разрешать 'three' и 'three-mesh-bvh' самому. Городить это
       ради полосы прогресса не стоит — проще честно предупредить и подождать.

       Перед постройкой отдаём кадр браузеру, иначе предупреждение не успеет
       отрисоваться и пауза будет выглядеть зависанием. */
    const t0 = (typeof performance !== 'undefined' ? performance : Date).now();

    /* Пробуем построить дерево в отдельном потоке: тогда интерфейс остаётся
       живым и снимок можно сделать в любой момент. Если поток не поднялся
       (нет Worker, не разрешились адреса, отказ при сборке) — считаем в
       главном, как раньше: медленнее по ощущению, но работает всегда. */
    /* Worker ставим ПУБЛИЧНЫМ методом. Раньше я лез в приватное поле —
       `tracer._generator?.setBVHWorker?.(...)`, — и оператор ?. молча глотал
       промах: worker не устанавливался, сборка падала на «setBVHWorker must
       be called», а начатая ею генерация продолжала держать генератор. Отсюда
       и «BVH is already building» на ПЕРВОМ же запуске. */
    let threaded = false;
    const mesh = await load();
    const bvhWorker = typeof tracer.setBVHWorker === 'function'
      ? makeBvhWorker(mesh.MeshBVH || (await import('three-mesh-bvh')).MeshBVH)
      : null;

    if (bvhWorker) {
      pt.worker = bvhWorker;
      tracer.setBVHWorker(bvhWorker);
      try {
        /* setSceneAsync сбрасывает свой внутренний флаг синхронно и
           возвращает обещание — его обязательно дожидаться. */
        await tracer.setSceneAsync(scene, camera, { onProgress: v => { pt.build = v; } });
        threaded = true;
      } catch (e) {
        console.warn('[трассировка пути] дерево в потоке не собралось, считаю в главном', e);
        /* Генератор остался занят начатой сборкой: продолжать через него
           нельзя, берём чистый трассировщик. */
        try { tracer.dispose?.(); } catch { /* нечего освобождать */ }
        tracer = new WebGLPathTracer(renderer);
        applyTracerSettings(tracer, mobile, onComposite);
      }
    }
    if (!threaded) tracer.setScene(scene, camera);
    pt.threaded = threaded;
    pt.buildMs = ((typeof performance !== 'undefined' ? performance : Date).now() - t0) | 0;

    pt.build = 1;
    pt.ready = true;
    starting = false;
    return true;
  } catch (e) {
    starting = false;
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

  /* Накопленный кадр каждый раз проходит через цепочку заново — и на паузе,
     и когда счёт уже завершён. Раньше в обоих случаях был просто выход, и
     канвас в этом кадре не перерисовывался вовсе. Отсюда сразу две беды:
     снятие паузы не возвращало исходную картинку, а снимок читал канвас с
     уже неопределённым содержимым и выходил пустым. Один полноэкранный
     проход — цена невелика. */
  if (pt.paused || done >= 1) {
    if (composeOut && tracer.target) composeOut(tracer.target.texture);
    return done;
  }
  try {
    tracer.renderSample();
    /* при нескольких полосах счётчик дробный: кадр набирается по частям */
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
  if (pt.worker) { try { pt.worker.terminate(); } catch { /* уже закрыт */ } pt.worker = null; }
  if (windU) windU.value = savedWind;
  restoreLight(S);
  restoreEmissive();
  restoreAxisLights();
  removeRimLights();
  restoreWater();
  restoreSolids();
  collapseInstances();
  restoreHidden();
  if (tracer) {
    try { tracer.dispose?.(); } catch { /* нечего освобождать */ }
  }
  tracer = null;
  R = S = C = null;
}

/* ═══════════════════════════════════════════════════════════════════════════
   ПАУЗА И ОЧИСТКА

   Накопление можно остановить и пропустить кадр через шумоподавитель: он
   сглаживает зерно, оставляя кромки. Это не замена выборкам — картинка
   становится чище, но детали, которых ещё нет, не появятся. Зато снимок
   можно делать раньше, не дожидаясь полного схождения.
   ═══════════════════════════════════════════════════════════════════════════ */
let scaleWanted = 0;

/** Доля разрешения трассировки. Меняется и на ходу: накопление при этом
    начинается заново — размер буфера другой. */
export function setPathScale(v) {
  scaleWanted = v > 0 ? v : 0;
  if (tracer) {
    tracer.renderScale = scaleWanted || tracer.renderScale;
    pt.samples = 0;
  }
}

export function setPaused(on) {
  pt.paused = !!on;
  if (tracer) tracer.renderToCanvas = true;
  return pt.paused;
}

export function pathPaused() { return pt.paused; }

export function stopPath() {
  cleanup();
  pt.active = false; pt.ready = false; pt.build = 0; pt.samples = 0;
  pt.buildMs = 0; pt.error = null; pt.paused = false; starting = false;
}

/** Сообщение для индикатора: постройка дерева и накопление — разные фазы,
    и путать их нельзя. Дерево может строиться десятки секунд. */
export function pathLabel() {
  if (pt.error) return `путь недоступен · ${pt.error}`;
  /* Постройка дерева блокирует поток: честно предупреждаем, что это надолго,
     а не рисуем прогресс, которого у синхронной сборки нет. */
  if (!pt.ready) {
    return pt.threaded || pt.build > 0
      ? `дерево обхода · ${(pt.build * 100) | 0}%`
      : 'строится дерево обхода, это займёт время…';
  }
  const done = Math.min(1, pt.samples / CONFIG.PATH.samples);
  if (pt.paused) return `пауза · выборок ${pt.samples | 0} · картинка очищена`;
  const built = pt.buildMs
    ? ` · дерево ${(pt.buildMs / 1000).toFixed(1)} с${pt.threaded ? ' в потоке' : ''}` : '';
  return done >= 1
    ? `готово · ${pt.samples | 0} выборок пути${built}`
    : `путь · ${(done * 100) | 0}% · выборок ${pt.samples | 0}${built}`;
}
