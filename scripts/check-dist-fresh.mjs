/**
 * Is dist/ actually built from the current src/?
 *
 * Two earlier attempts at this check were WRONG, which is worth recording
 * because a check that measures the wrong thing is worse than no check -- it
 * ends the investigation with a false green:
 *
 *   1. Comparing the pnpm store inode against the source dist inode. That only
 *      detects a broken hardlink. It reported IN-SYNC for a dist missing an
 *      entire commit.
 *   2. Comparing newest-source-mtime against newest-dist-mtime. rollup does not
 *      rewrite outputs whose content did not change, so a correct build can
 *      leave the newest dist file older than the newest source file.
 *
 * So: hash the sources, stamp the hash into dist at build time, compare. The
 * only thing that can make this lie is not running it.
 */
import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = new URL('..', import.meta.url).pathname;
const STAMP = join(ROOT, 'dist', '.src-hash');

async function hashSources() {
  const files = [];
  async function walk(d) {
    let entries;
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) { await walk(p); continue; }
      // Tests do not ship, so they must not invalidate the build.
      if (!e.name.endsWith('.ts') || e.name.endsWith('.test.ts')) continue;
      files.push(p);
    }
  }
  await walk(join(ROOT, 'src'));
  // Build inputs count too. Hashing only src/ meant a change to the rollup
  // config, the tsconfig, or the .d.ts fixer left a genuinely stale dist
  // reported as fresh -- the same false-green this script exists to prevent.
  for (const extra of ['rollup.config.js', 'tsconfig.json', 'scripts/fix-dts-extensions.mjs']) {
    files.push(join(ROOT, extra));
  }
  const h = createHash('sha256');
  for (const f of files) {
    h.update(f.slice(ROOT.length));
    try { h.update(await readFile(f)); } catch { h.update('<missing>'); }
  }
  return h.digest('hex');
}

const current = await hashSources();

if (process.argv[2] === '--write') {
  await writeFile(STAMP, current + '\n');
  console.log('dist/.src-hash stamped');
  process.exit(0);
}

let stamped = null;
try { stamped = (await readFile(STAMP, 'utf8')).trim(); } catch { /* no stamp */ }

try { await stat(join(ROOT, 'dist', 'index.js')); }
catch { console.error('dist/ is missing entirely -- run the build.'); process.exit(1); }

if (!stamped) {
  console.error('dist/ carries no build stamp -- it predates this check. Rebuild.');
  process.exit(1);
}
if (stamped !== current) {
  console.error('dist/ is STALE: src has changed since it was built.');
  console.error(`  stamped: ${stamped.slice(0, 16)}...`);
  console.error(`  current: ${current.slice(0, 16)}...`);
  console.error('Run the build before publishing, vendoring or deploying.');
  process.exit(1);
}
console.log('dist/ is up to date with src/.');
