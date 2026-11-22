/* ═══════════════════════════════════════════════════════════════════════════
   Context2D: a software subset of CanvasRenderingContext2D.

   Same method/property names as the DOM API, so texture generators can be
   ported line for line (and keep their exact sequence of rnd() calls).
   Storage is RGBA8 non-premultiplied (like ImageData); compositing is
   source-over in 8-bit sRGB, as browsers do.

   Supported: fillRect/strokeRect/clearRect; beginPath, moveTo, lineTo,
   quadraticCurveTo, bezierCurveTo, arc, ellipse, rect, closePath; fill
   (nonzero/evenodd), stroke, clip; lineWidth, lineCap, lineJoin, miterLimit,
   setLineDash/getLineDash, lineDashOffset; save/restore; translate, rotate,
   scale, transform, setTransform, resetTransform, getTransform; globalAlpha;
   fillStyle/strokeStyle as CSS colours or gradients; drawImage (3/5/9 args);
   getImageData/putImageData/createImageData.
   Not supported: text, patterns, shadows, filters, composite ops other than
   source-over, Path2D, arcTo, roundRect, isPointInPath.
   ═══════════════════════════════════════════════════════════════════════════ */

import { createPixelImage, copyPixelImage, resampleRows } from './image.ts';
import type { PixelImage, ResampleFilter } from './image.ts';
import { parseColor, colorToString, RasterGradient, solidShader, gradientShader, imageShader } from './paint.ts';
import type { RGBA, Shader } from './paint.ts';
import { PathBuilder, identity, multiply, invert, meanScale, isAxisAligned } from './path.ts';
import type { Mat2D } from './path.ts';
import { fillPath, strokePath } from './cover.ts';
import type { IRect, LineCap, LineJoin, RowSink } from './cover.ts';

type Paint = RGBA | RasterGradient;
export type FillRule = 'nonzero' | 'evenodd';
/** Anything drawImage accepts. */
export type ImageSource = RasterCanvas | PixelImage;

interface Clip {
  /** device-space clip rectangle (fractional edges are anti-aliased) */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** rectangle has fractional edges → per-pixel edge coverage needed */
  partial: boolean;
  /** coverage mask (width*height) for non-rectangular clips */
  mask: Float32Array | null;
  /** integer bounds of the mask's non-zero area */
  mb: IRect | null;
}

interface State {
  m: Mat2D;
  fill: Paint;
  fillOut: string | RasterGradient;
  stroke: Paint;
  strokeOut: string | RasterGradient;
  lineWidth: number;
  lineCap: LineCap;
  lineJoin: LineJoin;
  miterLimit: number;
  dash: number[];
  dashOffset: number;
  alpha: number;
  clip: Clip;
  smoothing: boolean;
  smoothingQuality: 'low' | 'medium' | 'high';
  filter: ResampleFilter;
}

const BLACK: RGBA = { r: 0, g: 0, b: 0, a: 1 };

function initialState(w: number, h: number): State {
  return {
    m: identity(),
    fill: BLACK, fillOut: '#000000',
    stroke: BLACK, strokeOut: '#000000',
    lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', miterLimit: 10,
    dash: [], dashOffset: 0,
    alpha: 1,
    clip: { x0: 0, y0: 0, x1: w, y1: h, partial: false, mask: null, mb: null },
    smoothing: true, smoothingQuality: 'low', filter: 'box'
  };
}

function cloneState(s: State): State {
  return {
    m: s.m.slice() as Mat2D,
    fill: s.fill, fillOut: s.fillOut, stroke: s.stroke, strokeOut: s.strokeOut,
    lineWidth: s.lineWidth, lineCap: s.lineCap, lineJoin: s.lineJoin, miterLimit: s.miterLimit,
    dash: s.dash.slice(), dashOffset: s.dashOffset,
    alpha: s.alpha, clip: s.clip,                    // clips are immutable: share
    smoothing: s.smoothing, smoothingQuality: s.smoothingQuality, filter: s.filter
  };
}

/* ───────────────────────────── compositing ───────────────────────────── */

let shadeBuf: Float32Array = new Float32Array(1024);
let rectCov: Float32Array = new Float32Array(1024);
let rectCx: Float32Array = new Float32Array(1024);
let onesBuf: Float32Array = new Float32Array(1024);

const grow = (a: Float32Array, n: number): Float32Array => (a.length >= n ? a : new Float32Array(Math.max(n, a.length * 2)));

/** Multiply span coverage by the clip; false when the row is fully clipped. */
function applyClip(clip: Clip, W: number, y: number, x0: number, n: number, cov: Float32Array, off: number): boolean {
  if (clip.partial) {
    const cy = Math.min(y + 1, clip.y1) - Math.max(y, clip.y0);
    if (cy <= 0) return false;
    if (cy < 1) for (let i = 0; i < n; i++) cov[off + i] *= cy;
    const fx = Math.floor(clip.x0);
    if (fx >= x0 && fx < x0 + n) {
      const k = Math.min(fx + 1, clip.x1) - clip.x0;
      if (k < 1) cov[off + fx - x0] *= k > 0 ? k : 0;
    }
    const lx = Math.ceil(clip.x1) - 1;
    if (lx !== fx && lx >= x0 && lx < x0 + n) {
      const k = clip.x1 - Math.max(lx, clip.x0);
      if (k < 1) cov[off + lx - x0] *= k > 0 ? k : 0;
    }
  }
  const m = clip.mask;
  if (m) {
    const q = y * W + x0;
    for (let i = 0; i < n; i++) cov[off + i] *= m[q + i];
  }
  return true;
}

/** source-over of a constant colour (sa = colour alpha × globalAlpha). */
function blendSolid(d: Uint8ClampedArray, p: number, n: number, cov: Float32Array, off: number,
  r: number, g: number, b: number, sa: number): void {
  for (let i = 0; i < n; i++, p += 4) {
    const c = cov[off + i] * sa;
    if (c <= 0) continue;
    if (c >= 1) { d[p] = r; d[p + 1] = g; d[p + 2] = b; d[p + 3] = 255; continue; }
    const da = d[p + 3];
    if (da === 255) {
      d[p] = d[p] + (r - d[p]) * c; d[p + 1] = d[p + 1] + (g - d[p + 1]) * c; d[p + 2] = d[p + 2] + (b - d[p + 2]) * c;
    } else if (da === 0) {
      d[p] = r; d[p + 1] = g; d[p + 2] = b; d[p + 3] = c * 255;
    } else {
      const k = (da / 255) * (1 - c), oa = c + k, io = 1 / oa;
      d[p] = (r * c + d[p] * k) * io; d[p + 1] = (g * c + d[p + 1] * k) * io; d[p + 2] = (b * c + d[p + 2] * k) * io;
      d[p + 3] = oa * 255;
    }
  }
}

/** source-over of per-pixel colours sh (r,g,b 0..255, a 0..1). */
function blendShaded(d: Uint8ClampedArray, p: number, n: number, cov: Float32Array, off: number,
  sh: Float32Array, alpha: number): void {
  for (let i = 0, o = 0; i < n; i++, p += 4, o += 4) {
    const c = cov[off + i] * sh[o + 3] * alpha;
    if (c <= 0) continue;
    const r = sh[o], g = sh[o + 1], b = sh[o + 2];
    if (c >= 1) { d[p] = r; d[p + 1] = g; d[p + 2] = b; d[p + 3] = 255; continue; }
    const da = d[p + 3];
    if (da === 255) {
      d[p] = d[p] + (r - d[p]) * c; d[p + 1] = d[p + 1] + (g - d[p + 1]) * c; d[p + 2] = d[p + 2] + (b - d[p + 2]) * c;
    } else if (da === 0) {
      d[p] = r; d[p + 1] = g; d[p + 2] = b; d[p + 3] = c * 255;
    } else {
      const k = (da / 255) * (1 - c), oa = c + k, io = 1 / oa;
      d[p] = (r * c + d[p] * k) * io; d[p + 1] = (g * c + d[p + 1] * k) * io; d[p + 2] = (b * c + d[p + 2] * k) * io;
      d[p + 3] = oa * 255;
    }
  }
}

/* ───────────────────────────── canvas ───────────────────────────── */

/** Minimal HTMLCanvasElement stand-in: width/height + getContext('2d'). */
export class RasterCanvas {
  declare private img: PixelImage;
  declare private ctx: Context2D | null;

  constructor(width = 300, height = 150) {
    this.img = createPixelImage(width, height);
    this.ctx = null;
  }

  get width(): number { return this.img.width; }
  /** Like the DOM: setting a size clears the bitmap and resets the context state. */
  set width(v: number) { this.resize(v, this.img.height); }
  get height(): number { return this.img.height; }
  set height(v: number) { this.resize(this.img.width, v); }

  private resize(w: number, h: number): void {
    this.img = createPixelImage(w, h);
    if (this.ctx) this.ctx.resetState();
  }

  /** The backing pixels (live, not a copy). */
  get image(): PixelImage { return this.img; }

  getContext(type: '2d'): Context2D {
    if (type !== '2d') throw new Error(`RasterCanvas: unsupported context '${String(type)}'`);
    if (!this.ctx) this.ctx = new Context2D(this);
    return this.ctx;
  }
}

export function createCanvas(width: number, height: number): RasterCanvas {
  return new RasterCanvas(width, height);
}

const resolveImage = (src: ImageSource): PixelImage => (src instanceof RasterCanvas ? src.image : src);

/* ───────────────────────────── context ───────────────────────────── */

export class Context2D {
  declare readonly canvas: RasterCanvas;
  declare private st: State;
  declare private stack: State[];
  declare private path: PathBuilder;

  constructor(canvas: RasterCanvas) {
    this.canvas = canvas;
    this.path = new PathBuilder();
    this.stack = [];
    this.st = initialState(canvas.width, canvas.height);
  }

  /** Called by RasterCanvas on resize. */
  resetState(): void {
    this.stack = [];
    this.path.clear();
    this.st = initialState(this.canvas.width, this.canvas.height);
  }

  /* ── state ── */

  save(): void { this.stack.push(cloneState(this.st)); }
  restore(): void { const s = this.stack.pop(); if (s) this.st = s; }

  get fillStyle(): string | RasterGradient { return this.st.fillOut; }
  set fillStyle(v: string | RasterGradient) {
    const p = this.toPaint(v);
    if (p) { this.st.fill = p[0]; this.st.fillOut = p[1]; }
  }
  get strokeStyle(): string | RasterGradient { return this.st.strokeOut; }
  set strokeStyle(v: string | RasterGradient) {
    const p = this.toPaint(v);
    if (p) { this.st.stroke = p[0]; this.st.strokeOut = p[1]; }
  }
  private toPaint(v: unknown): [Paint, string | RasterGradient] | null {
    if (v instanceof RasterGradient) return [v, v];
    if (typeof v !== 'string') return null;
    const c = parseColor(v);
    return c ? [c, colorToString(c)] : null;
  }

  get globalAlpha(): number { return this.st.alpha; }
  set globalAlpha(v: number) { if (isFinite(v) && v >= 0 && v <= 1) this.st.alpha = v; }

  get globalCompositeOperation(): string { return 'source-over'; }
  set globalCompositeOperation(v: string) {
    if (v !== 'source-over') throw new Error(`Context2D: globalCompositeOperation '${v}' is not supported`);
  }

  get lineWidth(): number { return this.st.lineWidth; }
  set lineWidth(v: number) { if (isFinite(v) && v > 0) this.st.lineWidth = v; }
  get lineCap(): LineCap { return this.st.lineCap; }
  set lineCap(v: LineCap) { if (v === 'butt' || v === 'round' || v === 'square') this.st.lineCap = v; }
  get lineJoin(): LineJoin { return this.st.lineJoin; }
  set lineJoin(v: LineJoin) { if (v === 'miter' || v === 'round' || v === 'bevel') this.st.lineJoin = v; }
  get miterLimit(): number { return this.st.miterLimit; }
  set miterLimit(v: number) { if (isFinite(v) && v > 0) this.st.miterLimit = v; }
  get lineDashOffset(): number { return this.st.dashOffset; }
  set lineDashOffset(v: number) { if (isFinite(v)) this.st.dashOffset = v; }

  setLineDash(segments: ArrayLike<number>): void {
    const a = Array.prototype.slice.call(segments) as number[];
    for (const v of a) if (!isFinite(v) || v < 0) return;
    this.st.dash = a.length & 1 ? a.concat(a) : a;
  }
  getLineDash(): number[] { return this.st.dash.slice(); }

  get imageSmoothingEnabled(): boolean { return this.st.smoothing; }
  set imageSmoothingEnabled(v: boolean) { this.st.smoothing = !!v; }
  /** Stored for API compatibility; the filter is chosen by `resampleFilter`. */
  get imageSmoothingQuality(): 'low' | 'medium' | 'high' { return this.st.smoothingQuality; }
  set imageSmoothingQuality(v: 'low' | 'medium' | 'high') {
    if (v === 'low' || v === 'medium' || v === 'high') this.st.smoothingQuality = v;
  }
  /**
   * Non-standard: drawImage resampling filter when smoothing is enabled.
   * 'box' (default) = area average when shrinking, bilinear when enlarging.
   * 'bilinear' = Chrome's default ('low' quality) behaviour at any scale.
   */
  get resampleFilter(): ResampleFilter { return this.st.filter; }
  set resampleFilter(v: ResampleFilter) { if (v === 'box' || v === 'bilinear' || v === 'nearest') this.st.filter = v; }

  /* ── transforms ── */

  translate(x: number, y: number): void {
    if (!isFinite(x) || !isFinite(y)) return;
    const m = this.st.m;
    m[4] += m[0] * x + m[2] * y;
    m[5] += m[1] * x + m[3] * y;
  }
  rotate(angle: number): void {
    if (!isFinite(angle)) return;
    const m = this.st.m, c = Math.cos(angle), s = Math.sin(angle);
    const a = m[0], b = m[1], cc = m[2], d = m[3];
    m[0] = a * c + cc * s; m[1] = b * c + d * s;
    m[2] = cc * c - a * s; m[3] = d * c - b * s;
  }
  scale(x: number, y: number): void {
    if (!isFinite(x) || !isFinite(y)) return;
    const m = this.st.m;
    m[0] *= x; m[1] *= x; m[2] *= y; m[3] *= y;
  }
  transform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    if (![a, b, c, d, e, f].every(isFinite)) return;
    this.st.m = multiply(this.st.m, [a, b, c, d, e, f]);
  }
  setTransform(a?: number | { a: number; b: number; c: number; d: number; e: number; f: number },
    b?: number, c?: number, d?: number, e?: number, f?: number): void {
    if (a === undefined) { this.st.m = identity(); return; }
    const v: number[] = typeof a === 'object' ? [a.a, a.b, a.c, a.d, a.e, a.f] : [a, b as number, c as number, d as number, e as number, f as number];
    if (!v.every(isFinite)) return;
    this.st.m = v as Mat2D;
  }
  resetTransform(): void { this.st.m = identity(); }
  getTransform(): { a: number; b: number; c: number; d: number; e: number; f: number } {
    const m = this.st.m;
    return { a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5] };
  }

  /* ── path ── */

  beginPath(): void { this.path.clear(); }
  closePath(): void { this.path.closePath(); }
  moveTo(x: number, y: number): void { this.path.moveTo(this.st.m, x, y); }
  lineTo(x: number, y: number): void { this.path.lineTo(this.st.m, x, y); }
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void {
    this.path.quadraticCurveTo(this.st.m, cpx, cpy, x, y);
  }
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void {
    this.path.bezierCurveTo(this.st.m, c1x, c1y, c2x, c2y, x, y);
  }
  rect(x: number, y: number, w: number, h: number): void { this.path.rect(this.st.m, x, y, w, h); }
  arc(x: number, y: number, r: number, start: number, end: number, anticlockwise = false): void {
    this.path.arc(this.st.m, x, y, r, start, end, !!anticlockwise);
  }
  ellipse(x: number, y: number, rx: number, ry: number, rotation: number,
    start: number, end: number, anticlockwise = false): void {
    this.path.ellipse(this.st.m, x, y, rx, ry, rotation, start, end, !!anticlockwise);
  }

  fill(fillRule: FillRule = 'nonzero'): void {
    const sink = this.paintSink(this.st.fill);
    const b = this.bounds();
    if (!sink || !b) return;
    fillPath(this.path.pts, this.path.subs, b, fillRule === 'evenodd', sink);
  }

  stroke(): void {
    const sink = this.paintSink(this.st.stroke);
    const b = this.bounds();
    if (!sink || !b) return;
    this.strokeWith(this.path, b, sink);
  }

  clip(fillRule: FillRule = 'nonzero'): void {
    const cur = this.st.clip;
    const r = this.path.asDeviceRect();
    if (r) {
      const x0 = Math.max(cur.x0, r[0]), y0 = Math.max(cur.y0, r[1]);
      const x1 = Math.max(x0, Math.min(cur.x1, r[2])), y1 = Math.max(y0, Math.min(cur.y1, r[3]));
      const W = this.canvas.width, H = this.canvas.height;
      const frac = (v: number, lim: number): boolean => v > 0 && v < lim && v !== Math.floor(v);
      const partial = frac(x0, W) || frac(x1, W) || frac(y0, H) || frac(y1, H);
      this.st.clip = { x0, y0, x1, y1, partial, mask: cur.mask, mb: cur.mb };
      return;
    }
    const W = this.canvas.width, H = this.canvas.height;
    const mask = new Float32Array(W * H);
    const old = cur.mask;
    const mb: IRect = { x0: W, y0: H, x1: 0, y1: 0 };
    const b = this.bounds();
    if (b) {
      fillPath(this.path.pts, this.path.subs, b, fillRule === 'evenodd', (y, x0, n, cov, off) => {
        const q = y * W + x0;
        for (let i = 0; i < n; i++) mask[q + i] = cov[off + i] * (old ? old[q + i] : 1);
        if (x0 < mb.x0) mb.x0 = x0;
        if (x0 + n > mb.x1) mb.x1 = x0 + n;
        if (y < mb.y0) mb.y0 = y;
        if (y + 1 > mb.y1) mb.y1 = y + 1;
      });
    }
    this.st.clip = { x0: cur.x0, y0: cur.y0, x1: cur.x1, y1: cur.y1, partial: cur.partial, mask, mb };
  }

  /* ── rectangles ── */

  fillRect(x: number, y: number, w: number, h: number): void {
    if (![x, y, w, h].every(isFinite) || w === 0 || h === 0) return;
    const sink = this.paintSink(this.st.fill);
    if (!sink) return;
    const m = this.st.m;
    if (isAxisAligned(m)) this.deviceRect(m[0] * x + m[4], m[3] * y + m[5], m[0] * (x + w) + m[4], m[3] * (y + h) + m[5], sink);
    else this.tempPath(x, y, w, h, sink);
  }

  strokeRect(x: number, y: number, w: number, h: number): void {
    if (![x, y, w, h].every(isFinite)) return;
    const sink = this.paintSink(this.st.stroke);
    const b = this.bounds();
    if (!sink || !b) return;
    const p = new PathBuilder();
    if (w === 0 || h === 0) { p.moveTo(this.st.m, x, y); p.lineTo(this.st.m, x + w, y + h); }
    else p.rect(this.st.m, x, y, w, h);
    this.strokeWith(p, b, sink);
  }

  clearRect(x: number, y: number, w: number, h: number): void {
    if (![x, y, w, h].every(isFinite) || w === 0 || h === 0) return;
    const data = this.canvas.image.data, W = this.canvas.width, clip = this.st.clip;
    const sink: RowSink = (yy, x0, n, cov, off) => {
      if (!applyClip(clip, W, yy, x0, n, cov, off)) return;
      let p = (yy * W + x0) * 4;
      for (let i = 0; i < n; i++, p += 4) {
        const c = cov[off + i];
        if (c <= 0) continue;
        if (c >= 1) { data[p] = data[p + 1] = data[p + 2] = data[p + 3] = 0; continue; }
        const a = data[p + 3] * (1 - c);
        data[p + 3] = a;
        if (data[p + 3] === 0) data[p] = data[p + 1] = data[p + 2] = 0;
      }
    };
    const m = this.st.m;
    if (isAxisAligned(m)) this.deviceRect(m[0] * x + m[4], m[3] * y + m[5], m[0] * (x + w) + m[4], m[3] * (y + h) + m[5], sink);
    else this.tempPath(x, y, w, h, sink);
  }

  /* ── gradients ── */

  createLinearGradient(x0: number, y0: number, x1: number, y1: number): RasterGradient {
    if (![x0, y0, x1, y1].every(isFinite)) throw new TypeError('createLinearGradient: non-finite argument');
    return new RasterGradient('linear', [x0, y0, x1, y1]);
  }
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): RasterGradient {
    if (![x0, y0, r0, x1, y1, r1].every(isFinite)) throw new TypeError('createRadialGradient: non-finite argument');
    if (r0 < 0 || r1 < 0) throw new RangeError('IndexSizeError: negative radius');
    return new RasterGradient('radial', [x0, y0, r0, x1, y1, r1]);
  }

  /* ── images ── */

  drawImage(src: ImageSource, a1: number, a2: number, a3?: number, a4?: number,
    a5?: number, a6?: number, a7?: number, a8?: number): void {
    let img = resolveImage(src);
    let sx = 0, sy = 0, sw = img.width, sh = img.height, dx: number, dy: number, dw: number, dh: number;
    if (a5 !== undefined) {
      sx = a1; sy = a2; sw = a3 as number; sh = a4 as number;
      dx = a5; dy = a6 as number; dw = a7 as number; dh = a8 as number;
    } else if (a3 !== undefined) {
      dx = a1; dy = a2; dw = a3; dh = a4 as number;
    } else {
      dx = a1; dy = a2; dw = sw; dh = sh;
    }
    if (![sx, sy, sw, sh, dx, dy, dw, dh].every(isFinite)) return;
    if (sw < 0) { sx += sw; sw = -sw; }
    if (sh < 0) { sy += sh; sh = -sh; }
    if (dw < 0) { dx += dw; dw = -dw; }
    if (dh < 0) { dy += dh; dh = -dh; }
    if (sw === 0 || sh === 0 || dw === 0 || dh === 0) return;
    // clip the source rectangle to the image, shrinking the destination proportionally
    const kx = dw / sw, ky = dh / sh;
    if (sx < 0) { dx -= sx * kx; dw += sx * kx; sw += sx; sx = 0; }
    if (sy < 0) { dy -= sy * ky; dh += sy * ky; sh += sy; sy = 0; }
    if (sx + sw > img.width) { const e = sx + sw - img.width; sw -= e; dw -= e * kx; }
    if (sy + sh > img.height) { const e = sy + sh - img.height; sh -= e; dh -= e * ky; }
    if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return;
    if (img === this.canvas.image) img = copyPixelImage(img);
    const b = this.bounds();
    if (!b) return;
    const st = this.st, m = st.m, alpha = st.alpha;
    const W = this.canvas.width, data = this.canvas.image.data, clip = st.clip;
    if (isAxisAligned(m) && m[0] > 0 && m[3] > 0) {
      const X0 = m[0] * dx + m[4], X1 = m[0] * (dx + dw) + m[4];
      const Y0 = m[3] * dy + m[5], Y1 = m[3] * (dy + dh) + m[5];
      const ix0 = Math.max(b.x0, Math.floor(X0)), ix1 = Math.min(b.x1, Math.ceil(X1));
      const iy0 = Math.max(b.y0, Math.floor(Y0)), iy1 = Math.min(b.y1, Math.ceil(Y1));
      if (ix1 <= ix0 || iy1 <= iy0) return;
      const filter: ResampleFilter = st.smoothing ? st.filter : 'nearest';
      onesBuf = grow(onesBuf, ix1 - ix0);
      const ones = onesBuf;
      resampleRows(img, sx, sy, sw, sh, X0, Y0, X1, Y1, ix0, iy0, ix1, iy1, filter, (y, x0, n, shade) => {
        ones.fill(1, 0, n);
        if (!applyClip(clip, W, y, x0, n, ones, 0)) return;
        blendShaded(data, (y * W + x0) * 4, n, ones, 0, shade, alpha);
      });
      return;
    }
    const inv = invert(m);
    if (!inv) return;
    const shader = imageShader(img, sx, sy, sw, sh, dx, dy, dw, dh, inv, !st.smoothing);
    const p = new PathBuilder();
    p.rect(m, dx, dy, dw, dh);
    fillPath(p.pts, p.subs, b, false, this.shaderSink(shader, alpha));
  }

  getImageData(sx: number, sy: number, sw: number, sh: number): PixelImage {
    sx = Math.trunc(sx); sy = Math.trunc(sy); sw = Math.trunc(sw); sh = Math.trunc(sh);
    if (!sw || !sh) throw new RangeError('IndexSizeError: getImageData with zero size');
    if (sw < 0) { sx += sw; sw = -sw; }
    if (sh < 0) { sy += sh; sh = -sh; }
    const out = createPixelImage(sw, sh);
    const src = this.canvas.image, W = src.width, H = src.height;
    const x0 = Math.max(0, sx), x1 = Math.min(W, sx + sw), y0 = Math.max(0, sy), y1 = Math.min(H, sy + sh);
    if (x1 <= x0) return out;
    for (let y = y0; y < y1; y++) {
      out.data.set(src.data.subarray((y * W + x0) * 4, (y * W + x1) * 4), ((y - sy) * sw + (x0 - sx)) * 4);
    }
    return out;
  }

  putImageData(img: PixelImage, dx: number, dy: number,
    dirtyX = 0, dirtyY = 0, dirtyW: number = img.width, dirtyH: number = img.height): void {
    dx = Math.trunc(dx); dy = Math.trunc(dy);
    dirtyX = Math.trunc(dirtyX); dirtyY = Math.trunc(dirtyY); dirtyW = Math.trunc(dirtyW); dirtyH = Math.trunc(dirtyH);
    if (dirtyW < 0) { dirtyX += dirtyW; dirtyW = -dirtyW; }
    if (dirtyH < 0) { dirtyY += dirtyH; dirtyH = -dirtyH; }
    if (dirtyX < 0) { dirtyW += dirtyX; dirtyX = 0; }
    if (dirtyY < 0) { dirtyH += dirtyY; dirtyY = 0; }
    dirtyW = Math.min(dirtyW, img.width - dirtyX);
    dirtyH = Math.min(dirtyH, img.height - dirtyY);
    const dst = this.canvas.image, W = dst.width, H = dst.height;
    const x0 = Math.max(0, dx + dirtyX), x1 = Math.min(W, dx + dirtyX + dirtyW);
    const y0 = Math.max(0, dy + dirtyY), y1 = Math.min(H, dy + dirtyY + dirtyH);
    if (x1 <= x0 || y1 <= y0) return;
    for (let y = y0; y < y1; y++) {
      const s = ((y - dy) * img.width + (x0 - dx)) * 4;
      dst.data.set(img.data.subarray(s, s + (x1 - x0) * 4), (y * W + x0) * 4);
    }
  }

  createImageData(w: number | PixelImage, h?: number): PixelImage {
    if (typeof w === 'object') return createPixelImage(w.width, w.height);
    const ww = Math.abs(Math.trunc(w)), hh = Math.abs(Math.trunc(h as number));
    if (!ww || !hh) throw new RangeError('IndexSizeError: createImageData with zero size');
    return createPixelImage(ww, hh);
  }

  /* ── internals ── */

  /** Integer drawing bounds: canvas ∩ clip; null when empty. */
  private bounds(): IRect | null {
    const c = this.st.clip, W = this.canvas.width, H = this.canvas.height;
    let x0 = Math.max(0, Math.floor(c.x0)), y0 = Math.max(0, Math.floor(c.y0));
    let x1 = Math.min(W, Math.ceil(c.x1)), y1 = Math.min(H, Math.ceil(c.y1));
    if (c.mb) {
      x0 = Math.max(x0, c.mb.x0); y0 = Math.max(y0, c.mb.y0);
      x1 = Math.min(x1, c.mb.x1); y1 = Math.min(y1, c.mb.y1);
    }
    return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null;
  }

  private paintSink(p: Paint): RowSink | null {
    const alpha = this.st.alpha;
    if (alpha <= 0) return null;
    let shader: Shader | null;
    if (p instanceof RasterGradient) {
      const inv = invert(this.st.m);
      shader = inv ? gradientShader(p, inv) : null;
    } else {
      if (p.a <= 0) return null;
      shader = solidShader(p);
    }
    return shader ? this.shaderSink(shader, alpha) : null;
  }

  private shaderSink(shader: Shader, alpha: number): RowSink {
    const data = this.canvas.image.data, W = this.canvas.width, clip = this.st.clip;
    const solid = shader.solid;
    if (solid) {
      const sa = solid.a * alpha, r = solid.r, g = solid.g, b = solid.b;
      return (y, x0, n, cov, off) => {
        if (!applyClip(clip, W, y, x0, n, cov, off)) return;
        blendSolid(data, (y * W + x0) * 4, n, cov, off, r, g, b, sa);
      };
    }
    return (y, x0, n, cov, off) => {
      if (!applyClip(clip, W, y, x0, n, cov, off)) return;
      shadeBuf = grow(shadeBuf, n * 4);
      shader.shadeRow(y, x0, n, shadeBuf);
      blendShaded(data, (y * W + x0) * 4, n, cov, off, shadeBuf, alpha);
    };
  }

  /** Axis-aligned device rectangle with exact fractional edge coverage. */
  private deviceRect(X0: number, Y0: number, X1: number, Y1: number, sink: RowSink): void {
    if (X1 < X0) { const t = X0; X0 = X1; X1 = t; }
    if (Y1 < Y0) { const t = Y0; Y0 = Y1; Y1 = t; }
    const b = this.bounds();
    if (!b) return;
    const ix0 = Math.max(b.x0, Math.floor(X0)), ix1 = Math.min(b.x1, Math.ceil(X1));
    const iy0 = Math.max(b.y0, Math.floor(Y0)), iy1 = Math.min(b.y1, Math.ceil(Y1));
    const n = ix1 - ix0;
    if (n <= 0 || iy1 <= iy0) return;
    rectCx = grow(rectCx, n);
    rectCov = grow(rectCov, n);
    const cx = rectCx, cov = rectCov;
    for (let i = 0; i < n; i++) {
      const x = ix0 + i;
      cx[i] = Math.min(x + 1, X1) - Math.max(x, X0);
    }
    for (let y = iy0; y < iy1; y++) {
      const cy = Math.min(y + 1, Y1) - Math.max(y, Y0);
      if (cy <= 0) continue;
      for (let i = 0; i < n; i++) cov[i] = cx[i] * cy;
      sink(y, ix0, n, cov, 0);
    }
  }

  /** Rectangle under a rotating/skewing transform, via the path rasterizer. */
  private tempPath(x: number, y: number, w: number, h: number, sink: RowSink): void {
    const b = this.bounds();
    if (!b) return;
    const p = new PathBuilder();
    p.rect(this.st.m, x, y, w, h);
    fillPath(p.pts, p.subs, b, false, sink);
  }

  private strokeWith(p: PathBuilder, b: IRect, sink: RowSink): void {
    const st = this.st, k = meanScale(st.m);
    if (!(k > 0)) return;
    let dash: number[] | null = null;
    if (st.dash.length) {
      let sum = 0;
      for (const d of st.dash) sum += d;
      if (sum > 0) dash = st.dash.map(d => d * k);
    }
    strokePath(p.pts, p.subs, {
      halfWidth: (st.lineWidth * k) / 2,
      cap: st.lineCap,
      join: st.lineJoin,
      miterLimit: st.miterLimit,
      dash,
      dashOffset: st.dashOffset * k
    }, b, sink);
  }
}
