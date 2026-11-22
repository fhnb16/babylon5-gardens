import { app } from '../state.ts';
import { ctl } from '../../js/controls.js';
import { dispatch, keyToAction, normalizeKey } from './actions.ts';
import { remoteDown, remoteUp, remoteReset } from './remote.ts';

/* ═══════════════════════════════════════════════════════════════════════════
   КЛАВИАТУРА
   Два вида ввода с одной клавиатуры:
   • аналоговый — WASD, стрелки, R/F, Shift: состояние в ctl.keys, его
     читает updateControls каждый кадр;
   • действия — горячие клавиши (KEYBOARD_MAP), а в ТВ-режиме весь пульт
     (REMOTE_MAP): стрелки там листают точки обзора, а не двигают камеру.
   ═══════════════════════════════════════════════════════════════════════════ */

/** Клавиша набирается в поле ввода — горячие клавиши молчат */
const typing = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  return !!t && (t.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName));
};
/** С модификатором — это сочетание браузера (Ctrl+P, Ctrl+−), не наше */
const chord = (e: KeyboardEvent) => e.ctrlKey || e.metaKey || e.altKey;

export function initKeyboard() {
  window.addEventListener('keydown', e => {
    if (window.GardensAndroid && e.key === 'GoBack' && !app.tv) {
      if (!e.repeat) dispatch('back');
      e.preventDefault(); return;
    }
    if (app.tv && !chord(e)) {
      if (remoteDown(normalizeKey(e), e.repeat)) { e.preventDefault(); return; }
    } else if (ctl.enabled && !typing(e) && !chord(e)) {
      const a = keyToAction(e, false);
      if (a) {
        if (!e.repeat) dispatch(a);
        e.preventDefault();
        return;
      }
    }

    ctl.keys[e.code] = true;
    if (e.code.startsWith('Shift')) ctl.boost = true;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  }, { passive: false });

  window.addEventListener('keyup', e => {
    if (app.tv && remoteUp(normalizeKey(e))) e.preventDefault();
    ctl.keys[e.code] = false;
    if (e.code.startsWith('Shift')) ctl.boost = false;
  });

  /* потеря фокуса окна съедает keyup: без сброса клавиша «залипает» */
  window.addEventListener('blur', () => {
    for (const k in ctl.keys) ctl.keys[k] = false;
    ctl.boost = false;
    remoteReset();
  });
}
