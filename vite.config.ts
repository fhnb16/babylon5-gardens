import { defineConfig, build, type Plugin, type ResolvedConfig } from 'vite';
import { cpSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/* ═══════════════════════════════════════════════════════════════════════════
   PWA-файлы в корне сборки

   sw.js, manifest.webmanifest и icons/ остаются в КОРНЕ репозитория (тесты
   test.mjs читают их оттуда, а единый источник версии — js/version.js).

   • sw.js собирается ОТДЕЛЬНОЙ сборкой в dist/sw.js: самодостаточный модуль
     со вшитой версией. Общий чанк с приложением недопустим — иначе воркер
     мог бы потянуть код страницы. Смена версии меняет байты sw.js, и браузер
     обновляет воркер сам. Регистрация в app/main.ts относительная ('sw.js'),
     поэтому работает и под подкаталогом (base './', GitHub Pages).
   • manifest.webmanifest и icons/ копируются как есть: ссылки внутри
     манифеста относительные и без хешей, переписывать их нечем. Поэтому их
     <link> в index.html помечаются vite-ignore (до разбора разметки Vite):
     иначе Vite унёс бы манифест в assets/ с хешем, и его ссылки на иконки
     сломались бы.
   ═══════════════════════════════════════════════════════════════════════════ */
const PWA_LINK_RE = /<link\b(?=[^>]*\brel="(?:manifest|icon|apple-touch-icon)")(?![^>]*\bvite-ignore\b)/g;

function pwaFiles(): Plugin {
  let cfg: ResolvedConfig;
  return {
    name: 'b5-pwa-files',
    apply: 'build',
    configResolved(c) { cfg = c; },
    transformIndexHtml: {
      order: 'pre',
      handler: html => html.replace(PWA_LINK_RE, '<link vite-ignore')
    },
    async closeBundle() {
      const root = cfg.root;
      const outDir = resolve(root, cfg.build.outDir);
      cpSync(resolve(root, 'manifest.webmanifest'), resolve(outDir, 'manifest.webmanifest'));
      if (existsSync(resolve(root, 'icons'))) {
        cpSync(resolve(root, 'icons'), resolve(outDir, 'icons'), { recursive: true });
      }
      await build({
        configFile: false,
        root,
        logLevel: 'warn',
        publicDir: false,
        build: {
          outDir,
          emptyOutDir: false,
          copyPublicDir: false,
          target: 'es2022',
          minify: cfg.build.minify,
          sourcemap: false,
          lib: {
            entry: resolve(root, 'sw.js'),
            formats: ['es'],
            fileName: () => 'sw.js'
          }
        }
      });
    }
  };
}

export default defineConfig({
  base: './',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    target: 'es2022',
    emptyOutDir: true,
    /* three сам по себе ~550 КБ — предупреждение о «большом чанке» тут шум */
    chunkSizeWarningLimit: 1024
  },
  worker: {
    format: 'es'
  },
  plugins: [pwaFiles()]
});
