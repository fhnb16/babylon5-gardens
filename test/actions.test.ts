import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  ACTIONS, ACTION_LABELS, KEYBOARD_MAP, REMOTE_MAP, GAMEPAD_MAP,
  keyToAction, normalizeKey, remoteAction, deadZone, createOkPress, type Action
} from '../app/input/actions.ts';
import { TV, parseTvMode, overlayKey, moveFocus, cycleValue } from '../app/tv-mode.ts';

/* Action layer and TV mode: the pure parts (no DOM). */

describe('keyboard → action (desktop)', () => {
  it('maps shortcuts by physical key code, layout-independent', () => {
    expect(keyToAction({ key: 't', code: 'KeyT' }, false)).toBe('toggleTour');
    expect(keyToAction({ key: 'е', code: 'KeyT' }, false)).toBe('toggleTour');   // Russian layout
    expect(keyToAction({ key: '.', code: 'Period' }, false)).toBe('nextView');
    expect(keyToAction({ key: ',', code: 'Comma' }, false)).toBe('prevView');
    expect(keyToAction({ key: 'Escape', code: 'Escape' }, false)).toBe('back');
    expect(keyToAction({ key: 'MediaPlayPause', code: 'MediaPlayPause' }, false)).toBe('togglePause');
    expect(keyToAction({ key: 'ContextMenu', code: 'ContextMenu' }, false)).toBe('openSettings');
  });

  it('leaves movement keys to the analog input', () => {
    for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyR', 'KeyF', 'ShiftLeft', 'Space',
      'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
      expect(keyToAction({ key: code, code }, false), code).toBeNull();
      expect(KEYBOARD_MAP[code], code).toBeUndefined();
    }
  });
});

describe('TV remote → action (docs/ROADMAP.md, Android TV)', () => {
  const tv = (key: string, code = key) => keyToAction({ key, code }, true);

  it('follows the roadmap layout', () => {
    expect(tv('ArrowLeft')).toBe('prevView');
    expect(tv('ArrowRight')).toBe('nextView');
    expect(tv('ArrowUp')).toBe('cyclePhase');
    expect(tv('ArrowDown')).toBe('prevPhase');
    expect(tv('Enter')).toBe('toggleTour');
    expect(tv('ContextMenu')).toBe('openSettings');
    expect(tv('Escape')).toBe('back');
    expect(tv('GoBack', '')).toBe('back');
    expect(tv('BrowserBack', '')).toBe('back');
    expect(tv('MediaPlayPause', '')).toBe('togglePause');
    expect(tv('ChannelUp', '')).toBe('nextView');
    expect(tv('ChannelDown', '')).toBe('prevView');
  });

  it('normalizes remote quirks', () => {
    expect(normalizeKey({ key: 'Unidentified', keyCode: 461 })).toBe('GoBack');      // webOS back
    expect(normalizeKey({ key: 'Unidentified', keyCode: 10009 })).toBe('GoBack');    // Tizen back
    expect(normalizeKey({ key: 'Unidentified', keyCode: 179 })).toBe('MediaPlayPause');
    expect(normalizeKey({ key: '', keyCode: 13 })).toBe('Enter');
    expect(normalizeKey({ key: 'Select' })).toBe('Enter');
    expect(normalizeKey({ key: 'NumpadEnter' })).toBe('Enter');
    expect(normalizeKey({ key: 'Esc' })).toBe('Escape');
    expect(tv('Unidentified', '')).toBeNull();
  });

  it('keeps desktop shortcuts usable on a TV with a keyboard', () => {
    expect(keyToAction({ key: 'm', code: 'KeyM' }, true)).toBe('toggleSound');
  });
});

describe('gamepad → remote keys', () => {
  it('uses the standard mapping: D-pad like the remote, A = OK, B = back, Start = menu', () => {
    expect(GAMEPAD_MAP[0]).toBe('Enter');
    expect(GAMEPAD_MAP[1]).toBe('Escape');
    expect(GAMEPAD_MAP[9]).toBe('ContextMenu');
    expect(remoteAction(GAMEPAD_MAP[12])).toBe('cyclePhase');
    expect(remoteAction(GAMEPAD_MAP[13])).toBe('prevPhase');
    expect(remoteAction(GAMEPAD_MAP[14])).toBe('prevView');
    expect(remoteAction(GAMEPAD_MAP[15])).toBe('nextView');
    expect(remoteAction(GAMEPAD_MAP[0])).toBe('toggleTour');
    expect(remoteAction(GAMEPAD_MAP[1])).toBe('back');
    expect(remoteAction(GAMEPAD_MAP[9])).toBe('openSettings');
  });

  it('every gamepad key reaches an action', () => {
    for (const key of Object.values(GAMEPAD_MAP)) expect(remoteAction(key), key).not.toBeNull();
  });

  it('stick dead zone removes drift and rescales the rest', () => {
    expect(deadZone(0.1)).toBe(0);
    expect(deadZone(-0.1)).toBe(0);
    expect(deadZone(1)).toBe(1);
    expect(deadZone(-1)).toBe(-1);
    expect(deadZone(0.59, 0.18)).toBeCloseTo(0.5, 5);
  });
});

describe('long press of OK', () => {
  it('short press toggles the tour on release', () => {
    const ok = createOkPress(600);
    ok.down(0);
    expect(ok.poll(300)).toBeNull();
    expect(ok.up(320)).toBe('toggleTour');
    expect(ok.held).toBe(false);
  });

  it('long press opens the menu once while held, release does nothing', () => {
    const ok = createOkPress(600);
    ok.down(0);
    ok.down(100);                              // auto-repeat: ignored
    expect(ok.poll(599)).toBeNull();
    expect(ok.poll(600)).toBe('openSettings');
    expect(ok.poll(900)).toBeNull();
    expect(ok.up(1200)).toBeNull();
  });

  it('a late release without a poll still counts as long', () => {
    const ok = createOkPress(600);
    ok.down(0);
    expect(ok.up(700)).toBe('openSettings');
    expect(ok.up(800)).toBeNull();             // no press in flight
  });
});

describe('TV mode flag', () => {
  it('?mode=tv turns it on, another mode turns it off, otherwise the pref decides', () => {
    expect(parseTvMode('?mode=tv', false)).toBe(true);
    expect(parseTvMode('?x=1&mode=TV', false)).toBe(true);
    expect(parseTvMode('?mode=web', true)).toBe(false);
    expect(parseTvMode('', true)).toBe(true);
    expect(parseTvMode('', undefined)).toBe(false);
    expect(parseTvMode('?seed=4', false)).toBe(false);
  });
});

describe('TV overlay navigation', () => {
  it('maps remote keys onto overlay moves', () => {
    expect(overlayKey('ArrowUp')).toBe('up');
    expect(overlayKey('ArrowDown')).toBe('down');
    expect(overlayKey('ArrowLeft')).toBe('left');
    expect(overlayKey('ArrowRight')).toBe('right');
    expect(overlayKey('Enter')).toBe('ok');
    for (const k of ['Escape', 'GoBack', 'BrowserBack', 'Backspace', 'ContextMenu']) {
      expect(overlayKey(k), k).toBe('close');
    }
    expect(overlayKey('MediaPlayPause')).toBeNull();
  });

  it('focus moves with wrap-around', () => {
    expect(moveFocus(0, 7, 1)).toBe(1);
    expect(moveFocus(6, 7, 1)).toBe(0);
    expect(moveFocus(0, 7, -1)).toBe(6);
    expect(moveFocus(-1, 7, 1)).toBe(0);
    expect(moveFocus(-1, 7, -1)).toBe(6);
    expect(moveFocus(0, 0, 1)).toBe(-1);
  });

  it('values cycle both ways', () => {
    const q = ['AUTO', 'LOW', 'HIGH'];
    expect(cycleValue(q, 'AUTO', 1)).toBe('LOW');
    expect(cycleValue(q, 'HIGH', 1)).toBe('AUTO');
    expect(cycleValue(q, 'AUTO', -1)).toBe('HIGH');
    expect(cycleValue(q, 'nope', 1)).toBe('AUTO');
    expect(cycleValue(TV.tourHolds, 6.5, 1)).toBe(10);
  });

  it('auto-hides after 8 s of idle', () => {
    expect(TV.overlayIdleMs).toBe(8000);
  });
});

describe('action table', () => {
  it('every action has a label and a handler in app/commands.ts', () => {
    const src = readFileSync(new URL('../app/commands.ts', import.meta.url), 'utf8');
    for (const a of ACTIONS) {
      expect(ACTION_LABELS[a], a).toBeTruthy();
      expect(src.includes(`onAction('${a}'`), `handler for ${a}`).toBe(true);
    }
  });

  it('keeps native maintenance commands accessible from the Android TV menu', () => {
    const menu = readFileSync(new URL('../app/ui/tv-overlay.ts', import.meta.url), 'utf8');
    for (const action of ['checkUpdates', 'dreamSettings'] as const) {
      expect(ACTIONS).toContain(action);
      expect(menu).toContain(`dispatch('${action}')`);
    }
  });

  it('maps only known actions', () => {
    const known = new Set<Action>(ACTIONS);
    for (const a of [...Object.values(KEYBOARD_MAP), ...Object.values(REMOTE_MAP)]) {
      expect(known.has(a), a).toBe(true);
    }
  });
});
