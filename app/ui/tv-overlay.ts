import { CONFIG } from '../cfg.ts';
import { $ } from '../dom.ts';
import { app } from '../state.ts';
import { prefs } from '../prefs.ts';
import { phaseIndex } from '../palette.ts';
import { PHASE_NAMES } from './hud.ts';
import { overlayKey, moveFocus, cycleValue } from '../tv-mode.ts';
import { dispatch } from '../input/actions.ts';
import { audio } from '../../js/audio.js';

/* ═══════════════════════════════════════════════════════════════════════════
   ЭКРАННОЕ МЕНЮ ТВ-РЕЖИМА

   Крупные пункты для 10-футового интерфейса, целиком на D-pad:
   ↑ ↓ — выбор пункта, OK и → — следующее значение, ← — предыдущее,
   Назад / Меню — закрыть. Через 8 с без нажатий меню закрывается само.
   Открывается только действием openSettings (Меню, долгое OK, Start).

   Значения меняются теми же путями, что и в обычном интерфейсе: сезон и
   качество — через их же <select> в шторке настроек, зерно — её кнопкой,
   фаза и звук — действиями. Отдельной логики настроек здесь нет.
   ═══════════════════════════════════════════════════════════════════════════ */
interface Item {
  label: string;
  value(): string;
  change(d: number): void;
}

/** Следующий вариант <select> из шторки настроек, применённый её обработчиком */
function stepSelect(id: string, d: number) {
  const sel = $(id) as HTMLSelectElement;
  const values = [...sel.options].map(o => o.value);
  sel.value = cycleValue(values, sel.value, d);
  sel.dispatchEvent(new Event('change'));
}
const selectText = (id: string) => {
  const sel = $(id) as HTMLSelectElement;
  return sel.options[sel.selectedIndex]?.textContent ?? '';
};
const onOff = (on: boolean) => on ? 'ВКЛ' : 'ВЫКЛ';

const ITEMS: Item[] = [
  { label: 'Фаза освещения', value: () => PHASE_NAMES[phaseIndex()],
    change: d => dispatch(d < 0 ? 'prevPhase' : 'cyclePhase') },
  { label: 'Авто-цикл освещения', value: () => onOff(app.autoCycle),
    change: () => dispatch('toggleAutoCycle') },
  { label: 'Скорость тура', value: () => `${app.tourHold} с на точку`,
    change: d => {
      app.tourHold = cycleValue(CONFIG.TV.tourHolds, app.tourHold, d);
      prefs.set('tvHold', app.tourHold);
    } },
  { label: 'Звук', value: () => onOff(audio.on), change: () => dispatch('toggleSound') },
  { label: 'Сезон', value: () => selectText('sSeason'), change: d => stepSelect('sSeason', d) },
  { label: 'Качество', value: () => selectText('sQual'), change: d => stepSelect('sQual', d) },
  { label: 'Новое зерно мира', value: () => String(CONFIG.SEED),
    change: () => $('sSeedRnd').click() }
];

let root: HTMLElement | null = null;
let buttons: HTMLButtonElement[] = [];
let focusIdx = 0;
let idleTimer = 0;

export function initTvOverlay() {
  root = $('tvMenu');
  const list = $('tvMenuList') as HTMLElement | null;
  if (!root || !list) return;
  if (window.GardensAndroid && new URLSearchParams(location.search).get('host') !== 'dream') {
    ITEMS.push({ label: 'Проверить обновления', value: () => '', change: () => dispatch('checkUpdates') },
      { label: 'Выбрать заставку Android TV', value: () => '', change: () => dispatch('dreamSettings') });
  }
  buttons = ITEMS.map((it, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tvi';
    b.setAttribute('role', 'menuitem');
    b.tabIndex = -1;
    b.innerHTML = '<span></span><b></b>';
    (b.firstElementChild as HTMLElement).textContent = it.label;
    /* мышью тоже можно; клик с клавиатуры (detail 0) уже обработан по keydown */
    b.addEventListener('click', e => {
      if (e.detail === 0) return;
      setFocus(i); change(+1);
    });
    list.appendChild(b);
    return b;
  });
  root.addEventListener('pointermove', armIdle);
}

export const isOverlayOpen = () => !!root && !root.hidden;

export function openOverlay() {
  if (!root) return;
  root.hidden = false;
  root.classList.add('open');
  if (document.pointerLockElement) document.exitPointerLock();
  paint();
  setFocus(0);
  armIdle();
}

export function closeOverlay() {
  if (!root) return;
  clearTimeout(idleTimer);
  root.classList.remove('open');
  root.hidden = true;
  (document.activeElement as HTMLElement | null)?.blur?.();
}

/** Клавиша пульта при открытом меню. false — не наша, пусть идёт дальше. */
export function overlayKeyDown(key: string): boolean {
  const k = overlayKey(key);
  if (!k) return false;
  armIdle();
  if (k === 'close') closeOverlay();
  else if (k === 'up' || k === 'down') setFocus(moveFocus(focusIdx, buttons.length, k === 'up' ? -1 : 1));
  else change(k === 'left' ? -1 : 1);
  return true;
}

function setFocus(i: number) {
  focusIdx = i;
  buttons.forEach((b, j) => { b.tabIndex = j === i ? 0 : -1; });
  buttons[i]?.focus();
}

function change(d: number) {
  ITEMS[focusIdx].change(d);
  paint();
  const st = $('tvMenuStatus');
  if (st) st.textContent = `${ITEMS[focusIdx].label}: ${ITEMS[focusIdx].value()}`;
}

/** Подписи значений: часть меняется не отсюда (фаза — авто-циклом) */
function paint() {
  buttons.forEach((b, i) => { (b.lastElementChild as HTMLElement).textContent = ITEMS[i].value(); });
}

function armIdle() {
  clearTimeout(idleTimer);
  idleTimer = window.setTimeout(closeOverlay, CONFIG.TV.overlayIdleMs);
}
