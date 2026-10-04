// Synthetic visual proof for a flow's message after research (flow-items.ts): the Telegram message as the scripted
// transport received it (its text, bold titles, labelled links, buttons and the album with numbered captions), drawn
// as a phone chat, and the console card with the same numbered items beside their screenshots, at desktop and phone
// sizes. The report and its screenshots are a labelled synthetic fixture. No network and no model. Build first.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openStore } from '../dist/store.js';
import { addApprover } from '../dist/scope.js';
import { storeEvidence } from '../dist/evidence.js';
import { advanceFlows } from '../dist/flow-engine.js';
import { flowFromSteps } from '../dist/flows.js';
import { bridgePass, hashPairingCode, mintPairingCode, PAIRING_TTL_MS } from '../dist/telegram.js';
import { createDecisionServer } from '../dist/serve.js';

const out = resolve('evidence/flow-items');
mkdirSync(out, { recursive: true });
let pw;
for (const root of [join(process.env.REAL_HOME ?? homedir(), '.npm', '_npx')]) for (const d of existsSync(root) ? readdirSync(root) : []) {
  const p = join(root, d, 'node_modules/playwright/index.mjs');
  if (!pw && existsSync(p)) pw = await import(pathToFileURL(p));
}
if (!pw) throw Error('Playwright unavailable');

const base = realpathSync(mkdtempSync(join(tmpdir(), 'toolroll-items-proof-')));
const repo = join(base, 'bookshelf'), evidenceRoot = join(base, 'evidence');
mkdirSync(repo, { recursive: true }); mkdirSync(evidenceRoot, { recursive: true });
execFileSync('git', ['init', '-q', repo]);
const now = new Date();
const store = openStore(join(base, 'state.db'));
const login = addApprover(store, 'alex', now);
store.upsertProject(repo, 'bookshelf', now);
const browser = await pw.chromium.launch({ channel: 'chrome' });

// Three synthetic "app screens" for the report's screenshots, drawn here (labelled as a fixture on each).
const screens = [
  ['Settings', ['Account', 'Notifications', 'Workspace', 'Billing', 'Security'], '#5e6ad2'],
  ['Search settings…', ['Appearance', 'Language & region', 'Connected apps', 'Notifications'], '#111'],
  ['Privacy', ['Location Services', 'Tracking', 'Analytics & Improvements', 'Apple Advertising'], '#0a84ff'],
];
const shotTab = await browser.newPage({ viewport: { width: 800, height: 600 } });
const pictures = [];
for (const [heading, rows, accent] of screens) {
  await shotTab.setContent(`<body style="margin:0;font:16px system-ui;background:#f4f4f5"><div style="margin:32px;background:#fff;border-radius:14px;padding:24px;box-shadow:0 1px 3px #0002">
    <h2 style="margin:0 0 16px;color:${accent}">${heading}</h2>${rows.map(row => `<div style="display:flex;justify-content:space-between;padding:14px 0;border-top:1px solid #eee"><span>${row}</span><span style="color:#999">›</span></div>`).join('')}
    <p style="color:#aaa;font-size:12px;margin-top:20px">Synthetic fixture screen</p></div></body>`);
  pictures.push(await shotTab.screenshot());
}
await shotTab.close();

// Paired first: a chat gets what is sent after it pairs.
const code = mintPairingCode();
store.createTelegramPairing({ codeHash: hashPairingCode(code), approver: 'alex', by: 'alex', ttlMs: PAIRING_TTL_MS }, now);
store.consumeTelegramPairing({ codeHash: hashPairingCode(code), botId: '777', chatId: '42', userId: '42', updateId: 1 }, now);
const legacy = { route: { routeDigest: 'legacy', phase: 'build', provider: 'claude', model: null, chosen: 'legacy' } };
store.createTask({ id: 'look-1', title: 'Find UI inspiration for Settings' }, now);
const ref = store.refFor('built-in', 'look-1').id;
store.placeTask(ref, repo, {}, now);
const run = store.startRun({ taskRef: ref, leaseId: 'l-look-1', runner: 'worker-1', branch: 'so-scout/look-1', worktree: '/pool/look-1', role: 'scout', ...legacy, now });
const files = ['linear.png', 'notion.png', 'apple.png'];
const stored = files.map((file, n) => storeEvidence(store, evidenceRoot, run, 'screenshot', `report-image-${n + 1}.png`, pictures[n], `scout screenshot ${file} (validated png)`, now));
const sha = id => store.artifactsFor(run).find(one => one.id === id).sha256;
const items = [
  { title: 'Linear groups settings under five headings', url: 'https://mobbin.com/screens/linear-settings', image: 'linear.png',
    why: 'Short headed groups with the most-used group first; our Settings page is one long list of 30 toggles and people scroll past what they need; plugs in as five sections on our Settings page, reusing the existing toggles' },
  { title: 'Notion keeps a search box above every setting', url: 'https://www.notion.so/help/account-settings', image: 'notion.png',
    why: 'One search field that filters all settings as you type; we already get support questions asking where a setting lives; plugs in as one search field over the groups, matching names and descriptions' },
  { title: 'Apple shows one control per row, details on tap', url: 'https://developer.apple.com/design/human-interface-guidelines/settings', image: 'apple.png',
    why: 'Each row has one control, and anything rare opens on tap; our rows carry two or three controls and read as noise on a phone; plugs in by moving rare controls into a disclosure under each row' },
];
const report = { title: 'Settings inspiration', summary: 'Three products keep long settings easy to scan: they group them, let people search them, and keep one control per row. Each pattern below fits our Settings page.',
  report: '## Findings', followUps: [], items, images: files.map((file, n) => ({ file, caption: `${['Linear', 'Notion', 'Apple'][n]} settings`, url: items[n].url, sha256: sha(stored[n]), artifact: stored[n] })) };
storeEvidence(store, evidenceRoot, run, 'report', 'report.json', Buffer.from(JSON.stringify(report)), 'scout handoff (verified tree)', now);
store.finishRun(run, { outcome: 'built', reason: 'report-delivered', now });
store.setTaskState('look-1', 'done', now);

const flow = store.createFlow({ repo, name: 'UI inspiration', by: 'alex', definitionJson: JSON.stringify(flowFromSteps([{ id: 'find', title: 'Find UI inspiration', kind: 'report' },
  { id: 'pick', title: 'Your pick', kind: 'choose', options: [{ label: 'Implement', goesTo: 'end' }, { label: 'Ignore', goesTo: 'end' }] }], null)) }, now);
const card = store.addFlowCard({ flow, title: 'Settings page', description: null, stage: 'find', by: 'alex' }, now);
store.updateFlowCard(card, { outputs: { find: report.summary } }, now);
store.moveFlowCard(card, { to: 'pick', outcome: 'ok', actor: 'flow', task: 'look-1' }, now);
advanceFlows(store, repo, now, { evidenceRoot });

// Telegram, scripted: what the transport received.
const calls = [];
let id = 100;
const transport = async (method, params, _signal, upload, more) => {
  if (method === 'getUpdates') return { ok: true, result: [] };
  calls.push({ method, params, uploads: [...(upload === undefined ? [] : [upload]), ...(more ?? [])] });
  if (method === 'sendMediaGroup') return { ok: true, result: params.media.map(() => ({ message_id: id++ })) };
  return { ok: true, result: { message_id: id++ } };
};
for (let n = 0; n < 2; n++) await bridgePass(store, { botId: '777', transport, clock: () => new Date(now.getTime() + n * 60_000), readProjects: async () => [repo], conversation: { evidenceRoot, phoneOrigin: () => 'https://toolroll.example' } });
const notice = calls.find(one => one.method === 'sendMessage' && String(one.params.text).includes('Choose one.'));
const album = calls.find(one => one.method === 'sendMediaGroup');
if (!notice || !album) throw Error(`Telegram: ${JSON.stringify(calls.map(one => one.method))}`);

const esc = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const text = String(notice.params.text);
const marks = [...(notice.params.entities ?? [])].sort((a, b) => a.offset - b.offset);
let html = '', at = 0;
for (const mark of marks) {
  html += esc(text.slice(at, mark.offset));
  const inner = esc(text.slice(mark.offset, mark.offset + mark.length));
  html += mark.type === 'bold' ? `<b>${inner}</b>` : mark.type === 'text_link' ? `<a href="${esc(mark.url)}">${inner}</a>` : inner;
  at = mark.offset + mark.length;
}
html += esc(text.slice(at));
const keys = (notice.params.reply_markup?.inline_keyboard ?? []).map(row => `<div class="row">${row.map(one => `<span class="key">${esc(one.text)}</span>`).join('')}</div>`).join('');
const photos = album.params.media.map((one, n) => `<figure><img src="data:image/png;base64,${album.uploads[n].bytes.toString('base64')}"><figcaption>${esc(one.caption ?? '')}</figcaption></figure>`).join('');
const page = `<!doctype html><meta charset="utf-8"><style>
  body{margin:0;background:#0e1621;font:15px/1.35 -apple-system,system-ui,sans-serif;color:#f5f5f5;padding:12px}
  .label{color:#8a9ba8;font-size:12px;text-align:center;margin:4px 0 10px}
  .bubble{background:#182533;border-radius:12px;padding:8px 10px;white-space:pre-wrap;word-wrap:break-word;max-width:340px}
  a{color:#6ab3f3;text-decoration:none} .row{display:flex;gap:4px;margin-top:4px;max-width:360px} .key{flex:1;text-align:center;background:#2b5278aa;border-radius:8px;padding:9px 4px;font-size:14px}
  .album{margin-top:12px;max-width:360px;display:grid;grid-template-columns:1fr 1fr;gap:3px} figure{margin:0;position:relative} img{width:100%;display:block;border-radius:6px}
  figcaption{font-size:12px;color:#c7d3dd;padding:3px 2px 6px}</style>
  <div class="label">Telegram message as the scripted transport received it · synthetic fixture</div>
  <div class="bubble">${html}</div>${keys}<div class="album">${photos}</div>
  <div class="label" style="margin-top:8px">${text.length} characters (limit 4096) · ${marks.filter(one => one.type === 'text_link').length} labelled links</div>`;
const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
await phone.setContent(page);
await phone.screenshot({ path: join(out, 'telegram-message.png'), fullPage: true });
await phone.close();

// The console card, signed in, at desktop and phone sizes.
const server = createDecisionServer({ store, evidenceRoot, repo, chatEnv: {}, configDir: base });
await new Promise(done => server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${server.address().port}`;
try {
  for (const [name, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
    const tab = await context.newPage(), errors = [];
    tab.on('pageerror', e => errors.push(e.message));
    await tab.goto(`${url}/chat`);
    await tab.getByLabel('Username').fill('alex');
    await tab.getByLabel('Password').fill(login.token);
    await Promise.all([tab.waitForNavigation(), tab.getByRole('button', { name: 'Sign in', exact: true }).click()]);
    await tab.goto(`${url}/flows/${flow}?card=${card}`);
    const list = tab.locator('[data-flow-items]');
    await list.waitFor();
    await list.scrollIntoViewIfNeeded();
    await tab.waitForFunction(() => [...document.querySelectorAll('[data-flow-items] img')].every(one => one.complete && one.naturalWidth > 0));
    const facts = await tab.evaluate(() => ({ items: document.querySelectorAll('[data-flow-item]').length, images: document.querySelectorAll('[data-flow-items] img').length, overflow: document.documentElement.scrollWidth > innerWidth }));
    if (facts.items !== 3 || facts.images !== 3 || facts.overflow || errors.length > 0) throw Error(`${name}: ${JSON.stringify({ facts, errors })}`);
    await tab.screenshot({ path: join(out, `console-page-${name}.png`) });
    // The whole box at once: a taller window, so the card's own scroll doesn't cut it.
    await tab.setViewportSize({ width: viewport.width, height: 2000 });
    await tab.locator('[data-flow-choose]').scrollIntoViewIfNeeded();
    await tab.locator('[data-flow-choose]').screenshot({ path: join(out, `console-card-${name}.png`) });
    await context.close();
  }
} finally {
  server.close();
  await browser.close();
  store.close();
  rmSync(base, { recursive: true, force: true });
}
console.log(`Saved to ${out}`);
