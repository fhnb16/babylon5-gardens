/* core/** must stay engine-agnostic and QuickJS-safe (AGENTS.md rules 2–4):
   no three, DOM, WebAudio, timers, fetch, Node built-ins, import.meta,
   Math.random, top-level await. Scans every core/**.ts except core/test/**. */
import { describe, expect, test } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (relative(CORE_DIR, p).split(sep)[0] === 'test') continue;
      walk(p, out);
    } else if (/\.ts$/.test(name)) out.push(p);
  }
  return out;
}

/** Replace comments (and optionally string/template/regex-free literal contents) with spaces, keeping offsets and newlines. */
function strip(src: string, stripStrings: boolean): string {
  let out = '';
  let i = 0;
  const n = src.length;
  const blank = (s: string): string => s.replace(/[^\n]/g, ' ');
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') {
      let j = i; while (j < n && src[j] !== '\n') j++;
      out += blank(src.slice(i, j)); i = j;
    } else if (c === '/' && d === '*') {
      const j = src.indexOf('*/', i + 2); const e = j < 0 ? n : j + 2;
      out += blank(src.slice(i, e)); i = e;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && src[j] !== c) { if (src[j] === '\\') j++; j++; }
      const lit = src.slice(i, j + 1);
      out += stripStrings ? c + blank(lit.slice(1, -1)) + c : lit;
      i = j + 1;
    } else { out += c; i++; }
  }
  return out;
}

/** `await` outside any (), {} or [] nesting. */
function hasTopLevelAwait(src: string): boolean {
  const s = strip(src, true);
  let depth = 0;
  const re = /[{}()[\]]|\bawait\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const t = m[0];
    if (t === '{' || t === '(' || t === '[') depth++;
    else if (t === '}' || t === ')' || t === ']') depth--;
    else if (depth === 0) return true;
  }
  return false;
}

const FORBIDDEN: [string, RegExp][] = [
  ["import from 'three'", /from\s*['"]three/],
  ["dynamic import of three", /import\(\s*['"]three/],
  ['document.', /\bdocument\./],
  ['window.', /\bwindow\./],
  ['requestAnimationFrame', /\brequestAnimationFrame\b/],
  ['AudioContext', /\bAudioContext\b/],
  ['import.meta', /\bimport\.meta\b/],
  ['Math.random(', /\bMath\.random\s*\(/],
  ['setTimeout / setInterval', /\bset(Timeout|Interval)\s*\(/],
  ['fetch(', /\bfetch\s*\(/],
  ['structuredClone', /\bstructuredClone\b/],
  ['TextEncoder / TextDecoder', /\bText(En|De)coder\b/],
  ['Intl.', /\bIntl\./],
  ['Node built-in import', /from\s*['"](node:|fs['"/]|path['"/]|os['"/]|crypto['"/]|worker_threads['"/])/],
  ['Worker / OffscreenCanvas', /\b(new\s+Worker|OffscreenCanvas)\b/]
];

export function violations(src: string): string[] {
  const noComments = strip(src, false);
  const found = FORBIDDEN.filter(([, re]) => re.test(noComments)).map(([name]) => name);
  if (hasTopLevelAwait(src)) found.push('top-level await');
  return found;
}

describe('core purity', () => {
  const files = walk(CORE_DIR);

  test('scans a sensible set of files', () => {
    const rel = files.map(f => relative(CORE_DIR, f).split(sep).join('/'));
    expect(rel.length).toBeGreaterThan(5);
    expect(rel).toContain('rng.ts');
    expect(rel).toContain('math/mat4.ts');
    expect(rel).toContain('geometry/mesh.ts');
    expect(rel.some(f => f.startsWith('test/'))).toBe(false);
  });

  test('the checker itself catches every forbidden construct (and ignores comments)', () => {
    expect(violations("import * as T from 'three';")).toContain("import from 'three'");
    expect(violations('import { Vector3 } from "three/src/x.js"')).toContain("import from 'three'");
    expect(violations('const a = document.body;')).toContain('document.');
    expect(violations('const w = window.innerWidth;')).toContain('window.');
    expect(violations('requestAnimationFrame(f)')).toContain('requestAnimationFrame');
    expect(violations('new AudioContext()')).toContain('AudioContext');
    expect(violations('const u = import.meta.url;')).toContain('import.meta');
    expect(violations('const r = Math.random();')).toContain('Math.random(');
    expect(violations('setTimeout(f, 1)')).toContain('setTimeout / setInterval');
    expect(violations("import fs from 'node:fs';")).toContain('Node built-in import');
    expect(violations('const x = await load();')).toContain('top-level await');
    expect(violations('await init();\nexport const a = 1;')).toContain('top-level await');
    // allowed: await inside a function, mentions in comments and strings
    expect(violations('async function f() { await g(); }')).toEqual([]);
    expect(violations('const f = async () => { const a = await g(); return a; };')).toEqual([]);
    expect(violations("// window.x and Math.random() and from 'three'\n/* document.y */ const a = 1;")).toEqual([]);
    expect(violations("const s = 'await';")).toEqual([]);
  });

  test('no core file (outside core/test) contains a forbidden construct', () => {
    const bad: Record<string, string[]> = {};
    for (const f of files) {
      const v = violations(readFileSync(f, 'utf8'));
      if (v.length) bad[relative(CORE_DIR, f).split(sep).join('/')] = v;
    }
    expect(bad).toEqual({});
  });
});
