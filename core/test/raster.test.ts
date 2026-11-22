import { test, expect } from 'vitest';
import { createCanvas, parseColor, resamplePixelImage, createPixelImage } from '../raster/index.ts';
import type { Context2D, RasterCanvas } from '../raster/index.ts';

const px = (c: RasterCanvas, x: number, y: number): number[] => {
  const i = (y * c.width + x) * 4, d = c.image.data;
  return [d[i], d[i + 1], d[i + 2], d[i + 3]];
};
const alpha = (c: RasterCanvas, x: number, y: number): number => px(c, x, y)[3];
const make = (w: number, h: number): [RasterCanvas, Context2D] => {
  const c = createCanvas(w, h);
  return [c, c.getContext('2d')];
};

test('colour parsing', () => {
  expect(parseColor('#abc')).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc, a: 1 });
  expect(parseColor('#54703c')).toEqual({ r: 0x54, g: 0x70, b: 0x3c, a: 1 });
  expect(parseColor('#00000080')!.a).toBeCloseTo(128 / 255, 6);
  expect(parseColor('rgb(1,2,3)')).toEqual({ r: 1, g: 2, b: 3, a: 1 });
  expect(parseColor('rgba(255,255,255,.22)')!.a).toBeCloseTo(Math.round(0.22 * 255) / 255, 6);
  expect(parseColor(' RGBA(14, 19, 26, 0.620) ')).toMatchObject({ r: 14, g: 19, b: 26 });
  expect(parseColor('rgb(10 20 30 / 50%)')).toMatchObject({ r: 10, g: 20, b: 30 });
  expect(parseColor('hsl(120, 100%, 50%)')).toEqual({ r: 0, g: 255, b: 0, a: 1 });
  expect(parseColor('transparent')!.a).toBe(0);
  expect(parseColor('black')).toEqual({ r: 0, g: 0, b: 0, a: 1 });
  expect(parseColor('#12')).toBeNull();
  expect(parseColor('rgb(1,2)')).toBeNull();
  expect(parseColor('nonsense')).toBeNull();

  const [, g] = make(1, 1);
  g.fillStyle = '#ff0000';
  g.fillStyle = 'not-a-colour';                         // ignored, like Canvas
  expect(g.fillStyle).toBe('#ff0000');
  g.fillStyle = 'rgba(0,0,0,.5)';
  expect(g.fillStyle).toBe('rgba(0, 0, 0, 0.5)');
});

test('fillRect is exact on integer rectangles', () => {
  const [c, g] = make(10, 10);
  g.fillStyle = '#123456';
  g.fillRect(2, 3, 4, 5);
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 10; x++) {
      const inside = x >= 2 && x < 6 && y >= 3 && y < 8;
      expect(px(c, x, y)).toEqual(inside ? [0x12, 0x34, 0x56, 255] : [0, 0, 0, 0]);
    }
  }
  // negative sizes are normalized
  const [c2, g2] = make(4, 4);
  g2.fillRect(3, 3, -2, -2);
  expect(alpha(c2, 1, 1)).toBe(255);
  expect(alpha(c2, 0, 0)).toBe(0);
  expect(alpha(c2, 3, 3)).toBe(0);
});

test('anti-aliasing: a half-covered pixel gets ~50% coverage', () => {
  const [c, g] = make(4, 2);
  g.fillRect(0, 0, 2.5, 1);
  expect(alpha(c, 1, 0)).toBe(255);
  expect(Math.abs(alpha(c, 2, 0) - 127.5)).toBeLessThanOrEqual(1);
  expect(alpha(c, 3, 0)).toBe(0);

  // same through the path rasterizer, along a diagonal edge
  const [c2, g2] = make(8, 8);
  g2.beginPath(); g2.moveTo(0, 0); g2.lineTo(8, 0); g2.lineTo(0, 8); g2.closePath(); g2.fill();
  expect(Math.abs(alpha(c2, 3, 4) - 127.5)).toBeLessThanOrEqual(1);   // centre lies on x + y = 8
  expect(alpha(c2, 1, 1)).toBe(255);
  expect(alpha(c2, 6, 6)).toBe(0);
});

test('nonzero winding: overlapping subpaths fill once; opposite-direction inner subpath is a hole', () => {
  const [c, g] = make(30, 10);
  g.fillStyle = 'rgba(0,0,0,0.5)';
  g.beginPath();
  g.rect(0, 0, 10, 10);
  g.rect(5, 0, 10, 10);                                  // overlaps the first, same direction
  g.fill();
  expect(alpha(c, 7, 5)).toBe(alpha(c, 2, 5));           // overlap not blended twice
  expect(Math.abs(alpha(c, 2, 5) - 128)).toBeLessThanOrEqual(1);

  const [c2, g2] = make(20, 20);
  g2.beginPath();
  g2.moveTo(0, 0); g2.lineTo(20, 0); g2.lineTo(20, 20); g2.lineTo(0, 20); g2.closePath();   // clockwise
  g2.moveTo(5, 5); g2.lineTo(15, 5); g2.lineTo(15, 15); g2.lineTo(5, 15); g2.closePath();   // same direction
  g2.fill();
  expect(alpha(c2, 10, 10)).toBe(255);                   // winding 2 → filled (nonzero)
  g2.clearRect(0, 0, 20, 20);
  g2.fill('evenodd');
  expect(alpha(c2, 10, 10)).toBe(0);                     // even-odd → hole
  expect(alpha(c2, 2, 2)).toBe(255);

  const [c3, g3] = make(20, 20);
  g3.beginPath();
  g3.moveTo(0, 0); g3.lineTo(20, 0); g3.lineTo(20, 20); g3.lineTo(0, 20); g3.closePath();
  g3.moveTo(5, 5); g3.lineTo(5, 15); g3.lineTo(15, 15); g3.lineTo(15, 5); g3.closePath();   // opposite direction
  g3.fill();
  expect(alpha(c3, 10, 10)).toBe(0);                     // winding 0 → hole even under nonzero
  expect(alpha(c3, 2, 2)).toBe(255);
});

test('arc: anticlockwise annular sector (end-cap construction) and anticlockwise sweep', () => {
  const [c, g] = make(100, 100);
  const a0 = 0.2, a1 = 1.2, r0 = 20, r1 = 45;
  g.beginPath();
  g.arc(50, 50, r1, a0, a1);
  g.arc(50, 50, r0, a1, a0, true);
  g.closePath();
  g.fill();
  const at = (ang: number, r: number): number =>
    alpha(c, Math.floor(50 + Math.cos(ang) * r), Math.floor(50 + Math.sin(ang) * r));
  expect(at(0.7, 32)).toBe(255);                         // inside the sector
  expect(at(0.7, 10)).toBe(0);                           // inside the inner radius
  expect(at(2.0, 32)).toBe(0);                           // outside the angular range
  expect(at(-0.3, 32)).toBe(0);

  // anticlockwise from 0 to π/2 covers the other three quadrants
  const [c2, g2] = make(100, 100);
  g2.beginPath(); g2.moveTo(50, 50); g2.arc(50, 50, 40, 0, Math.PI / 2, true); g2.closePath(); g2.fill();
  expect(alpha(c2, 25, 50)).toBe(255);                   // left (angle π)
  expect(alpha(c2, 50, 25)).toBe(255);                   // top (angle 3π/2)
  expect(alpha(c2, 70, 70)).toBe(0);                     // bottom-right (angle π/4)

  // sweep ≥ 2π draws the full circle (generators use 6.2832 > 2π)
  const [c3, g3] = make(40, 40);
  g3.beginPath(); g3.arc(20, 20, 15, 0, 6.2832); g3.fill();
  expect(alpha(c3, 20, 20)).toBe(255);
  expect(alpha(c3, 33, 20)).toBe(255);
  const area = (() => { let s = 0; for (let i = 3; i < c3.image.data.length; i += 4) s += c3.image.data[i] / 255; return s; })();
  expect(Math.abs(area - Math.PI * 225) / (Math.PI * 225)).toBeLessThan(0.005);
});

test('dashed stroke', () => {
  const [c, g] = make(40, 4);
  g.lineWidth = 1;
  g.setLineDash([5, 5]);
  g.beginPath(); g.moveTo(0, 1.5); g.lineTo(40, 1.5); g.stroke();
  const row = Array.from({ length: 40 }, (_, x) => alpha(c, x, 1));
  for (let x = 0; x < 40; x++) expect(row[x]).toBe(Math.floor(x / 5) % 2 === 0 ? 255 : 0);
  expect(alpha(c, 2, 0)).toBe(0);
  expect(g.getLineDash()).toEqual([5, 5]);
  g.setLineDash([3]);
  expect(g.getLineDash()).toEqual([3, 3]);               // odd lists are doubled
});

test('translucent self-overlapping stroke is not darker at the overlap', () => {
  const [c, g] = make(100, 100);
  g.fillStyle = '#fff'; g.fillRect(0, 0, 100, 100);
  g.strokeStyle = 'rgba(0,0,0,0.5)'; g.lineWidth = 8; g.lineJoin = 'round';
  g.beginPath(); g.moveTo(10, 10); g.lineTo(90, 90); g.lineTo(90, 10); g.lineTo(10, 90); g.stroke();
  const cross = px(c, 50, 50)[0], single = px(c, 30, 30)[0];
  expect(Math.abs(cross - single)).toBeLessThanOrEqual(1);
  expect(Math.abs(single - 128)).toBeLessThanOrEqual(1);
  // a corner join is also blended once
  expect(Math.abs(px(c, 88, 88)[0] - single)).toBeLessThanOrEqual(1);
});

test('stroke caps and joins', () => {
  const caps = (cap: 'butt' | 'round' | 'square'): RasterCanvas => {
    const [c, g] = make(40, 20);
    g.lineWidth = 10; g.lineCap = cap;
    g.beginPath(); g.moveTo(10, 10); g.lineTo(30, 10); g.stroke();
    return c;
  };
  const butt = caps('butt'), square = caps('square'), round = caps('round');
  expect(alpha(butt, 10, 10)).toBe(255);
  expect(alpha(butt, 8, 10)).toBe(0);
  expect(alpha(square, 6, 6)).toBe(255);                 // square cap extends by half width
  expect(alpha(square, 4, 10)).toBe(0);
  expect(alpha(round, 6, 10)).toBe(255);
  expect(alpha(round, 5, 5)).toBe(0);                    // corner outside the round cap

  // miter join fills the outer corner; bevel cuts it
  const join = (j: 'miter' | 'bevel' | 'round'): RasterCanvas => {
    const [c, g] = make(40, 40);
    g.lineWidth = 10; g.lineJoin = j;
    g.beginPath(); g.moveTo(5, 10); g.lineTo(30, 10); g.lineTo(30, 35); g.stroke();
    return c;
  };
  expect(alpha(join('miter'), 34, 6)).toBe(255);
  expect(alpha(join('bevel'), 34, 6)).toBe(0);
  expect(alpha(join('bevel'), 31, 8)).toBe(255);
  expect(alpha(join('round'), 34, 6)).toBeLessThan(255);
  expect(alpha(join('round'), 32, 8)).toBe(255);
  // the inside of the joint has no seam
  expect(alpha(join('miter'), 28, 12)).toBe(255);

  // strokeRect with an odd width on half-pixel coordinates is crisp
  const [c, g] = make(20, 20);
  g.strokeRect(2.5, 2.5, 10, 10);
  expect(alpha(c, 2, 2)).toBe(255);
  expect(alpha(c, 12, 7)).toBe(255);
  expect(alpha(c, 3, 3)).toBe(0);
  expect(alpha(c, 1, 2)).toBe(0);
});

test('clip with save/restore', () => {
  const [c, g] = make(40, 40);
  g.save();
  g.beginPath(); g.rect(10, 10, 10, 10); g.clip();
  g.fillStyle = '#f00'; g.fillRect(0, 0, 40, 40);
  g.restore();
  expect(px(c, 15, 15)).toEqual([255, 0, 0, 255]);
  expect(alpha(c, 5, 5)).toBe(0);
  expect(alpha(c, 25, 15)).toBe(0);
  g.fillStyle = '#00f'; g.fillRect(30, 30, 5, 5);       // clip gone after restore
  expect(px(c, 32, 32)).toEqual([0, 0, 255, 255]);

  // fractional clip edges are anti-aliased; nested clips intersect
  const [c2, g2] = make(20, 4);
  g2.beginPath(); g2.rect(2.5, 0, 20, 4); g2.clip();
  g2.beginPath(); g2.rect(0, 0, 10, 4); g2.clip();
  g2.fillRect(0, 0, 20, 4);
  expect(Math.abs(alpha(c2, 2, 1) - 127.5)).toBeLessThanOrEqual(1);
  expect(alpha(c2, 5, 1)).toBe(255);
  expect(alpha(c2, 10, 1)).toBe(0);

  // non-rectangular clip (mask)
  const [c3, g3] = make(40, 40);
  g3.beginPath(); g3.arc(20, 20, 10, 0, Math.PI * 2); g3.clip();
  g3.fillRect(0, 0, 40, 40);
  expect(alpha(c3, 20, 20)).toBe(255);
  expect(alpha(c3, 3, 3)).toBe(0);
  expect(alpha(c3, 36, 20)).toBe(0);
});

test('gradients at known points', () => {
  const [c, g] = make(100, 2);
  const lg = g.createLinearGradient(0, 0, 100, 0);
  lg.addColorStop(0, '#000'); lg.addColorStop(1, '#fff');
  g.fillStyle = lg; g.fillRect(0, 0, 100, 2);
  expect(Math.abs(px(c, 0, 0)[0] - 1.3)).toBeLessThanOrEqual(1.5);
  expect(Math.abs(px(c, 50, 0)[0] - 128.8)).toBeLessThanOrEqual(1.5);
  expect(Math.abs(px(c, 99, 0)[0] - 253.7)).toBeLessThanOrEqual(1.5);

  // radial (concentric), as in makeBlobTexture; beyond r1 the last stop pads
  const [c2, g2] = make(128, 128);
  const rg = g2.createRadialGradient(64, 64, 0, 64, 64, 64);
  rg.addColorStop(0, 'rgba(0,0,0,.78)'); rg.addColorStop(0.42, 'rgba(0,0,0,.44)'); rg.addColorStop(1, 'rgba(0,0,0,0)');
  g2.fillStyle = rg; g2.fillRect(0, 0, 128, 128);
  expect(Math.abs(alpha(c2, 64, 64) - 0.78 * 255)).toBeLessThanOrEqual(3);
  const r42 = Math.round(64 + 0.42 * 64);
  expect(Math.abs(alpha(c2, r42, 64) - 0.44 * 255)).toBeLessThanOrEqual(3);
  expect(alpha(c2, 0, 0)).toBe(0);

  // two-circle radial: inner circle radius 10 → t = 0 inside it
  const [c3, g3] = make(64, 64);
  const r2 = g3.createRadialGradient(32, 32, 10, 32, 32, 30);
  r2.addColorStop(0, '#f00'); r2.addColorStop(1, '#00f');
  g3.fillStyle = r2; g3.fillRect(0, 0, 64, 64);
  expect(px(c3, 32, 32)).toEqual([255, 0, 0, 255]);
  const mid = px(c3, 52, 32);                              // distance 20.5 → t ≈ 0.525
  expect(Math.abs(mid[0] - 255 * 0.475)).toBeLessThanOrEqual(3);
  expect(px(c3, 63, 32)).toEqual([0, 0, 255, 255]);

  // gradient coordinates follow the transform at fill time
  const [c4, g4] = make(20, 2);
  const lg2 = g4.createLinearGradient(0, 0, 10, 0);
  lg2.addColorStop(0, '#000'); lg2.addColorStop(1, '#fff');
  g4.translate(10, 0); g4.fillStyle = lg2; g4.fillRect(-10, 0, 20, 2);
  expect(px(c4, 5, 0)[0]).toBe(0);                       // user x < 0 → first stop
  expect(Math.abs(px(c4, 15, 0)[0] - 0.55 * 255)).toBeLessThanOrEqual(1.5);   // user x = 5.5
  expect(Math.abs(px(c4, 19, 0)[0] - 0.95 * 255)).toBeLessThanOrEqual(1.5);
});

test('drawImage downscale averages (box filter)', () => {
  const [src, gs] = make(4, 4);
  gs.fillStyle = '#000'; gs.fillRect(0, 0, 4, 4);
  gs.fillStyle = '#fff';
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) if ((x + y) & 1) gs.fillRect(x, y, 1, 1);
  const [dst, gd] = make(2, 2);
  gd.drawImage(src, 0, 0, 2, 2);
  for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
    expect(Math.abs(px(dst, x, y)[0] - 127.5)).toBeLessThanOrEqual(1);
    expect(alpha(dst, x, y)).toBe(255);
  }
  // 4 → 1: mean of a ramp
  const [ramp, gr] = make(4, 1);
  [0, 40, 80, 120].forEach((v, i) => { gr.fillStyle = `rgb(${v},${v},${v})`; gr.fillRect(i, 0, 1, 1); });
  const [one, g1] = make(1, 1);
  g1.drawImage(ramp, 0, 0, 1, 1);
  expect(px(one, 0, 0)[0]).toBe(60);
  // same-size copy is exact
  const [cp, gc] = make(4, 4);
  gc.drawImage(src, 0, 0);
  expect(Array.from(cp.image.data)).toEqual(Array.from(src.image.data));
  // transparent texels do not bleed their colour (premultiplied averaging)
  const img = createPixelImage(2, 1);
  img.data.set([255, 0, 0, 255, 0, 255, 0, 0]);
  const half = resamplePixelImage(img, 1, 1);
  expect(Array.from(half.data)).toEqual([255, 0, 0, 128]);
});

test('transform order: translate then rotate', () => {
  const [c, g] = make(60, 20);
  g.translate(50, 0);
  g.rotate(Math.PI / 2);                                  // (x, y) → (50 - y, x)
  g.fillRect(0, 0, 10, 5);
  expect(alpha(c, 47, 5)).toBe(255);
  expect(alpha(c, 52, 5)).toBe(0);
  expect(alpha(c, 47, 12)).toBe(0);
  const t = g.getTransform();
  expect(t.e).toBe(50);
  expect(t.b).toBeCloseTo(1, 12);
  g.resetTransform();
  expect(g.getTransform()).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });

  // scaled ellipse via save/translate/rotate/scale (pond construction)
  const [c2, g2] = make(100, 100);
  g2.save(); g2.translate(50, 50); g2.rotate(0); g2.scale(1, 0.5);
  g2.beginPath(); g2.arc(0, 0, 40, 0, Math.PI * 2); g2.fill(); g2.restore();
  expect(alpha(c2, 85, 50)).toBe(255);
  expect(alpha(c2, 50, 75)).toBe(0);
  expect(alpha(c2, 50, 65)).toBe(255);
});

test('globalAlpha, clearRect and image data round trip', () => {
  const [c, g] = make(4, 4);
  g.fillStyle = '#fff'; g.fillRect(0, 0, 4, 4);
  g.globalAlpha = 0.5; g.fillStyle = '#000'; g.fillRect(0, 0, 2, 4);
  expect(Math.abs(px(c, 0, 0)[0] - 127.5)).toBeLessThanOrEqual(1);
  g.globalAlpha = 2;                                      // out of range → ignored
  expect(g.globalAlpha).toBe(0.5);
  g.globalAlpha = 1;
  g.clearRect(3, 0, 1, 4);
  expect(px(c, 3, 2)).toEqual([0, 0, 0, 0]);

  const id = g.getImageData(0, 0, 4, 4);
  const out = g.createImageData(4, 4);
  for (let i = 0; i < id.data.length; i += 4) { out.data[i] = 255 - id.data[i]; out.data[i + 3] = 255; }
  g.putImageData(out, 0, 0);
  expect(px(c, 2, 0)).toEqual([0, 0, 0, 255]);
  expect(px(c, 3, 0)).toEqual([255, 0, 0, 255]);
  const part = g.getImageData(-1, -1, 2, 2);             // out-of-canvas reads are transparent
  expect(Array.from(part.data.slice(0, 4))).toEqual([0, 0, 0, 0]);
});

test('canvas resize resets bitmap and state', () => {
  const c = createCanvas(4, 4), g = c.getContext('2d');
  g.fillStyle = '#f00'; g.fillRect(0, 0, 4, 4); g.translate(1, 1);
  c.width = 8;
  expect(c.image.data.length).toBe(8 * 4 * 4);
  expect(alpha(c, 0, 0)).toBe(0);
  expect(g.fillStyle).toBe('#000000');
  expect(g.getTransform().e).toBe(0);
  expect(c.getContext('2d')).toBe(g);
});
