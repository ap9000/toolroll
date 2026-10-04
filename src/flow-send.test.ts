/**
 * "Send to me" and "Person chooses" (flow-send.ts): what a card's step before produced reaches the card's person —
 * summary, links and screenshots — and a choice comes back by button or reply, through one door, for exactly the
 * visit it was about. Also: a build step in another project, and the gallery's optional "Send me the result".
 * Scripted Telegram transport and a real store; no live account. Slack, Discord and Teams rendering is tested in
 * their own files.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FLOW_SHOTS_KIND, openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { storeEvidence } from "./evidence.js";
import { advanceFlows, crossProjectProblem, flowDefinitionOf } from "./flow-engine.js";
import { chooseFlowCard, flowChoiceAt, readFlowSend } from "./flow-send.js";
import { flowFromSteps, flowTerms, validateFlowDefinition, type FlowDefinition } from "./flows.js";
import { BLANK, buildFromGallery, GALLERY, galleryDiagram, galleryTemplateOf, SEND_RESULT, withSendResult } from "./flow-gallery.js";
import { bridgePass, hashPairingCode, mintPairingCode, PAIRING_TTL_MS, type TelegramTransport } from "./telegram.js";
import { flowView } from "./flows-ui.js";
import { createDecisionServer } from "./serve.js";

const T0 = new Date("2026-10-03T09:00:00.000Z");
const ALPHA = "/projects/alpha", BETA = "/projects/beta";
const BOT = "777000", CHAT = 4242, ORIGIN = "https://console.example";
const legacy = { route: { routeDigest: "legacy", phase: "build" as const, provider: "claude", model: null, chosen: "legacy" as const } };

/** A real PNG header with the given size; the rest is filler. */
function png(width: number, height: number, fill = 7): Buffer {
  const head = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write("IHDR", 12, "ascii");
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return Buffer.concat([head, Buffer.alloc(300, fill)]);
}

let dir: string, root: string, store: Store, now: Date, alexToken: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-flow-send-")));
  root = join(dir, "evidence");
  mkdirSync(root);
  store = openStore(join(dir, "state.db"));
  now = T0;
  const alex = addApprover(store, "alex", now);
  if (!alex.ok) throw new Error("approver");
  alexToken = alex.token;
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

/** A finished build of one task, with saved screenshots and its own report. */
function built(id: string, title: string, shots = 3, repo = ALPHA) {
  store.createTask({ id, title }, now);
  const ref = store.refFor("built-in", id).id;
  store.placeTask(ref, repo, {}, now);
  const run = store.startRun({ taskRef: ref, leaseId: `l-${id}`, runner: "worker-1", branch: `so/${id}`, worktree: `/pool/${id}`, ...legacy, now });
  for (let n = 0; n < shots; n++) storeEvidence(store, root, run, "screenshot", `shot-${n}.png`, png(390 + n, 844, n + 1), `agent-claimed screenshot at evidence/shot-${n}.png (validated png)`, now);
  store.recordOutcomeFacts(run, { handoff: "Totals now round half-up, with a regression test." });
  store.finishRun(run, { outcome: "built", committed: true, now });
  store.setTaskState(id, "done", now);
  return { ref, run };
}

const STEPS = [
  { id: "build", title: "Build", kind: "task" as const },
  { id: "choose", title: "What next?", kind: "choose" as const, options: [{ label: "Ship it", goesTo: "Ship" }, { label: "Ignore", goesTo: "end" }], remindAfter: "2 days", ifNoReply: "Parked" },
  { id: "ship", title: "Ship", kind: "inbox" as const },
  { id: "parked", title: "Parked", kind: "inbox" as const },
];
/** A flow of these steps, and a card whose build just finished and handed its task on to `at`. */
function cardAt(steps: unknown[], at: string, task: string | null): { flow: number; card: number } {
  const flow = store.createFlow({ repo: ALPHA, name: "Fixes", by: "alex", definitionJson: JSON.stringify(flowFromSteps(steps, null)) }, now);
  const card = store.addFlowCard({ flow, title: "Checkout rounding", description: "Totals are off by a cent", stage: "build", by: "alex" }, now);
  if (task !== null) store.updateFlowCard(card, { primaryTask: task, outputs: { build: `Result ready on task ${task}.` } }, now);
  expect(store.moveFlowCard(card, { to: at, outcome: "ok", actor: "flow", task }, now)).toBe(true);
  return { flow, card };
}

describe("drawing send and choose", () => {
  test("steps make them, a reply goes back to the build by default, and choices that can't work are refused in words", () => {
    const flow = flowFromSteps([...STEPS.slice(0, 1), { id: "tell", title: "Send me the result", kind: "send" }, ...STEPS.slice(1)], null);
    const choose = flow.stages.find(one => one.id === "choose")!;
    expect(choose).toMatchObject({ kind: "choose", next: null, onFail: "build", options: [{ label: "Ship it", to: "ship" }, { label: "Ignore", to: "end" }], limit: { minutes: 2 * 24 * 60, to: "parked" } });
    expect(flow.stages.find(one => one.id === "tell")).toMatchObject({ kind: "send", next: "choose" });
    const terms = flowTerms(flow, null);
    expect(terms[1]).toBe("2. Send me the result — Send to me\nSends the card's owner (or the flow's) what the step before produced: its summary, links and any screenshots, in each chat app they use.\nThen → What next?");
    expect(terms[2]).toContain("Ship it → Ship.\nIgnore → ignores the card.\nOr a reply with what they'd change → Build.");
    // An edit keeps the options it leaves out.
    expect(flowFromSteps([{ id: "build" }, { id: "choose", title: "Decide" }, { id: "ship" }, { id: "parked" }], flow).stages.find(one => one.id === "choose")!.options).toEqual(choose.options);

    const bad = (options: unknown, extra: Record<string, unknown> = {}) => () => validateFlowDefinition({ version: 1, start: "c", stages: [
      { id: "c", title: "Choose", kind: "choose", options, ...extra }, { id: "x", title: "X", kind: "inbox" }] });
    expect(bad([{ label: "Only", to: "x" }])).toThrow("Zone Choose: give it 2 to 4 options.");
    expect(bad([1, 2, 3, 4, 5].map(n => ({ label: `O${n}`, to: "x" })))).toThrow("Zone Choose: give it 2 to 4 options.");
    expect(bad([{ label: "Go", to: "x" }, { label: "go", to: "end" }])).toThrow("Zone Choose: two options are called go.");
    expect(bad([{ label: "Go", to: "nowhere" }, { label: "Stop", to: "end" }])).toThrow("Zone Choose points at a zone that no longer exists.");
    expect(bad([{ label: "Again", to: "c" }, { label: "Stop", to: "end" }])).toThrow("Zone Choose: an option can't send cards back into the same zone.");
    expect(bad([{ label: "Go", to: "x" }, { label: "", to: "end" }])).toThrow("Zone Choose: each option needs a few words and where it leads.");
    expect(() => flowFromSteps([{ title: "Pick", kind: "choose" }], null)).toThrow('Step Pick: give it 2 to 4 options, each with a label and the step it goes to (or "end").');
    expect(() => flowFromSteps([{ title: "Pick", kind: "choose", options: [{ label: "A", goesTo: "end" }, { label: "B", goesTo: "end" }], ifNoReply: "end" }], null)).toThrow("Step Pick: say how long to wait for a choice first");
  });
});

describe("c1: Send to me", () => {
  test("what the build produced goes to the card's person once — summary, links, screenshots — on the card too, and the card moves on", () => {
    built("fix-1", "Checkout rounding");
    const { flow, card } = cardAt([STEPS[0], { id: "tell", title: "Send me the result", kind: "send" }], "tell", "fix-1");
    // The card's owner is its person; the flow's owner only when the card has none.
    expect(addApprover(store, "sam", now, { name: "alex", token: alexToken }).ok).toBe(true);
    store.setFlowCardOwner(card, "sam", "alex", now);
    advanceFlows(store, ALPHA, now, { evidenceRoot: root });
    const sent = store.flowSend(card, 2)!;
    expect(sent.person).toBe("sam");
    expect(readFlowSend(sent.contentJson)).toEqual({
      title: "Checkout rounding · Build", from: "Build", summary: "Totals now round half-up, with a regression test.",
      links: [{ label: "Result", path: "/t/fix-1" }, { label: "Card", path: `/flows/${flow}?card=${card}` }], shots: { taskId: "fix-1", run: 1 },
    });
    const rows = store.listNotifications("all").filter(one => one.dedupeKey.startsWith("flow-"));
    expect(rows.map(one => [one.dedupeKey, one.kind, one.recipient, one.link])).toEqual([
      [`flow-send:${card}:2`, "flow-card", "sam", "/t/fix-1"],
      [`flow-shots:${card}:2`, FLOW_SHOTS_KIND, "sam", "/t/fix-1"],
    ]);
    expect(rows[0]!).toMatchObject({ subject: "Fixes: Checkout rounding · Build", body: "Totals now round half-up, with a regression test.", pushClass: null });
    expect(rows[1]!.run).toBe(1);
    // The console shows what was sent on the card, and the card went on by itself.
    expect(store.getFlowCard(card)!.outputs["tell"]).toBe("Checkout rounding · Build\n\nTotals now round half-up, with a regression test.");
    expect(store.getFlowCard(card)!.stage).toBe("done");
    advanceFlows(store, ALPHA, now, { evidenceRoot: root });
    expect(store.getFlowCard(card)!.state).toBe("done");
    expect(store.listNotifications("all").filter(one => one.dedupeKey.startsWith("flow-send:"))).toHaveLength(1);
  });

  test("after research, the report is the summary; the result, its pull request and the report are links", () => {
    const { ref, run } = built("fix-7", "Checkout rounding", 0);
    const publication = store.createPublicationIntent({ run, taskRef: ref, githubRepo: "o/shop", remote: "origin", base: "main", head: "so/fix-7", headSha: "c".repeat(40), bodyHash: "h", draft: false }, now);
    store.markPublicationPushed(publication, now);
    store.markPublicationOpened(publication, 12, "https://github.com/o/shop/pull/12", now);
    store.createTask({ id: "look-7", title: "Check it: Checkout rounding" }, now);
    store.placeTask(store.refFor("built-in", "look-7").id, ALPHA, {}, now);
    const flow = store.createFlow({ repo: ALPHA, name: "Fixes", by: "alex", definitionJson: JSON.stringify(flowFromSteps([STEPS[0], { id: "check", title: "Check it", kind: "report" },
      { id: "tell", title: "Send me the result", kind: "send" }], null)) }, now);
    const card = store.addFlowCard({ flow, title: "Checkout rounding", description: null, stage: "check", by: "alex" }, now);
    store.updateFlowCard(card, { primaryTask: "fix-7", outputs: { build: "Result ready on task fix-7.", check: "The fix holds; rounding matches the bank's statements." } }, now);
    store.moveFlowCard(card, { to: "tell", outcome: "ok", actor: "flow", task: "look-7" }, now);
    advanceFlows(store, ALPHA, now, { evidenceRoot: root });
    expect(readFlowSend(store.flowSend(card, 2)!.contentJson)).toEqual({
      title: "Checkout rounding · Check it", from: "Check it", summary: "The fix holds; rounding matches the bank's statements.", shots: null,
      links: [{ label: "Result", path: "/t/fix-7" }, { label: "Pull request", url: "https://github.com/o/shop/pull/12" }, { label: "Report", path: "/t/look-7" }, { label: "Card", path: `/flows/${flow}?card=${card}` }],
    });
    expect(store.listNotifications("all").find(one => one.dedupeKey === `flow-send:${card}:2`)!.body).toBe("The fix holds; rounding matches the bank's statements.\n\nPull request: https://github.com/o/shop/pull/12");
  });

  test("Telegram: the send arrives with its link buttons, then its screenshots as one album", async () => {
    pair();
    built("fix-2", "Checkout rounding");
    cardAt([STEPS[0], { id: "tell", title: "Send me the result", kind: "send" }], "tell", "fix-2");
    advanceFlows(store, ALPHA, now, { evidenceRoot: root });
    const script = scripted();
    await pass(script);
    const notice = script.sent("Checkout rounding · Build");
    expect(String(notice.params["text"])).toContain("Totals now round half-up, with a regression test.");
    expect(script.buttons(notice).map(one => [one.text, one.url])).toEqual([["Result", `${ORIGIN}/t/fix-2`], ["Card", `${ORIGIN}/flows/1?card=1`]]);
    const album = script.calls.find(one => one.method === "sendMediaGroup")!;
    expect((album.params["media"] as unknown[]).length).toBe(3);
    expect(script.calls.indexOf(album)).toBeGreaterThan(script.calls.indexOf(notice));
    await pass(script);
    expect(script.calls.filter(one => one.method === "sendMediaGroup")).toHaveLength(1);
  });
});

describe("c2: Person chooses", () => {
  test("Telegram: the options are buttons under what was done; a tap moves the card once, is ledgered, and a used or stale button acts on nothing", async () => {
    pair();
    built("fix-3", "Checkout rounding", 0);
    const { card } = cardAt(STEPS, "choose", "fix-3");
    advanceFlows(store, ALPHA, now, { evidenceRoot: root });
    expect(store.getFlowCard(card)!.waiting).toBe("Waiting for alex to choose");
    const row = store.listNotifications("all").find(one => one.dedupeKey === `flow-choose:${card}:2`)!;
    expect(row).toMatchObject({ kind: "flow-decision", recipient: "alex", pushClass: "attention" });
    expect(row.body).toBe("Totals now round half-up, with a regression test.\n\nChoose one. Or reply with what you'd change.");
    const script = scripted();
    await pass(script);
    const notice = script.sent("Choose one.");
    expect(String(notice.params["text"])).toContain("Totals now round half-up, with a regression test.\n\nChoose one. Or reply with what you'd change.");
    expect(script.buttons(notice).map(one => one.text)).toEqual(["Ship it", "Ignore", "Result", "Card"]);
    const ship = script.buttons(notice).find(one => one.text === "Ship it")!.callback_data!;
    await tap(script, ship, notice.messageId!);
    expect(store.getFlowCard(card)).toMatchObject({ stage: "ship", state: "active" });
    expect(script.calls.at(-1)).toMatchObject({ method: "editMessageText" });
    expect(String(script.calls.at(-1)!.params["text"])).toContain("✅ You chose “Ship it”. Ship it. Moved to Ship.");
    expect(store.flowEvents(card).at(-1)).toMatchObject({ toStage: "ship", actor: "alex", note: "Chose “Ship it” in Telegram" });
    expect(store.actionLedger({ repos: [ALPHA] }).filter(one => one.action === "flow choice"))
      .toEqual([expect.objectContaining({ actor: "alex", repo: ALPHA, outcome: "chosen", detail: "Fixes · card 1 · What next?: “Ship it” · via Telegram" })]);
    // The same button again, or Ignore on the spent message: nothing changes.
    await tap(script, ship, notice.messageId!);
    await tap(script, script.buttons(notice).find(one => one.text === "Ignore")!.callback_data!, notice.messageId!);
    expect(script.acks().slice(-2)).toEqual(["That was already chosen, or these buttons are too old.", "That was already chosen, or these buttons are too old."]);
    expect(store.getFlowCard(card)).toMatchObject({ stage: "ship", state: "active" });
  });

  test("Telegram: a reply to the choice is the note where replies go, and Ignore on another card closes it as Ignored", async () => {
    pair();
    built("fix-4", "Checkout rounding", 0);
    const { flow, card } = cardAt(STEPS, "choose", "fix-4");
    advanceFlows(store, ALPHA, now, { evidenceRoot: root });
    const script = scripted();
    await pass(script);
    const notice = script.sent("Choose one.");
    script.updates.push([{ update_id: next++, message: { message_id: 900, chat: { id: CHAT, type: "private" }, from: { id: CHAT }, text: "Round half-even instead, please.", reply_to_message: { message_id: notice.messageId } } }]);
    await pass(script);
    expect(store.getFlowCard(card)).toMatchObject({ stage: "build", note: "Round half-even instead, please." });
    expect(script.calls.filter(one => one.method === "sendMessage").at(-1)!.params["text"]).toBe("↩️ Sent to Build with your note.");
    // The card is back in Build: its buttons now act on nothing.
    await tap(script, script.buttons(notice)[0]!.callback_data!, notice.messageId!);
    expect(store.getFlowCard(card)!.stage).toBe("build");

    const other = store.addFlowCard({ flow, title: "Header spacing", description: null, stage: "build", by: "alex" }, now);
    store.moveFlowCard(other, { to: "choose", outcome: "ok", actor: "flow" }, now);
    advanceFlows(store, ALPHA, now, { evidenceRoot: root });
    await pass(script);
    const second = [...script.calls].reverse().find(one => one.method === "sendMessage" && script.buttons(one).some(button => button.text === "Ignore"))!;
    await tap(script, script.buttons(second).find(one => one.text === "Ignore")!.callback_data!, second.messageId!);
    expect(store.getFlowCard(other)).toMatchObject({ state: "cancelled", waiting: "Ignored" });
    expect(store.flowEvents(other).at(-1)).toMatchObject({ outcome: "cancelled", actor: "alex", note: "Ignored: chose “Ignore” in Telegram" });
  });

  test("one door for every place: only the card's person chooses, only for the visit they saw, and a reply needs words", () => {
    built("fix-5", "Checkout rounding", 0);
    const { card } = cardAt(STEPS, "choose", "fix-5");
    advanceFlows(store, ALPHA, now, { evidenceRoot: root });
    expect(addApprover(store, "sam", now, { name: "alex", token: alexToken }).ok).toBe(true);
    const at = (input: Partial<Parameters<typeof chooseFlowCard>[1]>) => chooseFlowCard(store, { card, choice: null, note: null, actor: "alex", where: "Toolroll", repos: [ALPHA], ...input }, now);
    expect(at({ actor: "sam", choice: 0 })).toEqual({ ok: false, message: "Only alex chooses here." });
    expect(at({ entry: 1, choice: 0 })).toEqual({ ok: false, message: "That card has moved on since; nothing was changed." });
    expect(at({ choice: 0, label: "Ship" })).toEqual({ ok: false, message: "Those options changed since; nothing was changed." });
    expect(at({ choice: 7 })).toEqual({ ok: false, message: "Those options changed since; nothing was changed." });
    expect(at({ note: "  " })).toEqual({ ok: false, message: "Say what you'd change." });
    expect(at({ repos: [BETA], choice: 0 })).toEqual({ ok: false, message: "That card is no longer waiting." });
    expect(flowChoiceAt(store, card, 2)?.person).toBe("alex");
    expect(at({ choice: 1, label: "Ignore" })).toEqual({ ok: true, said: "Ignored. The card is closed." });
    expect(store.getFlowCard(card)).toMatchObject({ state: "cancelled", waiting: "Ignored" });
    expect(at({ choice: 0 })).toEqual({ ok: false, message: "That card is no longer waiting." });
    expect(store.actionLedger({ repos: [ALPHA] }).filter(one => one.action === "flow choice").map(one => [one.actor, one.outcome, one.detail]))
      .toEqual([["alex", "ignored", "Fixes · card 1 · What next?: “Ignore” · via Toolroll"]]);
  });

  test("the console: the card shows what was sent and the options to its person only, and choosing there goes through the same door", async () => {
    built("fix-8", "Checkout rounding", 0);
    const { flow, card } = cardAt(STEPS, "choose", "fix-8");
    advanceFlows(store, ALPHA, now, { evidenceRoot: root });
    expect(addApprover(store, "sam", now, { name: "alex", token: alexToken }).ok).toBe(true);
    const view = (name: string) => flowView(store, store.getFlow(flow)!, { name, approver: true }, null).cards.find(one => one.id === card)!;
    // The panel already names the card and opens its task: only where it came from, and no link twice.
    expect(view("alex").choose).toEqual({ entry: 2, title: "From Build", summary: "Totals now round half-up, with a regression test.", person: "alex", mine: true, reply: true,
      links: [], options: [{ choice: 0, label: "Ship it" }, { choice: 1, label: "Ignore" }] });
    expect(view("alex")).toMatchObject({ mine: true, sent: null });
    expect(view("sam").choose).toMatchObject({ mine: false, person: "alex" });

    store.upsertProject(ALPHA, "alpha", now);
    const server = createDecisionServer({ store, evidenceRoot: root, repo: ALPHA, configDir: dir });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address !== "object") throw new Error("listen");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const cookie = (await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token: alexToken }), redirect: "manual" }))
        .headers.getSetCookie().map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session="))!;
      const page = await (await fetch(`${base}/flows/${flow}`, { headers: { cookie } })).text();
      const csrf = /"csrf":"([^"]+)"/.exec(page)?.[1] ?? /name="csrf" value="([^"]+)"/.exec(page)![1]!;
      const choose = (form: Record<string, string>) => fetch(`${base}/flows/${flow}/cards/${card}/choose`, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ csrf, ...form }) }).then(async one => ({ status: one.status, body: await one.json() as { ok: boolean; said: string } }));
      expect(await choose({ choice: "0", label: "Ship it", entry: "1" })).toEqual({ status: 409, body: { ok: false, said: "That card has moved on since; nothing was changed." } });
      expect(await choose({ note: "Round half-even instead.", entry: "2" })).toMatchObject({ status: 200, body: { ok: true, said: "Sent to Build with your note." } });
      expect(store.getFlowCard(card)).toMatchObject({ stage: "build", note: "Round half-even instead." });
      expect(store.flowEvents(card).at(-1)).toMatchObject({ actor: "alex", outcome: "sent-back" });
      expect(store.actionLedger({ repos: [ALPHA] }).find(one => one.action === "flow choice")).toMatchObject({ actor: "alex", outcome: "replied", detail: "Fixes · card 1 · What next?: a reply to Build · via Toolroll" });
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  test("no choice in time: the person is reminded once and the card moves where no reply leads", () => {
    built("fix-6", "Checkout rounding", 0);
    const { card } = cardAt(STEPS, "choose", "fix-6");
    advanceFlows(store, ALPHA, now, { evidenceRoot: root });
    now = new Date(T0.getTime() + 2 * 24 * 60 * 60_000 + 1);
    advanceFlows(store, ALPHA, now, { evidenceRoot: root });
    expect(store.getFlowCard(card)!.stage).toBe("parked");
    expect(store.listNotifications("all").filter(one => one.dedupeKey.startsWith(`flow-card:${card}:limit:`)).map(one => [one.recipient, one.subject]))
      .toEqual([["alex", "Fixes: “Checkout rounding” has waited 2 days in What next?"]]);
  });
});

describe("c3: another project, and Send me the result", () => {
  test("a build step in another project files its task there, only when the flow's owner may file there", () => {
    expect(addApprover(store, "sam", now, { name: "alex", token: alexToken }).ok).toBe(true);
    expect(store.setAccountProjects("sam", [ALPHA], "alex", now)).toEqual({ ok: true });
    const steps = [{ id: "build", title: "Build the docs", kind: "task" as const, repo: BETA }];
    const definition = flowFromSteps(steps, null);
    expect(definition.stages[0]).toMatchObject({ kind: "task", repo: BETA });
    expect(flowTerms(definition, null)[0]).toContain("Builds in another project: /projects/beta");
    expect(crossProjectProblem(store, definition, { repo: ALPHA, owner: "sam" })).toBe("Zone Build the docs: sam, who owns this flow, can't file work in that project.");
    expect(crossProjectProblem(store, definition, { repo: ALPHA, owner: "alex" })).toBeNull();

    const theirs = store.createFlow({ repo: ALPHA, name: "Docs", by: "sam", definitionJson: JSON.stringify(definition) }, now);
    const stuck = store.addFlowCard({ flow: theirs, title: "Document the API", description: null, stage: "build", by: "sam" }, now);
    expect(advanceFlows(store, ALPHA, now).filed).toEqual([]);
    expect(store.getFlowCard(stuck)!.waiting).toBe("Couldn't file the work: sam, who owns this flow, can't file work in /projects/beta. Choose another project for Build the docs, or give them access. It tries again on the next pass.");

    const ours = store.createFlow({ repo: ALPHA, name: "Docs", by: "alex", definitionJson: JSON.stringify(definition) }, now);
    const card = store.addFlowCard({ flow: ours, title: "Document the API", description: null, stage: "build", by: "alex" }, now);
    const filed = advanceFlows(store, ALPHA, now).filed;
    expect(filed).toHaveLength(1);
    expect(store.lookupRef(filed[0]!)?.repo).toBe(BETA);
    expect(store.getFlowCard(card)).toMatchObject({ task: filed[0], waiting: "Filed as a task" });
  });

  test("saving a build in another project needs the editor's access there too, not only the owner's", async () => {
    const sam = addApprover(store, "sam", now, { name: "alex", token: alexToken });
    if (!sam.ok) throw new Error("approver");
    expect(store.setAccountProjects("sam", [ALPHA], "alex", now)).toEqual({ ok: true });
    const elsewhere = flowFromSteps([{ id: "build", title: "Build the docs", kind: "task" as const, repo: BETA }], null);
    expect(crossProjectProblem(store, elsewhere, { repo: ALPHA, owner: "alex" }, "sam")).toBe("Zone Build the docs: you can't file work in that project, so you can't point a build there.");
    expect(crossProjectProblem(store, elsewhere, { repo: ALPHA, owner: "alex" }, "alex")).toBeNull();

    const here = flowFromSteps([{ id: "build", title: "Build the docs", kind: "task" as const }], null);
    const flow = store.createFlow({ repo: ALPHA, name: "Docs", by: "alex", definitionJson: JSON.stringify(here) }, now);
    store.upsertProject(ALPHA, "alpha", now);
    const server = createDecisionServer({ store, evidenceRoot: root, repo: ALPHA, configDir: dir });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address !== "object") throw new Error("listen");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const save = async (name: string, token: string, definition: unknown) => {
        const cookie = (await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name, token }), redirect: "manual" }))
          .headers.getSetCookie().map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session="))!;
        const page = await (await fetch(`${base}/flows/${flow}`, { headers: { cookie } })).text();
        const csrf = /"csrf":"([^"]+)"/.exec(page)?.[1] ?? /name="csrf" value="([^"]+)"/.exec(page)![1]!;
        const response = await fetch(`${base}/flows/${flow}/save`, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
          body: new URLSearchParams({ csrf, definition: JSON.stringify(definition), revision: String(store.getFlow(flow)!.revision) }) });
        return { status: response.status, body: await response.json() as { ok: boolean; said: string } };
      };
      // sam may edit this flow, but can't point its build at a project they can't file in, even though its owner can.
      expect(await save("sam", sam.token, elsewhere)).toEqual({ status: 400, body: { ok: false, said: "Zone Build the docs: you can't file work in that project, so you can't point a build there." } });
      expect(flowDefinitionOf(store.getFlow(flow)!)!.stages[0]).not.toHaveProperty("repo");
      expect(await save("alex", alexToken, elsewhere)).toMatchObject({ status: 200, body: { ok: true } });
      expect(flowDefinitionOf(store.getFlow(flow)!)!.stages[0]).toMatchObject({ repo: BETA });
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  test("every gallery template can end with Send me the result, off unless asked for", () => {
    for (const template of [...GALLERY, BLANK]) {
      const drawn = galleryDiagram(template);
      expect(drawn.stages.some(one => one.kind === "send")).toBe(false);
      const sending: FlowDefinition = validateFlowDefinition(withSendResult(drawn));
      const send = sending.stages.find(one => one.kind === "send")!;
      expect(send).toMatchObject({ title: "Send me the result", next: expect.any(String) });
      expect(sending.stages.find(one => one.id === send.next)!.kind).toBe("done");
      // Nothing reaches that end without passing it, and it is laid out where the end was.
      expect(sending.stages.some(one => one.id !== send.id && (one.next === send.next || one.onFail === send.next || (one.sort?.answers ?? []).some(answer => answer.to === send.next)))).toBe(false);
      expect(sending.stages.some(one => one.next === send.id || one.onFail === send.id || (one.sort?.answers ?? []).some(answer => answer.to === send.id) || (one.routes ?? []).some(route => route.to === send.id))).toBe(true);
    }
    const research = galleryTemplateOf("research")!;
    expect(buildFromGallery(store, research, ALPHA, {}).definition.stages.some(one => one.kind === "send")).toBe(false);
    const asked = buildFromGallery(store, research, ALPHA, { [SEND_RESULT.key]: "yes" });
    expect(asked.answers).toEqual({ [SEND_RESULT.key]: "yes" });
    expect(asked.definition.stages.map(one => one.id)).toEqual(["inbox", "research", "check", "share", "send-result", "done"]);
    expect(asked.definition.stages.find(one => one.id === "share")!.next).toBe("send-result");
    expect(asked.does.at(-1)).toBe(SEND_RESULT.does);
  });
});

// ---- a scripted Telegram ------------------------------------------------------------------------

type Button = { text: string; callback_data?: string; url?: string };
type Call = { method: string; params: Record<string, unknown>; messageId: number | null };
let next = 10;
function pair(): void {
  const code = mintPairingCode();
  store.createTelegramPairing({ codeHash: hashPairingCode(code), approver: "alex", by: "alex", ttlMs: PAIRING_TTL_MS }, now);
  expect(store.consumeTelegramPairing({ codeHash: hashPairingCode(code), botId: BOT, chatId: String(CHAT), userId: String(CHAT), updateId: 1 }, now).ok).toBe(true);
}
function scripted() {
  const calls: Call[] = [];
  const updates: unknown[][] = [];
  let id = 500;
  const transport: TelegramTransport = async (method, params) => {
    if (method === "getUpdates") {
      const offset = Number(params["offset"] ?? 0);
      return { ok: true, result: (updates.shift() ?? []).filter(one => Number((one as { update_id: number }).update_id) >= offset) };
    }
    const messageId = method === "sendMessage" || method === "sendPhoto" || method === "sendDocument" ? id++ : method === "editMessageText" ? Number(params["message_id"]) : null;
    calls.push({ method, params, messageId });
    if (method === "sendMediaGroup") return { ok: true, result: (params["media"] as unknown[]).map(() => ({ message_id: id++ })) };
    if (messageId !== null) return { ok: true, result: { message_id: messageId } };
    return { ok: true, result: true };
  };
  const buttons = (call: Call): Button[] => ((call.params["reply_markup"] as { inline_keyboard?: Button[][] } | undefined)?.inline_keyboard ?? []).flat();
  const acks = () => calls.filter(one => one.method === "answerCallbackQuery").map(one => String(one.params["text"] ?? ""));
  /** The first message sent with these words. */
  const sent = (words: string): Call => calls.find(one => one.method === "sendMessage" && String(one.params["text"]).includes(words))!;
  return { transport, calls, updates, buttons, acks, sent };
}
const pass = (script: ReturnType<typeof scripted>) => bridgePass(store, { botId: BOT, transport: script.transport, clock: () => now, readProjects: async () => [ALPHA],
  conversation: { evidenceRoot: root, phoneOrigin: () => ORIGIN } });
async function tap(script: ReturnType<typeof scripted>, data: string, messageId: number): Promise<void> {
  const text = String([...script.calls].reverse().find(one => one.messageId === messageId)?.params["text"] ?? "");
  script.updates.push([{ update_id: next++, callback_query: { id: `cb-${next}`, data, from: { id: CHAT }, message: { message_id: messageId, chat: { id: CHAT, type: "private" }, text } } }]);
  await pass(script);
}

describe("an install without Slack, Discord or Teams", () => {
  test("retiring a card's choices skips chat-app tables that were never created", () => {
    const names = ["slack", "discord", "teams"].flatMap(app => ["flow_choice", "flow_note", "flow_prompt", "flow_action"].map(table => `${app}_${table}`));
    for (const name of names) store.handle.prepare(`DROP TABLE IF EXISTS ${name}`).run();
    expect(() => store.retireFlowChoices(1, 1, new Date("2026-10-03T12:00:00Z"))).not.toThrow();
  });
});
