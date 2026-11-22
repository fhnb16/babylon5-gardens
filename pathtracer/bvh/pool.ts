/* ═══════════════════════════════════════════════════════════════════════════
   Tiny worker pool for BLAS builds: hardwareConcurrency − 1 module workers
   (at least 1), FIFO queue, one job per worker at a time. Where `Worker` is
   unavailable (Node, tests) or a worker cannot be created, jobs run
   synchronously in the calling thread through the same handleBuildRequest().

   Input arrays are structured-cloned (not transferred) unless the request
   says `transfer: true`, so SceneDesc geometry stays usable by the caller.
   ═══════════════════════════════════════════════════════════════════════════ */

import type { BlasBuildOptions, PackedBlas } from './pack.ts';
import { handleBuildRequest, type BuildRequest, type BuildResponse } from './worker.ts';

export interface WorkerLike {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  onmessage: ((ev: { data: BuildResponse }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  terminate(): void;
}

export interface PoolBuildInput {
  positions: Float32Array;
  index?: Uint16Array | Uint32Array | null;
  options?: BlasBuildOptions;
  /** transfer the input buffers to the worker (caller loses them) */
  transfer?: boolean;
}

export interface PooledBlas extends PackedBlas {
  /** build + pack time inside the worker, ms */
  ms: number;
}

export interface BvhPool {
  readonly size: number;
  /** true when builds run on real workers */
  readonly threaded: boolean;
  build(input: PoolBuildInput): Promise<PooledBlas>;
  buildAll(inputs: PoolBuildInput[]): Promise<PooledBlas[]>;
  terminate(): void;
}

export interface PoolOptions {
  /** number of workers (default max(1, hardwareConcurrency − 1)) */
  size?: number;
  /** worker factory; return null to fall back to synchronous builds */
  createWorker?: () => WorkerLike | null;
}

function defaultWorker(): WorkerLike | null {
  if (typeof Worker === 'undefined') return null;
  try {
    return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike;
  } catch {
    return null;
  }
}

function toBlas(r: BuildResponse): PooledBlas {
  if (!r.ok) throw new Error(`BVH worker: ${r.error}`);
  return {
    nodes: r.nodes, nodeCount: r.nodeCount, tris: r.tris, triCount: r.triCount,
    bounds: r.bounds, maxDepth: r.maxDepth, leafCount: r.leafCount, ms: r.ms
  };
}

export function createBvhPool(opts: PoolOptions = {}): BvhPool {
  const hc = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 2;
  const size = Math.max(1, opts.size ?? hc - 1);
  const factory = opts.createWorker ?? defaultWorker;

  interface Job { req: BuildRequest; transfer: Transferable[]; resolve: (b: PooledBlas) => void; reject: (e: unknown) => void }
  const workers: WorkerLike[] = [];
  const busy: (Job | null)[] = [];
  const queue: Job[] = [];
  let nextId = 1;

  for (let i = 0; i < size; i++) {
    const w = factory();
    if (!w) break;
    const slot = workers.length;
    workers.push(w);
    busy.push(null);
    w.onmessage = (ev) => {
      const job = busy[slot];
      busy[slot] = null;
      if (job) {
        try { job.resolve(toBlas(ev.data)); } catch (e) { job.reject(e); }
      }
      pump();
    };
    w.onerror = (ev) => {
      const job = busy[slot];
      busy[slot] = null;
      if (job) job.reject(ev);
      pump();
    };
  }
  const threaded = workers.length > 0;

  function pump(): void {
    for (let i = 0; i < workers.length && queue.length; i++) {
      if (busy[i]) continue;
      const job = queue.shift()!;
      busy[i] = job;
      workers[i].postMessage(job.req, job.transfer);
    }
  }

  function build(input: PoolBuildInput): Promise<PooledBlas> {
    const req: BuildRequest = { id: nextId++, positions: input.positions, index: input.index ?? null, options: input.options };
    if (!threaded) {
      return new Promise((resolve, reject) => {
        try { resolve(toBlas(handleBuildRequest(req).response)); } catch (e) { reject(e); }
      });
    }
    const transfer: Transferable[] = [];
    if (input.transfer) {
      transfer.push(input.positions.buffer as ArrayBuffer);
      if (input.index && input.index.buffer !== input.positions.buffer) transfer.push(input.index.buffer as ArrayBuffer);
    }
    return new Promise((resolve, reject) => {
      queue.push({ req, transfer, resolve, reject });
      pump();
    });
  }

  return {
    size: threaded ? workers.length : 1,
    threaded,
    build,
    buildAll: (inputs) => Promise.all(inputs.map(build)),
    terminate() {
      for (const w of workers) w.terminate();
      workers.length = 0;
      for (const j of queue) j.reject(new Error('pool terminated'));
      queue.length = 0;
    }
  };
}
