/* ═══════════════════════════════════════════════════════════════════════════
   Packed scene (bvh/pack.ts) → GPU storage buffers + the group-0 bind group
   of the traversal kernels. Buffers are created at least 64 B large (a
   zero-sized binding is invalid; a scene without instances still binds).
   updateDynamic() byte ranges can be re-uploaded with writeRanges().
   ═══════════════════════════════════════════════════════════════════════════ */

import { BUFFER, MAP } from './gpu-flags.ts';
import { DBG_BYTES, DBG_W } from './rays.ts';
import type { PtKernels } from './kernels.ts';

export interface PackedSceneLike {
  nodes: ArrayBuffer;
  tris: ArrayBuffer;
  instances: ArrayBuffer;
  tlasRoot: number;
}

export interface GpuScene {
  nodes: GPUBuffer;
  tris: GPUBuffer;
  instances: GPUBuffer;
  dbg: GPUBuffer;
  tlasRoot: number;
  bindGroup: GPUBindGroup;
  /** total bytes of the three scene buffers */
  bytes: number;
  /** re-upload byte ranges ([offset, length] pairs) of the CPU-side buffers */
  writeRanges(which: 'nodes' | 'instances', src: ArrayBuffer, ranges: [number, number][]): void;
  /** zero the debug counters (queue order) */
  resetDebug(): void;
  /** read the debug counters (copies through a MAP_READ buffer) */
  readDebug(): Promise<{ stackOverflow: number }>;
  destroy(): void;
}

const MIN_BYTES = 64;

function storageBuffer(device: GPUDevice, label: string, data: ArrayBuffer): GPUBuffer {
  const size = Math.max(MIN_BYTES, Math.ceil(data.byteLength / 4) * 4);
  const buf = device.createBuffer({ label, size, usage: BUFFER.STORAGE | BUFFER.COPY_DST, mappedAtCreation: true });
  new Uint8Array(buf.getMappedRange()).set(new Uint8Array(data));
  buf.unmap();
  return buf;
}

export function uploadScene(device: GPUDevice, kernels: PtKernels, scene: PackedSceneLike): GpuScene {
  const maxBinding = device.limits.maxStorageBufferBindingSize;
  for (const [k, b] of [['nodes', scene.nodes], ['tris', scene.tris], ['instances', scene.instances]] as const) {
    if (b.byteLength > maxBinding) throw new RangeError(`scene ${k}: ${b.byteLength} B > maxStorageBufferBindingSize ${maxBinding}`);
  }
  const nodes = storageBuffer(device, 'b5 nodes', scene.nodes);
  const tris = storageBuffer(device, 'b5 tris', scene.tris);
  const instances = storageBuffer(device, 'b5 instances', scene.instances);
  const dbg = device.createBuffer({ label: 'b5 dbg', size: DBG_BYTES, usage: BUFFER.STORAGE | BUFFER.COPY_SRC | BUFFER.COPY_DST });
  const bindGroup = device.createBindGroup({
    label: 'b5 scene',
    layout: kernels.sceneLayout,
    entries: [
      { binding: 0, resource: { buffer: nodes } },
      { binding: 1, resource: { buffer: tris } },
      { binding: 2, resource: { buffer: instances } },
      { binding: 3, resource: { buffer: dbg } }
    ]
  });
  return {
    nodes, tris, instances, dbg, bindGroup,
    tlasRoot: scene.tlasRoot,
    bytes: scene.nodes.byteLength + scene.tris.byteLength + scene.instances.byteLength,
    writeRanges(which, src, ranges) {
      const dst = which === 'nodes' ? nodes : instances;
      for (const [off, len] of ranges) device.queue.writeBuffer(dst, off, src, off, len);
    },
    resetDebug() {
      device.queue.writeBuffer(dbg, 0, new Uint32Array(DBG_BYTES / 4));
    },
    async readDebug() {
      const rb = device.createBuffer({ size: DBG_BYTES, usage: BUFFER.MAP_READ | BUFFER.COPY_DST });
      const enc = device.createCommandEncoder();
      enc.copyBufferToBuffer(dbg, 0, rb, 0, DBG_BYTES);
      device.queue.submit([enc.finish()]);
      await rb.mapAsync(MAP.READ);
      const u = new Uint32Array(rb.getMappedRange().slice(0));
      rb.unmap();
      rb.destroy();
      return { stackOverflow: u[DBG_W.stackOverflow] };
    },
    destroy() { nodes.destroy(); tris.destroy(); instances.destroy(); dbg.destroy(); }
  };
}

/** Copy a GPU buffer region to the CPU (MAP_READ staging buffer). */
export async function readBuffer(device: GPUDevice, src: GPUBuffer, bytes: number, offset = 0): Promise<ArrayBuffer> {
  const size = Math.ceil(bytes / 4) * 4;
  const rb = device.createBuffer({ size: Math.max(4, size), usage: BUFFER.MAP_READ | BUFFER.COPY_DST });
  const enc = device.createCommandEncoder();
  enc.copyBufferToBuffer(src, offset, rb, 0, size);
  device.queue.submit([enc.finish()]);
  await rb.mapAsync(MAP.READ);
  const out = rb.getMappedRange().slice(0, bytes);
  rb.unmap();
  rb.destroy();
  return out;
}
