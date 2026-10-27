/** Agents Live grid proof (2026-10-27; derived from agents-board-proof.mjs). An isolated candidate server — one
 * in-memory database, throwaway project folders, an ephemeral approver, no
 * worker, key or model call — seeded with SYNTHETIC agents in every board
 * state (labelled so in the report): a question, working, stuck, finished
 * and not yet viewed, failed, and idle. One desktop journey (1440×900) and
 * one phone journey (390×844) drive the built console in headless Chromium:
 *
 *   - the empty board, then agents appearing and moving between groups over
 *     /live with no navigation (the same page instance throughout);
 *   - an agent fixing its handoff (a repair run), one checking its result and
 *     one running a long command, each still Working with its own line, and
 *     the repairing agent's view keeping its own build's transcript;
 *   - an opened agent's question, long transcript, changes and composer;
 *     Reply, and the opened Done agent's result (feedback and revision live
 *     on the result page, which the board links to);
 *   - on a phone: the list, the full-screen agent view with the composer at
 *     the bottom, every interactive target measured at 44px or more, and no
 *     sideways overflow.
 *
 *   npm run build && node scripts/agents-board-proof.mjs [--out evidence/agents-live]
 *
 * Playwright is not a dependency: it loads from `playwright`, PLAYWRIGHT_MODULE
 * or the npx cache, as the other proof scripts do. Any failed check exits 1. */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openStore } from '../dist/store.js';
import { addApprover, approve } from '../dist/scope.js';
import { fileTaskProposal } from '../dist/proposal.js';
import { legOf, routeDigestOf } from '../dist/phase-routing.js';
import { budgetedStatJson, storeEvidence } from '../dist/evidence.js';
import { createDecisionServer } from '../dist/serve.js';
import { register } from '../dist/runner.js';
import { acquire } from '../dist/claim.js';
import { openLiveLog } from '../dist/live.js';
import { attemptKeyOf, ingestStatus, markAgentSeen, markStuck, noteDiff, noteOpenTool, noteTranscript, recordAgentTurn } from '../dist/agent-board.js';

const args = process.argv.slice(2);
const flag = name => { const at = args.indexOf(name); return at === -1 ? null : args[at + 1] ?? null; };
const out = resolve(flag('--out') ?? 'evidence/agents-live');
mkdirSync(out, { recursive: true });

async function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_MODULE].filter(Boolean);
  const npx = join(homedir(), '.npm', '_npx');
  if (existsSync(npx)) for (const dir of readdirSync(npx)) candidates.push(join(npx, dir, 'node_modules', 'playwright', 'index.mjs'));
  candidates.push('playwright');
  // The first copy whose browser is downloaded.
  for (const one of candidates) {
    if (one !== 'playwright' && !existsSync(one)) continue;
    const loaded = await import(one === 'playwright' ? one : pathToFileURL(one).href).catch(() => null);
    if (loaded?.chromium !== undefined && existsSync(loaded.chromium.executablePath())) return loaded;
  }
  throw new Error('playwright not found: install it, or set PLAYWRIGHT_MODULE to its index.mjs');
}

const report = { generatedAt: new Date().toISOString(), synthetic: 'Every agent, task and transcript here is a labelled synthetic fixture; no model ran.', checks: [], screenshots: [] };
const check = (name, ok, detail) => { report.checks.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

// ---- the fixture -------------------------------------------------------------

const root = realpathSync(mkdtempSync(join(tmpdir(), 'so-agents-proof-')));
const shop = join(root, 'shop-web'), payments = join(root, 'payments-api');
for (const dir of [shop, payments]) mkdirSync(join(dir, 'src'), { recursive: true });
const evidenceRoot = join(root, 'evidence');
mkdirSync(evidenceRoot, { recursive: true });
const store = openStore(':memory:');
const now = () => new Date();
const ago = minutes => new Date(Date.now() - minutes * 60_000);
const login = addApprover(store, 'alex', now());
if (!login.ok) throw new Error('fixture login failed');
for (const phase of ['plan', 'build', 'review']) store.setPhaseConfig('installation', phase, 'claude', 'sonnet', 'fixture', now());
register(store, { name: 'mac-studio', host: 'fixture-host', capacity: 6, repos: [shop, payments], now: now(), newToken: () => 'fixture-runner-token' });

/** File, approve, claim and start one task's build, as the worker would. */
function startAgent(id, title, repo, startedMinutesAgo) {
  const filed = fileTaskProposal(store, { id, title, repo, goal: `${title}. (Synthetic fixture task.)`, outOfScope: 'No schema changes.',
    touches: ['src/'], acceptance: [{ id: 'c1', statement: 'The change is covered by a test.', how: null, evidence: ['check'] }], filedVia: 'console', planning: 'skip' }, ago(startedMinutesAgo + 5));
  if (!filed.ok) throw new Error(`fixture ${id}: ${filed.reason}`);
  approve(store, id, 'alex', ago(startedMinutesAgo + 2), store.getScope(id).digest, login.token);
  const route = store.approvedRouteOf(id);
  const ref = store.refFor('built-in', id).id;
  const claim = acquire(store, ref, 'mac-studio', { token: 'fixture-runner-token', now: now(), ttlMs: 6 * 3_600_000 });
  if (!claim.ok) throw new Error(`fixture claim ${id}: ${claim.reason}`);
  const run = store.startRun({ taskRef: ref, leaseId: claim.claim.leaseId, runner: 'mac-studio', branch: `toolroll/${id}`, worktree: join(repo, `.wt-${id}`),
    now: ago(startedMinutesAgo), provider: 'claude', model: 'sonnet',
    route: { routeDigest: routeDigestOf(route), phase: 'build', provider: legOf(route, 'build').provider, model: legOf(route, 'build').model, chosen: legOf(route, 'build').chosen } });
  // A real build opens its steering mailbox as its agent starts (builder.ts): the board's composer reads that.
  store.markSteerFolderOpened(run, now());
  store.setRunPhase(run, 'agent-running');
  store.setTaskState(id, 'running', ago(startedMinutesAgo));
  return { id, ref, run, key: attemptKeyOf(store, run), lease: claim.claim.leaseId, route, worktree: join(repo, `.wt-${id}`) };
}
const say = (log, text) => log?.observe({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const tool = (log, name) => log?.observe({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `tu-${Math.random()}`, name, input: {} }] } });
let offsets = 0;
const RENAME_PATCH = `diff --git a/src/settings/nav.ts b/src/settings/nav.ts
--- a/src/settings/nav.ts
+++ b/src/settings/nav.ts
@@ -3,4 +3,4 @@ export const SETTINGS_NAV = [
   { label: 'Profile', href: '/settings/profile' },
-  { label: 'Billing', href: '/settings/billing' },
+  { label: 'Plans and payment', href: '/settings/plans' },
   { label: 'Team', href: '/settings/team' },
`;


/** A Claude stream event for the live log: the run's own words and calls, or a subagent's (parentId set). */
const ev = (content, parentId = null) => ({ type: 'assistant', parent_tool_use_id: parentId, message: { content } });
const text = (t, parentId) => ev([{ type: 'text', text: t }], parentId);
const call = (id, name, input, parentId) => ev([{ type: 'tool_use', id, name, input }], parentId);
const result = (id, content, parentId = null) => ({ type: 'user', parent_tool_use_id: parentId, message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } });

const quietLog = { log: null };
function seed() {
  // A build with two subagents: one still working, one just done.
  const lead = startAgent('checkout-tests', 'Make the checkout tests pass on Safari', shop, 14);
  // Its events spread over its fourteen minutes, as a real run's would be.
  // (Its recorders read the clock about thirty times; the helper that finished ends a few seconds before the screenshot,
  // so it still shows Done.)
  let at = ago(5).getTime();
  const log = openLiveLog(evidenceRoot, lead.run, { base: lead.worktree, commands: true, clock: () => new Date(Math.min(at += 9_000, Date.now() - 5_000)) });
  log.observe({ type: 'system', subtype: 'init' });
  log.observe(text('Splitting this in two: one helper reproduces the Safari failure, one reviews the date parsing.'));
  log.observe(ev([{ type: 'tool_use', id: 'task-a', name: 'Task', input: { description: 'Reproduce the Safari date failure' } }, { type: 'tool_use', id: 'task-b', name: 'Task', input: { description: 'Review the date parsing helpers' } }]));
  log.observe(text('Reading the failing test output first.', 'task-a'));
  log.observe(call('a1', 'Read', { file_path: join(lead.worktree, 'src/checkout/date.test.ts') }, 'task-a'));
  log.observe(result('a1', 'ok', 'task-a'));
  log.observe(call('a2', 'Bash', { command: 'npx playwright test checkout --project=webkit' }, 'task-a'));
  log.observe(text('Looking at parseDeliveryDate and its callers.', 'task-b'));
  log.observe(call('b1', 'Grep', { pattern: 'parseDeliveryDate' }, 'task-b'));
  log.observe(result('b1', 'src/checkout/date.ts\nsrc/checkout/summary.tsx', 'task-b'));
  log.observe(text('Found it: new Date("2026-10-27 09:00") is invalid in Safari. ISO with a T works everywhere.', 'task-b'));
  log.observe({ type: 'result', subtype: 'success', is_error: false, parent_tool_use_id: 'task-b' });
  log.observe(result('task-b', 'Use an ISO string with a T separator.'));
  log.observe(text('Helper confirmed the cause. Waiting for the repro before changing the parser.'));
  recordAgentTurn(store, { run: lead.run, attemptKey: lead.key, state: 'busy', at: ago(14) });
  store.recordRunActivity(lead.run, 'delegate', ago(0.2));
  // Kept open: the run is still going.
  quietLog.lead = log;

  // A quiet one: busy, nothing new for a while (the board's Stuck mark): it needs you.
  const quiet = startAgent('ledger-csv', 'Add a CSV export to the ledger with per-currency subtotals', payments, 31);
  const qlog = openLiveLog(evidenceRoot, quiet.run, { base: quiet.worktree, commands: true });
  qlog.observe({ type: 'system', subtype: 'init' });
  qlog.observe(text('Writing the streaming CSV writer.'));
  qlog.observe(call('q1', 'Edit', { file_path: join(quiet.worktree, 'src/ledger/csv.ts') }));
  qlog.observe(result('q1', 'ok'));
  qlog.observe(call('q2', 'Bash', { command: 'npm run migrate -- --dry-run' }));
  qlog.close();
  recordAgentTurn(store, { run: quiet.run, attemptKey: quiet.key, state: 'busy', at: ago(30) });
  noteTranscript(store, quiet.run, quiet.key, 4096, ago(9));
  store.recordRunActivity(quiet.run, 'command', ago(9));
  noteOpenTool(store, quiet.run, quiet.key, null, ago(9));
  markStuck(store, quiet.run, quiet.key, now());

  // A plain working one.
  const plain = startAgent('coupon-limits', 'Limit each coupon to one use per customer', payments, 6);
  const plog = openLiveLog(evidenceRoot, plain.run, { base: plain.worktree, commands: true });
  plog.observe({ type: 'system', subtype: 'init' });
  plog.observe(text('Adding a unique index on (coupon_id, customer_id).'));
  plog.observe(call('p1', 'Edit', { file_path: join(plain.worktree, 'src/coupons/schema.sql') }));
  plog.observe(result('p1', 'ok'));
  plog.observe(text('Now the redemption path returns a plain message when a coupon was already used.'));
  plog.close();
  recordAgentTurn(store, { run: plain.run, attemptKey: plain.key, state: 'busy', at: ago(6) });
  store.recordRunActivity(plain.run, 'edit', ago(0.1));
}
seed();

// One terminal the person is driving (a stand-in host: the Live grid only counts them, never reads them).
const terminal = { id: 'a'.repeat(32), owner: 'alex', generation: store.accountOf('alex').generation, repo: shop, program: 'shell', branch: 'toolroll/live-a', worktree: join(root, 'live-a'),
  startedAt: ago(20).toISOString(), endedAt: null, exit: null, endedBy: null, cleanup: null };
const terminalHost = { list: owner => owner === 'alex' ? [terminal] : [], get: id => id === terminal.id ? terminal : null, stop: () => {} };
// The person's own lead, answering in the build's task chat: a stand-in Claude sign-in that writes its reply word by
// word and stays mid-answer (a labelled synthetic reply; no model runs).
store.setChatConfig({ provider: 'claude-subscription', model: 'default', dailyTurns: 50, weeklyCeilingMicrousd: 0, priceInMicrousd: 0, priceOutMicrousd: 0 }, 'alex', now());
const REPLY = "I read the task and its latest run.\n\nThe build is split in two: one helper is reproducing the Safari failure in WebKit, and the other already found the cause. new Date(\"2026-10-27 09:00\") is invalid in Safari; an ISO string with a T works everywhere.\n\nOnce the repro confirms it, the fix is a one-line change in parseDeliveryDate plus a test for the Safari format. ";
let finishReply = () => {};
const subscriptionChatRunner = request => new Promise(resolve_ => {
  let shown = 0;
  const words = REPLY.split(/(?<= )/);
  const timer = setInterval(() => { if (shown < words.length - 6) request.onText?.(words.slice(0, ++shown).join('')); }, 40);
  finishReply = () => { clearInterval(timer); resolve_({ ok: true, answer: { text: REPLY, calls: [], tokensIn: 10, tokensOut: 5, reportedCostMicrousd: null } }); };
});
const server = createDecisionServer({ store, evidenceRoot, repos: [shop, payments], clock: () => new Date(), localRunner: 'mac-studio', terminalHost, subscriptionChatRunner });
await new Promise(resolve_ => server.listen(0, '127.0.0.1', resolve_));
const base = `http://127.0.0.1:${server.address().port}`;
const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
async function context(viewport) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, isMobile: viewport.width < 760, hasTouch: viewport.width < 760 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(`${base}/login`);
  await page.fill('input[name="name"]', 'alex');
  await page.fill('input[name="token"]', login.token);
  await Promise.all([page.waitForNavigation(), page.click('button[type="submit"]')]);
  return { ctx, page, errors };
}
// Start the lead's reply through the console, as the person would: sign in, start the lead, ask in the task's chat.
{
  const signedIn = await fetch(`${base}/login`, { method: 'POST', body: new URLSearchParams({ name: 'alex', token: login.token }), redirect: 'manual' });
  const cookie = (signedIn.headers.get('set-cookie') ?? '').split(';')[0];
  const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(await (await fetch(`${base}/chat`, { headers: { cookie } })).text())?.[1] ?? '';
  const minted = await fetch(`${base}/chat/mate/mint`, { method: 'POST', headers: { cookie, origin: base }, body: new URLSearchParams({ csrf, token: login.token }), redirect: 'manual' });
  check('the lead starts', minted.status === 303, `status ${minted.status}`);
  const asked = await fetch(`${base}/chat`, { method: 'POST', headers: { cookie, origin: base, accept: 'application/json' }, redirect: 'manual',
    body: new URLSearchParams({ csrf, task: 'checkout-tests', message: 'Where does the Safari fix stand?', request: 'c'.repeat(32), 'request-session': String(store.activeLeadSession('alex')?.id) }) });
  check('the lead is asked in the task chat', asked.status === 202, `status ${asked.status}`);
}
const until = async (page, test, ms = 15_000) => { try { await page.waitForFunction(test, null, { timeout: ms }); return true; } catch { return false; } };
for (const [name, viewport] of [['desktop', { width: 1440, height: 900 }], ['tablet', { width: 900, height: 1100 }], ['phone', { width: 390, height: 844 }]]) {
  const { ctx, page, errors } = await context(viewport);
  await page.goto(`${base}/agents?view=live`);
  const ready = await until(page, () => document.querySelectorAll('[data-live-tile]').length >= 3 && document.querySelectorAll('[data-live-child]').length >= 2
    && [...document.querySelectorAll('[data-live-lines]')].some(node => (node.textContent ?? '').includes('Splitting')));
  check(`${name}: three tiles, two subagents, live lines`, ready);
  check(`${name}: the terminals line`, await until(page, () => (document.body.textContent ?? '').includes("1 terminal you're driving"), 5_000));
  check(`${name}: the quiet one reads Needs you`, await page.$$eval('[data-live-state="needs-you"] [data-live-chip]', nodes => nodes.map(node => node.textContent)).then(words => words.includes('Needs you')));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(`${name}: no sideways scroll`, overflow <= 0, `overflow ${overflow}px`);
  check(`${name}: no browser errors`, errors.length === 0, errors.join(' | '));
  const path = join(out, `final-${name}.png`);
  await page.screenshot({ path, fullPage: true });
  report.screenshots.push({ path, caption: `${name} ${viewport.width}×${viewport.height}` });
  // Full screen: open the build with the subagents, as a person would (its title), then Escape back.
  if (name !== 'tablet') {
    await page.click('[data-live-tile] [data-live-open]:text("Make the checkout tests pass on Safari")');
    check(`${name}: full screen opens with its subagents`, await until(page, () => document.querySelectorAll('[role="dialog"] [data-live-child]').length >= 2, 5_000));
    await page.waitForTimeout(400); // past the dialog's fade
    await page.screenshot({ path: join(out, `final-full-${name}.png`), fullPage: false });
    await page.keyboard.press('Escape');
    check(`${name}: Escape returns to the tile`, await until(page, () => document.querySelector('[role="dialog"]') === null && document.activeElement?.hasAttribute('data-live-open'), 5_000));
  }
  // The lead's own reply: its tile on the grid, then full screen.
  if (name !== 'tablet') {
    check(`${name}: the lead's reply is a tile`, await until(page, () => (document.querySelector('[data-live-lead] [data-live-lines]')?.textContent ?? '').includes('helper'), 10_000));
    await page.locator('[data-live-lead]').first().screenshot({ path: join(out, `lead-tile-${name}.png`) });
    await page.click('[data-live-open-lead]');
    check(`${name}: the lead full screen links to its chat and task`, await until(page, () => document.querySelector('[role="dialog"] a[href^="/chat?task="]') !== null && document.querySelector('[role="dialog"] a[href^="/t/"]') !== null, 5_000));
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(out, `lead-full-${name}.png`), fullPage: false });
    await page.keyboard.press('Escape');
    check(`${name}: Escape returns to the lead tile`, await until(page, () => document.querySelector('[role="dialog"]') === null && document.activeElement?.hasAttribute('data-live-open-lead'), 5_000));
  }
  await ctx.close();
}
finishReply();
quietLog.lead?.close();
await browser.close();
server.close();
writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
rmSync(root, { recursive: true, force: true });
if (report.checks.some(one => !one.ok)) process.exit(1);
