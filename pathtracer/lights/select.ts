/* Light selection between the analytic tube and the triangle lights — CPU
   mirror of b5_ptube (light_tree.wgsl): p_tube = I_tube / (I_tube + I_tree)
   clamped to [pTubeMin, pTubeMax]; I_tube = tube luminance × strip solid
   angle (tube.ts tubeImportance), I_tree = importance of the root's children
   at (p, n). No triangle lights → 1; no tube → 0. */

import { LIGHTS_PT, LIGHT_MODE } from '../config.ts';
import { treeRootImportance, type LightTree } from './light-tree.ts';
import { tubeImportance, type TubeGeom } from './tube.ts';

export function pTube(
  tube: TubeGeom | null, tubeLum: number, tree: LightTree | null, mode: number,
  p: ArrayLike<number>, n: ArrayLike<number>
): number {
  if (!tube) return 0;
  if (mode === LIGHT_MODE.none || !tree) return 1;
  const it = tubeImportance(p, tube, tubeLum);
  const il = treeRootImportance(tree, p, n);
  if (!(il > 0)) return 1;
  if (!(it > 0)) return 0;
  return Math.min(LIGHTS_PT.pTubeMax, Math.max(LIGHTS_PT.pTubeMin, it / (it + il)));
}
