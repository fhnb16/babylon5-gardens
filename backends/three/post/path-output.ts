import { ExternalTexture, HalfFloatType, LinearFilter, type Texture } from 'three/webgpu';
import { texture } from 'three/tsl';
import type { PostPipeline } from './pipeline.ts';

/** The tracer owns the GPU texture. three r187 samples it on the same device. */
export function pathOutput(post: PostPipeline, rasterExposure: number) {
  let current: ExternalTexture | null = null;
  let exposure = rasterExposure;
  return {
    present(source: GPUTexture, exposureMultiplier: number) {
      const nextExposure = rasterExposure * exposureMultiplier;
      if (exposure !== nextExposure) {
        exposure = nextExposure;
        post.setExposure(exposure);
      }
      if (current?.sourceTexture !== source) {
        const previous = current;
        current = new ExternalTexture(source);
        const sized: Texture<unknown> = current;
        sized.image = { width: source.width, height: source.height };
        current.type = HalfFloatType;
        current.magFilter = current.minFilter = LinearFilter;
        current.generateMipmaps = false;
        current.flipY = false;
        current.needsUpdate = true;
        post.compositeExternal(texture(current));
        previous?.dispose();
      }
      post.render(true);
    },
    dispose() {
      if (!current) return;
      post.compositeExternal(null, rasterExposure);
      current.dispose();
      current = null;
    }
  };
}
