/* Золотые снимки мира.
     node tools/snapshot-world.mjs --write            записать эталоны в test/golden/
     node tools/snapshot-world.mjs --check            сверить (код выхода 1 при расхождении)
     node tools/snapshot-world.mjs --check --strict   плюс требовать совпадения бит в бит
     --case <id>[,<id>]                               только перечисленные случаи
     --list                                           показать матрицу случаев
   Формат и допуски описаны в tools/snapshot-lib.mjs. */
import { CASES, writeWorldSnapshots, checkWorldSnapshots } from './snapshot-lib.mjs';

const args = process.argv.slice(2);
const has = f => args.includes(f);
const ci = args.indexOf('--case');
const only = ci >= 0 ? (args[ci + 1] || '').split(',').filter(Boolean) : null;

if (has('--list')) {
  for (const c of CASES) console.log(`${c.id.padEnd(22)} ${c.full ? 'полные массивы' : 'счётчики + хэши'}`);
} else if (has('--write')) {
  const t0 = performance.now();
  writeWorldSnapshots({ only });
  console.log(`готово за ${((performance.now() - t0) / 1000).toFixed(1)} с`);
} else if (has('--check')) {
  const t0 = performance.now();
  const r = checkWorldSnapshots({ strict: has('--strict'), only, log: s => console.log(s) });
  console.log(r.report.split('\n').filter(l => !l.startsWith('check ')).join('\n'));
  console.log(`${r.ok ? 'OK' : 'РАСХОЖДЕНИЕ'} за ${((performance.now() - t0) / 1000).toFixed(1)} с`);
  process.exitCode = r.ok ? 0 : 1;
} else {
  console.log('укажите --write, --check или --list');
  process.exitCode = 2;
}
