import * as THREE from 'three';
import { CONFIG } from './config.js';
import { clamp, D2R } from '../core/math/scalar.ts';

/* ═══════════════════════════════════════════════════════════════════════════
   УПРАВЛЕНИЕ КАМЕРОЙ — состояние ввода, его применение и столкновения.
   Сами источники ввода (клавиатура, мышь и pointer lock, касания и
   джойстик, геймпад, пульт) живут в app/input/* и пишут сюда: в ctl и
   через addLook. Никаких FlyControls/OrbitControls.
   ═══════════════════════════════════════════════════════════════════════════ */
let collider = null;
const _ray = new THREE.Raycaster();
const _colPrev = new THREE.Vector3(), _colDir = new THREE.Vector3();

/** Объект, с которым камера сталкивается. Ожидается меш с построенным
    деревом обхода — без него луч перебирал бы всю геометрию поштучно. */
export function setCollider(obj) {
  collider = obj || null;
  _ray.firstHitOnly = true;    // ближайшее попадание, дальше не ищем
}

export const ctl = {
  freeFly: false,       // false — горизонт следует цилиндру, true — обычный полёт
  speed: CONFIG.SPEED_BASE,
  boost: false,
  keys: Object.create(null),
  vert: 0,
  stick: { active: false, id: -1, ox: 0, oy: 0, x: 0, y: 0 },
  /* аналоговый ввод геймпада, уже за мёртвой зоной: x вправо, y к оси, z вперёд */
  axis: { x: 0, y: 0, z: 0 },
  look: { id: -1, lx: 0, ly: 0 },
  sens: 1,
  locked: false,
  enabled: false
};

export const isMobile = matchMedia('(pointer: coarse)').matches
  || /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

/* Предел тангажа. При 89° вектор «вправо» получается длиной 0.017, и
   нормализация усиливает погрешность в полсотни раз — камеру трясёт у
   зенита. 84° дают запас в 0.1: базис остаётся устойчивым. */
const SIN_MAX = Math.sin(84 * Math.PI / 180);
let dYaw = 0, dPitch = 0;      // накопленный ввод обзора за кадр

/** «Верх» задаёт центробежная сила: от пола к оси станции.
    Мировой +Y годился бы для плоского мира — здесь он переворачивает
    горизонт везде, кроме θ = 180°. */
export function stationUp(pos, out) {
  out.set(-pos.x, -pos.y, 0);
  return out.lengthSq() < 1e-4 ? out.set(0, 1, 0) : out.normalize();
}

/** Опорный «верх» кадра. В режиме станции он идёт к оси и горизонт следует
    изгибу цилиндра; в свободном — берётся собственный верх камеры, и полёт
    ведёт себя как в обычной игре от первого лица: лево это лево. */
export function frameUp(camera, out) {
  if (!ctl.freeFly) return stationUp(camera.position, out);
  return out.set(0, 1, 0).applyQuaternion(camera.quaternion).normalize();
}

/** Накопить поворот взгляда за кадр. Применяется в updateControls одним
    поворотом — так мышь, свайп и стик геймпада ведут себя одинаково. */
export function addLook(dx, dy, k) {
  dYaw -= dx * k * ctl.sens;
  dPitch -= dy * k * ctl.sens;
}

/* ═══════════════════════════════════════════════════════════════════════════
   ПРИМЕНЕНИЕ ВВОДА
   ═══════════════════════════════════════════════════════════════════════════ */
const _fwd = new THREE.Vector3(), _right = new THREE.Vector3();
const _up = new THREE.Vector3(), _back = new THREE.Vector3();
const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion();

/** Снимаем крен и удерживаем тангаж: базис строится от «верха» станции.
    Ориентация хранится прямо в кватернионе камеры — углы Эйлера от мирового
    +Y тут не годятся, они защёлкивали бы крен обратно после каждой посадки. */
export function levelCamera(camera) {
  /* В свободном полёте выравнивать нечего: крен там — часть управления */
  if (ctl.freeFly) return;
  stationUp(camera.position, _up);
  camera.getWorldDirection(_fwd);

  clampPitch(_fwd, _up, SIN_MAX);           // не даём взгляду встать вертикально
  _right.crossVectors(_fwd, _up);
  if (_right.lengthSq() < 1e-8) return;     // вырожденный случай — оставляем как есть
  _right.normalize();
  _up.crossVectors(_right, _fwd).normalize();
  _back.copy(_fwd).negate();
  camera.quaternion.setFromRotationMatrix(_m4.makeBasis(_right, _up, _back));
}

export function updateControls(dt, camera) {
  if (!ctl.enabled) return;

  if (dYaw || dPitch) {
    frameUp(camera, _up);
    camera.quaternion.premultiply(_q.setFromAxisAngle(_up, dYaw));
    camera.getWorldDirection(_fwd);
    _right.crossVectors(_fwd, _up);
    if (_right.lengthSq() > 1e-8) {
      _right.normalize();
      /* Тангаж ограничиваем ДО поворота: докручивать вплотную к зениту,
         а потом оттягивать назад — значит каждый кадр дёргать базис. */
      const cur = Math.asin(clamp(_fwd.dot(_up), -1, 1));
      const lim = Math.asin(SIN_MAX);
      camera.quaternion.premultiply(
        _q.setFromAxisAngle(_right, clamp(cur + dPitch, -lim, lim) - cur));
    }
    dYaw = dPitch = 0;
  }
  levelCamera(camera);

  let fx = 0, fz = 0, fy = ctl.vert;
  const k = ctl.keys;
  if (k.KeyW || k.ArrowUp) fz += 1;
  if (k.KeyS || k.ArrowDown) fz -= 1;
  if (k.KeyD || k.ArrowRight) fx += 1;
  if (k.KeyA || k.ArrowLeft) fx -= 1;
  if (k.KeyR) fy += 1;
  if (k.KeyF) fy -= 1;

  const s = ctl.stick;
  if (s.active) {
    const len = Math.hypot(s.x, s.y);
    if (len > CONFIG.STICK_DEAD) {
      const g = (len - CONFIG.STICK_DEAD) / (1 - CONFIG.STICK_DEAD) / len;
      fx += s.x * g; fz -= s.y * g;
    }
  }
  const ax = ctl.axis;
  fx += ax.x; fz += ax.z; fy += ax.y;
  if (!fx && !fz && !fy) return;

  const spd = ctl.speed * (ctl.boost ? CONFIG.SPEED_BOOST : 1) * dt;
  _colPrev.copy(camera.position);
  camera.getWorldDirection(_fwd);
  frameUp(camera, _up);
  _right.crossVectors(_fwd, _up).normalize();
  camera.position.addScaledVector(_fwd, fz * spd);
  camera.position.addScaledVector(_right, fx * spd);
  camera.position.addScaledVector(_up, fy * spd);   // «вверх» — к оси станции

  /* Столкновения с миром. Луч пускается по направлению движения, и если
     впереди ближе радиуса что-то есть — камера туда не идёт. Дерево обхода
     строит three-mesh-bvh: без него такой луч перебирал бы полмиллиона
     треугольников на каждый кадр. */
  if (collider && (fx || fy || fz)) {
    _colDir.copy(camera.position).sub(_colPrev);
    const dist = _colDir.length();
    if (dist > 1e-5) {
      _colDir.divideScalar(dist);
      _ray.set(_colPrev, _colDir);
      _ray.far = dist + CONFIG.COLLIDE.radius;
      const hit = _ray.intersectObject(collider, false)[0];
      if (hit && hit.distance < dist + CONFIG.COLLIDE.radius) {
        /* останавливаемся, не доходя радиуса до преграды */
        camera.position.copy(_colPrev).addScaledVector(_colDir,
          Math.max(0, hit.distance - CONFIG.COLLIDE.radius));
      }
    }
  }

  /* Труба-солнце — сплошное тело, а не декорация: внутрь неё не пускаем.
     Отталкиваем по радиусу, оставляя движение вдоль оси свободным. */
  const keep = CONFIG.SUN.r + CONFIG.SUN.clear;
  const rr = Math.hypot(camera.position.x, camera.position.y);
  if (rr < keep) {
    if (rr < 1e-4) camera.position.x = keep;         // ровно на оси — отводим вбок
    else {
      const k = keep / rr;
      camera.position.x *= k;
      camera.position.y *= k;
    }
  }

  /* мягко держим камеру внутри станции */
  const r = Math.hypot(camera.position.x, camera.position.y);
  if (r > CONFIG.R - 1.2) {
    const f = (CONFIG.R - 1.2) / r;
    camera.position.x *= f; camera.position.y *= f;
  }
  camera.position.z = clamp(camera.position.z, -CONFIG.L / 2 + 2, CONFIG.L / 2 - 2);
}

/** После перелёта ориентация уже в кватернионе — достаточно выровнять крен */
export function syncFromCamera(camera) {
  dYaw = dPitch = 0;
  levelCamera(camera);
}

/* ═══════════════════════════════════════════════════════════════════════════
   ГЕОМЕТРИЯ КАМЕРЫ — перенесено из js/util.js (v2.12.0: мир строит core/,
   а util.js удалён; здесь остались только помощники камеры на THREE).
   Чистые версии без three — core/camera/flight.ts.
   ═══════════════════════════════════════════════════════════════════════════ */
/** Точка на радиусе r под углом t: x = r·sin t, y = r·cos t (как в ядре) */
export function surfacePos(t, r, z, out = new THREE.Vector3()) {
  return out.set(Math.sin(t) * r, Math.cos(t) * r, z);
}
/** [θ°, r, z] → локальный вектор станции */
export const tpVec = ([deg, r, z]) => surfacePos(deg * D2R, r, z);

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
