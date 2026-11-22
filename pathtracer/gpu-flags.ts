/* WebGPU flag constants (values fixed by the WebGPU spec). TypeScript's DOM
   lib declares only the flag *types*, not the GPUBufferUsage / GPUShaderStage
   / … namespace objects, and Node (Dawn) exposes them only after installing
   its globals — so the path tracer uses these plain constants everywhere. */

export const BUFFER = {
  MAP_READ: 0x0001,
  MAP_WRITE: 0x0002,
  COPY_SRC: 0x0004,
  COPY_DST: 0x0008,
  INDEX: 0x0010,
  VERTEX: 0x0020,
  UNIFORM: 0x0040,
  STORAGE: 0x0080,
  INDIRECT: 0x0100,
  QUERY_RESOLVE: 0x0200
} as const;

export const TEXTURE = {
  COPY_SRC: 0x01,
  COPY_DST: 0x02,
  TEXTURE_BINDING: 0x04,
  STORAGE_BINDING: 0x08,
  RENDER_ATTACHMENT: 0x10
} as const;

export const STAGE = {
  VERTEX: 0x1,
  FRAGMENT: 0x2,
  COMPUTE: 0x4
} as const;

export const MAP = {
  READ: 0x1,
  WRITE: 0x2
} as const;
