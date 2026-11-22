import { CONFIG } from './cfg.ts';
import { $ } from './dom.ts';
import { app } from './state.ts';
import { prefs } from './prefs.ts';
import { setTour } from './tour.ts';
import { ctl } from '../js/controls.js';
import { startAudio } from '../js/audio.js';

/* ═══════════════════════════════════════════════════════════════════════════
   ТВ-РЕЖИМ: запуск сеанса

   Корневой класс html.tv прячет весь интерфейс (style.css): HUD, кнопки,
   шторки, подсказки, джойстик, курсор. Заставки нет — сцена сразу летит:
   авто-тур и авто-цикл освещения включены, экран не гаснет.
   ═══════════════════════════════════════════════════════════════════════════ */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let wakeLock: any = null;

/** Screen Wake Lock: держим экран включённым. Браузер снимает блокировку,
    когда вкладка скрыта, — поэтому просим заново при возвращении. */
async function keepAwake() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wl = (navigator as any).wakeLock;
  if (!wl || document.hidden || (wakeLock && !wakeLock.released)) return;
  try { wakeLock = await wl.request('screen'); } catch { /* запрещено политикой или вкладка не видна */ }
}

export function startTvMode() {
  document.documentElement.classList.add('tv');
  $('intro').style.display = 'none';
  ctl.enabled = true;

  /* в ТВ-режиме свои значения по умолчанию: авто-цикл включён */
  app.autoCycle = prefs.get('tvCycle', true);
  $('sCycle').classList.toggle('on', app.autoCycle);
  app.tourHold = prefs.get('tvHold', CONFIG.TOUR_HOLD);
  setTour(true);

  void keepAwake();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void keepAwake(); });

  /* AudioContext заводится только по жесту: первое нажатие на пульте им и будет */
  const wake = () => { startAudio(); void keepAwake(); };
  addEventListener('keydown', wake, { once: true });
  addEventListener('pointerdown', wake, { once: true });
}
