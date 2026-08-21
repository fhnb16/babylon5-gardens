import * as THREE from 'three';
import { CONFIG } from './config.js';
import { clamp, clampPitch } from './util.js';

/* ═══════════════════════════════════════════════════════════════════════════
   УПРАВЛЕНИЕ — только Pointer Events. Никаких FlyControls/OrbitControls
   и никаких внешних джойстиков.
   ═══════════════════════════════════════════════════════════════════════════ */
export const ctl = {
  freeFly: false,       // false — горизонт следует цилиндру, true — обычный полёт
  speed: CONFIG.SPEED_BASE,
  boost: false,
  keys: Object.create(null),
  vert: 0,
  stick: { active: false, id: -1, ox: 0, oy: 0, x: 0, y: 0 },
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
let base, knob;
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

/** §12: радиус джойстика зависит от ориентации экрана */
export const stickRadius = () =>
  CONFIG.STICK_RADIUS[innerHeight >= innerWidth ? 'portrait' : 'landscape'];

/**
 * @param dom     канвас рендерера
 * @param stage   контейнер, ловящий жесты
 * @param isBusy  () => true, если идёт перелёт (ввод игнорируется)
 * @param onTap   вызывается при касании во время перелёта — отмена
 */
export function initControls(dom, stage, isBusy, onTap) {
  base = document.getElementById('stickBase');
  knob = document.getElementById('stickKnob');

  /* --- клавиатура --- */
  addEventListener('keydown', e => {
    ctl.keys[e.code] = true;
    if (e.code.startsWith('Shift')) ctl.boost = true;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  }, { passive: false });
  addEventListener('keyup', e => {
    ctl.keys[e.code] = false;
    if (e.code.startsWith('Shift')) ctl.boost = false;
  });

  /* --- Pointer Lock --- */
  document.addEventListener('pointerlockchange', () => { ctl.locked = document.pointerLockElement === dom; });
  addEventListener('mousemove', e => {
    if (!ctl.locked || isBusy()) return;
    look(e.movementX, e.movementY, CONFIG.LOOK_SENS);
  });

  /* --- колесо: базовая скорость --- */
  stage.addEventListener('wheel', e => {
    e.preventDefault();
    ctl.speed = clamp(ctl.speed - Math.sign(e.deltaY) * 2, CONFIG.SPEED_MIN, CONFIG.SPEED_MAX);
  }, { passive: false });

  /* --- касания и мышь --- */
  stage.addEventListener('pointerdown', e => {
    if (!ctl.enabled) return;
    if (isBusy()) { onTap(); return; }

    if (e.pointerType === 'mouse' && !isMobile) {
      ctl.look.id = e.pointerId; ctl.look.lx = e.clientX; ctl.look.ly = e.clientY;
      if (!ctl.locked) dom.requestPointerLock?.()?.catch?.(() => {});   // фолбэк: обзор перетаскиванием
      return;
    }
    stage.setPointerCapture?.(e.pointerId);
    if (e.clientX < innerWidth * 0.5 && !ctl.stick.active) {
      Object.assign(ctl.stick, { active: true, id: e.pointerId, ox: e.clientX, oy: e.clientY, x: 0, y: 0 });
      showStick(e.clientX, e.clientY, e.clientX, e.clientY);
    } else if (ctl.look.id === -1) {
      ctl.look.id = e.pointerId; ctl.look.lx = e.clientX; ctl.look.ly = e.clientY;
    }
  });

  stage.addEventListener('pointermove', e => {
    if (!ctl.enabled || isBusy()) return;
    const s = ctl.stick;
    if (e.pointerId === s.id && s.active) {
      let dx = e.clientX - s.ox, dy = e.clientY - s.oy;
      const len = Math.hypot(dx, dy), R = stickRadius();
      if (len > R) { dx *= R / len; dy *= R / len; }
      s.x = dx / R; s.y = dy / R;
      showStick(s.ox, s.oy, s.ox + dx, s.oy + dy);
    } else if (e.pointerId === ctl.look.id && !ctl.locked) {
      look(e.clientX - ctl.look.lx, e.clientY - ctl.look.ly,
        e.pointerType === 'mouse' ? CONFIG.LOOK_SENS : CONFIG.TOUCH_SENS);
      ctl.look.lx = e.clientX; ctl.look.ly = e.clientY;
    }
  });

  const release = e => {
    if (e.pointerId === ctl.stick.id) { resetStick(); }
    if (e.pointerId === ctl.look.id) ctl.look.id = -1;
  };
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    stage.addEventListener(ev, release);
  }

  /* --- кнопки-«держалки» ▲ ▼ и переключатель скорости --- */
  const hold = (el, on, off) => {
    el.addEventListener('pointerdown', e => {
      e.stopPropagation(); e.preventDefault();
      el.setPointerCapture?.(e.pointerId); el.classList.add('held'); on();
    });
    const end = e => { e?.stopPropagation?.(); el.classList.remove('held'); off(); };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('lostpointercapture', () => end());
  };
  hold(document.getElementById('bUp'), () => ctl.vert = 1, () => ctl.vert = 0);
  hold(document.getElementById('bDn'), () => ctl.vert = -1, () => ctl.vert = 0);

  const bSpd = document.getElementById('bSpd');
  bSpd.addEventListener('pointerdown', e => {
    e.stopPropagation(); e.preventDefault();
    const fast = ctl.speed < CONFIG.SPEED_RABBIT;
    ctl.speed = fast ? CONFIG.SPEED_RABBIT : CONFIG.SPEED_TURTLE;
    bSpd.classList.toggle('on', fast);
  });

  /* --- мобайл-гигиена --- */
  addEventListener('gesturestart', e => e.preventDefault(), { passive: false });
  addEventListener('contextmenu', e => e.preventDefault());
  document.addEventListener('dblclick', e => e.preventDefault(), { passive: false });

  if (isMobile) document.getElementById('pad').classList.add('show');
}

function look(dx, dy, k) {
  dYaw -= dx * k * ctl.sens;
  dPitch -= dy * k * ctl.sens;
}
function showStick(bx, by, kx, ky) {
  const R = stickRadius(), kr = Math.round(R * 0.44);
  base.style.width = base.style.height = R * 2 + 'px';
  knob.style.width = knob.style.height = kr * 2 + 'px';
  base.classList.add('on'); knob.classList.add('on');
  base.style.transform = `translate(${bx - R}px,${by - R}px)`;
  knob.style.transform = `translate(${kx - kr}px,${ky - kr}px)`;
}
export function resetStick() {
  Object.assign(ctl.stick, { active: false, id: -1, x: 0, y: 0 });
  ctl.look.id = -1; ctl.vert = 0;
  base?.classList.remove('on'); knob?.classList.remove('on');
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
  if (!fx && !fz && !fy) return;

  const spd = ctl.speed * (ctl.boost ? CONFIG.SPEED_BOOST : 1) * dt;
  camera.getWorldDirection(_fwd);
  frameUp(camera, _up);
  _right.crossVectors(_fwd, _up).normalize();
  camera.position.addScaledVector(_fwd, fz * spd);
  camera.position.addScaledVector(_right, fx * spd);
  camera.position.addScaledVector(_up, fy * spd);   // «вверх» — к оси станции

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
