import { CONFIG } from '../cfg.ts';
import { app } from '../state.ts';
import { ctl, isMobile, addLook } from '../../js/controls.js';
import { dispatch } from './actions.ts';
import { stickDown, stickMove, resetStick } from './touch.ts';

/* ═══════════════════════════════════════════════════════════════════════════
   МЫШЬ И УКАЗАТЕЛЬ: pointer lock, обзор мышью или перетаскиванием,
   колесо — базовая скорость. Касания идут через те же Pointer Events:
   левая половина — джойстик (touch.ts), правая — обзор свайпом.
   В ТВ-режиме pointer lock не берётся: курсора там нет вовсе.
   ═══════════════════════════════════════════════════════════════════════════ */
/**
 * @param dom     канвас рендерера
 * @param stage   контейнер, ловящий жесты
 * @param isBusy  () => true, если идёт перелёт или съёмка (ввод игнорируется)
 * @param onTap   касание во время перелёта — отмена
 */
export function initPointer(dom: HTMLCanvasElement, stage: HTMLElement,
  isBusy: () => boolean, onTap: () => void) {
  /* --- Pointer Lock --- */
  document.addEventListener('pointerlockchange', () => { ctl.locked = document.pointerLockElement === dom; });
  window.addEventListener('mousemove', e => {
    if (!ctl.locked || isBusy()) return;
    addLook(e.movementX, e.movementY, CONFIG.LOOK_SENS);
  });

  /* --- колесо: базовая скорость --- */
  stage.addEventListener('wheel', e => {
    e.preventDefault();
    if (e.deltaY) dispatch(e.deltaY > 0 ? 'speedDown' : 'speedUp');
  }, { passive: false });

  /* --- касания и мышь --- */
  stage.addEventListener('pointerdown', e => {
    if (!ctl.enabled) return;
    if (isBusy()) { onTap(); return; }

    if (e.pointerType === 'mouse' && !isMobile) {
      ctl.look.id = e.pointerId; ctl.look.lx = e.clientX; ctl.look.ly = e.clientY;
      /* фолбэк: обзор перетаскиванием */
      if (!ctl.locked && !app.tv) dom.requestPointerLock?.()?.catch?.(() => {});
      return;
    }
    stage.setPointerCapture?.(e.pointerId);
    if (!stickDown(e) && ctl.look.id === -1) {
      ctl.look.id = e.pointerId; ctl.look.lx = e.clientX; ctl.look.ly = e.clientY;
    }
  });

  stage.addEventListener('pointermove', e => {
    if (!ctl.enabled || isBusy()) return;
    if (stickMove(e)) return;
    if (e.pointerId === ctl.look.id && !ctl.locked) {
      addLook(e.clientX - ctl.look.lx, e.clientY - ctl.look.ly,
        e.pointerType === 'mouse' ? CONFIG.LOOK_SENS : CONFIG.TOUCH_SENS);
      ctl.look.lx = e.clientX; ctl.look.ly = e.clientY;
    }
  });

  const release = (e: PointerEvent) => {
    if (e.pointerId === ctl.stick.id) { resetStick(); }
    if (e.pointerId === ctl.look.id) ctl.look.id = -1;
  };
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
    stage.addEventListener(ev, release);
  }
}
