import { CONFIG } from '../cfg.ts';
import { isOverlayOpen, overlayKeyDown } from '../ui/tv-overlay.ts';
import { dispatch, remoteAction, isOkKey, createOkPress } from './actions.ts';

/* ═══════════════════════════════════════════════════════════════════════════
   TV REMOTE (D-pad) PIPELINE

   Keys of a TV remote — and gamepad buttons, which emit the same keys — go
   through here: the settings overlay gets them first while it is open,
   OK/Enter distinguishes a short press (toggle tour) from a long one (open
   the menu), everything else maps through REMOTE_MAP onto actions.
   Keyboard events reach this pipeline only in TV mode; gamepads always.
   ═══════════════════════════════════════════════════════════════════════════ */
const ok = createOkPress(CONFIG.TV.longPressMs);
let okTimer = 0;
const now = () => performance.now();

/** Key pressed. Returns true when the key was consumed (caller prevents default). */
export function remoteDown(key: string, repeat: boolean): boolean {
  /* OK still held after a long press opened the menu: its repeats must not
     click the first menu item */
  if (isOkKey(key) && (repeat || ok.held)) return true;

  if (isOverlayOpen() && overlayKeyDown(key)) return true;

  if (isOkKey(key)) {
    ok.down(now());
    clearTimeout(okTimer);
    okTimer = window.setTimeout(() => {
      const a = ok.poll(now());
      if (a) dispatch(a);
    }, CONFIG.TV.longPressMs);
    return true;
  }
  const a = remoteAction(key);
  if (!a) return false;
  /* auto-repeat of a held arrow would fire a flight per repeat */
  if (!repeat) dispatch(a);
  return true;
}

/** Key released. OK fires its short action here (the long one fired already). */
export function remoteUp(key: string): boolean {
  if (!isOkKey(key)) return false;
  clearTimeout(okTimer);
  const a = ok.up(now());
  if (a) dispatch(a);
  return true;
}

/** Window lost focus mid-press: forget it, a missed keyup must not fire later */
export function remoteReset() {
  clearTimeout(okTimer);
  ok.reset();
}
