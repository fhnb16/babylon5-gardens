import { VERSION } from './js/version.js';

/* Список и отпечаток файлов Vite подставляет после сборки всех чанков. */
/* global __PWA_FILES__, __PWA_REVISION__ */
const scope = self.registration.scope;
const prefix = 'b5-offline:' + scope + '|';
const cacheName = prefix + VERSION + '-' + __PWA_REVISION__;
const entry = new URL('index.html', scope).href;
const files = new Map(__PWA_FILES__.map(([path, integrity]) => [new URL(path, scope).href, integrity]));

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    // addAll атомарен: неполная загрузка не заменит работающую версию.
    await cache.addAll(Array.from(files, ([url, integrity]) => new Request(url, { integrity, cache: 'reload' })));
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith(prefix) && key !== cacheName) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data === 'offline-status') event.ports[0]?.postMessage('ready');
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  url.search = '';
  const key = event.request.mode === 'navigate' && url.href === scope ? entry : url.href;
  if (files.has(key)) event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    return await cache.match(key) ?? fetch(event.request);
  })());
});

