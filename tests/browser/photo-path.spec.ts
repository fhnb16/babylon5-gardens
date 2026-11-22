import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

for (const renderer of ['webgpu', 'classic', 'webgl2']) {
  test(`photo mode on ${renderer} presents and saves the cleaned path-traced frame`, async ({ page }) => {
    test.setTimeout(240_000);
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    await page.setViewportSize({ width: 480, height: 320 });
    await page.addInitScript(mode => {
      localStorage.setItem('b5.prefs', JSON.stringify({
        quality: 'LOW', ptScale: 0.5, pathClean: mode === 'webgpu' ? 'oidn' : 'atrous'
      }));
    }, renderer);
    await page.goto(`./?renderer=${renderer}`);
    await page.waitForFunction(() => window.__b5ready);
    await page.evaluate(() => {
      window.__b5!.dispatch('photo');
      window.__b5!.dispatch('pathTrace');
    });
    const report = page.locator('#traceInfo');
    await expect(report).toContainText(/выборок [1-9]/, { timeout: 150_000 });
    await expect(page.locator('.b5-pt-overlay')).toHaveCount(renderer === 'webgpu' ? 0 : 1);
    await page.evaluate(() => window.__b5!.dispatch('denoisePause'));
    await expect(report).toContainText(renderer === 'webgpu' ? 'Open Image Denoise' : 'à-trous',
      { timeout: 75_000 });

    const pending = page.waitForEvent('download');
    await page.evaluate(() => window.__b5!.dispatch('shot'));
    const blob = await pending;
    const bytes = await readFile((await blob.path())!);
    const image = await page.evaluate(async b64 => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const rgb = ctx.getImageData(0, 0, c.width, c.height).data;
      let min = 255, max = 0;
      for (let i = 0; i < rgb.length; i += 4) { min = Math.min(min, rgb[i]); max = Math.max(max, rgb[i]); }
      return { w: c.width, h: c.height, range: max - min };
    }, bytes.toString('base64'));
    const dimensions = await page.locator('#stage canvas').first().evaluate(c => {
      const canvas = c as HTMLCanvasElement;
      return { w: canvas.width, h: canvas.height };
    });
    expect(image).toMatchObject(dimensions);
    expect(image.range).toBeGreaterThan(16);
    await page.evaluate(() => window.__b5!.dispatch('exitPhoto'));
    await expect(page.locator('.b5-pt-overlay')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
