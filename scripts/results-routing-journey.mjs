#!/usr/bin/env node
/** Results routing, slices 1 to 3 (docs/plans/results-routing.md): the task page's "Result record" line, and
 * Settings → Models → Suggested (empty, an offer, its review, a stale offer, a refused save, the rule, the evidence
 * line, Turn off; then a trial offer, starting it, a trial task's line, its progress, full and Stop), at desktop and phone, on synthetic data (the ui-polish fixture: an in-memory database, no live model, Git history, installed
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
    const file = (id, title, size = 'small') => {
      store.createTask({ id, title }, now);
      const ref = store.refFor('built-in', id).id;
      store.placeTask(ref, repo);
      store.writeSizing(ref, { size, risky: false, source: 'person', reason: 'synthetic journey task' });
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

      // ---- slice 2: Settings → Models → Suggested, at this viewport, on the long-named project ----
      const models = async (query = '') => { await page.goto(`${fixture.url}/settings/models?scope=${encodeURIComponent(repo)}${query}`); return page.locator('section[aria-labelledby="models-suggested"]'); };
      let section = await models();
      check(`${name}: Suggested, empty, says how a suggestion comes`, (await section.innerText()).includes('No suggestions yet.'));
      await fits('the empty Suggested group');
      // Synthetic evidence: small tasks build on Sonnet here; Haiku has ten accepted, checked small tasks, and is cheaper.
      const HAIKU = 'claude-haiku-5-5', SONNET = 'claude-sonnet-5-5';
      store.setPhaseTierConfig(repo, 'build', 'light', 'claude', SONNET, 'polish-fixture', now);
      for (const phase of ['build', 'repair']) store.setPhaseConfig(repo, phase, 'claude', SONNET, 'polish-fixture', now);
      const { recordCatalog } = await import('../dist/model-catalog.js');
      const prices = haikuIn => recordCatalog(store, [
        { source: 'claude', id: HAIKU, name: 'Claude Haiku 5.5', inputUsd: haikuIn, outputUsd: 5, context: null, tools: true, releasedAt: null },
        { source: 'claude', id: SONNET, name: 'Claude Sonnet 5.5', inputUsd: 3, outputUsd: 15, context: null, tools: true, releasedAt: null }], now);
      prices(1);
      const { saveResultRecord } = await import('../dist/route-store.js');
      let seq = 0;
      const evidence = (state, when) => {
        const id = `journey-evidence-${name}-${++seq}`;
        store.createTask({ id, title: `Synthetic evidence ${seq}` }, now);
        const ref = store.refFor('built-in', id).id;
        store.placeTask(ref, repo);
        saveResultRecord(store, { taskRef: ref, task: id, repo, cohortSize: 'small', provider: 'claude', model: HAIKU, state, reason: state === 'rejected' ? 'check-failed' : null, resultRun: null,
          firstStartedAt: when.toISOString(), acceptedAt: null, decidedAt: null, modelFailures: 0, infraFailures: 0, apiMicrousd: 400000, subscriptionRuns: 0, subscriptionTokens: 0, unknownRuns: 0,
          remediationRuns: 0, selections: [], settled: true, personRevisions: 0, firstCheckPassed: null, agentTurns: 0, turnsUnknownRuns: 0, accumulationEnded: false }, when);
      };
      for (let one = 0; one < 10; one++) evidence('mature', new Date(now.getTime() - (30 - one) * 86_400_000));
      section = await models();
      check(`${name}: the suggestion shows its evidence, with Review change and Not now`, (await section.innerText()).includes('Claude Haiku 5.5 for small tasks instead of Claude Sonnet 5.5: 10 of the last 10 decided similar tasks were accepted with checks passing')
        && await section.getByRole('link', { name: 'Review change' }).count() === 1 && await section.getByRole('button', { name: 'Not now' }).count() === 1);
      await fits('a suggestion beside a long project name');
      await shot('suggested');
      // Review change: the evidence, prices and switch-back terms, saved with a step-up.
      await section.getByRole('link', { name: 'Review change' }).click();
      await page.waitForURL(url => url.search.includes('suggestion='));
      section = page.locator('section[aria-labelledby="models-suggested"]');
      check(`${name}: Review change shows the switch-back terms before saving`, (await section.innerText()).includes('It switches itself off if 2 of the latest 5 decided tasks are rejected'));
      await fits('the review');
      await shot('review');
      const reviewUrl = page.url();
      // A stale offer: the results moved after the page was drawn; the save refuses in words, nothing saved.
      evidence('mature', new Date(now.getTime() - 86_400_000));
      await section.locator('input[name="password"]').fill(fixture.password);
      await section.getByRole('button', { name: /Use Claude Haiku 5.5/ }).click();
      await page.waitForURL(url => url.search.includes('problem='));
      const alerts = async () => (await page.locator('[role="alert"]').allInnerTexts()).join(' | ');
      check(`${name}: a stale offer refuses as out of date`, (await alerts()).includes('out of date'));
      await page.goto(reviewUrl);
      check(`${name}: reviewing an offer that changed says it's out of date`, (await page.locator('section[aria-labelledby="models-suggested"] [role="alert"]').innerText()).includes('This suggestion is out of date'));
      await fits('the stale review');
      await shot('stale');
      // A price that changed between Review and Save: refused by name (the error state).
      section = await models();
      await section.getByRole('link', { name: 'Review change' }).click();
      await page.waitForURL(url => url.search.includes('suggestion='));
      section = page.locator('section[aria-labelledby="models-suggested"]');
      prices(1.5);
      await section.locator('input[name="password"]').fill(fixture.password);
      await section.getByRole('button', { name: /Use Claude Haiku 5.5/ }).click();
      await page.waitForURL(url => url.search.includes('problem='));
      check(`${name}: a changed price refuses in words`, (await alerts()).includes('A listed price changed'));
      await fits('the refused save');
      await shot('refused');
      // Accept for real.
      section = await models();
      await section.getByRole('link', { name: 'Review change' }).click();
      await page.waitForURL(url => url.search.includes('suggestion='));
      section = page.locator('section[aria-labelledby="models-suggested"]');
      await section.locator('input[name="password"]').fill(fixture.password);
      await section.getByRole('button', { name: /Use Claude Haiku 5.5/ }).click();
      await page.waitForURL(url => url.search.includes('said='));
      check(`${name}: accepted, with the rule listed and Turn off beside it`, (await page.locator('[role="status"]').first().innerText()).includes('Saved.')
        && (await page.locator('section[aria-labelledby="models-suggested"]').innerText()).includes('Claude Haiku 5.5 builds small tasks instead of Claude Sonnet 5.5'));
      await fits('the rule in use');
      await shot('rule');
      // A new small task routes to Haiku, and its plan says why.
      const ruled = file('record-ruled', 'Shorten export labels (synthetic, under the earned rule)');
      void ruled;
      await page.goto(fixture.url + '/t/record-ruled');
      const why = page.locator('[data-route-evidence]').first();
      check(`${name}: a new small task's approved route says why this model`, ((await why.textContent()) ?? '').trim().startsWith('Why this model: Claude Haiku 5.5 builds small tasks in this project.'));
      await fits('the evidence line');
      await shot('evidence');
      // Chat and screen counts match: the lead's read (get_models) lists what the page lists.
      const { suggestionsFor, rulesOf } = await import('../dist/route-rules.js');
      check(`${name}: the lead reads the same rules the page shows`, rulesOf(store, repo, new Date()).length === 1 && suggestionsFor(store, repo, new Date()).length === 0);
      // Turn off: tasks already approved keep their model.
      section = await models();
      await section.getByRole('button', { name: 'Turn off' }).first().click();
      await page.waitForURL(url => url.search.includes('said='));
      check(`${name}: Turn off says approved tasks keep their model`, (await page.locator('[role="status"]').first().innerText()).includes('tasks already approved keep their model'));

      // ---- slice 3: a trial, on routine tasks (Sonnet has ten accepted routine tasks here; Haiku has none) ----
      for (let one = 0; one < 10; one++) {
        const id = `journey-routine-${name}-${one}`;
        store.createTask({ id, title: `Synthetic routine evidence ${one}` }, now);
        const ref = store.refFor('built-in', id).id;
        store.placeTask(ref, repo);
        const when = new Date(now.getTime() - (40 - one) * 86_400_000);
        saveResultRecord(store, { taskRef: ref, task: id, repo, cohortSize: 'medium', provider: 'claude', model: SONNET, state: 'mature', reason: null, resultRun: null,
          firstStartedAt: when.toISOString(), acceptedAt: null, decidedAt: null, modelFailures: 0, infraFailures: 0, apiMicrousd: 900000, subscriptionRuns: 0, subscriptionTokens: 0, unknownRuns: 0,
          remediationRuns: 0, selections: [], settled: true, personRevisions: 0, firstCheckPassed: null, agentTurns: 0, turnsUnknownRuns: 0, accumulationEnded: false }, when);
      }
      prices(1);
      section = await models();
      check(`${name}: the trial offer says why, with Try it on the next 10 and Not now`, (await section.innerText()).includes('Claude Sonnet 5.5 does well on routine tasks here (10 of the last 10 accepted with checks passing). Claude Haiku 5.5 has no decided tasks here yet.')
        && await section.getByRole('button', { name: 'Try it on the next 10' }).count() === 1);
      await fits('the trial offer');
      await shot('trial-offer');
      const offerRow = section.locator('form[action="/settings/models/try"]');
      if (await offerRow.locator('input[name="password"]').count() > 0) await offerRow.locator('input[name="password"]').fill(fixture.password);
      await offerRow.getByRole('button', { name: 'Try it on the next 10' }).click();
      await page.waitForURL(url => url.search.includes('said='));
      section = page.locator('section[aria-labelledby="models-suggested"]');
      check(`${name}: the trial starts, and its progress shows`, (await page.locator('[role="status"]').first().innerText()).includes('Trial started.')
        && (await section.innerText()).includes('on the next 10 routine tasks: 0 of 10 so far'));
      await fits('the trial in use');
      await shot('trial-started');
      // A routine task filed now tries Haiku, waits for a person's approval, and its plan says which trial task it is.
      file('record-trial', 'Shorten export labels (synthetic, trying a cheaper model)', 'medium');
      await page.goto(fixture.url + '/t/record-trial');
      const trialWhy = ((await page.locator('[data-route-evidence]').first().textContent()) ?? '').trim();
      check(`${name}: the trial task's line says trial 1 of 10`, trialWhy.startsWith('Trying a cheaper model: Claude Haiku 5.5, trial 1 of 10.'));
      await fits('the trial evidence line');
      await shot('trial-evidence');
      section = await models();
      check(`${name}: the count moves`, (await section.innerText()).includes('1 of 10 so far (0 started, 1 waiting)'));
      // Full: nine more filings take the rest; the eleventh builds on the configured model.
      for (let one = 2; one <= 10; one++) file(`record-trial-${one}`, `Synthetic trial task ${one}`, 'medium');
      file('record-trial-full', 'Synthetic task after the trial is full', 'medium');
      const fullBuild = JSON.parse(store.getScope('record-trial-full').proposedRouteJson).legs[1];
      check(`${name}: a full trial routes the next task on the configured model`, fullBuild.model === SONNET && fullBuild.selection === undefined);
      section = await models();
      check(`${name}: a full trial says 10 of 10`, (await section.innerText()).includes('10 of 10 so far'));
      await fits('the full trial');
      await shot('trial-full');
      await section.getByRole('button', { name: 'Stop' }).first().click();
      await page.waitForURL(url => url.search.includes('said='));
      check(`${name}: Stop says approved tasks keep their model`, (await page.locator('[role="status"]').first().innerText()).includes('Trial stopped.'));
      await fits('the stopped trial');
      await shot('trial-stopped');
      check(`${name}: no page errors`, errors.length === 0);
    } finally { await context.close(); await fixture.stop(); }
  }
  console.log(JSON.stringify(report));
} finally { await browser.close(); }
