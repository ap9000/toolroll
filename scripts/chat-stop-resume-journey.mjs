/** Focused Chromium journey on synthetic data and a scripted chat provider.
 * Run after affected tests (their existing setup builds the current local runtime).
 * No live model, Git history, installed database, or external write is used.
 * Default: assert and clean up. --capture also saves real viewport screenshots. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startFixture } from './ui-polish-fixture.mjs';
import { finalize } from '../dist/claim.js';
import { taskControlOf } from '../dist/task-control.js';

const capture = process.argv.includes('--capture');
const out = resolve('output/playwright/chat-stop-resume-2026-09-15');
mkdirSync(out, { recursive: true });
// Refuse stale generated code rather than test another candidate.
for (const file of readdirSync(resolve('src')).filter(n => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
  const built = resolve('dist', file.replace(/\.ts$/, '.js'));
  assert(existsSync(built) && statSync(built).mtimeMs >= statSync(resolve('src', file)).mtimeMs, `Run affected tests to refresh local runtime: ${file}`);
}
async function playwright() {
  try { return await import('playwright'); } catch { /* use an already installed copy */ }
  const cache = join(homedir(), '.npm', '_npx');
  const candidates = [process.env.PLAYWRIGHT_MODULE, ...readdirSync(cache).map(d => join(cache, d, 'node_modules/playwright/index.mjs'))].filter(Boolean);
  for (const file of candidates) if (existsSync(file)) return import(pathToFileURL(file).href);
  throw Error('Set PLAYWRIGHT_MODULE to an installed Playwright index.mjs');
}
const report = { synthetic: true, modelCalls: 0, viewports: [], checks: [], screenshots: [] };
const check = (label, value) => { assert(value, label); report.checks.push(label); console.log('PASS '+label); };
const { chromium } = await playwright();
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome' });
async function stable(page) {
  await page.waitForFunction(() => { try { return !document.documentElement.matches(':active-view-transition'); } catch { return true; } });
}
async function submit(page, locator) {
  await stable(page);
  await page.evaluate(() => window.__oldDocument = true);
  if (page.viewportSize().width > 600) { await locator.focus(); await locator.press('Enter'); }
  else await locator.click();
  await page.waitForFunction(() => window.__oldDocument === undefined);
  await stable(page);
}
async function fits(page, label) {
  check(label+' has no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
}
async function shot(page, name) {
  await stable(page); await fits(page, name);
  if (capture) { await page.screenshot({ path: join(out, name+'.png') }); report.screenshots.push(name+'.png'); }
}
try {
  for (const [name, width, height] of [['desktop', 1440, 900], ['phone', 390, 844]]) {
    if (process.argv.includes('--phone') && name !== 'phone') continue;
    const answers = [];
    const tool = (name, args) => ({ text: '', calls: [{ id: name, name, args }], tokensIn: 1, tokensOut: 1, reportedCostMicrousd: null });
    const done = { text: 'Review the task and consequence below.', calls: [], tokensIn: 1, tokensOut: 1, reportedCostMicrousd: null };
    const fixture = await startFixture({ git: false, directory: out, sameTaskRevisions: true, runner: async () => {
      const answer = answers.shift(); assert(answer, 'Unexpected scripted provider request'); return { ok: true, answer };
    } });
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce', isMobile: width === 390, hasTouch: width === 390 });
    const page = await context.newPage();
    const detail = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    try {
      const store = fixture.store, task = 'csv-range-tests', taskRef = store.lookupRef(task).id;
      const run = store.runsFor(taskRef)[0], draft = 'Unsent feedback: keep the export labels short.';
      mkdirSync(run.worktree, { recursive: true });
      writeFileSync(join(run.worktree, 'draft.txt'), 'Preserved fixture work\n');
      const approval = store.getScope(task);
      if (name === 'phone') store.raw().prepare('UPDATE task SET title = ? WHERE id = ?').run('Keep CSV exports readable with '+ 'averylongunbrokentaskname'.repeat(6), task);
      const goto = async path => { await page.goto(fixture.url+path); await stable(page); };
      await goto('/login');
      await page.locator('[name="name"]').fill(fixture.name); await page.locator('[name="token"]').fill(fixture.password);
      await submit(page, page.locator('button[type="submit"]'));
      await goto('/chat?task='+task);
      await page.locator('form[action="/chat/mate/mint"] [name="token"]').fill(fixture.password);
      await fits(page, name+' before conversation');
      await submit(page, page.locator('form[action="/chat/mate/mint"] button'));
      await fits(page, name+' empty chat');
      if (name === 'desktop') await shot(page, 'desktop-empty');
      const send = async (message, calls) => {
        answers.push(...calls, done);
        await page.locator('.composer textarea').fill(message);
        await page.locator('.composer button[type="submit"]').click();
        await page.waitForFunction(() => document.querySelector('.composer')?.getAttribute('aria-busy') !== 'true');
        for (let i = 0; i < 100 && (answers.length || store.liveLeadTurnFor(fixture.name)); i++) await new Promise(r => setTimeout(r, 50));
        assert.equal(answers.length, 0);
        await page.waitForSelector('.proposal-task_action.pending, .proposal-review.pending');
        return store.raw().prepare("SELECT id FROM lead_proposal ORDER BY id DESC LIMIT 1").get().id;
      };
      const stop = await send('Stop this task', [tool('get_task', { task }), tool('propose_task_action', { task, run: run.id, operation: 'stop' })]);
      const stopCard = page.locator('article').filter({ has: page.locator(`form[action="/chat/proposal/${stop}/confirm"]`) });
      if (await page.locator('#chat-new-update').isVisible()) await page.locator('#chat-new-update').click();
      await stopCard.evaluate(el => scrollTo(0, el.getBoundingClientRect().top + scrollY - 85));
      const stopWords = await stopCard.innerText();
      check(name+' confirmation names exact task, run and saved-work consequence', stopWords.includes('Run #'+run.id) && stopWords.includes(task) && stopWords.includes('Saved work remains'));
      // Build #1604 feedback: at most two short sentences that still say
      // saved work remains, other tasks continue, and the pause waits.
      const consequence = (await stopCard.locator('p').filter({ hasText: 'acknowledges the stop' }).innerText()).trim();
      check(name+' confirmation consequence is two short sentences naming other tasks and acknowledgement', consequence.includes('other tasks continue') && consequence.length <= 110 && consequence.split(/(?<=\.)\s+/).length <= 2);
      check(name+' confirmation buttons have tap targets and single-line labels', await stopCard.locator('button').evaluateAll(buttons => buttons.every(button => {
        const rect = button.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(button);
        return rect.height >= 44 && rect.width >= 44 && range.getBoundingClientRect().height < 30;
      })));
      await shot(page, name === 'desktop' ? 'desktop-stop-confirm' : 'phone-stop-confirm-long');
      await page.locator('.composer textarea').fill(draft);
      await submit(page, page.locator(`form[action="/chat/proposal/${stop}/confirm"] button`));
      check(name+' stop preserves composer draft', await page.locator('.composer textarea').inputValue() === draft);
      check(name+' stop requested is still stopping', store.stopOf(run.id).settledAt === null && taskControlOf(store, taskRef, new Date()).kind === 'stopping');
      await detail.goto(fixture.url+'/t/'+task);
      check(name+' chat and task show stopping for the same run', await page.locator('[data-task-control="stopping"]').getAttribute('data-control-run') === String(run.id) && await detail.locator('[data-task-control="stopping"]').getAttribute('data-control-run') === String(run.id));
      if (name === 'desktop') {
        await page.evaluate(() => scrollTo(0, document.querySelector('#task-chat-live').getBoundingClientRect().top + scrollY - 115)); await shot(page, 'desktop-stopping');
        // Build #1620 feedback: the separate /t/:task page for the same run,
        // captured while it still reads Stopping and before any state change.
        await detail.locator('[data-task-control="stopping"]').scrollIntoViewIfNeeded();
        await shot(detail, 'desktop-task-detail-stopping');
      }
      const csrf = await page.locator('[name="csrf"]').first().inputValue();
      const replay = await page.request.post(fixture.url+`/chat/proposal/${stop}/confirm`, { form: { csrf }, maxRedirects: 0 });
      check(name+' repeated confirmation records one stop', replay.status() === 303 && store.stopsForTask(taskRef).length === 1);
      // Synthetic worker acknowledgement, explicitly not a live process or model proof.
      finalize(store, run.leaseId, { kind: 'interrupted', taskId: task, runId: run.id, stopRun: run.id, now: new Date() });
      await page.waitForSelector('[data-task-control="paused"]', { state: 'attached' });
      await detail.reload();
      check(name+' task-page acknowledgement reaches chat without clearing draft', await page.locator('.composer textarea').inputValue() === draft && await detail.locator('[data-task-control="paused"]').count() === 1);
      const resume = await send('Resume this task', [tool('get_task', { task }), tool('propose_task_action', { task, run: run.id, operation: 'resume' })]);
      await page.locator(`form[action="/chat/proposal/${resume}/confirm"]`).waitFor();
      await page.locator('.composer textarea').fill(draft);
      await submit(page, page.locator(`form[action="/chat/proposal/${resume}/confirm"] button`));
      check(name+' resume opens existing nonce and password form', await page.locator(`form[action="/t/${task}/resume"] [name="nonce"]`).count() === 1 && store.stopOf(run.id).resumedAt === null);
      await fits(page, name+' long resume terms');
      if (name === 'phone') await shot(page, 'phone-resume-password');
      await page.locator('.resume-form [name="token"]').fill('incorrect-fixture-password');
      await submit(page, page.locator('.resume-form button'));
      await fits(page, name+' password refusal');
      check(name+' wrong password refuses resume', store.stopOf(run.id).resumedAt === null && (await page.locator('body').innerText()).includes('password'));
      await goto('/chat?task='+task);
      check(name+' refusal retains chat draft', await page.locator('.composer textarea').inputValue() === draft);
      // A stale card is checked again at its current confirmation door.
      const stale = await send('Review resume again', [tool('get_task', { task }), tool('propose_task_action', { task, run: run.id, operation: 'resume' })]);
      await page.locator(`form[action="/chat/proposal/${stale}/confirm"]`).waitFor();
      store.raw().prepare("UPDATE task SET updated_at = ? WHERE id = ?").run(new Date(Date.now()+1000).toISOString(), task);
      await page.locator('.composer textarea').fill(draft);
      await submit(page, page.locator(`form[action="/chat/proposal/${stale}/confirm"] button`));
      await page.locator('.proposal-task_action.refused').waitFor();
      check(name+' stale card refuses without draft loss', store.getLeadProposal(stale).state === 'refused' && await page.locator('.composer textarea').inputValue() === draft);
      await page.locator('.proposal-task_action.refused').scrollIntoViewIfNeeded();
      await shot(page, name === 'phone' ? 'phone-refusal-draft' : 'desktop-refusal-draft');
      // Complete the same task-owned ceremony, entered from the focused chat.
      await page.locator('#task-control-details > summary').click();
      await submit(page, page.locator('.task-resume-form button'));
      await page.locator('.resume-form [name="token"]').fill(fixture.password);
      await submit(page, page.locator('.resume-form button'));
      check(name+' successful resume returns to draft in same chat', new URL(page.url()).searchParams.get('task') === task && await page.locator('.composer textarea').inputValue() === draft);
      check(name+' resume preserves saved work, scope and run history', readFileSync(join(run.worktree, 'draft.txt'), 'utf8') === 'Preserved fixture work\n' && JSON.stringify(store.getScope(task)) === JSON.stringify(approval) && store.runsFor(taskRef).length === 1 && store.stopOf(run.id).resumedAt !== null);
      await detail.reload();
      await fits(detail, name+' task detail after resume');
      check(name+' task and chat agree after resume', await page.locator('[data-task-status]').first().getAttribute('data-work-status') === await detail.locator('[data-task-status]').first().getAttribute('data-work-status'));
      // Baseline one-task result flow: open result, inspect diff, save exact feedback, request revision.
      const root = fixture.tasks.done, result = fixture.runId;
      await goto('/chat?task='+root+'&result='+result);
      await page.locator('[data-result-tab="changes"]').click();
      await fits(page, name+' result changes');
      check(name+' result keeps exact run', await page.locator(`[data-result-panel][data-result-run="${result}"]`).count() === 1);
      if (name === 'desktop') await page.locator('[data-review-diff]').scrollIntoViewIfNeeded();
      else {
        // Build #1620 feedback: one 390px viewport holding the selected
        // Changes tab, the file list and the readable start of the diff.
        await page.evaluate(() => scrollTo(0, document.querySelector('[data-result-tab="changes"]').getBoundingClientRect().top + scrollY - 70));
        check('phone result shows the selected Changes tab and the diff in one viewport', await page.evaluate(() => {
          const tab = document.querySelector('[data-result-tab="changes"]').getBoundingClientRect(), diff = document.querySelector('[data-review-diff]').getBoundingClientRect();
          return tab.top >= 0 && tab.bottom <= innerHeight && diff.top >= 0 && diff.top + 120 <= innerHeight;
        }));
      }
      await shot(page, name === 'desktop' ? 'desktop-result' : 'phone-result');
      const note = 'Keep the primary action on one line. On mobile, leave enough room above the composer to read the latest reply and reach its action. Shorten the confirmation without hiding what will stop. Keep my draft if the connection drops, and keep this revision in the original task history.';
      await page.locator('#comment-form textarea[name="note"]').fill(note);
      await submit(page, page.locator('#comment-form [data-save-feedback]'));
      check(name+' result feedback saved in shared history', store.liveDiffComments(result).some(n => n.note === note));
      await goto('/chat?task='+root);
      const saved = store.liveDiffComments(result).find(n => n.note === note);
      const revision = await send('Apply the saved feedback', [tool('get_result', { task: root, run: result }), tool('propose_review', { run: result, operation: 'revise', saved_notes: [saved.id] })]);
      await page.locator(`form[action="/chat/proposal/${revision}/confirm"]`).waitFor();
      check(name+' revision card shows exact submitted feedback', (await page.locator('.proposal-review.pending').innerText()).includes(note));
      await fits(page, name+' long revision feedback');
      await submit(page, page.locator(`form[action="/chat/proposal/${revision}/confirm"] button`));
      const family = store.taskFamilyOf(root, [fixture.repos.main], false);
      check(name+' revision preserves one task and result lineage', family.versions.length === 2 && new URL(page.url()).searchParams.get('task') === root && store.revisionLineageOf(family.current.id, new Date()).sourceRun === result);
      const second = await page.request.post(fixture.url+`/chat/proposal/${revision}/confirm`, { form: { csrf }, maxRedirects: 0 });
      check(name+' revision replay creates no duplicate', second.status() === 303 && store.taskFamilyOf(root, [fixture.repos.main], false).versions.length === 2);
      await fits(page, name+' revision created');
      // Build #1604 feedback (evidence 792): returning to the revision left
      // the newest message under the phone's fixed composer. The landing is
      // the receipt itself, with its plan link readable above the composer.
      const readable = async whole => page.evaluate(whole => {
        const latest = document.querySelector('#latest'), composer = document.querySelector('.composer'), link = latest?.querySelector('.proposal-review a');
        if (!latest || !composer || !link) return { ok: false };
        const covered = getComputedStyle(composer).position === 'fixed' ? composer.getBoundingClientRect().top : innerHeight;
        const l = latest.getBoundingClientRect(), a = link.getBoundingClientRect();
        return { ok: latest === document.querySelector('.thread > :last-child') && (!whole || l.top >= 0) && l.bottom <= covered && a.top >= 0 && a.bottom <= covered, latest: [Math.round(l.top), Math.round(l.bottom)], composer: Math.round(covered), link: link.textContent.trim() };
      }, whole);
      const landed = await readable(true);
      check(name+' revision receipt and its plan link are readable above the composer on arrival', landed.ok && landed.link.includes('review'));
      await shot(page, name === 'phone' ? 'phone-revision' : 'desktop-revision');
      if (name === 'phone') {
        // A software keyboard is simulated by shrinking the reported visual
        // viewport by 336px while the composer is focused; the page's own
        // viewport script then raises the composer. No physical keyboard,
        // Safari, or live model is claimed.
        await page.locator('.composer textarea').focus();
        await page.locator('.composer textarea').fill(draft);
        await page.evaluate(() => { Object.defineProperty(visualViewport, 'height', { configurable: true, get: () => innerHeight - 336 }); visualViewport.dispatchEvent(new Event('resize')); });
        await page.waitForFunction(() => document.documentElement.hasAttribute('data-mobile-keyboard'));
        const typing = await readable(false);
        check('phone newest message follows the raised composer while typing (simulated keyboard)', typing.ok && typing.composer < 600 && await page.locator('.composer textarea').inputValue() === draft);
        await shot(page, 'phone-revision-typing');
        await page.evaluate(() => { delete visualViewport.height; visualViewport.dispatchEvent(new Event('resize')); });
        await page.locator('.composer textarea').blur();
        await page.waitForFunction(() => !document.documentElement.hasAttribute('data-mobile-keyboard'));
      }
      check(name+' browser has no script errors', errors.length === 0);
      report.viewports.push({ name, width, height });
    } catch (error) {
      if (capture) await page.screenshot({ path: join(out, name+'-debug.png') });
      console.log(JSON.stringify(await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, elements: [...document.querySelectorAll('h1, .mate-terms, form[action="/chat/mate/mint"], form[action="/chat/mate/mint"] button')].map(e => ({ tag: e.tagName, text: e.textContent.slice(0, 70), rect: e.getBoundingClientRect().toJSON(), position: getComputedStyle(e).position })) }))));
      throw error;
    } finally { await context.close(); await fixture.stop(); }
  }
} finally { await browser.close(); }
if (capture) writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2)+'\n');
console.log(`PASS ${report.checks.length} checks; synthetic Chromium ${report.viewports.map(v => v.width+'px').join(' and ')} journeys; zero live model calls.`);
