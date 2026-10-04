/** Workspace package 3 browser proof (2026-09-13): result-first review
 * and one revision loop — driven against the isolated synthetic fixture
 * (`scripts/ui-polish-fixture.mjs`: one in-memory database, a throwaway
 * repository, an ephemeral approver, a scripted subscription runner that
 * stands in for the model) in headless Chromium. Nothing here touches a
 * real database, worker, key, model, or worktree, and headless Chromium
 * emulating a phone viewport is NOT physical iPhone Safari. Every
 * screenshot is of synthetic fixture data and is labeled so.
 *
 * What it proves, one section per acceptance criterion:
 *   c1  the chat receipt, the chat's result detail, the run page, and the
 *       review cockpit stamp byte-identical shared facts (run, head, base,
 *       checks, caveats, evidence health, publication) for the same
 *       result; each Summary leads with the deliverable itself.
 *   c2  Summary / Changes / Checks switch in place and by URL (refresh and
 *       Back keep the view); validated screenshots render through the
 *       evidence road; an investigation's report is escaped text with a
 *       download, never markup; a code diff renders with View / Annotate;
 *       a tampered screenshot, a failed change-summary capture, and a
 *       shortened check log are named in the open and never called
 *       validated, and the tampered bytes are refused by the evidence road.
 *   c3  a plain note and a line annotation both land in ONE batch, seal
 *       into ONE revision through the existing road (unapproved, exact
 *       lineage, both links), a replayed note and a replayed seal mint
 *       nothing twice, and the original result stays on record.
 *   c4  the chat draft and the review draft survive opening the result,
 *       Back to chat, refresh, and a refused submission; the selected
 *       result and tab and the reading position survive Back and refresh;
 *       another task and another account on the same tab inherit nothing.
 *   c5  1440×900, 390×844, and 320×740 exact-viewport screenshots of the
 *       result beside chat, the dedicated phone view, the run page, and
 *       the cockpit; no document overflow; tabs, Add note, Create
 *       revision, and Back to chat reachable and inside the viewport.
 *   Repair 2026-09-14 (the five independent findings on run 1552):
 *   c7  a note submitted whose response never arrives keeps its request
 *       identity for an unchanged retry (recorded once) and mints a new
 *       one the moment the note or file is edited; the server refuses the
 *       same identity with different words or on another result, and the
 *       refusal's way back rotates the identity without losing the words.
 *   c8  the revision form seals exactly the note batch it displayed; the
 *       old seal body replayed after a new note returns the original
 *       child and leaves the new note live; a second tab whose batch was
 *       partly sealed elsewhere is refused whole and can reload.
 *   c9  a verified build whose check log was altered on disk reads as
 *       damaged evidence on the task receipt, the chat receipt, the run
 *       page, and the cockpit — problems counted, readiness word gone,
 *       output and download withheld, evidence road refusing — while a
 *       shortened log's download is described as the stored part only.
 *   c10 a sealed revision's line carries the shared projection's own
 *       words: needs approval → (approved) → on hold → (rescoped) needs
 *       approval again — never "building" because it was once approved.
 *   c11 Summary is the deliverable first: one bounded outcome line, one
 *       action, the agent's account and the technical facts behind
 *       closed disclosures, risks in the open, and a 44px Back at 390
 *       and 320.
 *
 *   node scripts/workspace-result-proof.mjs [--out output/playwright/workspace-3-result-2026-09-13] [--strict] [--layout-only] [--long-requests] [--revision-names]
 *
 * Playwright is NOT a dependency of this package: the script imports it
 * from `playwright` when installed, else from PLAYWRIGHT_MODULE, else from
 * the npx cache. With --strict any failed check exits 1. Build first. */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startFixture, LONG_REQUEST_PATH, LONG_FEEDBACK_PATH, LONG_REVIEW_PATH, LONG_REVIEW_HASH } from './ui-polish-fixture.mjs';
import { addApprover, approve, propose } from '../dist/scope.js';
import { resultFactsFromHtml } from '../dist/result-review.js';

const args = process.argv.slice(2);
const flag = name => { const at = args.indexOf(name); return at === -1 ? null : args[at + 1] ?? null; };
const out = resolve(flag('--out') ?? 'output/playwright/workspace-3-result-2026-09-13');
const strict = args.includes('--strict');
const learning = args.includes('--learning');
const sameTask = args.includes('--same-task-revisions');
const revisionNames = args.includes('--revision-names');
const longRequests = args.includes('--long-requests') || revisionNames;
const layoutOnly = args.includes('--layout-only');
mkdirSync(out, { recursive: true });

async function loadPlaywright() {
  try { return await import('playwright'); } catch { /* not installed here */ }
  const candidates = [process.env.PLAYWRIGHT_MODULE].filter(Boolean);
  const npx = join(homedir(), '.npm', '_npx');
  if (existsSync(npx)) for (const dir of readdirSync(npx)) candidates.push(join(npx, dir, 'node_modules', 'playwright', 'index.mjs'));
  for (const one of candidates) if (existsSync(one)) return import(pathToFileURL(one).href);
  throw new Error('playwright not found: install it, or set PLAYWRIGHT_MODULE to its index.mjs');
}

const VIEWPORTS = { desktop: { width: revisionNames || sameTask || learning ? 1400 : 1440, height: 900 }, phone: { width: 390, height: 844 }, narrow: { width: 320, height: 740 } };
const report = { generatedAt: new Date().toISOString(), out, fixture: 'scripts/ui-polish-fixture.mjs (synthetic, in-memory; scripted subscription runner, no model)', checks: [], screenshots: [] };
const check = (name, ok, detail) => { report.checks.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

const { chromium } = await loadPlaywright();
let fixture = await startFixture({ learning, longRequests, revisionNames, sameTaskRevisions: sameTask, secondProject: sameTask || learning, ...(sameTask || learning ? { directory: join(out, "fixture") } : {}) });
const browser = await chromium.launch(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {});

async function loginAs(page, name, password) {
  await page.goto(`${fixture.url}/login`);
  await page.fill('input[name="name"]', name);
  await page.fill('input[name="token"]', password);
  await submit(page, 'button[type="submit"]');
}
const login = page => loginAs(page, fixture.name, fixture.password);
let latestPage = null;
async function context(viewport, extra = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: viewport.width < 760, hasTouch: viewport.width < 760, ...extra });
  const page = await ctx.newPage();
  latestPage = page;
  await login(page);
  return { ctx, page };
}
const shot = async (page, name, caption) => {
  const path = join(out, `${name}.png`);
  // The shell animates cross-document navigation; a capture during that
  // transition is a blank snapshot, so wait for it to end first.
  await page.waitForFunction(() => { try { return !document.documentElement.matches(':active-view-transition'); } catch { return true; } }, null, { timeout: 5000 }).catch(() => undefined);
  await page.waitForTimeout(150);
  await page.evaluate(() => { document.documentElement.style.scrollBehavior = 'auto'; });
  await page.screenshot({ path, fullPage: false });
  report.screenshots.push({ path, caption });
  return path;
};
/** Click a submit and wait for a NEW document. */
async function submit(page, selector) {
  await page.waitForFunction(() => { try { return !document.documentElement.matches(':active-view-transition'); } catch { return true; } }, null, { timeout: 5000 }).catch(() => undefined);
  await page.evaluate(() => { window.__staleDocument = true; document.documentElement.style.scrollBehavior = 'auto'; });
  await page.click(selector);
  await page.waitForFunction(() => window.__staleDocument === undefined, null, { timeout: 15000 });
  await page.waitForLoadState('load');
  await page.waitForTimeout(200);
}
const goto = async (page, path) => { await page.goto(`${fixture.url}${path}`); await page.waitForLoadState('load'); await page.evaluate(() => { document.documentElement.style.scrollBehavior = 'auto'; }); };
const rect = (page, selector) => page.evaluate(sel => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }; }, selector);
const fits = (r, viewport) => r !== null && r.top >= 0 && r.bottom <= viewport.height && r.left >= 0 && r.right <= viewport.width && r.width > 0 && r.height > 0;
const noOverflow = page => page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, ok: document.documentElement.scrollWidth <= document.documentElement.clientWidth }));
const scrollTo = (page, selector, offset = 72) => page.evaluate(([sel, off]) => { const el = document.querySelector(sel); if (!el) return false; document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - off, behavior: 'instant' }); return true; }, [selector, offset]);
const html = async path => { const r = await fetch(`${fixture.url}${path}`, { headers: { cookie: cookieHeader } }); return r.text(); };
const factsOf = async (path, selectorHint) => {
  const text = await html(path);
  const all = resultFactsFromHtml(text);
  return { all, text, first: all[0] ?? null };
};
const visibleTab = page => page.evaluate(() => [...document.querySelectorAll('[data-result-view]')].find(v => !v.hidden)?.getAttribute('data-result-view') ?? null);
const revisionIdAt = url => { const u = new URL(url); return u.searchParams.get('revision') ?? u.searchParams.get('version') ?? u.pathname.slice(3); };
const revisionLocationIs = (url, root, child) => { const u = new URL(url); return (u.pathname === '/chat' && u.searchParams.get('task') === root && u.searchParams.get('revision') === child) || (u.pathname === `/t/${root}` && u.searchParams.get('version') === child); };
const selectedTab = page => page.evaluate(() => document.querySelector('[data-result-tab][aria-selected="true"]')?.getAttribute('data-result-tab') ?? null);
/** Mint a NEW conversation (ending any live one first) so the composer exists. */
async function freshConversation(page, path) {
  await goto(page, path);
  if (await page.$('form[action="/chat/mate/end"]')) {
    await page.evaluate(() => { const d = document.querySelector('.chat-session-details'); if (d) d.open = true; });
    await submit(page, 'form[action="/chat/mate/end"] button[type="submit"]');
  }
  await page.fill('form[action="/chat/mate/mint"] input[name="token"]', fixture.password);
  await submit(page, 'form[action="/chat/mate/mint"] button[type="submit"]');
}
/** Post a form from the page's own session (a replay of an earlier submission). */
async function postFrom(page, path, fields) {
  return page.evaluate(async ([p, f]) => {
    const r = await fetch(p, { method: 'POST', body: new URLSearchParams(f), credentials: 'same-origin', redirect: 'manual' });
    return { status: r.status, type: r.type };
  }, [path, fields]);
}

/** Package 5 pilot 1: the existing fixture and real browser journey,
 * with synthetic pre-policy signed terms. No autonomous model success. */
async function longRequestJourney() {
  const original = fixture.store.getScope(task);
  check('legacy fixture exceeds the new character limit in both fields', original.goal.length > 2000 && original.outOfScope.length > 2000,
    JSON.stringify({ goalChars: original.goal.length, goalBytes: Buffer.byteLength(original.goal), exclusionChars: original.outOfScope.length, exclusionBytes: Buffer.byteLength(original.outOfScope) }));
  check('synthetic signed goal and exclusions include the actual pilot assessment path', original.goal.includes(LONG_REQUEST_PATH) && original.outOfScope.includes(LONG_REQUEST_PATH));
  const inspectScope = async (page, scope, label) => {
    // A completed task can arrive with Scope already open.
    if (!await page.locator('#scope').evaluate(el => el.open)) {
      await page.locator('#scope > summary').focus();
      await page.keyboard.press('Enter');
    }
    // The first two recaps are the goal and exclusions; agent fallbacks
    // can add another recap after them.
    const terms = await page.locator('#scope .recap').evaluateAll((elements, path) => elements.slice(0, 2).map(el => {
      const style = getComputedStyle(el), bounds = el.getBoundingClientRect();
      // Measure the path itself: pre-wrap intentionally hangs trailing
      // whitespace outside line boxes without adding document overflow.
      const start = el.textContent.indexOf(path), range = document.createRange();
      if (start >= 0) { range.setStart(el.firstChild, start); range.setEnd(el.firstChild, start + path.length); }
      return { text: el.textContent, width: el.clientWidth, scrollWidth: el.scrollWidth,
        visible: el.checkVisibility(), unclipped: !['hidden', 'clip'].includes(style.overflowX) && style.textOverflow !== 'ellipsis' && ['none', '0'].includes(style.webkitLineClamp),
        pathFits: start >= 0 && [...range.getClientRects()].every(r => r.left >= bounds.left - 1 && r.right <= bounds.right + 1) };
    }), LONG_REQUEST_PATH);
    const geometry = { document: await noOverflow(page), terms: terms.map(({ text, ...one }) => one) };
    check(`${label}: expanded scope wraps the actual long path without hiding or changing signed text`, terms.length === 2 && terms[0].text === scope.goal && terms[1].text === scope.outOfScope && geometry.document.ok && terms.every(one => one.visible && one.unclipped && one.pathFits && one.scrollWidth <= one.width), JSON.stringify(geometry));
  };
  for (const [name, viewport] of [['desktop', VIEWPORTS.desktop], ['phone', VIEWPORTS.phone]]) {
    const { ctx, page } = await context(viewport, { reducedMotion: 'reduce' });
    await goto(page, `/t/${task}`);
    await inspectScope(page, original, `${name} original`);
    for (const [index, field] of ['goal', 'exclusions'].entries()) {
      await page.locator('#scope .recap').nth(index).evaluate(el => { window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 100, behavior: 'instant' }); });
      await shot(page, `${name}-long-scope-${field}`, `${viewport.width}×${viewport.height}: actual pilot assessment path in signed ${field} (synthetic legacy fixture)`);
    }
    await freshConversation(page, `/chat?task=${task}`);
    const chatDraft = `Unsent ${name}: keep the Unicode terms exactly.`;
    await page.fill('.composer textarea', chatDraft);
    await page.click('.completion-receipt a[data-open-result]');
    await page.waitForLoadState('load');
    check(`${name}: open result keeps chat draft and has no overflow`, (await noOverflow(page)).ok && await page.inputValue('.composer textarea') === chatDraft);
    await shot(page, `${name}-long-result`, `${viewport.width}×${viewport.height}: result opened from chat with an unsent draft (synthetic legacy fixture)`);
    await page.click('[data-result-tab="changes"]');
    check(`${name}: changes show the sealed diff`, await page.locator('.diff-lines').count() > 0 && (await noOverflow(page)).ok);
    await page.click('[data-result-tab="checks"]');
    check(`${name}: checks view opens`, await visibleTab(page) === 'checks');
    // The first batch at each viewport is plain; the later one is annotated.
    for (const mode of (revisionNames ? ['plain', 'annotated', 'mixed'] : ['plain', 'annotated'])) {
      if (mode !== 'plain') {
        await page.click('[data-result-tab="changes"]');
        await page.click('button[data-diff-mode="annotate"]');
        await page.locator('button.pick-line[data-path="src/payout.ts"][data-side="new"]').first().click();
      }
      const note = `${name} ${mode}: Réparer 日本語 😀 e\u0301. ` + 'Keep the footer readable. '.repeat(12).trim();
      await page.fill('#comment-form [name="note"]', note);
      await page.reload({ waitUntil: 'load' });
      check(`${name} ${mode}: reload keeps the entire review draft`, await page.inputValue('#comment-form [name="note"]') === note);
      const form = await page.evaluate(() => Object.fromEntries(new FormData(document.querySelector('#comment-form')).entries()));
      // A lost response leaves the form and draft in place; a real retry
      // of its exact request returns the original note, never a duplicate.
      await postFrom(page, `/r/${runId}/comment`, form);
      await submit(page, '#comment-form button[type="submit"]');
      const batch = fixture.store.liveDiffComments(runId);
      check(`${name} ${mode}: missed-response retry records exactly one note`, batch.length === (mode === 'plain' || (revisionNames && mode === 'annotated') ? 1 : 2) && batch.at(-1).note === note && (mode === 'plain' ? batch.at(-1).path === null : batch.at(-1).path === 'src/payout.ts'));
      const seal = await page.evaluate(() => Object.fromEntries(new FormData(document.querySelector('.result-request form[action$="/revise"]')).entries()));
      await scrollTo(page, '.result-request form[action$="/revise"]', 180);
      const button = await rect(page, '.result-request form[action$="/revise"] button');
      const bar = await rect(page, 'nav.tabbar');
      check(`${name} ${mode}: revision action fits above navigation`, fits(button, viewport) && button.height >= 44 && (viewport.width > 760 || button.bottom <= bar.top) && (await noOverflow(page)).ok);
      if (mode === 'annotated') await shot(page, `${name}-long-feedback`, `${viewport.width}×${viewport.height}: Unicode line feedback ready for a separate revision (synthetic legacy fixture)`);
      const before = fixture.store.revisionsFromRun(runId).length;
      // Miss the seal response too; submitting the same displayed batch must land once.
      await postFrom(page, `/r/${runId}/revise`, seal);
      await submit(page, '.result-request form[action$="/revise"] button[type="submit"]');
      const childId = revisionIdAt(page.url());
      check(`${name}: revision navigation stays rooted`, revisionLocationIs(page.url(), task, childId));
      await goto(page, `/t/${task}?version=${childId}`);
      const child = fixture.store.getScope(childId);
      check(`${name} ${mode}: exactly one unapproved child retains every inherited byte`, fixture.store.revisionsFromRun(runId).length === before + 1 && child !== null && child.approvedAt === null && child.approvedDigest === null && child.goal === `${original.goal} — apply the ${batch.every(one => one.path !== null) ? 'annotations' : 'feedback'} recorded on build #${runId}; the revision brief carries the exact batch` && child.outOfScope === original.outOfScope);
      if (revisionNames) {
        const expectedTitle = 'Fix the payout rounding drift — revision';
        const title = await page.locator('h1').textContent();
        const source = fixture.store.revisionSourceOf(fixture.store.lookupRef(childId).id);
        check(`${name} ${mode}: human title, unchanged ID generation and exact source`, title === fixture.store.getTask(task).title && fixture.store.getTask(childId).title === expectedTitle && childId.startsWith(`revise-payout-rounding-from-${batch.length}-annotation`) && source.sourceTask === task && source.sourceRun === runId && (await noOverflow(page)).ok, JSON.stringify({ title, childId, sourceRun: source.sourceRun }));
        const collapsed = await page.evaluate(() => {
          const identity = document.querySelector('.task-identity');
          const options = document.querySelector('#task-diagnostics');
          const rows = [...document.querySelectorAll('.list-pane a.item')];
          return { closed: options?.open === false, identityHidden: identity !== null && !identity.checkVisibility(),
            identityInOptions: identity?.closest('details') === options,
            titleFirst: document.querySelector('main')?.firstElementChild?.classList.contains('task-title-row'),
            titleOnlyLinks: rows.length > 0 && rows.every(row => row.textContent === row.querySelector('.t')?.textContent),
            selectedHref: document.querySelector('.list-pane a.item.current')?.getAttribute('href'),
            selectedTitle: document.querySelector('.list-pane a.item.current')?.textContent };
        });
        check(`${name} ${mode}: title leads with identity collapsed and title-only task navigation`, collapsed.closed && collapsed.identityHidden && collapsed.identityInOptions && collapsed.titleFirst && collapsed.titleOnlyLinks && collapsed.selectedHref === `/t/${task}` && collapsed.selectedTitle === fixture.store.getTask(task).title, JSON.stringify(collapsed));
        await page.locator('h1').scrollIntoViewIfNeeded();
        if (mode === 'mixed') await shot(page, `${name}-named-revision`, `${viewport.width}×${viewport.height}: human title leads; Task options closed, sidebar names only, fresh approval required (synthetic fixture)`);
        await page.locator('#task-diagnostics > summary').focus();
        await page.keyboard.press('Enter');
        const expanded = await page.locator('.task-identity').evaluate(el => ({ visible: el.checkVisibility(), id: el.querySelector('.mono')?.textContent, width: el.clientWidth, scrollWidth: el.scrollWidth }));
        const summary = await rect(page, '#task-diagnostics > summary');
        check(`${name} ${mode}: keyboard opens exact task identity without overflow`, expanded.visible && expanded.id === childId && expanded.scrollWidth <= expanded.width && summary.height >= 44 && (await noOverflow(page)).ok, JSON.stringify({ ...expanded, summary }));
        check(`${name} ${mode}: source task and build links remain in scope details`, await page.locator(`#scope .revision-card a[href="/t/${task}"]`).count() > 0 && await page.locator(`#scope .revision-card a[href="/r/${runId}"]`).count() > 0);
        if (mode === 'mixed') await shot(page, `${name}-named-revision-details`, `${viewport.width}×${viewport.height}: Task options opened by keyboard exposes the full unchanged task ID (synthetic fixture)`);
        await page.locator('#task-diagnostics > summary').focus();
        await page.keyboard.press('Enter');
        check(`${name} ${mode}: keyboard closes task identity again`, !await page.locator('.task-identity').isVisible());
      }
      await page.locator('.task-plan-review > summary').focus();
      await page.keyboard.press('Enter');
      const terms = await page.evaluate(() => ({ goal: document.querySelector('.approval-goal')?.textContent, not: document.querySelector('.approval-boundary p + p')?.textContent, digest: document.querySelector('form[action$="/approve"] [name="digest"]')?.value }));
      check(`${name} ${mode}: full approval terms and current digest render unchanged`, terms.goal === child.goal && terms.not === child.outOfScope && terms.digest === child.digest && (await noOverflow(page)).ok);
      if (mode === 'annotated') {
        await scrollTo(page, '.approval-boundaries', 80);
        await shot(page, `${name}-long-approval`, `${viewport.width}×${viewport.height}: inherited exclusions remain fully available before fresh approval (synthetic legacy fixture)`);
      }
      const approval = page.locator('form[action$="/approve"]');
      await approval.locator('[name="token"]').fill(fixture.password);
      await approval.locator('button[type="submit"]').focus();
      const approvalButton = await rect(page, 'form[action$="/approve"] button[type="submit"]');
      check(`${name} ${mode}: keyboard reaches fresh approval with a single-line button`, approvalButton.height >= 44 && approvalButton.height < 70 && (await noOverflow(page)).ok, JSON.stringify(approvalButton));
      await submit(page, 'form[action$="/approve"] button[type="submit"]');
      check(`${name} ${mode}: only the child receives fresh approval`, fixture.store.getScope(childId).approvedDigest === child.digest && JSON.stringify(fixture.store.getScope(task)) === JSON.stringify(original));
      await inspectScope(page, fixture.store.getScope(childId), `${name} ${mode} revision`);
      await goto(page, chatResult(task, runId));
      check(`${name} ${mode}: consumed feedback leaves an empty editable note box`, fixture.store.liveDiffComments(runId).length === 0 && await page.inputValue('#comment-form [name="note"]') === '');
      // Old seal remains tied to its old batch when another note appears.
      if (mode === (revisionNames ? 'annotated' : 'plain')) {
        const laterNote = `${name}: later batch stays live`;
        const form2 = await page.evaluate(() => Object.fromEntries(new FormData(document.querySelector('#comment-form')).entries()));
        await postFrom(page, `/r/${runId}/comment`, { ...form2, note: laterNote });
        await postFrom(page, `/r/${runId}/revise`, seal);
        check(`${name}: old seal replay leaves the later batch untouched`, fixture.store.revisionsFromRun(runId).length === before + 1 && fixture.store.liveDiffComments(runId).map(one => one.note).join() === laterNote);
        // Include this later note with the following annotated batch.
        await goto(page, chatResult(task, runId));
      }
    }
    await page.click('[data-result-back]');
    await page.waitForLoadState('load');
    check(`${name}: Back to chat preserves the unsent draft`, await page.inputValue('.composer textarea') === chatDraft);
    // New authoring refusal returns an editable form, specific error and
    // the same text, while the signed scope and approval card stay untouched.
    await goto(page, `/t/${fixture.tasks.long}`);
    await page.evaluate(() => { document.querySelector('#scope').open = true; document.querySelector('.scope-editor').closest('details').open = true; });
    const bad = '新しい request 😀 '.repeat(600);
    await page.fill('.scope-editor [name="goal"]', bad);
    await submit(page, '.scope-editor button[type="submit"]');
    const problem = await page.locator('#scope-error').textContent();
    check(`${name}: rejected long scope stays editable with one concise error`, problem === `Goal is ${bad.length.toLocaleString('en-US')} characters; the limit is 8,000. Shorten it.` && await page.inputValue('.scope-editor [name="goal"]') === bad && (await noOverflow(page)).ok);
    await scrollTo(page, '.scope-editor', 80);
    await shot(page, `${name}-long-rejected`, `${viewport.width}×${viewport.height}: rejected new goal stays editable; signed terms remain unchanged (synthetic fixture)`);
    await page.fill('.scope-editor [name="goal"]', 'Repair the CSV footer.');
    await submit(page, '.scope-editor button[type="submit"]');
    check(`${name}: correcting the rejected draft saves normally`, fixture.store.getScope(fixture.tasks.long).goal === 'Repair the CSV footer.');
    if (revisionNames) {
      // Reuse another synthetic result for the maximum-length title state.
      const longRun = fixture.statusRuns.attested;
      await goto(page, `/r/${longRun}`);
      await page.fill('#comment-form [name="note"]', `${name}: Keep the long Unicode subject recognizable.`);
      await submit(page, '#comment-form button[type="submit"]');
      await submit(page, '.result-request form[action$="/revise"] button[type="submit"]');
      const childId = revisionIdAt(page.url());
      check(`${name}: revision navigation stays rooted`, revisionLocationIs(page.url(), task, childId));
      await goto(page, `/t/${task}?version=${childId}`);
      const longTitle = fixture.store.getTask(childId).title;
      const geometry = await page.locator('h1').evaluate(el => {
        const r = el.getBoundingClientRect(), style = getComputedStyle(el);
        return { width: el.clientWidth, scrollWidth: el.scrollWidth, height: r.height, left: r.left, right: r.right, text: el.textContent, overflow: style.overflow, ellipsis: style.textOverflow, clamp: style.webkitLineClamp };
      });
      check(`${name}: long Unicode revision title wraps completely`, longTitle.length <= 200 && longTitle.endsWith(' — revision') && geometry.text === fixture.store.getTask(task).title && geometry.scrollWidth <= geometry.width && geometry.left >= 0 && geometry.right <= viewport.width && !['hidden', 'clip'].includes(geometry.overflow) && geometry.ellipsis !== 'ellipsis' && ['none', '0'].includes(geometry.clamp) && (await noOverflow(page)).ok, JSON.stringify(geometry));
      await shot(page, `${name}-long-named-revision`, `${viewport.width}×${viewport.height}: a bounded Unicode revision title wraps without clipping (synthetic fixture)`);
      await goto(page, `/chat?task=${childId}`);
      check(`${name}: chat card keeps the same long revision title and source link`, await page.locator('h1').textContent() === fixture.store.getTask(task).title && await page.locator('[data-revision-source]').count() === 1 && (await noOverflow(page)).ok);
      await goto(page, '/work?view=needs-you');
      const card = page.locator(`.work-row[data-task="${task}"] .work-title`);
      check(`${name}: Work card has the same long revision title`, await card.textContent() === fixture.store.getTask(task).title && (await noOverflow(page)).ok);
      await card.scrollIntoViewIfNeeded();
      await shot(page, `${name}-long-revision-work`, `${viewport.width}×${viewport.height}: long revision name in Work (synthetic fixture)`);
      await goto(page, chatResult(fixture.statusTasks.damaged, fixture.statusRuns.damaged));
      const risk = page.locator('.result-panel [data-result-attention]');
      check(`${name}: damaged evidence stays visible`, await risk.isVisible() && (await noOverflow(page)).ok);
      await shot(page, `${name}-names-evidence-failure`, `${viewport.width}×${viewport.height}: damaged evidence is still named openly (synthetic fixture)`);
    }
    await ctx.close();
  }
}

/** Same-task acceptance: two browser journeys, real HTTP/approval/seal
 * and claim records, synthetic completed artifacts, no model or worker. */
async function sameTaskJourney() {
  for (const [name, viewport] of Object.entries(VIEWPORTS).filter(([name]) => name !== 'narrow' && (!args.includes('--phone-only') || name === 'phone'))) {
    if (name === 'phone') {
      await fixture.stop();
      fixture = await startFixture({ sameTaskRevisions: true, secondProject: true, directory: join(out, 'fixture') });
    }
    const root = fixture.tasks.done, originalRun = fixture.runId;
    const originalArtifacts = JSON.stringify(fixture.store.artifactsFor(originalRun));
    const originalScope = JSON.stringify(fixture.store.getScope(root));
    const { page, ctx } = await context(viewport, { reducedMotion: 'reduce' });
    const read = async path => (await ctx.request.get(`${fixture.url}${path}`)).text();
    const post = async (path, body) => ctx.request.post(`${fixture.url}${path}`, { form: body, maxRedirects: 0 });
    const fields = selector => page.locator(selector).evaluate(form => Object.fromEntries(new FormData(form)));
    const projectCsrf = /name="csrf" value="([a-f0-9]+)"/.exec(await read('/projects'))?.[1];
    if (!projectCsrf) throw new Error('No project selection token');
    await post('/projects/select', { csrf: projectCsrf, path: fixture.repos.main, return: '/work' });
    const draft = `Keep this ${name} conversation draft through two revisions.`;
    await freshConversation(page, `/chat?task=${root}`);
    await page.fill('.composer textarea[name="message"]', `Remember the ${name} review conversation.`);
    await page.click('.composer button[type="submit"]');
    await page.waitForFunction(() => document.querySelector('.composer')?.getAttribute('data-chat-busy') === '0' && document.querySelectorAll('[data-message-role]').length > 0);
    await page.fill('.composer textarea[name="message"]', draft);
    const thread = fixture.store.activeMateSession(fixture.name);
    let sourceRun = originalRun;
    const versions = [root], runs = [sourceRun], seals = [];
    for (let revision = 1; revision <= 2; revision++) {
      await goto(page, `/chat?task=${root}&result=${sourceRun}`);
      check(`${name} revision ${revision}: exact source result and root conversation`, await page.locator(`[data-result-panel][data-result-run="${sourceRun}"]`).count() === 1 && await page.locator('.composer').getAttribute('data-chat-task') === root);
      if (revision === 1) {
        check(`${name}: empty requested-change batch has no Revise form`, await page.locator('.revision-from-comments').count() === 0);
        await shot(page, `${name}-same-task-result`, `${viewport.width}×${viewport.height}: original result with the shared root conversation (synthetic fixture).`);
      }
      if (revision === 1) {
        fixture.addReviewNotes(sourceRun);
        await page.reload();
        await page.click('[data-result-tab="checks"]');
        check(`${name}: informational reviewer notes stay available without Revise`, await page.locator('[data-cockpit-source="reviewer"]').innerText().then(text => text.includes('The rounding guard looks good.') && text.includes('Should the helper name be clearer?')) && await page.locator('.revision-from-comments').count() === 0);
        for (const [place, path] of [['chat', `/chat?task=${root}&result=${sourceRun}&tab=checks`], ['run', `/r/${sourceRun}`], ['review', `/review?result=${root}`]]) {
          await goto(page, path);
          await page.click('[data-result-tab="checks"]');
          const finding = page.locator('[data-cockpit-source="reviewer"] li').filter({ hasText: LONG_REVIEW_PATH });
          const geometry = await finding.evaluate((el, [path, hash]) => {
            const bounds = el.getBoundingClientRect(), location = el.querySelector('.mono');
            const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            const rects = [];
            while (walker.nextNode()) {
              const range = document.createRange(); range.selectNodeContents(walker.currentNode);
              rects.push(...range.getClientRects());
            }
            const unclipped = [el, ...el.querySelectorAll('*')].every(one => {
              const style = getComputedStyle(one);
              return !['hidden', 'clip'].includes(style.overflowX) && style.textOverflow !== 'ellipsis' && ['none', '0'].includes(style.webkitLineClamp);
            });
            return { exact: location?.textContent === `${path}:28` && el.textContent.includes(hash), unclipped,
              textFits: rects.every(r => r.left >= bounds.left - 1 && r.right <= bounds.right + 1),
              width: el.clientWidth, scrollWidth: el.scrollWidth };
          }, [LONG_REVIEW_PATH, LONG_REVIEW_HASH]);
          const document = await noOverflow(page);
          check(`${name} ${place}: Checks wraps the exact reviewer location and hash without clipping`, geometry.exact && geometry.unclipped && geometry.textFits && geometry.scrollWidth <= geometry.width && document.ok, JSON.stringify({ ...geometry, document }));
          await finding.locator('button').focus();
          const action = await rect(page, `button[data-review-note="Synthetic reviewer hash: ${LONG_REVIEW_HASH}"]`);
          check(`${name} ${place}: reviewer action stays visible and single-line`, fits(action, viewport) && (viewport.width > 760 || action.height >= 44) && action.height < 70);
          if (place === 'chat') await shot(page, `${name}-same-task-checks`, `${viewport.width}×${viewport.height}: exact reported reviewer location and full hash in Checks (synthetic fixture).`);
        }
        await goto(page, `/chat?task=${root}&result=${sourceRun}&tab=checks`);
        await page.locator('button[data-review-note="Should the helper name be clearer?"]').click();
        check(`${name}: deliberately selecting a reviewer question creates a feedback draft only`, await page.inputValue('#comment-form textarea[name="note"]') === 'Should the helper name be clearer?' && fixture.store.liveDiffComments(sourceRun).every(one => one.reviewerRun !== null));
      }
      await page.locator('[data-result-tab="changes"]').focus();
      await page.keyboard.press('Enter');
      await page.click('button[data-diff-mode="annotate"]');
      await page.locator("details.diff-file").filter({ hasText: LONG_FEEDBACK_PATH }).locator("summary").click();
      const lineButton = page.locator(`button.pick-line[data-path="${LONG_FEEDBACK_PATH}"][data-side="new"]`).first();
      const lineSize = await lineButton.boundingBox();
      check(`${name} revision ${revision}: keyboard opens Changes and phone annotation targets are comfortable`, await visibleTab(page) === 'changes' && (viewport.width > 760 || lineSize.width >= 44 && lineSize.height >= 44));
      check(`${name} revision ${revision}: diff code preserves whitespace and its own horizontal scroll`, await lineButton.locator('xpath=ancestor::div[contains(@class,"diff-lines")]').evaluate(el => getComputedStyle(el).overflowX === 'auto' && [...el.querySelectorAll('.diff-line code')].every(code => getComputedStyle(code).whiteSpace === 'pre')));
      await lineButton.click();
      const note = `Version ${revision}: keep ${LONG_FEEDBACK_PATH} and ${'a'.repeat(64)} intact. 日本語 😀`;
      await page.fill('#comment-form textarea[name="note"]', note);
      // Reload recovers the exact per-run annotation draft before submission.
      await page.reload();
      check(`${name} revision ${revision}: annotation draft survives reload`, await page.inputValue('#comment-form textarea[name="note"]') === note && await page.inputValue('#comment-form input[name="path"]') === LONG_FEEDBACK_PATH);
      check(`${name} revision ${revision}: long changed paths and hashes fit the viewport`, (await noOverflow(page)).ok);
      const annotation = await fields('#comment-form');
      await submit(page, '#comment-form button[type="submit"]');
      await post(`/r/${sourceRun}/comment`, annotation); // simulate lost response
      check(`${name} revision ${revision}: lost note response stores one annotation`, fixture.store.liveDiffComments(sourceRun).filter(one => one.note === note).length === 1);
      await page.fill('#comment-form textarea[name="note"]', `Also keep the ${name} root task name.`);

      await submit(page, '#comment-form button[type="submit"]');
      const batch = await fields('.revision-from-comments');
      seals.push(batch);
      const exactIds = batch.batch.split(',').map(Number);
      check(`${name} revision ${revision}: ordinary feedback and annotation share one batch`, exactIds.length === 2);
      await page.locator('.revision-from-comments button').focus();
      const reviseButton = await rect(page, '.revision-from-comments button');
      check(`${name} revision ${revision}: Revise is a single-line 44px target`, fits(reviseButton, viewport) && reviseButton.height >= 44 && reviseButton.height < 70);
      await submit(page, '.revision-from-comments button');
      const child = new URL(page.url()).searchParams.get('revision');
      versions.push(child);
      check(`${name} revision ${revision}: Revise stays on the root with a fresh unapproved execution`, new URL(page.url()).searchParams.get('task') === root && child && !fixture.store.getScope(child).approvedAt && await page.locator(`form[action="/t/${child}/approve"]`).count() === 1);
      const replay = await post(`/r/${sourceRun}/revise`, batch);
      check(`${name} revision ${revision}: lost seal response returns the same child`, replay.status() === 303 && replay.headers().location === `/chat?task=${root}&revision=${child}` && fixture.store.revisionsFromRun(sourceRun).length === 1);
      check(`${name} revision ${revision}: root draft and session survive creation`, await page.inputValue('.composer textarea[name="message"]') === draft && fixture.store.activeMateSession(fixture.name).id === thread.id);
      const work = await read('/work');
      check(`${name} revision ${revision}: one root Work card with current approval state`, (work.match(new RegExp(`class="work-row" data-task="${root}"`, 'g')) ?? []).length === 1 && !work.includes(`class="work-row" data-task="${child}"`) && /Needs you/.test(work.split(`data-task="${root}"`)[1]?.split('</article>')[0] ?? ''));
      await page.locator('.chat-approval > summary').focus();
      await page.keyboard.press('Enter');
      await scrollTo(page, '.chat-approval-section .recap', 100);
      check(`${name} revision ${revision}: keyboard opens approval and inherited paths and hashes wrap`, await page.locator('.chat-approval').evaluate(el => el.open) && (await noOverflow(page)).ok && await page.locator('.chat-approval').innerText().then(text => text.includes(note)));
      if (revision === 1) await shot(page, `${name}-same-task-approval`, `${viewport.width}×${viewport.height}: exact inherited feedback, wrapped path/hash, fresh approval (synthetic fixture).`);
      await page.fill(`form[action="/t/${child}/approve"] input[name="token"]`, fixture.password);
      await submit(page, `form[action="/t/${child}/approve"] button[type="submit"]`);
      check(`${name} revision ${revision}: only this exact scope is approved`, fixture.store.getScope(child).approvedDigest === fixture.store.getScope(child).digest && JSON.stringify(fixture.store.getScope(root)) === originalScope);
      if (revision === 2) {
        fixture.store.hold(fixture.store.lookupRef(child).id, 'Synthetic hold for the acceptance journey.', null, new Date());
        await page.reload();
        check(`${name}: held revision replaces the old completed state`, await page.locator('#task-chat-live').innerText().then(text => text.includes('On hold')));
        fixture.store.unhold(fixture.store.lookupRef(child).id);
      }
      const countsOf = text => {
        const match = /<a href="\/runs">(\d+) live<\/a><a href="\/board\?view=order">(\d+) queued<\/a>/.exec(text);
        if (!match) throw new Error('No project/header counts');
        return { live: Number(match[1]), queued: Number(match[2]) };
      };
      const beforeLive = countsOf(await read(`/t/${root}`));
      const live = fixture.startRevision(child);
      await page.reload();
      check(`${name} revision ${revision}: actual live revision says Building with its stored row still queued`, fixture.store.getTask(child).state === 'queued' && await page.locator('#task-chat-live').innerText().then(text => text.includes('Building')));
      for (const phase of ['agent-running', 'verifying-proof']) {
        fixture.store.setRunPhase(live, phase);
        const header = countsOf(await read(`/t/${root}`));
        const projects = await read('/projects');
        check(`${name} revision ${revision}: project/header counts use the native claim during ${phase}`, header.live === beforeLive.live + 1 && header.queued === beforeLive.queued - 1 && projects.includes(`>${header.live} running</a>`) && (header.queued === 0 || projects.includes(`>${header.queued} queued</a>`)), JSON.stringify(header));
      }
      if (revision === 1) {
        await goto(page, `/t/${root}`);
        check(`${name}: live task and header fit the viewport`, (await noOverflow(page)).ok);
        if (name === 'phone') check('phone: each header count label is fully visible', await page.locator('.mobile-top .pill-status').evaluate(el => {
          const bounds = el.getBoundingClientRect();
          return [...el.children].every(child => {
            const range = document.createRange(); range.selectNodeContents(child);
            const text = range.getBoundingClientRect();
            return text.left >= bounds.left - 1 && text.right <= bounds.right + 1 && text.bottom <= bounds.bottom + 1;
          });
        }));
        await shot(page, `${name}-same-task-live`, `${viewport.width}×${viewport.height}: native-style queued row, live claim in final checks, truthful project/header counts (synthetic fixture).`);
        await goto(page, `/chat?task=${root}`);
      }
      if (revision === 2) {
        fixture.finishRevision(live, 'failed');
        await page.reload();
        check(`${name}: failed current revision exposes recovery and History`, await page.locator('#task-chat-live').innerText().then(text => /failed|retry/i.test(text) && text.includes('History')));
        await shot(page, `${name}-same-task-failure`, `${viewport.width}×${viewport.height}: current failed revision, preserved conversation and History (synthetic fixture).`);
        const retried = fixture.store.requeueTask(child, fixture.name, new Date());
        if (!retried.ok) throw new Error(`synthetic retry: ${retried.reason}`);
        sourceRun = fixture.startRevision(child);
      } else sourceRun = live;
      fixture.finishRevision(sourceRun);
      runs.push(sourceRun);
      await page.reload();
      check(`${name} revision ${revision}: current result, root draft and shared conversation`, (await page.locator('[data-open-result]').first().getAttribute('href')).includes(`result=${sourceRun}`) && await page.inputValue('.composer textarea[name="message"]') === draft && (await page.locator('#chat-thread').innerText()).includes(`Remember the ${name} review conversation.`));
    }
    await page.locator('#task-chat-live .task-history > summary').focus();
    await page.keyboard.press('Enter');
    check(`${name}: keyboard opens History with Original and two exact revisions`, await page.locator('#task-chat-live .task-history').evaluate(el => el.open) && await page.locator('#task-chat-live [data-history-version]').count() === 3 && await page.locator('#task-chat-live .task-history').innerText().then(text => text.includes('Original') && text.includes('Revision 1') && text.includes('Revision 2')));
    await scrollTo(page, '#task-chat-live .task-history', 130);
    await shot(page, `${name}-same-task-history`, `${viewport.width}×${viewport.height}: one root task, Original, Revision 1 and Revision 2 (synthetic builds).`);
    const heads = [];
    for (let i = 0; i < runs.length; i++) {
      await goto(page, `/chat?task=${root}&result=${runs[i]}&tab=changes`);
      heads.push(await page.locator('[data-result-panel]').getAttribute('data-result-head'));
      check(`${name}: History result ${i} opens its exact diff and comment target`, await page.locator(`[data-result-panel][data-result-run="${runs[i]}"]`).count() === 1 && await page.locator('#comment-form').getAttribute('action') === `/r/${runs[i]}/comment`);
      await page.locator("details.diff-file").filter({ hasText: LONG_FEEDBACK_PATH }).locator("summary").click();
      if (i > 0) check(`${name}: revision ${i} diff is distinct`, (await page.locator('[data-result-view="changes"]').innerText()).includes(`version_${runs[i]}`));
      await page.goBack();
    }
    check(`${name}: three exact heads and immutable original artifacts`, new Set(heads).size === 3 && JSON.stringify(fixture.store.artifactsFor(originalRun).filter(one => one.kind !== 'revision-brief')) === originalArtifacts, JSON.stringify({ heads }));
    // A late note on the original is never stolen by retrying its earlier seal.
    await goto(page, `/chat?task=${root}&result=${originalRun}`);
    await page.fill('#comment-form textarea[name="note"]', 'Later feedback on the original.');
    await submit(page, '#comment-form button[type="submit"]');
    check(`${name}: later feedback stays on the original`, fixture.store.liveDiffComments(originalRun).filter(one => one.reviewerRun === null).length === 1);
    const oldSeal = await post(`/r/${originalRun}/revise`, seals[0]);
    await goto(page, oldSeal.headers().location);
    check(`${name}: an old seal retry after two revisions opens its exact version and preserves later notes`, new URL(page.url()).pathname === `/t/${root}` && new URL(page.url()).searchParams.get('version') === versions[1] && fixture.store.liveDiffComments(originalRun).filter(one => one.reviewerRun === null).length === 1 && fixture.store.revisionsFromRun(originalRun).length === 1);
    await goto(page, `/chat?task=${versions[1]}&result=${runs[1]}`);
    check(`${name}: old child result link canonicalizes without changing the selected run`, new URL(page.url()).searchParams.get('task') === root && new URL(page.url()).searchParams.get('result') === String(runs[1]));
    await goto(page, `/chat?task=${root}`);
    await page.reload();
    check(`${name}: draft survives Back, old links and reload`, await page.inputValue('.composer textarea[name="message"]') === draft);
    await goto(page, `/chat?task=${fixture.statusTasks.damaged}&result=${fixture.statusRuns.damaged}`);
    check(`${name}: damaged screenshot remains an explicit failure`, await page.locator('.result-panel [data-result-attention]').innerText().then(text => /unavailable|damaged|cannot/i.test(text)) && (await noOverflow(page)).ok);
    // A broken synthetic lineage remains a readable exact result in Review.
    const damagedTask = fixture.statusTasks.damaged;
    const brief = fixture.store.artifactsFor(originalRun).find(one => one.kind === 'revision-brief');
    fixture.store.markRevision(fixture.store.lookupRef(damagedTask).id, 'missing-synthetic-ancestor', brief.id);
    await goto(page, `/review?result=${damagedTask}`);
    check(`${name}: Review keeps the broken-lineage result with a safe warning`, await page.locator(`.cockpit-row.current[href="/review?result=${damagedTask}"]`).count() === 1 && await page.locator('[data-history-problem]').count() > 0 && !(await page.locator('main').innerText()).includes('missing-synthetic-ancestor') && (await noOverflow(page)).ok);
    check(`${name}: broken history describes the task in plain English`, (await page.locator('main').innerText()).includes('This task is shown separately.'));
    await shot(page, `${name}-same-task-review`, `${viewport.width}×${viewport.height}: broken-lineage result retained in Review with a history warning (synthetic fixture).`);
    const csrf = await page.locator('input[name=csrf]').first().getAttribute('value');
    await post('/projects/select', { csrf, path: fixture.repos.empty, return: '/work' });
    await goto(page, '/work');
    check(`${name}: empty project has no family cards`, await page.locator('.work-row').count() === 0 && await page.locator('.work-empty').count() === 1);
    check(`${name}: final layout has no horizontal overflow`, (await noOverflow(page)).ok);
    await ctx.close();
  }
}

let cookieHeader = '';
const runId = fixture.runId;
const task = fixture.tasks.done;
const chatResult = (id, run, tab) => `/chat?task=${id}&result=${run}${tab ? `&tab=${tab}` : ''}`;

async function learningJourney() {
  for (const [name, viewport] of [['desktop', VIEWPORTS.desktop], ['phone', VIEWPORTS.phone]]) {
    if (name === 'phone') { await fixture.stop(); fixture = await startFixture({ learning: true, secondProject: true, directory: join(out, 'fixture') }); }
    const { ctx, page } = await context(viewport, { reducedMotion: 'reduce' });
    const settings = `/settings/learning?repo=${encodeURIComponent(fixture.repos.main)}`;
    await goto(page, '/settings');
    check(`${name}: Settings exposes Learning without notification credentials`, await page.locator('main a[href="/settings/learning"]').count() === 1, '');
    await goto(page, settings);
    check(`${name}: empty learning and ledger states`, (await page.textContent('main')).includes('No lessons yet') && (await page.textContent('main')).includes('No learning changes yet'), '');
    await shot(page, `${name}-learning-empty`, `${viewport.width}×${viewport.height}: empty Learning settings, synthetic project`);
    fixture.captureLearning();
    await goto(page, `/r/${fixture.runId}`);
    const closed = await page.locator('.result-learning').evaluate(el => !el.open);
    check(`${name}: useful learning stays closed and keeps the result action`, closed && await page.locator('[data-result-action]').count() === 1, '');
    // Inspect the diff and leave feedback through the existing result road.
    await page.locator('.result-tabs a').filter({ hasText: 'Changes' }).click();
    await page.fill('#comment-form [name="note"]', 'Keep the half-cent boundary regression readable.');
    await submit(page, '#comment-form button[type="submit"]');
    await submit(page, '.result-request form[action$="/revise"] button[type="submit"]');
    check(`${name}: existing feedback creates one unapproved revision`, fixture.store.revisionsFromRun(fixture.runId).length === 1, '');
    await goto(page, `/r/${fixture.runId}`);
    await page.locator('.result-learning > summary').focus();
    await page.keyboard.press('Enter');
    check(`${name}: disclosure works with keyboard`, await page.locator('.result-learning').evaluate(el => el.open), '');
    await page.locator('.result-learning [data-lesson]').filter({ hasText: 'Proposed lesson' }).locator('details > summary').click();
    const button = page.getByRole('button', { name: 'Save lesson', exact: true });
    await button.scrollIntoViewIfNeeded();
    check(`${name}: Save lesson has a 44px target`, await button.evaluate(el => el.getBoundingClientRect().height >= 44), '');
    await shot(page, `${name}-learning-adopt`, `${viewport.width}×${viewport.height}: source-linked lesson in a quiet result disclosure; synthetic data`);
    await submit(page, '.result-learning button:has-text("Save lesson")');
    check(`${name}: adoption ledger and system suggestion stay distinct`, (await page.textContent('main')).includes('Adopted advice') && (await page.textContent('main')).includes('No change applied'), '');
    const staleForm = await page.locator('.learning form').first().evaluate(el => Object.fromEntries(new FormData(el)));
    await submit(page, '.learning button:has-text("Enable reuse")');
    const used = fixture.laterLearningRun();
    const frozen = JSON.parse(used.context.trim().split('\n').at(-1));
    check(`${name}: a different later run receives the exact adopted advice`, frozen.lessons.length === 1 && frozen.lessons[0].source === fixture.runId && used.context === fixture.store.handle.prepare('SELECT payload FROM learning_snapshot WHERE run=?').get(used.runId).payload, '');
    await goto(page, settings);
    await page.locator('[data-learning-event="reuse"] details > summary').first().click();
    await page.locator('[data-learning-event="reuse"]').first().scrollIntoViewIfNeeded();
    await shot(page, `${name}-learning-ledger`, `${viewport.width}×${viewport.height}: append-only usage ledger with actor, state, sources and run; synthetic data`);
    const stale = await page.evaluate(async data => { const r = await fetch('/settings/learning/change', { method: 'POST', body: new URLSearchParams(data) }); return { status: r.status, text: await r.text() }; }, staleForm);
    check(`${name}: a stale form is refused with recovery`, stale.status === 409 && stale.text.includes('Reload before trying again'), '');
    // Navigate to a real stale response to inspect its visible failure layout.
    await page.evaluate(data => { const f = document.createElement('form'); f.method = 'post'; f.action = '/settings/learning/change'; for (const [k,v] of Object.entries(data)) { const i = document.createElement('input'); i.name=k; i.value=v; f.append(i); } document.body.append(f); f.submit(); }, staleForm);
    await page.waitForLoadState('load'); await page.waitForSelector('.problem');
    await shot(page, `${name}-learning-error`, `${viewport.width}×${viewport.height}: stale Learning action refused with reload link; synthetic data`);
    check(`${name}: error state fits and recovery has a 44px target`, (await noOverflow(page)).ok && await page.getByRole('link', {name:'Reload Learning', exact:true}).evaluate(el => el.getBoundingClientRect().height >= 44), '');
    await goto(page, settings);
    await submit(page, '.learning button:has-text("Disable lesson")');
    const next = fixture.laterLearningRun();
    check(`${name}: disabling excludes future advice and retains the earlier snapshot`, JSON.parse(next.context.trim().split('\n').at(-1)).lessons.length === 0 && fixture.store.handle.prepare('SELECT payload FROM learning_snapshot WHERE run=?').get(used.runId).payload === used.context, '');
    await goto(page, settings);
    await page.locator('.learning [data-lesson] details > summary').last().click();
    check(`${name}: expanded long source details fit without overflow`, (await noOverflow(page)).ok, '');
    await page.locator('[data-learning-event="reuse"] details > summary').first().click();
    await page.locator('[data-learning-event="reuse"]').first().getByText('Exact context', {exact:true}).click();
    check(`${name}: immutable context is readable without overflow`, (await noOverflow(page)).ok, '');
    const controls = await page.locator('.learning button, .learning summary').evaluateAll(els => els.filter(e => e.checkVisibility()).map(e => ({ height: e.getBoundingClientRect().height, width: e.getBoundingClientRect().width, text: e.textContent })));
    check(`${name}: visible learning actions and disclosures have 44px targets`, controls.every(c => c.height >= 44), JSON.stringify(controls));
    check(`${name}: retained ledger includes adoption, disable and reuse`, ['adopt', 'disable', 'reuse'].every(action => fixture.store.handle.prepare('SELECT 1 FROM learning_event WHERE repo=? AND action=?').get(fixture.repos.main, action)), '');
    // Project filter does not leak the main project's lesson or ledger.
    await goto(page, `/settings/learning?repo=${encodeURIComponent(fixture.repos.empty)}`);
    check(`${name}: another project remains empty`, (await page.textContent('main')).includes('No lessons yet') && !(await page.textContent('main')).includes('Payout rounding uses'), '');
    await ctx.close();
  }
}

try {
  // A plain HTTP session for the fact reads (the same login, no browser).
  {
    const login = await fetch(`${fixture.url}/login`, { method: 'POST', body: new URLSearchParams({ name: fixture.name, token: fixture.password }), redirect: 'manual' });
    cookieHeader = (login.headers.get('set-cookie') ?? '').split(';')[0];
  }

  if (learning) {
    await learningJourney();
  } else if (sameTask) {
    await sameTaskJourney();
  } else if (longRequests) {
    await longRequestJourney();
  } else {
  let page;
  // Small presentation repairs can recheck the affected evidence and layouts
  // without repeating the already-passed result-to-revision journey.
  if (!layoutOnly) {
  // ---- c1: the shared facts agree across every surface ----------------------
  const surfaces = {
    'chat receipt': await factsOf(`/chat?task=${task}`),
    'chat result detail': await factsOf(chatResult(task, runId)),
    'run page': await factsOf(`/r/${runId}`),
    'review cockpit': await factsOf(`/review?result=${task}`),
  };
  const stamp = f => JSON.stringify(f);
  const receiptFacts = surfaces['chat receipt'].first;
  check('c1 the chat receipt stamps the shared facts (run, head, base, checks, caveats, evidence, publication)', receiptFacts !== null && receiptFacts.run === String(runId) && receiptFacts.head === '9e07b4152aa0' && receiptFacts.base === '4b825dc642cb' && receiptFacts['head-source'] === 'sealed diff' && receiptFacts.checks === '2/2' && receiptFacts.caveats === '0' && receiptFacts.evidence === 'ok' && receiptFacts.publication === 'none', stamp(receiptFacts));
  for (const [name, one] of Object.entries(surfaces)) {
    const same = one.all.filter(f => f.run === String(runId)).every(f => stamp(f) === stamp(receiptFacts));
    check(`c1 ${name} agrees with the receipt fact for fact (${one.all.filter(f => f.run === String(runId)).length} stamped element(s))`, one.all.length > 0 && same, one.all.map(stamp).join(' | '));
  }
  check('c1 the chat receipt leads to the result detail with one primary road', surfaces['chat receipt'].text.includes(`href="/chat?task=${task}&amp;result=${runId}" data-open-result>Open result</a>`) && !/Request changes in chat|Review &amp; annotate/.test(surfaces['chat receipt'].text));
  // A published result: the same publication words on every surface.
  const published = fixture.statusRuns.published;
  const pubTask = fixture.statusTasks.published;
  const pubSurfaces = [await factsOf(`/t/${pubTask}`), await factsOf(`/r/${published}`), await factsOf(`/review?result=${pubTask}`)];
  check('c1 a published result names the same publication state and PR on the task receipt, the run page, and the cockpit', pubSurfaces.every(one => one.first?.publication === 'opened' && one.text.includes('PR #482')), pubSurfaces.map(one => stamp(one.first)).join(' | '));
  // The deliverable leads: screenshots for UI work, the report for an investigation, the change list for code.
  const leadOf = text => /data-result-lead="([a-z]+)"/.exec(text)?.[1] ?? null;
  const firstInSummary = text => { const view = /<div class="result-view" role="tabpanel" data-result-view="summary"[^>]*>([\s\S]*?)<div class="result-view" role="tabpanel" data-result-view="changes"/.exec(text)?.[1] ?? ''; return /<([a-z]+)[^>]*class="([^"]*)"/.exec(view)?.[2] ?? null; };
  const uiText = surfaces['run page'].text;
  const investigationText = await html(`/r/${fixture.statusRuns.investigation}`);
  const codeText = await html(`/r/${fixture.statusRuns.missingProof}`);
  check('c1 UI work leads with its validated screenshots', leadOf(uiText) === 'screenshots' && /^receipt-visuals result-visuals/.test(firstInSummary(uiText) ?? ''), `${leadOf(uiText)} · ${firstInSummary(uiText)}`);
  check('c1 an investigation leads with its report', leadOf(investigationText) === 'report' && firstInSummary(investigationText) === 'result-report', `${leadOf(investigationText)} · ${firstInSummary(investigationText)}`);
  check('c1 code work without screenshots leads with its changed files and the way to the diff', leadOf(codeText) === 'changes' && firstInSummary(codeText) === 'result-files-lead', `${leadOf(codeText)} · ${firstInSummary(codeText)}`);

  // ---- c2: Summary / Changes / Checks, safe evidence, honest problems ------
  const desktop = await context(VIEWPORTS.desktop);
  page = desktop.page;
  await goto(page, `/r/${runId}`);
  check('c2 the run page opens on Summary with the other views hidden', (await visibleTab(page)) === 'summary' && (await selectedTab(page)) === 'summary');
  const docToken = await page.evaluate(() => (window.__doc = Math.random()));
  await page.click('[data-result-tab="changes"]');
  await page.waitForTimeout(100);
  const afterClick = { tab: await visibleTab(page), url: page.url(), same: await page.evaluate(t => window.__doc === t, docToken), diff: await page.evaluate(() => document.querySelector('[data-result-view="changes"] [data-review-diff]')?.checkVisibility() ?? false) };
  check('c2 Changes switches in place (no reload), records ?tab=changes, and shows the diff', afterClick.tab === 'changes' && afterClick.same && afterClick.url.endsWith(`/r/${runId}?tab=changes`) && afterClick.diff, JSON.stringify(afterClick));
  await page.reload({ waitUntil: 'load' });
  check('c2 refresh keeps the Changes view', (await visibleTab(page)) === 'changes');
  await page.click('[data-result-tab="checks"]');
  await page.waitForTimeout(100);
  const checksView = await page.evaluate(() => ({ verdict: document.querySelector('[data-result-view="checks"] [data-proof-verdict]')?.getAttribute('data-proof-verdict'), matrix: document.querySelectorAll('[data-result-view="checks"] [data-matrix-state]').length, log: document.querySelector('[data-result-view="checks"] [data-cockpit-source="machine"]') !== null, agent: document.querySelector('[data-result-view="checks"] [data-cockpit-source="agent"]') !== null }));
  check('c2 Checks carries the machine verdict, every signed criterion, the check log, and the agent checks', checksView.verdict === 'complete-verified' && checksView.matrix === 2 && checksView.log && checksView.agent, JSON.stringify(checksView));
  // Keyboard: arrows move between tabs.
  await page.focus('[data-result-tab="checks"]');
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(100);
  check('c2 the tabs are keyboard-operable (ArrowLeft from Checks selects Changes)', (await visibleTab(page)) === 'changes' && (await page.evaluate(() => document.activeElement?.getAttribute('data-result-tab'))) === 'changes');
  await goto(page, `/r/${runId}?tab=checks`);
  check('c2 the URL alone selects the view (no script needed to land on Checks)', (await visibleTab(page)) === 'checks');
  // Validated screenshot through the evidence road.
  const shotSrc = await page.evaluate(() => document.querySelector('.result-panel .receipt-shot img')?.getAttribute('src') ?? null);
  const shotStatus = shotSrc === null ? null : (await fetch(`${fixture.url}${shotSrc}`, { headers: { cookie: cookieHeader } })).status;
  check('c2 the validated screenshot renders through the evidence road (200, image)', shotSrc !== null && shotStatus === 200, `${shotSrc} → ${shotStatus}`);
  // Investigation: escaped report, download as text, never a page.
  await goto(page, `/r/${fixture.statusRuns.investigation}`);
  const reportView = await page.evaluate(() => {
    const article = document.querySelector('.result-report');
    return {
      present: article !== null,
      scriptsInside: article?.querySelectorAll('script').length ?? -1,
      textHasTag: (article?.querySelector('pre')?.textContent ?? '').includes('<script>alert("this is text, never markup")</script>'),
      download: article?.querySelector('a[href*="/evidence/"]')?.getAttribute('href') ?? null,
      lead: document.querySelector('[data-result-panel]')?.getAttribute('data-result-lead'),
      status: document.querySelector('.result-head .status-line')?.textContent.trim(),
      noDiffWords: document.querySelector('[data-result-view="changes"]')?.textContent.includes('an investigation changes nothing in the repository'),
      alerted: window.__alerted === true,
    };
  });
  const download = reportView.download === null ? null : await fetch(`${fixture.url}${reportView.download}`, { headers: { cookie: cookieHeader } });
  check('c2 an investigation leads with its report as escaped text — no script element, the tag visible as text — with a text download (attachment), and says it changed nothing', reportView.present && reportView.scriptsInside === 0 && reportView.textHasTag && reportView.lead === 'report' && reportView.noDiffWords === true && download?.status === 200 && (download.headers.get('content-type') ?? '').startsWith('text/plain') && (download.headers.get('content-disposition') ?? '').startsWith('attachment'), JSON.stringify({ ...reportView, contentType: download?.headers.get('content-type') }));
  await shot(page, 'desktop-investigation-report', 'Desktop 1440×900: an investigation result leads with its escaped report and text download (synthetic fixture)');
  // Damaged evidence: named in the open, never validated, refused by the evidence road.
  await goto(page, `/r/${fixture.statusRuns.damaged}`);
  const damaged = await page.evaluate(() => {
    const panel = document.querySelector('[data-result-panel]');
    const attention = document.querySelector('[data-result-attention]');
    const tabsTop = document.querySelector('.result-tabs')?.getBoundingClientRect().top ?? 0;
    return {
      evidence: panel?.getAttribute('data-result-evidence'),
      attentionAboveTabs: attention !== null && attention.getBoundingClientRect().bottom <= tabsTop,
      attention: attention?.textContent ?? '',
      images: panel?.querySelectorAll('img').length ?? -1,
      unavailable: document.querySelector('[data-result-unavailable]')?.textContent ?? '',
      validatedWords: /validated visual proof/.test(panel?.textContent ?? ''),
      evidenceFact: [...document.querySelectorAll('.result-facts dt')].find(dt => dt.textContent === 'Evidence')?.nextElementSibling?.textContent ?? '',
      caveats: panel?.getAttribute('data-result-caveats'),
      status: document.querySelector('.result-head .status-line')?.textContent.trim(),
    };
  });
  const tamperedArtifact = fixture.store.artifactsFor(fixture.statusRuns.damaged).find(one => one.kind === 'screenshot');
  const tamperedFetch = await fetch(`${fixture.url}/r/${fixture.statusRuns.damaged}/evidence/${tamperedArtifact.id}`, { headers: { cookie: cookieHeader } });
  check('c2 damaged evidence is named in the open BEFORE the views: tampered screenshot not shown or called validated, failed change-summary capture, shortened check log, and the caveat', damaged.evidence?.startsWith('problems:') && damaged.attentionAboveTabs && /Screenshot evidence\/payout-dashboard\.png no longer verifies/.test(damaged.attention) && /change summary is unavailable/.test(damaged.attention) && /check output was shortened/.test(damaged.attention) && /USD only/.test(damaged.attention) && damaged.images === 0 && !damaged.validatedWords && /0 validated screenshots, 1 unavailable/.test(damaged.evidenceFact) && damaged.caveats === '1', JSON.stringify(damaged));
  check('c2 the evidence road refuses the tampered screenshot bytes (410)', tamperedFetch.status === 410, String(tamperedFetch.status));
  check('c2 the damaged result is not called ready: its status says some saved material is unavailable (repair 2026-09-14)', /some saved material is unavailable/i.test(damaged.status ?? ''), damaged.status);
  await shot(page, 'desktop-damaged-evidence', 'Desktop 1440×900: a result whose screenshot was altered after sealing — problems first, nothing called validated (synthetic fixture)');
  const damagedChat = await factsOf(`/chat?task=${fixture.statusTasks.damaged}`);
  check('c2 the chat receipt counts the tampered screenshot as unavailable, not validated', damagedChat.text.includes('1 unavailable — not validated') && damagedChat.first?.evidence === damaged.evidence, `${damagedChat.first?.evidence}`);

  // ---- c3: two feedback styles, one sealed revision --------------------------
  await goto(page, `/r/${runId}`);
  const revisionsBefore = fixture.store.revisionsFromRun(runId).length;
  // A plain note (no pin).
  await page.fill('#comment-form [name="note"]', 'Please also round the CSV footer the same way — the drift moves there otherwise.');
  const firstRequest = await page.evaluate(() => document.querySelector('#comment-form [name="request"]').value);
  await submit(page, '#comment-form button[type="submit"]');
  const afterNote = { url: page.url(), notes: fixture.store.liveDiffComments(runId).length, focused: await page.evaluate(() => document.activeElement?.getAttribute('name') === 'note') };
  check('c3 a plain note lands in the batch and the reader returns to the form, focused', afterNote.notes === 1 && afterNote.url.includes(`noted=${firstRequest}#request-changes`) && afterNote.focused, JSON.stringify(afterNote));
  // Replay the same submission (same request token): no second note.
  const csrf = await page.evaluate(() => document.querySelector('input[name="csrf"]')?.value ?? '');
  const replayed = await postFrom(page, `/r/${runId}/comment`, { csrf, note: 'Please also round the CSV footer the same way — the drift moves there otherwise.', request: firstRequest, return: `/r/${runId}` });
  check('c3 replaying the same note submission records no second note', (replayed.status === 0 || replayed.status === 303) && fixture.store.liveDiffComments(runId).length === 1, JSON.stringify({ replayed, notes: fixture.store.liveDiffComments(runId).length }));
  // A line annotation through Annotate mode.
  await page.click('[data-result-tab="changes"]');
  await page.click('button[data-diff-mode="annotate"]');
  await page.waitForTimeout(100);
  const pinVisible = await page.evaluate(() => { const pin = document.querySelector('button.pick-line[data-path="src/payout.ts"][data-side="new"]'); return pin !== null && pin.checkVisibility() && document.querySelector('[data-review-diff]')?.getAttribute('data-mode') === 'annotate'; });
  check('c3 Annotate mode reveals the line pins', pinVisible);
  await page.click('button.pick-line[data-path="src/payout.ts"][data-side="new"]');
  await page.waitForTimeout(150);
  const pinned = await page.evaluate(() => ({ path: document.querySelector('#comment-form [name="path"]').value, line: document.querySelector('#comment-form [name="line"]').value, open: document.querySelector('#comment-form details.result-pin')?.open, focused: document.activeElement?.getAttribute('name') }));
  check('c3 picking a line fills the pin and focuses the note', pinned.path === 'src/payout.ts' && /^[0-9]+$/.test(pinned.line) && pinned.open === true && pinned.focused === 'note', JSON.stringify(pinned));
  await page.fill('#comment-form [name="note"]', 'Name the rounding helper instead of inlining the multiply.');
  await submit(page, '#comment-form button[type="submit"]');
  const batch = fixture.store.liveDiffComments(runId);
  check('c3 both feedback styles sit in ONE batch: a plain note and a pinned annotation', batch.length === 2 && batch.some(one => one.path === null) && batch.some(one => one.path === 'src/payout.ts' && one.line !== null), JSON.stringify(batch.map(one => [one.path, one.line])));
  const readyWords = await page.evaluate(() => document.querySelector('.result-request .revision-from-comments strong')?.textContent);
  check('c3 Request changes shows the batch beside the result with one Revise act', readyWords === '2 notes ready' && (await page.evaluate(() => document.querySelectorAll('.result-request form[action$="/revise"]').length)) === 1, readyWords);
  await shot(page, 'desktop-request-changes-batch', 'Desktop 1440×900: a plain note and a line annotation in one batch beside the result, ready to become one revision (synthetic fixture)');
  // The seal body as rendered (repair 2026-09-14): the exact batch and source.
  const sealBody = await page.evaluate(() => Object.fromEntries(new FormData(document.querySelector('.result-request form[action$="/revise"]')).entries()));
  check('c3 the seal form names the exact displayed batch and the source terms', sealBody.batch === batch.map(one => one.id).join(',') && sealBody.source === fixture.store.getScope(task).digest, JSON.stringify(sealBody));
  await submit(page, '.result-request form[action$="/revise"] button[type="submit"]');
  const revisions = fixture.store.revisionsFromRun(runId);
  const revisionId = revisions.at(-1)?.id ?? '';
  const revisionScope = fixture.store.getScope(revisionId);
  const lineage = fixture.store.revisionLineageOf(revisionId, new Date());
  check('c3 Create revision seals exactly one revision through the existing road, unapproved, with the exact source lineage', revisions.length === revisionsBefore + 1 && revisionLocationIs(page.url(), task, revisionId) && revisionScope !== null && revisionScope.approvedAt === null && lineage?.sourceTask === task && lineage?.sourceRun === runId, JSON.stringify({ revisions: revisions.map(one => one.id), url: page.url(), lineage }));
  await goto(page, `/t/${task}?version=${revisionId}`);
  const revisionPage = await page.content();
  check('c3 the revision page restates both notes and links back to the original task and build', revisionPage.includes('Please also round the CSV footer') && revisionPage.includes('Name the rounding helper') && revisionPage.includes(`href="/r/${runId}">build #${runId}</a>`) && revisionPage.includes(`href="/t/${task}"`), '');
  check('c3 the revision still needs its own password approval (looks good never became an approval)', revisionPage.includes('input type="password"') || /approve/i.test(revisionPage), '');
  // Replay the seal: no twin.
  const replayedSeal = await postFrom(page, `/r/${runId}/revise`, sealBody);
  check('c3 replaying Create revision mints no second revision', (replayedSeal.status === 0 || replayedSeal.status === 303) && fixture.store.revisionsFromRun(runId).length === revisions.length, JSON.stringify({ replayedSeal, count: fixture.store.revisionsFromRun(runId).length }));
  // Forward link and preserved original evidence.
  await goto(page, `/r/${runId}`);
  const forward = await page.evaluate(() => ({ revision: document.querySelector('[data-result-revision]')?.getAttribute('data-result-revision'), words: document.querySelector('[data-result-revision]')?.textContent, shots: document.querySelectorAll('.result-panel .receipt-shot img').length, diff: document.querySelector('[data-review-diff]') !== null, batchGone: document.querySelector('.result-request .revision-from-comments') === null }));
  check('c3 the original result links forward to the proposed revision and keeps its own evidence (screenshot, diff); the consumed batch no longer offers a second seal', forward.revision === revisionId && /Needs you/.test(forward.words ?? '') && forward.shots === 1 && forward.diff && forward.batchGone, JSON.stringify(forward));
  const chatApproval = await html(`/chat?task=${revisionId}`);
  check('c3 the revision\'s chat approval card links back to the original result', chatApproval.includes(`href="/chat?task=${task}&amp;result=${runId}" data-revision-source>Original result: build #${runId} →</a>`), '');
  await desktop.ctx.close();

  // ---- c4: drafts, selected result, reading position, isolation -------------
  const cont = await context(VIEWPORTS.desktop);
  page = cont.page;
  await freshConversation(page, `/chat?task=${task}`);
  await page.fill('.composer textarea', 'Unsent: can you also cover EUR in the footer test?');
  await page.waitForTimeout(150);
  // Scroll to the receipt (reading position) and open the result.
  await scrollTo(page, '.completion-receipt');
  const chatScrollY = await page.evaluate(() => window.scrollY);
  await page.waitForTimeout(250);
  await page.click('.completion-receipt a[data-open-result]');
  await page.waitForLoadState('load');
  const opened = { url: page.url(), panel: await page.evaluate(() => document.querySelector('[data-result-panel]') !== null), beside: await page.evaluate(() => { const main = document.querySelector('.chat-main'); const aside = document.querySelector('.chat-result'); return main !== null && aside !== null && main.checkVisibility() && aside.checkVisibility() && aside.getBoundingClientRect().left > main.getBoundingClientRect().left; }), context: await page.evaluate(() => document.querySelector('.task-chat-context') === null), draft: await page.evaluate(() => document.querySelector('.composer textarea').value) };
  check('c4 Open result opens the detail beside the conversation on the desktop, as the only auxiliary panel, with the unsent chat draft intact', opened.url === `${fixture.url}${chatResult(task, runId)}` && opened.panel && opened.beside && opened.context && opened.draft === 'Unsent: can you also cover EUR in the footer test?', JSON.stringify(opened));
  await shot(page, 'desktop-chat-result-beside', 'Desktop 1440×900: the result detail open beside the task conversation, unsent draft kept (synthetic fixture)');
  check('c5 desktop chat + result has no horizontal overflow', (await noOverflow(page)).ok);
  // A review draft, then Back to chat, then reopen.
  await page.click('[data-result-tab="checks"]');
  await page.fill('#comment-form [name="note"]', 'Draft: the EUR case is still uncovered.');
  await page.waitForTimeout(150);
  await scrollTo(page, '#request-changes');
  const resultScrollY = await page.evaluate(() => window.scrollY);
  await page.waitForTimeout(250);
  await page.click('[data-result-back]');
  await page.waitForLoadState('load');
  await page.waitForTimeout(200);
  const back = { url: page.url(), draft: await page.evaluate(() => document.querySelector('.composer textarea').value), scrollY: await page.evaluate(() => window.scrollY) };
  check('c4 Back to chat returns to the same task with the unsent chat draft and the reading position', back.url === `${fixture.url}/chat?task=${task}` && back.draft === 'Unsent: can you also cover EUR in the footer test?' && Math.abs(back.scrollY - chatScrollY) <= 8, JSON.stringify({ ...back, chatScrollY }));
  await page.goBack({ waitUntil: 'load' });
  await page.waitForTimeout(250);
  const returned = { url: page.url(), tab: await visibleTab(page), note: await page.evaluate(() => document.querySelector('#comment-form [name="note"]')?.value), scrollY: await page.evaluate(() => window.scrollY) };
  check('c4 browser Back restores the selected result and view (Checks) with the review draft and the position', returned.url === `${fixture.url}${chatResult(task, runId, 'checks')}` && returned.tab === 'checks' && returned.note === 'Draft: the EUR case is still uncovered.' && Math.abs(returned.scrollY - resultScrollY) <= 8, JSON.stringify({ ...returned, resultScrollY }));
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(250);
  const refreshed = { tab: await visibleTab(page), note: await page.evaluate(() => document.querySelector('#comment-form [name="note"]')?.value), chat: await page.evaluate(() => document.querySelector('.composer textarea').value), scrollY: await page.evaluate(() => window.scrollY) };
  check('c4 refresh keeps the view, the review draft, the chat draft, and the position', refreshed.tab === 'checks' && refreshed.note === 'Draft: the EUR case is still uncovered.' && refreshed.chat === 'Unsent: can you also cover EUR in the footer test?' && Math.abs(refreshed.scrollY - resultScrollY) <= 8, JSON.stringify(refreshed));
  // A refused submission is recoverable: a bad line number.
  await page.evaluate(() => { document.querySelector('#comment-form details.result-pin').open = true; });
  await page.fill('#comment-form [name="path"]', 'src/payout.ts');
  await page.fill('#comment-form [name="line"]', 'abc');
  await page.waitForTimeout(150);
  await submit(page, '#comment-form button[type="submit"]');
  const refused = { words: await page.evaluate(() => document.querySelector('.problem')?.textContent ?? ''), back: await page.evaluate(() => document.querySelector('a[href^="/chat?task="]')?.getAttribute('href')) };
  check('c4 a refused submission says why and offers the way back to the result view', /line number/.test(refused.words) && refused.back === chatResult(task, runId), JSON.stringify(refused));
  await page.click(`a[href="${chatResult(task, runId)}"]`);
  await page.waitForLoadState('load');
  await page.waitForTimeout(200);
  const recovered = await page.evaluate(() => ({ note: document.querySelector('#comment-form [name="note"]')?.value, path: document.querySelector('#comment-form [name="path"]')?.value, line: document.querySelector('#comment-form [name="line"]')?.value }));
  check('c4 the draft (note, file, line) is restored after the refusal so it can be corrected', recovered.note === 'Draft: the EUR case is still uncovered.' && recovered.path === 'src/payout.ts' && recovered.line === 'abc', JSON.stringify(recovered));
  check('c4 the refused submission recorded nothing', fixture.store.liveDiffComments(runId).length === 0);
  // Another task's result on the same tab: nothing inherited.
  await goto(page, chatResult(fixture.statusTasks.attested, fixture.statusRuns.attested));
  const otherTask = await page.evaluate(() => ({ note: document.querySelector('#comment-form [name="note"]')?.value ?? '', panel: document.querySelector('[data-result-panel]')?.getAttribute('data-result-task') }));
  check('c4 another task\'s result view carries no draft from the first', otherTask.panel === fixture.statusTasks.attested && otherTask.note === '', JSON.stringify(otherTask));
  // A run that is not this task's: refused as a result view, conversation intact.
  await goto(page, chatResult(task, fixture.statusRuns.attested));
  const foreign = await page.evaluate(() => ({ panel: document.querySelector('[data-result-panel]') !== null, problem: document.querySelector('.problem')?.textContent ?? '', task: document.querySelector('.composer')?.getAttribute('data-chat-task') }));
  check('c4 a result id from another task is refused for this lens; the conversation shows without it', !foreign.panel && /not available for this task/.test(foreign.problem) && foreign.task === task, JSON.stringify(foreign));
  // Another account on the same tab inherits nothing.
  const second = addApprover(fixture.store, 'second-reviewer', new Date(), { name: fixture.name, token: fixture.password });
  if (!second.ok) throw new Error('second approver');
  await page.evaluate(async () => { await fetch('/logout', { method: 'POST', credentials: 'same-origin', redirect: 'manual' }); });
  await loginAs(page, 'second-reviewer', second.token);
  await goto(page, chatResult(task, runId));
  const otherAccount = await page.evaluate(() => ({ note: document.querySelector('#comment-form [name="note"]')?.value ?? '', keys: Object.keys(sessionStorage).filter(k => k.startsWith('standing-orders:review-draft:')) }));
  check('c4 another account on the same tab sees no draft and the first account\'s draft keys are gone', otherAccount.note === '' && otherAccount.keys.every(k => !k.includes(`:${fixture.name}:`)), JSON.stringify(otherAccount));
  await cont.ctx.close();

  // ---- c5: phone views ---------------------------------------------------------
  for (const [name, viewport] of [['phone', VIEWPORTS.phone], ['narrow', VIEWPORTS.narrow]]) {
    const mobile = await context(viewport);
    page = mobile.page;
    await freshConversation(page, `/chat?task=${task}`);
    await page.fill('.composer textarea', 'Unsent on the phone.');
    await page.waitForTimeout(150);
    await scrollTo(page, '.completion-receipt');
    await shot(page, `${name}-chat-receipt`, `${viewport.width}×${viewport.height}: the task conversation's result receipt with one Open result road (synthetic fixture)`);
    check(`c5 ${name} chat receipt has no horizontal overflow`, (await noOverflow(page)).ok);
    await page.click('.completion-receipt a[data-open-result]');
    await page.waitForLoadState('load');
    const dedicated = await page.evaluate(() => ({ chatHidden: !(document.querySelector('.chat-main')?.checkVisibility() ?? true), panel: document.querySelector('[data-result-panel]')?.checkVisibility() ?? false, back: document.querySelector('[data-result-back]')?.textContent, composerHidden: !(document.querySelector('.composer')?.checkVisibility() ?? true) }));
    check(`c5 ${name} opens a dedicated result view: conversation and composer out of the way, Back to chat first`, dedicated.chatHidden && dedicated.panel && dedicated.back === '← Back to chat' && dedicated.composerHidden, JSON.stringify(dedicated));
    check(`c5 ${name} result view has no horizontal overflow`, (await noOverflow(page)).ok);
    const backRect = await rect(page, '[data-result-back] a, a[data-result-back]');
    const tabRects = await page.evaluate(() => [...document.querySelectorAll('[data-result-tab]')].map(t => { const r = t.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height }; }));
    const tabsFit = tabRects.length === 3 && tabRects.every((r, i) => r.left >= 0 && r.right <= viewport.width && r.height >= 40 && (i === 0 || r.left >= tabRects[i - 1].right - 1));
    check(`c5 ${name} Back to chat (44px tall) and the three tabs (40px+) are inside the viewport and do not overlap`, fits(backRect, viewport) && backRect.height >= 44 && tabsFit, JSON.stringify({ backRect, tabRects }));
    await shot(page, `${name}-result-summary`, `${viewport.width}×${viewport.height}: the dedicated result view — Summary with the validated screenshot (synthetic fixture)`);
    await page.click('[data-result-tab="changes"]');
    await page.waitForTimeout(100);
    const diffBox = await page.evaluate(() => { const lines = document.querySelector('.diff-lines'); const doc = document.documentElement; return { lines: lines !== null, docOk: doc.scrollWidth <= doc.clientWidth, scrollsInside: lines !== null && lines.scrollWidth >= lines.clientWidth }; });
    check(`c5 ${name} Changes shows the diff scrolling within its own region, never the page`, diffBox.lines && diffBox.docOk, JSON.stringify(diffBox));
    await shot(page, `${name}-result-changes`, `${viewport.width}×${viewport.height}: Changes — the file list and the sealed diff in its own scrolling region (synthetic fixture)`);
    await scrollTo(page, '#request-changes', 60);
    const addNote = await rect(page, '#comment-form button[type="submit"]');
    const tabBar = await rect(page, 'nav.tabbar');
    const clear = addNote !== null && (tabBar === null || addNote.bottom <= tabBar.top || addNote.top >= tabBar.bottom);
    check(`c5 ${name} Add note is reachable and not under the tab bar`, addNote !== null && addNote.left >= 0 && addNote.right <= viewport.width && addNote.height >= 40 && clear, JSON.stringify({ addNote, tabBar }));
    await shot(page, `${name}-request-changes`, `${viewport.width}×${viewport.height}: Request changes beside the result — note, optional pin, Add note (synthetic fixture)`);
    if (name === 'phone') {
      await page.fill('#comment-form [name="note"]', 'Phone review: keep the footer aligned with the rounded rows.');
      await submit(page, '#comment-form button[type="submit"]');
      const phoneBatch = fixture.store.liveDiffComments(runId).map(one => one.id);
      await submit(page, '.result-request form[action$="/revise"] button[type="submit"]');
      const child = fixture.store.revisionsFromRun(runId).at(-1)?.id;
      check('c5 phone result-to-revision journey seals exactly its note and still needs approval', phoneBatch.length === 1 && revisionLocationIs(page.url(), task, child) && fixture.store.getScope(child)?.approvedAt === null && fixture.store.allDiffComments(runId).find(one => one.id === phoneBatch[0])?.consumedBy === child, JSON.stringify({ child, phoneBatch }));
      await shot(page, 'phone-revision-created', '390×844: revision created from phone feedback, with its own approval still required (synthetic fixture)');
      await goto(page, chatResult(task, runId));
    }
    // Back to chat keeps the phone draft too.
    await page.click('[data-result-back]');
    await page.waitForLoadState('load');
    await page.waitForTimeout(200);
    check(`c4 ${name} Back to chat keeps the unsent phone draft`, (await page.evaluate(() => document.querySelector('.composer textarea').value)) === 'Unsent on the phone.');
    // The run page and the cockpit at this size.
    await goto(page, `/r/${runId}`);
    check(`c5 ${name} run page has no horizontal overflow`, (await noOverflow(page)).ok);
    await goto(page, `/review?result=${task}`);
    check(`c5 ${name} review cockpit has no horizontal overflow`, (await noOverflow(page)).ok);
    await mobile.ctx.close();
  }
  // Desktop run page and cockpit captures.
  const wide = await context(VIEWPORTS.desktop);
  page = wide.page;
  await goto(page, `/r/${runId}?tab=changes`);
  check('c5 desktop run page has no horizontal overflow', (await noOverflow(page)).ok);
  await shot(page, 'desktop-run-changes', 'Desktop 1440×900: the run page\'s result panel on Changes with View / Annotate (synthetic fixture)');
  await goto(page, `/review?result=${task}`);
  check('c5 desktop review cockpit has no horizontal overflow', (await noOverflow(page)).ok);
  await scrollTo(page, '.result-panel');
  await shot(page, 'desktop-review-cockpit', 'Desktop 1440×900: the review cockpit with the same result panel under its queue and next action (synthetic fixture)');
  await wide.ctx.close();

  // ---- c7: a request identity is bound to what it sent -----------------------
  const c7 = await context(VIEWPORTS.desktop);
  page = c7.page;
  await goto(page, `/r/${runId}`);
  const csrf7 = await page.evaluate(() => document.querySelector('input[name="csrf"]')?.value ?? '');
  const notesBefore7 = fixture.store.liveDiffComments(runId).length;
  const requestOf = () => page.evaluate(() => document.querySelector('#comment-form [name="request"]').value);
  await page.fill('#comment-form [name="note"]', 'Retry A: round the CSV footer too.');
  const tokenA = await requestOf();
  // Exact independent reproduction: send current FormData with fetch and
  // leave the document in place. No synthetic submit event can hide the bug.
  const lost = await page.evaluate(async () => {
    const form = document.getElementById('comment-form');
    const r = await fetch(form.action, { method: 'POST', body: new URLSearchParams(new FormData(form)), redirect: 'manual' });
    return { status: r.status, type: r.type };
  });
  const draftAfterLost = await page.evaluate(() => JSON.parse(sessionStorage.getItem(Object.keys(sessionStorage).find(k => k.startsWith('standing-orders:review-draft:')) ?? '') ?? 'null'));
  const retried = await postFrom(page, `/r/${runId}/comment`, { csrf: csrf7, note: 'Retry A: round the CSV footer too.', request: tokenA, return: `/r/${runId}` });
  check('c7 direct FormData with a missed receipt and unchanged retry records exactly once', (lost.status === 0 || lost.status === 303) && (retried.status === 0 || retried.status === 303) && fixture.store.liveDiffComments(runId).length === notesBefore7 + 1 && draftAfterLost?.request === tokenA, JSON.stringify({ lost, retried, draftAfterLost }));
  // Unchanged: the identity stays (a retry would record once). Edited: a new one, before any click.
  await page.evaluate(() => { const box = document.querySelector('#comment-form [name="note"]'); box.dispatchEvent(new Event('input', { bubbles: true })); });
  const unchangedToken = await requestOf();
  await page.fill('#comment-form [name="note"]', 'Retry B: round the CSV footer AND the JSON export the same way.');
  const tokenB = await requestOf();
  check('c7 an unchanged retry keeps its identity; editing the note mints a new immutable one at once', unchangedToken === tokenA && /^[a-f0-9]{32}$/.test(tokenB) && tokenB !== tokenA, JSON.stringify({ tokenA, unchangedToken, tokenB }));
  // The edited words land under their own identity; A is untouched; B's own receipt clears B's draft.
  await page.evaluate(() => document.getElementById('comment-form').removeAttribute('aria-busy'));
  await submit(page, '#comment-form button[type="submit"]');
  const notes7 = fixture.store.liveDiffComments(runId).map(one => one.note);
  const afterB = { url: page.url(), note: await page.evaluate(() => document.querySelector('#comment-form [name="note"]')?.value ?? null) };
  check('c7 the edited note is recorded as a second note under the new identity, the first stays, and the draft clears on ITS receipt', notes7.includes('Retry A: round the CSV footer too.') && notes7.includes('Retry B: round the CSV footer AND the JSON export the same way.') && fixture.store.liveDiffComments(runId).length === notesBefore7 + 2 && afterB.url.includes(`noted=${tokenB}`) && afterB.note === '', JSON.stringify({ notes7, afterB }));
  // The reviewer's direct replay: identity A with different words → refused, nothing recorded, way back names the conflict.
  const conflicting = await page.evaluate(async ([p, f]) => { const r = await fetch(p, { method: 'POST', body: new URLSearchParams(f), credentials: 'same-origin' }); return { status: r.status, text: await r.text() }; }, [`/r/${runId}/comment`, { csrf: csrf7, note: 'Retry C: different words, old identity.', request: tokenA, return: `/r/${runId}` }]);
  check('c7 the same identity with different words is refused (409) with the draft\'s way back carrying ?conflict=<token>; nothing is recorded', conflicting.status === 409 && conflicting.text.includes('already recorded a different note') && conflicting.text.includes(`href="/r/${runId}?conflict=${tokenA}#request-changes"`) && fixture.store.liveDiffComments(runId).length === notesBefore7 + 2, JSON.stringify({ status: conflicting.status, count: fixture.store.liveDiffComments(runId).length }));
  const crossRun = fixture.statusRuns.attested;
  const crossCsrf = csrf7;
  const crossed = await page.evaluate(async ([p, f]) => { const r = await fetch(p, { method: 'POST', body: new URLSearchParams(f), credentials: 'same-origin' }); return { status: r.status, text: await r.text() }; }, [`/r/${crossRun}/comment`, { csrf: crossCsrf, note: 'Retry A: round the CSV footer too.', request: tokenA, return: `/r/${crossRun}` }]);
  check('c7 the same identity on another result is refused (409); that result records nothing', crossed.status === 409 && crossed.text.includes('already used on another result') && fixture.store.liveDiffComments(crossRun).length === 0, JSON.stringify({ status: crossed.status, count: fixture.store.liveDiffComments(crossRun).length }));
  // Coming back from that refusal: the words are kept, the identity is new.
  await page.evaluate(([k, t]) => { sessionStorage.setItem(k, JSON.stringify({ note: 'Retry C: different words, old identity.', path: '', line: '', request: t, sent: null, at: Date.now() })); }, [`standing-orders:review-draft:${fixture.name}:${task}:${runId}`, tokenA]);
  await goto(page, `/r/${runId}?conflict=${tokenA}#request-changes`);
  const recovered7 = { note: await page.evaluate(() => document.querySelector('#comment-form [name="note"]')?.value), token: await requestOf() };
  check('c7 the refusal\'s way back keeps the draft and rotates its identity', recovered7.note === 'Retry C: different words, old identity.' && /^[a-f0-9]{32}$/.test(recovered7.token) && recovered7.token !== tokenA, JSON.stringify(recovered7));
  await shot(page, 'desktop-c7-draft-recovered', 'Desktop 1440×900: after a refused identity conflict, the draft words are kept under a fresh request identity (synthetic fixture)');
  await page.evaluate(() => sessionStorage.clear());

  // ---- c8: the seal binds the displayed batch ---------------------------------
  await goto(page, `/r/${runId}`);
  const revisionsBefore8 = fixture.store.revisionsFromRun(runId).length;
  const oldSeal = await page.evaluate(() => Object.fromEntries(new FormData(document.querySelector('.result-request form[action$="/revise"]')).entries()));
  const batchA = fixture.store.liveDiffComments(runId).map(one => one.id);
  check('c8 the rendered seal names exactly the live notes shown and the source terms', oldSeal.batch === batchA.join(',') && oldSeal.source === fixture.store.getScope(task).digest, JSON.stringify(oldSeal));
  await submit(page, '.result-request form[action$="/revise"] button[type="submit"]');
  const childX = fixture.store.revisionsFromRun(runId).at(-1)?.id ?? '';
  check('c8 the seal creates one child from that batch', fixture.store.revisionsFromRun(runId).length === revisionsBefore8 + 1 && revisionLocationIs(page.url(), task, childX), JSON.stringify({ childX, url: page.url() }));
  // A new note C, then the OLD seal body replayed byte for byte.
  await goto(page, `/r/${runId}`);
  await page.fill('#comment-form [name="note"]', 'Note C: added after the seal.');
  await submit(page, '#comment-form button[type="submit"]');
  const idC = fixture.store.liveDiffComments(runId).find(one => one.note === 'Note C: added after the seal.')?.id;
  const replayedOld = await postFrom(page, `/r/${runId}/revise`, oldSeal);
  const afterReplay = { revisions: fixture.store.revisionsFromRun(runId).map(one => one.id), live: fixture.store.liveDiffComments(runId).map(one => one.id), consumedC: fixture.store.allDiffComments(runId).find(one => one.id === idC)?.consumedBy ?? null };
  check('c8 replaying the old seal after a new note returns the original child and never consumes the new note', (replayedOld.status === 0 || replayedOld.status === 303) && afterReplay.revisions.length === revisionsBefore8 + 1 && afterReplay.live.length === 1 && afterReplay.live[0] === idC && afterReplay.consumedC === null, JSON.stringify({ replayedOld, afterReplay }));
  // Two tabs: tab 1 shows [C]; tab 2 shows [C, D]; tab 1 seals; tab 2 is refused whole and reloads to [D].
  const tabOne = await c7.ctx.newPage();
  await tabOne.goto(`${fixture.url}/r/${runId}`); await tabOne.waitForLoadState('load');
  await page.reload({ waitUntil: 'load' });
  await page.fill('#comment-form [name="note"]', 'Note D: from the second tab.');
  await submit(page, '#comment-form button[type="submit"]');
  const tabTwoSeal = await page.evaluate(() => Object.fromEntries(new FormData(document.querySelector('.result-request form[action$="/revise"]')).entries()));
  const tabOneSeal = await tabOne.evaluate(() => Object.fromEntries(new FormData(document.querySelector('.result-request form[action$="/revise"]')).entries()));
  await tabOne.evaluate(() => { window.__staleDocument = true; });
  await tabOne.click('.result-request form[action$="/revise"] button[type="submit"]');
  await tabOne.waitForFunction(() => window.__staleDocument === undefined, null, { timeout: 15000 });
  await tabOne.waitForLoadState('load');
  const childY = fixture.store.revisionsFromRun(runId).at(-1)?.id ?? '';
  await submit(page, '.result-request form[action$="/revise"] button[type="submit"]');
  const idD = fixture.store.allDiffComments(runId).find(one => one.note === 'Note D: from the second tab.')?.id;
  const twoTabs = { one: tabOneSeal.batch, two: tabTwoSeal.batch, refused: await page.evaluate(() => document.querySelector('.problem')?.textContent ?? ''), url: page.url(), revisions: fixture.store.revisionsFromRun(runId).map(one => one.id), live: fixture.store.liveDiffComments(runId).map(one => one.id) };
  check('c8 two tabs: the first seals [C]; the second\'s [C, D] is refused whole (names the child that took C) and D stays live — no twin', twoTabs.one === String(idC) && twoTabs.two === `${idC},${idD}` && twoTabs.refused.includes(`already sealed into revision ${childY}`) && twoTabs.revisions.length === revisionsBefore8 + 2 && twoTabs.live.length === 1 && twoTabs.live[0] === idD, JSON.stringify(twoTabs));
  await shot(page, 'desktop-c8-two-tab-refusal', 'Desktop 1440×900: the second tab\'s stale batch refused whole, naming the revision that sealed part of it (synthetic fixture)');
  await goto(page, `/r/${runId}`);
  const reloadedSeal = await page.evaluate(() => Object.fromEntries(new FormData(document.querySelector('.result-request form[action$="/revise"]')).entries()));
  check('c8 the refused tab reloads to exactly the remaining note', reloadedSeal.batch === String(idD), JSON.stringify(reloadedSeal));
  await tabOne.close();

  // ---- c10: a revision's standing is the shared projection's words ---------
  const revisionLine = async () => page.evaluate(id => { const p = document.querySelector(`[data-result-revision="${id}"]`); return p === null ? null : { approved: p.getAttribute('data-result-revision-approved'), words: p.querySelector('.meta')?.textContent.replace(/^· /, '') ?? '' }; }, childX);
  const rowWords = async () => { const text = await html('/work?view=all'); const row = text.split(`data-task="${childX}"`)[1] ?? ''; return /<span class="status-label">([^<]*)<\/span>/.exec(row)?.[1] ?? null; };
  await goto(page, `/r/${runId}`);
  const standing = { unapproved: await revisionLine(), unapprovedRow: await rowWords() };
  const childScope = fixture.store.getScope(childX);
  approve(fixture.store, childX, fixture.name, new Date(), childScope.digest, fixture.password);
  await page.reload({ waitUntil: 'load' });
  standing.approved = await revisionLine(); standing.approvedRow = await rowWords();
  fixture.store.hold(fixture.store.lookupRef(childX).id, 'Wait for the footer decision.', null, new Date());
  await page.reload({ waitUntil: 'load' });
  standing.held = await revisionLine(); standing.heldRow = await rowWords();
  fixture.store.unhold(fixture.store.lookupRef(childX).id);
  propose(fixture.store, { taskId: childX, goal: `${childScope.goal} — and the header row`, outOfScope: childScope.outOfScope, touches: childScope.touches, acceptance: childScope.acceptance, now: new Date() });
  await page.reload({ waitUntil: 'load' });
  standing.rescoped = await revisionLine(); standing.rescopedRow = await rowWords();
  standing.rescopedStampKept = fixture.store.getScope(childX)?.approvedAt !== null;
  check('c10 unapproved → needs your approval, the same words as the child\'s Work row', standing.unapproved?.approved === '0' && standing.unapproved?.words === 'Needs you' && standing.unapproved?.words === standing.unapprovedRow, JSON.stringify(standing));
  check('c10 approved exactly → approval no longer asked for, and not "building" (nothing runs); the Work row agrees', standing.approved?.approved === '1' && !/approval|building/i.test(standing.approved?.words ?? '') && standing.approved?.words === standing.approvedRow, JSON.stringify(standing));
  check('c10 held after approval → On hold, never building', standing.held?.approved === '1' && standing.held?.words === 'On hold' && standing.held?.words === standing.heldRow, JSON.stringify(standing));
  check('c10 rescoped after approval → the old stamp is no approval: needs your approval again', standing.rescopedStampKept && standing.rescoped?.approved === '0' && standing.rescoped?.words === 'Needs you' && standing.rescoped?.words === standing.rescopedRow, JSON.stringify(standing));
  await scrollTo(page, '#request-changes');
  await shot(page, 'desktop-c10-revision-standing', 'Desktop 1440×900: the sealed revision\'s line after approve-then-rescope — needs approval again (synthetic fixture)');
  await c7.ctx.close();

  }
  // ---- c9: a corrupted check log is damaged evidence everywhere --------------
  const logTask = fixture.statusTasks.corruptLog, logRun = fixture.statusRuns.corruptLog;
  const logArtifact = fixture.store.artifactsFor(logRun).find(one => one.kind === 'check-log');
  const logSurfaces = { 'task receipt': await factsOf(`/t/${logTask}`), 'chat receipt': await factsOf(`/chat?task=${logTask}`), 'run page': await factsOf(`/r/${logRun}?tab=checks`), 'review cockpit': await factsOf(`/review?result=${logTask}`) };
  for (const [name, one] of Object.entries(logSurfaces)) {
    const shared = one.text.slice(one.text.indexOf('data-result-run="'), one.text.lastIndexOf('</section>'));
    check(`c9 ${name}: the corrupted check log counts as an evidence problem, the readiness word is gone, the problem is named, and no download of it is offered`, one.first?.evidence === 'problems:1' && one.text.includes('data-work-status="evidence-damaged"') && !one.text.includes('data-work-status="ready-to-review"') && one.text.includes('The check log no longer verifies (') && !shared.includes(`/evidence/${logArtifact.id}"`) && !one.text.includes('0 passed, 214 failed'), JSON.stringify({ facts: one.first, damaged: one.text.includes('data-work-status="evidence-damaged"') }));
  }
  const logRoad = await fetch(`${fixture.url}/r/${logRun}/evidence/${logArtifact.id}`, { headers: { cookie: cookieHeader } });
  check('c9 the evidence road refuses the corrupted check log bytes (410)', logRoad.status === 410, String(logRoad.status));
  const c9 = await context(VIEWPORTS.desktop);
  page = c9.page;
  await goto(page, `/r/${logRun}?tab=checks`);
  const logView = await page.evaluate(() => ({ status: document.querySelector('.result-head .status-line')?.textContent.trim(), attention: document.querySelector('[data-result-attention]')?.textContent ?? '', damaged: document.querySelector('[data-check-log="damaged"]')?.textContent ?? '', fullLink: /Open the full check log|Download the full/.test(document.body.textContent) }));
  check('c9 the run page says it in the open: status, attention, and the withheld output with nothing to download', /some saved material is unavailable/.test(logView.status ?? '') && /check log no longer verifies/.test(logView.attention) && /nothing to download/.test(logView.damaged) && !logView.fullLink, JSON.stringify(logView));
  await shot(page, 'desktop-c9-corrupt-check-log', 'Desktop 1440×900: a verified build whose check log was altered on disk — evidence unavailable, output withheld, no download (synthetic fixture)');
  // A SHORTENED log (the damaged fixture) is described as the stored part, never the full bytes.
  const shortenedText = await html(`/r/${fixture.statusRuns.damaged}?tab=checks`);
  check('c9 a shortened check log\'s download is described as the stored part only', /Download the stored part of the check log \(shortened at storage — not the full check log\)/.test(shortenedText) && /Check output \(shortened — [0-9]+ of [0-9]+ bytes stored\)/.test(shortenedText) && !/Open the full check log/.test(shortenedText), '');
  await c9.ctx.close();

  // ---- c11: deliverable first, one outcome, one action, 44px Back -----------
  for (const [name, viewport] of [['desktop', VIEWPORTS.desktop], ['phone', VIEWPORTS.phone], ['narrow', VIEWPORTS.narrow]]) {
    const c11 = await context(viewport);
    page = c11.page;
    await goto(page, chatResult(task, runId));
    const shape = await page.evaluate(() => {
      const panel = document.querySelector('[data-result-panel]');
      const rectOf = el => { if (!el) return null; const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height, width: r.width, left: r.left, right: r.right }; };
      const before = []; for (const el of panel.children) { if (el.matches('.result-view')) break; before.push(el.className || el.tagName.toLowerCase()); }
      return {
        back: rectOf(document.querySelector('[data-result-back]')),
        outcome: document.querySelector('.result-summary')?.textContent ?? '',
        outcomeLines: (() => { const el = document.querySelector('.result-summary'); if (!el) return null; return Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)); })(),
        actions: [...document.querySelectorAll('[data-result-action]')].map(a => a.getAttribute('data-result-action')),
        actionText: document.querySelector('[data-result-action] .button-link, [data-result-action] button')?.textContent.trim() ?? null,
        deliverable: rectOf(document.querySelector('[data-result-view="summary"] .result-visuals img')),
        detailsClosed: [...document.querySelectorAll('.result-notes, .result-details')].map(d => [d.className, d.open]),
        factsInside: document.querySelector('.result-details .result-facts') !== null,
        linksInside: document.querySelector('.result-details .result-links') !== null,
        changesInside: document.querySelector('.result-notes .result-changes') !== null,
        panelOrder: before,
        attentionOpen: document.querySelector('.result-panel [data-result-attention]') !== null,
        overflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      };
    });
    check(`c11 ${name}: one bounded outcome line, one action, the deliverable inside the first viewport, the agent's account and the technical facts behind closed disclosures, no page overflow`,
      shape.outcome.length > 0 && shape.outcome.length <= 181 && shape.actions.length === 1 && /^(Request changes|Revise from [0-9]+ notes?)$/.test(shape.actionText ?? '') && shape.deliverable !== null && shape.deliverable.top < viewport.height && shape.detailsClosed.length === 2 && shape.detailsClosed.every(([, open]) => open === false) && shape.factsInside && shape.linksInside && shape.changesInside && !shape.attentionOpen && shape.overflow,
      JSON.stringify(shape));
    if (viewport.width < 760) check(`c11 ${name}: Back to chat has a 44px target inside the viewport`, shape.back !== null && shape.back.height >= 44 && fits(shape.back, viewport), JSON.stringify(shape.back));
    await shot(page, `${name}-c11-summary`, `${viewport.width}×${viewport.height}: Summary after the repair — deliverable first, one outcome line, one action, details on demand (synthetic fixture)`);
    // Long feedback and paths must keep their input and primary act usable.
    await page.fill('#comment-form [name="note"]', 'Long feedback stays editable. '.repeat(18).slice(0, 500));
    await page.locator('#comment-form .result-pin summary').click();
    await page.fill('#comment-form [name="path"]', 'src/' + 'long-name-'.repeat(28) + '.ts');
    await scrollTo(page, '#comment-form button[type="submit"]', 160);
    const longForm = await page.evaluate(() => {
      const button = document.querySelector('#comment-form button[type="submit"]');
      const r = button.getBoundingClientRect(), bar = document.querySelector('nav.tabbar');
      const box = document.querySelector('#comment-form textarea');
      const lineHeight = parseFloat(getComputedStyle(button).lineHeight);
      return { fits: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && (!bar || !bar.checkVisibility() || r.bottom <= bar.getBoundingClientRect().top), height: r.height, noteLength: box.value.length, fontSize: parseFloat(getComputedStyle(box).fontSize), overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
    });
    check(`c5 ${name}: long feedback and path fit; Add note is reachable above fixed navigation`, longForm.fits && longForm.height >= 44 && longForm.noteLength === 500 && !longForm.overflow && (viewport.width > 760 || longForm.fontSize >= 16), JSON.stringify(longForm));
    if (name === 'narrow') await shot(page, 'narrow-long-feedback', '320×740: a 500-character review draft and long path keep Add note above the fixed navigation (synthetic fixture)');
    // Risks stay in the open: the damaged result's problems precede the tabs at this width too.
    await goto(page, chatResult(fixture.statusTasks.damaged, fixture.statusRuns.damaged));
    const risks = await page.evaluate(() => { const a = document.querySelector('.result-panel [data-result-attention]'); const t = document.querySelector('.result-tabs'); return { open: a !== null && a.checkVisibility(), aboveTabs: a !== null && t !== null && a.getBoundingClientRect().bottom <= t.getBoundingClientRect().top, status: document.querySelector('.result-head .status-line')?.textContent.trim() }; });
    check(`c11 ${name}: the damaged result keeps its risks open ahead of the tabs`, risks.open && risks.aboveTabs && /some saved material is unavailable/.test(risks.status ?? ''), JSON.stringify(risks));
    if (name === 'phone') await shot(page, 'phone-c11-risks-open', '390×844: a damaged result keeps its problems in the open ahead of the tabs (synthetic fixture)');
    await c11.ctx.close();
  }
  }
} catch (error) {
  if (latestPage && !latestPage.isClosed()) { await latestPage.screenshot({ path: join(out, 'failure.png'), fullPage: true }); console.log(await latestPage.locator('#comment-form').evaluate(form => ({ rect: form.getBoundingClientRect().toJSON(), height: document.documentElement.scrollHeight, top: scrollY, button: form.querySelector('button[type=submit]')?.getBoundingClientRect().toJSON() })).catch(() => null)); }
  check('proof ran to completion', false, error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  await browser.close();
  await fixture.stop();
}

const failed = report.checks.filter(one => !one.ok);
report.summary = { passed: report.checks.length - failed.length, failed: failed.length };
writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
console.log(`\n${report.summary.passed} passed, ${failed.length} failed → ${join(out, 'report.json')}`);
if (strict && failed.length > 0) process.exit(1);
