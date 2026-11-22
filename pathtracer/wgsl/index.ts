/* WGSL sources of the path tracer, bundled by Vite (`?raw`). Node code (tests,
   Dawn scripts) reads the same files with fs instead — see
   pathtracer/test/wgsl-fs.ts. The keys are the names used by `//#include`. */
import common from './common.wgsl?raw';
import tri from './tri.wgsl?raw';
import traverse from './traverse.wgsl?raw';
import kIntersect from './k_intersect.wgsl?raw';
import kShadow from './k_shadow.wgsl?raw';
import type { WgslSources } from '../kernels.ts';

export const WGSL_FILES = ['common.wgsl', 'tri.wgsl', 'traverse.wgsl', 'k_intersect.wgsl', 'k_shadow.wgsl'] as const;

export const WGSL_SOURCES: WgslSources = {
  'common.wgsl': common,
  'tri.wgsl': tri,
  'traverse.wgsl': traverse,
  'k_intersect.wgsl': kIntersect,
  'k_shadow.wgsl': kShadow
};
