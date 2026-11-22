import { CONFIG } from './cfg.ts';
import { $ } from './dom.ts';
import { app } from './state.ts';
import { prefs } from './prefs.ts';
import { goTo, cancelFly } from './flight.ts';
import { tour, setTour, stepView } from './tour.ts';
import { ride, setRide } from './ride.ts';
import { setClean, setTrace, stopTracing, togglePath, toggleDenoisePause,
  cycleTraceDebug } from './photo-mode.ts';
import { closeSheets, toggleSheet, openSheet, anySheetOpen } from './ui/sheets.ts';
import { setDayIcon, showSnd } from './ui/hud.ts';
import { isOverlayOpen, openOverlay, closeOverlay } from './ui/tv-overlay.ts';
import { onAction } from './input/actions.ts';
import { clamp } from '../core/math/scalar.ts';
import { ctl } from '../js/controls.js';
import { audio, setEnabled } from '../js/audio.js';
import { trace } from '../js/photo.js';

/* ═══════════════════════════════════════════════════════════════════════════
   ЧТО ДЕЛАЕТ КАЖДОЕ ДЕЙСТВИЕ
   Единственное место, где действие превращается в вызовы приложения.
   Кнопки HUD, клавиатура, пульт и геймпад только отправляют действия.
   ═══════════════════════════════════════════════════════════════════════════ */
export function initCommands() {
  /* --- точки обзора --- */
  onAction('goToView', i => { closeSheets(); setTour(false); setRide(false); goTo(i ?? 0); });
  onAction('nextView', () => { closeSheets(); setRide(false); stepView(+1); });
  onAction('prevView', () => { closeSheets(); setRide(false); stepView(-1); });

  /* --- режимы --- */
  onAction('toggleTour', () => { closeSheets(); setRide(false); setTour(!tour.on); });
  onAction('toggleRide', () => { closeSheets(); setRide(!ride.on); });
  onAction('exitRide', () => setRide(false));
  onAction('togglePause', () => { app.held = !app.held; });

  /* --- фаза освещения ---
     По кругу: день → закат → ночь → день. Цель — всегда СЛЕДУЮЩАЯ фаза от
     текущей, а не «плюс один к цели»: иначе быстрые нажатия копили очередь
     и переход растягивался на десятки секунд. */
  onAction('cyclePhase', () => { app.phaseTo = Math.floor(app.phase) + 1; setDayIcon(); });
  /* Назад — к предыдущей целой фазе, тоже плавно. Счётчики держим
     неотрицательными: палитра берёт фазу по модулю круга. */
  onAction('prevPhase', () => {
    const n = CONFIG.PHASES.length;
    if (app.phase < 1) { app.phase += n; app.phaseTo += n; }
    app.phaseTo = Math.ceil(app.phase) - 1;
    setDayIcon();
  });
  onAction('toggleAutoCycle', () => {
    /* в ТВ-режиме авто-цикл свой (включён по умолчанию) и хранится отдельно */
    if (!app.tv) { $('sCycle').click(); return; }
    app.autoCycle = !app.autoCycle;
    prefs.set('tvCycle', app.autoCycle);
    $('sCycle').classList.toggle('on', app.autoCycle);
  });

  /* --- шторки и меню --- */
  onAction('openSettings', () => { if (app.tv) openOverlay(); else openSheet('set'); });
  onAction('toggleSettings', () => {
    if (app.tv) { if (isOverlayOpen()) closeOverlay(); else openOverlay(); }
    else toggleSheet('set');
  });
  onAction('toggleTeleports', () => toggleSheet('tp'));
  onAction('toggleHelp', () => toggleSheet('help'));
  /* Назад снимает верхний слой: меню, шторку, фото-режим, поездку */
  onAction('back', () => {
    if (isOverlayOpen()) closeOverlay();
    else if (anySheetOpen()) closeSheets();
    else if (app.cleanView) setClean(false);
    else if (ride.on) setRide(false);
    else window.GardensAndroid?.close();
  });

  onAction('checkUpdates', () => window.GardensAndroid?.checkUpdates());
  onAction('dreamSettings', () => window.GardensAndroid?.screenSaverSettings());

  /* --- фото-режим --- */
  onAction('photo', () => setClean(!app.cleanView));
  onAction('exitPhoto', () => setClean(false));
  onAction('shot', () => { app.shotPending = true; });
  onAction('trace', () => setTrace(!trace.active));
  onAction('pathTrace', () => { void togglePath(); });
  onAction('denoisePause', toggleDenoisePause);
  onAction('traceDebug', cycleTraceDebug);

  /* --- прочее --- */
  onAction('fullscreen', () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.()?.catch?.(() => {});
  });
  onAction('toggleSound', () => { setEnabled(!audio.on); prefs.set('sound', audio.on); showSnd(); });
  onAction('speedUp', () => { ctl.speed = clamp(ctl.speed + 2, CONFIG.SPEED_MIN, CONFIG.SPEED_MAX); });
  onAction('speedDown', () => { ctl.speed = clamp(ctl.speed - 2, CONFIG.SPEED_MIN, CONFIG.SPEED_MAX); });
  onAction('toggleSpeed', () => {
    const fast = ctl.speed < CONFIG.SPEED_RABBIT;
    ctl.speed = fast ? CONFIG.SPEED_RABBIT : CONFIG.SPEED_TURTLE;
    $('bSpd').classList.toggle('on', fast);
  });
  onAction('cancel', () => { cancelFly(); stopTracing(); });
}
