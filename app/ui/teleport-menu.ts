import { CONFIG } from '../cfg.ts';
import { $ } from '../dom.ts';
import { dispatch } from '../input/actions.ts';

/** Список точек обзора в шторке «Куда лететь»: клик — действие goToView */
export function initTeleportMenu() {
  const list = $('tpList');
  CONFIG.TP.forEach((tp: { ico: string; name: string; hint: string }, i: number) => {
    const d = document.createElement('div');
    d.className = 'tp';
    d.innerHTML = `<i>${tp.ico}</i><div><b>${tp.name}</b><s>${tp.hint}</s></div>`;
    d.addEventListener('click', () => dispatch('goToView', i));
    list.appendChild(d);
  });
}
