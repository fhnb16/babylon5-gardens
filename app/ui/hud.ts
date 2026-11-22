import { $ } from '../dom.ts';
import { app, renderer } from '../state.ts';
import { prefs } from '../prefs.ts';
import { phaseIndex } from '../palette.ts';
import { closeSheets } from './sheets.ts';
import { dispatch, type Action } from '../input/actions.ts';
import { VERSION } from '../../js/version.js';
import { ctl, isMobile } from '../../js/controls.js';
import { audio, startAudio, setEnabled } from '../../js/audio.js';

/* ═══════════════════════════════════════════════════════════════════════════
   HUD: кнопки справа, панель фото-режима, полоса поездки, заставка.
   Кнопки не делают ничего сами — они отправляют действия, как клавиатура,
   пульт и геймпад (input/actions.ts).
   ═══════════════════════════════════════════════════════════════════════════ */
const bind = (id: string, a: Action) => { $(id).onclick = () => dispatch(a); };

const PHASE_ICONS = [
  '',                                                                   // солнце: берётся из разметки
  '<svg viewBox="0 0 24 24"><path d="M2.6 18.6h18.8M6.4 18.6a5.6 5.6 0 0 1 11.2 0"/><path d="M12 3.4v2.4M4.6 6.9l1.7 1.7M19.4 6.9l-1.7 1.7M2.8 14.2h1.9M19.3 14.2h1.9"/></svg>',
  '<svg viewBox="0 0 24 24"><path d="M20.5 14.6A8.6 8.6 0 0 1 9.4 3.5a8.6 8.6 0 1 0 11.1 11.1z"/></svg>'
];
export const PHASE_NAMES = ['День', 'Закат', 'Ночь'];
const SND_OFF = '<svg viewBox="0 0 24 24"><path d="M4 9.2h3.3L12 5.3v13.4l-4.7-3.9H4z"/><path d="M16.2 9.8l5 4.4M21.2 9.8l-5 4.4"/></svg>';
let SND_ON = '';

/** Иконка и подпись кнопки фазы — по фазе, к которой идёт переход */
export function setDayIcon() {
  const bDay = $('bDay');
  const k = phaseIndex();
  bDay.innerHTML = PHASE_ICONS[k];
  bDay.title = PHASE_NAMES[k];
  bDay.classList.toggle('on', k > 0);
}

export function showSnd() {
  const bSnd = $('bSnd');
  bSnd.innerHTML = audio.on ? SND_ON : SND_OFF;
  bSnd.classList.toggle('on', audio.on);
}

export function initHud() {
  bind('bTour', 'toggleTour');
  bind('bRide', 'toggleRide');
  bind('bRideExit', 'exitRide');
  bind('bPhoto', 'photo');
  bind('bPhotoExit', 'exitPhoto');
  bind('bShot', 'shot');
  bind('bTrace', 'trace');
  bind('bPause', 'denoisePause');
  bind('bPath', 'pathTrace');
  bind('bDebug', 'traceDebug');
  bind('bTp', 'toggleTeleports');
  bind('bSet', 'toggleSettings');
  bind('bHelp', 'toggleHelp');
  bind('bFs', 'fullscreen');
  $('tpClose').onclick = $('setClose').onclick = $('helpClose').onclick = closeSheets;

  PHASE_ICONS[0] = $('bDay').innerHTML;
  /* По кругу: день → закат → ночь → день (действие cyclePhase) */
  bind('bDay', 'cyclePhase');
  setDayIcon();

  SND_ON = $('bSnd').innerHTML;
  setEnabled(prefs.get('sound', true));
  showSnd();
  bind('bSnd', 'toggleSound');

  /* версия видна пользователю: по ней он сообщит, что именно у него */
  const vEl = $('ver');
  if (vEl) vEl.textContent = 'v' + VERSION;

  $('go').onclick = () => {
    $('intro').classList.add('hide');
    setTimeout(() => { $('intro').style.display = 'none'; }, 700);
    ctl.enabled = true;
    startAudio();                 // AudioContext можно завести только по жесту
    if (!isMobile && !app.tv) renderer.domElement.requestPointerLock?.();
  };
}
