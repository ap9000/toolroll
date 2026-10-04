// Synthetic visual proof for the flow gallery (Flows → New) and its tool templates, at desktop (1440×900) and phone
// (390×844). One project on GitHub with PostHog signed in and Sentry added another way; Mobbin and Figma not connected.
// Each journey: the gallery's marks and states, a missing tool's Connect and a failed Connect coming back to the
// template, a connected template's long expanded steps, then one Create without the tool. No network and no model.
// Build first (`npm run build`).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openStore } from '../dist/store.js';
import { addApprover } from '../dist/scope.js';
import { createDecisionServer } from '../dist/serve.js';
import { addToolTo, catalogTool } from '../dist/project-tools.js';
import { connectedSpec } from '../dist/mcp-connect.js';

const out = resolve('evidence/flow-gallery');
mkdirSync(out, { recursive: true });
let pw;
for (const root of [join(process.env.REAL_HOME ?? homedir(), '.npm', '_npx')]) for (const d of existsSync(root) ? readdirSync(root) : []) {
  const p = join(root, d, 'node_modules/playwright/index.mjs');
  if (!pw && existsSync(p)) pw = await import(pathToFileURL(p));
}
if (!pw) throw Error('Playwright unavailable');

const base = realpathSync(mkdtempSync(join(tmpdir(), 'toolroll-gallery-proof-')));
const repo = join(base, 'bookshelf'), evidenceRoot = join(base, 'evidence'), toolHome = join(base, 'tools');
for (const dir of [repo, evidenceRoot, toolHome]) mkdirSync(dir, { recursive: true });
execFileSync('git', ['init', '-q', repo]);
execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:bookshelf-co/bookshelf.git']);

const store = openStore(':memory:');
const login = addApprover(store, 'alex', new Date());
store.upsertProject(repo, 'bookshelf', new Date());
addToolTo(store, repo, connectedSpec('posthog'), 'PostHog, connected by signing in', 'alex', new Date(), { home: toolHome });
const { label: _label, ...sentry } = catalogTool('sentry');
addToolTo(store, repo, sentry, 'the common tools list', 'alex', new Date(), { home: toolHome });

const server = createDecisionServer({ store, evidenceRoot, repo, chatEnv: {}, configDir: base, toolHome });
await new Promise(done => server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${server.address().port}`;

const browser = await pw.chromium.launch({ channel: 'chrome' });
const checks = [];
const measure = async (tab, name) => {
  const facts = await tab.evaluate(() => {
    const taps = [...document.querySelectorAll('.gallery-card .button-link, .gallery-actions button, .gallery-connect button, .gallery-use input:not([type=hidden]):not([type=checkbox]), .gallery-use select, .gallery-preview summary')].map(one => one.getBoundingClientRect()).filter(one => one.height > 0);
    const buttons = [...document.querySelectorAll('.gallery-card .button-link, .gallery-actions button, .gallery-connect button')];
    const marks = [...document.querySelectorAll('.gallery-tools .brand-mark, .gallery-connect .brand-mark')].map(one => Math.round(one.getBoundingClientRect().width));
    // Each step strip wraps inside its card or page, and a person's steps carry the accent chip.
    const strips = [...document.querySelectorAll('.gallery-steps')];
    const stripOverflow = strips.some(one => one.scrollWidth > one.clientWidth + 1 || [...one.children].some(li => li.getBoundingClientRect().right > one.getBoundingClientRect().right + 1));
    return { overflow: document.documentElement.scrollWidth > innerWidth || stripOverflow, strips: strips.length, smallestTap: taps.length === 0 ? null : Math.min(...taps.map(one => Math.round(one.height))),
      wrappedButton: buttons.some(one => one.getBoundingClientRect().height > 60), marks: [...new Set(marks)] };
  });
  checks.push({ name, ...facts });
  return facts;
};
const fail = (what, facts, errors) => { throw Error(`${what}: ${JSON.stringify({ facts, errors })}`); };
try {
  for (const [name, viewport, mark] of [['desktop', { width: 1440, height: 900 }, 32], ['phone', { width: 390, height: 844 }, 28]]) {
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
    const tab = await context.newPage(), errors = [];
    tab.on('pageerror', e => errors.push(e.message));
    await tab.goto(`${url}/chat`);
    await tab.getByLabel('Username').fill('alex');
    await tab.getByLabel('Password').fill(login.token);
    await tab.getByRole('button', { name: 'Sign in', exact: true }).click();
    const check = async (what, extra = () => false) => {
      const facts = await measure(tab, `${what} ${name}`);
      if (facts.overflow || (name === 'phone' && facts.smallestTap !== null && facts.smallestTap < 44) || facts.wrappedButton || facts.marks.some(one => one !== mark) || errors.length > 0 || extra(facts)) fail(`${name} ${what}`, facts, errors);
    };

    // The gallery: every card with its tools' marks and whether bookshelf has them.
    await tab.goto(`${url}/flows/new?repo=${encodeURIComponent(repo)}`);
    const states = await tab.locator('.gallery-tools li').evaluateAll(all => all.map(one => `${one.closest('[data-template]').dataset.template}:${one.dataset.tool}:${one.dataset.state}`));
    for (const want of ['metrics-digest:posthog:connected', 'ui-inspiration:mobbin:open', 'error-to-fix:sentry:taken', 'figma-to-pr:figma-desktop:open']) if (!states.includes(want)) fail(`${name} gallery state ${want}`, states, errors);
    await check('gallery', facts => facts.marks.length !== 1);
    await tab.locator('[data-template="ui-inspiration"]').evaluate(one => one.scrollIntoView({ block: 'start' }));
    await tab.evaluate(() => window.scrollBy(0, -16));
    await tab.screenshot({ path: join(out, `${name}-gallery.png`) });

    // A missing tool: its Connect comes first. A wrong password is refused and comes back to the template.
    await tab.locator('[data-template="ui-inspiration"] a.button-link').click();
    await tab.waitForURL(/\/flows\/new\/ui-inspiration/);
    await tab.fill('.gallery-connect input[name="password"]', 'not my password');
    await Promise.all([tab.waitForNavigation(), tab.click('.gallery-connect button[value="mobbin"]')]);
    if (!/\/flows\/new\/ui-inspiration\?repo=/.test(tab.url())) fail(`${name} connect came back to ${tab.url()}`, null, errors);
    const problem = await tab.locator('.gallery-use .problem').textContent();
    if (problem !== 'Enter your Toolroll password to connect a tool.') fail(`${name} problem`, problem, errors);
    await check('ui-inspiration failed connect');
    await tab.screenshot({ path: join(out, `${name}-ui-inspiration-connect-failed.png`) });

    // Its preview names the zone that needs the tool; Create flow stays, quieter.
    await tab.locator('.gallery-preview').evaluate(one => one.scrollIntoView({ block: 'start' }));
    const needs = await tab.locator('[data-needs-tool="mobbin"]').textContent();
    if (needs !== "“Find examples” needs Mobbin, which isn't connected.") fail(`${name} needs`, needs, errors);
    await tab.screenshot({ path: join(out, `${name}-ui-inspiration-preview.png`) });

    // It sends its result already, so "Send me the result" isn't offered again.
    if (await tab.locator('[data-send-result]').count() !== 0) fail(`${name} ui-inspiration offers a second send`, null, errors);

    // Added another way: it reads as there, not missing; Create flow keeps its normal weight.
    await tab.goto(`${url}/flows/new/error-to-fix?repo=${encodeURIComponent(repo)}`);
    const taken = await tab.locator('[data-tool-taken="sentry"]').textContent();
    if (taken !== '“Find the cause” uses Sentry, added another way.' || await tab.locator('[data-needs-tool], [data-without-tools], .gallery-connect form').count() !== 0) fail(`${name} taken`, taken, errors);
    await check('error-to-fix taken');
    await tab.locator('.gallery-preview').evaluate(one => one.scrollIntoView({ block: 'start' }));
    await tab.screenshot({ path: join(out, `${name}-error-to-fix-taken.png`) });

    // A connected tool, with its long steps open.
    await tab.goto(`${url}/flows/new/fix-drop-off?repo=${encodeURIComponent(repo)}`);
    const strip = await tab.locator('.gallery-use .gallery-steps').innerText();
    if (strip.replace(/\s+/g, ' ').trim() !== 'Find the drop-off → You choose → Build the fix → Pull request → Sent to you') fail(`${name} strip`, strip, errors);
    await tab.screenshot({ path: join(out, `${name}-fix-drop-off-top.png`) });
    await tab.locator('.gallery-preview details').evaluate(one => { one.open = true; });
    await check('fix-drop-off expanded', () => false);
    if (await tab.locator('.gallery-connect form').count() !== 0) fail(`${name} connected offers Connect`, null, errors);
    if (name === 'desktop') await tab.screenshot({ path: join(out, `${name}-fix-drop-off-steps.png`), fullPage: true });

    if (name === 'phone') {
      // One Create without the tool: UI inspiration, weekly, previewed first.
      await tab.goto(`${url}/flows/new/ui-inspiration?repo=${encodeURIComponent(repo)}`);
      await tab.fill('form[data-gallery-use] input[name="schedule"]', 'friday 10:00');
      await Promise.all([tab.waitForNavigation(), tab.click('form[data-gallery-use] button[value="preview"]')]);
      await Promise.all([tab.waitForNavigation(), tab.click('form[data-gallery-use] button[value="create"]')]);
      if (!/\/flows\/\d+$/.test(tab.url())) fail(`create went to ${tab.url()}`, null, errors);
    }
    if (errors.length > 0) fail(`${name} page errors`, null, errors);
    await context.close();
  }
  const flows = store.listFlows([repo]).map(one => ({ name: one.name, triggers: store.flowTriggers(one.id).map(t => JSON.parse(t.configJson)), zones: JSON.parse(one.definitionJson).stages.map(s => s.kind) }));
  if (flows.length !== 1 || flows[0].name !== 'UI inspiration') throw Error(`flows: ${JSON.stringify(flows)}`);
  writeFileSync(join(out, 'checks.json'), `${JSON.stringify({ synthetic: true, checks, flows }, null, 2)}\n`);
  console.log(JSON.stringify({ checks, flows }, null, 2));
} finally {
  await browser.close();
  server.closeAllConnections?.();
  server.close();
  store.close();
  rmSync(base, { recursive: true, force: true });
}
