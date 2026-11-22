/* Мир совпадает с золотыми снимками test/golden/ (см. tools/snapshot-lib.mjs).
   Пересоздать эталоны после НАМЕРЕННОГО изменения мира:
     node tools/snapshot-world.mjs --write */
import { test, expect } from 'vitest';
import { checkWorldSnapshots } from '../tools/snapshot-lib.mjs';

test('мир совпадает с золотыми снимками', () => {
  const r = checkWorldSnapshots();
  if (!r.ok) console.log(r.report);
  expect(r.problems).toEqual([]);
  expect(r.ok).toBe(true);
}, 900_000);
