/* Node-side WGSL source loader (tests, Dawn scripts): the same { name → text }
   map pathtracer/wgsl/index.ts builds with Vite `?raw` imports. */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { WgslSources } from '../kernels.ts';

const DIRS = ['../wgsl/', '../smoke/'];

export function loadWgslSources(): WgslSources {
  const out: Record<string, string> = {};
  for (const rel of DIRS) {
    const dir = fileURLToPath(new URL(rel, import.meta.url));
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.wgsl')) continue;
      if (out[f] !== undefined) throw new Error(`duplicate WGSL file name ${f}`);
      out[f] = readFileSync(dir + f, 'utf8');
    }
  }
  return out;
}
