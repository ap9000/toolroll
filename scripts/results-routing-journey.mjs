#!/usr/bin/env node
/** Results routing, slice 1 (docs/plans/results-routing.md): the task page's "Result record" line, at desktop and
 * phone, on synthetic data (the ui-polish fixture: an in-memory database, no live model, Git history, installed
 * database or external write). Run after `npm run build`. Default: assert and clean up; --capture also saves
 * screenshots to evidence/results-routing-journey/.
 *
 *   1. Empty: a task with no build shows no record line.
 *   2. A small task built on one model, its result waiting: the line says so; the record pass saves the same words.
 *   3. Feedback → revision: a person requests a change on a result page; the revision is filed with origin person.
 *      (The fixture's sealed result was built for screenshots on another provider, so its record isn't counted and
 *      says why; a person revision rejecting a counted record is unit-tested.) An automatic-review revision on
 *      another task leaves its record as it was.
 *   4. A long project name on the phone: no horizontal overflow.
 * Pending → provisional → mature over 14 days, and every rejection and exclusion, are unit-tested
 * (src/route-results.test.ts): a journey can't seal a passing check or move the clock without editing records. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startFixture } from './ui-polish-fixture.mjs';
import { recordRunModelReported } from '../dist/store.js';
import { propose, approve } from '../dist/scope.js';
import { recordRevisionOrigin } from '../dist/route-store.js';
import { reevaluateResultRecords, resultRecordOf } from '../dist/route-results.js';

const capture = process.argv.includes('--capture');
const out = resolve('evidence/results-routing-journey');
if (capture) mkdirSync(out, { recursive: true });
for (const file of readdirSync(resolve('src')).filter(n => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
  const built = resolve('dist', file.replace(/\.ts$/, '.js'));
  assert(existsSync(built) && statSync(built).mtimeMs >= statSync(resolve('src', file)).mtimeMs, `Run npm run build first: ${file}`);
}
async function playwright() {
  try { return await import('playwright'); } catch { /* an installed copy */ }
  const cache = join(homedir(), '.npm', '_npx');
  const candidates = [process.env.PLAYWRIGHT_MODULE, ...(existsSync(cache) ? readdirSync(cache).map(d => join(cache, d, 'node_modules/playwright/index.mjs')) : [])].filter(Boolean);
  for (const file of candidates) if (existsSync(file)) return import(pathToFileURL(file).href);
  throw Error('Set PLAYWRIGHT_MODULE to an installed Playwright index.mjs');
}
const report = { synthetic: true, modelCalls: 0, checks: [] };
const check = (label, value) => { assert(value, label); report.checks.push(label); console.log('PASS ' + label); };
const { chromium } = await playwright();
const browser = await chromium.launch({ headless: true });
const MODEL = 'claude-haiku-4-5';

try {
  for (const [name, width, height] of [['desktop', 1440, 900], ['phone', 390, 844]]) {
    const fixture = await startFixture({ git: false, secondProject: true });
    const store = fixture.store, repo = fixture.repos.second, now = new Date();
    // The long project's Models rows: a Claude builder, so its runs report their model.
    for (const phase of ['plan', 'build', 'review', 'repair']) store.setPhaseConfig(repo, phase, 'claude', MODEL, 'polish-fixture', now);
    const file = (id, title) => {
      store.createTask({ id, title }, now);
      const ref = store.refFor('built-in', id).id;
      store.placeTask(ref, repo);
      store.writeSizing(ref, { size: 'small', risky: false, source: 'person', reason: 'synthetic journey task' });
      propose(store, { taskId: id, goal: 'Keep the export labels short (synthetic).', touches: ['src/export/labels.ts'], now });
      assert(approve(store, id, fixture.name, now, store.getScope(id).digest, fixture.password).ok, `approve ${id}`);
      return ref;
    };
    const build = (id, ref) => {
      const authority = store.routeAuthorityFor(ref, 'builder');
      assert(authority?.ok, `route for ${id}`);
      const run = store.startRun({ taskRef: ref, leaseId: `journey-${id}`, runner: 'night-shift-1', branch: `standing-orders/${id}`, worktree: join(repo, `.journey-${id}`), route: authority.stamp, now });
      store.stampRun(run, { scopeDigest: store.getScope(id).digest });
      store.stampProviderStart(run, now);
      recordRunModelReported(store, run, MODEL, false);
      store.finishRun(run, { outcome: 'built', committed: true, now });
      return run;
    };
    const emptyRef = file('record-empty', 'Shorten export labels (synthetic, not built)');
    void emptyRef;
    const waitingRef = file('record-waiting', 'Shorten export labels (synthetic, built)');
    const waitingRun = build('record-waiting', waitingRef);
    const autoRef = file('record-auto', 'Shorten export labels (synthetic, reviewed automatically)');
    const autoRun = build('record-auto', autoRef);
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce', isMobile: width === 390, hasTouch: width === 390 });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto(fixture.url + '/login');
      await page.locator('[name="name"]').fill(fixture.name);
      await page.locator('[name="token"]').fill(fixture.password);
      await page.locator('button[type="submit"]').click();
      await page.waitForURL(url => !url.pathname.startsWith('/login'));
      const details = async id => {
        await page.goto(fixture.url + '/t/' + encodeURIComponent(id));
        // The page's own Details button (the desktop one, or the phone's icon), which opens the details drawer.
        await page.getByRole('button', { name: 'Details' }).locator('visible=true').first().click();
        await page.waitForSelector('[data-task-details]', { state: 'visible' });
        const fact = page.locator('[data-detail-fact="Result record"]');
        return (await fact.count()) === 0 ? null : (await fact.innerText()).trim();
      };
      const fits = async label => check(`${name}: ${label} has no horizontal overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
      const shot = async label => { if (capture) await page.screenshot({ path: join(out, `${name}-${label}.png`), fullPage: false }); };

      check(`${name}: a task with no build shows no result record`, await details('record-empty') === null);
      await fits('the empty task');
      // The synthetic build sealed no check, so the result isn't counted, and says why.
      const waiting = await details('record-waiting');
      check(`${name}: a built task's record line says what it is, in plain words`, waiting === "Not counted: its check result can't be read");
      await fits('the long project name');
      await shot('record-waiting');
      reevaluateResultRecords(store, repo, fixture.configDir + '/evidence', new Date());
      check(`${name}: the record pass saves the words the page showed`, resultRecordOf(store, 'record-waiting', fixture.configDir + '/evidence', new Date())?.words === waiting);

      // Feedback → revision, as a person, through the result's own form (the fixture's sealed result).
      await page.goto(`${fixture.url}/r/${fixture.runId}`);
      const form = page.locator('#comment-form');
      await form.waitFor({ state: 'attached' });
      const before = store.raw().prepare("SELECT COUNT(*) AS n FROM task_ref WHERE revision_of = 'payout-rounding'").get().n;
      // The page's own form, as it was rendered (its CSRF, batch, source and request fields), posted with this browser
      // session's cookie: the console's Request changes, whatever surface shows it.
      const fields = await form.evaluate(el => [...new FormData(el).entries()].map(([k, v]) => [k, String(v)]));
      const action = await form.getAttribute('action');
      const posted = Object.fromEntries(fields);
      posted.note = 'Keep the payout labels on one line on a phone.'; posted.intent = 'revise';
      const answer = await page.request.post(fixture.url + action, { form: posted, headers: { origin: fixture.url }, maxRedirects: 0 });
      check(`${name}: Request changes is accepted`, answer.status() === 303);
      const child = store.raw().prepare("SELECT external_id, revision_origin FROM task_ref WHERE revision_of = 'payout-rounding' ORDER BY id DESC LIMIT 1").get();
      check(`${name}: a person's requested change files one revision, with origin person`, store.raw().prepare("SELECT COUNT(*) AS n FROM task_ref WHERE revision_of = 'payout-rounding'").get().n === before + 1 && child?.revision_origin === 'person');
      // The fixture's result was built for screenshots on another provider: its record isn't counted, and says why.
      check(`${name}: the revised task's record says why it isn't counted`, await details('payout-rounding') === 'Not counted: not a small or routine task with default checks');
      await shot('revised');
      // An automatic-review revision on another task: its record stays as it was (only a person's revision rejects).
      const autoBefore = await details('record-auto');
      const brief = Buffer.from(JSON.stringify({ schema: 1, sourceTask: 'record-auto', sourceRun: autoRun, sourceScopeDigest: store.getScope('record-auto').digest, head: null, comments: [] }));
      const { writeEvidenceFile } = await import('../dist/evidence.js');
      const { createHash } = await import('node:crypto');
      const key = writeEvidenceFile(fixture.configDir + '/evidence', autoRun, 'journey-brief.json', brief);
      const sealed = store.sealRevision({ source: { task: 'record-auto', run: autoRun, scopeDigest: store.getScope('record-auto').digest },
        brief: { evidenceRoot: fixture.configDir + '/evidence', key, bytes: brief.length, sha256: createHash('sha256').update(brief).digest('hex'), capture: 'synthetic brief' },
        child: { title: 'Revise (synthetic)', repair: 'apply the review' }, commentIds: null }, new Date());
      assert(sealed.ok, sealed.ok ? '' : sealed.detail);
      recordRevisionOrigin(store, sealed.id, 'automatic-review');
      check(`${name}: an automatic-review revision leaves the record as it was`, await details('record-auto') === autoBefore);
      void waitingRun;
      check(`${name}: no page errors`, errors.length === 0);
    } finally { await context.close(); await fixture.stop(); }
  }
  console.log(JSON.stringify(report));
} finally { await browser.close(); }
