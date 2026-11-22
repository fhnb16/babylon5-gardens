import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 400, height: 240 }, launchOptions: {
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist']
} });

test('WebGPU screen rays, diagnostics and guided cleanup render in the app', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  await page.addInitScript(() => localStorage.setItem('b5.prefs', JSON.stringify({ quality: 'LOW' })));
  await page.goto('/?mode=web&renderer=webgpu');
  await page.waitForFunction(() => window.__b5ready);
  await page.evaluate(() => { window.__b5!.dispatch('photo'); window.__b5!.dispatch('trace'); });
  await expect(page.locator('#bTrace')).toHaveClass(/on/);
  await expect(page.locator('#traceInfo')).toContainText(/накопление|готово/);
  await page.evaluate(() => { window.__b5!.dispatch('traceDebug'); window.__b5!.dispatch('denoisePause'); });
  await expect(page.locator('#bPause')).toHaveClass(/on/);
  await page.screenshot();
  await page.evaluate(() => window.__b5!.dispatch('exitPhoto'));
  await expect(page.locator('#bTrace')).not.toHaveClass(/on/);
  expect(errors).toEqual([]);
});
