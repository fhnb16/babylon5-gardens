/* Заглушка Canvas 2D: даёт запустить генераторы текстур в Node и ловит
   опечатки, NaN в координатах и вызовы несуществующих методов. */
const grad = () => ({
  addColorStop(o, c) {
    if (typeof o !== 'number' || typeof c !== 'string') throw new Error('addColorStop: плохие аргументы');
  }
});
/* Незакрытый save с обрезкой — тихая и очень дорогая ошибка: следующая
   обрезка пересекается с предыдущей, и всё нарисованное дальше пропадает.
   Считаем глубину стека и даём тесту её проверить. */
globalThis.__canvasStacks = [];

const ctx = () => {
  const o = {
    createRadialGradient: grad, createLinearGradient: grad, __depth: 0,
    /* пиксельные операции нужны генератору карт нормалей */
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData: () => {},
    drawImage: () => {}
  };
  globalThis.__canvasStacks.push(o);
  for (const k of ['fillStyle', 'strokeStyle', 'lineJoin', 'lineCap', 'filter', 'font']) o[k] = '';
  for (const k of ['lineWidth', 'globalAlpha']) o[k] = 1;
  for (const m of ['fillRect', 'strokeRect', 'clearRect', 'beginPath', 'closePath', 'moveTo', 'lineTo',
    'arc', 'ellipse', 'rect', 'fill', 'stroke', 'clip', 'save', 'restore',
    'translate', 'rotate', 'scale', 'quadraticCurveTo', 'bezierCurveTo', 'fillText', 'setLineDash']) {
    o[m] = (...a) => {
      for (const v of a) if (typeof v === 'number' && !Number.isFinite(v)) throw new Error(m + ': не число');
    };
  }
  const save = o.save, restore = o.restore;
  o.save = (...a) => { o.__depth++; return save(...a); };
  o.restore = (...a) => {
    if (--o.__depth < 0) throw new Error('restore без парного save');
    return restore(...a);
  };
  return o;
};
globalThis.document = {
  createElement(tag) {
    if (tag !== 'canvas') throw new Error('ожидался canvas, получен ' + tag);
    return { width: 1, height: 1, nodeType: 1, getContext: ctx, toDataURL: () => 'data:,' };
  },
  getElementById: () => null,
  querySelectorAll: () => [],
  addEventListener() {}
};
globalThis.self = globalThis;
/* controls.js определяет тип ввода при загрузке модуля */
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.innerWidth = 1280;
globalThis.innerHeight = 800;
globalThis.addEventListener = () => {};
