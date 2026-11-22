/* ═══════════════════════════════════════════════════════════════════════════
   WGSL kernel loader: `//#include "file.wgsl"` resolution (include-once),
   generated prelude (defines + bvh/layout.ts + rays.ts declarations),
   compilation with error messages mapped back to file:line, explicit bind
   group layouts and async compute pipelines.

   Sources come in as a { name → text } map so the same loader works with
   Vite `?raw` imports (pathtracer/wgsl/index.ts) and with fs in Node.

   Bindings (shared by every traversal kernel):
     group 0 = scene  : 0 nodes, 1 tris, 2 instances (read-only storage),
                        3 debug counters (storage, atomics)
     group 1 = I/O    : 0 params (uniform), 1 rays (read-only storage),
                        2 output (storage: hits or occlusion flags)
   ═══════════════════════════════════════════════════════════════════════════ */

import { emitWgslLayout } from './bvh/layout.ts';
import { KERNEL_STACK_SIZE } from './bvh/traverse-ref.ts';
import { BUFFER, STAGE } from './gpu-flags.ts';
import { PARAMS_BYTES, PARAMS_W, emitWgslRays } from './rays.ts';

export type WgslSources = Readonly<Record<string, string>>;

export interface SourceLine {
  file: string;
  line: number;
}

export interface ResolvedSource {
  code: string;
  /** origin of every line of `code` (1-based line numbers) */
  lines: SourceLine[];
}

const INCLUDE_RE = /^\s*\/\/#include\s+"([^"]+)"\s*$/;

/** Inline `//#include "x.wgsl"` lines recursively; each file is included once. */
export function resolveIncludes(entry: string, sources: WgslSources, seen: Set<string> = new Set()): ResolvedSource {
  const out: ResolvedSource = { code: '', lines: [] };
  const code: string[] = [];
  const visit = (file: string, from: string) => {
    if (seen.has(file)) return;
    const text = sources[file];
    if (text === undefined) throw new Error(`${from}: //#include "${file}" — no such WGSL source`);
    seen.add(file);
    const src = text.replace(/\r\n?/g, '\n').split('\n');
    src.forEach((l, i) => {
      const m = INCLUDE_RE.exec(l);
      if (m) visit(m[1], `${file}:${i + 1}`);
      else { code.push(l); out.lines.push({ file, line: i + 1 }); }
    });
  };
  visit(entry, '<entry>');
  out.code = code.join('\n');
  return out;
}

export type KernelDefines = Record<string, number | boolean>;

/** Loader-level constants (WGSL `const`s). B5_TRAVERSE_STACK sizes the private stack. */
export const DEFAULT_DEFINES: KernelDefines = { B5_TRAVERSE_STACK: KERNEL_STACK_SIZE };

function emitDefines(defines: KernelDefines): string {
  const lines = ['// loader defines (pathtracer/kernels.ts)'];
  for (const [k, v] of Object.entries(defines)) {
    if (!/^B5_[A-Z0-9_]+$/.test(k)) throw new Error(`define ${k}: must match B5_[A-Z0-9_]+`);
    if (typeof v === 'boolean') lines.push(`const ${k}: bool = ${v};`);
    else if (Number.isInteger(v) && v >= 0) lines.push(`const ${k}: u32 = ${v}u;`);
    else lines.push(`const ${k}: f32 = ${Number(v).toExponential()};`);
  }
  return lines.join('\n') + '\n';
}

/** Full module source of one kernel: defines + generated layouts + includes. */
export function buildKernelSource(entry: string, sources: WgslSources, defines: KernelDefines = {}): ResolvedSource {
  const parts: [string, string][] = [
    ['<defines>', emitDefines({ ...DEFAULT_DEFINES, ...defines })],
    ['<bvh/layout.ts>', emitWgslLayout()],
    ['<rays.ts>', emitWgslRays()]
  ];
  const code: string[] = [];
  const lines: SourceLine[] = [];
  for (const [file, text] of parts) {
    text.split('\n').forEach((l, i) => { code.push(l); lines.push({ file, line: i + 1 }); });
  }
  const body = resolveIncludes(entry, sources);
  return { code: code.join('\n') + '\n' + body.code, lines: lines.concat(body.lines) };
}

export const KERNELS = {
  intersect: { file: 'k_intersect.wgsl', entryPoint: 'b5_k_intersect' },
  shadow: { file: 'k_shadow.wgsl', entryPoint: 'b5_k_shadow' }
} as const;
export type KernelName = keyof typeof KERNELS;

export const DEFAULT_WORKGROUP_SIZE = 64;

interface CompilationMessageLike {
  type: string;
  message: string;
  lineNum: number;
  linePos: number;
}

/** "file:line:col: error: message" lines, mapped through the include map. */
export function formatCompilationMessages(messages: readonly CompilationMessageLike[], src: ResolvedSource): string {
  return messages.map((m) => {
    const o = src.lines[m.lineNum - 1];
    const where = o ? `${o.file}:${o.line}:${m.linePos}` : `<generated>:${m.lineNum}:${m.linePos}`;
    const text = src.code.split('\n')[m.lineNum - 1] ?? '';
    return `${where}: ${m.type}: ${m.message}\n    ${text.trim()}`;
  }).join('\n');
}

/** createShaderModule + getCompilationInfo; throws with mapped messages on error. */
export async function compileShader(device: GPUDevice, label: string, src: ResolvedSource): Promise<GPUShaderModule> {
  device.pushErrorScope('validation');
  const module = device.createShaderModule({ label, code: src.code });
  const info = await module.getCompilationInfo();
  const scopeErr = await device.popErrorScope();
  const errors = info.messages.filter((m) => m.type === 'error');
  if (errors.length || scopeErr) {
    throw new Error(`WGSL ${label} failed to compile:\n${formatCompilationMessages(errors, src)}${scopeErr ? '\n' + scopeErr.message : ''}`);
  }
  const warnings = info.messages.filter((m) => m.type === 'warning');
  if (warnings.length) console.warn(`WGSL ${label}:\n${formatCompilationMessages(warnings, src)}`);
  return module;
}

export function createSceneLayout(device: GPUDevice): GPUBindGroupLayout {
  const ro = { type: 'read-only-storage' } as const;
  return device.createBindGroupLayout({
    label: 'b5 scene',
    entries: [
      { binding: 0, visibility: STAGE.COMPUTE, buffer: ro },
      { binding: 1, visibility: STAGE.COMPUTE, buffer: ro },
      { binding: 2, visibility: STAGE.COMPUTE, buffer: ro },
      { binding: 3, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } }
    ]
  });
}

export function createIoLayout(device: GPUDevice): GPUBindGroupLayout {
  return device.createBindGroupLayout({
    label: 'b5 trace io',
    entries: [
      { binding: 0, visibility: STAGE.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: STAGE.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: STAGE.COMPUTE, buffer: { type: 'storage' } }
    ]
  });
}

export interface KernelOptions {
  defines?: KernelDefines;
  /** pipeline-overridable workgroup size (override B5_WG_SIZE) */
  workgroupSize?: number;
}

export interface PtKernels {
  pipelines: Record<KernelName, GPUComputePipeline>;
  sceneLayout: GPUBindGroupLayout;
  ioLayout: GPUBindGroupLayout;
  workgroupSize: number;
  defines: KernelDefines;
  /** wall time of shader compilation + pipeline creation, ms */
  compileMs: number;
}

export async function createKernels(device: GPUDevice, sources: WgslSources, opts: KernelOptions = {}): Promise<PtKernels> {
  const t0 = performance.now();
  const workgroupSize = opts.workgroupSize ?? DEFAULT_WORKGROUP_SIZE;
  const defines = { ...DEFAULT_DEFINES, ...opts.defines };
  const sceneLayout = createSceneLayout(device);
  const ioLayout = createIoLayout(device);
  const layout = device.createPipelineLayout({ label: 'b5 trace', bindGroupLayouts: [sceneLayout, ioLayout] });
  const names = Object.keys(KERNELS) as KernelName[];
  /* modules one after another (error scopes are a stack — interleaved
     push/pop would attribute errors to the wrong module), pipelines in parallel */
  const modules: GPUShaderModule[] = [];
  for (const name of names) {
    const k = KERNELS[name];
    modules.push(await compileShader(device, k.file, buildKernelSource(k.file, sources, defines)));
  }
  const built = await Promise.all(names.map((name, i) => {
    const k = KERNELS[name];
    const module = modules[i];
    return device.createComputePipelineAsync({
      label: k.entryPoint,
      layout,
      compute: { module, entryPoint: k.entryPoint, constants: { B5_WG_SIZE: workgroupSize } }
    });
  }));
  const pipelines = Object.fromEntries(names.map((n, i) => [n, built[i]])) as Record<KernelName, GPUComputePipeline>;
  return { pipelines, sceneLayout, ioLayout, workgroupSize, defines, compileMs: performance.now() - t0 };
}

/** Workgroup grid for `count` invocations: 1-D up to maxPerDim groups, then split over y. */
export function dispatchSize(count: number, workgroupSize: number, maxPerDim = 65535): [number, number] {
  const groups = Math.max(1, Math.ceil(count / workgroupSize));
  if (groups <= maxPerDim) return [groups, 1];
  const y = Math.ceil(groups / maxPerDim);
  return [Math.ceil(groups / y), y];
}

/* ─── per-batch I/O ───────────────────────────────────────────────────────── */

export interface TraceBatch {
  kind: KernelName;
  capacity: number;
  params: GPUBuffer;
  rays: GPUBuffer;
  out: GPUBuffer;
  bindGroup: GPUBindGroup;
  destroy(): void;
}

/**
 * Params + ray + output buffers for up to `capacity` rays. Output stride:
 * HIT_BYTES (intersect) or 4 (shadow). Rays are written with
 * device.queue.writeBuffer(batch.rays, …) — or produced by another kernel.
 */
export function createTraceBatch(
  device: GPUDevice, kernels: PtKernels, kind: KernelName, capacity: number,
  rayBytes: number, outStride: number
): TraceBatch {
  const params = device.createBuffer({ label: `b5 ${kind} params`, size: PARAMS_BYTES, usage: BUFFER.UNIFORM | BUFFER.COPY_DST });
  const rays = device.createBuffer({ label: `b5 ${kind} rays`, size: Math.max(16, capacity * rayBytes), usage: BUFFER.STORAGE | BUFFER.COPY_DST });
  const out = device.createBuffer({ label: `b5 ${kind} out`, size: Math.max(16, capacity * outStride), usage: BUFFER.STORAGE | BUFFER.COPY_SRC });
  const bindGroup = device.createBindGroup({
    label: `b5 ${kind} io`,
    layout: kernels.ioLayout,
    entries: [
      { binding: 0, resource: { buffer: params } },
      { binding: 1, resource: { buffer: rays } },
      { binding: 2, resource: { buffer: out } }
    ]
  });
  return {
    kind, capacity, params, rays, out, bindGroup,
    destroy() { params.destroy(); rays.destroy(); out.destroy(); }
  };
}

/** Write the params uniform (queue order: call before the submit that dispatches). */
export function writeTraceParams(device: GPUDevice, batch: TraceBatch, count: number, mask: number, root: number, mode = 0): void {
  if (count > batch.capacity) throw new RangeError(`${count} rays > batch capacity ${batch.capacity}`);
  const p = new Uint32Array(PARAMS_BYTES / 4);
  p[PARAMS_W.count] = count;
  p[PARAMS_W.mask] = mask;
  p[PARAMS_W.root] = root;
  p[PARAMS_W.mode] = mode;
  device.queue.writeBuffer(batch.params, 0, p);
}

/** Record one traversal dispatch into an open compute pass. */
export function encodeTrace(
  pass: GPUComputePassEncoder, kernels: PtKernels, batch: TraceBatch,
  sceneBindGroup: GPUBindGroup, count: number, maxPerDim = 65535
): void {
  pass.setPipeline(kernels.pipelines[batch.kind]);
  pass.setBindGroup(0, sceneBindGroup);
  pass.setBindGroup(1, batch.bindGroup);
  const [x, y] = dispatchSize(count, kernels.workgroupSize, maxPerDim);
  pass.dispatchWorkgroups(x, y);
}
