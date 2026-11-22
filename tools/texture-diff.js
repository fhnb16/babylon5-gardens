/* Canvas2D (browser) vs core/raster Context2D, side by side.

   Each scene is a plain drawing function run twice: once on a DOM canvas,
   once on a core RasterCanvas. Shown: both images, |difference| × gain, PSNR
   over RGBA. Serve through the Vite dev server (it compiles the .ts import):
   npm run dev → /tools/texture-diff.html

   To compare the real generators later, call registerScene() with a
   function (ctx, env) that draws into ctx; env.createCanvas(w, h) creates a
   canvas of the matching kind (DOM or core) for drawImage sources.

   The real generators (js/textures.js vs core/textures) are registered with
   registerPair(name, w, h, legacyFn, coreFn) in registerGenerators().
   ?filter=<substring> limits the scenes; results go to window.__textureDiff
   (for headless Playwright runs). */

import { createCanvas as createCoreCanvas } from '../core/raster/index.ts';

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rnd, arr) => arr[(rnd() * arr.length) | 0];
const TAU = Math.PI * 2;

const scenes = [];
/** @param {string} name @param {number} w @param {number} h @param {(ctx:any, env:any)=>void} draw */
export function registerScene(name, w, h, draw) {
  scenes.push({ name, w, h, draw });
}

/* ───────────── representative sequences (from js/textures.js) ───────────── */

registerScene('fillRect + globalAlpha (hull soil)', 256, 256, (a, { W, H, rnd }) => {
  a.fillStyle = '#54703c'; a.fillRect(0, 0, W, H);
  for (let i = 0; i < 400; i++) {
    a.fillStyle = pick(rnd, ['#5e7a42', '#4b653a', '#66834a', '#48603a', '#6d8a4e']);
    a.globalAlpha = 0.3 + rnd() * 0.45;
    const s = 4 + rnd() * 26;
    a.fillRect(rnd() * W, rnd() * H, s, s * (0.4 + rnd()));
  }
  a.globalAlpha = 1;
});

registerScene('rotated ellipses (parks)', 256, 256, (a, { W, H, rnd }) => {
  a.fillStyle = '#42682f'; a.fillRect(0, 0, W, H);
  for (let i = 0; i < 200; i++) {
    a.fillStyle = pick(rnd, ['#4d7536', '#385c28', '#598040', '#6b8f45', '#2f4f22']);
    a.globalAlpha = 0.5 + rnd() * 0.5;
    a.beginPath();
    a.ellipse(rnd() * W, rnd() * H, 4 + rnd() * 22, 3 + rnd() * 16, rnd() * Math.PI, 0, 6.2832);
    a.fill();
  }
  a.globalAlpha = 1;
});

registerScene('thin strokes + blotches (detail)', 256, 256, (g, { W, rnd }) => {
  g.fillStyle = '#808080'; g.fillRect(0, 0, W, W);
  for (let i = 0; i < 3000; i++) {
    const x = rnd() * W, y = rnd() * W, len = 2 + rnd() * 6, ang = rnd() * Math.PI;
    g.strokeStyle = rnd() < 0.5 ? 'rgba(255,255,255,.22)' : 'rgba(0,0,0,.22)';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len); g.stroke();
  }
  for (let i = 0; i < 60; i++) {
    g.fillStyle = rnd() < 0.5 ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.1)';
    g.beginPath(); g.ellipse(rnd() * W, rnd() * W, 6 + rnd() * 26, 6 + rnd() * 26, 0, 0, 6.2832); g.fill();
  }
});

registerScene('clip + quads + hatching (fields)', 256, 256, (a, { H, rnd }) => {
  a.fillStyle = '#54703c'; a.fillRect(0, 0, 256, 256);
  const x0 = 30.7, x1 = 220.3;
  a.save(); a.beginPath(); a.rect(x0, 0, x1 - x0, H); a.clip();
  let y = -20;
  while (y < H + 20) {
    const bh = 26 + rnd() * 50;
    let x = x0 - 30;
    while (x < x1 + 30) {
      const bw = 24 + rnd() * 60, j = 6;
      a.fillStyle = pick(rnd, ['#7d8f3e', '#96a24a', '#6d8438', '#b5ab52', '#c9bd63']);
      a.beginPath();
      a.moveTo(x + (rnd() - .5) * j, y + (rnd() - .5) * j);
      a.lineTo(x + bw + (rnd() - .5) * j, y + (rnd() - .5) * j);
      a.lineTo(x + bw + (rnd() - .5) * j, y + bh + (rnd() - .5) * j);
      a.lineTo(x + (rnd() - .5) * j, y + bh + (rnd() - .5) * j);
      a.closePath(); a.fill();
      a.globalAlpha = 0.13; a.strokeStyle = '#31401f'; a.lineWidth = 1;
      const step = 5 + rnd() * 8;
      a.beginPath();
      for (let k = y + step; k < y + bh; k += step) { a.moveTo(x, k); a.lineTo(x + bw, k); }
      a.stroke();
      a.globalAlpha = 0.22; a.strokeStyle = '#4d5f2c'; a.lineWidth = 3; a.strokeRect(x, y, bw, bh);
      a.globalAlpha = 1;
      x += bw;
    }
    y += bh;
  }
  a.restore();
});

registerScene('streets: wide + dashed + mask passes', 256, 256, (a) => {
  a.fillStyle = '#6f757b'; a.fillRect(0, 0, 256, 256);
  for (const [p, main] of [[40.5, true], [120, false], [200.25, true]]) {
    a.strokeStyle = main ? '#3a3f44' : '#44494f'; a.lineWidth = main ? 9.2 : 7.2;
    a.beginPath(); a.moveTo(p, 0); a.lineTo(p, 256); a.stroke();
    a.beginPath(); a.moveTo(0, p); a.lineTo(256, p); a.stroke();
    if (main) {
      a.globalAlpha = 0.5; a.strokeStyle = '#e8d98a'; a.lineWidth = 1.3; a.setLineDash([9, 7]);
      a.beginPath(); a.moveTo(p, 0); a.lineTo(p, 256); a.stroke();
      a.setLineDash([]); a.globalAlpha = 1;
    }
    a.strokeStyle = '#0000ff';
    for (const [mul, al] of [[2.1, 0.22], [1.4, 0.45], [0.75, 1]]) {
      a.globalAlpha = al * 0.3; a.lineWidth = Math.max(1.5, 9 * mul);
      a.beginPath(); a.moveTo(p + 0.3, 0); a.lineTo(p + 0.3, 256); a.stroke();
    }
    a.globalAlpha = 1;
  }
});

registerScene('river: smooth quadratic, round joins', 256, 256, (a, { rnd }) => {
  a.fillStyle = '#54703c'; a.fillRect(0, 0, 256, 256);
  const pts = [];
  for (let y = -20; y <= 276; y += 24) pts.push([128 + Math.sin(y * 0.03) * 40 + (rnd() - .5) * 6, y]);
  const stroke = (w, col) => {
    a.strokeStyle = col; a.lineWidth = w; a.lineJoin = 'round'; a.lineCap = 'round';
    a.beginPath(); a.moveTo(pts[0][0], pts[0][1]);
    for (let k = 1; k < pts.length - 1; k++) {
      a.quadraticCurveTo(pts[k][0], pts[k][1], (pts[k][0] + pts[k + 1][0]) / 2, (pts[k][1] + pts[k + 1][1]) / 2);
    }
    const e = pts[pts.length - 1]; a.lineTo(e[0], e[1]); a.stroke();
  };
  stroke(60, '#a8a173'); stroke(49, '#7f9a55'); stroke(36, '#3a5c47'); stroke(28, '#2c4c5e');
  a.globalAlpha = 0.35; stroke(13, '#20384a'); a.globalAlpha = 1;
});

registerScene('end cap: annular sectors + spokes', 256, 256, (g, { rnd }) => {
  const S = 256, C = S / 2;
  g.fillStyle = '#7e848c'; g.beginPath(); g.arc(C, C, C, 0, TAU); g.fill();
  const rings = 10;
  for (let i = rings; i >= 1; i--) {
    const r1 = C * (i / rings), r0 = C * ((i - 1) / rings);
    const seg = Math.max(6, Math.round(i * 2.6));
    for (let k = 0; k < seg; k++) {
      const a0 = (k / seg) * TAU + rnd() * 0.01, a1 = ((k + 1) / seg) * TAU;
      const v = Math.round(132 * (0.72 + rnd() * 0.5));
      g.fillStyle = `rgb(${v},${v + 4},${v + 9})`;
      g.beginPath(); g.arc(C, C, r1, a0, a1); g.arc(C, C, r0, a1, a0, true); g.closePath(); g.fill();
    }
    g.strokeStyle = 'rgba(38,44,52,.42)'; g.lineWidth = 1.4;
    g.beginPath(); g.arc(C, C, r0, 0, TAU); g.stroke();
  }
  for (let k = 0; k < 6; k++) {
    g.save(); g.translate(C, C); g.rotate((k / 6) * TAU + 0.26);
    g.fillStyle = 'rgba(150,158,168,.85)'; g.fillRect(-C * 0.018, -C * 0.96, C * 0.036, C * 0.9);
    g.restore();
  }
});

registerScene('gradients: streaks, puddles, sprite', 256, 256, (g, { rnd }) => {
  g.fillStyle = '#8e959d'; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 80; i++) {
    const sx = rnd() * 256, sy = rnd() * 256, len = 12 + rnd() * 90, w = 1 + rnd() * 5;
    const gr = g.createLinearGradient(sx, sy, sx, sy + len);
    gr.addColorStop(0, rnd() < 0.62 ? 'rgba(38,44,52,.34)' : 'rgba(226,232,240,.20)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(sx, sy, w, len);
  }
  for (let i = 0; i < 12; i++) {
    const x = rnd() * 256, y = rnd() * 256, r = 8 + rnd() * 34;
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, 'rgba(28,34,42,.30)'); gr.addColorStop(1, 'rgba(28,34,42,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
  }
  const gr = g.createRadialGradient(64, 192, 2.5, 64, 192, 64);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.45, 'rgba(255,255,255,.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 128, 128, 128);
});

registerScene('1-px fillRects (footprint)', 128, 128, (g) => {
  const S = 128, halfX = S * 0.42, halfY = S * 0.21;
  g.clearRect(0, 0, S, S);
  for (let y = 0; y < S; y++) {
    const dy = Math.abs(y - S / 2) / halfY;
    const fy = dy <= 1 ? 1 : Math.max(0, 1 - (dy - 1) / 1.35);
    if (fy <= 0) continue;
    for (let x = 0; x < S; x++) {
      const dx = Math.abs(x - S / 2) / halfX;
      const fx = dx <= 1 ? 1 : Math.max(0, 1 - (dx - 1) / 0.16);
      if (fx <= 0) continue;
      g.fillStyle = `rgba(0,0,0,${(fx * fy * fy * 0.82).toFixed(3)})`;
      g.fillRect(x, y, 1, 1);
    }
  }
});

registerScene('leaf: transparent bg + transformed ellipses', 256, 256, (g, { rnd }) => {
  g.clearRect(0, 0, 256, 256);
  g.fillStyle = '#5c8a3a';
  for (let i = 0; i < 6; i++) { g.beginPath(); g.arc(80 + rnd() * 96, 70 + rnd() * 80, 30 + rnd() * 30, 0, TAU); g.fill(); }
  for (let i = 0; i < 400; i++) {
    const v = 60 + rnd() * 90;
    g.fillStyle = `rgba(${(v * 0.55) | 0},${v},${(v * 0.42) | 0},.75)`;
    g.save(); g.translate(60 + rnd() * 136, 50 + rnd() * 120); g.rotate(rnd() * TAU);
    g.beginPath(); g.ellipse(0, 0, 2 + rnd() * 5, 1 + rnd() * 2.4, 0, 0, TAU); g.fill();
    g.restore();
  }
  g.fillStyle = '#6b5236'; g.fillRect(128 - 5.6, 140.8, 11.3, 107.5);
});

registerScene('drawImage 2× downscale', 128, 128, (g, { rnd, createCanvas }) => {
  const src = createCanvas(256, 256), s = src.getContext('2d');
  s.fillStyle = '#000'; s.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 300; i++) {
    s.fillStyle = `rgb(${(rnd() * 255) | 0},${(rnd() * 255) | 0},${(rnd() * 255) | 0})`;
    s.fillRect((rnd() * 256) | 0, (rnd() * 256) | 0, 1 + ((rnd() * 20) | 0), 1 + ((rnd() * 20) | 0));
  }
  g.drawImage(src, 0, 0, 128, 128);
});

/* ───────────── real generators: js/textures.js vs core/textures ─────────────
   Each pair runs the LEGACY generator (DOM canvas, three CanvasTexture) and
   the core port through the spec registry, at the sizes/seeds the app uses.
   Derived maps (normals, water) are compared twice: "chain" feeds each side
   its own source (the real end-to-end parity), "iso" feeds both the SAME
   legacy source pixels to isolate the algorithm. */

/** @param {string} name @param {number} w @param {number} h
    @param {() => HTMLCanvasElement} legacy @param {() => {data: Uint8ClampedArray}} core */
export function registerPair(name, w, h, legacy, core) {
  scenes.push({ name, w, h, pair: { legacy, core } });
}

const SEED = 1337;
/* hull ponds in the shape world.js passes (t, z, r·0.62, ax, rot) */
const PONDS = [
  { t: 1.31, z: -40, r: 4.2, ax: 1.4, rot: 0.6 },
  { t: 5.40, z: 62, r: 6.1, ax: 0.7, rot: -0.3 },
  { t: 3.05, z: 10, r: 3.3, ax: 1.0, rot: 0 }
];

async function registerGenerators() {
  const L = await import('../test/legacy-oracle/textures.js');
  const { CONFIG } = await import('../js/config.js');
  const { mulberry32: lrng } = await import('../test/legacy-oracle/util.js');
  const C = await import('../core/textures/index.ts');
  const legacySeeded = (fn) => {
    const old = CONFIG.SEED; CONFIG.SEED = SEED;
    try { return fn(); } finally { CONFIG.SEED = old; }
  };
  const memo = new Map();
  const once = (key, fn) => { if (!memo.has(key)) memo.set(key, fn()); return memo.get(key); };
  const core = (gen, args) => () => C.generateImage({ gen, args });
  /** core-side PixelImage copy of a legacy canvas (for the "iso" variants) */
  const asPixels = (cnv) => {
    const d = cnv.getContext('2d').getImageData(0, 0, cnv.width, cnv.height);
    return { width: d.width, height: d.height, data: d.data };
  };

  for (const [size, maskSize] of [[2048, 1024], [1024, 512]]) {
    const lh = () => once(`hull${size}`, () => legacySeeded(() => L.makeHullMaps(size, maskSize, lrng(SEED + 7), PONDS)));
    const args = { size, maskSize, seed: SEED + 7, worldSeed: SEED, ponds: PONDS };
    registerPair(`hullMaps albedo ${size}`, size, size, () => lh().albedo.image, core('hullMaps', { ...args, output: 'albedo' }));
    registerPair(`hullMaps mask ${maskSize}`, maskSize, maskSize, () => lh().mask.image, core('hullMaps', { ...args, output: 'mask' }));
    /* hull normals exist only with hullTex 2048 (HIGH: Q.normals 1024, ULTRA: 2048) */
    if (size === 2048) {
      const src = { gen: 'hullMaps', args: { ...args, output: 'albedo' } };
      for (const ns of [1024, 2048]) {
        registerPair(`heightToNormal hull ${size}→${ns} (chain)`, ns, ns,
          () => L.heightToNormal(lh().canvas, CONFIG.NORMALS.hull, ns).image,
          core('heightToNormal', { src, strength: CONFIG.NORMALS.hull, size: ns }));
        registerPair(`heightToNormal hull ${size}→${ns} (iso)`, ns, ns,
          () => L.heightToNormal(lh().canvas, CONFIG.NORMALS.hull, ns).image,
          () => C.heightToNormal(asPixels(lh().canvas), CONFIG.NORMALS.hull, ns).image);
      }
    }
    const mask = { gen: 'hullMaps', args: { ...args, output: 'mask' } };
    const ws = Math.min(1024, maskSize);
    registerPair(`waterRoughness ${maskSize}→${ws} (chain)`, ws, ws,
      () => L.makeWaterRoughness(lh().mask, ws).image, core('waterRoughness', { mask, size: ws }));
    registerPair(`waterNormal ${maskSize}→${ws} (chain)`, ws, ws,
      () => L.makeWaterNormal(lh().mask, ws, CONFIG.NORMALS.water).image,
      core('waterNormal', { mask, size: ws, strength: CONFIG.NORMALS.water }));
    registerPair(`waterNormal ${maskSize}→${ws} (iso)`, ws, ws,
      () => L.makeWaterNormal(lh().mask, ws, CONFIG.NORMALS.water).image,
      () => C.makeWaterNormal(asPixels(lh().mask.image), ws, CONFIG.NORMALS.water).image);
  }
  /* ULTRA: 2048 mask downscaled to 1024 by drawImage */
  {
    const lh = () => once('hullU', () => legacySeeded(() => L.makeHullMaps(1024, 2048, lrng(SEED + 7), PONDS)));
    const mask = { gen: 'hullMaps', args: { size: 1024, maskSize: 2048, seed: SEED + 7, worldSeed: SEED, ponds: PONDS, output: 'mask' } };
    registerPair('waterRoughness 2048→1024 (chain)', 1024, 1024,
      () => L.makeWaterRoughness(lh().mask, 1024).image, core('waterRoughness', { mask, size: 1024 }));
    registerPair('waterRoughness 2048→1024 (iso)', 1024, 1024,
      () => L.makeWaterRoughness(lh().mask, 1024).image,
      () => C.makeWaterRoughness(asPixels(lh().mask.image), 1024).image);
  }

  registerPair('detailTexture', 256, 256, () => L.makeDetailTexture(lrng(SEED + 11)).image, core('detailTexture', { seed: SEED + 11 }));
  for (let v = 0; v < 4; v++) {
    const lf = () => once(`fac${v}`, () => L.makeFacade(lrng(SEED + 31 * (v + 1)), v));
    const fa = { seed: SEED + 31 * (v + 1), variant: v };
    registerPair(`facade ${v} map`, 256, 256, () => lf().map.image, core('facade', { ...fa, output: 'map' }));
    registerPair(`facade ${v} emissive`, 256, 256, () => lf().emis.image, core('facade', { ...fa, output: 'emissive' }));
    registerPair(`heightToNormal facade ${v} (chain)`, 256, 256,
      () => L.heightToNormal(lf().canvas, CONFIG.NORMALS.facade).image,
      core('heightToNormal', { src: { gen: 'facade', args: { ...fa, output: 'map' } }, strength: CONFIG.NORMALS.facade, size: 0 }));
  }
  const roof = { gen: 'roofTexture', args: { seed: SEED + 77 } };
  const lroof = () => once('roof', () => L.makeRoofTexture(lrng(SEED + 77)));
  registerPair('roofTexture', 256, 256, () => lroof().image, core('roofTexture', roof.args));
  registerPair('heightToNormal roof (chain)', 256, 256,
    () => L.heightToNormal(lroof().image, CONFIG.NORMALS.roof, 256).image,
    core('heightToNormal', { src: roof, strength: CONFIG.NORMALS.roof, size: 256 }));
  registerPair('carWindows', 32, 32, () => L.makeCarWindows().image, core('carWindows', {}));

  const lpanel = () => once('panel', () => L.makePanelTexture(lrng(SEED + 53)));
  registerPair('panelTexture', 512, 512, () => lpanel().canvas, core('panelTexture', { seed: SEED + 53 }));
  registerPair('heightToNormal panel (chain)', 512, 512,
    () => L.heightToNormal(lpanel().canvas, CONFIG.NORMALS.panel).image,
    core('heightToNormal', { src: { gen: 'panelTexture', args: { seed: SEED + 53 } }, strength: CONFIG.NORMALS.panel, size: 0 }));
  for (const size of [1024, 512]) {
    const le = () => once(`cap${size}`, () => L.makeEndCapTexture(size, lrng(SEED + 99)));
    const ea = { size, seed: SEED + 99 };
    registerPair(`endCapTexture ${size} map`, size, size, () => le().map.image, core('endCapTexture', { ...ea, output: 'map' }));
    registerPair(`endCapTexture ${size} emissive`, size, size, () => le().emis.image, core('endCapTexture', { ...ea, output: 'emissive' }));
    registerPair(`heightToNormal endcap ${size}→1024 (chain)`, 1024, 1024,
      () => L.heightToNormal(le().canvas, CONFIG.NORMALS.endcap, 1024).image,
      core('heightToNormal', { src: { gen: 'endCapTexture', args: { ...ea, output: 'map' } }, strength: CONFIG.NORMALS.endcap, size: 1024 }));
  }
  const lleaf = () => once('leaf', () => L.makeLeafTexture(lrng(SEED + 61)));
  registerPair('leafTexture', 256, 256, () => lleaf().image, core('leafTexture', { seed: SEED + 61 }));
  registerPair('heightToNormal leaf (chain)', 256, 256,
    () => L.heightToNormal(lleaf().image, CONFIG.NORMALS.leaf, 256).image,
    core('heightToNormal', { src: { gen: 'leafTexture', args: { seed: SEED + 61 } }, strength: CONFIG.NORMALS.leaf, size: 256 }));
  for (const h of [0, 0.3, 0.5]) {
    registerPair(`softSprite ${h}`, 128, 128, () => L.makeSoftSprite(h).image, core('softSprite', { hardness: h }));
  }
  registerPair('blobTexture', 128, 128, () => L.makeBlobTexture().image, core('blobTexture', {}));
  registerPair('footprintTexture', 256, 256, () => L.makeFootprintTexture().image, core('footprintTexture', {}));
  registerPair('glowTexture', 64, 8, () => L.makeGlowTexture().image, core('glowTexture', {}));
}

/* ───────────────────────────── runner ───────────────────────────── */

function runPair(sc, kind) {
  const t0 = performance.now();
  if (kind === 'dom') {
    const c = sc.pair.legacy();
    const ms = performance.now() - t0;
    return { data: c.getContext('2d').getImageData(0, 0, sc.w, sc.h).data, ms };
  }
  const im = sc.pair.core();
  const ms = performance.now() - t0;
  if (im.width !== sc.w || im.height !== sc.h) throw new Error(`${sc.name}: core size ${im.width}×${im.height}`);
  return { data: im.data, ms };
}

function runScene(sc, kind) {
  if (sc.pair) return runPair(sc, kind);
  const make = kind === 'dom'
    ? (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
    : (w, h) => createCoreCanvas(w, h);
  const canvas = make(sc.w, sc.h);
  const ctx = canvas.getContext('2d');
  const t0 = performance.now();
  sc.draw(ctx, { W: sc.w, H: sc.h, rnd: mulberry32(1234), createCanvas: make });
  const ms = performance.now() - t0;
  const data = kind === 'dom' ? ctx.getImageData(0, 0, sc.w, sc.h).data : canvas.image.data;
  return { data, ms };
}

function toCanvas(w, h, data, zoom, label) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data), w, h), 0, 0);
  c.style.width = `${w * zoom}px`;
  const f = document.createElement('figure');
  const cap = document.createElement('figcaption');
  cap.textContent = label;
  f.append(c, cap);
  return f;
}

/* Compared premultiplied: browsers store premultiplied pixels, so the RGB of
   an almost transparent pixel is noise after getImageData and must not count. */
function compare(a, b, gain) {
  const diff = new Uint8ClampedArray(a.length);
  let se = 0, max = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (let k = 0; k < 4; k++) {
      const pa = k < 3 ? a[i + k] * a[i + 3] / 255 : a[i + k];
      const pb = k < 3 ? b[i + k] * b[i + 3] / 255 : b[i + k];
      const d = Math.round(Math.abs(pa - pb));
      se += d * d;
      if (d > max) max = d;
      if (k < 3) diff[i + k] = Math.max(diff[i + k], d * gain);
    }
    const da = Math.abs(a[i + 3] - b[i + 3]) * gain;
    diff[i] = Math.max(diff[i], da); diff[i + 1] = Math.max(diff[i + 1], da); diff[i + 2] = Math.max(diff[i + 2], da);
    diff[i + 3] = 255;
  }
  const mse = se / a.length;
  return { diff, psnr: mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse), max };
}

/* ?filter=substring limits the scenes; results also land in
   window.__textureDiff for headless runs (Playwright). */
const FILTER = new URLSearchParams(location.search).get('filter') || '';

function run() {
  const gain = +document.getElementById('gain').value;
  const zoom = +document.getElementById('zoom').value;
  const out = document.getElementById('out'), tbody = document.querySelector('#summary tbody');
  out.textContent = ''; tbody.textContent = '';
  const results = [];
  for (const sc of scenes) {
    if (FILTER && !sc.name.includes(FILTER)) continue;
    const dom = runScene(sc, 'dom'), core = runScene(sc, 'core');
    const { diff, psnr, max } = compare(dom.data, core.data, gain);
    results.push({ name: sc.name, w: sc.w, h: sc.h, psnr, max, domMs: dom.ms, coreMs: core.ms });
    const cls = psnr >= 40 ? 'good' : psnr >= 30 ? 'ok' : 'bad';
    const psnrText = psnr === Infinity ? '∞' : psnr.toFixed(2);
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${sc.name}</td><td>${sc.w}×${sc.h}</td><td class="${cls}">${psnrText}</td><td>${max}</td>`
      + `<td>${dom.ms.toFixed(1)}</td><td>${core.ms.toFixed(1)}</td>`;
    tbody.append(tr);
    const div = document.createElement('div');
    div.className = 'scene';
    const h = document.createElement('h2');
    h.innerHTML = `${sc.name} — PSNR <span class="${cls}">${psnrText} dB</span>`;
    const row = document.createElement('div');
    row.className = 'row';
    row.append(
      toCanvas(sc.w, sc.h, dom.data, zoom, 'browser Canvas2D'),
      toCanvas(sc.w, sc.h, core.data, zoom, 'core Context2D'),
      toCanvas(sc.w, sc.h, diff, zoom, `|Δ| × ${gain}`)
    );
    div.append(h, row);
    out.append(div);
  }
  document.getElementById('status').textContent = `${results.length} scenes`;
  window.__textureDiff = results;
}

document.getElementById('gain').addEventListener('change', run);
document.getElementById('zoom').addEventListener('change', run);
registerGenerators()
  .catch(e => { console.error(e); document.getElementById('status').textContent = `generators failed: ${e}`; })
  .then(run)
  .catch(e => { console.error(e); window.__textureDiff = { error: String(e && e.stack || e) }; });
