/* ═══════════════════════════════════════════════════════════════════════════
   TV MODE — pure parts (no DOM at import time; unit-tested)

   TV mode is the no-UI kiosk/screensaver mode for Android TV
   (docs/ROADMAP.md, "Бэклог: Android TV"): every UI element hidden, no
   pointer lock, auto-tour and auto day-cycle on, screen kept awake, a
   D-pad-navigable settings overlay. The DOM side lives in app/tv.ts and
   app/ui/tv-overlay.ts.
   ═══════════════════════════════════════════════════════════════════════════ */

import { CONFIG } from '../js/config.js';

/** TV-mode tunables live in CONFIG.TV (js/config.js):
    overlayIdleMs — the overlay closes itself after this much idle time, ms;
    longPressMs — OK held this long opens the overlay instead of the tour, ms;
    tourHolds — tour hold choices in the overlay ("tour speed"), s per point.
    `TV` is the same object, typed. */
export const TV: { overlayIdleMs: number; longPressMs: number; tourHolds: readonly number[] } = CONFIG.TV;

/**
 * Is TV mode on?
 * `?mode=tv` turns it on, any other explicit `?mode=` (e.g. `?mode=web`)
 * turns it off; without the parameter the stored pref decides.
 */
export function parseTvMode(search: string, pref: unknown): boolean {
  const mode = new URLSearchParams(search).get('mode');
  if (mode !== null) return mode.trim().toLowerCase() === 'tv';
  return pref === true || pref === 1 || pref === 'tv';
}

/* ── overlay navigation ────────────────────────────────────────────────── */
export type OverlayKey = 'up' | 'down' | 'left' | 'right' | 'ok' | 'close';

/** What a (normalized) remote key does inside the overlay */
export function overlayKey(key: string): OverlayKey | null {
  switch (key) {
    case 'ArrowUp': return 'up';
    case 'ArrowDown': return 'down';
    case 'ArrowLeft': return 'left';
    case 'ArrowRight': return 'right';
    case 'Enter': case ' ': return 'ok';
    case 'Escape': case 'GoBack': case 'BrowserBack': case 'Backspace': case 'ContextMenu':
      return 'close';
    default: return null;
  }
}

/** Focus index after moving by `d` in a list of `n` items (wraps around) */
export function moveFocus(i: number, n: number, d: number): number {
  if (n <= 0) return -1;
  const cur = i < 0 ? (d > 0 ? -1 : 0) : i;
  return ((cur + d) % n + n) % n;
}

/** Next/previous value in a list of choices (wraps; unknown current → first/last) */
export function cycleValue<T>(list: readonly T[], cur: T, d: number): T {
  const n = list.length;
  const i = list.indexOf(cur);
  if (i < 0) return d >= 0 ? list[0] : list[n - 1];
  return list[((i + d) % n + n) % n];
}
