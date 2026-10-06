/** Synthetic team-chat journey against the compiled candidate, in headless Chromium.
 * Uses the existing isolated fixture; no installed runtime, model, or Git history writes.
 * Run after the focused tests build dist/: node scripts/team-chat-proposals-proof.mjs */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { startFixture, LONG_FEEDBACK_PATH } from './ui-polish-fixture.mjs';
import { FLOW_TEMPLATES } from '../dist/flows.js';

const out = resolve('evidence/team-chat-proposals');
mkdirSync(out, { recursive: true });
async function playwright() {
  try { return await import('playwright'); } catch { /* reuse a locally installed copy */ }
  const cache = join(homedir(), '.npm', '_npx');
  const candidates = [process.env.PLAYWRIGHT_MODULE, ...(existsSync(cache) ? readdirSync(cache).map(d => join(cache, d, 'node_modules/playwright/index.mjs')) : [])].filter(Boolean);
  for (const file of candidates) if (existsSync(file)) return import(pathToFileURL(file).href);
  throw Error('Set PLAYWRIGHT_MODULE to an installed Playwright index.mjs');
}
const report = { synthetic: true, headless: true, checks: [], screenshots: [], source: {} };
for (const file of ['src/serve.ts', 'src/team-contract.ts', 'src/browser/team-chat.tsx', 'src/browser/chat-cards.tsx', 'src/browser/workspace.css', 'dist/browser/workspace.js', 'dist/browser/workspace.css']) {
  report.source[file] = createHash('sha256').update(readFileSync(file)).digest('hex');
}
const check = (label, condition) => { assert(condition, label); report.checks.push(label); console.log('PASS ' + label); };
async function stable(page) {
  await page.waitForFunction(() => { try { return !document.documentElement.matches(':active-view-transition'); } catch { return true; } });
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
}
async function fits(page, label) {
  await stable(page);
  const layout = await page.evaluate(() => ({
    fits: document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.so-team-content, .so-card-body')].every(el => el.scrollWidth <= el.clientWidth + 1),
    buttons: [...document.querySelectorAll('[data-view="chat-card"] button, [data-view="chat-card"] [data-slot="button"]')].filter(el => el.checkVisibility()).map(el => {
      const rect = el.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(el);
      return { height: rect.height, textHeight: range.getBoundingClientRect().height, fits: el.scrollWidth <= rect.width + 1 };
    }),
  }));
  check(label + ' fits without clipped card content or wrapped controls', layout.fits && layout.buttons.every(button => button.fits && button.textHeight < 30 && (page.viewportSize().width > 760 || button.height >= 44)));
}
async function shot(page, name) {
  await fits(page, name); await page.screenshot({ path: join(out, name + '.png') });
  report.screenshots.push('evidence/team-chat-proposals/' + name + '.png');
}
const { chromium } = await playwright();
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  for (const [name, width, height] of [['desktop', 1440, 1000], ['phone', 390, 844]]) {
    const answers = [];
    const tool = (name, args) => ({ text: '', calls: [{ id: name, name, args }], tokensIn: 1, tokensOut: 1, reportedCostMicrousd: null });
    const f = await startFixture({ git: false, directory: out, sameTaskRevisions: true, runner: async () => {
      const answer = answers.shift(); assert(answer, 'Unexpected scripted provider request'); return { ok: true, answer };
    } });
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce', isMobile: name === 'phone', hasTouch: name === 'phone' });
    const page = await context.newPage(), detail = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto(f.url + '/login');
      await page.locator('[name=name]').fill(f.name); await page.locator('[name=token]').fill(f.password);
      await page.getByRole('button', { name: 'sign in', exact: true }).click();
      await page.waitForURL(url => url.pathname !== '/login');
      const csrf = await page.locator('input[name="csrf"]').first().inputValue();
      const team = async (operation, args) => {
        const response = await page.request.post(f.url + '/api/team', { headers: { 'x-csrf-token': csrf }, data: { operation, args } });
        const body = await response.json(); assert(body.ok, body.message); return body;
      };
      const lead = await team('create-lead', { name: 'Portfolio lead', projects: [f.repos.main] });
      const created = await team('create-conversation', { leadId: lead.result.leadId, title: 'Portfolio launch · synthetic example', visibility: 'team', projects: [f.repos.main] });
      const room = created.snapshot.selected, roomUrl = f.url + '/chat?conversation=' + room.id;
      await page.goto(roomUrl);
      await page.getByRole('button', { name: 'Enable chat', exact: true }).click();
      await page.getByRole('button', { name: 'Enable chat', exact: true }).waitFor({ state: 'hidden' });
      check(name + ' empty room has one next step and no proposal list', await page.getByText('What would you like to work on?', { exact: true }).isVisible() && await page.locator('.so-team-proposals').count() === 0);
      const send = async (message, steps, reply) => {
        const previous = f.store.listMateProposals(room.threadId).map(row => row.id);
        answers.push(...steps, { text: reply, calls: [], tokensIn: 1, tokensOut: 1, reportedCostMicrousd: null });
        await page.locator('#team-message').fill(message);
        await page.getByRole('button', { name: 'Send', exact: true }).click();
        await page.getByText(reply, { exact: true }).waitFor();
        const proposals = f.store.listMateProposals(room.threadId).filter(row => !previous.includes(row.id));
        assert(proposals.length, 'Scripted reply produced no proposals');
        for (const proposal of proposals) {
          await page.locator(`[data-action-card="${proposal.id}"]`).waitFor();
          check(name + ' proposal ' + proposal.id + ' is attached to its saved assistant turn', await page.locator(`[data-action-card="${proposal.id}"]`).evaluate(el => el.closest('.so-team-message--assistant')?.querySelector('.so-team-message-text')?.textContent === reply));
        }
        return proposals;
      };
      const [hold] = await send('Pause the ledger export until the audit is finished.', [tool('propose_hold', { task: f.tasks.long, reason: 'Wait for the audit before starting the export changes.' })], 'The ledger export can wait for the audit.');
      const holdCard = page.locator(`[data-action-card="${hold.id}"]`);
      await holdCard.scrollIntoViewIfNeeded();
      await shot(page, name + '-inline');
      // Simulate a lost HTTP response: keep the recorded pending state and report the failure.
      await page.route('**/chat/proposal/' + hold.id + '/confirm', route => route.abort('failed'));
      await holdCard.locator('[data-card-confirm]').click();
      await page.getByText("That didn't go through. Check your connection and try again.", { exact: true }).waitFor();
      check(name + ' failed confirmation never claims Done', await holdCard.getAttribute('data-card-state') === 'pending' && f.store.getMateProposal(hold.id).state === 'pending');
      await shot(page, name + '-failure');
      await page.unroute('**/chat/proposal/' + hold.id + '/confirm');
      const draft = 'After the audit, keep the existing CSV column names.';
      await page.locator('#team-message').fill(draft);
      await holdCard.locator('[data-card-confirm]').focus();
      await page.keyboard.press('Enter');
      await page.locator(`[data-action-card="${hold.id}"][data-card-state="confirmed"]`).waitFor();
      check(name + ' keyboard confirmation preserves the unsent draft', await page.locator('#team-message').inputValue() === draft);
      check(name + ' hold is saved once in task state', f.store.activeHolds(f.store.lookupRef(f.tasks.long).id, new Date()).filter(row => row.ownerKind === 'operator').length === 1);
      await detail.goto(f.url + '/t/' + f.tasks.long);
      check(name + ' task page sees the hold from chat', (await detail.locator('body').innerText()).includes('Wait for the audit'));

      const [flow] = await send('Draft a review flow for the portfolio team.', [tool('propose_flow', { operation: 'create', repo: 'r1', template: FLOW_TEMPLATES[0].id, name: 'Portfolio review' })], 'Here is a review flow for the portfolio team.');
      const flowCard = page.locator(`[data-action-card="${flow.id}"]`);
      check(name + ' flow proposal reuses the same card and server terms', await flowCard.getAttribute('data-card-kind') === 'action');
      await flowCard.locator('[data-card-dismiss]').click();
      await page.locator(`[data-action-card="${flow.id}"][data-card-state="dismissed"]`).waitFor();

      // A saved result: inspect changes, save exact feedback, then revise through the team card.
      await detail.goto(f.url + '/chat?task=' + f.tasks.done + '&result=' + f.runId + '&conversation=' + room.id);
      await detail.locator('[data-result-tab="changes"]').click();
      await detail.locator('[data-review-diff]').waitFor();
      check(name + ' result opens the exact saved run', await detail.locator(`[data-result-panel][data-result-run="${f.runId}"]`).count() === 1);
      const feedback = 'Keep the rounding fix, and add coverage for half-cent values and negative adjustments. Preserve the existing export column names so saved spreadsheets still open correctly.';
      await detail.locator('#comment-form').evaluate(el => { for (let parent = el.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true; });
      await detail.locator('#comment-form textarea[name="note"]').fill(feedback);
      await detail.locator('#comment-form [data-save-feedback]').click();
      await detail.waitForFunction(() => !document.querySelector('#comment-form textarea[name="note"]')?.value);
      const saved = f.store.liveDiffComments(f.runId).find(note => note.note === feedback); assert(saved, 'Feedback was not saved');
      const [revision] = await send('Apply the feedback I saved on the payout result.', [tool('get_result', { task: f.tasks.done, run: f.runId }), tool('propose_review', { run: f.runId, operation: 'revise', saved_notes: [saved.id], note: 'Keep the regression fixture alongside ' + LONG_FEEDBACK_PATH + '.' })], 'The revision will apply your saved feedback to the payout task.');
      const revisionCard = page.locator(`[data-action-card="${revision.id}"]`);
      check(name + ' revision card shows the exact feedback from the result screen', (await revisionCard.innerText()).includes(feedback));
      await revisionCard.scrollIntoViewIfNeeded(); await shot(page, name + '-long-feedback');
      await revisionCard.locator('[data-card-confirm]').click();
      await page.locator(`[data-action-card="${revision.id}"][data-card-state="confirmed"]`).waitFor();
      const family = f.store.taskFamilyOf(f.tasks.done, [f.repos.main], false);
      check(name + ' chat revision preserves task and result identity', family.versions.length === 2 && f.store.revisionLineageOf(family.current.id, new Date()).sourceRun === f.runId);
      await page.request.post(f.url + '/chat/proposal/' + revision.id + '/confirm', { headers: { accept: 'application/json' }, form: { csrf } });
      check(name + ' replay creates no second revision', f.store.taskFamilyOf(f.tasks.done, [f.repos.main], false).versions.length === 2);

      // Historical records with a missing reply remain reachable at the end after reload.
      f.store.handle.prepare("DELETE FROM mate_message WHERE thread=? AND turn=? AND role='assistant'").run(room.threadId, flow.turn);
      await page.reload();
      const unmatched = page.locator(`[data-action-card="${flow.id}"]`); await unmatched.waitFor();
      check(name + ' old unmatched proposal appears once at the end', await unmatched.count() === 1 && await unmatched.evaluate(el => !el.closest('[data-team-message]') && !!(document.querySelector('.so-team-messages').compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)));
      await fits(page, name + ' saved history');
      check(name + ' no browser exceptions', errors.length === 0);
    } finally { await context.close(); await f.stop(); }
  }
} catch (error) {
  report.failure = String(error); throw error;
} finally { await browser?.close(); writeFileSync(join(out, 'journey.json'), JSON.stringify(report, null, 2) + '\n'); }
