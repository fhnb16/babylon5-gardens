// ═══════════════════════════════════════════════════════════════════════════
// traverse.wgsl — two-level BVH2 traversal over the packed buffers
// (pathtracer/bvh/layout.ts), closest hit and any hit. The algorithm is
// exactly pathtracer/bvh/traverse-ref.ts (f32 mode):
//   • ordered children: both hit → push the far one, descend the near one;
//     popped entries farther than the current closest t are skipped;
//   • TLAS leaf (count 1, offset = instance) whose flags pass the ray mask →
//     ray to object space with worldToObject (direction not renormalised,
//     t is shared), remember the stack height, continue at blasRoot; the
//     world ray is restored when the stack drops back to that height;
//   • slab test with |d| clamped to B5_DIR_EPS, tfar *= B5_SLAB_TFAR_SCALE;
//   • finite tmax always (DECISIONS.md #3);
//   • private stack of B5_TRAVERSE_STACK entries (loader define, default 32 —
//     WGSL allows override-sized arrays only in workgroup memory). On overflow
//     the farthest entry of the current level is replaced (or the new one
//     dropped) and b5_dbg.stackOverflow is incremented (DECISIONS.md #1).
// Requires: common.wgsl, tri.wgsl. Scene bindings live in @group(0).
// ═══════════════════════════════════════════════════════════════════════════

@group(0) @binding(0) var<storage, read> b5_nodes: array<B5BvhNode>;
@group(0) @binding(1) var<storage, read> b5_tris: array<B5Tri>;
@group(0) @binding(2) var<storage, read> b5_insts: array<B5Instance>;
@group(0) @binding(3) var<storage, read_write> b5_dbg: B5Dbg;

struct B5TraceHit {
  t: f32,
  u: f32,
  v: f32,
  inst: u32,   // B5_NO_INDEX for single-level traces
  tri: u32,    // B5_NO_INDEX on a miss
  front: bool,
}

// entry distance of a child box, B5_MISS when the box is missed or farther than tbest
fn b5_slab(p: B5RayPre, bmin: vec3f, bmax: vec3f, tmin: f32, tbest: f32) -> f32 {
  let t0 = (bmin - p.o) * p.inv;
  let t1 = (bmax - p.o) * p.inv;
  let tn = max(max(max(min(t0.x, t1.x), min(t0.y, t1.y)), min(t0.z, t1.z)), tmin);
  let tf = min(min(max(t0.x, t1.x), max(t0.y, t1.y)), max(t0.z, t1.z)) * B5_SLAB_TFAR_SCALE;
  return select(B5_MISS, tn, tn <= tf && tn <= tbest);
}

// worldToObject rows applied left to right (same order as the f32 reference)
fn b5_xform_point(r: vec4f, p: vec3f) -> f32 {
  return r.x * p.x + r.y * p.y + r.z * p.z + r.w;
}
fn b5_xform_dir(r: vec4f, d: vec3f) -> f32 { // r.w (translation) unused
  return r.x * d.x + r.y * d.y + r.z * d.z;
}

// twoLevel = false: `root` is a BLAS root, instances are not used (inst = B5_NO_INDEX)
fn b5_trace(ray: B5Ray, mask: u32, root: u32, twoLevel: bool, anyHit: bool) -> B5TraceHit {
  let world = b5_prepare_ray(ray.o, ray.d);
  var R = world;
  var tBest = ray.tmax;
  let tMin = ray.tmin;
  var res: B5TraceHit;
  res.t = 0.0;
  res.u = 0.0;
  res.v = 0.0;
  res.inst = B5_NO_INDEX;
  res.tri = B5_NO_INDEX;
  res.front = false;
  var th: B5TriHit;

  var stkRef: array<u32, B5_TRAVERSE_STACK>;
  var stkT: array<f32, B5_TRAVERSE_STACK>;
  var sp = 0u;
  var blasBase = 0u;
  var inBlas = !twoLevel;
  var curInst = B5_NO_INDEX;
  var cur = root;

  loop {
    if (!b5_is_leaf(cur)) {
      let n = b5_nodes[cur];
      let t0 = b5_slab(R, n.c0min, n.c0max, tMin, tBest);
      let t1 = b5_slab(R, n.c1min, n.c1max, tMin, tBest);
      if (t0 < B5_MISS) {
        if (t1 < B5_MISS) {
          var farRef = n.child1;
          var farT = t1;
          cur = n.child0;
          if (t1 < t0) {
            farRef = n.child0;
            farT = t0;
            cur = n.child1;
          }
          if (sp < B5_TRAVERSE_STACK) {
            stkRef[sp] = farRef;
            stkT[sp] = farT;
            sp += 1u;
          } else {
            // overflow: replace the farthest entry of the current level if it is
            // farther than the new one, else drop the new one
            atomicAdd(&b5_dbg.stackOverflow, 1u);
            let lo = select(0u, blasBase, twoLevel && inBlas);
            var fi = B5_NO_INDEX;
            var ft = farT;
            for (var i = lo; i < sp; i += 1u) {
              if (stkT[i] > ft) {
                ft = stkT[i];
                fi = i;
              }
            }
            if (fi != B5_NO_INDEX) {
              stkRef[fi] = farRef;
              stkT[fi] = farT;
            }
          }
        } else {
          cur = n.child0;
        }
        continue;
      }
      if (t1 < B5_MISS) {
        cur = n.child1;
        continue;
      }
    } else if (cur != B5_LEAF_FLAG) { // B5_LEAF_FLAG alone = empty leaf
      let cnt = b5_leaf_count(cur);
      let off = b5_leaf_offset(cur);
      if (!inBlas) {
        let inst = b5_insts[off];
        if ((b5_inst_flags(inst.flagsLight) & mask & B5_VIS_ALL) != 0u) {
          let o = vec3f(b5_xform_point(inst.w2o0, ray.o), b5_xform_point(inst.w2o1, ray.o),
                        b5_xform_point(inst.w2o2, ray.o));
          let d = vec3f(b5_xform_dir(inst.w2o0, ray.d), b5_xform_dir(inst.w2o1, ray.d),
                        b5_xform_dir(inst.w2o2, ray.d));
          R = b5_prepare_ray(o, d);
          inBlas = true;
          blasBase = sp;
          curInst = off;
          cur = inst.blasRoot;
          continue;
        }
      } else {
        for (var k = 0u; k < cnt; k += 1u) {
          let ti = off + k;
          let tr = b5_tris[ti];
          if (b5_intersect_tri(R, tr.v0, tr.v1, tr.v2, tMin, tBest, &th)) {
            tBest = th.t;
            res.t = th.t;
            res.u = th.u;
            res.v = th.v;
            res.front = th.front;
            res.tri = ti;
            res.inst = select(B5_NO_INDEX, curInst, twoLevel);
            if (anyHit) {
              return res;
            }
          }
        }
      }
    }
    // pop
    loop {
      if (twoLevel && inBlas && sp == blasBase) {
        inBlas = false;
        R = world;
        curInst = B5_NO_INDEX;
      }
      if (sp == 0u) {
        return res;
      }
      sp -= 1u;
      if (stkT[sp] > tBest) {
        continue;
      }
      cur = stkRef[sp];
      break;
    }
  }
}

fn b5_closest_hit(ray: B5Ray, mask: u32, root: u32, twoLevel: bool) -> B5TraceHit {
  return b5_trace(ray, mask, root, twoLevel, false);
}

fn b5_any_hit(ray: B5Ray, mask: u32, root: u32, twoLevel: bool) -> bool {
  return b5_trace(ray, mask, root, twoLevel, true).tri != B5_NO_INDEX;
}
