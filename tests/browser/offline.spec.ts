import { expect, test } from '@playwright/test';

test('reopens the installed app entry offline with its optional photo assets', async ({ page, context, baseURL }) => {
  await page.goto('./');
  await expect(page.locator('#offlineStatus')).toHaveText('Готово к работе офлайн');
  await page.close();
  await context.setOffline(true);
  const reopened = await context.newPage();
  const manifest = await reopened.goto(new URL('manifest.webmanifest', baseURL).href);
  const { start_url } = await manifest!.json();
  await reopened.goto(new URL(start_url + '?mode=tv', baseURL).href);
  await reopened.waitForFunction(() => window.__b5ready === true);
  expect(await reopened.evaluate(async () => {
    const response = await fetch('oidn/rt_hdr_alb_nrm.tza');
    return response.ok && (await response.arrayBuffer()).byteLength > 0;
  })).toBe(true);
});

