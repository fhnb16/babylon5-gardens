// Compile the actual substituted bodies plus the exact shared kernel library
// in Dawn before passing any material functions to the native client.
import { createServer } from 'node:http';
import { chromium } from '@playwright/test';
import { helpers, hullBody, tubeBody, foliageBody } from '../src/materials.ts';

const prelude = `
struct B5Input { wp: vec3f, uv: vec2f, uvd: f32, power: f32 }
struct B5Output { base: vec3f, emissive: vec3f, roughness: f32, normal: vec3f }
fn msample(m: u32, i: B5Input, tex: u32, p: vec2f, w: f32) -> vec4f { return vec4f(1.0); }
fn tangent_normal(i: B5Input, n: vec3f) -> vec3f { return n; }
`;
const specs = [
  [hullBody, { Mask: '0u', Detail: '1u', Tint: 'vec4f(1.0)', Size: 'vec4f(1.0)', Repeat: '1.0', Glow: '1.0', Street: '1.0' }],
  [tubeBody, { Tint: 'vec4f(1.0)', Nits: '1.0' }],
  [foliageBody, { Amount: '1.0', Cell: '1.0' }]
];
const bodies = specs.map(([src, params], i) => {
  const body = src.replace(/\$(\w+)/g, (_, p) => {
    if (!Object.hasOwn(params, p)) throw new Error('Unknown shader parameter ' + p);
    return params[p];
  });
  return 'fn b5_check' + i + '(m: u32, i: B5Input) -> B5Output { var o: B5Output;\n' + body + '\nreturn o; }';
});
const server = createServer((_req, res) => res.end('<title>WGSL check</title>'));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', args: ['--enable-unsafe-webgpu'] });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:' + server.address().port);
  const errors = await page.evaluate(async code => {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) throw new Error('WebGPU unavailable for offline WGSL validation');
    const device = await adapter.requestDevice();
    try {
      const module = device.createShaderModule({ code });
      return (await module.getCompilationInfo()).messages.filter(m => m.type === 'error').map(m => m.lineNum + ': ' + m.message);
    } finally { device.destroy(); }
  }, [prelude, helpers, ...bodies].join('\n'));
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('WGSL compiled: hull, tube, foliage');
} finally {
  await browser?.close();
  server.close();
}
