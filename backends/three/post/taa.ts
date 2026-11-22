/* three's TRAANode, made aware of a scaled scene pass.

   TRAANode (r187) sizes its camera jitter and its depth-history copy from
   renderer.getDrawingBufferSize(). With the scene pass at a resolution
   scale ≠ 1 (SSAA, FSR) both are wrong:
   - jitter is in drawing-buffer pixels, not pass pixels (×scale too wide /
     too narrow a sub-pixel pattern);
   - the depth copy is skipped (sizes differ), the previous depth stays
     stale, and the disocclusion test rejects the history — TAA silently
     degrades to the raw jittered frame.
   This subclass feeds both the pass size instead. At scale 1 it is exactly
   TRAANode. Velocity comes from the MRT (`velocity` node): object motion,
   including the station's world rotation, is reprojected natively — the
   classic chain's world-rotation reprojection is not needed. */
import type * as THREE from 'three/webgpu';
import TRAANode from 'three/addons/tsl/display/TRAANode.js';

type FrameLike = THREE.NodeFrame;
type SizeFn = (target: THREE.Vector2) => THREE.Vector2;
interface TraaInternals {
  setViewOffset(width: number, height: number): void;
  updateBefore(frame: FrameLike): boolean | undefined;
  getTextureNode(): THREE.TextureNode;
}

const base = TRAANode.prototype as unknown as TraaInternals;

export class ScaledTRAANode extends TRAANode {
  /** The resolve output as a texture node (declared by r187's JS, missing in @types). */
  getTextureNode(): THREE.TextureNode { return base.getTextureNode.call(this); }

  /** Scene pass resolution scale relative to the drawing buffer. */
  renderScale = 1;

  setViewOffset(width: number, height: number): void {
    const s = this.renderScale;
    base.setViewOffset.call(this, Math.max(1, Math.floor(width * s)), Math.max(1, Math.floor(height * s)));
  }

  updateBefore(frame: FrameLike): boolean | undefined {
    const s = this.renderScale;
    if (s === 1) return base.updateBefore.call(this, frame);
    const r = (frame as unknown as { renderer: unknown }).renderer as unknown as { getDrawingBufferSize: SizeFn };
    const own = Object.prototype.hasOwnProperty.call(r, 'getDrawingBufferSize');
    const orig = r.getDrawingBufferSize;
    r.getDrawingBufferSize = (t: THREE.Vector2) => {
      orig.call(r, t);
      return t.set(Math.max(1, Math.floor(t.x * s)), Math.max(1, Math.floor(t.y * s)));
    };
    try {
      return base.updateBefore.call(this, frame);
    } finally {
      if (own) r.getDrawingBufferSize = orig;
      else delete (r as Partial<typeof r>).getDrawingBufferSize;
    }
  }
}
