#!/usr/bin/env node
/**
 * Fails the build when the Workbox precache manifest grows beyond a
 * fixed byte budget. Precache downloads on install and competes with
 * the user's data plan — letting it drift silently is how a 2 MB app
 * becomes a 10 MB app after a few deploys.
 *
 * Reads dist/service-worker.js, pulls the __WB_MANIFEST url list, then
 * sums the file sizes from dist/. Exits 1 when the total exceeds
 * MAX_PRECACHE_BYTES.
 *
 * Threshold chosen with ~60% headroom over the current manifest
 * (~1.88 MB as of 2026-04-24). Raise deliberately when you really need
 * to precache more — the point is the review, not the number.
 */
import { readFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = resolve(__dirname, '..', 'dist');
const SW_PATH  = resolve(DIST_DIR, 'service-worker.js');
const MAX_PRECACHE_BYTES = 3 * 1024 * 1024; // 3 MB

const sw = readFileSync(SW_PATH, 'utf8');

// injectManifest emits __WB_MANIFEST as a JSON array. The exact shape
// varies slightly between vite-plugin-pwa versions; what's stable is
// "url":"...","revision":"..."} per entry. Pull URLs with a regex over
// the whole SW source — it's minified so no multi-line concerns.
const urls = Array.from(sw.matchAll(/"url":"([^"]+)"/g)).map((m) => m[1]);

if (urls.length === 0) {
  console.error('[check-precache-size] No precache entries found — __WB_MANIFEST shape changed?');
  console.error(`  SW: ${SW_PATH}`);
  process.exit(1);
}

let total = 0;
const rows = [];
for (const url of urls) {
  // Strip query string if Workbox added a revision as ?__WB_REVISION__=
  const clean = url.split('?')[0];
  const abs = resolve(DIST_DIR, clean.replace(/^\//, ''));
  try {
    const size = statSync(abs).size;
    total += size;
    rows.push({ url: clean, size });
  } catch {
    console.warn(`[check-precache-size] Missing file referenced in precache: ${clean}`);
  }
}

const human = (n) => (n / 1024).toFixed(1) + ' KiB';
const overBudget = total > MAX_PRECACHE_BYTES;

console.log(`[check-precache-size] ${urls.length} entries, total ${human(total)} (budget ${human(MAX_PRECACHE_BYTES)})`);

if (overBudget) {
  console.error('');
  console.error('Top 10 largest precache entries:');
  rows.sort((a, b) => b.size - a.size);
  for (const r of rows.slice(0, 10)) {
    console.error(`  ${human(r.size).padStart(10)}  ${r.url}`);
  }
  console.error('');
  console.error(`[check-precache-size] FAIL: precache is ${human(total - MAX_PRECACHE_BYTES)} over budget.`);
  console.error('Fix: move large assets out of globPatterns into runtime CacheFirst,');
  console.error('or raise MAX_PRECACHE_BYTES in scripts/check-precache-size.mjs with a reason.');
  process.exit(1);
}
