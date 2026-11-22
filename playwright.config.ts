import { defineConfig } from '@playwright/test';

/* Браузерный дымовой тест: собранный сайт (vite build) через vite preview,
   системный Microsoft Edge (браузеры Playwright не скачиваются). WebGL в
   безголовом режиме идёт через ANGLE/D3D11 на настоящей видеокарте. */
const PORT = 4173;

export default defineConfig({
  testDir: 'tests/browser',
  outputDir: 'test-results/browser',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}/`,
    channel: 'msedge',
    headless: true,
    viewport: { width: 1280, height: 720 },
    serviceWorkers: 'allow',
    launchOptions: {
      args: [
        '--use-angle=d3d11',
        '--enable-gpu',
        '--ignore-gpu-blocklist'
      ]
    }
  },
  webServer: {
    command: `npm run build && npx vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}/`,
    /* несколько агентов/прогонов подряд: занятый порт с уже собранным сайтом не ошибка */
    reuseExistingServer: true,
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe'
  }
});
