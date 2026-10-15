import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Voxshift's one public address is https://www.voxshift.io. An old domain kept creeping into docs, examples and comments, so this fails the
 * build if it appears anywhere in the repository (the needle is built in pieces so this file does not contain it).
 */
const OLD = ['direct', 'routing', '.online'].join('');
const ROOT = resolve(__dirname, '../../..');
const SKIP = new Set(['node_modules', 'dist', '.git', 'coverage', '.turbo']);
const EXT = /\.(ts|tsx|js|mjs|cjs|json|md|yml|yaml|sql|html|css|env|example|txt|conf)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (EXT.test(name) || name.startsWith('.env')) out.push(p);
  }
  return out;
}

describe('the public address', () => {
  it('never mentions the old domain: use https://www.voxshift.io', () => {
    const hits = walk(ROOT).filter((f) => readFileSync(f, 'utf8').toLowerCase().includes(OLD));
    expect(hits.map((f) => f.replace(ROOT + '/', ''))).toEqual([]);
  });
});
