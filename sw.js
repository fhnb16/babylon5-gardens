/* Service worker существует ровно затем, чтобы браузер счёл приложение
   устанавливаемым: Chrome требует зарегистрированный worker с обработчиком
   fetch. Кеша здесь нет и не должно быть — каждый запрос уходит в сеть,
   как и задумано. Ничего не перехватываем: без respondWith браузер сам
   выполняет запрос обычным путём. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* сквозной проход, без кеша */ });
