import { isOverlayOpen } from '../ui/tv-overlay.ts';
import { ctl, addLook } from '../../js/controls.js';
import { CONFIG } from '../cfg.ts';
import { GAMEPAD_MAP, deadZone } from './actions.ts';
import { remoteDown, remoteUp } from './remote.ts';

/* ═══════════════════════════════════════════════════════════════════════════
   ГЕЙМПАД (Gamepad API, стандартная раскладка)
   Кнопки ведут себя как пульт — они выдают те же клавиши и идут через тот
   же конвейер (remote.ts): крестовина листает точки и фазы, A — OK, B —
   назад, Start — меню. Стики — аналоговый ввод: левый двигает, правый
   поворачивает взгляд, курки — вверх/вниз к оси. Опрос раз в кадр из цикла.
   ═══════════════════════════════════════════════════════════════════════════ */
const pressed: boolean[] = [];
let analog = false;
const BUTTONS = Object.entries(GAMEPAD_MAP).map(([i, key]) => [+i, key] as const);

function firstPad(): Gamepad | null {
  for (const p of navigator.getGamepads()) if (p && p.connected) return p;
  return null;
}

function clearAnalog() {
  ctl.axis.x = ctl.axis.y = ctl.axis.z = 0;
  analog = false;
}

/** @param dt  шаг кадра, с: поворот стиком — с постоянной угловой скоростью */
export function pollGamepads(dt: number) {
  if (!navigator.getGamepads) return;
  const gp = firstPad();
  if (!gp) { if (analog) clearAnalog(); return; }

  for (const [i, key] of BUTTONS) {
    const now = !!gp.buttons[i]?.pressed;
    if (now === !!pressed[i]) continue;
    pressed[i] = now;
    if (now) remoteDown(key, false); else remoteUp(key);
  }

  if (!ctl.enabled || isOverlayOpen()) { if (analog) clearAnalog(); return; }
  const lx = deadZone(gp.axes[0] ?? 0), ly = deadZone(gp.axes[1] ?? 0);
  const rx = deadZone(gp.axes[2] ?? 0), ry = deadZone(gp.axes[3] ?? 0);
  const up = (gp.buttons[7]?.value ?? 0) - (gp.buttons[6]?.value ?? 0);
  ctl.axis.x = lx;
  ctl.axis.z = -ly;
  ctl.axis.y = Math.abs(up) > CONFIG.GAMEPAD.dead ? up : 0;
  analog = true;
  if (rx || ry) addLook(rx * CONFIG.GAMEPAD.lookRate * dt, ry * CONFIG.GAMEPAD.lookRate * dt, 1);
}
