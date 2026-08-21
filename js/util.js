import * as THREE from 'three';
import { CONFIG } from './config.js';

/* ═══════════════════════════════════════════════════════════════════════════
   ДЕТЕРМИНИЗМ И МЕЛОЧИ
   ═══════════════════════════════════════════════════════════════════════════ */
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const D2R = Math.PI / 180;
export const TAU = Math.PI * 2;
export const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
export const lerp = (a, b, t) => a + (b - a) * t;
export const easeInOut = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
export const pick = (rnd, arr) => arr[(rnd() * arr.length) | 0];
export const inRanges = (deg, ranges) => ranges.some(([a, b]) => deg >= a && deg <= b);

/** Зона по углу θ (градусы) — тот же CONFIG, что и у текстуры корпуса */
export function zoneAt(deg) {
  deg = ((deg % 360) + 360) % 360;
  if (inRanges(deg, CONFIG.SECT.rivers)) return 'river';
  if (inRanges(deg, CONFIG.SECT.cities)) return 'city';
  if (inRanges(deg, CONFIG.SECT.fields)) return 'field';
  if (inRanges(deg, CONFIG.SECT.parks))  return 'park';
  return 'edge';
}

/* ═══════════════════════════════════════════════════════════════════════════
   БАЗИС РАССТАНОВКИ: локальный +Y смотрит на ось, +Z вдоль станции.
   Единственный допустимый способ ориентации. Без lookAt-хаков.
   ═══════════════════════════════════════════════════════════════════════════ */
const _up = new THREE.Vector3(), _zAx = new THREE.Vector3(0, 0, 1);
const _xAx = new THREE.Vector3(), _mtx = new THREE.Matrix4();

export function surfaceQuat(t, out = new THREE.Quaternion()) {
  _up.set(-Math.sin(t), -Math.cos(t), 0);
  _xAx.crossVectors(_up, _zAx);
  return out.setFromRotationMatrix(_mtx.makeBasis(_xAx, _up, _zAx));
}
export function surfacePos(t, r, z, out = new THREE.Vector3()) {
  return out.set(Math.sin(t) * r, Math.cos(t) * r, z);
}
/** [θ°, r, z] → локальный вектор worldGroup */
export const tpVec = ([deg, r, z]) => surfacePos(deg * D2R, r, z);

/* ═══════════════════════════════════════════════════════════════════════════
   РУЧНОЕ СЛИЯНИЕ ГЕОМЕТРИЙ (аддоны запрещены)
   ═══════════════════════════════════════════════════════════════════════════ */
export function mergeGeos(list) {
  let vc = 0, ic = 0;
  for (const g of list) {
    if (!g.index) throw new Error('mergeGeos: нужна индексированная геометрия');
    vc += g.attributes.position.count; ic += g.index.count;
  }
  const pos = new Float32Array(vc * 3), nor = new Float32Array(vc * 3), uv = new Float32Array(vc * 2);
  const idx = vc > 65535 ? new Uint32Array(ic) : new Uint16Array(ic);
  let vo = 0, io = 0;
  for (const g of list) {
    const p = g.attributes.position, n = g.attributes.normal, u = g.attributes.uv, x = g.index;
    pos.set(p.array, vo * 3);
    if (n) nor.set(n.array, vo * 3);
    if (u) uv.set(u.array, vo * 2);
    for (let i = 0; i < x.count; i++) idx[io + i] = x.getX(i) + vo;
    vo += p.count; io += x.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

/** Брус: box с длиной по локальной Y, повёрнутый и сдвинутый. Кирпич всех ферм. */
export function rod(w, h, d, x, y, z, rx = 0, ry = 0, rz = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rx) g.rotateX(rx);
  if (rz) g.rotateZ(rz);
  if (ry) g.rotateY(ry);
  g.translate(x, y, z);
  return g;
}

/** Развёртка фасада для одной детали здания.
    По горизонтали — постоянная плотность: без этого карниз толщиной 60 см
    показывал всю текстуру целиком, а барабан — её же, размазанную по кругу.
    По вертикали — доля от высоты здания (v берётся прямо из координаты),
    чтобы парапет из верхних процентов текстуры всегда оказывался наверху
    стены, на какой бы высоте эта деталь ни находилась. */
export function facadeUV(geo, uScale) {
  const uv = geo.attributes.uv, p = geo.attributes.position;
  for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * uScale, p.getY(k));
  uv.needsUpdate = true;
  return geo;
}

/** Панельная развёртка по мировым координатам детали. Для слитых форм из
    десятков брусьев перебирать каждый примитив бессмысленно: проецируем по
    доминирующей оси нормали с фиксированной плотностью. Швы на цилиндрах для
    технической текстуры не видны, зато 44-метровый пояс фермы перестаёт
    показывать одну растянутую панель на всю длину. */
export function panelUV(geo, tile, sy = 1) {
  const p = geo.attributes.position, n = geo.attributes.normal, uv = geo.attributes.uv;
  for (let k = 0; k < p.count; k++) {
    const nx = Math.abs(n.getX(k)), ny = Math.abs(n.getY(k)), nz = Math.abs(n.getZ(k));
    let a, b;
    if (nx >= ny && nx >= nz) { a = p.getZ(k); b = p.getY(k) * sy; }
    else if (ny >= nz) { a = p.getX(k); b = p.getZ(k); }
    else { a = p.getX(k); b = p.getY(k) * sy; }
    uv.setXY(k, a / tile, b / tile);
  }
  uv.needsUpdate = true;
  return geo;
}

/** Кватернион камеры, смотрящей из eye на target.
    Object3D.lookAt для НЕ-камеры разворачивает к цели +Z, а камера смотрит
    вдоль −Z: подставив обычный Object3D, легко получить взгляд ровно назад.
    Matrix4.lookAt строит именно камерный базис, поэтому берём его напрямую. */
const _aimM = new THREE.Matrix4();
const _aimF = new THREE.Vector3(), _aimU = new THREE.Vector3(), _aimT = new THREE.Vector3();
export function aimAt(eye, target, up, out) {
  /* «Верх» приводим к перпендикуляру взгляда. Когда взгляд идёт почти вдоль
     него, базис вырождается и переворачивается — камера рывком крутится на
     180° за один кадр. Ортогонализация убирает вырождение в корне, а если
     верх совпал со взглядом полностью, берём любой перпендикуляр. */
  _aimF.subVectors(target, eye);
  if (_aimF.lengthSq() < 1e-12) return out;
  _aimF.normalize();
  _aimU.copy(up).addScaledVector(_aimF, -up.dot(_aimF));
  /* Порог намеренно велик. Ортогонализация спасает только пока верх и
     взгляд заметно расходятся: у dot = 0.999 остаток длиной 0.04, и его
     направление скачет от кадра к кадру — камеру выворачивает. Ниже порога
     берём ось станции: она перпендикулярна радиальному верху всегда. */
  if (_aimU.lengthSq() < 0.02) {
    _aimT.set(0, 0, 1);
    if (Math.abs(_aimF.z) > 0.9) _aimT.set(1, 0, 0);
    _aimU.crossVectors(_aimT, _aimF);
    if (_aimU.lengthSq() < 1e-8) _aimU.set(1, 0, 0);
  }
  _aimU.normalize();
  _aimM.lookAt(eye, target, _aimU);
  return out.setFromRotationMatrix(_aimM);
}

/* ═══════════════════════════════════════════════════════════════════════════
   СЕТКА КВАРТАЛОВ — единственный источник правды о городе
   ═══════════════════════════════════════════════════════════════════════════ */
/** Габариты квартала в юнитах мира */
export function cityBlock() {
  const C = CONFIG.CITY;
  return {
    stepT: TAU * CONFIG.R / C.cols,          // шаг по дуге
    stepZ: CONFIG.L / C.rows,                // шаг вдоль оси
    wT: TAU * CONFIG.R / C.cols - C.street,  // ширина квартала по дуге
    wZ: CONFIG.L / C.rows - C.street
  };
}

/** Центр квартала (i, j): угол в радианах и координата z */
export function cityCenter(i, j) {
  const C = CONFIG.CITY;
  return {
    t: ((i + 0.5) / C.cols) * TAU,
    z: -CONFIG.L / 2 + (j + 0.5) * (CONFIG.L / C.rows)
  };
}

/** Годится ли квартал под застройку: весь его угловой размах должен лежать
    внутри городского сектора, а не только центр. Иначе крайние кварталы
    вылезают на соседний биом — и планом, и домами. */
export function cellUsable(i, j) {
  const B = cityBlock();
  const half = (B.wT / CONFIG.R) / D2R / 2;
  const c = cityCenter(i, 0).t / D2R;
  if (!CONFIG.SECT.cities.some(([a, b]) => c - half >= a && c + half <= b)) return false;
  return Math.abs(cityCenter(i, j).z) <= CONFIG.L / 2 - B.stepZ;
}

/** Что в этом квартале. Детерминированно по индексам и зерну, поэтому
    текстура и геометрия получают ОДИН И ТОТ ЖЕ ответ. */
export function cellInfo(i, j) {
  const rnd = mulberry32((CONFIG.SEED ^ Math.imul(i, 374761393) ^ Math.imul(j, 668265263)) >>> 0);
  const roll = rnd();
  const kind = roll < 0.15 ? 'park' : roll < 0.23 ? 'plaza' : roll < 0.31 ? 'lot' : 'built';
  return {
    kind,
    type: (rnd() * 4) | 0,
    w: rnd(), d: rnd(),
    spin: (rnd() * 4) | 0,
    floors: rnd(),          // форму распределения задаёт CONFIG.FLOOR_W
    tint: rnd()
  };
}

/** Этажность по весам из CONFIG.FLOOR_W, ограниченная диапазоном типа.
    u — равномерное число из cellInfo, форму задаёт таблица весов. */
export function pickFloors(u, [lo, hi]) {
  const W = CONFIG.FLOOR_W;
  let sum = 0;
  for (let f = lo; f <= hi; f++) sum += W[f - 1];
  let acc = u * sum;
  for (let f = lo; f <= hi; f++) { acc -= W[f - 1]; if (acc < 0) return f; }
  return hi;
}

/** Поворот одного направления к другому на долю w, с устойчивой осью.

    setFromUnitVectors при почти противоположных направлениях выбирает ось
    произвольно, и она скачет от кадра к кадру — камера выворачивается на
    180° за один шаг. Здесь ось задаётся явно: обычно это их векторное
    произведение, а при развороте точно назад — «верх», то есть камера
    поворачивается через горизонт, как человек, а не через темя. */
const _tA = new THREE.Vector3(), _tQ = new THREE.Quaternion();
export function turnToward(from, to, w, up, out) {
  const d = clamp(from.dot(to), -1, 1);
  _tA.crossVectors(from, to);
  if (_tA.lengthSq() < 1e-8) {
    if (d > 0) return out.copy(from);          // уже совпали
    _tA.copy(up);                              // ровно назад — через горизонт
    _tA.addScaledVector(from, -from.dot(_tA));
    if (_tA.lengthSq() < 1e-8) _tA.set(0, 0, 1).cross(from);
  }
  _tA.normalize();
  _tQ.setFromAxisAngle(_tA, Math.acos(d) * clamp(w, 0, 1));
  return out.copy(from).applyQuaternion(_tQ).normalize();
}

/** Ограничить угол между направлением и «верхом».

    Наивное «убрать лишнюю вертикальную составляющую и нормализовать» не
    работает: убрав её, вектор укорачивается, и нормализация возвращает долю
    почти обратно — предел 0.978 оставлял 0.995. Раскладываем на составляющие
    и собираем заново с нужной долей: результат точно на пределе. */
const _cpP = new THREE.Vector3(), _cpT = new THREE.Vector3();
export function clampPitch(dir, up, sinMax) {
  const d = dir.dot(up);
  if (Math.abs(d) <= sinMax) return dir;
  _cpP.copy(dir).addScaledVector(up, -d);
  if (_cpP.lengthSq() < 1e-10) {
    _cpT.set(0, 0, 1);
    if (Math.abs(up.z) > 0.9) _cpT.set(1, 0, 0);
    _cpP.crossVectors(up, _cpT);
  }
  _cpP.normalize();
  return dir.copy(up).multiplyScalar(Math.sign(d) * sinMax)
    .addScaledVector(_cpP, Math.sqrt(Math.max(0, 1 - sinMax * sinMax)))
    .normalize();
}

/** Приглушение палитры: тянем насыщенность к серому и слегка сводим
    светлоту к середине. Природные кроны не бывают чистыми цветами
    красителя, а низкополигональная модель без текстур это подчёркивает. */
const _hsl = { h: 0, s: 0, l: 0 };
export function natural(hex, k, out) {
  out.setHex(hex).getHSL(_hsl);
  return out.setHSL(_hsl.h, _hsl.s * k, lerp(0.42, _hsl.l, 0.5 + k * 0.5));
}

/** Гасить аддитивный материал туманом нельзя обычным способом: стандартный
    туман подмешивает свой цвет, а при аддитивном смешивании это ДОБАВЛЯЕТ
    света — дымка становится ярче. Гасим прозрачностью: вдали материал просто
    исчезает, как и всё остальное. */
export function fadeByFog(mat) {
  mat.fog = true;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (s, r) => {
    prev?.call(mat, s, r);
    s.fragmentShader = s.fragmentShader.replace('#include <fog_fragment>', `
      #ifdef USE_FOG
        float fogF = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
        gl_FragColor.a *= 1.0 - clamp( fogF, 0.0, 1.0 );
      #endif`);
  };
  const key = mat.customProgramCacheKey;
  mat.customProgramCacheKey = () => (key ? key.call(mat) : '') + '-fogfade';
  return mat;
}

/** Рекурсивная очистка поддерева: геометрии, материалы, их текстуры */
export function deepDispose(obj) {
  obj.traverse?.(n => {
    n.geometry?.dispose();
    const ms = Array.isArray(n.material) ? n.material : n.material ? [n.material] : [];
    for (const m of ms) {
      for (const k of ['map', 'emissiveMap', 'alphaMap', 'roughnessMap', 'normalMap']) m[k]?.dispose();
      for (const t of m.userData?.extra || []) t.dispose();
      m.dispose();
    }
  });
}
