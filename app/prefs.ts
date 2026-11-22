import { CONFIG } from './cfg.ts';

/* Настройки переживают перезагрузку одним объектом. localStorage может быть
   недоступен (приватный режим, отключённые куки) — тогда просто работаем без
   него: всё в try/catch, ни один вызов не обязан удаться. */
const PREFS_KEY = 'b5.prefs';
export const prefs = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  d: {} as Record<string, any>,
  load() {
    try { this.d = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null') || {}; } catch { this.d = {}; }
    return this;
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get(k: string, dflt?: any) { const v = this.d[k]; return v === undefined ? dflt : v; },
  set(k: string, v: unknown) {
    this.d[k] = v;
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(this.d)); } catch { /* без сохранения */ }
  },
  drop(k: string) {
    delete this.d[k];
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(this.d)); } catch { /* без сохранения */ }
  }
}.load();

/** Сохранённые параметры мира — до первой постройки: зерно, сезон,
    насыщенность, густота зелени и пресет качества. Раньше качество и
    зелень читались только в initSettings, уже после первой сборки, и мир
    при запуске строился с заводскими значениями. */
export function applyStoredWorld(target: { quality: string }) {
  CONFIG.SEED = prefs.get('seed', CONFIG.SEED_DEFAULT) >>> 0;
  CONFIG.SEASON = prefs.get('season', CONFIG.SEASON);
  CONFIG.SATURATION = prefs.get('sat', CONFIG.SATURATION * 100) / 100;
  const g = CONFIG.GREEN[+prefs.get('green', 2)];
  if (typeof g === 'number') CONFIG.GREEN_K = g;
  target.quality = prefs.get('quality', 'AUTO');
}
