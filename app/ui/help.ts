import { $ } from '../dom.ts';
import { ACTION_LABELS, KEYBOARD_MAP, type Action } from '../input/actions.ts';

/** Подпись клавиши по KeyboardEvent.code */
const KEY_NAMES: Readonly<Record<string, string>> = {
  Escape: 'Esc', Comma: ',', Period: '.', Equal: '=', Minus: '−', Pause: 'Pause'
};
const keyName = (code: string) => KEY_NAMES[code] ?? code.replace(/^Key/, '');

/** Горячие клавиши в справке строятся из той же таблицы, по которой они
    работают, — расходиться им не с чего. */
export function initHelp() {
  const box = $('helpKeys') as HTMLElement | null;
  if (!box) return;
  if (window.GardensAndroid) {
    const p = document.createElement('p');
    p.textContent = 'Обновления APK доступны в настройках. На телевизоре долгое OK открывает меню с выбором системной заставки.';
    box.appendChild(p);
  }
  const byAction = new Map<Action, string[]>();
  for (const [code, a] of Object.entries(KEYBOARD_MAP)) {
    if (code.startsWith('Numpad')) continue;      // дубли плюса и минуса
    byAction.set(a, [...(byAction.get(a) || []), keyName(code)]);
  }
  for (const [a, keys] of byAction) {
    const p = document.createElement('p');
    for (const k of keys) {
      const kbd = document.createElement('kbd');
      kbd.textContent = k;
      p.appendChild(kbd);
    }
    p.append(` — ${ACTION_LABELS[a]}`);
    box.appendChild(p);
  }
}
