/** Current workspace journey: Chat / Tasks / Projects, truthful Ready and
 * explicit Complete, saved results, feedback and an explicit revision.
 * One desktop and one phone viewport, including real failure, empty and
 * long-content fixtures. Historical reviewer rows are read-only history.
 *
 *   node scripts/workspace-proof.mjs --strict [--out output/playwright/workspace]
 *   node scripts/workspace-proof.mjs --density-only --rev <git-rev> --out <dir>
 *
 * --status-only remains an alias for the current journey. --density-only
 * measures another built fixture/tree without asserting current behavior.
 * Everything is isolated synthetic data: no live DB, worker, key or model.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const flag = name => { const at = args.indexOf(name); return at === -1 ? null : args[at + 1] ?? null; };
const out = resolve(flag('--out') ?? 'output/playwright/workspace-1/after');
const strict = args.includes('--strict');
const densityOnly = args.includes('--density-only');
const contextOnly = args.includes('--context-only');
mkdirSync(out, { recursive: true });
/** Another tree's fixture: `--fixture <path>` names a built checkout's
 * `scripts/ui-polish-fixture.mjs`; `--rev <git-rev>` extracts that
 * revision with `git archive` (read-only) under `<out>/tree`, builds it
 * there against this checkout's node_modules, and uses its fixture — the
 * durable way to re-measure a sealed base or source with this measure. */
let fixtureModule = flag('--fixture');
const rev = flag('--rev');
if (rev !== null) {
  if (fixtureModule !== null) throw new Error('--rev and --fixture are exclusive');
  const tree = join(out, 'tree');
  rmSync(tree, { recursive: true, force: true });
  mkdirSync(tree, { recursive: true });
  execFileSync('git', ['archive', '-o', join(out, 'tree.tar'), rev]);
  execFileSync('tar', ['-xf', join(out, 'tree.tar'), '-C', tree]);
  rmSync(join(out, 'tree.tar'));
  symlinkSync(resolve('node_modules'), join(tree, 'node_modules'));
  execFileSync('npx', ['tsc', '-p', 'tsconfig.build.json'], { cwd: tree, stdio: 'inherit' });
  execFileSync('node', ['scripts/postbuild.mjs'], { cwd: tree, stdio: 'inherit' });
  fixtureModule = join(tree, 'scripts', 'ui-polish-fixture.mjs');
}
const { startFixture, LONG_ALLOWED_PATH, LONG_REQUEST_PATH } = await import(fixtureModule === null ? './ui-polish-fixture.mjs' : pathToFileURL(resolve(fixtureModule)).href);

async function loadPlaywright() {
  try { return await import('playwright'); } catch { /* not installed here */ }
  const candidates = [process.env.PLAYWRIGHT_MODULE].filter(Boolean);
  const npx = join(homedir(), '.npm', '_npx');
  if (existsSync(npx)) for (const dir of readdirSync(npx)) candidates.push(join(npx, dir, 'node_modules', 'playwright', 'index.mjs'));
  for (const one of candidates) if (existsSync(one)) return import(pathToFileURL(one).href);
  throw new Error('playwright not found: install it, or set PLAYWRIGHT_MODULE to its index.mjs');
}

const VIEWPORTS = { desktop: { width: 1440, height: 900 }, laptop: { width: 1280, height: 800 }, phone: { width: 390, height: 844 }, narrow: { width: 320, height: 740 } };
const report = { generatedAt: new Date().toISOString(), out, fixture: `synthetic — ${fixtureModule ?? 'scripts/ui-polish-fixture.mjs'} { secondProject: true }`, mode: densityOnly ? 'density-only' : contextOnly ? 'context-only' : 'current-journey', rev: rev === null ? null : { asked: rev, resolved: execFileSync('git', ['rev-parse', rev]).toString().trim() }, checks: [], payloads: {}, screenshots: [], statuses: {} };
const check = (name, ok, detail) => { report.checks.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

const { chromium } = await loadPlaywright();
const fixture = await startFixture({ secondProject: true, slowMs: 1500, statusPresentation: !densityOnly, assignmentPresentation: !densityOnly });
const browser = await chromium.launch();
const T = fixture.statusTasks;
const R = fixture.statusRuns;

async function context(viewport, extra = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: viewport.width < 760, hasTouch: viewport.width < 760, ...extra });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(`${fixture.url}/login`);
  await page.fill('input[name="name"]', fixture.name);
  await page.fill('input[name="token"]', fixture.password);
  await submit(page, 'button[type="submit"]');
  return { ctx, page };
}
const shot = async (page, name, caption) => {
  const path = join(out, `${name}.png`);
  await page.evaluate(() => { document.documentElement.style.scrollBehavior = 'auto'; });
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
  // Playwright completes finite motion and pauses infinite decoration for
  // the capture; an unrelated paused animation must not stall the journey.
  await page.screenshot({ path, fullPage: false, animations: 'disabled' });
  report.screenshots.push({ path, caption });
  return path;
};
/** Click a submit and wait for a NEW document — robust to the chat page's
 * own reload racing the POST redirect (a bare waitForNavigation aborts). */
async function submit(page, selector) {
  await page.evaluate(() => { window.__staleDocument = true; });
  await page.click(selector);
  await page.waitForFunction(() => window.__staleDocument === undefined, null, { timeout: 15000 });
  await page.waitForLoadState('load');
  await page.waitForTimeout(200);
}
/** POST the switcher's own form (the session's csrf) and land on a page. */
async function switchProject(page, action, path, returnTo = '/work') {
  await page.goto(`${fixture.url}/projects`);
  await page.evaluate(([action, path, returnTo]) => {
    window.__staleDocument = true;
    const csrf = document.querySelector('input[name="csrf"]')?.value ?? '';
    const form = document.createElement('form'); form.method = 'post'; form.action = action;
    for (const [name, value] of [['csrf', csrf], ['path', path], ['return', returnTo]]) { const input = document.createElement('input'); input.name = name; input.value = value; form.appendChild(input); }
    document.body.appendChild(form); form.submit();
  }, [action, path, returnTo]);
  // A NEW document, not the already-loaded opener: waitForLoadState alone
  // returns at once and the next goto would abort the switch.
  await page.waitForFunction(() => window.__staleDocument === undefined, null, { timeout: 15000 });
  await page.waitForLoadState('load');
  if (new URL(page.url()).pathname !== returnTo) throw new Error(`project switch landed on ${page.url()} — ${await page.evaluate(() => document.querySelector('.problem')?.textContent ?? 'no problem text')}`);
}
const openProject = (page, path) => switchProject(page, '/projects/open', path);
const noOverflow = page => page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, ok: document.documentElement.scrollWidth <= document.documentElement.clientWidth }));
const scrollTo = (page, selector, offset = 72) => page.evaluate(([sel, off]) => { const el = document.querySelector(sel); if (!el) return false; document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - off, behavior: 'instant' }); return true; }, [selector, offset]);
const hrefs = (page, selector) => page.evaluate(sel => [...document.querySelectorAll(`${sel} a`)].map(a => a.getAttribute('href')), selector);
const visible = (page, selector) => page.evaluate(sel => { const el = document.querySelector(sel); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; }, selector);
/** Every Work filter's own bounds (review fixes): inside the viewport and
 * its strip, a usable target, legible type, no clipped words. */
const filterBoxes = (page, viewport) => page.evaluate(([vw]) => {
  const strip = document.querySelector('.work-views');
  const stripRect = strip?.getBoundingClientRect() ?? null;
  return [...document.querySelectorAll('.work-views a')].map(a => {
    const r = a.getBoundingClientRect();
    const style = getComputedStyle(a);
    const label = a.childNodes[0]?.textContent?.trim() ?? '';
    return {
      label, count: a.querySelector('.count')?.textContent ?? null,
      left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height),
      fontPx: parseFloat(style.fontSize), clipped: a.scrollWidth > a.clientWidth + 1,
      insideViewport: r.left >= 0 && r.right <= vw,
      insideStrip: stripRect !== null && r.left >= stripRect.left - 0.5 && r.right <= stripRect.right + 0.5,
      stripScrolls: strip !== null && strip.scrollWidth > strip.clientWidth + 1,
    };
  });
}, [viewport.width]);
const statusOf = (page, selector) => page.evaluate(sel => { const el = document.querySelector(sel); if (!el) return null; const line = el.matches('.status-line') ? el : el.querySelector('.status-line'); return { token: (line ?? el).getAttribute('data-work-status'), label: line?.querySelector('.status-label')?.textContent ?? el.querySelector('.dispatch-copy > strong, h2')?.textContent ?? null }; }, selector);
/** Visible density (concise pass; corrected by its independent review):
 * what a reader actually sees in the first viewport's UNOBSCURED band —
 * between any fixed or sticky chrome pinned at the top (the phone header)
 * and at the bottom (the phone tab bar), measured from their live boxes at
 * scroll 0, never from innerHeight alone. Rendered text only — every text
 * node whose client rects intersect the band, from elements that are
 * computed visible (a closed <details> body, display:none, and aria-hidden
 * never count). The text figures are ESTIMATES: a node's characters are
 * prorated by the share of its rects inside the band, and lines are the
 * distinct 6px-bucketed rect tops — sampling, not a glyph count. Whole
 * Work rows inside the band, the band itself, and the document height
 * are exact. */
const visibleDensity = (page, viewport) => page.evaluate(([vw, vh]) => {
  const main = document.querySelector('main');
  const mainRect = main?.getBoundingClientRect() ?? { left: 0, right: vw };
  let top = 0, bottom = vh;
  const occluders = [];
  for (const el of document.body.querySelectorAll('*')) {
    if (main !== null && main.contains(el)) continue;
    const style = getComputedStyle(el);
    if (style.position !== 'fixed' && style.position !== 'sticky') continue;
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0 || r.right <= mainRect.left || r.left >= mainRect.right) continue;
    const name = `${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).trim().split(/\s+/).join('.')}` : ''}`;
    if (r.top <= 0.5 && r.bottom < vh / 2) { if (r.bottom > top) top = r.bottom; occluders.push({ element: name, edge: 'top', position: style.position, top: Math.round(r.top), bottom: Math.round(r.bottom) }); }
    else if (r.bottom >= vh - 0.5 && r.top > vh / 2) { if (r.top < bottom) bottom = r.top; occluders.push({ element: name, edge: 'bottom', position: style.position, top: Math.round(r.top), bottom: Math.round(r.bottom) }); }
  }
  const inBand = r => r.bottom > top && r.top < bottom && r.right > 0 && r.left < vw;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let chars = 0;
  const lineTops = new Set();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const el = node.parentElement;
    if (!el || el.closest('script,style,noscript,template,[aria-hidden="true"]')) continue;
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const all = [...range.getClientRects()].filter(r => r.width > 0 && r.height > 0);
    if (all.length === 0) continue;
    const shown = all.filter(inBand);
    if (shown.length === 0) continue;
    chars += Math.round(text.length * shown.length / all.length);
    for (const r of shown) lineTops.add(Math.round(r.top / 6));
  }
  const rows = [...document.querySelectorAll('.work-row')].map(row => row.getBoundingClientRect());
  return {
    viewport: `${vw}x${vh}`,
    method: 'the viewport at its current scroll; the unobscured band excludes fixed/sticky chrome pinned at the top or bottom edge; text figures are ESTIMATES (characters prorated by the share of each text node\'s rects inside the band; lines are distinct 6px-bucketed rect tops); whole rows, the band, and the document height are exact',
    scrollY: Math.round(window.scrollY),
    unobscuredBand: { top: Math.round(top), bottom: Math.round(bottom), height: Math.round(bottom - top) },
    occluders,
    documentHeight: document.documentElement.scrollHeight,
    visibleCharsEstimate: chars,
    visibleTextLinesEstimate: lineTops.size,
    rowsWhollyVisible: rows.filter(r => r.top >= top && r.bottom <= bottom).length,
    rowsPartlyVisible: rows.filter(r => r.bottom > top && r.top < bottom).length,
    rowsTotal: rows.length,
    firstRowTop: rows[0] ? Math.round(rows[0].top) : null,
    lastWholeRowBottom: rows.filter(r => r.top >= top && r.bottom <= bottom).reduce((max, r) => Math.max(max, Math.round(r.bottom)), 0) || null,
    meanRowHeight: rows.length === 0 ? null : Math.round(rows.reduce((sum, r) => sum + r.height, 0) / rows.length),
  };
}, [viewport.width, viewport.height]);
const countsOf = page => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.work-views a')].map(a => [a.childNodes[0].textContent.trim(), Number(a.querySelector('.count')?.textContent)])));
const rowsOf = page => page.evaluate(() => [...document.querySelectorAll('.work-row')].map(row => ({ id: row.getAttribute('data-task'), token: row.getAttribute('data-work-status'), views: row.getAttribute('data-work-views').split(' '), label: row.querySelector('.status-label')?.textContent ?? null })));
/** The Work tools menu's live geometry (concise revision): open or not,
 * its own box, every destination's box and visibility, and the document's
 * width while it is open — the 390px overflow the review found could only
 * be seen with the menu OPEN. */
const menuBounds = (page, viewport, desktop = false) => page.evaluate(([vw, vh, desktop]) => {
  const details = document.querySelector(desktop ? 'aside.side [data-group="tools"]' : '.work-tools');
  const menu = details?.querySelector('nav');
  const r = menu?.getBoundingClientRect() ?? null;
  const box = b => ({ left: Math.round(b.left * 10) / 10, right: Math.round(b.right * 10) / 10, top: Math.round(b.top), bottom: Math.round(b.bottom), width: Math.round(b.width), height: Math.round(b.height) });
  const links = [...(menu?.querySelectorAll('a') ?? [])].map(a => {
    const b = a.getBoundingClientRect();
    const style = getComputedStyle(a);
    return { href: a.getAttribute('href'), ...box(b), positiveSize: b.width > 0 && b.height > 0, insideViewport: b.left >= 0 && b.right <= vw && b.top >= 0 && b.bottom <= vh, computedVisible: style.display !== 'none' && style.visibility !== 'hidden' && a.checkVisibility() };
  });
  return {
    open: details?.open ?? false,
    menu: r === null ? null : box(r),
    positiveSize: r !== null && r.width > 0 && r.height > 0,
    insideViewport: r !== null && r.left >= 0 && r.right <= vw && r.top >= 0 && r.bottom <= vh,
    links,
    scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth,
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  };
}, [viewport.width, viewport.height, desktop]);
/** A NEW empty conversation: end any open one, then mint. */
async function freshConversation(page) {
  await page.goto(`${fixture.url}/chat`);
  if (await page.$('form[action="/chat/mate/end"]')) { await page.evaluate(() => { const d = document.querySelector('.chat-session-details'); if (d) d.open = true; }); await submit(page, 'form[action="/chat/mate/end"] button[type="submit"]'); }
  await page.fill('form[action="/chat/mate/mint"] input[name="token"]', fixture.password);
  await submit(page, 'form[action="/chat/mate/mint"] button[type="submit"]');
  await page.waitForTimeout(400);
}
/** The density pass: the same surfaces, fixture, exact viewports, and
 * measure on ANY tree, so before, source, and after are compared with one
 * function. It records numbers and exact-viewport screenshots; the checks
 * live in the sections above and never run here. */
async function densityPass() {
  report.density = {};
  const record = async (key, page, viewport, name, caption) => { report.density[key] = await visibleDensity(page, viewport); await shot(page, name, caption); };
  for (const [name, viewport] of [['narrow', VIEWPORTS.narrow], ['phone', VIEWPORTS.phone], ['desktop', VIEWPORTS.desktop]]) {
    const { ctx, page } = await context(viewport);
    await openProject(page, fixture.repos.main);
    await page.goto(`${fixture.url}/work`);
    await record(`work-${name}`, page, viewport, `density-${name}-work-all`, `Work · All at ${viewport.width}×${viewport.height}, the first viewport (fixture)`);
    await page.click('.work-tools > summary');
    await page.waitForTimeout(150);
    report.density[`work-${name}-tools-open`] = await menuBounds(page, viewport);
    await shot(page, `density-${name}-work-tools-open`, `Work with the tools menu OPEN at ${viewport.width}×${viewport.height} (fixture)`);
    await ctx.close();
  }
  for (const [name, viewport] of [['phone', VIEWPORTS.phone], ['1440x900', VIEWPORTS.desktop], ['1280x800', VIEWPORTS.laptop]]) {
    const { ctx, page } = await context(viewport);
    await openProject(page, fixture.repos.main);
    await freshConversation(page);
    await record(`chat-fresh-${name}`, page, viewport, `density-chat-fresh-${name}`, `A NEW empty conversation at ${viewport.width}×${viewport.height} (fixture)`);
    if (name === '1280x800') { await ctx.close(); continue; }
    const kind = name === 'phone' ? 'phone' : 'desktop';
    await page.goto(`${fixture.url}/chat?task=${T.failedChecks}`);
    await page.fill('.composer textarea', 'What is the state of this task, and what should I do next?');
    await page.click('.composer button[type="submit"]'); // package 2: the enhanced send stays on this document; the reply lands live
    for (let i = 0; i < 40 && (await page.$('.msg.mate')) === null; i++) { await page.waitForTimeout(500); if (i % 4 === 3) await page.reload(); }
    await scrollTo(page, '.msg.op', 96);
    await record(`chat-focused-populated-${kind}`, page, viewport, `density-${kind}-chat-focused-populated`, `A populated focused conversation at ${viewport.width}×${viewport.height}, scrolled to the operator's message (fixture)`);
    await page.goto(`${fixture.url}/t/${T.failedChecks}`);
    await record(`task-failed-checks-${kind}`, page, viewport, `density-${kind}-task-failed-checks`, `Task page for the failed-check result at ${viewport.width}×${viewport.height}, the first viewport (fixture)`);
    if (kind === 'phone') {
      await page.goto(`${fixture.url}/t/${T.pendingReview}`);
      await record('task-pending-review-phone', page, viewport, 'density-phone-task-pending-review', 'Task page for a verified result whose review is queued at 390×844, the first viewport (fixture)');
    }
    await ctx.close();
  }
}

/** Package 5 pilot 2: one journey per viewport, reusing this fixture and
 * proof harness. All tasks here are synthetic, including the exact path
 * reported on the live pilot. No model or external write is involved. */
async function statusPass() {
  for (const [name, viewport] of [['desktop', VIEWPORTS.desktop], ['phone', VIEWPORTS.phone]]) {
    const { ctx, page } = await context(viewport);
    // Each viewport revises a different result, so the first journey cannot
    // change the second journey's starting assignment.
    const journeyTask = name === 'desktop' ? fixture.tasks.done : T.missingProof;
    const journeyRun = name === 'desktop' ? fixture.runId : R.missingProof;
    await openProject(page, fixture.repos.main);
    await page.goto(`${fixture.url}/`);
    check(`shell ${name}: signed-in home opens Chat`, new URL(page.url()).pathname === '/chat');
    check(`simple ${name}: Chat has one saved catch-up`, await page.locator('.lead-brief').count() === 1 && await page.locator('.chat-fleet-context').count() === 0);
    await shot(page, `${name}-chat-home`, `${viewport.width}×${viewport.height}: one saved catch-up without the duplicate overview (synthetic fixture)`);
    await page.goto(`${fixture.url}/projects`);
    const projectActions = await page.locator('.project-card form[action="/projects/open"] button.button-link').evaluateAll(els => els.map(el => ({label: el.textContent.trim(), height: el.getBoundingClientRect().height})));
    check(`simple ${name}: Open is the project action and Knowledge is secondary`, projectActions.length > 0 && projectActions.every(one => one.label === 'Open' && one.height >= 44) && await page.locator('.project-card a.button-link[href*="/settings/knowledge"]').count() === 0);
    check(`simple ${name}: Projects fits`, (await noOverflow(page)).ok);
    await shot(page, `${name}-projects`, `${viewport.width}×${viewport.height}: Open project leads, secondary knowledge and adding choices stay available (synthetic fixture)`);
    await page.goto(`${fixture.url}/review?result=${T.completed}&run=${R.completed}`);
    check(`simple ${name}: result queue and detail agree on Complete`, await page.locator('.cockpit-row.current [data-work-status="assignment-complete"]').count() === 1 && await page.locator('.cockpit-head [data-work-status="assignment-complete"]').count() === 1 && await page.locator('h1').count() === 1);
    check(`simple ${name}: completed result fits`, (await noOverflow(page)).ok);
    await shot(page, `${name}-result-complete`, `${viewport.width}×${viewport.height}: current queue and result share Complete with one title (synthetic fixture)`);
    await page.goto(`${fixture.url}/t/${T.damaged}`);
    check(`simple ${name}: damaged current material stays visible`, await page.locator('.assignment-summary > .problem').count() > 0 && (await page.locator('.assignment-summary').innerText()).includes('unavailable or changed'));
    await shot(page, `${name}-material-notices`, `${viewport.width}×${viewport.height}: storage limits are secondary while damaged material remains visible (synthetic fixture)`);
    await page.goto(`${fixture.url}/work`);
    const destinations = ['/chat', '/work', '/projects'];
    check(`shell ${name}: primary destinations are Chat, Tasks and Projects`, JSON.stringify(await hrefs(page, 'aside.side > nav:first-of-type')) === JSON.stringify(destinations) && JSON.stringify(await hrefs(page, 'nav.tabbar')) === JSON.stringify(destinations));
    check(`shell ${name}: the appropriate navigation is visible`, name === 'desktop' ? await visible(page, 'aside.side') && !await visible(page, 'nav.tabbar') : !await visible(page, 'aside.side') && await visible(page, 'nav.tabbar'));
    const rows = await rowsOf(page), counts = await countsOf(page);
    const byId = Object.fromEntries(rows.map(row => [row.id, row]));
    check(`state ${name}: Ready stays outside Complete`, byId[T.missingProof]?.token === 'assignment-ready-to-check' && !byId[T.missingProof].views.includes('completed') && byId[T.failedChecks]?.token === 'assignment-ready-to-check', JSON.stringify([byId[T.missingProof], byId[T.failedChecks]]));
    check(`state ${name}: only explicit completion enters Complete`, byId[T.completed]?.token === 'assignment-complete' && byId[T.completed].views.includes('completed') && rows.filter(row => row.views.includes('completed')).every(row => row.token === 'assignment-complete'));
    check(`counts ${name}: filters describe the same rows`, counts.All === rows.length && counts['Needs you'] === rows.filter(row => row.views.includes('needs-you')).length && counts.Complete === rows.filter(row => row.views.includes('completed')).length, JSON.stringify(counts));
    const filters = await filterBoxes(page, viewport);
    check(`fit ${name}: every task filter remains readable and reachable`, filters.length === 4 && filters.every(one => one.insideViewport && one.insideStrip && !one.clipped && one.height >= (name === 'phone' ? 44 : 40)), JSON.stringify(filters));
    const menuSelector = name === 'desktop' ? 'aside.side [data-group="tools"]' : '.work-tools';
    await page.focus(menuSelector + ' > summary');
    await page.keyboard.press('Enter');
    await page.waitForFunction(selector => document.querySelector(selector)?.open === true, menuSelector);
    const menu = await menuBounds(page, viewport, name === 'desktop');
    check(`shell ${name}: keyboard opens Tools inside the viewport, including the legacy inbox`, menu.open && menu.positiveSize && menu.insideViewport && !menu.overflow && menu.links.some(one => one.href === '/inbox'), JSON.stringify(menu.links));
    await shot(page, `${name}-tools`, `${viewport.width}×${viewport.height}: secondary tools opened by keyboard (synthetic fixture)`);
    await page.focus(menuSelector + ' > summary');
    await page.keyboard.press('Enter');
    await page.waitForFunction(selector => document.querySelector(selector)?.open === false, menuSelector);
    await shot(page, `${name}-tasks`, `${viewport.width}×${viewport.height}: current tasks and consistent counts (synthetic fixture)`);
    const cases = [fixture.tasks.long, T.chained, T.waitingForBuilder, T.running, T.held, T.paused, T.failed, T.failedChecks, T.missingProof, T.corruptLog, T.pendingReview, T.reviewing, T.reviewFailed, T.completed];
    const primary = () => page.evaluate(() => [...document.querySelectorAll('[data-primary-action]')].filter(el => el.checkVisibility()).map(el => ({ label: el.textContent.trim(), href: el.getAttribute('href') })));
    for (const id of cases) {
      await page.goto(`${fixture.url}/work`);
      const expected = await page.locator(`.work-row[data-task="${id}"]`).evaluate(row => ({ token: row.dataset.workStatus, label: row.querySelector('.status-label').textContent, action: row.querySelector('.work-action')?.textContent.replace(/ →$/, '') ?? null }));
      for (const surface of ['task', 'chat']) {
        await page.goto(`${fixture.url}${surface === 'task' ? `/t/${id}` : `/chat?task=${id}`}`);
        const seen = await statusOf(page, '[data-task-status], .completion-receipt .status-line');
        const actions = await primary();
        check(`agree ${name} ${id} ${surface}: status and one primary action match Work`, seen?.token === expected.token && seen?.label === expected.label && actions.length === 1 && actions[0].label === expected.action, JSON.stringify({ expected, seen, actions }));
        const actionFit = await page.locator('[data-primary-action]').evaluateAll(els => els.filter(el => el.checkVisibility()).map(el => {
          const target = el.querySelector('.button-link') ?? el, r = target.getBoundingClientRect(), text = document.createRange(); text.selectNodeContents(target);
          const lines = new Set([...text.getClientRects()].filter(rect => rect.width > 0).map(rect => Math.round(rect.top)));
          return { label: target.textContent.trim(), height: r.height, left: r.left, right: r.right, lines: lines.size };
        }));
        check(`fit ${name} ${id} ${surface}: primary action fits on one line with a 44px target`, actionFit.length === 1 && actionFit[0].height >= 44 && actionFit[0].left >= 0 && actionFit[0].right <= viewport.width && actionFit[0].lines === 1, JSON.stringify(actionFit));
        const bounds = await noOverflow(page);
        check(`fit ${name} ${id} ${surface}: document fits`, bounds.ok, JSON.stringify(bounds));
        check(`current ${name} ${id} ${surface}: no retired review action`, await page.locator('form[action$="/review"], form[action$="/review/retry"]').count() === 0);
        if (id === T.failedChecks && surface === 'task') await shot(page, `${name}-status-failure`, `${viewport.width}×${viewport.height}: Ready with actual failed check (synthetic fixture)`);
        if (id === T.completed && surface === 'task') {
          check(`simple ${name}: partial passing output has a visible disclosure`, await page.locator('.assignment-notices > summary').isVisible() && (await page.locator('.assignment-detail').innerText()).includes('Checks passed'));
          await page.focus('.assignment-notices > summary');
          await page.keyboard.press('Enter');
          check(`simple ${name}: keyboard reveals the retained-output limitation`, await page.locator('.assignment-notices > p').isVisible() && (await page.locator('.assignment-notices').innerText()).includes('its download holds only the stored part'));
          await shot(page, `${name}-status-complete`, `${viewport.width}×${viewport.height}: explicitly completed result with partial-output disclosure expanded by keyboard (synthetic fixture)`);
        }
      }
    }
    for (const [id, target] of [[T.held, 'form[action$="/unhold"] button'], [T.paused, '.task-resume-form button'], [T.waitingForBuilder, '.dispatch-recovery-command']]) {
      await page.goto(`${fixture.url}/t/${id}`);
      await page.focus('[data-primary-action]');
      const href = await page.locator('[data-primary-action]').getAttribute('href');
      if (href) await Promise.all([page.waitForURL(new URL(href, page.url()).href), page.keyboard.press('Enter')]);
      else await page.keyboard.press('Enter');
      await page.waitForLoadState('load');
      check(`one-action ${name} ${id}: keyboard primary action reveals its controls`, await page.locator(target).isVisible());
    }
    await page.goto(`${fixture.url}/t/${fixture.tasks.long}`);
    await page.focus('.task-plan-review > summary');
    await page.keyboard.press('Enter');
    const approval = await page.locator('#approve').evaluate(el => ({ full: el.querySelector('.approval-goal').textContent, paths: el.querySelector('.approval-boundaries').textContent, password: el.querySelector('input[type="password"]') !== null }));
    check(`one-action ${name}: Review plan opens the full exact terms before password approval`, approval.full === fixture.store.getScope(fixture.tasks.long).goal && approval.paths.includes(LONG_ALLOWED_PATH) && approval.password);
    const risk = page.locator('#approve .agents-risk-line');
    await risk.scrollIntoViewIfNeeded();
    check(`one-action ${name}: the risk and its consequences are reachable before consent`, await risk.isVisible() && (await risk.innerText()).startsWith('Routine: every role uses the everyday configured agent'), await risk.innerText());
    check(`fit ${name}: expanded approval fits`, (await noOverflow(page)).ok);
    await shot(page, `${name}-status-approval`, `${viewport.width}×${viewport.height}: risk and agent terms remain available before consent (synthetic fixture)`);
    await page.locator('.task-plan-review').evaluate(el => { el.open = false; });
    await page.locator('#scope').evaluate(el => { el.open = true; });
    await scrollTo(page, '#scope .scope-paths', 120);
    const paths = await page.locator('#scope .scope-paths').evaluate((el, exact) => {
      const r = el.getBoundingClientRect(), style = getComputedStyle(el);
      return { text: el.textContent, width: el.clientWidth, scroll: el.scrollWidth, right: r.right, overflow: style.overflowX, wrap: style.overflowWrap, exact: el.textContent.includes(exact), document: document.documentElement.scrollWidth };
    }, LONG_ALLOWED_PATH);
    check(`fit ${name}: the exact live-pilot allowed path wraps fully`, paths.exact && paths.wrap === 'anywhere' && paths.overflow !== 'hidden' && paths.scroll <= paths.width && paths.document <= viewport.width && paths.right <= viewport.width, JSON.stringify(paths));
    await shot(page, `${name}-status-long-path`, `${viewport.width}×${viewport.height}: full ${LONG_ALLOWED_PATH} in allowed paths (synthetic fixture)`);

    // The existing native result/feedback/revision journey, once per width.
    await freshConversation(page);
    await page.goto(`${fixture.url}/chat?task=${journeyTask}`);
    // The reported message path is different from the allowed-files case.
    // Send through the existing scripted runner and let the reply land live.
    await page.fill('.composer textarea', `Slowly read AGENTS.md and ${LONG_REQUEST_PATH}.`);
    await page.click('.composer button[type="submit"]');
    await page.waitForSelector('.chat-thinking');
    const draft = `Unsent ${name} feedback stays here.`;
    await page.fill('.composer textarea', draft);
    await page.locator('.composer textarea').evaluate(el => { window.__statusComposer = el; el.setSelectionRange(3, 8); });
    await page.locator('.msg.mate .chat-copy p').filter({ hasText: LONG_REQUEST_PATH }).first().waitFor();
    const kept = await page.locator('.composer textarea').evaluate(el => ({ same: el === window.__statusComposer, focused: el === document.activeElement, value: el.value, start: el.selectionStart, end: el.selectionEnd }));
    check(`one-action ${name}: the path reply refresh preserves the composer, draft, focus and selection`, kept.same && kept.focused && kept.value === draft && kept.start === 3 && kept.end === 8, JSON.stringify(kept));
    const messagePaths = await page.locator('.thread .msg p').filter({ hasText: LONG_REQUEST_PATH }).evaluateAll(els => els.map(el => {
      const r = el.getBoundingClientRect(), style = getComputedStyle(el);
      return { role: el.closest('.msg').dataset.messageRole, text: el.textContent, width: el.clientWidth, scroll: el.scrollWidth, left: r.left, right: r.right, overflow: style.overflowX, wrap: style.overflowWrap, clamp: style.webkitLineClamp, document: document.documentElement.scrollWidth };
    }));
    check(`fit ${name}: the exact live-pilot chat path wraps in sent text and plain/code replies without clipping`, messagePaths.length === 3 && messagePaths.some(p => p.role === 'operator') && messagePaths.every(p => p.wrap === 'anywhere' && p.overflow === 'visible' && p.clamp === 'none' && p.scroll <= p.width && p.left >= 0 && p.right <= viewport.width && p.document <= viewport.width), JSON.stringify(messagePaths));
    await scrollTo(page, '.msg.op', 96);
    await shot(page, `${name}-status-chat-path`, `${viewport.width}×${viewport.height}: full REAL_WORK_PILOT path in sent text and reply, with an unsent draft (synthetic fixture)`);
    await page.reload();
    check(`one-action ${name}: reloading the long-message chat preserves the unsent draft`, await page.inputValue('.composer textarea') === draft);
    await page.click('.assignment-summary [data-open-result]');
    await page.waitForSelector('[data-result-tab="changes"]');
    await page.click('[data-result-tab="changes"]');
    check(`one-action ${name}: Changes opens the preserved diff`, await page.locator('[data-result-view="changes"]').isVisible() && await page.locator('[data-result-view="changes"] .diff-file').count() > 0);
    await shot(page, `${name}-result-changes`, `${viewport.width}×${viewport.height}: saved diff opened from the current assignment (synthetic fixture)`);
    await page.click('[data-result-tab="checks"]');
    check(`one-action ${name}: Checks is readable`, await page.locator('[data-result-view="checks"]').isVisible());
    await page.goto(`${fixture.url}/r/${journeyRun}?tab=changes`);
    const note = `Keep the full allowed path visible at ${viewport.width}px. Wrap long filenames without hiding their suffixes, preserve the existing column names and row order, and make the check failure easy to find from this result. Keep this request attached to the same assignment when creating the revision.`;
    await page.fill('#comment-form [name="note"]', note);
    await page.reload();
    check(`one-action ${name}: refresh preserves the feedback draft`, await page.inputValue('#comment-form [name="note"]') === note);
    await page.locator('#comment-form').scrollIntoViewIfNeeded();
    await shot(page, `${name}-feedback`, `${viewport.width}×${viewport.height}: durable feedback draft before submission (synthetic fixture)`);
    await submit(page, '#comment-form [data-save-feedback]');
    const batch = fixture.store.liveDiffComments(journeyRun);
    check(`one-action ${name}: one note is saved`, batch.length === 1 && batch[0].note === note.trim(), JSON.stringify(batch.map(one => one.note)));
    await submit(page, '#comment-form [data-request-changes]');
    const revisedUrl = new URL(page.url());
    const child = revisedUrl.searchParams.get('version') ?? revisedUrl.pathname.slice('/t/'.length);
    check(`one-action ${name}: revision has its own unapproved scope`, fixture.store.getScope(child)?.approvedAt === null && fixture.store.revisionsFromRun(journeyRun).some(one => one.id === child));
    await shot(page, `${name}-revision`, `${viewport.width}×${viewport.height}: explicit revision awaits fresh scope approval (synthetic fixture)`);
    await page.goto(`${fixture.url}/chat?task=${journeyTask}`);
    check(`one-action ${name}: result/revision navigation preserves the unsent chat draft`, await page.inputValue('.composer textarea') === draft);
    await openProject(page, fixture.repos.empty);
    await page.goto(`${fixture.url}/work`);
    check(`fit ${name}: empty Work fits and offers Start in chat`, await page.locator('[data-work-empty="all"]').isVisible() && (await noOverflow(page)).ok);
    await shot(page, `${name}-empty`, `${viewport.width}×${viewport.height}: empty project task list (synthetic fixture)`);
    await ctx.close();
  }
}

/** New lead and knowledge entry points, using only saved/local data. */
async function contextPass() {
  for (const [name, viewport] of [['desktop', VIEWPORTS.desktop], ['phone', VIEWPORTS.phone]]) {
    const { ctx, page } = await context(viewport);
    const contextOffset = name === 'desktop' ? 110 : 88;
    await openProject(page, fixture.repos.main);
    await page.goto(`${fixture.url}/chat`);
    if (await page.$('form[action="/chat/mate/end"]')) {
      await page.locator('.chat-session-details').evaluate(el => { el.open = true; });
      await submit(page, 'form[action="/chat/mate/end"] button[type="submit"]');
    }
    const callsBefore = fixture.requests.length;
    await page.goto(`${fixture.url}/`);
    check(`context ${name}: DB catch-up is available before chat authorization`, new URL(page.url()).pathname === '/chat' && await page.locator('.lead-brief').isVisible() && await page.locator('form[action="/chat/mate/mint"]').count() === 1 && await page.locator('.composer').count() === 0);
    check(`context ${name}: catch-up fits`, (await noOverflow(page)).ok);
    await shot(page, `${name}-catch-up-home`, `${viewport.width}×${viewport.height}: DB catch-up before authorizing chat (synthetic fixture)`);
    await page.locator('.lead-brief li a').first().focus();
    const catchLink = await page.locator('.lead-brief li a').first().evaluate(el => ({focused: el === document.activeElement, height: el.getBoundingClientRect().height, text: el.textContent}));
    check(`context ${name}: saved task links support keyboard and touch`, catchLink.focused && catchLink.height >= 44, JSON.stringify(catchLink));
    await scrollTo(page, '.lead-brief', contextOffset);
    await shot(page, `${name}-catch-up`, `${viewport.width}×${viewport.height}: saved task context and clear next links (synthetic fixture)`);
    await page.goto(`${fixture.url}/settings/knowledge?repo=${encodeURIComponent(fixture.repos.main)}`);
    await scrollTo(page, '.repository-context', contextOffset);
    check(`context ${name}: empty code search fits`, await page.locator('.repository-context input[name="q"]').inputValue() === '' && (await noOverflow(page)).ok);
    await shot(page, `${name}-knowledge-empty`, `${viewport.width}×${viewport.height}: local code search before entering a query (synthetic fixture)`);
    await page.fill('.repository-context input[name="q"]', 'settle');
    await page.keyboard.press('Tab');
    const searchButton = await page.locator('.repository-context form[method="get"] button').evaluate(el => ({ focused: el === document.activeElement, height: el.getBoundingClientRect().height, inputHeight: el.form.querySelector('[name=q]').getBoundingClientRect().height }));
    check(`context ${name}: code search supports keyboard and touch`, searchButton.focused && searchButton.height >= (name === 'phone' ? 44 : 32) && searchButton.inputHeight >= 44, JSON.stringify(searchButton));
    await Promise.all([page.waitForURL(url => url.searchParams.get('q') === 'settle'), page.keyboard.press('Enter')]);
    await scrollTo(page, '.repository-context', contextOffset);
    const excerpt = page.locator('.repository-context details').filter({hasText:'src/payout.ts'}).first();
    check(`context ${name}: local source search returns the actual fixture code`, await excerpt.count() === 1 && (await page.locator('.repository-context').innerText()).includes('Source search'));
    await excerpt.locator('summary').focus();
    await page.keyboard.press('Enter');
    await excerpt.locator('pre').waitFor({state:'visible'});
    check(`context ${name}: expanded code fits without widening the document`, (await noOverflow(page)).ok);
    await shot(page, `${name}-knowledge-search`, `${viewport.width}×${viewport.height}: local source excerpt with no model call (synthetic fixture)`);
    await page.goto(`${fixture.url}/settings/knowledge?repo=${encodeURIComponent(fixture.repos.main)}&q=no_such_fixture_symbol_2099`);
    await scrollTo(page, '.repository-context', contextOffset);
    check(`context ${name}: no-match state stays readable`, (await page.locator('.repository-context').innerText()).includes('No matching source') && (await noOverflow(page)).ok);
    await shot(page, `${name}-knowledge-no-match`, `${viewport.width}×${viewport.height}: code search with no matching source (synthetic fixture)`);
    check(`context ${name}: catch-up and source search made no model request`, fixture.requests.length === callsBefore);
    await ctx.close();
  }
}

let fatalError = null;
try {
  if (densityOnly) await densityPass();
  else if (contextOnly) await contextPass();
  else { await statusPass(); await contextPass(); }
} catch (error) {
  fatalError = String(error.stack ?? error);
  check('journey completed', false, fatalError);
} finally {
  await browser.close();
  await fixture.stop();
}

writeFileSync(join(out, contextOnly ? 'report-context.json' : 'report.json'), JSON.stringify(report, null, 2));
const failed = report.checks.filter(one => !one.ok);
console.log(`\n${report.checks.length - failed.length}/${report.checks.length} checks passed · ${report.screenshots.length} screenshots · payloads: ${Object.entries(report.payloads).map(([k, v]) => `${k}=${v.htmlBytes}B`).join(' ')}`);
if (fatalError !== null || strict && failed.length > 0) process.exit(1);
