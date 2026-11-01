/** Agents board proof (2026-10-11). An isolated candidate server — one
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
 *   npm run build && node scripts/agents-board-proof.mjs [--out evidence/agents-board]
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
const out = resolve(flag('--out') ?? 'evidence/agents-board');
mkdirSync(out, { recursive: true });

async function loadPlaywright() {
  try { return await import('playwright'); } catch { /* not installed here */ }
  const candidates = [process.env.PLAYWRIGHT_MODULE].filter(Boolean);
  const npx = join(homedir(), '.npm', '_npx');
  if (existsSync(npx)) for (const dir of readdirSync(npx)) candidates.push(join(npx, dir, 'node_modules', 'playwright', 'index.mjs'));
  for (const one of candidates) if (existsSync(one)) return import(pathToFileURL(one).href);
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

function seed() {
  // Needs you: a question, with a long transcript.
  const asking = startAgent('login-redesign', 'Redesign the login page so returning customers sign in with one tap', shop, 26);
  // The live conversation: this project shows commands, so steps carry their file or command and a command's output.
  const log = openLiveLog(evidenceRoot, asking.run, { base: asking.worktree, commands: true });
  const call = (name, input, result, isError) => {
    const id = `tu-${Math.random()}`;
    log?.observe({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
    log?.observe({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: result, ...(isError ? { is_error: true } : {}) }] } });
  };
  log?.observe({ type: 'system', subtype: 'init' });
  say(log, 'Reading the current login form and its tests.');
  call('Read', { file_path: join(asking.worktree, 'src/login/LoginForm.tsx') }, '…');
  call('Grep', { pattern: 'SignInWithGoogle' }, 'src/marketing/pricing.tsx\nsrc/marketing/home.tsx');
  for (let step = 1; step <= 28; step++) {
    if (step % 3 === 0) call('Edit', { file_path: join(asking.worktree, `src/login/step-${step}.ts`) }, 'ok');
    say(log, `Step ${step}: ${['checked the session cookie flow', 'moved the remember-me option under the password field', 'updated the snapshot for the one-tap button', 'kept the error text next to the field it is about'][step % 4]}.`);
  }
  call('Bash', { command: 'npm test -- src/login' }, ' FAIL  src/login/LoginForm.test.tsx\n  ● one-tap button › signs in a returning customer\n    expected "Welcome back" but got "Sign in"\n\nTests: 1 failed, 23 passed, 24 total', true);
  say(log, 'One snapshot expected the old heading; updating it.');
  call('Edit', { file_path: join(asking.worktree, 'src/login/LoginForm.test.tsx') }, 'ok');
  call('Bash', { command: 'npm test -- src/login' }, 'Tests: 24 passed, 24 total');
  // A note from the operator, read by this run, sits in the conversation at the time it was sent.
  const steered = store.fileSteerNote(asking.id, 'alex', 'Keep the remember-me option checked by default.', ago(8));
  if (steered.ok) { store.markSteerMailed(steered.id, asking.run, ago(8)); store.ackSteerNote(steered.id, asking.run, ago(7)); }
  say(log, 'The old “Sign in with Google” button is still linked from two marketing pages. Asking before I remove it.');
  // Left open: the phone journey writes more of this conversation while the terminal view is open (follow / pause).
  recordAgentTurn(store, { run: asking.run, attemptKey: asking.key, state: 'busy', at: ago(25) });
  store.recordRunActivity(asking.run, 'edit', ago(1));
  noteDiff(store, asking.run, asking.key, 6, ago(1));
  ingestStatus(store, asking.run, asking.key, { lines: [{ status: 'needs-decision', key: 'google-button', question: 'Keep the old “Sign in with Google” button for the two marketing pages that still link to it, or remove it now?' }], nextOffset: offsets += 200 }, ago(1));

  // Working.
  const working = startAgent('ledger-csv', 'Add a CSV export to the ledger with per-currency subtotals', payments, 12);
  const wlog = openLiveLog(evidenceRoot, working.run);
  wlog?.observe({ type: 'system', subtype: 'init' }); say(wlog, 'Writing the streaming CSV writer.'); tool(wlog, 'Edit'); wlog?.close();
  recordAgentTurn(store, { run: working.run, attemptKey: working.key, state: 'busy', at: ago(12) });
  store.recordRunActivity(working.run, 'edit', ago(0.3));
  noteDiff(store, working.run, working.key, 3, ago(0.5));
  ingestStatus(store, working.run, working.key, { lines: [{ status: 'working', note: 'Writing the streaming CSV writer and its RFC 4180 tests' }], nextOffset: offsets += 200 }, ago(0.2));

  // Stuck: busy, and nothing new for six minutes.
  const stuck = startAgent('search-index', 'Speed up the product search index rebuild', shop, 40);
  const slog = openLiveLog(evidenceRoot, stuck.run);
  slog?.observe({ type: 'system', subtype: 'init' });
  say(slog, 'Profiling the nightly rebuild: most of the time goes to re-tokenizing unchanged products.');
  for (let shard = 1; shard <= 30; shard++) { tool(slog, 'Bash'); say(slog, `Shard ${shard}: ${shard * 1200} products re-indexed; ${shard % 5 === 0 ? 'cache hit rate 92%, skipping unchanged rows' : 'tokenizer warm'}.`); }
  slog?.close();
  recordAgentTurn(store, { run: stuck.run, attemptKey: stuck.key, state: 'busy', at: ago(30) });
  noteTranscript(store, stuck.run, stuck.key, 4096, ago(6));
  store.recordRunActivity(stuck.run, 'command', ago(6));
  noteDiff(store, stuck.run, stuck.key, 2, ago(6));
  markStuck(store, stuck.run, stuck.key, now());

  // Working, fixing its handoff: the build's turn ended without one, and a protocol repair runs for it.
  const fixing = startAgent('coupon-limits', 'Limit each coupon to one use per customer', payments, 18);
  const flog = openLiveLog(evidenceRoot, fixing.run);
  flog?.observe({ type: 'system', subtype: 'init' });
  say(flog, 'Added a unique index on (coupon_id, customer_id) and a test for the second redemption.');
  tool(flog, 'Edit'); say(flog, 'All coupon tests pass. Writing the summary.'); flog?.close();
  recordAgentTurn(store, { run: fixing.run, attemptKey: fixing.key, state: 'busy', at: ago(18) });
  recordAgentTurn(store, { run: fixing.run, attemptKey: fixing.key, state: 'idle', at: ago(2) });
  store.setRunPhase(fixing.run, 'validating-handoff');
  const leg = legOf(fixing.route, 'repair');
  const repaired = store.admitRepair({ taskRef: fixing.ref, leaseId: fixing.lease, runner: 'mac-studio', branch: `toolroll/${fixing.id}`, worktree: fixing.worktree, provider: leg.provider,
    ...(leg.model === null ? {} : { model: leg.model }), parentRun: fixing.run, now: ago(1),
    route: { routeDigest: routeDigestOf(fixing.route), phase: 'repair', provider: leg.provider, model: leg.model, chosen: leg.chosen } });
  if (!repaired.ok) throw new Error(`fixture repair: ${repaired.problem}`);
  fixing.repair = repaired.runId;

  // Working, checking its result: the turn has its result; the build is capturing its evidence.
  const checking = startAgent('invoice-pdf', 'Put the tax number on invoice PDFs', payments, 9);
  recordAgentTurn(store, { run: checking.run, attemptKey: checking.key, state: 'busy', at: ago(9) });
  recordAgentTurn(store, { run: checking.run, attemptKey: checking.key, state: 'idle', at: ago(0.5) });
  store.setRunPhase(checking.run, 'capturing-evidence');

  // Working, in a long command: silent for six minutes with its test run still open — not Stuck.
  const testing = startAgent('cart-totals', 'Fix rounding in cart totals for three-decimal currencies', shop, 14);
  recordAgentTurn(store, { run: testing.run, attemptKey: testing.key, state: 'busy', at: ago(14) });
  noteOpenTool(store, testing.run, testing.key, { kind: 'command', at: ago(6) }, ago(6));
  store.recordRunActivity(testing.run, 'command', ago(6));

  // Done, not viewed yet: a finished build with its sealed diff stats.
  const done = startAgent('billing-rename', 'Rename the billing settings page to Plans and payment', shop, 70);
  recordAgentTurn(store, { run: done.run, attemptKey: done.key, state: 'busy', at: ago(70) });
  recordAgentTurn(store, { run: done.run, attemptKey: done.key, state: 'idle', at: ago(46) });
  storeEvidence(store, evidenceRoot, done.run, 'diff-stat', 'diff-stat.json', budgetedStatJson({ schema: 1, base: '4b825dc642cb6eb9a060e54bf8d69288fbee4904', head: '9e07b4152aa01c9f3d7700e54bf8d69288fbe777',
    fileCount: 4, additions: 38, deletions: 21, binaryCount: 0, filesTruncated: false,
    files: [{ path: 'src/settings/billing.tsx', additions: 20, deletions: 14 }, { path: 'src/settings/nav.ts', additions: 4, deletions: 4 }, { path: 'src/routes.ts', additions: 2, deletions: 1 }, { path: 'src/settings/billing.test.tsx', additions: 12, deletions: 2 }] }),
    'parsed from git diff --numstat -z [fixture: synthetic]', ago(45), { captureStatus: 'ok' });
  store.stampRun(done.run, { baseRevision: '4b825dc642cb6eb9a060e54bf8d69288fbee4904', scopeDigest: store.getScope(done.id).digest });
  store.recordOutcomeFacts(done.run, { headRevision: '9e07b4152aa01c9f3d7700e54bf8d69288fbe777' });
  storeEvidence(store, evidenceRoot, done.run, 'terminal-diff', 'terminal-diff.patch', Buffer.from(RENAME_PATCH, 'utf8'), 'git diff --no-ext-diff --no-textconv --no-color 4b825dc6..HEAD (exit 0) [fixture: synthetic]', ago(45), { captureStatus: 'ok' });
  storeEvidence(store, evidenceRoot, done.run, 'handoff', 'handoff.json', Buffer.from(JSON.stringify({ schema: 1, outcome: 'built', committed: true,
    conclusion: 'Renamed Billing to Plans and payment in the settings navigation, page title and route, with a redirect from the old address. (Synthetic fixture.)',
    changes: ['Renamed the settings page and its navigation entry.', 'Redirected /settings/billing to /settings/plans.'], verification: ['Settings tests pass.'], followUps: [], decisionsIncorporated: [] }), 'utf8'),
    'composed at completion [fixture: synthetic]', ago(45));
  store.finishRun(done.run, { outcome: 'built', committed: true, now: ago(45) });
  store.setTaskState(done.id, 'done', ago(45));

  // Failed.
  const failed = startAgent('webhook-retries', 'Retry failed webhook deliveries with backoff', payments, 90);
  recordAgentTurn(store, { run: failed.run, attemptKey: failed.key, state: 'busy', at: ago(90) });
  recordAgentTurn(store, { run: failed.run, attemptKey: failed.key, state: 'crashed', at: ago(61) });
  store.finishRun(failed.run, { outcome: 'failed', reason: 'agent', now: ago(60) });
  store.setTaskState(failed.id, 'failed', ago(60));

  // Idle: finished earlier and already viewed.
  const idle = startAgent('readme-setup', 'Update the README setup steps', payments, 200);
  store.finishRun(idle.run, { outcome: 'no-change', committed: false, now: ago(180) });
  markAgentSeen(store, 'alex', idle.run, ago(170));
  return { asking, working, stuck, done, failed, idle, fixing, checking, testing, askingLog: log };
}

const server = createDecisionServer({ store, evidenceRoot, repos: [shop, payments], clock: () => new Date(), localRunner: 'mac-studio' });
await new Promise(resolve_ => server.listen(0, '127.0.0.1', resolve_));
const base = `http://127.0.0.1:${server.address().port}`;

// ---- the journeys --------------------------------------------------------------

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
async function context(viewport) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: viewport.width < 760, hasTouch: viewport.width < 760 });
  const page = await ctx.newPage();
  await page.goto(`${base}/login`);
  await page.fill('input[name="name"]', 'alex');
  await page.fill('input[name="token"]', login.token);
  await Promise.all([page.waitForNavigation(), page.click('button[type="submit"]')]);
  return { ctx, page };
}
const shot = async (page, name, caption) => {
  const path = join(out, `${name}.png`);
  await page.screenshot({ path, fullPage: false });
  report.screenshots.push({ path: `evidence/agents-board/${name}.png`, caption });
};
const groupsOn = page => page.$$eval('[data-agent-group-section]', nodes => nodes.map(node => node.getAttribute('data-agent-group-section')));
const until = async (page, test, arg = null, ms = 15_000) => { try { await page.waitForFunction(test, arg, { timeout: ms }); return true; } catch { return false; } };

let seeded;
{
  const { ctx, page } = await context({ width: 1440, height: 900 });
  await page.goto(`${base}/agents`);
  await page.waitForSelector('[data-agents-board]');
  check('desktop: the empty board says so in one line', await page.$('[data-agents-empty]') !== null, await page.textContent('[data-agents-empty]'));
  await shot(page, 'desktop-1-empty', 'Desktop 1440px: the empty Agents board (synthetic fixture)');
  // The same page instance from here on: a marker that a reload would erase.
  await page.evaluate(() => { window.__samePage = 'agents-board'; });
  seeded = seed();
  const arrived = await until(page, () => document.querySelectorAll('[data-agent-group-section]').length === 5);
  check('desktop: agents appear grouped Needs you, Working, Stuck, Done, Idle without a reload', arrived && JSON.stringify(await groupsOn(page)) === JSON.stringify(['needs-you', 'working', 'stuck', 'done', 'idle'])
    && await page.evaluate(() => window.__samePage) === 'agents-board', (await groupsOn(page)).join(', '));
  const lineOf = run => page.$eval(`[data-agent-row="${run}"]`, node => ({ group: node.getAttribute('data-agent-group'), line: node.querySelector('[data-agent-line]')?.textContent ?? null,
    time: node.querySelector('[data-agent-time]')?.textContent ?? null, text: node.textContent })).catch(() => null);
  const fixingRow = await lineOf(seeded.fixing.run), checkingRow = await lineOf(seeded.checking.run), testingRow = await lineOf(seeded.testing.run);
  check('desktop: a build fixing its handoff keeps its own row, Working, saying so', fixingRow?.group === 'working' && fixingRow.line === 'Fixing the handoff'
    && await page.$(`[data-agent-row="${seeded.fixing.repair}"]`) === null, JSON.stringify(fixingRow));
  check('desktop: a build checking its result stays Working with that line', checkingRow?.group === 'working' && checkingRow.line === 'Checking the result', JSON.stringify(checkingRow));
  check('desktop: a long command stays Working with what it runs, not Stuck', testingRow?.group === 'working' && /^Running a command · 6 min$/.test(testingRow.line ?? ''), JSON.stringify(testingRow));
  const failedRow = await lineOf(seeded.failed.run), doneRow0 = await lineOf(seeded.done.run);
  check('desktop: a failed row says Failed once (no "The agent failed.")', failedRow !== null && !/The agent failed/.test(failedRow.text) && (failedRow.text.match(/Failed/g) ?? []).length === 1, failedRow?.text);
  check('desktop: a finished row labels its run and finish times, with no unknown-diff dash', /^Ran 30 min · finished 1 h ago$/.test((await lineOf(seeded.failed.run))?.time ?? '') && /^Ran 25 min · finished 45 min ago$/.test(doneRow0?.time ?? '')
    && !(await page.textContent('[data-agents-board]')).includes('—'), `${failedRow?.time} / ${doneRow0?.time}`);
  await shot(page, 'desktop-2-board', 'Desktop 1440px: agents grouped Needs you, Working, Stuck, Done, Idle, updated over /live with no reload (synthetic)');

  // Open the agent with a question.
  await Promise.all([page.waitForNavigation(), page.click(`[data-agent-row="${seeded.asking.run}"] a`)]);
  await page.waitForSelector('[data-agent-detail]');
  await until(page, () => (document.querySelector('[data-agent-transcript]')?.textContent ?? '').includes('Asking before I remove it'));
  check('desktop: the conversation shows steps with their file or command, a failed command with its output, and the note it read', await page.$('[data-step-status="failed"] ') !== null
    && (await page.textContent('[data-agent-transcript]') ?? '').includes('npm test -- src/login') && (await page.textContent('[data-agent-transcript]') ?? '').includes('src/login/LoginForm.tsx')
    && await page.$('[data-conversation-note]') !== null && (await page.textContent('[data-conversation-note] [data-note-standing]') ?? '').startsWith('Picked up at'));
  {
    // Open the failed command's output, then put the conversation back as it was.
    const failed = await page.$('[data-step-status="failed"]');
    const toggle = await failed?.evaluateHandle(node => node.closest('[data-step]')?.querySelector('[data-step-toggle]'));
    await toggle?.asElement()?.click();
    await page.waitForSelector('[data-step-output]:not([hidden])');
    await page.evaluate(() => document.querySelector('[data-step-output]:not([hidden])')?.scrollIntoView({ block: 'center' }));
    check('desktop: a failed command opens to its output', ((await page.textContent('[data-step-output]:not([hidden])')) ?? '').includes('1 failed, 23 passed'));
    await shot(page, 'desktop-3b-conversation-output', 'Desktop 1440px: the conversation with a failed command opened to its output, and the note the agent read (synthetic)');
    await toggle?.asElement()?.click();
    await page.evaluate(() => { const pane = document.querySelector('[data-agent-transcript]'); if (pane) pane.scrollTop = 0; });
    await shot(page, 'desktop-3c-conversation-note', 'Desktop 1440px: the start of the conversation — the note the operator sent, read by the agent, among its steps (synthetic)');
    await page.evaluate(() => { const pane = document.querySelector('[data-agent-transcript]'); if (pane) pane.scrollTop = pane.scrollHeight; });
  }
  check('desktop: the opened agent shows its question, transcript, changes and Reply', await page.$('[data-agent-question="google-button"]') !== null
    && (await page.textContent('[data-agent-transcript]') ?? '').includes('Step 28') && await page.$('[data-agent-changes]') !== null && await page.$('[data-agent-composer="reply"]') !== null);
  await page.evaluate(() => { window.__samePage = 'agent-view'; });
  const before = await page.$$eval('[data-agent-group="working"]', nodes => nodes.length);

  // A live transition while the agent view stays open: the working agent finishes; another goes Stuck.
  store.finishRun(seeded.working.run, { outcome: 'built', committed: true, now: now() });
  await until(page, run => document.querySelector(`[data-agent-row="${run}"]`)?.getAttribute('data-agent-group') === 'done', seeded.working.run);
  const movedNow = await page.$eval(`[data-agent-row="${seeded.working.run}"]`, node => node.getAttribute('data-agent-group')).catch(() => null);
  check('desktop: a finished agent moves Working → Done in place, with the opened agent kept and no reload',
    movedNow === 'done' && await page.evaluate(() => window.__samePage) === 'agent-view' && await page.$(`[data-agent-detail="${seeded.asking.run}"]`) !== null,
    `working rows before ${before}; the agent's row now in ${movedNow}`);
  await shot(page, 'desktop-3-agent-live', 'Desktop 1440px: the opened agent (question, long transcript, Reply) while the board updates beside it (synthetic)');
  // The terminal view of the same records (cockpit §5): dense lines, the failed command's output tail, then back.
  await page.click('[data-conversation-view] button:has-text("Terminal")');
  await page.waitForSelector('[data-terminal]');
  await page.waitForTimeout(400);
  check('desktop: the terminal view shows the same records as dense lines, a failed command with its output tail', (await page.textContent('[data-terminal]') ?? '').includes('$ npm test')
    && (await page.evaluate(() => [...document.querySelectorAll('[data-terminal-step="command"]')].find(node => node.textContent?.includes('[failed]'))?.querySelector('[data-terminal-output]')?.textContent ?? '')).includes('Tests: 1 failed, 23 passed, 24 total')
    && await page.getAttribute('[data-conversation-view] button:has-text("Terminal")', 'aria-pressed') === 'true');
  await shot(page, 'desktop-3t-terminal', 'Desktop 1440px: the same agent in the terminal view (synthetic)');
  await page.click('[data-conversation-view] button:has-text("Conversation")');

  // Reply.
  await page.fill('#agent-composer', 'Keep it until the marketing pages link to the new button, then remove it.');
  await Promise.all([page.waitForNavigation(), page.click('[data-agent-composer="reply"] button[type="submit"]')]);
  await page.waitForSelector('[data-agent-said]');
  // The operator's earlier steering note is seeded too; the reply is the one new note.
  const notes = store.listSteerNotes(seeded.asking.ref).map(one => one.note).filter(note => !note.startsWith('Keep the remember-me'));
  check('desktop: Reply files the answer for the running agent and closes the question', notes.length === 1 && notes[0].startsWith('Reply to your question "google-button"')
    && await page.$('[data-agent-question]') === null && await page.$('[data-agent-composer="steer"]') !== null, notes[0]);
  await shot(page, 'desktop-4-replied', 'Desktop 1440px: after Reply — sent, the question closed, the composer back to a steering note (synthetic)');

  // The repairing agent opens on its own build, with that build's transcript.
  await page.goto(`${base}/agents?run=${seeded.fixing.repair}`);
  await page.waitForSelector('[data-agent-detail]');
  await until(page, () => (document.querySelector('[data-agent-transcript]')?.textContent ?? '').includes('Writing the summary'));
  check('desktop: opening a repair opens its build, Fixing the handoff, with the build’s own transcript', await page.$(`[data-agent-detail="${seeded.fixing.run}"]`) !== null
    && (await page.textContent('[data-agent-detail] [data-agent-line]')) === 'Fixing the handoff' && (await page.textContent('[data-agent-transcript]') ?? '').includes('Writing the summary'));
  await shot(page, 'desktop-4b-fixing', 'Desktop 1440px: a build fixing its handoff — still its own row and transcript, Working (synthetic)');

  // Failed, then Done → its result, where feedback and a revision are asked for.
  await page.goto(`${base}/agents?run=${seeded.failed.run}`);
  await page.waitForSelector('[data-agent-detail]');
  check('desktop: a failed agent says what went wrong', (await page.textContent('[data-agent-detail]') ?? '').includes('Failed'));
  await page.goto(`${base}/agents?run=${seeded.done.run}`);
  await page.waitForSelector('[data-agent-detail]');
  const doneRow = await page.$eval(`[data-agent-row="${seeded.done.run}"]`, node => node.getAttribute('data-agent-group'));
  check('desktop: opening a Done agent marks it viewed (it moves to Idle) and lists its saved changes', doneRow === 'idle'
    && (await page.textContent('[data-agent-detail]') ?? '').includes('+38 −21 · 4 files'), `row now in ${doneRow}`);
  await page.click('[data-agent-changes] button');
  await shot(page, 'desktop-5-done-changes', 'Desktop 1440px: a finished agent opened — viewed, its saved changes listed, Result one tap away (synthetic)');
  const resultHref = await page.getAttribute('[data-agent-detail] header a[href^="/r/"]', 'href');
  await Promise.all([page.waitForNavigation(), page.click('[data-agent-detail] header a[href^="/r/"]')]);
  await page.waitForLoadState('load');
  await page.waitForTimeout(400);
  check('desktop: a finished agent opens its result page, where feedback and revision live', page.url().includes(`/review?result=billing-rename&run=${seeded.done.run}`), `${resultHref} → ${page.url().replace(base, '')}`);
  await shot(page, 'desktop-6-result', 'Desktop 1440px: the Done agent’s result page, where feedback and a revision are requested (synthetic)');
  // Feedback, then a revision: the result page's own Request changes (unchanged by the board).
  await page.locator('a[href="#request-changes"], button:has-text("Request changes")').first().click();
  const box = page.locator('#comment-form textarea[name="note"]');
  await box.waitFor({ timeout: 10_000 });
  await box.fill('Keep the old /settings/billing address working for the emails already sent.');
  await shot(page, 'desktop-7-feedback', 'Desktop 1440px: feedback on the Done agent’s result before Request changes (synthetic)');
  await Promise.all([page.waitForNavigation(), page.locator('#comment-form button[data-request-changes]').click()]);
  const revision = store.handle.prepare("SELECT external_id FROM task_ref WHERE revision_of = 'billing-rename' ORDER BY id DESC LIMIT 1").get();
  check('desktop: feedback on the Done agent’s result creates a revision', revision !== undefined, revision === undefined ? page.url().replace(base, '') : `revision ${revision.external_id}`);
  await ctx.close();
}

{
  const { ctx, page } = await context({ width: 390, height: 844 });
  await page.goto(`${base}/agents`);
  await page.waitForSelector('[data-agent-group-section]');
  const overflow = await page.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth);
  check('phone: the board is a list with no sideways overflow', overflow <= 0, `overflow ${overflow}px`);
  // A target's touch area: its box, or the larger area its ::after hit-area extends to (the timeline bars do this on a
  // phone: a 20px bar with 12px above and below to touch).
  const small = await page.$$eval('[data-agents-board] a, [data-agents-board] button', nodes => nodes.map(node => {
    const box = node.getBoundingClientRect();
    const after = getComputedStyle(node, '::after');
    const reach = after.content !== 'none' && after.position === 'absolute' ? Math.max(box.height, box.height - parseFloat(after.top || '0') - parseFloat(after.bottom || '0')) : box.height;
    return { node, width: box.width, reach };
  }).filter(one => one.width > 0 && one.reach < 44).map(one => `${one.node.textContent?.trim().slice(0, 30)} ${Math.round(one.reach)}px`));
  check('phone: every row is a 44px target', small.length === 0, small.join('; ') || 'all ≥ 44px');
  await shot(page, 'phone-1-board', 'Phone 390px: the Agents board as a list, grouped by state (synthetic)');

  // The full-screen agent view: a new question on the stuck agent arrives, and the person opens it.
  ingestStatus(store, seeded.stuck.run, seeded.stuck.key, { lines: [{ status: 'needs-decision', key: 'reindex-window', question: 'Rebuild the index during business hours (slower for shoppers for ~3 minutes) or wait for tonight’s window?' }], nextOffset: offsets += 200 }, now());
  const arrived = await until(page, run => document.querySelector(`[data-agent-row="${run}"]`)?.getAttribute('data-agent-group') === 'needs-you', seeded.stuck.run);
  check('phone: a new question moves the agent into Needs you without a reload', arrived);
  await Promise.all([page.waitForNavigation(), page.click(`[data-agent-row="${seeded.stuck.run}"] a`)]);
  await page.waitForSelector('[data-agent-detail]');
  await until(page, () => (document.querySelector('[data-agent-transcript]')?.textContent ?? '').includes('Shard 30'));
  const layout = await page.evaluate(() => {
    const detail = document.querySelector('[data-agent-detail]').getBoundingClientRect();
    const composer = document.querySelector('[data-agent-composer]').getBoundingClientRect();
    const transcript = document.querySelector('[data-agent-transcript]')?.getBoundingClientRect() ?? null;
    const targets = [...document.querySelectorAll('[data-agent-detail] a, [data-agent-detail] button, [data-agent-detail] textarea, [data-agent-detail] summary')]
      .filter(node => node.getBoundingClientRect().width > 0)
      .map(node => ({ what: (node.getAttribute('aria-label') ?? node.textContent ?? node.tagName).trim().slice(0, 24), h: Math.round(node.getBoundingClientRect().height), w: Math.round(node.getBoundingClientRect().width) }));
    const scroller = document.querySelector('[data-agent-detail] > div');
    return { detail: { top: detail.top, height: detail.height, width: detail.width }, composerBottom: composer.bottom, composerTop: composer.top, innerHeight: window.innerHeight, innerWidth: window.innerWidth,
      transcriptBottomInScroller: transcript === null ? null : transcript.bottom, scrollerBottom: scroller.getBoundingClientRect().bottom, targets,
      overflow: document.scrollingElement.scrollWidth - window.innerWidth };
  });
  check('phone: the agent view is full-screen', layout.detail.top === 0 && Math.round(layout.detail.height) === layout.innerHeight && Math.round(layout.detail.width) === layout.innerWidth, JSON.stringify(layout.detail));
  check('phone: the opened agent asks its question, with Reply in the composer', await page.$('[data-agent-question="reindex-window"]') !== null && await page.$('[data-agent-composer="reply"]') !== null);
  check('phone: the composer sits at the bottom and nothing scrolls under it', Math.abs(layout.composerBottom - layout.innerHeight) <= 1 && layout.scrollerBottom <= layout.composerTop + 1, `composer ${Math.round(layout.composerTop)}–${Math.round(layout.composerBottom)} of ${layout.innerHeight}`);
  const under = layout.targets.filter(one => one.h < 44 || one.w < 44);
  check('phone: every interactive target in the agent view is at least 44px', under.length === 0, under.map(one => `${one.what} ${one.w}×${one.h}`).join('; ') || layout.targets.map(one => `${one.what} ${one.h}`).join(', '));
  check('phone: no sideways overflow in the agent view', layout.overflow <= 0, `overflow ${layout.overflow}px`);
  await shot(page, 'phone-2-agent', 'Phone 390px: the full-screen agent view — question, long transcript, Reply at the bottom (synthetic)');
  await page.click('[data-agent-changes] button');
  await page.$eval('[data-agent-detail] > div', node => { node.scrollTop = node.scrollHeight; });
  await shot(page, 'phone-3-agent-changes', 'Phone 390px: the same view scrolled to its changes, the composer still at the bottom (synthetic)');

  // The terminal view on a phone (cockpit §5): the long, commands-shown conversation, dense; the failed command's tail;
  // the footer never over it; it follows new lines at the end, holds still when scrolled up, and follows again after.
  await page.goto(`${base}/agents?run=${seeded.asking.run}`);
  await page.waitForSelector('[data-agent-detail]');
  await until(page, () => (document.querySelector('[data-agent-transcript]')?.textContent ?? '').includes('Step 28'));
  await page.click('[data-conversation-view] button:has-text("Terminal")');
  await page.waitForSelector('[data-terminal]');
  await page.waitForTimeout(400);
  const failedTail = await page.evaluate(() => [...document.querySelectorAll('[data-terminal-step="command"]')].find(node => node.textContent?.includes('[failed]'))?.querySelector('[data-terminal-output]')?.textContent ?? '');
  check('phone: the terminal view shows the failed command with its output tail', failedTail.includes('Tests: 1 failed, 23 passed, 24 total'), failedTail.slice(0, 80));
  const scrollerOf = () => page.evaluate(() => {
    const box = document.querySelector('[data-agent-transcript]');
    const node = box.scrollHeight > box.clientHeight + 1 ? box : box.closest('[data-agent-scroll]');
    const footer = document.querySelector('[data-agent-footer]').getBoundingClientRect();
    return { top: node.scrollTop, gap: node.scrollHeight - node.scrollTop - node.clientHeight, scrollerBottom: node.getBoundingClientRect().bottom, footerTop: footer.top, footerBottom: footer.bottom, innerHeight: window.innerHeight };
  });
  const atEnd = await scrollerOf();
  check('phone: in the terminal view the footer sits at the bottom and nothing scrolls under it', Math.abs(atEnd.footerBottom - atEnd.innerHeight) <= 1 && atEnd.scrollerBottom <= atEnd.footerTop + 1, JSON.stringify(atEnd));
  const write = text => { say(seeded.askingLog, text); };
  // At the end: a new line arrives and the view follows it.
  await page.evaluate(() => { const box = document.querySelector('[data-agent-transcript]'); const node = box.scrollHeight > box.clientHeight + 1 ? box : box.closest('[data-agent-scroll]'); node.scrollTop = node.scrollHeight; node.dispatchEvent(new Event('scroll')); });
  write('Following: the first new line.');
  await until(page, () => (document.querySelector('[data-terminal]')?.textContent ?? '').includes('Following: the first new line.'));
  await page.waitForTimeout(300);
  const followed = await scrollerOf();
  // Scrolled up: another line arrives and the view holds still.
  await page.evaluate(() => { const box = document.querySelector('[data-agent-transcript]'); const node = box.scrollHeight > box.clientHeight + 1 ? box : box.closest('[data-agent-scroll]'); node.scrollTop = 0; node.dispatchEvent(new Event('scroll')); });
  write('Held: a line that arrives while scrolled up.');
  await until(page, () => (document.querySelector('[data-terminal]')?.textContent ?? '').includes('Held: a line'));
  await page.waitForTimeout(300);
  const held = await scrollerOf();
  // Back at the end: it follows again.
  await page.evaluate(() => { const box = document.querySelector('[data-agent-transcript]'); const node = box.scrollHeight > box.clientHeight + 1 ? box : box.closest('[data-agent-scroll]'); node.scrollTop = node.scrollHeight; node.dispatchEvent(new Event('scroll')); });
  write('Resumed: following again.');
  await until(page, () => (document.querySelector('[data-terminal]')?.textContent ?? '').includes('Resumed: following again.'));
  await page.waitForTimeout(300);
  const resumed = await scrollerOf();
  check('phone: the terminal view follows new lines at the end, holds still when scrolled up, and follows again', followed.gap <= 2 && held.top === 0 && resumed.gap <= 2,
    `followed gap ${followed.gap}, held top ${held.top}, resumed gap ${resumed.gap}`);
  await shot(page, 'phone-4-terminal', 'Phone 390px: the terminal view of the commands-shown conversation, following its newest line (synthetic)');
  await ctx.close();
}

await browser.close();
server.closeAllConnections?.();
await new Promise(resolve_ => server.close(resolve_));
store.close();
rmSync(root, { recursive: true, force: true });
writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
const failed = report.checks.filter(one => !one.ok);
console.log(`${report.checks.length - failed.length}/${report.checks.length} checks passed; screenshots in ${out}`);
process.exit(failed.length === 0 ? 0 : 1);
