// Synthetic visual proof for Telegram decision cards: the exact text and buttons src/telegram-cards.test.ts captured
// from the scripted transport (TELEGRAM_CARDS_OUT), before and after, drawn as phone chat bubbles at 1280px and 390px.
// A fixture preview, not the Telegram app: wrapping, fonts and button truncation on a real phone may differ.
// Usage: node scripts/telegram-cards-proof.mjs evidence/telegram-cards/before.json evidence/telegram-cards/after.json
// Writes PNGs, checks.json and before-after.md beside the inputs. No network and no model.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [beforeFile, afterFile] = process.argv.slice(2).map(one => resolve(one));
if (beforeFile === undefined || afterFile === undefined) throw Error('give the before and after capture files');
const out = dirname(afterFile);
const before = JSON.parse(readFileSync(beforeFile, 'utf8'));
const after = JSON.parse(readFileSync(afterFile, 'utf8'));
const key = one => `${one.family} — ${one.state}`;
const pairs = after.map(one => ({ key: key(one), after: one, before: before.find(old => key(old) === key(one)) ?? null }));

let pw;
for (const root of [join(process.env.REAL_HOME ?? homedir(), '.npm', '_npx')]) for (const d of existsSync(root) ? readdirSync(root) : []) {
  const p = join(root, d, 'node_modules/playwright/index.mjs');
  if (!pw && existsSync(p)) pw = await import(pathToFileURL(p));
}
if (!pw) throw Error('Playwright unavailable');

const esc = text => String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const bubble = card => card === null ? '<div class="bubble none">Not captured before</div>' : `<div class="bubble"><div class="text">${esc(card.text)}</div>${
  card.rows.map(row => `<div class="row">${row.map(one => `<span class="btn ${one.kind}" title="${esc(one.data)}"><span class="label">${esc(one.label)}</span>${one.kind === 'link' ? '<span class="arrow">↗</span>' : ''}</span>`).join('')}</div>`).join('')}</div>`;
const page = (which, families) => `<!doctype html><meta charset="utf-8"><style>
  * { box-sizing: border-box }
  body { margin: 0; background: #efefef; font: 15px/1.35 -apple-system, "SF Pro Text", system-ui, sans-serif; color: #171717 }
  header { padding: 16px; background: #fff; border-bottom: 1px solid #e6e6e6 }
  header h1 { font-size: 17px; margin: 0 0 4px } header p { margin: 0; color: #666; font-size: 13px }
  section { padding: 12px 12px 4px } h2 { font-size: 13px; color: #525252; margin: 8px 4px; font-weight: 600 }
  .cols { display: grid; gap: 12px; grid-template-columns: ${which === 'both' ? '1fr 1fr' : '1fr'} }
  .col h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #666; margin: 0 4px 6px }
  .chat { background: #d9e4ec; border-radius: 12px; padding: 10px }
  .bubble { background: #fff; border-radius: 12px; padding: 8px 10px; max-width: 100%; box-shadow: 0 1px 1px #0001 }
  .bubble.none { color: #666; font-style: italic }
  .text { white-space: pre-wrap; overflow-wrap: anywhere }
  .row { display: flex; gap: 4px; margin-top: 4px }
  .btn { flex: 1 1 0; min-width: 0; min-height: 40px; display: flex; align-items: center; justify-content: center; gap: 4px; padding: 0 8px;
    background: #5a8fbb; color: #fff; border-radius: 8px; font-weight: 500; font-size: 14px }
  .btn .label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
  .btn.link .arrow { font-size: 11px; opacity: .8 }
  @media (max-width: 480px) { .cols { grid-template-columns: 1fr } }
</style><header><h1>Telegram decision cards — fixture preview</h1><p>Exact text and buttons from the scripted Bot API in src/telegram-cards.test.ts, drawn here. Not the Telegram app; not a physical-device trial.</p></header>
${families.map(({ key, before, after }) => `<section><h2>${esc(key)}</h2><div class="cols">${
  which === 'both' ? `<div class="col"><h3>Before</h3><div class="chat">${bubble(before)}</div></div><div class="col"><h3>After</h3><div class="chat">${bubble(after)}</div></div>`
  : `<div class="col"><div class="chat">${bubble(which === 'before' ? before : after)}</div></div>`}</div></section>`).join('')}`;

// The cards a person decides on, as first sent and as armed; the long recap's last part is the one with buttons.
const shown = pairs.filter(one => !one.key.includes('long recap') || one.after.rows.length > 0);
const browser = await pw.chromium.launch({ channel: 'chrome' });
const checks = [];
const shots = [
  { file: 'desktop-before-after.png', width: 1280, which: 'both', cards: shown },
  { file: 'phone-after.png', width: 390, which: 'after', cards: shown },
  { file: 'phone-before.png', width: 390, which: 'before', cards: shown },
  { file: 'phone-after-sent.png', width: 390, which: 'after', cards: shown.filter(one => /— (sent|armed)/.test(one.key)) },
  // One screen each, as a phone and a desktop window first show them: the decision cards a person acts on.
  { file: 'phone-screen-decisions.png', width: 390, which: 'after', screen: true, cards: shown.filter(one => /^(Parked decision|Flow approval|Flow choice) — sent$/.test(one.key)) },
  { file: 'phone-screen-plan-proposal.png', width: 390, which: 'after', screen: true, cards: shown.filter(one => /^(Plan approval|Proposal: irreversible answer) — sent$/.test(one.key)) },
  { file: 'desktop-screen-decisions.png', width: 1280, which: 'both', screen: true, cards: shown.filter(one => /^(Parked decision|Flow approval|Flow choice) — sent$/.test(one.key)) },
];
for (const shot of shots) {
  const tab = await browser.newPage({ viewport: { width: shot.width, height: 844 }, deviceScaleFactor: shot.width < 500 ? 2 : 1 });
  await tab.setContent(page(shot.which, shot.cards));
  // Overflow, tap targets and truncated labels, as this preview draws them.
  const found = await tab.evaluate(() => {
    const problems = [];
    if (document.documentElement.scrollWidth > window.innerWidth) problems.push(`page scrolls sideways: ${document.documentElement.scrollWidth}px`);
    for (const one of document.querySelectorAll('.bubble, .text')) if (one.scrollWidth > one.clientWidth + 1) problems.push(`overflow: ${one.textContent.slice(0, 40)}`);
    for (const one of document.querySelectorAll('.btn')) {
      const box = one.getBoundingClientRect(), label = one.querySelector('.label');
      if (box.height < 40) problems.push(`small tap target: ${one.textContent}`);
      if (label.scrollWidth > label.clientWidth + 1) problems.push(`label cut: ${one.textContent}`);
    }
    return { buttons: document.querySelectorAll('.btn').length, problems };
  });
  checks.push({ file: shot.file, width: shot.width, cards: shot.cards.length, ...found });
  await tab.screenshot({ path: join(out, shot.file), fullPage: shot.screen !== true });
  await tab.close();
}
await browser.close();
writeFileSync(join(out, 'checks.json'), `${JSON.stringify(checks, null, 2)}\n`);

// The exact before/after words and buttons, for the handoff.
const buttons = card => card === null ? '(not captured)' : card.rows.length === 0 ? '(no buttons)'
  : card.rows.map(row => row.map(one => `[${one.label}${one.kind === 'link' ? ' ↗' : ''}] \`${one.kind === 'link' ? 'url' : one.data}\``).join(' ')).join('<br>');
const fence = text => `\`\`\`text\n${text}\n\`\`\``;
const md = pairs.map(({ key, before: old, after: now }) => [`### ${key}`, '', '**Before**', '', old === null ? '(not captured)' : fence(old.text), '', `Buttons: ${buttons(old)}`, '',
  '**After**', '', fence(now.text), '', `Buttons: ${buttons(now)}`, ''].join('\n')).join('\n');
writeFileSync(join(out, 'before-after.md'), `${md}\n`);
console.log(JSON.stringify(checks, null, 2));
