/* Заглушка Canvas 2D: даёт запустить генераторы текстур в Node и ловит
   опечатки, NaN в координатах и вызовы несуществующих методов. */
const grad = () => ({
  addColorStop(o, c) {
    if (typeof o !== 'number' || typeof c !== 'string') throw new Error('addColorStop: плохие аргументы');
  }
});
const ctx = () => {
  const o = { createRadialGradient: grad, createLinearGradient: grad };
  for (const k of ['fillStyle', 'strokeStyle', 'lineJoin', 'lineCap', 'filter', 'font']) o[k] = '';
  for (const k of ['lineWidth', 'globalAlpha']) o[k] = 1;
  for (const m of ['fillRect', 'strokeRect', 'clearRect', 'beginPath', 'closePath', 'moveTo', 'lineTo',
    'arc', 'ellipse', 'rect', 'fill', 'stroke', 'clip', 'save', 'restore',
    'translate', 'rotate', 'scale', 'quadraticCurveTo', 'bezierCurveTo', 'fillText']) {
    o[m] = (...a) => {
      for (const v of a) if (typeof v === 'number' && !Number.isFinite(v)) throw new Error(m + ': не число');
    };
  }
  return o;
};
globalThis.document = {
  createElement(tag) {
    if (tag !== 'canvas') throw new Error('ожидался canvas, получен ' + tag);
    return { width: 1, height: 1, nodeType: 1, getContext: ctx, toDataURL: () => 'data:,' };
  },
  getElementById: () => null,
  addEventListener() {}
};
globalThis.self = globalThis;
