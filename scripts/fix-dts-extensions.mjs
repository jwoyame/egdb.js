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
import { readdir, readFile, writeFile, access } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';

const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

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

// A specifier can point at a FILE (./types -> types.d.ts) or at a DIRECTORY
// (./reconcile -> reconcile/index.d.ts). Appending ".js" blindly turns the
// second kind into "./reconcile.js", which does not exist -- so those imports
// stay unresolvable and every type behind them silently stays `any`. That is
// the exact failure this script exists to prevent, so it has to distinguish
// the two.
async function resolveSpecifier(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  if (await exists(`${base}.d.ts`)) return `${spec}.js`;
  if (await exists(join(base, 'index.d.ts'))) return `${spec}/index.js`;
  return null;
}

let changed = 0, touched = 0, unresolved = [];
for (const file of await walk(DIST)) {
  const src = await readFile(file, 'utf8');
  const specs = [...src.matchAll(SPEC)];
  const rewrites = new Map();
  for (const [, , , spec] of specs) {
    if (/\.(js|cjs|mjs|json)$/.test(spec) || rewrites.has(spec)) continue;
    const target = await resolveSpecifier(file, spec);
    if (target) rewrites.set(spec, target);
    else unresolved.push(`${file}: ${spec}`);
  }
  let n = 0;
  const out = src.replace(SPEC, (m, lead, q, spec) => {
    const target = rewrites.get(spec);
    if (!target) return m;
    n++;
    return `${lead}${q}${target}${q}`;
  });
  if (n) { await writeFile(file, out); changed += n; touched++; }
}

if (unresolved.length) {
  console.error('fix-dts-extensions: could not resolve:\n  ' + unresolved.join('\n  '));
  process.exit(1);
}
console.log(`fix-dts-extensions: rewrote ${changed} specifier(s) across ${touched} file(s)`);
