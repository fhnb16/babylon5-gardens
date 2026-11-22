// ═══════════════════════════════════════════════════════════════════════════
// k_args.wgsl — one invocation between k_shade and k_shadow of every bounce:
//   shadowLive = shadow rays appended by k_shade, input count = extension
//   rays appended, both append counters → 0, parity flipped; writes the
//   indirect dispatch arguments (same 2-D split as kernels.ts dispatchSize):
//     args[0..3) = extension rays (k_intersect + k_shade of the next bounce)
//     args[3..6) = shadow rays (k_shadow + k_shadow_resolve of this bounce)
// The args buffer is bound ONLY here (INDIRECT and STORAGE usages must not
// meet in one dispatch).
// ═══════════════════════════════════════════════════════════════════════════
//#include "common.wgsl"
//#include "pt_state.wgsl"

override B5_WG_SIZE: u32 = 64u;

@group(1) @binding(0) var<uniform> b5_wave: B5Frame;
@group(1) @binding(1) var<storage, read_write> b5_queues: B5Queues;
@group(1) @binding(2) var<storage, read_write> b5_args: array<u32, 6>;

fn b5_split(count: u32, wg: u32, maxDim: u32) -> vec3u {
  let groups = (count + wg - 1u) / wg;
  if (groups <= maxDim) {
    return vec3u(groups, 1u, 1u);
  }
  let y = (groups + maxDim - 1u) / maxDim;
  return vec3u((groups + y - 1u) / y, y, 1u);
}

@compute @workgroup_size(1)
fn b5_k_args() {
  let next = atomicLoad(&b5_queues.ctl[B5_Q_NEXT]);
  let sh = atomicLoad(&b5_queues.ctl[B5_Q_SHADOW]);
  atomicStore(&b5_queues.ctl[B5_Q_COUNT], next);
  atomicStore(&b5_queues.ctl[B5_Q_NEXT], 0u);
  atomicStore(&b5_queues.ctl[B5_Q_SHADOW_LIVE], sh);
  atomicStore(&b5_queues.ctl[B5_Q_SHADOW], 0u);
  atomicStore(&b5_queues.ctl[B5_Q_PARITY], 1u - atomicLoad(&b5_queues.ctl[B5_Q_PARITY]));
  atomicAdd(&b5_queues.ctl[B5_Q_BOUNCE], 1u);
  atomicAdd(&b5_queues.ctl[B5_Q_RAYS], next);
  atomicAdd(&b5_queues.ctl[B5_Q_SHADOWS], sh);
  let a = b5_split(next, B5_WG_SIZE, b5_wave.maxDim);
  let s = b5_split(sh, B5_WG_SIZE, b5_wave.maxDim);
  b5_args[0] = a.x;
  b5_args[1] = a.y;
  b5_args[2] = a.z;
  b5_args[3] = s.x;
  b5_args[4] = s.y;
  b5_args[5] = s.z;
}
