// ═══════════════════════════════════════════════════════════════════════════
// traverse_tr.wgsl — shadow rays with thin-glass transmission (PT-W4a).
// Same two-level BVH2 walk as traverse.wgsl b5_trace (ordered children,
// private stack, overflow policy), but any-hit with a filter: a triangle of
// an instance flagged B5_INST_GLASS does not occlude — the transmittance is
// multiplied by b5_glass_transmittance (tint · (1 − R′(cos))) and the walk
// goes on WITHOUT shrinking tmax. Each triangle sits in exactly one leaf of
// its BLAS and every leaf is visited at most once per instance, so every
// glass crossing on [tmin, tmax] is counted exactly once. Any opaque hit
// returns 0 immediately.
// Requires common.wgsl, tri.wgsl, traverse.wgsl (bindings, b5_slab,
// b5_xform_*), bsdf_glass.wgsl, and the kernel's b5_surface_glass(inst, tri).
// ═══════════════════════════════════════════════════════════════════════════

fn b5_trace_transmittance(ray: B5Ray, mask: u32, root: u32) -> vec3f {
  let world = b5_prepare_ray(ray.o, ray.d);
  var R = world;
  let tMax = ray.tmax;
  let tMin = ray.tmin;
  var T = vec3f(1.0);
  var th: B5TriHit;
  let dn = normalize(ray.d);

  var stkRef: array<u32, B5_TRAVERSE_STACK>;
  var stkT: array<f32, B5_TRAVERSE_STACK>;
  var sp = 0u;
  var blasBase = 0u;
  var inBlas = false;
  var curInst = B5_NO_INDEX;
  var glass = false;
  var cur = root;

  loop {
    if (!b5_is_leaf(cur)) {
      let n = b5_nodes[cur];
      let t0 = b5_slab(R, n.c0min, n.c0max, tMin, tMax);
      let t1 = b5_slab(R, n.c1min, n.c1max, tMin, tMax);
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
            atomicAdd(&b5_dbg.stackOverflow, 1u);
            let lo = select(0u, blasBase, inBlas);
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
    } else if (cur != B5_LEAF_FLAG) {
      let cnt = b5_leaf_count(cur);
      let off = b5_leaf_offset(cur);
      if (!inBlas) {
        let inst = b5_insts[off];
        let fl = b5_inst_flags(inst.flagsLight);
        if ((fl & mask & B5_VIS_ALL) != 0u) {
          let o = vec3f(b5_xform_point(inst.w2o0, ray.o), b5_xform_point(inst.w2o1, ray.o),
                        b5_xform_point(inst.w2o2, ray.o));
          let d = vec3f(b5_xform_dir(inst.w2o0, ray.d), b5_xform_dir(inst.w2o1, ray.d),
                        b5_xform_dir(inst.w2o2, ray.d));
          R = b5_prepare_ray(o, d);
          inBlas = true;
          blasBase = sp;
          curInst = off;
          glass = (fl & B5_INST_GLASS) != 0u;
          cur = inst.blasRoot;
          continue;
        }
      } else {
        for (var k = 0u; k < cnt; k += 1u) {
          let ti = off + k;
          let tr = b5_tris[ti];
          if (b5_intersect_tri(R, tr.v0, tr.v1, tr.v2, tMin, tMax, &th)) {
            if (!glass) {
              return vec3f(0.0);
            }
            // world normal = W2Oᵀ n_obj
            let ins = b5_insts[curInst];
            let nObj = cross(tr.v1 - tr.v0, tr.v2 - tr.v0);
            let nW = normalize(mat3x3f(ins.w2o0.xyz, ins.w2o1.xyz, ins.w2o2.xyz) * nObj);
            let g = b5_surface_glass(curInst, ti);
            T *= b5_glass_transmittance(g.xyz, abs(dot(nW, dn)), g.w);
          }
        }
      }
    }
    loop {
      if (inBlas && sp == blasBase) {
        inBlas = false;
        glass = false;
        R = world;
        curInst = B5_NO_INDEX;
      }
      if (sp == 0u) {
        return T;
      }
      sp -= 1u;
      cur = stkRef[sp];
      break;
    }
  }
}
