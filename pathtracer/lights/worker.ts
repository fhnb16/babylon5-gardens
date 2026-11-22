/* Module worker: builds the light BVH + alias table and packs the light data
   buffer off the main thread (lights/pack-async.ts is the client). */
import { packLights, type LightList } from './light-data.ts';

export interface LightPackRequest {
  id: number;
  list: Pick<LightList, 'count' | 'verts' | 'inst' | 'tri' | 'area'>;
  phi: Float32Array;
}

export interface LightPackResponse {
  id: number;
  data?: ArrayBuffer;
  nLights?: number;
  nNodes?: number;
  totalPhi?: number;
  active?: number;
  buildMs?: number;
  error?: string;
}

interface WorkerScope {
  onmessage: ((ev: MessageEvent<LightPackRequest>) => void) | null;
  postMessage(msg: LightPackResponse, transfer: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;
scope.onmessage = (ev) => {
  const { id, list, phi } = ev.data;
  try {
    const p = packLights(list, phi);
    scope.postMessage({ id, data: p.data, nLights: p.nLights, nNodes: p.nNodes, totalPhi: p.totalPhi, active: p.active, buildMs: p.buildMs }, [p.data]);
  } catch (e) {
    scope.postMessage({ id, error: e instanceof Error ? e.message : String(e) }, []);
  }
};
