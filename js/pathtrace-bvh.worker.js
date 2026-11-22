/* ═══════════════════════════════════════════════════════════════════════════
   ПОТОК ПОСТРОЙКИ ДЕРЕВА ОБХОДА

   Отдельный модуль, а не строка: сборщик (Vite) видит его по шаблону
   `new Worker(new URL('./pathtrace-bvh.worker.js', import.meta.url))`
   в pathtrace.js и сам разрешает 'three' и 'three-mesh-bvh' из node_modules —
   те же версии, что у страницы. Протокол сообщений:
     вход  { position, index, options, progress }
     выход { progress } × N, затем { ok: true, packed, position } | { ok: false, error }
   Позиции возвращаются обратно: они пришли сюда переносом, без копии, и у
   страницы на их месте остался пустой буфер — без возврата геометрия сцены
   после сборки была бы испорчена.
   ═══════════════════════════════════════════════════════════════════════════ */
import { BufferGeometry, BufferAttribute } from 'three';
import { MeshBVH, SAH } from 'three-mesh-bvh';

self.onmessage = e => {
  const { position, index, options, progress } = e.data;
  try {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(position, 3));
    if (index) geo.setIndex(new BufferAttribute(index, 1));
    /* maxLeafTris в three-mesh-bvh 0.9.x устарел (предупреждение в консоль):
       библиотека трассировки всё ещё шлёт его — переводим в targetLeafSize. */
    const opts = { ...(options || {}) };
    if (opts.maxLeafTris !== undefined) {
      if (opts.targetLeafSize === undefined) opts.targetLeafSize = opts.maxLeafTris;
      delete opts.maxLeafTris;
    }
    /* Доля готовности — сообщениями, не чаще раза на процент */
    let last = -1;
    if (progress) {
      opts.onProgress = v => {
        const p = Math.floor(v * 100);
        if (p !== last) { last = p; self.postMessage({ progress: v }); }
      };
    }
    /* SAH — разбиение по площади поверхности: дерево строится дольше, но
       обходится заметно быстрее, а строим мы его один раз за съёмку. */
    const bvh = new MeshBVH(geo, { ...opts, strategy: SAH });
    const packed = MeshBVH.serialize(bvh, { cloneBuffers: false });
    const move = [...new Set([
      position.buffer,
      ...(packed.index ? [packed.index.buffer] : []),
      ...(packed.indirectBuffer ? [packed.indirectBuffer.buffer] : []),
      ...packed.roots
    ])];
    self.postMessage({ ok: true, packed, position }, move);
  } catch (err) {
    self.postMessage({ ok: false, error: String((err && err.message) || err) });
  }
};
