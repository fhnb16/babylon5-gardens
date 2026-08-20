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
