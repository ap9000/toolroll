#!/usr/bin/env node
/** The Code map page (docs/plans/code-map.md §6), at desktop and phone, on synthetic data: browse, search, a GitHub link,
 * each state, a refresh between two pages keeping the pinned version, a failure and its next try, and a long unbroken
 * name on the phone. Fetching a real remote is covered by src/code-map.slow.test.ts; here versions go in through the
 * library, as a build would publish them. Run after `npm run build`. --capture saves screenshots to evidence/code-map-journey/. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startFixture } from './ui-polish-fixture.mjs';
import { buildCodeMap } from '../dist/code-map-shape.js';
import { digestOfUrl, encodeMap, publishVersion, recordFailure, releaseLease, takeLease } from '../dist/code-map-store.js';

const capture = process.argv.includes('--capture');
const out = resolve('evidence/code-map-journey');
if (capture) mkdirSync(out, { recursive: true });
async function playwright() {
  try { return await import('playwright'); } catch { /* an installed copy */ }
  const cache = join(homedir(), '.npm', '_npx');
  const candidates = [process.env.PLAYWRIGHT_MODULE, ...(existsSync(cache) ? readdirSync(cache).map(d => join(cache, d, 'node_modules/playwright/index.mjs')) : [])].filter(Boolean);
  for (const file of candidates) if (existsSync(file)) return import(pathToFileURL(file).href);
  throw Error('Set PLAYWRIGHT_MODULE to an installed Playwright index.mjs');
}
const check = (label, value) => { assert(value, label); console.log('PASS ' + label); };
const REMOTE = 'https://github.com/acme/ledger.git';
const LONG = `src/${'averyveryverylongunbrokenfoldername'.repeat(6)}/${'anotherunbrokenfilename'.repeat(6)}.ts`;

function publish(store, repo, commit, files, now, startedFrom) {
  const entries = Object.keys(files).map(path => ({ path, mode: '100644', bytes: 1200 }));
  const facts = new Map(Object.entries(files).map(([path, names]) => [path, { exports: names.map((name, at) => ({ name, kind: 'function', line: at + 1 })), imports: [], external: [], parseFailed: false }]));
  const map = buildCodeMap({ repo, commit, remote: { urlDigest: digestOfUrl(REMOTE), record: 0 }, builtAt: now.toISOString(), extractor: 'journey', entries, entryCount: entries.length, withheld: 0, facts, unread: new Map(), manifests: new Map(), warnings: [] });
  const lease = takeLease(store, repo, 'journey', now);
  const done = publishVersion(store, lease, { map, encoded: encodeMap(map), identity: { url: REMOTE, record: 0 }, startedFrom, report: JSON.stringify({ enforced: 'checked', proxy: null }) }, now);
  releaseLease(store, lease);
  assert(done?.current, 'published');
  return done.version;
}

const { chromium } = await playwright();
const browser = await chromium.launch({ headless: true });
try {
  for (const [name, width, height] of [['desktop', 1440, 900], ['phone', 390, 844]]) {
    const fixture = await startFixture({ git: false, secondProject: true });
    const { store } = fixture, repo = fixture.repos.second, now = new Date();
    store.upsertProject(repo, repo.split('/').at(-1), now, { remoteUrl: REMOTE });
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce', isMobile: width === 390, hasTouch: width === 390 });
    const page = await context.newPage();
    const fits = async label => check(`${name}: ${label} has no sideways scroll`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    const shot = async label => { if (capture) await page.screenshot({ path: join(out, `${name}-${label}.png`), fullPage: true }); };
    try {
      await page.goto(fixture.url + '/login');
      await page.locator('[name="name"]').fill(fixture.name);
      await page.locator('[name="token"]').fill(fixture.password);
      await page.locator('button[type="submit"]').first().click();
      await page.waitForURL(url => !url.pathname.startsWith('/login'));
      const base = `${fixture.url}/projects/${encodeURIComponent(repo.split('/').at(-1))}/map`;

      await page.goto(base);
      check(`${name}: the first map is on its way`, (await page.textContent('body')).includes('Making the first map.'));
      await fits('making'); await shot('making');

      const first = publish(store, repo, 'a'.repeat(40), { 'src/export/csv.ts': ['writeCsv'], 'src/export/range.ts': ['inRange'], 'src/ledger/entry.ts': ['Entry'], [LONG]: ['aVeryLongExportedName'.repeat(9)] }, now, null);
      await page.goto(base);
      check(`${name}: areas show`, (await page.textContent('body')).includes('Areas'));
      await fits('areas'); await shot('areas');
      await page.getByText('Where this comes from').click();
      check(`${name}: the label is on demand`, (await page.textContent('body')).includes('untrusted data'));

      await page.goto(`${base}?v=${first}&q=writeCsv`);
      await page.locator('.cm-item a').first().click();
      check(`${name}: a file links to GitHub at its commit`, await page.locator(`a[href*="github.com/acme/ledger/blob/${'a'.repeat(40)}"]`).count() === 1);

      await page.goto(`${base}?v=${first}&q=anotherunbroken`);
      await fits('a long unbroken name'); await shot('long-name');

      // A refresh between two pages keeps the pinned version.
      publish(store, repo, 'b'.repeat(40), { 'src/other/new.ts': ['fresh'] }, now, first);
      await page.goto(`${base}?v=${first}&q=writeCsv`);
      check(`${name}: a pinned page still reads its version`, (await page.textContent('body')).includes('src/export/csv.ts'));

      const lease = takeLease(store, repo, 'journey', now);
      recordFailure(store, lease, "couldn't read main: its host name couldn't be resolved", 'failed', now);
      releaseLease(store, lease);
      await page.goto(base);
      const failed = await page.textContent('body');
      check(`${name}: a failure says why and when, with the last map`, failed.includes("Couldn't check main") && failed.includes('Next try at') && failed.includes('Areas'));
      await fits('failure'); await shot('failure');

      store.handle.prepare('UPDATE project SET code_map = 0 WHERE path = ?').run(repo);
      await page.goto(base);
      check(`${name}: off says so`, (await page.textContent('body')).includes('The code map is off.'));
      await fits('off');
    } finally { await context.close(); await fixture.stop(); }
  }
} finally { await browser.close(); }
