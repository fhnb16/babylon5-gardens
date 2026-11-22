import * as THREE from 'three';
import { CONFIG } from './cfg.ts';
import { app, camera, worldGroup } from './state.ts';
import { setTour } from './tour.ts';
import { resetStick } from './input/touch.ts';
import { clamp, lerp, easeInOut, TAU } from '../core/math/scalar.ts';
import { syncFromCamera, stationUp, tpVec, aimAt, turnToward, clampPitch } from '../js/controls.js';

/* ═══════════════════════════════════════════════════════════════════════════
   ТЕЛЕПОРТЫ: цели живут в локальных координатах и каждый кадр
   переводятся в мировые — посадочная точка честно едет с вращением
   ═══════════════════════════════════════════════════════════════════════════ */
export const fly = {
  a0: 0, a1: 0, da: 0, r0: 0, r1: 0, z0: 0, z1: 0, rMid: 20,
  dir: new THREE.Vector3(0, 0, -1), up: new THREE.Vector3(0, 1, 0),
  on: false, t: 0, dur: 3,
  p0: new THREE.Vector3(), p1: new THREE.Vector3(), p2: new THREE.Vector3(),
  look: new THREE.Vector3(), q0: new THREE.Quaternion(), rot0: 0
};
const _upA = new THREE.Vector3();
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _upB = new THREE.Vector3(), _dirA = new THREE.Vector3(), _dirB = new THREE.Vector3();

export function goTo(i: number, instant = false) {
  const tp = CONFIG.TP[i];
  const target = tpVec(tp.pos), look = tpVec(tp.look);
  worldGroup.updateMatrixWorld();
  app.view = i;

  if (instant) {
    camera.position.copy(worldGroup.localToWorld(target.clone()));
    stationUp(camera.position, _upA);
    aimAt(camera.position, worldGroup.localToWorld(look.clone()), _upA, camera.quaternion);
    syncFromCamera(camera);
    return;
  }

  fly.p0.copy(worldGroup.worldToLocal(camera.position.clone()));
  fly.p2.copy(target);
  fly.look.copy(look);

  /* Траектория ведётся в цилиндрических координатах: угол по кратчайшей
     дуге, радиус с выносом к середине. Между башней (r = 28) и трубой
     (r = 3.4) объём пуст, поэтому путь через этот коридор свободен ПО
     ПОСТРОЕНИЮ — проверять столкновения не с чем. Прежняя почти прямая
     хорда шла впритирку к полу и таранила застройку. */
  const F = CONFIG.FLY;
  fly.a0 = Math.atan2(fly.p0.x, fly.p0.y);
  fly.a1 = Math.atan2(fly.p2.x, fly.p2.y);
  /* кратчайшее направление обхода */
  fly.da = ((fly.a1 - fly.a0 + Math.PI) % TAU + TAU) % TAU - Math.PI;
  fly.r0 = Math.hypot(fly.p0.x, fly.p0.y);
  fly.r1 = Math.hypot(fly.p2.x, fly.p2.y);
  fly.z0 = fly.p0.z; fly.z1 = fly.p2.z;
  /* середина коридора, но не дальше того, где мы и так летим */
  fly.rMid = clamp(Math.min(fly.r0, fly.r1, CONFIG.R * F.corridor),
    CONFIG.SUN.r + CONFIG.SUN.clear + 2, CONFIG.TOWER ? CONFIG.R - 8 : CONFIG.R - 8);

  /* длительность — по фактической длине пути, а не по хорде */
  const arc = Math.abs(fly.da) * (fly.r0 + fly.r1) * 0.5;
  const len = Math.hypot(arc, fly.z1 - fly.z0, fly.r1 - fly.r0);
  fly.dur = clamp(F.min + len / F.speed, F.min, F.max);

  /* цель взгляда стартует там, куда камера смотрит сейчас: иначе на первом
     же кадре она рывком развернётся к пункту назначения */
  camera.getWorldDirection(fly.dir);
  fly.up.set(0, 1, 0).applyQuaternion(camera.quaternion).normalize();

  fly.rot0 = worldGroup.rotation.z;
  fly.t = 0; fly.on = true;
  app.flights++;
  resetStick();
}

/** Точка траектории в локальных координатах мира */
/** Точка траектории. e может выходить за [0,1]: взгляд смотрит вперёд по
    курсу, и на финише ему нужна точка за пределом пути. */
function flyPoint(e: number, out: THREE.Vector3) {
  const bump = Math.sin(Math.PI * clamp(e, 0, 1));   // 0 на концах, 1 в середине
  const a = fly.a0 + fly.da * e;
  const rLine = lerp(fly.r0, fly.r1, e);
  const r = rLine + (fly.rMid - rLine) * bump * CONFIG.FLY.pull;
  return out.set(Math.sin(a) * r, Math.cos(a) * r, lerp(fly.z0, fly.z1, e));
}

export function updateFly(dt: number) {
  if (!fly.on) return;
  fly.t = Math.min(1, fly.t + dt / fly.dur);
  const e = easeInOut(fly.t);
  worldGroup.updateMatrixWorld();

  flyPoint(e, _v);
  worldGroup.localToWorld(_v);
  camera.position.copy(_v);

  /* Куда смотреть. Интерполируем НАПРАВЛЕНИЕ, а не точку: точка, переезжая
     от цели впереди по курсу к цели позади, проходит ровно сквозь камеру, и
     взгляд переворачивается на 180° за один кадр. Именно от этого камеру и
     выворачивало. Направления же поворачиваются друг к другу по дуге. */
  /* Точку впереди берём БЕЗ ограничения единицей: на финише e + lead
     упиралось в саму себя, вектор вырождался в ноль, и нормализация давала
     мусор — отсюда девяностоградусный скачок на последнем кадре. */
  flyPoint(e + CONFIG.FLY.lead, _v3);
  _dirA.subVectors(_v3, _v);
  if (_dirA.lengthSq() < 1e-6) _dirA.copy(fly.dir); else _dirA.normalize();
  worldGroup.localToWorld(_v3.copy(fly.look));
  _dirB.subVectors(_v3, _v).normalize();
  stationUp(_v, _upA);
  /* Верх плавно переходит от стартового к станционному: у самой оси
     станционный проворачивается на восемь градусов за юнит пути и закручивал
     бы камеру вокруг своей оси в середине траектории. */
  _upB.copy(fly.up).lerp(_upA, smoothstep01(0.2, 1, e)).normalize();
  /* цель: от направления по курсу к направлению на точку прибытия */
  turnToward(_dirA, _dirB, smoothstep01(CONFIG.FLY.turnFrom, 1, e), _upA, _dirA);
  /* и догоняем её экспоненциально — повороты закладываются дугой */
  turnToward(fly.dir, _dirA, 1 - Math.exp(-dt * CONFIG.FLY.turn), _upA, fly.dir);

  /* Не даём взгляду подойти к «верху» вплотную. У dot = 1 базис вырождается
     и камера выворачивается за кадр; порог с переключением на запасной верх
     эту дыру только сдвигает — на самом переключении остаётся скачок.
     Ограничение же непрерывно: тот же приём снял тряску у зенита. */
  clampPitch(fly.dir, _upB, Math.sin(CONFIG.FLY.pitchMax * Math.PI / 180));
  /* Цель взгляда — точка впереди по fly.dir. В main.js _v2 только объявлялся
     и не заполнялся, поэтому весь перелёт камера смотрела на начало
     координат, а посчитанное выше направление пропадало. */
  _v2.copy(_v).addScaledVector(fly.dir, 60);
  aimAt(_v, _v2, _upB, camera.quaternion);

  if (fly.t >= 1) { fly.on = false; syncFromCamera(camera); }
}

const smoothstep01 = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
export function cancelFly() { fly.on = false; setTour(false); syncFromCamera(camera); }
