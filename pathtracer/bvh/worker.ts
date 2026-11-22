/* ═══════════════════════════════════════════════════════════════════════════
   BLAS build worker (module worker).

   Request : { id, positions: Float32Array, index?: Uint16Array|Uint32Array,
               options?: BlasBuildOptions }
   Response: { id, ok: true, nodes, tris (ArrayBuffers, transferred),
               nodeCount, triCount, bounds, maxDepth, leafCount, ms }
           | { id, ok: false, error }

   handleBuildRequest() is the same code path, callable synchronously (Node
   tests, no-Worker fallback in pool.ts). Importing this module outside a
   worker has no side effects.
   ═══════════════════════════════════════════════════════════════════════════ */

import { buildPackedBlas, type BlasBuildOptions } from './pack.ts';

export interface BuildRequest {
  id: number;
  positions: Float32Array;
  index?: Uint16Array | Uint32Array | null;
  options?: BlasBuildOptions;
}

export type BuildResponse =
  | {
      id: number;
      ok: true;
      nodes: ArrayBuffer;
      tris: ArrayBuffer;
      nodeCount: number;
      triCount: number;
      bounds: Float32Array;
      maxDepth: number;
      leafCount: number;
      ms: number;
    }
  | { id: number; ok: false; error: string };

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Build + pack; returns the response and the list of buffers to transfer. */
export function handleBuildRequest(req: BuildRequest): { response: BuildResponse; transfer: ArrayBuffer[] } {
  try {
    const t0 = now();
    const p = buildPackedBlas(req.positions, req.index ?? null, req.options ?? {});
    const ms = now() - t0;
    return {
      response: {
        id: req.id, ok: true,
        nodes: p.nodes, tris: p.tris,
        nodeCount: p.nodeCount, triCount: p.triCount,
        bounds: p.bounds, maxDepth: p.maxDepth, leafCount: p.leafCount, ms
      },
      transfer: [p.nodes, p.tris]
    };
  } catch (e) {
    return { response: { id: req.id, ok: false, error: String((e as Error)?.stack ?? e) }, transfer: [] };
  }
}

/* worker entry: only when running inside a WorkerGlobalScope */
interface WorkerScopeLike {
  onmessage: ((ev: { data: BuildRequest }) => void) | null;
  postMessage(msg: unknown, transfer: Transferable[]): void;
}
const g = globalThis as unknown as { WorkerGlobalScope?: new () => unknown };
if (typeof g.WorkerGlobalScope === 'function' && globalThis instanceof g.WorkerGlobalScope) {
  const scope = globalThis as unknown as WorkerScopeLike;
  scope.onmessage = (ev) => {
    const { response, transfer } = handleBuildRequest(ev.data);
    scope.postMessage(response, transfer);
  };
}
