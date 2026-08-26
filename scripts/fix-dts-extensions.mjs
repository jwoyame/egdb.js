/**
 * Give the emitted .d.ts files explicit import extensions.
 *
 * rollup's TypeScript plugin writes relative type imports without an extension
 * (`from './types'`). Consumers on `moduleResolution: NodeNext` cannot resolve
 * those -- it is a TS2834 error -- and because most consumers also run with
 * `skipLibCheck: true`, the error is swallowed and EVERY type this package
 * exports silently degrades to `any`. That is not theoretical: it is why a
 * geometry payload with the wrong nesting compiled cleanly in openparcels and
 * shipped as a live bug.
 *
 * `./x.js` is the correct specifier -- NodeNext maps it to `./x.d.ts`.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const DIST = new URL('../dist/', import.meta.url).pathname;

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p));
    else if (e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

// `from './x'` / `from "../x"` and `import('./x')`, but never a bare specifier
// like 'mssql', and never one that already has an extension.
const SPEC = /(\bfrom\s*|\bimport\s*\(\s*)(['"])(\.\.?\/[^'"]*?)\2/g;

let changed = 0, touched = 0;
for (const file of await walk(DIST)) {
  const src = await readFile(file, 'utf8');
  let n = 0;
  const out = src.replace(SPEC, (m, lead, q, spec) => {
    if (/\.(js|cjs|mjs|json)$/.test(spec)) return m;
    n++;
    return `${lead}${q}${spec}.js${q}`;
  });
  if (n) { await writeFile(file, out); changed += n; touched++; }
}
console.log(`fix-dts-extensions: rewrote ${changed} specifier(s) across ${touched} file(s)`);
