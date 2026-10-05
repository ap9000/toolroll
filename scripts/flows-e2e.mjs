#!/usr/bin/env node
/**
 * Flows, end to end. A throwaway Toolroll instance — the real CLI,
 * the real console (`serve`) and the real worker loop (`watch`) — against a
 * real git repository, driven through a real browser (scripts/e2e-kit.mjs).
 * Every check waits for what a person would see, and reads the database only
 * as the oracle.
 *
 * Each journey is scripted or real-model. A scripted one tests Toolroll's own
 * behaviour (cards moving through zones, scripts, triggers, decisions) with the
 * model scripted (scripts/fixtures/scripted-provider.mjs); a real-model one
 * tests the model integration: the lead drawing flows and scripts from plain
 * words, Jev sorting, a card through a real plan and build.
 *
 *   npm run e2e:flows      (or: node scripts/flows-e2e.mjs [--group <name>] [--journeys scripted|real|all] [--skip-build] [--keep] [--only <pattern>] [--playwright <index.mjs>] [--output <dir>])
 *   node scripts/e2e-parallel.mjs scripts/flows-e2e.mjs      (every group at once, each in its own world)
 *   node scripts/flows-e2e.mjs --groups      (the groups and what each covers)
 *
 * The checks are in groups. Each group runs in a world of its own, so the
 * groups can run at once: every group starts with the first-run setup and ends
 * with the browser-error check, and a check that needs an earlier one is in its
 * group. With no --group, every check runs in one world, one after another.
 *
 * Needs: a built dist/, git, npm, `gh` logged in; for real-model journeys
 * `claude` logged in (subscription), which spends a few subscription turns and
 * one real build. Everything it writes lives in a temporary folder (database,
 * login, worktrees, evidence); the installed Toolroll is never touched.
 */
import { accessSync, constants, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { flag, groupList, mailSink, option, REAL_MODEL, SCRIPTED, Skip, sleep, world } from "./e2e-kit.mjs";

/** The groups, in the order they're listed, with how many journeys each has (the first-run setup included), how many of
 * those are real-model, and how many scripted ones every group shares (checked at the end of every run). */
const GROUPS = {
  build: { journeys: 4, real: 3, shared: 1, about: "The lead saves a script and draws a flow from plain words, and a card goes all the way through a real build" },
  lead: { journeys: 3, real: 2, shared: 1, about: "The lead draws a sorting flow and a reply-and-approve flow from plain words" },
  steps: { journeys: 4, real: 1, shared: 1, about: "Jev sorts through OpenRouter, a Draft step writes with Claude, and web request, email and tool steps reach outside" },
  triggers: { journeys: 9, real: 1, shared: 1, about: "A failing script and Insights, then a public form, a webhook, GitHub, a schedule, mentions, and the lead on where flows break" },
};
/** Not a group: the checks every group has (the first-run setup; the kit adds the browser-error check). */
const EVERY = "every";
const group = option("--group", null);
if (flag("--groups")) {
  const list = groupList(GROUPS);
  console.log(flag("--json") ? JSON.stringify(list) : list.map(one => `${one.name.padEnd(9)} ${String(one.journeys).padStart(2)} journeys (${one.real} real-model)  ${one.about}`).join("\n"));
  process.exit(0);
}
if (group !== null && !(group in GROUPS)) { console.error(`No group "${group}". The groups: ${Object.keys(GROUPS).join(", ")}`); process.exit(2); }
const skipBuild = flag("--skip-build");

const w = await world(group === null ? "flows" : `flows-${group}`, { groups: GROUPS });
const { base, page, cli, rows, until, say, git, json, shot, script, repo, auth } = w;
const root = w.root;
const alexPassword = w.passwords?.alex, samPassword = w.passwords?.sam;
const baseSha = w.listing ? null : git("rev-parse", "HEAD");
const flowView = id => json(`/flows/${id}?format=json`);
/** A check in its group (or in EVERY group), scripted or real-model: it runs when its group, or every group, runs and the
 * run takes its mode; what it needs is in the same group. */
function journey(name, mode, title, needs, body) {
  return w.check(title, needs, body, { mode, groups: name === EVERY ? Object.keys(GROUPS) : [name] });
}
/** Send the lead a message and wait for its reply; returns the reply's text and cards. */
const askLead = message => w.askLead(message, page);
async function confirmCard(reply, label) {
  const card = await w.confirmCard(reply, label);
  const href = await card.locator('a:has-text("Open the flow")').first().getAttribute("href").catch(() => null);
  return { card, href };
}
const signIn = async (name, password) => ({ page: await w.signIn(name) });

// ------------------------------------------------------------------ checks

await journey(EVERY, SCRIPTED, "Sign in and turn the lead chat on (first-run setup)", [], async () => {
  // Onboarding turned the lead on by itself and moved its form to Settings → Lead → Advanced.
  await page.goto(`${base}/settings/lead`);
  await page.locator("details[data-lead-advanced]").evaluate(el => { el.open = true; }).catch(() => undefined);
  await page.selectOption('form[action="/chat/config"] select[name="provider"]', "claude-subscription");
  await page.fill('form[action="/chat/config"] input[name="model"]', "sonnet");
  await page.fill('form[action="/chat/config"] input[name="token"]', alexPassword);
  await Promise.all([page.waitForNavigation(), page.click('form[action="/chat/config"] button[type="submit"]')]);
  await page.goto(`${base}/chat`);
  await page.waitForSelector("[data-workspace-composer] textarea", { timeout: 15_000 });
});

let flowId = null;
await journey("build", REAL_MODEL, "The lead saves a script from plain words (real Claude turn)", ["Sign in and turn the lead chat on (first-run setup)"], async () => {
  const { reply, text } = await askLead("Make a project script called unit-tests that runs npm test, for up to 5 minutes.");
  await shot("lead-script-card");
  await confirmCard(reply, "unit-tests");
  const saved = rows("SELECT name, body, timeout_minutes FROM flow_script WHERE state = 'active'");
  if (!saved.some(one => one.name === "unit-tests" && /npm test/.test(one.body))) throw new Error(`no unit-tests script running npm test was saved: ${JSON.stringify(saved)}; the lead said: ${text.slice(0, 300)}`);
  return { saved };
});

await journey("build", REAL_MODEL, "The lead draws a flow from plain words (real Claude turn)", ["The lead saves a script from plain words (real Claude turn)"], async () => {
  const { reply, text } = await askLead("Make a flow called Bug fixes in this project: new requests wait in an inbox, then an agent builds the fix, then it runs the unit-tests script, then I review it and decide. If the script fails, send the card back to the build.");
  await shot("lead-flow-card");
  const { href } = await confirmCard(reply, "Bug fixes");
  const id = Number(/\/flows\/(\d+)/.exec(href ?? "")?.[1] ?? rows("SELECT id FROM flow ORDER BY id DESC LIMIT 1")[0]?.id);
  if (!id) throw new Error(`no flow was created; the lead said: ${text.slice(0, 300)}`);
  flowId = id;
  const view = await flowView(id);
  const kinds = view.stages.map(one => one.kind);
  const build = view.stages.find(one => one.kind === "task"), script = view.stages.find(one => one.kind === "check"), review = view.stages.find(one => one.kind === "approval");
  const problems = [];
  if (!kinds.includes("inbox")) problems.push("no holding zone");
  if (build === undefined) problems.push("no build zone");
  if (script?.script !== "unit-tests") problems.push(`the script zone runs ${script?.script ?? "nothing"}`);
  if (review === undefined) problems.push("no review zone");
  if (script !== undefined && build !== undefined && script.onFail !== build.id) problems.push(`a failed script goes to ${script.onFail ?? "nowhere"}, not the build`);
  if (problems.length > 0) throw new Error(`${problems.join("; ")}: ${JSON.stringify(view.stages.map(one => [one.title, one.kind, one.next, one.onFail, one.script]))}`);
  return { zones: view.stages.map(one => `${one.title} (${one.kind})`) };
});

await journey("lead", REAL_MODEL, "The lead draws a sorting flow from plain words (real Claude turn)", ["Sign in and turn the lead chat on (first-run setup)"], async () => {
  const { reply, text } = await askLead("Make a flow called Ticket sorter in this project: Jev sorts each new ticket into billing, technical or account questions, each going to its own team's zone, and anything it isn't sure about waits in a zone called Sort by hand. Also note how urgent each ticket is.");
  await shot("lead-sort-card");
  const { href } = await confirmCard(reply, "Ticket sorter");
  const id = Number(/\/flows\/(\d+)/.exec(href ?? "")?.[1] ?? rows("SELECT id FROM flow WHERE name = 'Ticket sorter' ORDER BY id DESC LIMIT 1")[0]?.id);
  if (!id) throw new Error(`no flow was created; the lead said: ${text.slice(0, 300)}`);
  const view = await flowView(id);
  const sort = view.stages.find(one => one.kind === "sort");
  const problems = [];
  if (sort === undefined) problems.push("there's no sort step");
  else {
    if (view.start !== sort.id) problems.push(`new cards start in ${view.start}, not the sort`);
    const targets = new Set(sort.sort.answers.map(one => one.to));
    if (sort.sort.answers.length < 3 || targets.size < 3) problems.push(`it has ${sort.sort.answers.length} answers going to ${targets.size} zones`);
    if (!/by hand/i.test(view.stages.find(one => one.id === sort.onFail)?.title ?? "")) problems.push(`not-sure cards go to ${sort.onFail}`);
    if (!sort.sort.notes.some(one => one.kind === "score" && /urgen/i.test(one.question))) problems.push("it doesn't note urgency");
  }
  if (problems.length > 0) throw new Error(`${problems.join("; ")}: ${JSON.stringify(view.stages.map(one => [one.title, one.kind, one.sort?.answers.map(a => `${a.answer}→${a.to}`), one.onFail]))}`);
  return { answers: sort.sort.answers.map(one => `${one.answer} → ${view.stages.find(z => z.id === one.to)?.title}`), notSure: sort.onFail, sureAt: sort.sort.sureAt };
});

await journey("steps", REAL_MODEL, "Jev sorts real cards through OpenRouter (Exception routing template)", ["Sign in and turn the lead chat on (first-run setup)"], async () => {
  const { namedPath } = await import(new URL("../dist/names.js", import.meta.url).href);
  // Inside the agents' fence (a flow's check zone) the saved key is out of reach, as it is for the worker there.
  try { accessSync(join(namedPath(homedir(), ["keys"], { dot: true }), "openrouter"), constants.R_OK); } catch (error) {
    throw new Skip(error.code === "EPERM" ? "the OpenRouter key saved in Settings → AI providers is out of reach inside the agents' fence" : "needs an OpenRouter key saved in Settings → AI providers");
  }
  // Flows → New → a template's page: name it, then create what it previews.
  await page.goto(`${base}/flows/new/exception-routing`);
  await page.fill('form[data-gallery-use] input[name="name"]', "Support desk");
  await Promise.all([page.waitForNavigation(), page.click('form[data-gallery-use] button[value="create"]')]);
  const id = Number(/\/flows\/(\d+)/.exec(page.url())[1]);
  await page.waitForSelector("[data-zone]");
  const tickets = [
    { title: "Please cancel order #4471", details: "I ordered the wrong size by mistake. Can you cancel it before it ships? Thanks, Priya", expect: ["orders"] },
    { title: "Charged twice for invoice INV-2291", details: "My card was charged twice for the same invoice this morning. I need the duplicate refunded before payroll on Friday.", expect: ["billing"] },
    { title: "Parcel arrived crushed", details: "The box was crushed in transit and two of the glasses inside are broken.", expect: ["delivery"] },
    { title: "Do you have a dark mode?", details: "Just wondering whether the app has a dark mode.", expect: ["by-hand"] },
  ];
  for (const ticket of tickets) {
    await page.click('button:has-text("New card")');
    await page.fill('input[aria-label="Title"]', ticket.title);
    await page.fill('textarea[aria-label="Details"]', ticket.details);
    await page.click('button:has-text("Add card")');
    await until(`“${ticket.title}” on the canvas`, async () => (await flowView(id)).cards.some(one => one.title === ticket.title), { timeoutMs: 15_000, everyMs: 500 });
  }
  const sorted = await until("every card to be sorted", async () => { const cards = (await flowView(id)).cards; return cards.length === tickets.length && cards.every(one => one.stage !== "sort") ? cards : null; }, { timeoutMs: 90_000, everyMs: 2000 });
  const wrong = tickets.flatMap(ticket => { const card = sorted.find(one => one.title === ticket.title); return ticket.expect.includes(card.stage) ? [] : [`${ticket.title} → ${card.stage} (${card.sorted?.chip ?? "no decision"})`]; });
  if (wrong.length > 0) throw new Error(`sorted to the wrong zone: ${wrong.join("; ")}`);
  const runs = rows(`SELECT r.card, r.state, r.decision_json FROM flow_step_run r JOIN flow_card c ON c.id = r.card WHERE c.flow = ${id} AND r.kind = 'sort'`);
  const decisions = runs.map(one => JSON.parse(one.decision_json ?? "null"));
  if (runs.length !== tickets.length || decisions.some(one => one === null)) throw new Error(`not every card kept its decision: ${JSON.stringify(runs.map(one => [one.card, one.state]))}`);
  const invoice = decisions.find(one => one.answer === "Invoice problem");
  if (invoice?.notes.find(one => one.id === "refund")?.answer !== "yes") throw new Error(`the invoice card's refund note says ${JSON.stringify(invoice?.notes)}`);
  // What a person sees: the chip on the card, and the Sorting section of Insights.
  await page.reload(); await page.waitForSelector("[data-zone]");
  const chip = await page.locator(`[data-card="${sorted.find(one => one.title.startsWith("Charged twice")).id}"] [data-sort-chip]`).innerText();
  if (!/Invoice problem/.test(chip)) throw new Error(`the card's chip says ${chip}`);
  await shot("sort-canvas");
  await page.click("[data-open-insights]");
  const summary = await page.locator('[data-insights-sort="sort"]').innerText({ timeout: 15_000 });
  if (!/4 sorted/.test(summary)) throw new Error(`Insights says: ${summary}`);
  await shot("sort-insights");
  return { zones: sorted.map(one => `${one.title} → ${one.stage} (${one.sorted?.chip})`), ms: decisions.map(one => one.ms), costUsd: decisions.reduce((sum, one) => sum + (one.cost ?? 0), 0) };
});

await journey("steps", SCRIPTED, "A Draft step writes a reply with Claude, and the owner edits and approves it", ["Sign in and turn the lead chat on (first-run setup)"], async () => {
  script({ role: "draft", when: [/Refund for order 42\?/], answer: { text: "Hi Priya, sorry about the double charge on order 42. We've refunded the extra charge to your card; it takes up to 5 days to show. Thanks for your patience!" } });
  // Flows → New → a template's page: name it, then create what it previews.
  await page.goto(`${base}/flows/new/blank`);
  const csrf = await page.locator('input[name="csrf"]').first().inputValue();
  await page.fill('form[data-gallery-use] input[name="name"]', "Replies");
  await Promise.all([page.waitForNavigation(), page.click('form[data-gallery-use] button[value="create"]')]);
  const id = Number(/\/flows\/(\d+)/.exec(page.url())[1]);
  const view = await flowView(id);
  if (view.flow.owner !== "alex") throw new Error(`the flow's owner is ${view.flow.owner}, not whoever made it`);
  const zone = (x, color) => ({ x, y: 0, w: 260, h: 300, color });
  const base0 = { instructions: null, planning: null, approver: null, message: null, close: null, script: null, sort: null };
  const drawing = { version: 1, start: "inbox", stages: [
    { ...view.stages.find(one => one.id === "inbox"), next: "reply" },
    { ...base0, id: "reply", title: "Write the reply", kind: "draft", zone: zone(300, "violet"), instructions: "Write a short, friendly reply to the customer. Confirm the refund and say it takes up to 5 days.", next: "check", onFail: null },
    { ...base0, id: "check", title: "Check the reply", kind: "approval", toOwner: true, zone: zone(600, "amber"), next: "post", onFail: "reply" },
    { ...base0, id: "post", title: "Post it", kind: "notify", zone: zone(900, "green"), message: "{{stage.reply}}", next: "done", onFail: null },
    { ...view.stages.find(one => one.id === "done"), zone: zone(1200, "green") },
  ] };
  const saved = await page.request.post(`${base}/flows/${id}/save`, { form: { csrf, name: "Replies", owner: "alex", revision: String(view.flow.revision), definition: JSON.stringify(drawing) }, headers: { accept: "application/json", origin: base } });
  if (!saved.ok()) throw new Error(`the drawing wasn't saved: ${await saved.text()}`);
  await page.reload(); await page.waitForSelector("[data-zone]");
  await page.click('button:has-text("New card")');
  await page.fill('input[aria-label="Title"]', "Refund for order 42?");
  await page.fill('textarea[aria-label="Details"]', "Hi, I was charged twice for order 42 yesterday. Can I get one of the charges refunded? Thanks, Priya");
  await page.click('button:has-text("Add card")');
  const card = await until("the card", async () => (await flowView(id)).cards.find(one => one.title === "Refund for order 42?"));
  await page.locator(`[data-card="${card.id}"]`).click();
  await page.selectOption("#flow-move", "reply");
  // Claude writes it (the lead's sign-in, no tools); the card waits for the owner with the draft.
  const waiting = await until("Claude's draft", async () => { const one = (await flowView(id)).cards.find(c => c.id === card.id); return one?.stage === "check" && one.draft !== null ? one : null; }, { timeoutMs: 240_000, everyMs: 3000 });
  const draft = waiting.draft.text;
  if (draft.length < 40 || !/refund/i.test(draft)) throw new Error(`the draft doesn't read like a refund reply: ${draft.slice(0, 300)}`);
  const decision = rows(`SELECT recipient, body FROM notification WHERE kind = 'flow-decision' ORDER BY id DESC LIMIT 1`)[0];
  if (decision?.recipient !== "alex" || !decision.body.includes(draft.slice(0, 60))) throw new Error(`the decision didn't go to the owner with the draft: ${JSON.stringify(decision)}`);
  // The owner edits it in the card's panel and approves: their version is what gets posted.
  await page.reload(); await page.waitForSelector("[data-zone]");
  await page.locator(`[data-card="${card.id}"]`).click();
  const box = page.locator("[data-flow-draft-edit]");
  await box.waitFor();
  if ((await box.inputValue()).trim() !== draft.trim()) throw new Error("the panel doesn't show Claude's draft to edit");
  const edited = `${draft.trim()}\n\n— Alex`;
  await box.fill(edited);
  await shot("draft-review");
  await page.click('[data-flow-card-panel] button:has-text("Approve")');
  await until("the card to be done", async () => (await flowView(id)).cards.find(one => one.id === card.id)?.state === "done");
  const posted = rows(`SELECT body FROM notification WHERE kind = 'flow-message' ORDER BY id DESC LIMIT 1`)[0]?.body ?? "";
  if (!posted.startsWith(edited)) throw new Error(`what was posted isn't the owner's version: ${posted.slice(0, 200)}`);
  const run = rows(`SELECT kind, state, result, duration_ms FROM flow_step_run WHERE card = ${card.id} AND kind = 'draft'`)[0];
  return { draft: draft.slice(0, 200), seconds: Math.round(run.duration_ms / 100) / 10, result: run.result };
});

await journey("lead", REAL_MODEL, "The lead drafts a reply-and-approve flow from plain words (real Claude turn)", ["Sign in and turn the lead chat on (first-run setup)"], async () => {
  let { reply, text } = await askLead("Make a flow called Customer replies in this project: Claude drafts a reply to each new question, I approve or edit it in my chat app, then it's posted to the team chat.");
  // An earlier check made a similar "Replies" flow, and the lead may fairly ask whether to reuse it: answered the way a person would.
  const drafted = await reply.locator('[data-view="chat-card"][data-card-state="pending"]').filter({ hasText: "Customer replies" }).first().waitFor({ timeout: 10_000 }).then(() => true, () => false);
  if (!drafted && /\?/.test(text)) {
    ({ reply, text } = await askLead("A separate new flow, please: draft Customer replies."));
  }
  const { href } = await confirmCard(reply, "Customer replies");
  const id = Number(/\/flows\/(\d+)/.exec(href ?? "")?.[1] ?? rows("SELECT id FROM flow WHERE name = 'Customer replies' ORDER BY id DESC LIMIT 1")[0]?.id);
  if (!id) throw new Error(`no flow was created; the lead said: ${text.slice(0, 300)}`);
  const view = await flowView(id);
  const draft = view.stages.find(one => one.kind === "draft");
  const decide = draft === undefined ? undefined : view.stages.find(one => one.id === draft.next);
  const sends = decide === undefined ? undefined : view.stages.find(one => one.id === decide.next);
  const problems = [];
  if (draft === undefined) problems.push("there's no draft step");
  if (decide?.kind !== "approval" || !(decide.toOwner === true || decide.approver === "alex")) problems.push(`after the draft comes ${decide?.kind ?? "nothing"}${decide?.kind === "approval" ? " decided by someone other than the person who asked" : ""}`);
  if (sends === undefined || !/\{\{\s*stage\.[a-z0-9-]+\s*\}\}/.test(sends.message ?? "")) problems.push(`the step after the decision doesn't send the draft: ${JSON.stringify(sends?.message)}`);
  if (problems.length > 0) throw new Error(`${problems.join("; ")}: ${JSON.stringify(view.stages.map(one => [one.title, one.kind, one.next, one.toOwner ?? one.approver, one.message]))}`);
  return { steps: view.stages.map(one => `${one.title} (${one.kind})`) };
});

await journey("steps", SCRIPTED, "Web request, email and tool steps reach outside for real: a web server, a mail server and an MCP tool", ["Sign in and turn the lead chat on (first-run setup)"], async () => {
  const calls = [];
  const web = createHttpServer((request, response) => { let body = ""; request.on("data", chunk => { body += chunk; }); request.on("end", () => { calls.push({ url: request.url, auth: request.headers["authorization"], body }); response.writeHead(201, { "content-type": "application/json" }); response.end('{"ticket": "T-1042"}'); }); });
  await new Promise(done => web.listen(0, "127.0.0.1", done));
  const mail = await mailSink();
  const echo = join(root, "echo-mcp.mjs");
  writeFileSync(echo, `import { createInterface } from "node:readline";
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") reply(message.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "chat", version: "1" } });
  else if (message.method === "tools/list") reply(message.id, { tools: [{ name: "post_message", inputSchema: { type: "object" } }] });
  else if (message.method === "tools/call") reply(message.id, { content: [{ type: "text", text: "posted to " + message.params.arguments.channel + ": " + message.params.arguments.text }] });
});
`);
  try {
    // Settings → Email, through the page, and its test email.
    await page.goto(`${base}/settings#email`);
    await page.waitForSelector("[data-email-settings]");
    await page.fill("#email-host", "127.0.0.1"); await page.fill("#email-port", String(mail.port)); await page.fill("#email-from", "team@shop.example");
    await Promise.all([page.waitForNavigation(), page.click('[data-email-settings] button:has-text("Save email")')]);
    await page.click('#email button:has-text("Change")');
    await Promise.all([page.waitForNavigation(), page.click('[data-email-settings] button:has-text("Send a test email")')]);
    await until("the test email", async () => mail.received.length === 1, { timeoutMs: 15_000, everyMs: 500 });
    await shot("settings-email");
    // A project tool, added the way the Tools page adds one, and tested.
    const csrf = await page.locator('input[name="csrf"]').first().inputValue();
    for (const form of [{ action: "add-custom", name: "chat", transport: "stdio", target: `${process.execPath} ${echo}`, password: alexPassword }, { action: "test", name: "chat" }]) {
      const answered = await page.request.post(`${base}/settings/tools/change`, { form: { csrf, repo, shown: repo, ...form }, headers: { origin: base }, maxRedirects: 0 });
      if (answered.status() >= 400) throw new Error(`the Tools page refused ${form.action}: ${answered.status()}`);
    }
    // The flow: call the web server, post to the tool, email whoever asked.
    // Flows → New → a template's page: name it, then create what it previews.
    await page.goto(`${base}/flows/new/blank`);
    await page.fill('form[data-gallery-use] input[name="name"]', "Intake");
    await Promise.all([page.waitForNavigation(), page.click('form[data-gallery-use] button[value="create"]')]);
    const id = Number(/\/flows\/(\d+)/.exec(page.url())[1]);
    const view = await flowView(id);
    const zone = x => ({ x, y: 0, w: 260, h: 300, color: "blue" });
    const none = { instructions: null, planning: null, approver: null, message: null, close: null, script: null, sort: null };
    const drawing = { version: 1, start: "call", stages: [
      { ...none, id: "call", title: "Log it", kind: "request", zone: zone(0), request: { method: "POST", url: `http://127.0.0.1:${web.address().port}/tickets`, headers: { Authorization: "Bearer {{secret.DESK_TOKEN}}" }, body: '{"subject": "{{card.title}}", "from": "{{card.email}}"}' }, next: "post", onFail: "inbox" },
      { ...none, id: "post", title: "Tell the team", kind: "tool", zone: zone(300), tool: { server: "chat", name: "post_message", args: '{"channel": "#support", "text": "{{card.title}} ({{stage.call}})"}' }, next: "mail", onFail: "inbox" },
      { ...none, id: "mail", title: "Email them", kind: "email", zone: zone(600), email: { to: "{{card.email}}", subject: "We got it: {{card.title}}", body: "Thanks! Your ticket: {{stage.call}}" }, next: "done", onFail: "inbox" },
      { ...view.stages.find(one => one.id === "inbox"), next: null, zone: { x: 300, y: 380, w: 260, h: 300, color: "slate" } },
      { ...view.stages.find(one => one.id === "done"), zone: zone(900) },
    ] };
    const saved = await page.request.post(`${base}/flows/${id}/save`, { form: { csrf, name: "Intake", owner: "alex", revision: String(view.flow.revision), definition: JSON.stringify(drawing) }, headers: { accept: "application/json", origin: base } });
    if (!saved.ok()) throw new Error(`the drawing wasn't saved: ${await saved.text()}`);
    const secret = `desk-${randomBytes(6).toString("hex")}`;
    const kept = await page.request.post(`${base}/flows/${id}/secrets`, { form: { csrf, name: "DESK_TOKEN", value: secret }, headers: { accept: "application/json", origin: base } });
    if (!kept.ok()) throw new Error(`the secret wasn't saved: ${await kept.text()}`);
    await page.reload(); await page.waitForSelector("[data-zone]");
    await page.click('button:has-text("New card")');
    await page.fill('input[aria-label="Title"]', "Printer on fire");
    await page.fill('textarea[aria-label="Details"]', "It's smoking. Reach me at priya@example.com");
    await page.click('button:has-text("Add card")');
    const card = await until("the card to be done", async () => (await flowView(id)).cards.find(one => one.title === "Printer on fire" && one.state === "done"), { timeoutMs: 90_000, everyMs: 2000 });
    const problems = [];
    if (calls[0]?.auth !== `Bearer ${secret}` || !calls[0]?.body.includes('"from":"priya@example.com"')) problems.push(`the web server got ${JSON.stringify(calls[0])}`);
    const posted = card.outputs.find(one => one.stage === "post")?.text ?? "";
    if (posted !== 'posted to #support: Printer on fire ({"ticket": "T-1042"})') problems.push(`the tool answered ${posted}`);
    const email = mail.received[1];
    if (email?.to[0] !== "<priya@example.com>" || !email.data.includes('Thanks! Your ticket: {"ticket": "T-1042"}')) problems.push(`the email was ${JSON.stringify(email)}`);
    const logs = rows(`SELECT log FROM flow_step_run r JOIN flow_card c ON c.id = r.card WHERE c.flow = ${id}`).map(one => one.log ?? "").join("\n");
    if (logs.includes(secret)) problems.push("the secret reached a run log");
    if (problems.length > 0) throw new Error(problems.join("; "));
    await page.reload(); await page.waitForSelector("[data-zone]");
    await shot("outside-steps");
    return { request: calls[0].url, tool: posted, emails: mail.received.length };
  } finally {
    web.close(); mail.server.close();
  }
});

let buildCard = null;
await journey("build", REAL_MODEL, "A card goes all the way through with a real build, a real script and a person's decision", ["The lead draws a flow from plain words (real Claude turn)"], async () => {
  if (skipBuild) throw new Skip("--skip-build");
  await page.goto(`${base}/flows/${flowId}`);
  await page.waitForSelector("[data-zone]");
  await page.click('button:has-text("New card")');
  await page.fill('input[aria-label="Title"]', "Add a greet function");
  await page.fill('textarea[aria-label="Details"]', "Add src/greet.js exporting greet(name) that returns `Hello, ${name}!`, with a node:test test in test/greet.test.js. Keep the existing tests passing.");
  await page.click('button:has-text("Add card")');
  const view = await until("the card on the canvas", async () => (await flowView(flowId)).cards.find(one => one.title === "Add a greet function"));
  buildCard = view.id;
  const zones = (await flowView(flowId)).stages;
  const build = zones.find(one => one.kind === "task"), script = zones.find(one => one.kind === "check"), review = zones.find(one => one.kind === "approval");
  // Move it to the build through the card's own panel.
  await page.locator(`[data-card="${buildCard}"]`).click();
  await page.selectOption("#flow-move", build.id);
  const filed = await until("the build zone to file a task", async () => (await flowView(flowId)).cards.find(one => one.id === buildCard)?.task?.id, { timeoutMs: 60_000 });
  say(`      filed task ${filed}; waiting for it to be ready to approve`);
  // Planning may run first (a real Claude plan); approval comes when the exact work is ready.
  await until("the task to wait for approval", async () => {
    const task = cli(["task", "show", filed]);
    const plan = rows(`SELECT plan FROM task_ref WHERE external_id = '${filed}'`)[0]?.plan ?? null;
    return task.scope !== null && task.scope.digest !== task.scope.approvedDigest && plan !== "requested" ? task : null;
  }, { timeoutMs: 8 * 60_000, everyMs: 4000 });
  const scope = cli(["task", "show", filed]).scope;
  cli(["task", "approve", filed, "--yes", "--digest", scope.digest, ...auth]);
  say("      approved; the worker builds it with Claude");
  await until("the card to reach the review zone", async () => {
    const card = (await flowView(flowId)).cards.find(one => one.id === buildCard);
    if (card?.stage === build.id && /failed|cancelled/i.test(card.waiting ?? "")) throw new Error(`the build stopped: ${card.waiting}`);
    return card?.stage === review.id ? card : null;
  }, { timeoutMs: 25 * 60_000, everyMs: 5000 });
  const scriptRun = rows(`SELECT state, exit_code, script, log FROM flow_step_run WHERE card = ${buildCard} AND stage = '${script.id}'`)[0];
  if (scriptRun?.state !== "passed" || scriptRun.exit_code !== 0) throw new Error(`the unit-tests script didn't pass: ${JSON.stringify(scriptRun)}`);
  // The kept log is the whole run, summary included: the seed's one test plus the agent's new one, on the built commit.
  const passedTests = Number(/# pass (\d+)/.exec(scriptRun.log ?? "")?.[1] ?? 0);
  if (passedTests < 2 || !/# fail 0/.test(scriptRun.log ?? "")) throw new Error(`the script's log should end with at least 2 passing tests and none failing: …${(scriptRun.log ?? "").slice(-400)}`);
  // The person decides, in the card's panel.
  await page.reload(); await page.waitForSelector("[data-zone]");
  await page.locator(`[data-card="${buildCard}"]`).click();
  await page.click('[data-flow-card-panel] button:has-text("Approve")');
  await until("the card to be done", async () => (await flowView(flowId)).cards.find(one => one.id === buildCard)?.state === "done");
  const branch = rows(`SELECT branch FROM run WHERE role = 'builder' AND outcome = 'built' ORDER BY id DESC LIMIT 1`)[0]?.branch;
  const changed = git("diff", "--name-only", baseSha, branch).split("\n");
  if (!changed.includes("src/greet.js")) throw new Error(`the build didn't add src/greet.js: ${changed.join(", ")}`);
  await shot("card-done");
  return { task: filed, branch, changed, scriptLog: scriptRun.log.slice(-300) };
});

let checksFlow = null;
await journey("triggers", SCRIPTED, "A failing script sends the card back, and Insights show where and why", ["Sign in and turn the lead chat on (first-run setup)"], async () => {
  // A script made on the Scripts panel.
  // Flows → New → a template's page: name it, then create what it previews.
  await page.goto(`${base}/flows/new/blank`);
  const csrf = await page.locator('input[name="csrf"]').first().inputValue();
  await page.fill('form[data-gallery-use] input[name="name"]', "Checks");
  await Promise.all([page.waitForNavigation(), page.click('form[data-gallery-use] button[value="create"]')]);
  checksFlow = Number(/\/flows\/(\d+)/.exec(page.url())[1]);
  await page.waitForSelector("[data-zone]");
  await page.click("[data-open-scripts]");
  if (await page.locator('[data-flow-scripts] button:has-text("New script")').count()) await page.click('[data-flow-scripts] button:has-text("New script")');
  const form = page.locator("[data-script-form]");
  await form.locator("label", { hasText: "Name" }).locator("input").fill("lint");
  await form.locator("label", { hasText: "What it checks" }).locator("input").fill("Fails on purpose: two lint problems");
  await form.locator("label", { hasText: "Script" }).locator("textarea").fill("echo \"2 problems found in src/math.js\" >&2\nexit 1");
  await form.locator('button[type="submit"]').click();
  await until("the lint script to be saved", async () => rows("SELECT name FROM flow_script WHERE name = 'lint' AND state = 'active'").length === 1);
  // The flow's drawing, saved through the canvas's own endpoint: Inbox → Lint (fails back to Inbox) → Done.
  const view = await flowView(checksFlow);
  const drawing = { version: 1, start: "inbox", stages: [
    { ...view.stages.find(one => one.id === "inbox"), next: "lint" },
    { id: "lint", title: "Lint", kind: "check", zone: { x: 300, y: 0, w: 260, h: 300, color: "blue" }, instructions: null, planning: null, approver: null, message: null, close: null, script: "lint", next: "done", onFail: "inbox" },
    { ...view.stages.find(one => one.id === "done"), zone: { x: 600, y: 0, w: 260, h: 300, color: "green" } },
  ] };
  const saved = await page.request.post(`${base}/flows/${checksFlow}/save`, { form: { csrf, name: "Checks", revision: String(view.flow.revision), definition: JSON.stringify(drawing) }, headers: { accept: "application/json", origin: base } });
  if (!saved.ok()) throw new Error(`saving the drawing answered ${saved.status()}: ${await saved.text()}`);
  await page.reload(); await page.waitForSelector('[data-zone="lint"]');
  // A card moved into Lint by hand.
  await page.click('button:has-text("New card")');
  await page.fill('input[aria-label="Title"]', "Check the math module");
  await page.click('button:has-text("Add card")');
  const card = await until("the card", async () => (await flowView(checksFlow)).cards.find(one => one.title === "Check the math module"));
  await page.locator(`[data-card="${card.id}"]`).click();
  await page.selectOption("#flow-move", "lint");
  await until("the worker to run lint and send the card back", async () => { const now = (await flowView(checksFlow)).cards.find(one => one.id === card.id); return now?.stage === "inbox" && now.history.some(line => /problem|failed/i.test(line.text)) ? now : null; }, { timeoutMs: 90_000, everyMs: 2000 });
  const note = rows(`SELECT note FROM flow_card WHERE id = ${card.id}`)[0]?.note ?? "";
  if (!/lint failed \(exit 1\)/.test(note) || !/2 problems found/.test(note)) throw new Error(`the card's note doesn't say why: ${note}`);
  // Insights, in the browser.
  await page.reload(); await page.waitForSelector("[data-zone]");
  await page.click("[data-open-insights]");
  await page.waitForSelector("[data-flow-insights] table");
  const breaks = await page.locator("[data-flow-insights] section", { hasText: "Where it breaks" }).innerText();
  if (!/Lint/.test(breaks)) throw new Error(`Insights don't name Lint: ${breaks}`);
  await page.locator("[data-run] button").first().click();
  const log = await page.locator("[data-run-log]").innerText();
  if (!/2 problems found/.test(log)) throw new Error(`the run's log doesn't show the output: ${log.slice(0, 300)}`);
  await shot("insights");
  return { note, breaks: breaks.replace(/\s+/g, " ").slice(0, 200) };
});

const trigger = async (flow, fill) => {
  await page.goto(`${base}/flows/${flow}`); await page.waitForSelector("[data-zone]");
  await page.click("[data-open-triggers]"); await page.waitForSelector("[data-flow-triggers]");
  await page.locator("[data-flow-triggers] details").first().evaluate(node => { node.open = true; });
  const form = page.locator("[data-add-trigger]");
  await fill(form);
  await form.locator('button[type="submit"]').click();
  await sleep(1200);
};
const pick = (form, label, value) => form.locator("label", { hasText: label }).locator("select").selectOption(value);
const type = (form, label, value) => form.locator("label", { hasText: label }).locator("input, textarea").first().fill(value);

await journey("triggers", SCRIPTED, "A button shared as a public form makes a card without signing in", ["A failing script sends the card back, and Insights show where and why"], async () => {
  await trigger(checksFlow, async form => { await pick(form, "What starts cards", "button"); await type(form, "Button name", "Report a bug"); await type(form, "Questions it asks", "What happened?\nWhere?"); });
  const row = page.locator("[data-trigger-row]", { hasText: "Report a bug" });
  await row.locator("button", { hasText: "Share as a form" }).click();
  await page.waitForSelector("[data-trigger-reveal]");
  const path = /\/hooks\/form\/[A-Za-z0-9_-]+/.exec(await page.locator("[data-trigger-reveal]").innerText())?.[0];
  if (path === undefined) throw new Error("no form link was shown");
  const form = await fetch(`${base}${path}`);
  const html = await form.text();
  if (form.status !== 200 || !html.includes("What happened?") || html.includes("Checks")) throw new Error(`the public form page is wrong (${form.status})`);
  const shown = /name="t" value="(\d+)"/.exec(html)[1];
  await sleep(2500);
  const sent = await fetch(`${base}${path}`, { method: "POST", body: new URLSearchParams({ t: shown, website: "", a0: "Search is slow on the phone", a1: "The search page" }) });
  if (!(await sent.text()).includes("Thanks")) throw new Error("the form didn't thank the sender");
  const card = await until("the form's card", async () => (await flowView(checksFlow)).cards.find(one => one.title === "Search is slow on the phone"));
  return { source: card.source?.label };
});

await journey("triggers", SCRIPTED, "A webhook trigger makes a card from a posted JSON body", ["A failing script sends the card back, and Insights show where and why"], async () => {
  await trigger(checksFlow, async form => { await pick(form, "What starts cards", "webhook"); await type(form, "Title field", "alert.title"); });
  const path = /\/hooks\/flow\/[A-Za-z0-9_-]+/.exec(await page.locator("[data-trigger-reveal]").innerText())?.[0];
  if (path === undefined) throw new Error("no webhook address was shown");
  const sent = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-request-id": "e2e-1" }, body: JSON.stringify({ alert: { title: "Deploy failed on web-2" }, description: "Health check timed out" }) });
  if (sent.status !== 202) throw new Error(`the delivery answered ${sent.status}: ${await sent.text()}`);
  await until("the webhook's card", async () => (await flowView(checksFlow)).cards.find(one => one.title === "Deploy failed on web-2"));
  const again = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-request-id": "e2e-1" }, body: JSON.stringify({ alert: { title: "Deploy failed on web-2" } }) });
  if (!(await again.text()).includes("Nothing new")) throw new Error("the same delivery made a second card");
});

await journey("triggers", SCRIPTED, "A GitHub trigger checks a real repository with gh (Check now)", ["A failing script sends the card back, and Insights show where and why"], async () => {
  await trigger(checksFlow, async form => { await pick(form, "What starts cards", "github"); await type(form, "Repository", "ap9000/standing-orders"); await pick(form, "Watch", "checks"); });
  const row = page.locator("[data-trigger-row]", { hasText: "Failed checks on main" });
  await row.locator("button", { hasText: "Check now" }).click();
  await until("the check's answer", async () => /Nothing new|Added/.test(await row.innerText()), { timeoutMs: 45_000 });
  return { status: (await row.innerText()).replace(/\s+/g, " ").slice(0, 160) };
});

const scheduleAddedAt = Date.now();
// Daily at the next whole minute at least 45 s away (UTC): it fires in about a minute, where the
// shortest "every" schedule (5 minutes) kept the whole run waiting for it.
const fireAt = new Date(Math.ceil((scheduleAddedAt + 45_000) / 60_000) * 60_000);
const scheduled = await journey("triggers", SCRIPTED, "A schedule trigger is added (checked at the end)", ["A failing script sends the card back, and Insights show where and why"], async () => {
  await trigger(checksFlow, async form => { await pick(form, "What starts cards", "schedule"); await type(form, "When", `daily ${fireAt.toISOString().slice(11, 16)}`); await type(form, "Card title", "Health check"); });
  if ((await page.locator("[data-trigger-row]", { hasText: "Health check" }).count()) === 0) throw new Error("the schedule trigger isn't listed");
});

await journey("triggers", SCRIPTED, "People: a mention reaches only the person mentioned, who then sees the card as theirs", ["A failing script sends the card back, and Insights show where and why"], async () => {
  await page.goto(`${base}/flows/${checksFlow}`); await page.waitForSelector("[data-zone]");
  const card = (await flowView(checksFlow)).cards.find(one => one.title === "Check the math module");
  await page.locator(`[data-card="${card.id}"]`).click();
  const box = page.locator('[data-flow-discussion] textarea[aria-label="Comment"]');
  await box.fill("Lint is failing on purpose here. @sa");
  await page.locator('[aria-label="People to mention"] button', { hasText: "sam" }).click();
  await box.fill(`${await box.inputValue()}can you take a look?`);
  await page.click('[data-flow-discussion] button:has-text("Comment")');
  await until("the comment", async () => (await flowView(checksFlow)).cards.find(one => one.id === card.id)?.comments.length === 1);
  const notes = rows("SELECT recipient, subject FROM notification WHERE kind = 'flow-card' ORDER BY id");
  if (!notes.some(one => one.recipient === "sam" && /mentioned you/.test(one.subject))) throw new Error(`no mention notification for sam: ${JSON.stringify(notes)}`);
  if (notes.some(one => one.recipient === "alex" && /mentioned you/.test(one.subject))) throw new Error("alex was pinged about their own comment");
  const sam = await signIn("sam", samPassword);
  const samView = await (await sam.page.request.get(`${base}/flows/${checksFlow}?format=json`)).json();
  const seen = samView.cards.find(one => one.id === card.id);
  if (!seen?.mine || !seen.watching) throw new Error(`sam doesn't see it as theirs: ${JSON.stringify({ mine: seen?.mine, watching: seen?.watching })}`);
  return { notifications: notes };
});

await journey("triggers", REAL_MODEL, "The lead explains where the flows break (real Claude turn)", ["A failing script sends the card back, and Insights show where and why"], async () => {
  const { text } = await askLead("Where do my flows break? Keep it short.");
  if (!/lint/i.test(text)) throw new Error(`the answer doesn't mention the failing Lint step: ${text.slice(0, 400)}`);
  return { answer: text.slice(0, 400) };
});

await journey("triggers", SCRIPTED, "The schedule trigger makes its card on time", ["A schedule trigger is added (checked at the end)"], async () => {
  if (scheduled === null || scheduled === undefined) throw new Skip("this run didn't add the schedule trigger");
  const card = await until("the scheduled card", async () => (await flowView(checksFlow)).cards.find(one => one.title.startsWith("Health check")), { timeoutMs: Math.max(30_000, fireAt.getTime() + 60_000 - Date.now()), everyMs: 5000 });
  return { title: card.title, minutes: Math.round((Date.now() - scheduleAddedAt) / 6000) / 10 };
});

await w.finish(group === null ? "Flows end to end" : `Flows end to end: ${group}`);
