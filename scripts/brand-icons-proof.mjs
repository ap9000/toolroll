// Synthetic visual proof for integration logos: Settings → Tools,
// Integrations and the Settings home at desktop (1440) and phone (390), light
// and dark, plus a sheet of every icon at 1x and 2x. A fresh installation with
// one project: Telegram connected and the other chat apps not set up; Stripe
// and Figma connected by one click; Sentry from the catalog waiting for its
// token; a custom tool (a letter tile). No network: outside answers are
// stubbed. Build first (`npm run build`).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openStore } from '../dist/store.js';
import { addApprover } from '../dist/scope.js';
import { createDecisionServer } from '../dist/serve.js';
import { addToolTo, catalogTool, setToolSecrets, validateToolSpec } from '../dist/project-tools.js';
import { ONE_CLICK } from '../dist/mcp-connect.js';
import { BRAND_ICONS } from '../dist/brand-icons.js';
import { BRAND_MARK_CSS, brandMarkHtml } from '../dist/brand-mark.js';

const out = resolve('evidence/brand-icons');
mkdirSync(out, { recursive: true });
let pw;
for (const root of [join(process.env.REAL_HOME ?? homedir(), '.npm', '_npx')]) for (const d of existsSync(root) ? readdirSync(root) : []) {
  const p = join(root, d, 'node_modules/playwright/index.mjs');
  if (existsSync(p)) { try { const mod = await import(pathToFileURL(p)); const b = await mod.chromium.launch(); await b.close(); pw = mod; break; } catch { /* that copy's browser isn't installed */ } }
}
if (!pw) throw Error('Playwright unavailable');

const base = realpathSync(mkdtempSync(join(tmpdir(), 'toolroll-brand-proof-')));
const repo = join(base, 'bookshelf'), evidenceRoot = join(base, 'evidence');
mkdirSync(repo, { recursive: true }); mkdirSync(evidenceRoot, { recursive: true });
writeFileSync(join(base, 'telegram-token'), `7012345678:${'A'.repeat(20)}bcdefghijklmnopq\n`, { mode: 0o600 });

const store = openStore(':memory:');
const login = addApprover(store, 'alex', new Date());
store.upsertProject(repo, 'bookshelf', new Date());
const add = (spec, source) => { if (!addToolTo(store, repo, validateToolSpec(spec), source, 'alex', new Date(), { home: base }).ok) throw Error(spec.name); };
for (const id of ['stripe', 'figma']) {
  const service = ONE_CLICK.find(one => one.id === id);
  add({ name: id, transport: 'http', url: service.url, secrets: ['OAUTH_ACCESS_TOKEN'], bearer: 'OAUTH_ACCESS_TOKEN', about: service.about }, 'one-click');
  setToolSecrets(repo, id, { OAUTH_ACCESS_TOKEN: 'proof-token' }, base);
}
add({ ...catalogTool('sentry') }, 'catalog');
// A small stdio MCP server that starts and lists two tools: the custom tool.
const serverFile = join(base, 'catalog-mcp.mjs');
writeFileSync(serverFile, `import { createInterface } from "node:readline";
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") reply(message.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "catalog", version: "1" } });
  else if (message.method === "tools/list") reply(message.id, { tools: [{ name: "find_book", inputSchema: { type: "object" } }, { name: "list_loans", inputSchema: { type: "object" } }] });
});
`);
add({ name: 'catalog', command: process.execPath, args: [serverFile], secrets: [], about: 'The library catalogue' }, 'custom');

// No network: the one-click servers answer here, and anything else outside this computer fails.
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const address = String(input?.url ?? input);
  if (/^http:\/\/127\.0\.0\.1[:/]/.test(address)) return realFetch(input, init);
  if (/^https:\/\/mcp\.(stripe|figma)\.com\//.test(address)) {
    const message = JSON.parse(String(init?.body ?? '{}'));
    if (message.id === undefined) return new Response(null, { status: 202 });
    const result = message.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'proof', version: '1' } }
      : { tools: [{ name: 'search', inputSchema: { type: 'object' } }, { name: 'fetch', inputSchema: { type: 'object' } }] };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  throw Error(`The proof makes no network calls (${address}).`);
};

const fetcher = async (url) => String(url).includes('api.telegram.org')
  ? new Response(JSON.stringify({ ok: true, result: { id: 7012345678, is_bot: true, username: 'bookshelf_alerts_bot' } }), { status: 200 })
  : new Response('{}', { status: 404 });
const ok = (stdout) => ({ code: 0, stdout, stderr: '', timedOut: false, notFound: false });
const gh = async (_file, args) => args[0] === 'api' ? ok('alex-reads\n') : ok(JSON.stringify({ nameWithOwner: 'bookshelf-co/bookshelf', viewerPermission: 'WRITE' }));
const probe = async file => file === 'claude'
  ? ok(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', email: 'alex@bookshelf.example' }))
  : { code: 1, stdout: 'Not logged in\n', stderr: '', timedOut: false, notFound: false };
const server = createDecisionServer({ store, evidenceRoot, repo, chatEnv: {}, configDir: base, telegramTokenFile: join(base, 'telegram-token'), toolHome: base,
  connectionProbe: probe, integrationIo: { fetch: fetcher, gh, reach: async () => {} } });
await new Promise(done => server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${server.address().port}`;

const browser = await pw.chromium.launch();
const checks = [];
try {
  for (const [device, viewport] of [['desk', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    for (const scheme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport, colorScheme: scheme, reducedMotion: 'reduce' });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(`${url}/chat`);
      await page.getByLabel('Username').fill('alex');
      await page.getByLabel('Password').fill(login.token);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      for (const [name, path, anchor] of [['tools', `/settings/tools?repo=${encodeURIComponent(repo)}`, '.tools .card'], ['integrations', '/settings/integrations', '.integrations'], ['settings', '/settings', 'nav[aria-label="Settings sections"]']]) {
        await page.goto(`${url}${path}`);
        if (name === 'integrations') for (let tries = 0; tries < 40 && (await page.locator('.integration-state--checking').count()) > 0; tries += 1) { await new Promise(done => setTimeout(done, 250)); await page.reload(); }
        await page.locator(anchor).first().waitFor();
        await page.waitForTimeout(300);
        if (name === 'settings') await page.locator('a[href="/settings/telegram"]').scrollIntoViewIfNeeded();
        const facts = await page.evaluate(() => {
          const marks = [...document.querySelectorAll('.brand-mark')].filter(one => one.getClientRects().length > 0).map(one => {
            const box = one.getBoundingClientRect(), svg = one.querySelector('svg'), style = getComputedStyle(one);
            return { w: Math.round(box.width), h: Math.round(box.height), svg: svg ? Math.round(svg.getBoundingClientRect().width) : null, letter: svg ? null : one.textContent, connected: one.dataset.connected, color: style.color };
          });
          return { overflow: document.documentElement.scrollWidth > innerWidth, marks };
        });
        const sizes = new Set(facts.marks.map(one => `${one.w}x${one.h}`));
        if (facts.overflow || errors.length > 0 || facts.marks.length === 0 || sizes.size !== 1) throw Error(`${device} ${scheme} ${name}: ${JSON.stringify({ facts, errors })}`);
        await page.screenshot({ path: join(out, `${device}-${scheme}-${name}.png`) });
        // The one-click tiles sit under the tool cards: a second shot there.
        if (name === 'tools') { await page.locator('#connect').scrollIntoViewIfNeeded(); await page.locator('#connect').evaluate(one => one.scrollIntoView({ block: 'start' })); await page.screenshot({ path: join(out, `${device}-${scheme}-tools-connect.png`) }); }
        checks.push({ device, scheme, name, detail: facts.marks, size: [...sizes][0], marks: facts.marks.length, letters: facts.marks.filter(one => one.letter).map(one => one.letter), colors: [...new Set(facts.marks.map(one => `${one.connected}:${one.color}`))] });
      }
      await context.close();
    }
  }

  // The sheet: every icon in its tile, connected (ink) and not (muted), light and dark, at 1x and 2x.
  const ids = Object.keys(BRAND_ICONS);
  const tokens = { light: '--so-paper:#fff;--so-ink:#171717;--so-muted:#666;--so-line:#e6e6e6;--so-neutral-soft:#f0f0f0', dark: '--so-paper:#161616;--so-ink:#ededed;--so-muted:#a1a1a1;--so-line:#262626;--so-neutral-soft:#1f1f1f' };
  const panel = scheme => `<section style="${tokens[scheme]};background:var(--so-paper);color:var(--so-ink);padding:16px 20px">` +
    `<h2>${scheme === 'light' ? 'Light' : 'Dark'}: connected, then not connected</h2><div class="grid">${[...ids.map(id => [id, BRAND_ICONS[id].title]), ['attio', 'Attio'], ['klaviyo', 'Klaviyo'], ['mobbin', 'Mobbin'], ['context7', 'Context7']]
      .map(([id, title]) => `<figure>${brandMarkHtml(id, title, true)}${brandMarkHtml(id, title, false)}<figcaption>${title}</figcaption></figure>`).join('')}</div></section>`;
  const sheet = `<!doctype html><meta charset="utf-8"><style>${BRAND_MARK_CSS}body{margin:0;font:12px system-ui,sans-serif}h2{font-size:13px;font-weight:600;margin:0 0 12px}` +
    `.grid{display:grid;grid-template-columns:repeat(6,1fr);gap:12px 8px}figure{margin:0;display:grid;grid-template-columns:auto auto 1fr;gap:6px;align-items:center}figcaption{color:var(--so-muted);overflow-wrap:anywhere}</style>` +
    `<body>${panel('light')}${panel('dark')}</body>`;
  for (const scale of [1, 2]) {
    const context = await browser.newContext({ viewport: { width: 1040, height: 600 }, deviceScaleFactor: scale });
    const page = await context.newPage();
    await page.setContent(sheet);
    await page.screenshot({ path: join(out, `icon-sheet-${scale}x.png`), fullPage: true });
    await context.close();
  }
  writeFileSync(join(out, 'checks.json'), `${JSON.stringify({ synthetic: true, checks }, null, 2)}\n`);
  console.log(JSON.stringify(checks, null, 1));
} finally {
  await browser.close();
  server.closeAllConnections?.();
  server.close();
  store.close();
  rmSync(base, { recursive: true, force: true });
}
