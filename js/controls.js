import * as THREE from 'three';
import { CONFIG } from './config.js';
import { clamp } from './util.js';

/* ═══════════════════════════════════════════════════════════════════════════
   УПРАВЛЕНИЕ — только Pointer Events. Никаких FlyControls/OrbitControls
   и никаких внешних джойстиков.
   ═══════════════════════════════════════════════════════════════════════════ */
export const ctl = {
  yaw: 0, pitch: 0,
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

const PITCH_MAX = 89 * Math.PI / 180;
let base, knob;

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
      const len = Math.hypot(dx, dy), R = CONFIG.STICK_RADIUS;
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
  ctl.yaw -= dx * k * ctl.sens;
  ctl.pitch = clamp(ctl.pitch - dy * k * ctl.sens, -PITCH_MAX, PITCH_MAX);
}
function showStick(bx, by, kx, ky) {
  base.classList.add('on'); knob.classList.add('on');
  base.style.transform = `translate(${bx - 60}px,${by - 60}px)`;
  knob.style.transform = `translate(${kx - 26}px,${ky - 26}px)`;
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
const _up = new THREE.Vector3(0, 1, 0), _localUp = new THREE.Vector3();
const _eul = new THREE.Euler(0, 0, 0, 'YXZ');

export function updateControls(dt, camera) {
  if (!ctl.enabled) return;
  camera.quaternion.setFromEuler(_eul.set(ctl.pitch, ctl.yaw, 0));

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
  _right.crossVectors(_fwd, _up).normalize();
  _localUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
  camera.position.addScaledVector(_fwd, fz * spd);
  camera.position.addScaledVector(_right, fx * spd);
  camera.position.addScaledVector(_localUp, fy * spd);

  /* мягко держим камеру внутри станции */
  const r = Math.hypot(camera.position.x, camera.position.y);
  if (r > CONFIG.R - 1.2) {
    const f = (CONFIG.R - 1.2) / r;
    camera.position.x *= f; camera.position.y *= f;
  }
  camera.position.z = clamp(camera.position.z, -CONFIG.L / 2 + 2, CONFIG.L / 2 - 2);
}

/** После перелёта: подхватить ориентацию камеры без скачка */
export function syncFromCamera(camera) {
  _eul.setFromQuaternion(camera.quaternion, 'YXZ');
  ctl.yaw = _eul.y;
  ctl.pitch = clamp(_eul.x, -PITCH_MAX, PITCH_MAX);
}
