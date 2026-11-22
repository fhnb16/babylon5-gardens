/* ═══════════════════════════════════════════════════════════════════════════
   INPUT ACTION LAYER

   Every discrete command of the app is an Action. Keyboard, UI buttons,
   gamepad and TV remote never call app code directly: they map their input
   onto an Action and dispatch() it. Handlers are registered once
   (app/commands.ts). Continuous input — WASD/arrow flight, mouse/stick look,
   the touch joystick — is NOT an action: it stays analog state in `ctl`
   (js/controls.js).

   This module is pure (no DOM at import time): the mapping tables and the
   lookup/long-press helpers are unit-tested in test/actions.test.ts.
   ═══════════════════════════════════════════════════════════════════════════ */

import { CONFIG } from '../../js/config.js';

export const ACTIONS = [
  /* points of view */
  'nextView', 'prevView', 'goToView',
  /* modes */
  'toggleTour', 'toggleRide', 'exitRide', 'togglePause',
  /* lighting phase */
  'cyclePhase', 'prevPhase', 'toggleAutoCycle',
  /* overlays */
  'openSettings', 'toggleSettings', 'toggleTeleports', 'toggleHelp', 'back', 'checkUpdates', 'dreamSettings',
  /* photo mode */
  'photo', 'exitPhoto', 'shot', 'trace', 'pathTrace', 'denoisePause', 'traceDebug',
  /* misc */
  'fullscreen', 'toggleSound', 'speedUp', 'speedDown', 'toggleSpeed',
  /* tap during a flight: cancel it (and the tour, and screen-space tracing) */
  'cancel'
] as const;
export type Action = typeof ACTIONS[number];

/** Human-readable names (help sheet) */
export const ACTION_LABELS: Readonly<Record<Action, string>> = {
  nextView: 'следующая точка обзора', prevView: 'предыдущая точка обзора',
  goToView: 'перелёт в точку', toggleTour: 'авто-тур', toggleRide: 'поездка на монорельсе',
  exitRide: 'выйти из кабины', togglePause: 'пауза',
  cyclePhase: 'следующая фаза освещения', prevPhase: 'предыдущая фаза освещения',
  toggleAutoCycle: 'авто-цикл освещения',
  openSettings: 'настройки', toggleSettings: 'настройки', toggleTeleports: 'телепорты',
  checkUpdates: 'проверить обновления', dreamSettings: 'выбрать заставку Android TV',
  toggleHelp: 'справка', back: 'закрыть / назад',
  photo: 'фото-режим', exitPhoto: 'выйти из фото-режима', shot: 'снимок',
  trace: 'экранные лучи', pathTrace: 'трассировка пути', denoisePause: 'пауза и очистка',
  traceDebug: 'показать вклад лучей',
  fullscreen: 'во весь экран', toggleSound: 'звук', speedUp: 'быстрее', speedDown: 'медленнее',
  toggleSpeed: 'черепаха / кролик', cancel: 'отмена перелёта'
};

/* ── dispatch ──────────────────────────────────────────────────────────── */
export type ActionHandler = (arg?: number) => void;
const handlers = new Map<Action, ActionHandler>();

/** Register the single handler of an action (a later call replaces it) */
export function onAction(a: Action, fn: ActionHandler) { handlers.set(a, fn); }

/** Run an action. `arg` carries a payload (goToView: point index).
    Returns false when nobody handles the action. */
export function dispatch(a: Action, arg?: number): boolean {
  const fn = handlers.get(a);
  if (!fn) return false;
  fn(arg);
  return true;
}

/* ── keyboard ──────────────────────────────────────────────────────────── */
/** Minimal KeyboardEvent shape — lets tests pass plain objects */
export interface KeyLike { key: string; code?: string; keyCode?: number }

/** Desktop shortcuts by KeyboardEvent.code (layout-independent: works with
    a Russian layout too). Movement keys — WASD, arrows, R/F, Shift — are
    deliberately absent: they are analog state, not actions. */
export const KEYBOARD_MAP: Readonly<Record<string, Action>> = {
  Escape: 'back',
  Comma: 'prevView', Period: 'nextView',
  KeyT: 'toggleTour', KeyY: 'toggleRide',
  KeyL: 'cyclePhase', KeyK: 'prevPhase', KeyC: 'toggleAutoCycle',
  KeyO: 'openSettings', KeyG: 'toggleTeleports', KeyH: 'toggleHelp',
  KeyP: 'photo', KeyM: 'toggleSound', Pause: 'togglePause',
  Equal: 'speedUp', Minus: 'speedDown', NumpadAdd: 'speedUp', NumpadSubtract: 'speedDown'
};

/** Named keys that mean the same everywhere (media keys, menu, browser back) */
const COMMON_MAP: Readonly<Record<string, Action>> = {
  MediaPlayPause: 'togglePause', MediaPlay: 'togglePause', MediaPause: 'togglePause',
  ContextMenu: 'openSettings',
  GoBack: 'back', BrowserBack: 'back'
};

/** TV remote (D-pad) by KeyboardEvent.key — see docs/ROADMAP.md, "Android TV".
    OK/Enter is special: short press → toggleTour, long press → openSettings
    (see createOkPress). */
export const REMOTE_MAP: Readonly<Record<string, Action>> = {
  ...COMMON_MAP,
  ArrowLeft: 'prevView', ArrowRight: 'nextView',
  ArrowUp: 'cyclePhase', ArrowDown: 'prevPhase',
  ChannelUp: 'nextView', ChannelDown: 'prevView',
  MediaTrackNext: 'nextView', MediaTrackPrevious: 'prevView',
  Enter: 'toggleTour',
  Escape: 'back', Backspace: 'back'
};

/** Legacy keyCode → key for remotes/WebViews that report key 'Unidentified'.
    Values: DOM keyCodes (Chromium/Android), plus Tizen (10009) and webOS (461) back. */
const KEYCODE_KEYS: Readonly<Record<number, string>> = {
  8: 'Backspace', 13: 'Enter', 27: 'Escape',
  37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown',
  93: 'ContextMenu', 166: 'BrowserBack', 179: 'MediaPlayPause',
  461: 'GoBack', 10009: 'GoBack'
};

/** KeyboardEvent.key with remote quirks smoothed out */
export function normalizeKey(ev: KeyLike): string {
  let k = ev.key;
  if ((!k || k === 'Unidentified') && ev.keyCode != null) k = KEYCODE_KEYS[ev.keyCode] ?? k;
  if (k === 'Select' || k === 'NumpadEnter') return 'Enter';
  if (k === 'Esc') return 'Escape';
  return k || '';
}

/** Is this one of the OK/Enter keys (long press opens the menu) */
export const isOkKey = (key: string) => key === 'Enter';

/** Action of a remote key (also used by the gamepad: its buttons emit remote keys) */
export function remoteAction(key: string): Action | null {
  return REMOTE_MAP[key] ?? null;
}

/**
 * Action of a keyboard event.
 * @param tv  TV mode: the D-pad layout wins (arrows switch views instead of flying)
 */
export function keyToAction(ev: KeyLike, tv: boolean): Action | null {
  const key = normalizeKey(ev);
  if (tv) return REMOTE_MAP[key] ?? (ev.code ? KEYBOARD_MAP[ev.code] ?? null : null);
  return COMMON_MAP[key] ?? (ev.code ? KEYBOARD_MAP[ev.code] ?? null : null);
}

/* ── gamepad ───────────────────────────────────────────────────────────── */
/** Standard Gamepad mapping (https://w3c.github.io/gamepad/#remapping):
    buttons emit the same keys as a TV remote, so the D-pad behaves exactly
    like the remote: A = OK, B = back, Start = menu. */
export const GAMEPAD_MAP: Readonly<Record<number, string>> = {
  0: 'Enter',        // A
  1: 'Escape',       // B
  8: 'Escape',       // Back / Select
  9: 'ContextMenu',  // Start
  12: 'ArrowUp', 13: 'ArrowDown', 14: 'ArrowLeft', 15: 'ArrowRight',
  4: 'ChannelDown',  // LB
  5: 'ChannelUp'     // RB
};

/** Gamepad tunables live in CONFIG.GAMEPAD (js/config.js): `dead` — stick
    dead zone, `lookRate` — right stick look rate, rad/s at full deflection.
    `GAMEPAD` is the same object. */
export const GAMEPAD: { dead: number; lookRate: number } = CONFIG.GAMEPAD;

/** Stick value with the dead zone removed and the rest rescaled to 0…1 */
export function deadZone(v: number, dead = GAMEPAD.dead): number {
  const a = Math.abs(v);
  if (a <= dead) return 0;
  return Math.sign(v) * Math.min(1, (a - dead) / (1 - dead));
}

/* ── long press of OK ──────────────────────────────────────────────────── */
/** Long-press detector for OK. Short press → `short`, held ≥ ms → `long`
    (fires once while still held; the release then does nothing).
    Times are passed in, so it is a pure state machine. */
export function createOkPress(ms: number, short: Action = 'toggleTour', long: Action = 'openSettings') {
  let downAt = -1, fired = false;
  return {
    get held() { return downAt >= 0; },
    /** key down (auto-repeats are ignored) */
    down(t: number) { if (downAt < 0) { downAt = t; fired = false; } },
    /** call while held: returns `long` once the threshold is reached */
    poll(t: number): Action | null {
      if (downAt < 0 || fired || t - downAt < ms) return null;
      fired = true;
      return long;
    },
    /** key up: the short action, or null after a long press */
    up(t: number): Action | null {
      if (downAt < 0) return null;
      const r = fired ? null : (t - downAt >= ms ? long : short);
      downAt = -1; fired = false;
      return r;
    },
    /** forget a press (e.g. focus lost) */
    reset() { downAt = -1; fired = false; }
  };
}
