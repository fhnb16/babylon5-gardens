/* ═══════════════════════════════════════════════════════════════════════════
   Texture worker (module worker): generates core/textures images off the
   main thread.

   in : { id, specs: TextureSpec[], clear?: boolean }
   out: { id, images: [{ key, width, height, data }], ms }   (data transferred)
        { id, error }                                          on failure

   `key` is specKey(spec). The worker keeps the core memo cache between
   messages, so derived maps (normals, water) reuse their sources; pixels are
   copied before transfer so the cache stays intact. `clear: true` drops the
   cache after the batch (send it with the last batch of a world build).
   ═══════════════════════════════════════════════════════════════════════════ */

import { generateImage, specKey, clearImageCache } from '../../core/textures/index.ts';
import type { TextureSpec } from '../../core/scene/types.ts';

export interface TextureRequest {
  id: number;
  specs: TextureSpec[];
  clear?: boolean;
}

export interface TextureImageMsg {
  key: string;
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export type TextureResponse =
  | { id: number; images: TextureImageMsg[]; ms: number; error?: undefined }
  | { id: number; error: string };

interface WorkerScope {
  onmessage: ((e: MessageEvent<TextureRequest>) => void) | null;
  postMessage(msg: TextureResponse, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (e: MessageEvent<TextureRequest>): void => {
  const { id, specs, clear } = e.data;
  try {
    const t0 = performance.now();
    const images: TextureImageMsg[] = [];
    const transfer: Transferable[] = [];
    for (const s of specs) {
      const im = generateImage(s);
      const data = new Uint8ClampedArray(im.data);
      images.push({ key: specKey(s), width: im.width, height: im.height, data });
      transfer.push(data.buffer);
    }
    if (clear) clearImageCache();
    scope.postMessage({ id, images, ms: performance.now() - t0 }, transfer);
  } catch (err) {
    scope.postMessage({ id, error: String((err as Error)?.stack || err) });
  }
};
