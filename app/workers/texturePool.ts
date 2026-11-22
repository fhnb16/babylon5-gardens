/* ═══════════════════════════════════════════════════════════════════════════
   Texture worker pool: hardwareConcurrency − 1 module workers running
   core/textures, with a synchronous main-thread fallback (no Worker support,
   worker failed to load, or `workers: 0`).

   generate(specs) → Map<specKey, PixelImage>. Specs that share a source
   (hull albedo → hull normal, hull mask → water maps, facade map → facade
   normal …) go to the SAME worker, so each source is drawn once; groups are
   balanced across workers by pixel count (longest first).
   ═══════════════════════════════════════════════════════════════════════════ */

import { generateImage, specKey, specSize, clearImageCache } from '../../core/textures/index.ts';
import type { PixelImage } from '../../core/raster/index.ts';
import type { TextureSpec } from '../../core/scene/types.ts';
import type { TextureRequest, TextureResponse } from './textures.worker.ts';

export interface TexturePoolOptions {
  /** number of workers; default max(1, hardwareConcurrency − 1); 0 = synchronous */
  workers?: number;
}

export interface GenerateOptions {
  /** drop the workers' memo caches after this batch (last batch of a build) */
  clear?: boolean;
}

export interface TexturePool {
  /** live workers (0 ⇒ synchronous fallback) */
  readonly workers: number;
  generate(specs: TextureSpec[], opts?: GenerateOptions): Promise<Map<string, PixelImage>>;
  dispose(): void;
}

/** Key of the spec that has to be drawn first (multi-output collapsed). */
function rootKey(s: TextureSpec): string {
  const a = s.args;
  if (s.gen === 'heightToNormal' && a.src) return rootKey(a.src as TextureSpec);
  if ((s.gen === 'waterRoughness' || s.gen === 'waterNormal') && a.mask) return rootKey(a.mask as TextureSpec);
  const rest: Record<string, unknown> = { ...a };
  delete rest.output;
  return specKey({ gen: s.gen, args: rest });
}

function cost(s: TextureSpec): number {
  try {
    const { width, height } = specSize(s);
    return width * height;
  } catch {
    return 1;
  }
}

function generateSync(specs: TextureSpec[], clear: boolean): Map<string, PixelImage> {
  const out = new Map<string, PixelImage>();
  for (const s of specs) out.set(specKey(s), generateImage(s));
  if (clear) clearImageCache();
  return out;
}

function defaultWorkers(): number {
  const hc = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 2;
  return Math.max(1, hc - 1);
}

interface Pending {
  resolve: (images: Map<string, PixelImage>) => void;
  reject: (err: Error) => void;
  specs: TextureSpec[];
  clear: boolean;
}

export function createTexturePool(opts: TexturePoolOptions = {}): TexturePool {
  const want = opts.workers !== undefined ? Math.max(0, Math.floor(opts.workers)) : defaultWorkers();
  let workers: Worker[] = [];
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let broken = false;

  /* A worker that fails to load (or crashes) turns the pool synchronous:
     everything in flight is redone on the main thread. */
  const fallBack = (why: unknown): void => {
    if (broken) return;
    broken = true;
    console.warn('texturePool: workers unavailable, generating on the main thread:', why);
    for (const w of workers) w.terminate();
    workers = [];
    for (const [id, p] of pending) {
      pending.delete(id);
      try { p.resolve(generateSync(p.specs, p.clear)); } catch (e) { p.reject(e as Error); }
    }
  };

  if (want > 0 && typeof Worker !== 'undefined') {
    try {
      for (let i = 0; i < want; i++) {
        const w = new Worker(new URL('./textures.worker.ts', import.meta.url), { type: 'module', name: `textures-${i}` });
        w.onmessage = (e: MessageEvent<TextureResponse>): void => {
          const r = e.data;
          const p = pending.get(r.id);
          if (!p) return;
          pending.delete(r.id);
          if (r.error !== undefined) {
            p.reject(new Error(`texture worker: ${r.error}`));
            return;
          }
          const out = new Map<string, PixelImage>();
          for (const im of r.images) out.set(im.key, { width: im.width, height: im.height, data: im.data });
          p.resolve(out);
        };
        w.onerror = (e: ErrorEvent): void => { e.preventDefault(); fallBack(e.message || e); };
        workers.push(w);
      }
    } catch (e) {
      fallBack(e);
    }
  }

  const send = (w: Worker, specs: TextureSpec[], clear: boolean): Promise<Map<string, PixelImage>> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject, specs, clear });
      const msg: TextureRequest = { id, specs, clear };
      w.postMessage(msg);
    });

  return {
    get workers(): number { return workers.length; },

    async generate(specs: TextureSpec[], gopts: GenerateOptions = {}): Promise<Map<string, PixelImage>> {
      const clear = !!gopts.clear;
      /* dedupe by canonical key */
      const uniq = new Map<string, TextureSpec>();
      for (const s of specs) uniq.set(specKey(s), s);
      const list = [...uniq.values()];
      if (!workers.length || broken) return generateSync(list, clear);

      /* group by root source, then longest-processing-time-first onto workers */
      const groups = new Map<string, { specs: TextureSpec[]; cost: number }>();
      for (const s of list) {
        const k = rootKey(s);
        let g = groups.get(k);
        if (!g) { g = { specs: [], cost: 0 }; groups.set(k, g); }
        g.specs.push(s);
        g.cost += cost(s);
      }
      const load = workers.map(() => ({ specs: [] as TextureSpec[], cost: 0 }));
      for (const g of [...groups.values()].sort((a, b) => b.cost - a.cost)) {
        let best = load[0];
        for (const l of load) if (l.cost < best.cost) best = l;
        best.specs.push(...g.specs);
        best.cost += g.cost;
      }
      const parts = await Promise.all(workers.map((w, i) =>
        load[i].specs.length || clear ? send(w, load[i].specs, clear) : Promise.resolve(new Map<string, PixelImage>())));
      const out = new Map<string, PixelImage>();
      for (const p of parts) for (const [k, v] of p) out.set(k, v);
      return out;
    },

    dispose(): void {
      for (const w of workers) w.terminate();
      workers = [];
      for (const [id, p] of pending) {
        pending.delete(id);
        p.reject(new Error('texturePool disposed'));
      }
    }
  };
}
