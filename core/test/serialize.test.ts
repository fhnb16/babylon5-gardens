/* Binary SceneDesc container: round trip, shared arrays, determinism of
   buildScene (two builds → identical bytes), build timing. */
import { describe, expect, test } from 'vitest';
import { buildScene, defaultParams } from '../scene/build.ts';
import { deserializeScene, serializeScene, utf8Decode, utf8Encode } from '../scene/serialize.ts';
import type { SceneDesc } from '../scene/types.ts';

describe('serialize', () => {
  test('UTF-8 coder (Cyrillic, emoji)', () => {
    const s = 'Панорама Садов 🌅 ☀️ abc';
    const b = utf8Encode(s);
    expect(Array.from(b)).toEqual(Array.from(Buffer.from(s, 'utf8')));
    expect(utf8Decode(b)).toBe(s);
  });

  test('round trip of a LOW scene keeps every value, type and sharing', () => {
    const scene = buildScene(defaultParams('LOW'));
    const bytes = serializeScene(scene);
    expect(bytes.length % 8).toBe(0);
    const back = deserializeScene<SceneDesc>(bytes);
    expect(back).toEqual(scene);
    const hull = scene.meshes.find(m => m.role === 'hull');
    expect(back.geometries[hull?.geometry as string].index).toBeInstanceOf(Uint16Array);
    const b = back.meshes.find(m => m.role === 'traffic.body'), l = back.meshes.find(m => m.role === 'traffic.lamp');
    expect(b?.instances?.matrices).toBe(l?.instances?.matrices);
    expect(serializeScene(back)).toEqual(bytes);
  });

  test('blobs are 8-byte aligned', () => {
    const obj = { a: new Uint8Array([1, 2, 3]), b: new Float64Array([1.5, -2]), c: new Float32Array([3]) };
    const bytes = serializeScene(obj);
    const back = deserializeScene<typeof obj>(bytes);
    expect(back).toEqual(obj);
    const hl = new DataView(bytes.buffer).getUint32(8, true);
    const header = JSON.parse(Buffer.from(bytes.subarray(12, 12 + hl)).toString('utf8'));
    for (const k of ['a', 'b', 'c']) expect(header[k].o % 8).toBe(0);
    expect((12 + hl) % 8).toBe(0);
  });
});

describe('determinism and timing', () => {
  test('two HIGH builds serialize to identical bytes; layoutHash stable', () => {
    const t0 = performance.now();
    const a = buildScene(defaultParams('HIGH'));
    const ms = performance.now() - t0;
    const b = buildScene(defaultParams('HIGH'));
    expect(a.layoutHash).toBe(b.layoutHash);
    expect(a.layoutHash).toMatch(/^[0-9a-f]{8}$/);
    expect(Buffer.from(serializeScene(a)).equals(Buffer.from(serializeScene(b)))).toBe(true);
    expect(ms).toBeLessThan(1500);
  });

  test('different seeds give different layouts', () => {
    const a = buildScene(defaultParams('LOW'));
    const b = buildScene({ ...defaultParams('LOW'), seed: 42 });
    expect(a.layoutHash).not.toBe(b.layoutHash);
  });

  test('scene is structured-clone-able', () => {
    const a = buildScene(defaultParams('LOW'));
    expect(structuredClone(a)).toEqual(a);
  });
});
