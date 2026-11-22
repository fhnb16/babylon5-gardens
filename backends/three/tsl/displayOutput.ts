/* ═══════════════════════════════════════════════════════════════════════════
   'display' output mode of the node path: classic direct-to-canvas semantics.

   The classic WebGLRenderer rendering STRAIGHT to the canvas (no post chain:
   tools/core-world.html, the app with anti-aliasing off) does, per fragment:
       c = toneMapped ? ACES(L, exposure) : L        (tonemapping_fragment)
       c = enc_sRGB(c)                                (colorspace_fragment)
       c = mix(c, enc_sRGB(fog), f)                   (fog_fragment — AFTER both,
                                                        fog colour in output space)
   and blends translucent / additive surfaces on those ENCODED values; the
   background clear colour is enc_sRGB(fog) without tone mapping. Through the
   classic post chain (render target) everything is linear HDR instead — which
   is what WebGPURenderer / RenderPipeline always do ('hdr' mode, the app).

   'display' mode reproduces the direct look on WebGPURenderer: the renderer
   runs with NoToneMapping + LinearSRGBColorSpace output (no framebuffer target,
   so the canvas receives the fragment values as they are and blending happens
   on encoded values), and every node material writes the classic display
   value through its outputNode, built here. Fog (f = 1 − exp(−d²z²), z = view
   depth) is mixed in display space; fogFade materials skip the colour fog.
   ═══════════════════════════════════════════════════════════════════════════ */

import * as TSL from 'three/tsl';
import { asT, type TNode } from './kernelBridge.ts';

export interface DisplayOutputUniforms {
  /** fog colour, LINEAR (encoded here like the classic output-space uniform) */
  fogColor: TNode;
  fogDensity: TNode;
  /** three ACESFilmic exposure (renderer.toneMappingExposure of the classic setup) */
  exposure: TNode;
  /** ACES (true) or no tone mapping */
  aces: boolean;
}

/** outputNode of a node material in 'display' mode. */
export function displayOutputNode(U: DisplayOutputUniforms, o: { toneMapped: boolean; fog: boolean }): TNode {
  const T = TSL;
  const aces = T.acesFilmicToneMapping as unknown as (c: TNode, e: TNode) => TNode;
  const mix = T.mix as unknown as (a: TNode, b: TNode, t: TNode) => TNode;
  return asT(T.Fn(() => {
    const L = asT(T.output).rgb;
    const A = o.toneMapped && U.aces ? aces(L, U.exposure) : L;
    let D = asT(T.sRGBTransferOETF(A));
    if (o.fog) {
      const z = asT(T.positionView).z.negate();
      const f = asT(T.float(1)).sub(T.exp(U.fogDensity.mul(U.fogDensity).mul(z).mul(z).negate()));
      D = mix(D, T.sRGBTransferOETF(asT(U.fogColor).rgb), T.clamp(f, 0, 1));
    }
    return T.vec4(D, asT(T.output).a);
  })());
}
