import { CONFIG } from './cfg.ts';
import { $ } from './dom.ts';
import { app } from './state.ts';
import { fly, goTo } from './flight.ts';

/* ═══════════════════════════════════════════════════════════════════════════
   АВТО-ТУР
   Облетает все точки по кругу. Титры показываются после посадки и гаснут
   перед следующим взлётом. Любое вмешательство в управление тур прекращает.
   Стоянка в точке — app.tourHold: в ТВ-режиме её меняет экранное меню.
   ═══════════════════════════════════════════════════════════════════════════ */
export const tour = { on: false, idx: 0, wait: 0 };
const capEl = () => $('caption');

function showCaption(i: number) {
  const tp = CONFIG.TP[i], el = capEl();
  el.firstElementChild.textContent = tp.name;
  el.lastElementChild.textContent = tp.hint;
  el.classList.add('show');
}
function hideCaption() { capEl().classList.remove('show'); }

export function setTour(on: boolean) {
  tour.on = on;
  $('bTour').classList.toggle('on', on);
  if (on) {
    tour.idx = 0;
    goTo(0);
    tour.wait = app.tourHold;
  } else {
    hideCaption();
  }
}
export function updateTour(dt: number) {
  if (!tour.on) return;
  if (fly.on) { hideCaption(); return; }
  if (tour.wait === app.tourHold) showCaption(tour.idx);
  tour.wait -= dt;
  if (tour.wait <= 0) {
    tour.idx = (tour.idx + 1) % CONFIG.TP.length;
    goTo(tour.idx);
    tour.wait = app.tourHold;
  }
}

/** Соседняя точка обзора (действия nextView / prevView). Идущий тур не
    прерывается, а продолжается с новой точки — так пульт листает облёт. */
export function stepView(dir: number) {
  const n = CONFIG.TP.length;
  const i = ((app.view + dir) % n + n) % n;
  if (tour.on) {
    tour.idx = i;
    tour.wait = app.tourHold;
    hideCaption();
  }
  goTo(i);
}
