import { $ } from '../dom.ts';

/* Нижние шторки: телепорты, настройки, справка. Открыта не больше одной. */
const sheets = { tp: $('tp'), set: $('set'), help: $('help') };
export type SheetId = keyof typeof sheets;

export const closeSheets = () => { for (const el of Object.values(sheets)) el.classList.remove('open'); };
export const toggleSheet = (k: SheetId) => {
  const open = sheets[k].classList.contains('open');
  closeSheets();
  if (!open) {
    sheets[k].classList.add('open');
    if (document.pointerLockElement) document.exitPointerLock();
  }
};
/** Открыть шторку, не закрывая её, если уже открыта */
export const openSheet = (k: SheetId) => { if (!sheets[k].classList.contains('open')) toggleSheet(k); };
export const anySheetOpen = () => Object.values(sheets).some(el => el.classList.contains('open'));
