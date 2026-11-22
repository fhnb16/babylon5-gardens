/* ═══════════════════════════════════════════════════════════════════════════
   GPUDevice for the path tracer: adapter/device negotiation, device-lost and
   uncaptured-error plumbing, and adoption of a device created elsewhere.

   Two entry points (docs/ROADMAP.md §2.8):
   • createDevice()  — the path tracer owns the device. In wave 3 this device
     is handed to three: `new WebGPURenderer({ device: pt.device })` (three
     r187 skips its own adapter request when `device` is given). Pass
     `{ forThree: true }` so the device also gets every other adapter feature
     three would have requested itself (texture compression, float32-blendable,
     …), otherwise three runs with fewer features.
   • adoptDevice(d)  — use an existing device (e.g. renderer.backend.device);
     the limits the kernels need are checked and a clear error is thrown.

   Requested limits: maxStorageBufferBindingSize and maxBufferSize =
   min(adapter, 1 GiB), maxStorageBuffersPerShaderStage = min(adapter, 10),
   maxComputeWorkgroupStorageSize = adapter. Optional features when present:
   timestamp-query, shader-f16, subgroups, float32-filterable, and
   core-features-and-limits (without it three r187 switches to its
   compatibility mode: no MSAA).

   Errors are observed with addEventListener('uncapturederror'), never the
   `onuncapturederror` property: three assigns that property on the device
   it is given and would silently replace ours.
   ═══════════════════════════════════════════════════════════════════════════ */

export const GIB = 1024 * 1024 * 1024;
/** cap of storage-buffer binding / buffer size requests */
export const MAX_BUFFER_CAP = GIB;
/** cap of storage buffers per shader stage requests */
export const STORAGE_BUFFERS_CAP = 10;

export const OPTIONAL_FEATURES = [
  'timestamp-query',
  'shader-f16',
  'subgroups',
  'float32-filterable',
  'core-features-and-limits'
] as const satisfies readonly GPUFeatureName[];

/** What the traversal kernels need at minimum (checked by adoptDevice / createDevice). */
export const MIN_LIMITS = {
  /** k_shade needs 9: scene (tris, instances) + surface (attrs, materials) + path/queue buffers + light data */
  maxStorageBuffersPerShaderStage: 9,
  maxComputeInvocationsPerWorkgroup: 64,
  maxComputeWorkgroupSizeX: 64,
  /** group 0 scene, 1 per-dispatch, 2 surface, 3 accumulation/AOV */
  maxBindGroups: 4
} as const;

export type LimitName = 'maxStorageBufferBindingSize' | 'maxBufferSize' | 'maxStorageBuffersPerShaderStage' |
  'maxComputeWorkgroupStorageSize' | 'maxComputeInvocationsPerWorkgroup' | 'maxComputeWorkgroupSizeX' |
  'maxComputeWorkgroupsPerDimension' | 'maxBindGroups';

/** Subset of GPUSupportedLimits we care about (plain numbers, loggable). */
export type PtLimits = Record<LimitName, number>;
const LIMIT_NAMES: LimitName[] = [
  'maxStorageBufferBindingSize', 'maxBufferSize', 'maxStorageBuffersPerShaderStage',
  'maxComputeWorkgroupStorageSize', 'maxComputeInvocationsPerWorkgroup', 'maxComputeWorkgroupSizeX',
  'maxComputeWorkgroupsPerDimension', 'maxBindGroups'
];

type LimitsLike = Partial<Record<string, number>> | GPUSupportedLimits;
const lim = (l: LimitsLike, k: string): number => (l as Record<string, number>)[k];

/** requiredLimits for requestDevice() from the adapter limits (pure). */
export function computeRequiredLimits(adapter: LimitsLike): Record<string, number> {
  const buf = Math.min(lim(adapter, 'maxBufferSize'), MAX_BUFFER_CAP);
  return {
    maxBufferSize: buf,
    maxStorageBufferBindingSize: Math.min(lim(adapter, 'maxStorageBufferBindingSize'), MAX_BUFFER_CAP, buf),
    maxStorageBuffersPerShaderStage: Math.min(lim(adapter, 'maxStorageBuffersPerShaderStage'), STORAGE_BUFFERS_CAP),
    maxComputeWorkgroupStorageSize: lim(adapter, 'maxComputeWorkgroupStorageSize')
  };
}

/** requiredFeatures (pure): optional PT features present on the adapter, or all of them for three. */
export function selectFeatures(adapter: { has(f: string): boolean } & Iterable<string>, all = false): GPUFeatureName[] {
  if (all) return [...adapter] as GPUFeatureName[];
  return OPTIONAL_FEATURES.filter((f) => adapter.has(f));
}

/** Names of MIN_LIMITS the device does not meet, with values (pure). */
export function checkLimits(device: LimitsLike): string[] {
  const bad: string[] = [];
  for (const [k, v] of Object.entries(MIN_LIMITS)) {
    const have = lim(device, k);
    if (!(have >= v)) bad.push(`${k} = ${have} < ${v}`);
  }
  return bad;
}

export function pickLimits(l: LimitsLike): PtLimits {
  const out = {} as PtLimits;
  for (const k of LIMIT_NAMES) out[k] = lim(l, k);
  return out;
}

export interface PtDeviceInfo {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
}

export interface PtDevice {
  device: GPUDevice;
  /** null for adopted devices */
  adapter: GPUAdapter | null;
  adopted: boolean;
  info: PtDeviceInfo;
  features: ReadonlySet<string>;
  limits: PtLimits;
  /** adapter limits (createDevice only), for reports */
  adapterLimits: PtLimits | null;
  hasTimestamps: boolean;
  hasF16: boolean;
  hasSubgroups: boolean;
  /** resolves when the device is lost (also on destroy(): reason 'destroyed') */
  lost: Promise<GPUDeviceLostInfo>;
  isLost(): boolean;
  /** called on an unexpected loss (not after destroy()); returns an unsubscribe function */
  onLost(cb: (info: GPUDeviceLostInfo) => void): () => void;
  /** uncaptured validation / OOM / internal errors; without listeners they go to console.error */
  onError(cb: (err: GPUError) => void): () => void;
  /** destroys the device only if we created it (an adopted device belongs to its creator) */
  destroy(): void;
}

export interface CreateDeviceOptions {
  /** navigator.gpu by default; Node (Dawn) passes its own GPU object */
  gpu?: GPU;
  powerPreference?: GPUPowerPreference;
  /** also request every other adapter feature (the device will be shared with three) */
  forThree?: boolean;
  label?: string;
}

export class PtDeviceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PtDeviceError';
  }
}

function infoOf(i: GPUAdapterInfo | undefined): PtDeviceInfo {
  return {
    vendor: i?.vendor ?? '',
    architecture: i?.architecture ?? '',
    device: i?.device ?? '',
    description: i?.description ?? ''
  };
}

function wrap(device: GPUDevice, adapter: GPUAdapter | null, adopted: boolean): PtDevice {
  const lostCbs = new Set<(info: GPUDeviceLostInfo) => void>();
  const errCbs = new Set<(err: GPUError) => void>();
  let lostFlag = false;
  const lost = device.lost.then((info) => {
    lostFlag = true;
    if (info.reason !== 'destroyed') {
      if (lostCbs.size === 0) console.error(`[pt] GPU device lost (${info.reason}): ${info.message}`);
      for (const cb of lostCbs) cb(info);
    }
    return info;
  });
  device.addEventListener('uncapturederror', (ev) => {
    const err = (ev as GPUUncapturedErrorEvent).error;
    if (errCbs.size === 0) console.error(`[pt] uncaptured GPU error: ${err.message}`);
    for (const cb of errCbs) cb(err);
  });
  const features = new Set<string>(device.features);
  return {
    device, adapter, adopted,
    info: infoOf(adapter?.info ?? device.adapterInfo),
    features,
    limits: pickLimits(device.limits),
    adapterLimits: adapter ? pickLimits(adapter.limits) : null,
    hasTimestamps: features.has('timestamp-query'),
    hasF16: features.has('shader-f16'),
    hasSubgroups: features.has('subgroups'),
    lost,
    isLost: () => lostFlag,
    onLost(cb) { lostCbs.add(cb); return () => lostCbs.delete(cb); },
    onError(cb) { errCbs.add(cb); return () => errCbs.delete(cb); },
    destroy() { if (!adopted) device.destroy(); }
  };
}

/** Request a high-performance adapter and a device with the path tracer limits/features. */
export async function createDevice(opts: CreateDeviceOptions = {}): Promise<PtDevice> {
  const gpu = opts.gpu ?? (typeof navigator !== 'undefined' ? navigator.gpu : undefined);
  if (!gpu) throw new PtDeviceError('WebGPU is not available (navigator.gpu is undefined)');
  const adapter = await gpu.requestAdapter({ powerPreference: opts.powerPreference ?? 'high-performance' });
  if (!adapter) throw new PtDeviceError('WebGPU: no suitable GPU adapter (requestAdapter returned null)');
  const short = checkLimits(adapter.limits);
  if (short.length) throw new PtDeviceError(`WebGPU adapter too limited for the path tracer: ${short.join(', ')}`);
  const device = await adapter.requestDevice({
    label: opts.label ?? 'b5 path tracer',
    requiredFeatures: selectFeatures(adapter.features, opts.forThree),
    requiredLimits: computeRequiredLimits(adapter.limits)
  });
  return wrap(device, adapter, false);
}

/** Use a device created elsewhere (three's renderer.backend.device in wave 3). */
export function adoptDevice(device: GPUDevice): PtDevice {
  if (!device || typeof device.createComputePipelineAsync !== 'function') {
    throw new PtDeviceError('adoptDevice: not a GPUDevice');
  }
  const short = checkLimits(device.limits);
  if (short.length) {
    throw new PtDeviceError(`adoptDevice: device limits too low for the path tracer: ${short.join(', ')} ` +
      '(create the device with pathtracer/device.ts createDevice() and pass it to three instead)');
  }
  return wrap(device, null, true);
}

/** Human-readable one-liner for logs and the smoke page. */
export function describeDevice(pt: PtDevice): string {
  const i = pt.info;
  const name = [i.vendor, i.architecture, i.description || i.device].filter(Boolean).join(' / ') || 'unknown adapter';
  const mib = (n: number) => `${Math.round(n / 1048576)} MiB`;
  return `${name}; features: ${[...pt.features].sort().join(', ') || '—'}; ` +
    `maxStorageBufferBindingSize ${mib(pt.limits.maxStorageBufferBindingSize)}, maxBufferSize ${mib(pt.limits.maxBufferSize)}, ` +
    `maxStorageBuffersPerShaderStage ${pt.limits.maxStorageBuffersPerShaderStage}, ` +
    `maxComputeWorkgroupStorageSize ${pt.limits.maxComputeWorkgroupStorageSize}`;
}
