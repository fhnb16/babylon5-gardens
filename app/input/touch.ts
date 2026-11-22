import { CONFIG } from '../cfg.ts';
import { $ } from '../dom.ts';
import { app } from '../state.ts';
import { ctl, isMobile } from '../../js/controls.js';
import { dispatch } from './actions.ts';

/* ═══════════════════════════════════════════════════════════════════════════
   КАСАНИЯ: плавающий джойстик под левым пальцем, кнопки-«держалки» ▲ ▼,
   переключатель скорости, мобайл-гигиена. Только Pointer Events, никаких
   внешних джойстиков. Сами события сцены раздаёт pointer.ts.
   ═══════════════════════════════════════════════════════════════════════════ */
let base: HTMLElement | null = null, knob: HTMLElement | null = null;

/** §12: радиус джойстика зависит от ориентации экрана */
export const stickRadius = (): number =>
  CONFIG.STICK_RADIUS[innerHeight >= innerWidth ? 'portrait' : 'landscape'];

export function initTouch() {
  base = $('stickBase');
  knob = $('stickKnob');

  /* --- кнопки-«держалки» ▲ ▼ и переключатель скорости --- */
  const hold = (el: HTMLElement, on: () => void, off: () => void) => {
    el.addEventListener('pointerdown', e => {
      e.stopPropagation(); e.preventDefault();
      el.setPointerCapture?.(e.pointerId); el.classList.add('held'); on();
    });
    const end = (e?: Event) => { e?.stopPropagation?.(); el.classList.remove('held'); off(); };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('lostpointercapture', () => end());
  };
  hold($('bUp'), () => ctl.vert = 1, () => ctl.vert = 0);
  hold($('bDn'), () => ctl.vert = -1, () => ctl.vert = 0);

  $('bSpd').addEventListener('pointerdown', (e: PointerEvent) => {
    e.stopPropagation(); e.preventDefault();
    dispatch('toggleSpeed');
  });

  /* --- мобайл-гигиена --- */
  addEventListener('gesturestart', e => e.preventDefault(), { passive: false });
  addEventListener('contextmenu', e => e.preventDefault());
  document.addEventListener('dblclick', e => e.preventDefault(), { passive: false });

  if (isMobile && !app.tv) $('pad').classList.add('show');
}

/** Палец лёг на левую половину — там рождается джойстик */
export function stickDown(e: PointerEvent): boolean {
  if (e.clientX < innerWidth * 0.5 && !ctl.stick.active) {
    Object.assign(ctl.stick, { active: true, id: e.pointerId, ox: e.clientX, oy: e.clientY, x: 0, y: 0 });
    showStick(e.clientX, e.clientY, e.clientX, e.clientY);
    return true;
  }
  return false;
}

/** Ведём джойстик; false — это не его палец */
export function stickMove(e: PointerEvent): boolean {
  const s = ctl.stick;
  if (e.pointerId !== s.id || !s.active) return false;
  let dx = e.clientX - s.ox, dy = e.clientY - s.oy;
  const len = Math.hypot(dx, dy), R = stickRadius();
  if (len > R) { dx *= R / len; dy *= R / len; }
  s.x = dx / R; s.y = dy / R;
  showStick(s.ox, s.oy, s.ox + dx, s.oy + dy);
  return true;
}

function showStick(bx: number, by: number, kx: number, ky: number) {
  if (!base || !knob) return;
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
