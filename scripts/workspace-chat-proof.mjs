/** Workspace package 2 browser proof (2026-09-13): continuous chat,
 * planning, and approval — driven against the isolated synthetic fixture
 * (`scripts/ui-polish-fixture.mjs`: one in-memory database, a throwaway
 * repository, an ephemeral approver, a scripted subscription runner that
 * stands in for the model) in headless Chromium. Nothing here touches a
 * real database, worker, key, model, or worktree, and headless Chromium
 * emulating a 390×844 viewport is NOT physical iPhone Safari.
 *
 * What it proves, one section per acceptance criterion:
 *   c1  request → proposal card (live, no reload) → confirm → the created
 *       task's own focus → concise plan → Review plan → exact terms →
 *       Approve & start → recorded eligible state; creation and execution
 *       approval demonstrably separate; a repeated confirmation files no
 *       second task.
 *   c2  a reply and a card land while typing: same composer node, draft,
 *       caret, focus, open disclosures and scroll position; New update by
 *       keyboard; the new card still confirms after several polls.
 *   c3  send once, lose the response, reconnect, reload: one provider
 *       dispatch, a durable receipt, and a newer edit that survives the
 *       older send's receipt.
 *   c4  two task lenses with distinct drafts; the provider sees each
 *       task's context; one lens's receipt cannot clear the other's draft.
 *   c5  scope edited while the password form is open: the form and its
 *       password stay, the stale submission is refused, explicit review
 *       reveals the current digest and approves.
 *   c6  an ended session, a bad refresh, offline/online, storage denial,
 *       and JavaScript disabled: no draft loss, no duplicate work, no
 *       misleading success.
 *   c7  1440×900 and 390×844 (plus 320×740 overflow) exact-viewport
 *       screenshots of the proposal, the concise plan, the expanded
 *       approval, and a live update while typing; no document overflow;
 *       the composer clears the tab bar.
 *
 * Revision (build 1550 annotations): the All-projects journey on a
 * two-project fixture (the poll and the task fragment answer, never bounce
 * to the opener); the FULL reconnect — end elsewhere, Reconnect, mint
 * again, the same account's words restored unsent — and another account
 * on the same tab inheriting nothing; the concise card's copy and its
 * height with the long scope at 390 and 320.
 *
 *   node scripts/workspace-chat-proof.mjs [--out output/playwright/workspace-2-chat-2026-09-13] [--strict]
 *
 * Playwright is NOT a dependency of this package: the script imports it
 * from `playwright` when installed, else from PLAYWRIGHT_MODULE, else from
 * the npx cache. With --strict any failed check exits 1. */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startFixture } from './ui-polish-fixture.mjs';
import { addApprover } from '../dist/scope.js';

const args = process.argv.slice(2);
const flag = name => { const at = args.indexOf(name); return at === -1 ? null : args[at + 1] ?? null; };
const out = resolve(flag('--out') ?? 'output/playwright/workspace-2-chat-2026-09-13');
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

const VIEWPORTS = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 }, narrow: { width: 320, height: 740 } };
const report = { generatedAt: new Date().toISOString(), out, fixture: 'scripts/ui-polish-fixture.mjs (synthetic, in-memory; scripted subscription runner, no model)', checks: [], screenshots: [] };
const check = (name, ok, detail) => { report.checks.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

const { chromium } = await loadPlaywright();
const fixture = await startFixture({ slowMs: 9000 });
const browser = await chromium.launch();

async function login(page) {
  await page.goto(`${fixture.url}/login`);
  await page.fill('input[name="name"]', fixture.name);
  await page.fill('input[name="token"]', fixture.password);
  await submit(page, 'button[type="submit"]');
}
async function context(viewport, extra = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: viewport.width < 760, hasTouch: viewport.width < 760, ...extra });
  const page = await ctx.newPage();
  await login(page);
  return { ctx, page };
}
const shot = async (page, name, caption) => {
  const path = join(out, `${name}.png`);
  await page.evaluate(() => { document.documentElement.style.scrollBehavior = 'auto'; });
  await page.screenshot({ path, fullPage: false });
  report.screenshots.push({ path, caption });
  return path;
};
/** Click a submit and wait for a NEW document. */
async function submit(page, selector) {
  // A cross-document view transition still running (the shell animates
  // navigation, JavaScript or not) covers the page with its snapshot
  // pseudo-elements, and Chromium reports <html> intercepting the click.
  await page.waitForFunction(() => { try { return !document.documentElement.matches(':active-view-transition'); } catch { return true; } }, null, { timeout: 5000 }).catch(() => undefined);
  await page.evaluate(() => { window.__staleDocument = true; document.documentElement.style.scrollBehavior = 'auto'; });
  await page.click(selector);
  await page.waitForFunction(() => window.__staleDocument === undefined, null, { timeout: 15000 });
  await page.waitForLoadState('load');
  await page.waitForTimeout(250);
}
const rect = (page, selector) => page.evaluate(sel => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }; }, selector);
const fits = (r, viewport) => r !== null && r.top >= 0 && r.bottom <= viewport.height && r.left >= 0 && r.right <= viewport.width && r.width > 0 && r.height > 0;
const noOverflow = page => page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, ok: document.documentElement.scrollWidth <= document.documentElement.clientWidth }));
const scrollTo = (page, selector, offset = 72) => page.evaluate(([sel, off]) => { const el = document.querySelector(sel); if (!el) return false; document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - off, behavior: 'instant' }); return true; }, [selector, offset]);
const statusText = page => page.evaluate(() => document.getElementById('chat-connection')?.textContent ?? '');
const mark = page => page.evaluate(() => { window.__document = Math.random(); window.__composer = document.querySelector('.composer'); return window.__document; });
const sameDocument = (page, token) => page.evaluate(t => window.__document === t, token);
/** Mint a NEW conversation on this page (ending any live one first). */
async function freshConversation(page, path = '/chat') {
  await settled();
  await page.goto(`${fixture.url}${path}`);
  if (await page.$('form[action="/chat/mate/end"]')) {
    await page.evaluate(() => { const d = document.querySelector('.chat-session-details'); if (d) d.open = true; });
    await submit(page, 'form[action="/chat/mate/end"] button[type="submit"]');
  }
  await page.fill('form[action="/chat/mate/mint"] input[name="token"]', fixture.password);
  await submit(page, 'form[action="/chat/mate/mint"] button[type="submit"]');
}
/** Post a native chat form from a SECOND page in the same context. */
async function postFrom(page, path, fields) {
  return page.evaluate(async ([p, f]) => {
    const r = await fetch(p, { method: 'POST', body: new URLSearchParams(f), credentials: 'same-origin', redirect: 'manual' });
    return { status: r.status, type: r.type };
  }, [path, fields]);
}
const csrfOf = page => page.evaluate(() => document.querySelector('input[name="csrf"]')?.value ?? '');
const leadTurns = () => fixture.store.recentLeadTurns(fixture.name, 50).length;
/** Wait until no lead turn is live (a slow scripted reply from an earlier step). */
const settled = async () => { for (let i = 0; i < 60 && fixture.store.liveLeadTurnFor(fixture.name) !== null; i++) await new Promise(resolve => setTimeout(resolve, 500)); };
const createdTasks = title => fixture.store.listTasks().filter(one => one.title === title);
const TASK_TITLE = 'Add a header row to every CSV export';

try {
  // ---- c1 + c7: the request → plan journey on the desktop ----------------
  const desktop = await context(VIEWPORTS.desktop);
  let page = desktop.page;
  await freshConversation(page);
  let token = await mark(page);
  await page.fill('.composer textarea', 'Add a task for the CSV header row.');
  await page.click('.composer button[type="submit"]');
  await page.waitForSelector('.proposal-task.pending', { timeout: 20000 });
  check('c1 the proposal card arrived through the live refresh without a page load', await sameDocument(page, token) && (await page.evaluate(() => window.__composer === document.querySelector('.composer'))));
  check('c1 the sent draft cleared on its receipt, the request key rotated', (await page.evaluate(() => document.querySelector('.composer textarea').value)) === '' && /^[a-f0-9]{32}$/.test(await page.evaluate(() => document.querySelector('.composer [name="request"]').value)));
  check('c1 the proposal is a proposal: no task exists before confirmation', createdTasks(TASK_TITLE).length === 0);
  await scrollTo(page, '.proposal-task');
  await shot(page, 'desktop-new-task-proposal', 'Desktop 1440×900: the new-task proposal card, arrived live while the composer stayed put (fixture)');
  check('c7 desktop proposal page has no horizontal overflow', (await noOverflow(page)).ok);
  await submit(page, '.proposal-task form[action$="/confirm"] button[type="submit"]');
  const created = createdTasks(TASK_TITLE);
  check('c1 confirming filed exactly one task', created.length === 1, JSON.stringify(created.map(one => one.id)));
  const taskId = created[0]?.id ?? '';
  check('c1 confirmation leads to the created task\'s own focus (by its recorded id)', page.url() === `${fixture.url}/chat?task=${taskId}#task-chat-live` && (await page.evaluate(() => document.querySelector('.composer')?.getAttribute('data-chat-task'))) === taskId, page.url());
  const scopeAfterConfirm = fixture.store.getScope(taskId);
  check('c1 creation is not execution approval: the scope waits unapproved', scopeAfterConfirm !== null && scopeAfterConfirm.approvedAt === null && (await page.evaluate(() => document.querySelector('.task-journey')?.getAttribute('data-work-status'))) === 'needs-approval');
  const brief = await page.evaluate(() => ({
    head: document.querySelector('.chat-plan .chat-plan-head h2')?.textContent ?? null,
    outcome: document.querySelector('.chat-plan .chat-plan-outcome')?.textContent ?? '',
    facts: document.querySelector('.chat-plan .chat-plan-facts')?.textContent ?? '',
    review: document.querySelector('.chat-plan details.chat-approval > summary .button-link')?.textContent ?? null,
    summaryText: document.querySelector('.chat-plan details.chat-approval > summary')?.textContent.trim() ?? null,
    open: document.querySelector('.chat-plan details.chat-approval')?.open ?? null,
    visibleWords: [...document.querySelectorAll('.chat-plan > *:not(details), .chat-plan > details > summary')].map(el => el.textContent).join(' '),
    primaryButtons: [...document.querySelectorAll('#task-chat-live button[type="submit"]:not(.quiet)')].filter(b => b.checkVisibility()).length,
    filedLink: document.querySelector(`a[data-filed-task="${document.querySelector('.composer').getAttribute('data-chat-task')}"]`)?.textContent ?? null,
  }));
  check('c1 the concise plan leads: Plan ready, the outcome, one line of counts, and ONE unbroken Review plan action — no "your next step", "approve to start", "Nothing builds until", or footer (form folded, no competing primary button)', brief.head === 'Plan ready' && brief.outcome.startsWith('Emit one header row') && /^2 paths · 2 checks/.test(brief.facts) && brief.review === 'Approve plan' && brief.summaryText === 'Approve plan' && brief.open === false && brief.primaryButtons === 0 && !/your next step|approve to start|Nothing builds until|full exact terms/i.test(brief.visibleWords), JSON.stringify(brief));
  check('c1 the confirmed card names the created task by id', brief.filedLink !== null && brief.filedLink.includes(taskId), brief.filedLink);
  await scrollTo(page, '#task-chat-action');
  await shot(page, 'desktop-concise-plan', 'Desktop 1440×900: the created task\'s focus with the concise plan and its one Review plan action (fixture)');
  await page.click('.chat-plan details.chat-approval > summary');
  await page.waitForTimeout(150);
  const exact = await page.evaluate(() => {
    const form = document.querySelector('#task-chat-action form.approve-form');
    const text = form?.textContent ?? '';
    return {
      goal: text.includes('Keep the existing column order and names exactly as they are.'),
      not: text.includes('No changes to the settlement engine or the ledger schema; no new export formats.'),
      paths: text.includes('src/export/csv.ts') && text.includes('src/export/csv.test.ts'),
      criteria: text.includes('c1') && text.includes('c2') && text.includes('[requires: check, changed-path]'),
      agents: form?.querySelector('.agents-ceremony') !== null,
      permission: text.includes('Workspace sandbox') || text.includes('Full access') || text.includes('Auto permissions'),
      nonce: /^[a-f0-9]{32}$/.test(form?.querySelector('[name="nonce"]')?.value ?? ''),
      digest: /^[a-f0-9]{32,64}$/.test(form?.querySelector('[name="digest"]')?.value ?? ''),
      password: form?.querySelector('input[type="password"][name="token"]') !== null,
      lead: text.includes('These are the exact terms. Nothing builds until your password approves them.'),
      approve: form?.querySelector('button[type="submit"]')?.textContent ?? null,
      approves: [...document.querySelectorAll('#task-chat-live button[type="submit"]:not(.quiet)')].filter(b => b.checkVisibility()).length,
    };
  });
  check('c1 Review plan reveals the full exact terms — goal, exclusions, paths, criteria, agents, permissions, digest, nonce, the password words, password — and Approve & start is the one submit', Object.entries(exact).every(([k, v]) => k === 'approve' ? v === 'Approve & start' : k === 'approves' ? v === 1 : v === true), JSON.stringify(exact));
  await scrollTo(page, '#task-chat-action');
  await shot(page, 'desktop-expanded-approval', 'Desktop 1440×900: Review plan opened — the exact signed terms, password, and Approve & start (fixture)');
  check('c7 desktop expanded approval has no horizontal overflow', (await noOverflow(page)).ok);
  await page.fill('#task-chat-action input[name="token"]', fixture.password);
  await submit(page, '#task-chat-action button[type="submit"]');
  const scopeAfterApprove = fixture.store.getScope(taskId);
  const journey = await page.evaluate(() => ({ status: document.querySelector('.task-journey')?.getAttribute('data-work-status'), headline: document.querySelector('.task-journey h2')?.textContent, form: document.querySelector('form.approve-form') !== null }));
  check('c1 Approve & start records the approval (eligible state) and the journey says so; the form is gone', scopeAfterApprove?.approvedBy === fixture.name && page.url() === `${fixture.url}/chat?task=${taskId}` && journey.form === false && journey.status !== 'needs-approval', JSON.stringify(journey));
  // Repeated confirmation of the same card: the door refuses, no second task.
  const again = await postFrom(page, '/chat/proposal/1/confirm', { csrf: await csrfOf(page), return: `/chat?task=${taskId}` });
  check('c1 confirming the same proposal again files no second task', again.status === 0 || again.status === 303 ? createdTasks(TASK_TITLE).length === 1 : false, JSON.stringify({ again, tasks: createdTasks(TASK_TITLE).length }));
  await desktop.ctx.close();

  // ---- c2: a reply and a card land while typing (desktop) -----------------
  const live = await context(VIEWPORTS.desktop);
  page = live.page;
  const second = await live.ctx.newPage();
  await freshConversation(page);
  await page.fill('.composer textarea', 'Please pause the ledger export until I read it.');
  await page.click('.composer button[type="submit"]');
  await page.waitForSelector('.proposal-hold.pending', { timeout: 20000 });
  await submit(page, '.proposal-hold form[action$="/confirm"] button[type="submit"]');
  await page.goto(`${fixture.url}/chat`);
  token = await mark(page);
  await page.evaluate(() => { const d = document.querySelector('.chat-session-details'); if (d) d.open = true; const f = document.querySelector('.chat-fleet-context'); if (f) f.open = true; });
  await page.focus('.composer textarea');
  await page.keyboard.type('Now check the proof for');
  // The reader scrolls back up to re-read while the draft keeps focus.
  await page.evaluate(() => { const b = document.querySelector('.composer textarea'); b.setSelectionRange(9, 9); document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo({ top: 0, behavior: 'instant' }); });
  const before = await page.evaluate(() => { document.body.setAttribute('data-before-messages', String(document.querySelectorAll('.msg').length)); return { scrollY: window.scrollY, messages: document.querySelectorAll('.msg').length, height: document.documentElement.scrollHeight }; });
  // A second tab sends the next message natively; the reply lands here live.
  await second.goto(`${fixture.url}/chat`);
  await second.fill('.composer textarea', 'Brief me slowly.');
  await second.click('.composer button[type="submit"]');
  await page.waitForSelector('.chat-thinking', { timeout: 15000 });
  const during = await page.evaluate(() => ({ value: document.querySelector('.composer textarea').value, caret: document.querySelector('.composer textarea').selectionStart, focused: document.activeElement === document.querySelector('.composer textarea'), same: window.__composer === document.querySelector('.composer'), thinking: document.querySelector('.chat-thinking') !== null }));
  check('c2 the reply-in-progress card landed live while the composer kept its node, draft, caret and focus', during.same && during.thinking && during.value === 'Now check the proof for' && during.caret === 9 && during.focused, JSON.stringify(during));
  await page.waitForFunction(() => document.querySelector('.chat-thinking') === null && document.querySelectorAll('.msg').length >= 4, null, { timeout: 20000 });
  const after = await page.evaluate(() => ({
    value: document.querySelector('.composer textarea').value, caret: document.querySelector('.composer textarea').selectionStart,
    focused: document.activeElement === document.querySelector('.composer textarea'), same: window.__composer === document.querySelector('.composer'),
    detailsOpen: document.querySelector('.chat-session-details')?.open, messages: document.querySelectorAll('.msg').length, scrollY: window.scrollY,
    newUpdate: !document.getElementById('chat-new-update').hidden, firstNewKey: document.querySelectorAll('.msg')[Number(document.body.getAttribute('data-before-messages'))]?.getAttribute('data-key') ?? null,
  }));
  check('c2 the reply landed live: same composer node, draft, caret, focus and open disclosure retained; the reading position stayed and New update appeared', await sameDocument(page, token) && after.same && after.value === 'Now check the proof for' && after.caret === 9 && after.focused && after.detailsOpen === true && after.messages === before.messages + 2 && Math.abs(after.scrollY - before.scrollY) <= 1 && after.newUpdate, JSON.stringify({ before, after }));
  await shot(page, 'desktop-live-update-while-typing', 'Desktop 1440×900: a reply landed live while typing — the draft and caret stayed, the reader was not moved, New update offers the way down (fixture)');
  // New update by keyboard: Shift+Tab from the textarea reaches it; Enter moves the reader and focus to the new content.
  await page.keyboard.press('Shift+Tab');
  const onButton = await page.evaluate(() => document.activeElement?.id === 'chat-new-update');
  if (onButton) await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
  const moved = await page.evaluate(() => ({ hidden: document.getElementById('chat-new-update').hidden, focusedKey: document.activeElement?.getAttribute('data-key'), scrollY: window.scrollY, visible: (() => { const r = document.activeElement?.getBoundingClientRect(); return r ? r.top >= 0 && r.top < window.innerHeight : false; })() }));
  check('c2 New update is reached by keyboard and, on Enter, scrolls to and focuses the first new message', onButton && moved.hidden && moved.focusedKey === after.firstNewKey && moved.focusedKey !== null && moved.scrollY > before.scrollY && moved.visible, JSON.stringify({ onButton, moved, firstNewKey: after.firstNewKey }));
  // A card that arrives live stays actionable after several polls.
  await second.fill('.composer textarea', 'Propose a tighter scope for the ledger export.');
  await second.click('.composer button[type="submit"]');
  await page.waitForSelector('.proposal-scope.pending', { timeout: 20000 });
  await page.waitForTimeout(11000); // at least two idle polls
  const polled = await page.evaluate(() => ({ same: window.__composer === document.querySelector('.composer'), value: document.querySelector('.composer textarea').value, card: document.querySelector('.proposal-scope.pending') !== null }));
  check('c2 after several polls the composer draft is intact and the live card is still pending', await sameDocument(page, token) && polled.same && polled.value === 'Now check the proof for' && polled.card, JSON.stringify(polled));
  await scrollTo(page, '.proposal-scope');
  await submit(page, '.proposal-scope form[action$="/confirm"] button[type="submit"]');
  check('c2 the live card confirmed once through its own form after multiple polls', (await page.$('.proposal-scope.confirmed')) !== null && fixture.store.getLeadProposal(3)?.state === 'confirmed');
  await second.close();
  await live.ctx.close();

  // ---- c3: send once, lose the response, reconnect, reload -------------
  const lost = await context(VIEWPORTS.desktop);
  page = lost.page;
  await freshConversation(page);
  const turnsBefore = leadTurns();
  // The server handles the POST; the page never sees the answer. The
  // status poll is slowed so the unconfirmed state is observable before
  // the receipt settles it (the poll is otherwise fast enough to win).
  const dropPost = async route => { if (route.request().method() !== 'POST') return route.continue(); try { await route.fetch(); } catch { /* the server still ran it */ } await route.abort('failed'); };
  const slowPoll = async route => { await new Promise(resolve => setTimeout(resolve, 3000)); try { await route.continue(); } catch { /* the page moved on */ } };
  await page.route('**/chat', dropPost);
  await page.route('**/chat/mate/status*', slowPoll);
  await page.fill('.composer textarea', 'Brief me.');
  await page.click('.composer button[type="submit"]');
  await page.waitForFunction(() => /not confirmed/.test(document.getElementById('chat-connection')?.textContent ?? ''), null, { timeout: 15000 });
  await page.unroute('**/chat');
  const unconfirmed = await page.evaluate(() => ({ value: document.querySelector('.composer textarea').value, stored: JSON.parse(sessionStorage.getItem(Object.keys(sessionStorage).find(k => k.startsWith('standing-orders:chat-draft:')) ?? '') ?? 'null') }));
  check('c3 a lost send response keeps the draft as submitted and says it is not confirmed — no automatic retry', unconfirmed.value === 'Brief me.' && unconfirmed.stored?.submitted === true, JSON.stringify(unconfirmed));
  await page.waitForFunction(() => document.querySelector('.composer textarea').value === '', null, { timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('.chat-thinking') === null && document.querySelectorAll('.msg').length >= 2, null, { timeout: 20000 });
  check('c3 the receipt poll cleared the draft once the server had the message; exactly one turn ran', leadTurns() === turnsBefore + 1, `turns ${turnsBefore} → ${leadTurns()}`);
  await page.unroute('**/chat/mate/status*');
  // Reload with a submitted draft restored: the receipt settles it; no second turn.
  const requestKey = 'c'.repeat(32);
  await page.route('**/chat', dropPost);
  await page.route('**/chat/mate/status*', slowPoll);
  await page.fill('.composer textarea', 'Brief me.');
  // A known request key, so the receipt can be read from the store after the reload.
  await page.evaluate(k => { document.querySelector('.composer [name="request"]').value = k; }, requestKey);
  await page.click('.composer button[type="submit"]');
  await page.waitForFunction(() => /not confirmed/.test(document.getElementById('chat-connection')?.textContent ?? ''), null, { timeout: 15000 });
  await page.unroute('**/chat');
  await page.unroute('**/chat/mate/status*');
  await page.reload();
  await page.waitForLoadState('load');
  const restored = await page.evaluate(() => document.querySelector('.composer textarea').value);
  await page.waitForFunction(() => document.querySelector('.composer textarea').value === '', null, { timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('.chat-thinking') === null, null, { timeout: 20000 });
  const receipt = fixture.store.leadRequestReceipt(fixture.store.activeLeadSession(fixture.name).id, requestKey);
  check('c3 after a reload the restored submitted draft settled on its durable receipt: one turn for that key, no second dispatch', (restored === 'Brief me.' || restored === '') && receipt !== null && leadTurns() === turnsBefore + 2, JSON.stringify({ restored, receipt: receipt !== null, turns: leadTurns() - turnsBefore }));
  // Resending the SAME key by hand is the same turn (replayed), never a second one.
  const replay = await postFrom(page, '/chat', { csrf: await csrfOf(page), message: 'Brief me.', request: requestKey, 'request-session': await page.evaluate(() => document.querySelector('.composer').getAttribute('data-chat-session')) });
  await page.waitForTimeout(800);
  check('c3 a repeated send with the same request key replays instead of dispatching again', (replay.status === 0 || replay.status === 303) && leadTurns() === turnsBefore + 2, JSON.stringify({ replay, turns: leadTurns() - turnsBefore }));
  // A newer edit survives the older send's receipt.
  await page.route('**/chat', dropPost);
  await page.route('**/chat/mate/status*', slowPoll);
  await page.fill('.composer textarea', 'Brief me slowly.');
  await page.click('.composer button[type="submit"]');
  await page.waitForFunction(() => /not confirmed/.test(document.getElementById('chat-connection')?.textContent ?? ''), null, { timeout: 15000 });
  await page.unroute('**/chat');
  await page.evaluate(() => { const b = document.querySelector('.composer textarea'); b.value = 'Brief me slowly, then the proof.'; b.dispatchEvent(new Event('input')); });
  await page.unroute('**/chat/mate/status*');
  await page.waitForFunction(() => document.querySelector('.chat-thinking') === null && !/not confirmed/.test(document.getElementById('chat-connection')?.textContent ?? ''), null, { timeout: 25000 });
  const edited = await page.evaluate(() => ({ value: document.querySelector('.composer textarea').value, status: document.getElementById('chat-connection').textContent }));
  check('c3 a newer unsent edit survives the older send\'s receipt', edited.value === 'Brief me slowly, then the proof.' && leadTurns() === turnsBefore + 3, JSON.stringify({ edited, turns: leadTurns() - turnsBefore }));
  // Offline, then online: sending waits, the draft stays, the poll resumes.
  await lost.ctx.setOffline(true);
  await page.waitForFunction(() => /Offline|Connection lost/.test(document.getElementById('chat-connection')?.textContent ?? ''), null, { timeout: 15000 });
  const off = await page.evaluate(() => ({ disabled: document.querySelector('.composer button[type="submit"]').disabled, value: document.querySelector('.composer textarea').value, status: document.getElementById('chat-connection').textContent }));
  await lost.ctx.setOffline(false);
  await page.waitForFunction(() => document.getElementById('chat-connection')?.textContent === 'Connected.', null, { timeout: 20000 });
  const on = await page.evaluate(() => ({ disabled: document.querySelector('.composer button[type="submit"]').disabled, value: document.querySelector('.composer textarea').value }));
  check('c3/c6 offline disables sending and keeps the draft; online reconnects and re-enables it', off.disabled && off.value === 'Brief me slowly, then the proof.' && !on.disabled && on.value === off.value, JSON.stringify({ off, on }));
  await lost.ctx.close();

  // ---- c4: two task lenses, two drafts, the right context ----------------
  const lenses = await context(VIEWPORTS.desktop);
  page = lenses.page;
  await freshConversation(page);
  const A = fixture.tasks.long, B = fixture.statusTasks.waitingForBuilder;
  await page.goto(`${fixture.url}/chat?task=${A}`);
  await page.fill('.composer textarea', 'Draft for A: tighten the export.');
  await page.goto(`${fixture.url}/chat?task=${B}`);
  const bEmpty = await page.evaluate(() => document.querySelector('.composer textarea').value);
  await page.fill('.composer textarea', 'Draft for B: when does it stream?');
  await page.goto(`${fixture.url}/chat?task=${A}`);
  const aBack = await page.evaluate(() => ({ value: document.querySelector('.composer textarea').value, task: document.querySelector('.composer').getAttribute('data-chat-task'), hidden: document.querySelector('.composer [name="task"]')?.value }));
  check('c4 each task lens restores only its own draft, bound to its task', bEmpty === '' && aBack.value === 'Draft for A: tighten the export.' && aBack.task === A && aBack.hidden === A, JSON.stringify({ bEmpty, aBack }));
  const requestsBefore = fixture.requests.length;
  await page.click('.composer button[type="submit"]');
  await page.waitForFunction(() => document.querySelector('.composer textarea').value === '', null, { timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('.chat-thinking') === null && document.querySelectorAll('.msg').length >= 2, null, { timeout: 20000 });
  const seenByProvider = fixture.requests.slice(requestsBefore).map(one => one.text);
  check('c4 the provider was handed A\'s context with A\'s message, never B\'s', seenByProvider.length >= 1 && seenByProvider[0].includes(`Current task: ${A}.`) && seenByProvider[0].includes('Draft for A: tighten the export.') && !seenByProvider.some(one => one.includes(`Current task: ${B}.`)), JSON.stringify(seenByProvider.map(one => one.slice(0, 80))));
  await page.goto(`${fixture.url}/chat?task=${B}`);
  await page.waitForTimeout(600);
  const bAfter = await page.evaluate(() => ({ value: document.querySelector('.composer textarea').value, task: document.querySelector('.composer').getAttribute('data-chat-task'), messages: document.querySelectorAll('.msg').length }));
  check('c4 A\'s send and receipt did not clear or submit B\'s draft; the unified thread is one thread under either lens', bAfter.value === 'Draft for B: when does it stream?' && bAfter.task === B && bAfter.messages >= 2, JSON.stringify(bAfter));
  await lenses.ctx.close();

  // ---- c5: the scope changes while the password form is open ------------
  const stale = await context(VIEWPORTS.desktop);
  page = stale.page;
  const editor = await stale.ctx.newPage();
  await freshConversation(page, `/chat?task=${A}`);
  await page.goto(`${fixture.url}/chat?task=${A}`);
  token = await mark(page);
  await page.click('.chat-plan details.chat-approval > summary');
  await page.fill('#task-chat-action input[name="token"]', fixture.password);
  const formBefore = await page.evaluate(() => { window.__form = document.querySelector('form.approve-form'); return { nonce: window.__form.querySelector('[name="nonce"]').value, digest: window.__form.querySelector('[name="digest"]').value, csrf: window.__form.querySelector('[name="csrf"]').value }; });
  await editor.goto(`${fixture.url}/t/${A}`);
  const edited2 = await postFrom(editor, `/t/${A}/scope`, { csrf: await csrfOf(editor), sawDigest: fixture.store.getScope(A).digest, goal: 'Rework the portfolio ledger export — CSV writer and range filter only.', not: 'No progress control this time.', touches: 'src/export/csv.ts, src/export/range.ts', acceptance: 'c1: Quoted fields round-trip through a standard CSV parser. | check' });
  await page.waitForSelector('.chat-approval-stale', { timeout: 15000 });
  const staleState = await page.evaluate(() => ({
    sameDocument: true, sameForm: window.__form === document.querySelector('form.approve-form'), password: document.querySelector('#task-chat-action input[name="token"]').value,
    digest: document.querySelector('form.approve-form [name="digest"]').value, disabled: document.querySelector('form.approve-form button[type="submit"]').disabled,
    note: document.querySelector('.chat-approval-stale').textContent, review: document.querySelector('.chat-approval-stale button')?.textContent, notes: document.querySelectorAll('.chat-approval-stale').length,
  }));
  check('c5 the open form and its typed password were not swapped; the page says the plan changed, disables the stale submit, and offers explicit review', await sameDocument(page, token) && staleState.sameForm && staleState.password === fixture.password && staleState.digest === formBefore.digest && staleState.disabled && /plan changed/.test(staleState.note) && staleState.review === 'Review the current plan' && staleState.notes === 1 && (edited2.status === 0 || edited2.status === 303), JSON.stringify({ ...staleState, password: '(kept)' }));
  await scrollTo(page, '.chat-approval-stale', 120);
  await shot(page, 'desktop-stale-approval', 'Desktop 1440×900: the scope changed while the password form was open — the form stays, its submit is disabled, and review is explicit (fixture)');
  // The stale form submitted anyway (the server is the authority): refused.
  const refused = await page.evaluate(async f => {
    const r = await fetch(`/t/${f.task}/approve`, { method: 'POST', body: new URLSearchParams({ csrf: f.csrf, nonce: f.nonce, digest: f.digest, token: f.token, return: `/chat?task=${f.task}` }), credentials: 'same-origin', redirect: 'follow' });
    return { url: r.url, approved: false };
  }, { ...formBefore, task: A, token: fixture.password });
  check('c5 the stale submission is refused by the server and nothing is approved', /changed\+while\+this\+form\+was\+open|changed%20while%20this%20form%20was%20open/.test(refused.url) && fixture.store.getScope(A).approvedAt === null, refused.url);
  await page.evaluate(() => { window.__staleDocument = true; });
  await page.click('.chat-approval-stale button');
  await page.waitForFunction(() => window.__staleDocument === undefined, null, { timeout: 15000 });
  await page.waitForLoadState('load');
  const current = await page.evaluate(() => ({ digest: document.querySelector('form.approve-form [name="digest"]')?.value, goal: document.querySelector('.chat-plan .chat-plan-outcome')?.textContent, stale: document.querySelector('.chat-approval-stale') !== null }));
  check('c5 explicit review reveals the current exact digest and terms', current.digest === fixture.store.getScope(A).digest && current.digest !== formBefore.digest && /CSV writer and range filter only/.test(current.goal ?? '') && !current.stale, JSON.stringify(current));
  await page.click('.chat-plan details.chat-approval > summary');
  await page.fill('#task-chat-action input[name="token"]', fixture.password);
  await submit(page, '#task-chat-action button[type="submit"]');
  check('c5 approving the reviewed current terms succeeds', fixture.store.getScope(A).approvedBy === fixture.name && fixture.store.getScope(A).approvedDigest === current.digest);
  await editor.close();
  await stale.ctx.close();

  // ---- c6: ended session, bad refresh, storage denial, no JavaScript ----
  const safety = await context(VIEWPORTS.desktop);
  page = safety.page;
  const other = await safety.ctx.newPage();
  await freshConversation(page);
  await page.fill('.composer textarea', 'A draft that must survive.');
  token = await mark(page);
  // A failed / malformed refresh changes nothing and keeps retrying.
  const threadBefore = await page.evaluate(() => document.getElementById('chat-thread').innerHTML);
  let served = 0;
  await page.route('**/chat/mate/status*', route => { served++; return route.fulfill({ status: served % 2 ? 503 : 200, contentType: 'text/html', body: served % 2 ? 'down' : '<html>not json</html>' }); });
  await page.waitForFunction(() => /Reconnecting/.test(document.getElementById('chat-connection')?.textContent ?? ''), null, { timeout: 15000 });
  const badRefresh = await page.evaluate(() => ({ thread: document.getElementById('chat-thread').innerHTML, value: document.querySelector('.composer textarea').value, status: document.getElementById('chat-connection').textContent }));
  await page.unroute('**/chat/mate/status*');
  await page.waitForFunction(() => document.getElementById('chat-connection')?.textContent === 'Connected.', null, { timeout: 25000 });
  check('c6 a failed or malformed refresh leaves the thread and draft untouched, says so, and recovers by itself', badRefresh.thread === threadBefore && badRefresh.value === 'A draft that must survive.' && /Connection lost/.test(badRefresh.status) && await sameDocument(page, token), badRefresh.status);
  // The conversation ends from another tab: this page keeps the draft,
  // stops sending, and waits for an explicit reconnection.
  await other.goto(`${fixture.url}/chat`);
  await other.evaluate(() => { const d = document.querySelector('.chat-session-details'); if (d) d.open = true; });
  await submit(other, 'form[action="/chat/mate/end"] button[type="submit"]');
  await page.waitForFunction(() => /changed or ended/.test(document.getElementById('chat-connection')?.textContent ?? ''), null, { timeout: 15000 });
  const ended = await page.evaluate(() => ({ value: document.querySelector('.composer textarea').value, disabled: document.querySelector('.composer button[type="submit"]').disabled, reconnect: !document.getElementById('chat-reconnect').hidden, stored: sessionStorage.length }));
  const turnsAtEnd = leadTurns();
  await page.click('.composer button[type="submit"]', { force: true }).catch(() => undefined);
  await page.waitForTimeout(500);
  check('c6 an ended session keeps the visible draft, disables sending until an explicit reconnection, and dispatches nothing', await sameDocument(page, token) && ended.value === 'A draft that must survive.' && ended.disabled && ended.reconnect && ended.stored >= 1 && leadTurns() === turnsAtEnd, JSON.stringify(ended));
  // The FULL reconnection (revision): Reconnect reloads onto the mint card
  // (no composer, nothing sent); minting again for the SAME account brings
  // the words back as a new unsent draft under the new session and a fresh
  // request key. The carry names the account the server rendered.
  const endedSession = await page.evaluate(() => document.querySelector('.composer').getAttribute('data-chat-session'));
  await page.evaluate(() => { window.__staleDocument = true; });
  await page.click('#chat-reconnect button');
  await page.waitForFunction(() => window.__staleDocument === undefined, null, { timeout: 15000 });
  await page.waitForLoadState('load');
  const atMint = await page.evaluate(() => ({ mint: document.querySelector('form[action="/chat/mate/mint"]') !== null, composer: document.querySelector('.composer') !== null, carry: JSON.parse(sessionStorage.getItem('standing-orders:chat-carry:') ?? 'null') }));
  await page.fill('form[action="/chat/mate/mint"] input[name="token"]', fixture.password);
  await submit(page, 'form[action="/chat/mate/mint"] button[type="submit"]');
  await page.waitForFunction(() => document.getElementById('chat-connection')?.textContent === 'Connected.', null, { timeout: 15000 });
  const reconnected = await page.evaluate(() => {
    const composer = document.querySelector('.composer');
    const session = composer.getAttribute('data-chat-session');
    return { value: composer.querySelector('textarea').value, session, user: composer.getAttribute('data-chat-user'), request: composer.querySelector('[name="request"]').value, carry: sessionStorage.getItem('standing-orders:chat-carry:'), stored: JSON.parse(sessionStorage.getItem(`standing-orders:chat-draft:${session}:`) ?? 'null'), disabled: composer.querySelector('button[type="submit"]').disabled };
  });
  check('c6 the full reconnection — Reconnect, the mint card, mint again — restores the same account\'s words unsent under the new session with a fresh key, the carry consumed, nothing dispatched', atMint.mint && !atMint.composer && atMint.carry?.owner === fixture.name && atMint.carry?.text === 'A draft that must survive.' && reconnected.value === 'A draft that must survive.' && reconnected.session !== endedSession && reconnected.user === fixture.name && /^[a-f0-9]{32}$/.test(reconnected.request) && reconnected.stored?.submitted === false && reconnected.carry === null && !reconnected.disabled && leadTurns() === turnsAtEnd, JSON.stringify({ atMint, reconnected, endedSession }));
  // Another account on the SAME tab inherits nothing: the first account's
  // Reconnect leaves its carry behind; the second signs in, mints, and its
  // composer is empty — the record is discarded, not shown.
  await other.goto(`${fixture.url}/chat`);
  await other.evaluate(() => { const d = document.querySelector('.chat-session-details'); if (d) d.open = true; });
  await submit(other, 'form[action="/chat/mate/end"] button[type="submit"]');
  await page.waitForFunction(() => /changed or ended/.test(document.getElementById('chat-connection')?.textContent ?? ''), null, { timeout: 15000 });
  await page.evaluate(() => { window.__staleDocument = true; });
  await page.click('#chat-reconnect button');
  await page.waitForFunction(() => window.__staleDocument === undefined, null, { timeout: 15000 });
  await page.waitForLoadState('load');
  const leftBehind = await page.evaluate(() => JSON.parse(sessionStorage.getItem('standing-orders:chat-carry:') ?? 'null'));
  const secondAccount = addApprover(fixture.store, 'second-account', new Date(), { name: fixture.name, token: fixture.password });
  if (!secondAccount.ok) throw new Error(`second account: ${secondAccount.reason}`);
  await page.evaluate(async () => { await fetch('/logout', { method: 'POST', credentials: 'same-origin', redirect: 'manual' }); });
  await page.goto(`${fixture.url}/login`);
  await page.fill('input[name="name"]', 'second-account');
  await page.fill('input[name="token"]', secondAccount.token);
  await submit(page, 'button[type="submit"]');
  await page.goto(`${fixture.url}/chat`);
  await page.fill('form[action="/chat/mate/mint"] input[name="token"]', secondAccount.token);
  await submit(page, 'form[action="/chat/mate/mint"] button[type="submit"]');
  await page.waitForFunction(() => document.getElementById('chat-connection')?.textContent === 'Connected.', null, { timeout: 15000 });
  const otherAccount = await page.evaluate(() => ({ user: document.querySelector('.composer').getAttribute('data-chat-user'), value: document.querySelector('.composer textarea').value, carry: sessionStorage.getItem('standing-orders:chat-carry:'), drafts: Object.keys(sessionStorage).filter(k => k.startsWith('standing-orders:chat-draft:')).map(k => sessionStorage.getItem(k)) }));
  check('c6 another account signing in on the same tab never inherits the first account\'s reconnect draft: the composer is empty and the record is gone', leftBehind?.owner === fixture.name && leftBehind?.text === 'A draft that must survive.' && otherAccount.user === 'second-account' && otherAccount.value === '' && otherAccount.carry === null && !otherAccount.drafts.some(one => /A draft that must survive/.test(one ?? '')), JSON.stringify({ leftBehind, otherAccount }));
  await other.close();
  await safety.ctx.close();
  // Storage denied: the draft stays on the page, the words say so, sending still works once.
  const denied = await context(VIEWPORTS.desktop);
  page = denied.page;
  await page.addInitScript(() => { const original = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (String(k).startsWith('standing-orders:chat-draft:')) throw new Error('denied'); return original.call(this, k, v); }; });
  await freshConversation(page);
  await page.fill('.composer textarea', 'Brief me.');
  const deniedWords = await statusText(page);
  const turnsBeforeDenied = leadTurns();
  await page.click('.composer button[type="submit"]');
  await page.waitForFunction(() => document.querySelector('.composer textarea').value === '', null, { timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('.chat-thinking') === null, null, { timeout: 20000 });
  check('c6 storage denial says the draft stays on this page only, and the send still goes through exactly once', /storage is unavailable/.test(deniedWords) && leadTurns() === turnsBeforeDenied + 1, deniedWords);
  await denied.ctx.close();
  // ---- c7: phone journey screenshots and overflow -------------------------
  const phone = await context(VIEWPORTS.phone);
  page = phone.page;
  const phoneSecond = await phone.ctx.newPage();
  await freshConversation(page);
  await page.fill('.composer textarea', 'Add a task for the CSV header row.');
  await page.click('.composer button[type="submit"]');
  await page.waitForSelector('.proposal-task.pending', { timeout: 20000 });
  await scrollTo(page, '.proposal-task', 80);
  await shot(page, 'phone-new-task-proposal', 'Phone 390×844: the new-task proposal card arrived live (fixture)');
  check('c7 phone proposal page has no horizontal overflow', (await noOverflow(page)).ok);
  const phoneTasksBefore = createdTasks(TASK_TITLE).length;
  await submit(page, '.proposal-task form[action$="/confirm"] button[type="submit"]');
  const phoneTask = createdTasks(TASK_TITLE).find(one => !created.some(c => c.id === one.id))?.id ?? '';
  check('c7 the phone confirmation filed one more task and landed on its focus', createdTasks(TASK_TITLE).length === phoneTasksBefore + 1 && page.url().startsWith(`${fixture.url}/chat?task=${phoneTask}`), page.url());
  await scrollTo(page, '#task-chat-action', 80);
  await shot(page, 'phone-concise-plan', 'Phone 390×844: the created task\'s concise plan with its one Review plan action (fixture)');
  const planFit = await page.evaluate(() => { const r = document.querySelector('.chat-plan details.chat-approval > summary .button-link').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, right: r.right }; });
  check('c7 phone: Review plan is inside the viewport and the page does not overflow', planFit.top >= 0 && planFit.bottom <= 844 && planFit.right <= 390 && (await noOverflow(page)).ok, JSON.stringify(planFit));
  await page.click('.chat-plan details.chat-approval > summary');
  await page.waitForTimeout(150);
  await scrollTo(page, '.approval-confirm', 300);
  await shot(page, 'phone-expanded-approval', 'Phone 390×844: Review plan opened — password and Approve & start above the tab bar (fixture)');
  const approveRect = await rect(page, '#task-chat-action .approval-confirm button[type="submit"]');
  const tabbar = await rect(page, '.tabbar');
  check('c7 phone: Approve & start is not hidden beneath the tab bar or composer', approveRect !== null && tabbar !== null && approveRect.bottom <= tabbar.top + 0.5 && approveRect.top >= 0 && (await noOverflow(page)).ok, JSON.stringify({ approveRect, tabbar }));
  // Live update while typing on the phone: the reader sits at the top.
  await page.goto(`${fixture.url}/chat`);
  await page.evaluate(() => { document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo({ top: 0, behavior: 'instant' }); });
  await page.focus('.composer textarea');
  await page.keyboard.type('And on the phone');
  token = await mark(page);
  await phoneSecond.goto(`${fixture.url}/chat`);
  await phoneSecond.fill('.composer textarea', 'Brief me slowly.');
  await phoneSecond.click('.composer button[type="submit"]');
  await page.waitForFunction(() => !document.getElementById('chat-new-update').hidden, null, { timeout: 25000 });
  const phoneLive = await page.evaluate(() => {
    const button = document.getElementById('chat-new-update').getBoundingClientRect();
    const composer = document.querySelector('.composer').getBoundingClientRect();
    const tab = document.querySelector('.tabbar').getBoundingClientRect();
    return { value: document.querySelector('.composer textarea').value, focused: document.activeElement === document.querySelector('.composer textarea'), same: window.__composer === document.querySelector('.composer'), button: { top: button.top, bottom: button.bottom, left: button.left, right: button.right }, clearsComposer: button.bottom <= composer.top + 0.5, composerClearsTab: composer.bottom <= tab.top + 0.5, scrollY: window.scrollY };
  });
  check('c7/c2 phone: a live update while typing keeps the draft and focus, the reader stays put, and New update sits above the composer and tab bar inside the viewport', await sameDocument(page, token) && phoneLive.same && phoneLive.value === 'And on the phone' && phoneLive.focused && phoneLive.scrollY === 0 && phoneLive.button.top >= 0 && phoneLive.button.bottom <= 844 && phoneLive.button.left >= 0 && phoneLive.button.right <= 390 && phoneLive.clearsComposer && phoneLive.composerClearsTab && (await noOverflow(page)).ok, JSON.stringify(phoneLive));
  await shot(page, 'phone-live-update-while-typing', 'Phone 390×844: a live update landed while typing — draft kept, reader not moved, New update above the composer (fixture)');
  await phoneSecond.close();
  await phone.ctx.close();
  // No JavaScript: native forms carry the whole journey (c6).
  await settled();
  const noScript = await browser.newContext({ viewport: VIEWPORTS.desktop, deviceScaleFactor: 1, javaScriptEnabled: false });
  page = await noScript.newPage();
  await login(page);
  await page.goto(`${fixture.url}/chat`);
  if (await page.$('form[action="/chat/mate/end"]')) { await page.click('.chat-session-details > summary'); await submit(page, 'form[action="/chat/mate/end"] button[type="submit"]'); }
  await page.fill('form[action="/chat/mate/mint"] input[name="token"]', fixture.password);
  await submit(page, 'form[action="/chat/mate/mint"] button[type="submit"]');
  const turnsNoScript = leadTurns();
  await page.fill('.composer textarea', 'Brief me.');
  await submit(page, '.composer button[type="submit"]');
  const nativeRedirect = page.url().endsWith('/chat#latest');
  let nativeState = null;
  for (let i = 0; i < 30; i++) {
    nativeState = await page.evaluate(() => ({ thinking: document.querySelector('.chat-thinking') !== null, messages: [...document.querySelectorAll('.msg')].map(m => m.className), problem: document.querySelector('.problem')?.textContent ?? null }));
    if (!nativeState.thinking && nativeState.messages.includes('msg mate')) break;
    await page.waitForTimeout(500); await page.goto(`${fixture.url}/chat`);
  }
  const nativeReply = nativeState !== null && !nativeState.thinking && nativeState.messages.includes('msg mate');
  await page.goto(`${fixture.url}/chat?task=${phoneTask}`);
  const noScriptPlan = await page.evaluate(() => ({ plan: document.querySelector('.chat-plan') !== null, review: document.querySelector('.chat-plan details.chat-approval > summary') !== null, form: document.querySelector('form.approve-form input[type="password"]') !== null, composer: document.querySelector('.composer textarea') !== null }));
  check('c6 without JavaScript the native send redirects and dispatches once, the reply reads after a reload, and the task focus keeps its native Review plan disclosure and password form', nativeRedirect && leadTurns() === turnsNoScript + 1 && nativeReply && noScriptPlan.plan && noScriptPlan.review && noScriptPlan.form && noScriptPlan.composer, JSON.stringify({ nativeRedirect, nativeReply, nativeState, turns: leadTurns() - turnsNoScript, noScriptPlan }));
  await noScript.close();

  // 320×740: overflow on the same surfaces.
  const narrow = await context(VIEWPORTS.narrow);
  for (const path of ['/chat', `/chat?task=${taskId}`, `/chat?task=${A}`]) {
    await narrow.page.goto(`${fixture.url}${path}`);
    const flow = await noOverflow(narrow.page);
    check(`c7 no document horizontal overflow at 320px on ${path}`, flow.ok, JSON.stringify(flow));
  }
  await narrow.page.goto(`${fixture.url}/chat?task=${phoneTask}`);
  await narrow.page.click('.chat-plan details.chat-approval > summary').catch(() => undefined);
  check('c7 no document horizontal overflow at 320px with the approval expanded', (await noOverflow(narrow.page)).ok);
  await narrow.ctx.close();

  // ---- All projects (revision): a two-project fixture, no project chosen --
  // Build 1550 annotation 100: the poll bounced to /projects and the page
  // reported a lost sign-in under a valid session.
  const multi = await startFixture({ secondProject: true, slowMs: 9000 });
  try {
    const multiLogin = async page => {
      await page.goto(`${multi.url}/login`);
      await page.fill('input[name="name"]', multi.name);
      await page.fill('input[name="token"]', multi.password);
      await submit(page, 'button[type="submit"]');
    };
    const multiCtx = await browser.newContext({ viewport: VIEWPORTS.desktop, deviceScaleFactor: 1 });
    page = await multiCtx.newPage();
    await multiLogin(page);
    await page.goto(`${multi.url}/chat`);
    const allProjects = await page.evaluate(() => ({ chosen: document.cookie, scope: document.querySelector('[data-project-scope]')?.getAttribute('data-project-scope') ?? null, mint: document.querySelector('form[action="/chat/mate/mint"]') !== null, opener: location.pathname }));
    await page.fill('form[action="/chat/mate/mint"] input[name="token"]', multi.password);
    await submit(page, 'form[action="/chat/mate/mint"] button[type="submit"]');
    await page.waitForFunction(() => ['Connected.', 'Sign in again to reconnect. Your draft stays in this tab.'].includes(document.getElementById('chat-connection')?.textContent ?? ''), null, { timeout: 15000 });
    const allPoll = await page.evaluate(async () => {
      const r = await fetch('/chat/mate/status?version=x', { cache: 'no-store', credentials: 'same-origin', redirect: 'manual' });
      return { status: r.status, type: r.type, contentType: r.headers.get('content-type'), body: r.status === 200 ? await r.json() : null, words: document.getElementById('chat-connection').textContent, reconnect: !document.getElementById('chat-reconnect').hidden, disabled: document.querySelector('.composer button[type="submit"]').disabled };
    });
    check('c6 All projects (two admitted projects, none chosen): the status poll answers JSON with the live session, the page says Connected, and sending is enabled — no false sign-in warning', allProjects.opener === '/chat' && allProjects.mint && allPoll.status === 200 && /json/.test(allPoll.contentType ?? '') && typeof allPoll.body?.session === 'number' && allPoll.body?.task === '' && allPoll.words === 'Connected.' && !allPoll.reconnect && !allPoll.disabled, JSON.stringify({ allProjects, allPoll }));
    // A task lens in EACH project, still without choosing one: the poll
    // and the fragment answer for that task; a task the ceiling does not
    // admit, or an unknown id, is unavailable — never a redirect.
    const lensResults = [];
    for (const id of [multi.tasks.long, multi.statusTasks.published]) {
      await page.goto(`${multi.url}/chat?task=${id}`);
      await page.waitForFunction(() => document.getElementById('chat-connection')?.textContent === 'Connected.', null, { timeout: 15000 }).catch(() => undefined);
      lensResults.push(await page.evaluate(async task => {
        const r = await fetch(`/chat/mate/status?task=${task}&version=x`, { cache: 'no-store', credentials: 'same-origin', redirect: 'manual' });
        const f = await fetch(`/chat/task-status?task=${task}`, { cache: 'no-store', credentials: 'same-origin', redirect: 'manual' });
        const body = r.status === 200 ? await r.json() : null;
        return { task, lens: document.querySelector('.composer')?.getAttribute('data-chat-task'), live: document.getElementById('task-chat-live')?.getAttribute('data-task'), words: document.getElementById('chat-connection').textContent, poll: { status: r.status, task: body?.task, hasLive: typeof body?.fragments?.live === 'string' && body.fragments.live.includes('id="task-chat-live"') }, fragment: { status: f.status, hasRegion: (await f.text()).includes(`data-task="${task}"`) } };
      }, id));
    }
    const deniedLens = await page.evaluate(async () => {
      const r = await fetch('/chat/mate/status?task=not-a-task&version=x', { cache: 'no-store', credentials: 'same-origin', redirect: 'manual' });
      const f = await fetch('/chat/task-status?task=not-a-task', { cache: 'no-store', credentials: 'same-origin', redirect: 'manual' });
      return { status: r.status, body: r.status === 200 ? await r.json() : null, fragmentStatus: f.status };
    });
    check('c6/c4 All projects: a task lens in either admitted project polls and refreshes for ITS task, and an unavailable task answers unavailable (JSON), never a redirect', lensResults.every(one => one.lens === one.task && one.live === one.task && one.words === 'Connected.' && one.poll.status === 200 && one.poll.task === one.task && one.poll.hasLive && one.fragment.status === 200 && one.fragment.hasRegion) && deniedLens.status === 200 && deniedLens.body?.unavailable === true && deniedLens.fragmentStatus === 404, JSON.stringify({ lensResults, deniedLens }));
    await page.goto(`${multi.url}/chat?task=${multi.tasks.long}`);
    await scrollTo(page, '#task-chat-action');
    await shot(page, 'desktop-all-projects-task-focus', 'Desktop 1440×900: All projects (none chosen) on a two-project fixture — the task focus polls and says Connected (fixture)');
    // Sending from All projects dispatches once and clears on the receipt.
    const multiTurns = () => multi.store.recentLeadTurns(multi.name, 50).length;
    const turnsAll = multiTurns();
    await page.goto(`${multi.url}/chat`);
    await page.fill('.composer textarea', 'Brief me.');
    await page.click('.composer button[type="submit"]');
    await page.waitForFunction(() => document.querySelector('.composer textarea').value === '', null, { timeout: 15000 });
    await page.waitForFunction(() => document.querySelector('.chat-thinking') === null && document.querySelectorAll('.msg').length >= 2, null, { timeout: 20000 });
    check('c3 All projects: a send dispatches once and settles on its receipt', multiTurns() === turnsAll + 1 && (await page.evaluate(() => document.querySelectorAll('.msg').length)) >= 2, `turns ${turnsAll} → ${multiTurns()}`);
    await multiCtx.close();
    // The concise card with the LONG scope at 390 and 320 (revision): the
    // outcome is bounded, the counts are one line, Review plan is one
    // unbroken button of comfortable height, and the card stays compact.
    for (const [name, viewport, maxCard] of [['phone', VIEWPORTS.phone, 360], ['narrow', VIEWPORTS.narrow, 400]]) {
      const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
      const p = await ctx.newPage();
      await multiLogin(p);
      await p.goto(`${multi.url}/chat?task=${multi.tasks.long}`);
      await scrollTo(p, '#task-chat-action', 72);
      const card = await p.evaluate(() => {
        const card = document.querySelector('#task-chat-action').getBoundingClientRect();
        const button = document.querySelector('.chat-plan details.chat-approval > summary .button-link').getBoundingClientRect();
        const head = document.querySelector('.chat-plan .chat-plan-head h2').textContent;
        const outcome = document.querySelector('.chat-plan .chat-plan-outcome').textContent;
        const facts = document.querySelector('.chat-plan .chat-plan-facts').textContent;
        const summary = document.querySelector('.chat-plan details.chat-approval > summary').textContent.trim();
        const fullGoal = document.querySelector('.chat-plan form.approve-form .approval-goal')?.textContent ?? '';
        return { card: { top: card.top, height: card.height, right: card.right }, button: { height: button.height, width: button.width, right: button.right, top: button.top, bottom: button.bottom }, head, outcomeLength: outcome.length, facts, summary, fullGoalLength: fullGoal.length };
      });
      check(`c7 ${name} ${viewport.width}px with the long scope: Plan ready, a bounded outcome, one facts line, a single-line 44px Review plan, a compact card (≤ ${maxCard}px) inside the viewport, the full goal kept behind the disclosure, no overflow`, card.head === 'Plan ready' && card.outcomeLength <= 201 && /^\d+ paths · \d+ checks/.test(card.facts) && card.summary === 'Approve plan' && card.button.height >= 44 && card.button.height <= 48 && card.button.width < viewport.width / 2 && card.button.right <= viewport.width && card.button.top >= 0 && card.button.bottom <= viewport.height && card.card.height <= maxCard && card.card.right <= viewport.width && card.fullGoalLength > 700 && (await noOverflow(p)).ok, JSON.stringify(card));
      await shot(p, `${name}-concise-plan-long-scope`, `${name === 'phone' ? 'Phone 390×844' : 'Narrow 320×740'}: the revised concise plan on the long ledger-export scope — Plan ready, outcome, counts, one Review plan (fixture)`);
      await ctx.close();
    }
  } finally {
    await multi.stop();
  }
} finally {
  await browser.close();
  await fixture.stop();
}

writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
const failed = report.checks.filter(one => !one.ok);
console.log(`\n${report.checks.length - failed.length}/${report.checks.length} checks passed · ${report.screenshots.length} screenshots`);
if (strict && failed.length > 0) process.exit(1);
