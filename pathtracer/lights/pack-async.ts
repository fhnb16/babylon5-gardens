/* Light packing off the main thread when a module Worker is available
   (browser), synchronously otherwise (Node tests). The worker result carries
   the packed buffer only; the tree object (CPU pmf checks) is kept only on
   the synchronous path. */
import { packLights, type LightList, type PackedLights } from './light-data.ts';
import type { LightPackRequest, LightPackResponse } from './worker.ts';

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, (r: LightPackResponse) => void>();

function getWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === 'undefined') return null;
  try {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'b5-light-pack' });
    worker.onmessage = (ev: MessageEvent<LightPackResponse>) => {
      const cb = pending.get(ev.data.id);
      pending.delete(ev.data.id);
      cb?.(ev.data);
    };
    return worker;
  } catch {
    return null;
  }
}

export async function packLightsAsync(
  list: Pick<LightList, 'count' | 'verts' | 'inst' | 'tri' | 'area'>, phi: Float32Array, useWorker = true
): Promise<PackedLights> {
  const w = useWorker ? getWorker() : null;
  if (!w) return packLights(list, phi);
  const id = nextId++;
  const req: LightPackRequest = {
    id, phi: phi.slice(),
    list: { count: list.count, verts: list.verts.slice(), inst: list.inst.slice(), tri: list.tri.slice(), area: list.area.slice() }
  };
  const res = await new Promise<LightPackResponse>((resolve) => {
    pending.set(id, resolve);
    w.postMessage(req, [req.phi.buffer, req.list.verts.buffer, req.list.inst.buffer, req.list.tri.buffer, req.list.area.buffer]);
  });
  if (res.error || !res.data) throw new Error(`light pack worker: ${res.error ?? 'no data'}`);
  return {
    data: res.data, tree: { nodes: [], leafOf: new Uint32Array(0) }, nLights: res.nLights!, nNodes: res.nNodes!,
    totalPhi: res.totalPhi!, active: res.active!, buildMs: res.buildMs!
  };
}
