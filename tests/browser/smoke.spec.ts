import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

/* Дымовой тест приложения в настоящем браузере (Edge, WebGL2 через ANGLE).
   Проверяет то, чего не видит test.mjs в Node: шейдеры компилируются,
   кадр не пустой, сервис-воркер регистрируется, телепорт и смена фазы
   освещения не роняют страницу. Снимки — в test-results/. */

const SHOTS = 'test-results';

/** Сбор ошибок страницы: console.error и необработанные исключения */
function watchErrors(page: Page) {
  const errors: string[] = [];
  const warnings: string[] = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    else if (msg.type() === 'warning') warnings.push(msg.text());
  });
  page.on('pageerror', err => errors.push(`pageerror: ${err.message}`));
  return { errors, warnings };
}

/** Разброс яркости снимка: пустой (однотонный) кадр даёт около нуля.
    PNG декодируется в самой странице — без лишних зависимостей. */
async function screenshotStats(page: Page, path: string) {
  const png = await page.screenshot({ path });
  return page.evaluate(async b64 => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0, sum = 0, sum2 = 0;
    const seen = new Set<number>();
    /* каждый 7-й пиксель: хватает для статистики */
    for (let i = 0; i < d.length; i += 4 * 7) {
      const y = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      sum += y; sum2 += y * y; n++;
      seen.add((d[i] >> 3) << 10 | (d[i + 1] >> 3) << 5 | (d[i + 2] >> 3));
    }
    const mean = sum / n;
    return { mean, std: Math.sqrt(Math.max(0, sum2 / n - mean * mean)), colors: seen.size };
  }, png.toString('base64'));
}

/** Дождаться N кадров браузера */
const frames = (page: Page, n: number) => page.evaluate(k => new Promise<void>(res => {
  let i = 0;
  const step = () => (++i >= k ? res() : requestAnimationFrame(step));
  requestAnimationFrame(step);
}), n);

test('приложение запускается, рисует кадр и переживает телепорт и смену фазы', async ({ page }) => {
  mkdirSync(SHOTS, { recursive: true });
  const { errors, warnings } = watchErrors(page);

  await page.goto('./');

  /* WebGL на настоящей видеокарте, а не программный */
  const gpu = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return 'no webgl2';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  });
  console.log('[smoke] WebGL:', gpu);
  expect(gpu).not.toBe('no webgl2');

  /* Сигнал готовности ставит main.js после первого отрисованного кадра */
  await page.waitForFunction(() => (window as unknown as { __b5ready?: boolean }).__b5ready === true,
    null, { timeout: 90_000 });
  await frames(page, 30);
  await expect(page.locator('#fatal')).not.toHaveClass(/show/);

  /* Сервис-воркер: регистрируется по событию load */
  const sw = await page.evaluate(async () => {
    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<null>(r => setTimeout(() => r(null), 20_000))
    ]);
    return reg ? (reg.active?.scriptURL ?? 'registered') : null;
  });
  console.log('[smoke] service worker:', sw);
  expect(sw).toBeTruthy();

  /* Заставка уходит по кнопке «Начать» */
  await page.click('#go');
  await expect(page.locator('#intro')).toBeHidden({ timeout: 5_000 });
  await frames(page, 20);

  const s0 = await screenshotStats(page, `${SHOTS}/smoke-01-start.png`);
  console.log('[smoke] start frame', s0);
  expect(s0.std, 'кадр не однотонный').toBeGreaterThan(8);
  expect(s0.colors, 'в кадре много цветов').toBeGreaterThan(64);

  /* Указатель захватывается по «Начать»; отпускаем, чтобы клики шли в
     интерфейс (Escape под автоматизацией захват не снимает) */
  await page.evaluate(() => document.exitPointerLock());
  await page.waitForFunction(() => document.pointerLockElement === null);

  /* Телепорт: вторая точка списка */
  await page.click('#bTp');
  const tp = page.locator('#tpList .tp');
  await expect(tp.first()).toBeVisible();
  expect(await tp.count()).toBeGreaterThan(1);
  /* Без прокрутки к элементу: настоящий клик Playwright прокручивал документ,
     и в кадр въезжала спрятанная под краем шторка справки */
  await tp.nth(1).dispatchEvent('click');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(3_000);
  await frames(page, 20);
  const s1 = await screenshotStats(page, `${SHOTS}/smoke-02-teleport.png`);
  console.log('[smoke] after teleport', s1);
  expect(s1.std).toBeGreaterThan(8);

  /* Смена фазы освещения: день → закат → ночь, переход плавный */
  for (const [k, name] of [[1, 'sunset'], [2, 'night']] as const) {
    await page.click('#bDay');
    await page.waitForTimeout(4_000);
    await frames(page, 10);
    const s = await screenshotStats(page, `${SHOTS}/smoke-0${2 + k}-${name}.png`);
    console.log(`[smoke] ${name}`, s);
    expect(s.std).toBeGreaterThan(4);
  }

  await expect(page.locator('#fatal')).not.toHaveClass(/show/);
  if (warnings.length) console.log('[smoke] warnings:\n  ' + [...new Set(warnings)].join('\n  '));
  expect(errors, errors.join('\n')).toEqual([]);
});

/* ТВ-режим (?mode=tv): ни одного элемента интерфейса, пульт листает точки
   обзора, меню открывается кнопкой «Меню», ходит по D-pad и закрывается
   «Назад». Состояние видно через отладочный вход window.__b5. */
type B5State = { tv: boolean; flying: boolean; flights: number; view: number; tour: boolean;
  autoCycle: boolean; overlay: boolean };
const b5 = (page: Page) => page.evaluate(() =>
  (window as unknown as { __b5: { state: () => unknown } }).__b5.state() as B5State);

test('ТВ-режим: без интерфейса, управление с пульта', async ({ page }) => {
  mkdirSync(SHOTS, { recursive: true });
  const { errors, warnings } = watchErrors(page);

  await page.goto('./?mode=tv');
  await page.waitForFunction(() => (window as unknown as { __b5ready?: boolean }).__b5ready === true,
    null, { timeout: 90_000 });
  await frames(page, 20);
  await expect(page.locator('#fatal')).not.toHaveClass(/show/);

  const s0 = await b5(page);
  console.log('[smoke:tv] start', s0);
  expect(s0.tv).toBe(true);
  expect(s0.tour, 'авто-тур включён сразу').toBe(true);
  expect(s0.autoCycle, 'авто-цикл освещения включён').toBe(true);

  /* Ни одного видимого элемента, кроме самой сцены */
  const visible = await page.evaluate(() => [...document.body.querySelectorAll('*')]
    .filter(e => !e.closest('#stage') && e.checkVisibility())
    .map(e => e.id ? '#' + e.id : e.tagName.toLowerCase() + '.' + e.className));
  expect(visible, `видимые элементы: ${visible.join(', ')}`).toEqual([]);
  for (const sel of ['#hud', '#topbar', '#bSet', '#intro', '#set', '#tp', '#help', '#pad', '#caption', '#tvMenu']) {
    await expect(page.locator(sel), sel).toBeHidden();
  }
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('canvas')!).cursor)).toBe('none');
  const shot = await screenshotStats(page, `${SHOTS}/smoke-07-tv.png`);
  console.log('[smoke:tv] frame', shot);
  expect(shot.std).toBeGreaterThan(8);

  /* → — перелёт к следующей точке */
  await page.keyboard.press('ArrowRight');
  await frames(page, 2);
  const s1 = await b5(page);
  console.log('[smoke:tv] after ArrowRight', s1);
  expect(s1.flights).toBe(s0.flights + 1);
  expect(s1.flying).toBe(true);
  expect(s1.view).not.toBe(s0.view);
  expect(s1.tour, 'тур продолжается с новой точки').toBe(true);
  expect(await page.evaluate(() => document.pointerLockElement)).toBeNull();

  /* Меню — экранное меню, фокус на первом пункте */
  await page.keyboard.press('ContextMenu');
  const menu = page.locator('#tvMenu');
  await expect(menu).toBeVisible();
  expect(await page.evaluate(() => !!document.activeElement?.closest('#tvMenu'))).toBe(true);
  expect((await b5(page)).overlay).toBe(true);
  await page.screenshot({ path: `${SHOTS}/smoke-08-tv-menu.png` });

  /* ↓ — второй пункт (авто-цикл), OK — значение меняется */
  await page.keyboard.press('ArrowDown');
  const focused = page.locator('#tvMenu .tvi:focus');
  await expect(focused).toHaveCount(1);
  const before = await focused.locator('b').innerText();
  await page.keyboard.press('Enter');
  const after = await focused.locator('b').innerText();
  console.log(`[smoke:tv] menu item: ${before} → ${after}`);
  expect(after).not.toBe(before);
  expect((await b5(page)).autoCycle).toBe(false);

  /* Назад — меню закрыто */
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  expect((await b5(page)).overlay).toBe(false);

  if (warnings.length) console.log('[smoke:tv] warnings:\n  ' + [...new Set(warnings)].join('\n  '));
  expect(errors, errors.join('\n')).toEqual([]);
});

/* Пути, которые затронуло обновление three: SMAA (конструктор SMAAPass
   изменился в r175) и трассировка пути (three-gpu-pathtracer 0.0.28,
   дерево обхода в отдельном потоке). */
test('SMAA и трассировка пути работают на r187', async ({ page }) => {
  test.setTimeout(240_000);
  mkdirSync(SHOTS, { recursive: true });
  const { errors, warnings } = watchErrors(page);

  // This scenario exercises the classic path still used on WebGL-only systems.
  await page.addInitScript(() => Object.defineProperty(navigator, 'gpu', { value: undefined }));
  await page.goto('./');
  await page.waitForFunction(() => (window as unknown as { __b5ready?: boolean }).__b5ready === true,
    null, { timeout: 90_000 });
  await page.click('#go');
  await page.evaluate(() => document.exitPointerLock());
  await expect(page.locator('#intro')).toBeHidden({ timeout: 5_000 });

  /* SMAA + FXAA поверх TAA: все три прохода фильтра */
  await page.evaluate(() => {
    const s = document.getElementById('sFilter') as HTMLSelectElement;
    s.value = 'taasmaafxaa';
    s.dispatchEvent(new Event('change'));
  });
  await frames(page, 30);
  const sm = await screenshotStats(page, `${SHOTS}/smoke-05-smaa.png`);
  console.log('[smoke] smaa', sm);
  expect(sm.std).toBeGreaterThan(8);

  /* Фото-режим → трассировка пути. Ждём, пока наберутся выборки. */
  await page.click('#bPhoto');
  await page.locator('#bPath').dispatchEvent('click');
  const traceInfo = page.locator('#traceInfo');
  await expect(traceInfo).toContainText(/выборок [1-9]/, { timeout: 180_000 });
  await page.waitForTimeout(3_000);
  const info = (await traceInfo.innerText()).replace(/\s*\n\s*/g, ' | ');
  console.log('[smoke] path tracer:', info);
  /* дерево обхода собрано в отдельном потоке, без отката в главный */
  expect(info).toMatch(/в потоке/);
  const pp = await screenshotStats(page, `${SHOTS}/smoke-06-pathtrace.png`);
  console.log('[smoke] path traced', pp);
  expect(pp.std).toBeGreaterThan(4);
  expect(info).not.toMatch(/недоступен/);

  if (warnings.length) console.log('[smoke] warnings:\n  ' + [...new Set(warnings)].join('\n  '));
  expect(errors, errors.join('\n')).toEqual([]);
});
