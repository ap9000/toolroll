/** UI-polish viewport proof (2026-09-13). Drives the isolated fixture in
 * headless Chromium, captures exact-viewport screenshots, and records the
 * measurable facts the assessment cites: document overflow, composer /
 * tab-bar overlap, keyboard reach, reduced-motion computed styles, and the
 * served payload sizes of the same representative pages. The follow-up on
 * build 1540 adds a NEW empty conversation per desktop viewport (1440×900,
 * 1280×800) and the review annotation forms' advertised character limit.
 * The concise pass (2026-09-13) asserts the ready thread's one sentence
 * and three starters while every approval, revision, and draft check
 * below runs unchanged.
 *
 *   node scripts/ui-polish-proof.mjs [--out evidence/ui-polish-2026-09-13/after] [--strict]
 *
 * Playwright is NOT a dependency of this package: the script imports it
 * from `playwright` when installed, else from PLAYWRIGHT_MODULE, else from
 * the npx cache. With --strict any failed check exits 1. */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startFixture } from './ui-polish-fixture.mjs';

const args = process.argv.slice(2);
const flag = name => { const at = args.indexOf(name); return at === -1 ? null : args[at + 1] ?? null; };
const out = resolve(flag('--out') ?? 'evidence/ui-polish-2026-09-13/after');
const strict = args.includes('--strict');
mkdirSync(out, { recursive: true });

async function loadPlaywright() {
  try { return await import('playwright'); } catch { /* not installed here */ }
  const candidates = [process.env.PLAYWRIGHT_MODULE].filter(Boolean);
  const npx = join(homedir(), '.npm', '_npx');
  if (existsSync(npx)) for (const dir of readdirSync(npx)) candidates.push(join(npx, dir, 'node_modules', 'playwright', 'index.mjs'));
  for (const one of candidates) if (existsSync(one)) return import(pathToFileURL(one).href);
  throw new Error('playwright not found: install it, or set PLAYWRIGHT_MODULE to its index.mjs');
}

const VIEWPORTS = { desktop: { width: 1440, height: 900 }, laptop: { width: 1280, height: 800 }, phone: { width: 390, height: 844 }, narrow: { width: 320, height: 740 }, wide: { width: 430, height: 932 } };
const report = { generatedAt: new Date().toISOString(), out, checks: [], payloads: {}, screenshots: [] };
const check = (name, ok, detail) => { report.checks.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

const { chromium } = await loadPlaywright();
const fixture = await startFixture({ slowMs: 9000 });
const browser = await chromium.launch();

async function context(viewport, extra = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: viewport.width < 760, hasTouch: viewport.width < 760, ...extra });
  const page = await ctx.newPage();
  await page.goto(`${fixture.url}/login`);
  await page.fill('input[name="name"]', fixture.name);
  await page.fill('input[name="token"]', fixture.password);
  await submit(page, 'button[type="submit"]');
  return { ctx, page };
}
const shot = async (page, name, caption) => {
  const path = join(out, `${name}.png`);
  await page.evaluate(() => { document.documentElement.style.scrollBehavior = 'auto'; });
  await page.screenshot({ path, fullPage: false });
  report.screenshots.push({ path, caption });
  return path;
};
/** Send the composer's message. Package 2 (2026-09-13): the enhanced
 * send stays on the same document and the reply arrives through the live
 * refresh, so this clicks and waits for the thread to move — a reply, a
 * card, or the reply-in-progress card — instead of a new document. */
async function sendMessage(page, text) {
  await page.fill('.composer textarea', text);
  const before = await page.evaluate(() => document.querySelectorAll('.msg').length);
  await page.click('.composer button[type="submit"]');
  await page.waitForFunction(n => document.querySelectorAll('.msg').length > n || document.querySelector('.chat-thinking') !== null, before, { timeout: 15000 });
}
/** Click a submit and wait for a NEW document — robust to the chat page's
 * own reload racing the POST redirect (a bare waitForNavigation aborts). */
async function submit(page, selector) {
  await page.evaluate(() => { window.__staleDocument = true; });
  await page.click(selector);
  await page.waitForFunction(() => window.__staleDocument === undefined, null, { timeout: 15000 });
  await page.waitForLoadState('load');
  await page.waitForTimeout(250);
}
const rect = (page, selector) => page.evaluate(sel => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }; }, selector);
const noOverflow = page => page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, ok: document.documentElement.scrollWidth <= document.documentElement.clientWidth }));
const scrollTo = (page, selector, offset = 72) => page.evaluate(([sel, off]) => { const el = document.querySelector(sel); if (!el) return false; document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - off, behavior: 'instant' }); return true; }, [selector, offset]);
async function payload(page, path, label) {
  const response = await page.goto(`${fixture.url}${path}`);
  const html = await response.text();
  const style = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].reduce((sum, m) => sum + Buffer.byteLength(m[1]), 0);
  const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].reduce((sum, m) => sum + Buffer.byteLength(m[1]), 0);
  report.payloads[label] = { path, htmlBytes: Buffer.byteLength(html), inlineCssBytes: style, inlineJsBytes: script };
  return html;
}
const waitForReply = async page => {
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(500);
    try {
      await page.goto(`${fixture.url}/chat`);
      if (!(await page.$('.chat-thinking'))) return;
    } catch {
      // The page's own status poll reloaded it mid-query; look again.
    }
  }
  throw new Error('the scripted reply never landed');
};

try {
  // ---- chat: start state, ready state, action card, pending -----------
  const phone = await context(VIEWPORTS.phone);
  let page = phone.page;
  await payload(page, '/chat', 'chat-start');
  await shot(page, 'chat-start-390', 'Chat before a conversation exists: the start action in the first 390×844 viewport (fixture)');
  const startAction = await rect(page, 'form[action="/chat/mate/mint"] button[type="submit"]');
  check('c1 chat start action inside the first 390px viewport', startAction !== null && startAction.bottom <= 844 && startAction.top >= 0, JSON.stringify(startAction));
  const drawerOpenAtStart = await page.evaluate(() => { const w = document.querySelector('.chat-workspace'); return w ? w.classList.contains('projects-open') : null; });
  check('c1 project context is collapsed by default on the phone', drawerOpenAtStart === false, `projects-open=${drawerOpenAtStart}`);
  const overviewOpen = await page.evaluate(() => { const d = document.querySelector('details.chat-fleet-context'); return d ? d.open : null; });
  check('c1 overview disclosure is compact (closed) on the phone before a conversation', overviewOpen === false || overviewOpen === null, `open=${overviewOpen}`);
  check('c1 start page has no horizontal overflow at 390', (await noOverflow(page)).ok, JSON.stringify(await noOverflow(page)));

  await page.fill('form[action="/chat/mate/mint"] input[name="token"]', fixture.password);
  await submit(page, 'form[action="/chat/mate/mint"] button[type="submit"]');
  await payload(page, '/chat', 'chat-ready');
  await shot(page, 'chat-ready-390', 'Chat ready: the composer and send control in the first 390×844 viewport (fixture)');
  const send = await rect(page, '.composer button[type="submit"]');
  check('c1 composer send control inside the first 390px viewport', send !== null && send.bottom <= 844, JSON.stringify(send));
  const fontSize = await page.evaluate(() => getComputedStyle(document.querySelector('.composer textarea')).fontSize);
  check('c4 composer input is at least 16px', parseFloat(fontSize) >= 16, fontSize);
  const guidance = await page.evaluate(() => document.getElementById('chat-connection')?.textContent ?? '');
  check('c1 plain-language session guidance is present', /confirm|draft|connected/i.test(guidance), guidance);
  // Concise pass (2026-09-13): the ready thread carries one contextual
  // sentence and three starters — no intro over the heading, no second
  // hint under the composer; the composer and its send control stay.
  const concise = await page.evaluate(() => ({
    headMeta: document.querySelector('.chat-head > div > p.meta') !== null,
    emptyLines: document.querySelectorAll('.chat-empty p').length,
    starters: [...document.querySelectorAll('.chat-prompts form button')].map(b => b.textContent),
    secondHint: document.body.textContent.includes('One message is enough'),
    composer: document.querySelector('.composer textarea') !== null && document.querySelector('.composer button[type="submit"]') !== null,
  }));
  check('c1 the ready thread keeps one contextual sentence and three starters, with no heading intro or second composer hint', !concise.headMeta && concise.emptyLines === 1 && concise.starters.length === 3 && !concise.secondHint && concise.composer, JSON.stringify(concise));

  // A proposal card (hold) — the action-card state, then confirm it.
  await sendMessage(page, 'Please pause the ledger export until I have read it.');
  await waitForReply(page);
  await scrollTo(page, '.proposal-hold');
  await shot(page, 'chat-action-card-390', 'A hold proposal card in chat after a scripted reply (fixture)');
  check('c2 hold proposal card rendered', (await page.$('.proposal-hold.pending')) !== null);
  await submit(page, '.proposal-hold form[action$="/confirm"] button[type="submit"]');
  check('c2 hold proposal confirmed through the card', (await page.$('.proposal-hold.confirmed')) !== null);

  // Reply in progress: the scripted runner delays on "slowly".
  await page.goto(`${fixture.url}/chat`);
  await sendMessage(page, 'Brief me slowly.');
  await page.waitForSelector('.chat-thinking', { timeout: 15000 });
  await scrollTo(page, '.chat-thinking');
  await shot(page, 'chat-pending-390', 'Reply in progress with the draft composer still available (fixture)');
  check('c1 pending state keeps the composer visible and disabled send', (await page.$('.composer button[disabled]')) !== null);
  await waitForReply(page);

  // Ordinary revision path: a scope-revision card from chat, confirmed.
  await sendMessage(page, 'Propose a tighter scope for the ledger export.');
  await waitForReply(page);
  await scrollTo(page, '.proposal-scope');
  await shot(page, 'chat-scope-revision-390', 'Ordinary revision: a scope-rewrite proposal card in chat (fixture)');
  check('c3 ordinary revision card rendered', (await page.$('.proposal-scope.pending')) !== null);

  // Mobile navigation open: the project pill switcher.
  await page.goto(`${fixture.url}/chat`);
  await page.click('.mobile-top .project-pill summary');
  await page.waitForTimeout(400); // past the 160 ms entrance
  await shot(page, 'nav-open-390', 'Mobile navigation: the project switcher open under the header (fixture)');
  check('c4 mobile switcher open has no horizontal overflow', (await noOverflow(page)).ok);
  const menu = await rect(page, '.mobile-top .switcher-menu');
  const header = await rect(page, '.mobile-top');
  check('c4 the open switcher menu sits inside the viewport, below the header', menu !== null && header !== null && menu.top >= header.bottom - 8 && menu.bottom <= 844 && menu.left >= 0 && menu.right <= 390, JSON.stringify({ menu, header }));
  await page.keyboard.press('Escape');

  // ---- task approval: long scope --------------------------------------
  await payload(page, `/t/${fixture.tasks.long}`, 'task-approval');
  await shot(page, 'task-approval-390', 'Long task scope waiting for approval at 390×844: the next step leads (fixture)');
  const approvalHtml = await page.content();
  check('c2 exact goal text is present in full on the approval page', approvalHtml.includes('never buffers more than one thousand rows in memory') && approvalHtml.includes('downstream spreadsheets keep working'));
  // The plan sheet (docs/plans/task-page-steps.md) says each requirement in words, never its internal id.
  check('c2 every acceptance criterion is on the approval page, in words', fixture.store.getScope(fixture.tasks.long).acceptance.every(one => approvalHtml.includes(one.statement.replace(/&/g, '&amp;').replace(/</g, '&lt;'))));
  check('c2 Ask and Overview are both retained', (await page.$$('.task-view-switch a')).length === 2);
  const jump = await page.$('a[href="#approval-terms"], .approval-orient a[href^="#"]');
  check('c2 a clear Review scope jump exists', jump !== null);
  const nextStep = await rect(page, '.approval-orient, .approve-form .ceremony-head');
  check('c2 the next step is inside the first 390px viewport', nextStep !== null && nextStep.top < 844, JSON.stringify(nextStep));
  check('c2 approve button and password remain on the page', (await page.$('.approve-form input[name="token"]')) !== null && (await page.$('.approve-form button[type="submit"]')) !== null);
  check('c4 approval page has no horizontal overflow at 390', (await noOverflow(page)).ok);
  await page.goto(`${fixture.url}/chat?task=${fixture.tasks.long}`);
  await shot(page, 'task-ask-390', 'The same task in Ask mode with the approval disclosure (fixture)');
  check('c2 Ask mode carries the approval disclosure', (await page.$('#task-chat-action')) !== null);

  // ---- result: receipt, annotated diff revision -------------------------
  await payload(page, `/t/${fixture.tasks.done}`, 'task-result');
  await shot(page, 'result-390', 'A finished task: outcome, changed files and proof lead (fixture)');
  // Workspace package 3: the receipt's proof facts read "N/N acceptance
  // criteria passed" and "validated visual proof"; the evidence itself
  // opens through Open result.
  check('c3 result receipt renders outcome and proof', (await page.$('.completion-receipt')) !== null && /acceptance criteria passed|validated|verified|evidence/i.test(await page.evaluate(() => document.querySelector('.completion-receipt')?.textContent ?? '')));
  await payload(page, `/r/${fixture.runId}`, 'run-page');
  // Workspace package 3: the sealed diff lives under the result panel's
  // Changes view (a real tab link the server honours); open it first.
  await page.click('[data-result-tab="changes"]');
  await page.click('button[data-diff-mode="annotate"]');
  await page.click('button.diff-annotate.pick-line >> nth=0');
  // Follow-up on build 1540: the form advertises the server's own 500-character
  // limit, the helper says so, the counter follows typing, and the browser
  // stops a 501st character before any submission is discarded.
  const noteLimit = await page.evaluate(() => { const box = document.querySelector('#comment-form textarea[name="note"]'); const helper = document.getElementById(box?.getAttribute('aria-describedby') ?? ''); return { maxlength: box?.getAttribute('maxlength'), helper: helper?.textContent ?? null }; });
  check('followup c2 run-page annotation form advertises maxlength 500 with helper text', noteLimit.maxlength === '500' && noteLimit.helper === 'up to 500 characters', JSON.stringify(noteLimit));
  await page.fill('#comment-form textarea[name="note"]', 'x'.repeat(600));
  const overfull = await page.evaluate(() => ({ length: document.querySelector('#comment-form textarea[name="note"]').value.length, helper: document.getElementById('comment-note-limit')?.textContent ?? null }));
  check('followup c2 run-page annotation form caps typing at 500 and the counter says so', overfull.length === 500 && overfull.helper === '500 of 500 characters', JSON.stringify(overfull));
  await page.fill('#comment-form textarea[name="note"]', 'Name the rounding helper and reuse it in settleAll.');
  await scrollTo(page, '[data-review-diff]');
  await shot(page, 'result-annotate-390', 'Annotate mode on the sealed diff with a line picked into the comment form (fixture)');
  await submit(page, '#comment-form button[type="submit"]');
  check('c3 annotation recorded on the sealed diff', (await page.$('.diff-comment')) !== null);
  await submit(page, 'form.revision-from-comments button[type="submit"]');
  const revisionHtml = await page.content();
  check('c3 revision task created from annotations and its brief restates the comment', revisionHtml.includes('Name the rounding helper and reuse it in settleAll.') && (await page.$('.revision-card')) !== null);
  await shot(page, 'revision-task-390', 'The revision task created from the annotation, its brief restated beside the approval (fixture)');
  check('c4 revision page has no horizontal overflow at 390', (await noOverflow(page)).ok);

  // ---- keyboard: composer reach, drawer escape/focus return --------------
  await page.goto(`${fixture.url}/chat`);
  let reached = false;
  for (let i = 0; i < 80 && !reached; i++) {
    await page.keyboard.press('Tab');
    reached = await page.evaluate(() => document.activeElement?.matches('.composer button[type="submit"]') === true);
  }
  check('c4 send control reachable by keyboard within 80 tabs', reached);
  await page.focus('.chat-project-toggle');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
  const opened = await page.evaluate(() => document.querySelector('.chat-workspace')?.classList.contains('projects-open'));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  const closedAndReturned = await page.evaluate(() => !document.querySelector('.chat-workspace')?.classList.contains('projects-open') && document.activeElement?.matches('.chat-project-toggle') === true);
  check('c4 project drawer opens by keyboard, closes on Escape, focus returns to its toggle', opened === true && closedAndReturned, `opened=${opened} closedAndReturned=${closedAndReturned}`);
  await phone.ctx.close();

  // ---- overflow and overlap at 320 / 390 / 430 ---------------------------
  for (const [name, viewport] of Object.entries({ narrow: VIEWPORTS.narrow, phone: VIEWPORTS.phone, wide: VIEWPORTS.wide })) {
    const { ctx, page: p } = await context(viewport);
    for (const path of ['/chat', `/t/${fixture.tasks.long}`, `/t/${fixture.tasks.done}`, `/r/${fixture.runId}`, '/menu']) {
      await p.goto(`${fixture.url}${path}`);
      const flow = await noOverflow(p);
      check(`c4 no document horizontal overflow at ${viewport.width}px on ${path}`, flow.ok, JSON.stringify(flow));
    }
    await p.goto(`${fixture.url}/chat`);
    await scrollTo(p, '.composer', 400);
    const composer = await rect(p, '.composer button[type="submit"]');
    const tabbar = await rect(p, '.tabbar');
    check(`c4 composer does not sit under the bottom navigation at ${viewport.width}px`, composer !== null && tabbar !== null && composer.bottom <= tabbar.top, `send.bottom=${composer?.bottom} tabbar.top=${tabbar?.top}`);
    await p.goto(`${fixture.url}/t/${fixture.tasks.long}`);
    await p.evaluate(() => { document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }); });
    await scrollTo(p, '.approval-confirm', 300);
    const approve = await rect(p, '.approve-form .sticky-actions button');
    const bar = await rect(p, '.tabbar');
    check(`c4 approve action clears the bottom navigation at ${viewport.width}px`, approve !== null && bar !== null && approve.bottom <= bar.top + 0.5, `approve.bottom=${approve?.bottom} tabbar.top=${bar?.top}`);
    if (name === 'narrow') { await p.goto(`${fixture.url}/chat`); await shot(p, 'chat-ready-320', 'Chat ready at 320×740 (fixture)'); await p.goto(`${fixture.url}/t/${fixture.tasks.long}`); await shot(p, 'task-approval-320', 'Long scope approval at 320×740 (fixture)'); }
    if (name === 'wide') { await p.goto(`${fixture.url}/chat`); await shot(p, 'chat-ready-430', 'Chat ready at 430×932 (fixture)'); }
    await ctx.close();
  }

  // ---- desktop ----------------------------------------------------------
  const desktop = await context(VIEWPORTS.desktop);
  page = desktop.page;
  await page.goto(`${fixture.url}/chat`);
  await shot(page, 'chat-ready-desktop', 'Chat at 1440×900: one conversation column, projects behind the toggle (fixture)');
  check('c4 desktop chat has no horizontal overflow', (await noOverflow(page)).ok);
  await page.goto(`${fixture.url}/t/${fixture.tasks.long}`);
  await shot(page, 'task-approval-desktop', 'Long scope approval at 1440×900 (fixture)');
  await page.goto(`${fixture.url}/t/${fixture.tasks.done}`);
  await shot(page, 'result-desktop', 'Finished task at 1440×900 (fixture)');
  await page.goto(`${fixture.url}/review?task=${fixture.tasks.done}`);
  await shot(page, 'review-cockpit-desktop', 'Review cockpit for the finished task at 1440×900 (fixture)');
  const cockpitLimit = await page.evaluate(() => { const box = document.querySelector('#comment-form textarea[name="note"]'); const helper = document.getElementById(box?.getAttribute('aria-describedby') ?? ''); return { maxlength: box?.getAttribute('maxlength'), helper: helper?.textContent ?? null }; });
  check('followup c2 review-cockpit annotation form advertises maxlength 500 with helper text', cockpitLimit.maxlength === '500' && cockpitLimit.helper === 'up to 500 characters', JSON.stringify(cockpitLimit));
  await page.fill('#comment-form textarea[name="note"]', 'y'.repeat(12));
  check('followup c2 review-cockpit counter follows typing', (await page.evaluate(() => document.getElementById('comment-note-limit')?.textContent)) === '12 of 500 characters');
  await desktop.ctx.close();

  // Confirm the ordinary scope revision LAST (it rewrites the long scope
  // every capture above showed), then verify the task page carries it.
  const late = await context(VIEWPORTS.phone);
  await late.page.goto(`${fixture.url}/chat`);
  await submit(late.page, '.proposal-scope form[action$="/confirm"] button[type="submit"]');
  check('c3 ordinary scope revision confirmed through its card', (await late.page.$('.proposal-scope.confirmed')) !== null);
  await late.page.goto(`${fixture.url}/t/${fixture.tasks.long}`);
  check('c3 the rewritten scope waits for approval on the task', (await late.page.content()).includes('streaming RFC 4180 writer') && (await late.page.$('.approve-form')) !== null);
  await shot(late.page, 'task-rescoped-390', 'The task after the ordinary scope revision: the rewritten terms wait for a fresh approval (fixture)');
  await late.ctx.close();

  // ---- reduced motion -----------------------------------------------------
  const reduced = await context(VIEWPORTS.phone, { reducedMotion: 'reduce' });
  await reduced.page.goto(`${fixture.url}/chat`);
  await sendMessage(reduced.page, 'Brief me slowly.');
  await reduced.page.waitForSelector('.chat-thinking', { timeout: 15000 });
  const motion = await reduced.page.evaluate(() => {
    const read = (sel, pseudo) => { const el = document.querySelector(sel); return el ? getComputedStyle(el, pseudo) : null; };
    const orb = read('.thinking-orb', '::after');
    const button = read('.composer button[type="submit"]');
    const tab = read('.tabbar a');
    return { orbAnimation: orb?.animationName ?? 'missing', buttonTransition: button?.transitionDuration ?? 'missing', tabTransition: tab?.transitionDuration ?? 'missing' };
  });
  check('c5 reduced motion removes the thinking pulse and control transitions', motion.orbAnimation === 'none' && /^(0s(, 0s)*)$/.test(motion.buttonTransition) && /^(0s(, 0s)*)$/.test(motion.tabTransition), JSON.stringify(motion));
  await waitForReply(reduced.page);
  await reduced.ctx.close();

  // ---- fresh EMPTY conversation per desktop viewport (follow-up c1) ------
  // Each size ends the conversation the phone steps built and mints a NEW
  // one, so the measured page is the first-use state, not phone history.
  for (const [name, viewport] of Object.entries({ '1440x900': VIEWPORTS.desktop, '1280x800': VIEWPORTS.laptop })) {
    const fresh = await context(viewport);
    const p = fresh.page;
    await p.goto(`${fixture.url}/chat`);
    if (await p.$('form[action="/chat/mate/end"]')) {
      await p.evaluate(() => { const details = document.querySelector('.chat-session-details'); if (details) details.open = true; });
      await submit(p, 'form[action="/chat/mate/end"] button[type="submit"]');
    }
    check(`followup c1 ${name} starts from no conversation`, (await p.$('form[action="/chat/mate/mint"]')) !== null && (await p.$('.composer')) === null);
    await p.fill('form[action="/chat/mate/mint"] input[name="token"]', fixture.password);
    await submit(p, 'form[action="/chat/mate/mint"] button[type="submit"]');
    const state = await p.evaluate(() => ({ messages: document.querySelectorAll('.msg').length, empty: document.querySelector('.chat-empty') !== null, scrollY: window.scrollY, overviewOpen: document.querySelector('.chat-fleet-context')?.open ?? null, summary: document.querySelector('.chat-fleet-context > summary')?.textContent ?? null }));
    check(`followup c1 ${name} conversation is new and empty`, state.messages === 0 && state.empty && state.scrollY === 0, JSON.stringify(state));
    await shot(p, `chat-fresh-${name}`, `A NEW empty conversation at ${viewport.width}×${viewport.height}: the folded overview summary, the whole composer and send in the first viewport (fixture)`);
    const box = await rect(p, '.composer textarea');
    const sendButton = await rect(p, '.composer button[type="submit"]');
    const fits = one => one !== null && one.top >= 0 && one.bottom <= viewport.height && one.left >= 0 && one.right <= viewport.width;
    check(`followup c1 ${name} the ENTIRE textarea is inside the first viewport`, fits(box), JSON.stringify(box));
    check(`followup c1 ${name} the ENTIRE send button is inside the first viewport`, fits(sendButton), JSON.stringify(sendButton));
    check(`followup c1 ${name} no horizontal overflow`, (await noOverflow(p)).ok);
    const summaryRect = await rect(p, '.chat-fleet-context > summary');
    check(`followup c1 ${name} overview is folded behind a visible summary with its counts`, state.overviewOpen === false && summaryRect !== null && summaryRect.height > 0 && /needs? you|nothing waiting/.test(state.summary ?? '') && /building/.test(state.summary ?? ''), JSON.stringify({ open: state.overviewOpen, summary: state.summary, summaryRect }));
    // Accessible: the summary takes focus and Enter opens the full overview.
    await p.focus('.chat-fleet-context > summary');
    await p.keyboard.press('Enter');
    await p.waitForTimeout(100);
    const opened = await p.evaluate(() => ({ open: document.querySelector('.chat-fleet-context')?.open ?? null, overview: document.querySelector('.chat-overview')?.getBoundingClientRect().height ?? 0 }));
    check(`followup c1 ${name} overview opens by keyboard from its summary`, opened.open === true && opened.overview > 0, JSON.stringify(opened));
    await p.keyboard.press('Enter');
    await p.waitForTimeout(100);
    check(`followup c1 ${name} overview closes again by keyboard`, (await p.evaluate(() => document.querySelector('.chat-fleet-context')?.open)) === false);
    await fresh.ctx.close();
  }

  // Motion properties: no transition or animation may drive layout or blur.
  const html = await (await (await browser.newContext()).newPage()).goto(`${fixture.url}/login`).then(r => r.text());
  const css = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n');
  const transitions = [...css.matchAll(/transition:\s*([^;}]+)/g)].map(m => m[1]);
  const badTransition = transitions.filter(one => /\b(width|height|grid-template-columns|filter|backdrop-filter|margin|padding|top|left|right|bottom)\b/.test(one) || /^all\b/.test(one.trim()));
  check('c5 no transition animates a layout dimension or blur', badTransition.length === 0, badTransition.join(' | ') || 'none');
  const keyframes = [...css.matchAll(/@keyframes\s+([\w-]+)\s*\{([^}]*\}[^}]*)\}/g)].map(m => ({ name: m[1], body: m[2] }));
  const badKeyframes = keyframes.filter(one => /\b(width|height|filter|backdrop-filter|margin|padding|top|left|right|bottom)\s*:/.test(one.body));
  check('c5 no keyframe animates a layout dimension or blur', badKeyframes.length === 0, badKeyframes.map(one => one.name).join(', ') || 'none');
  const durations = [...css.matchAll(/transition:\s*[^;}]*?(\d*\.?\d+)(m?s)/g)].map(m => (m[2] === 'ms' ? Number(m[1]) : Number(m[1]) * 1000));
  check('c5 every transition is 220 ms or shorter', durations.every(ms => ms <= 220), `max ${Math.max(...durations)} ms across ${durations.length} declarations`);
} finally {
  await browser.close();
  await fixture.stop();
}

writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
const failed = report.checks.filter(one => !one.ok);
console.log(`\n${report.checks.length - failed.length}/${report.checks.length} checks passed · ${report.screenshots.length} screenshots · payloads: ${Object.entries(report.payloads).map(([k, v]) => `${k}=${v.htmlBytes}B`).join(' ')}`);
if (strict && failed.length > 0) process.exit(1);
