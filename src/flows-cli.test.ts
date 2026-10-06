/**
 * `toolroll flows`: flows set up and read from a terminal under the
 * console's rules. Reads need no login; every write is an approver's,
 * previews until --yes where it must, and is a line in the ledger.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { runOperate } from "./operate.js";
import { main } from "./cli.js";
import { flowFromSteps } from "./flows.js";

const NOW = new Date("2026-09-30T12:00:00.000Z");
let dir: string, file: string, repo: string, other: string, alex: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-flows-cli-")));
  file = join(dir, "orders.db");
  repo = join(dir, "shop");
  other = join(dir, "elsewhere");
  mkdirSync(repo);
  mkdirSync(other);
  const store = openStore(file);
  const made = addApprover(store, "alex", NOW);
  if (!made.ok) throw new Error("alex");
  alex = made.token;
  store.upsertProject(repo, "shop", NOW);
  store.close();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

type Answer = { code: number; out: string; body: Record<string, any> };
async function flows(argv: string[], options: Parameters<typeof runOperate>[3] = {}): Promise<Answer> {
  const lines: string[] = [];
  const code = await runOperate("flows", [...argv, "--json"], line => { lines.push(line); }, { databaseFile: file, now: NOW, ...options });
  const out = lines.join("\n");
  return { code, out, body: JSON.parse(out) as Record<string, any> };
}
const me = ["--as", "alex", "--token"];
const as = () => [...me, alex];
function stepsFile(steps: unknown): string {
  const path = join(dir, `steps-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(steps));
  return path;
}
function look<T>(read: (store: Store) => T): T {
  const store = openStore(file);
  try { return read(store); } finally { store.close(); }
}
const ledger = () => look(store => store.handle.prepare("SELECT actor, repo, action, outcome, source, detail FROM action_ledger WHERE action LIKE 'flows %' ORDER BY id").all());

test("create previews without --yes, then makes the flow from a template and records it in the ledger", async () => {
  const preview = await flows(["create", "--repo", repo, "--name", "Fixes", "--template", "coding", ...as()]);
  expect(preview.code).toBe(0);
  expect(preview.body).toMatchObject({ ok: true, command: "flows create", applied: false, title: "Create the Fixes flow in shop" });
  expect(preview.body.terms.join("\n")).toContain("usual approvals");
  expect(look(store => store.listFlows([repo]))).toEqual([]);
  expect(ledger()).toEqual([]);

  const made = await flows(["create", "--repo", repo, "--name", "Fixes", "--template", "coding", "--yes", ...as()]);
  expect(made.body).toMatchObject({ ok: true, applied: true, flow: { name: "Fixes", repo, owner: "alex" } });
  expect(look(store => store.listFlows([repo]).map(one => one.name))).toEqual(["Fixes"]);
  expect(ledger()).toEqual([{ actor: "alex", repo, action: "flows create", outcome: "accepted", source: "request", detail: `command line · flow #${made.body.flow.id}` }]);

  const listed = await flows(["list", "--repo", repo]);
  expect(listed.body.flows).toEqual([expect.objectContaining({ id: made.body.flow.id, name: "Fixes", project: "shop", triggers: 0, cardsWaiting: 0 })]);
  expect(listed.body.flows[0].zones.length).toBeGreaterThan(1);
});

test("writes need an approver's credentials; reads don't", async () => {
  const bare = await flows(["create", "--repo", repo, "--name", "Fixes", "--template", "coding", "--yes"]);
  expect(bare).toMatchObject({ code: 3, body: { ok: false, reason: "unauthenticated" } });
  const wrong = await flows(["create", "--repo", repo, "--name", "Fixes", "--template", "coding", "--yes", ...me, "not-it"]);
  expect(wrong).toMatchObject({ code: 3, body: { ok: false, reason: "unauthenticated" } });
  expect(look(store => store.listFlows([repo]))).toEqual([]);
  expect((await flows(["list"])).body).toMatchObject({ ok: true, flows: [] });
});

test("refuses an unknown project, invalid steps and a merge without a decision before it", async () => {
  const unknown = await flows(["create", "--repo", other, "--name", "X", "--template", "coding", "--yes", ...as()]);
  expect(unknown).toMatchObject({ code: 3, body: { reason: "unknown-project" } });
  const notSteps = await flows(["create", "--repo", repo, "--name", "X", "--steps", stepsFile({ nope: true }), "--yes", ...as()]);
  expect(notSteps.body).toMatchObject({ reason: "invalid-steps", message: "steps: must be an array (got an object)" });
  const merge = await flows(["create", "--repo", repo, "--name", "Ship", "--yes", ...as(), "--steps", stepsFile([
    { id: "build", title: "Build", kind: "task" },
    { id: "pr", title: "Open PR", kind: "pull-request", merge: "squash" },
  ])]);
  expect(merge.body).toMatchObject({ ok: false, reason: "invalid-steps" });
  expect(merge.body.message).toContain("must come before it on every path");
  const both = await flows(["create", "--repo", repo, "--name", "X", "--template", "coding", "--steps", stepsFile([]), ...as()]);
  expect(both).toMatchObject({ code: 2, body: { reason: "usage" } });
  expect(look(store => store.listFlows([repo]))).toEqual([]);
  expect(ledger().map((one: any) => [one.outcome, one.detail])).toEqual([
    ["refused", "command line · unknown-project"], ["refused", "command line · invalid-steps"], ["refused", "command line · invalid-steps"],
  ]);
});

test("create --steps takes the lead's step format; show --json gives zones, paths and triggers; edit keeps zones by id", async () => {
  const steps = stepsFile({ steps: [
    { id: "build", title: "Build", kind: "task" },
    { id: "review", title: "Review", kind: "approval", decider: "me" },
    { id: "pr", title: "Open PR", kind: "pull-request", merge: "squash" },
  ] });
  const made = await flows(["create", "--repo", repo, "--name", "Ship", "--steps", steps, "--yes", ...as()]);
  expect(made.code).toBe(0);
  const id = String(made.body.flow.id);
  const shown = await flows(["show", id]);
  expect(shown.body.flow.start).toBe("build");
  expect(shown.body.flow.zones).toEqual([
    expect.objectContaining({ id: "build", kind: "task", next: "review", ifFails: null }),
    expect.objectContaining({ id: "review", kind: "approval", next: "pr", ifFails: "build", decider: "alex" }),
    expect.objectContaining({ id: "pr", kind: "pull-request", merge: "squash", next: "done", ifFails: "build" }),
    expect.objectContaining({ id: "done", kind: "done", next: null, ifFails: null }),
  ]);
  expect(shown.body.flow.triggers).toEqual([]);

  const edit = stepsFile([{ id: "build", title: "Build it", kind: "task" }, { id: "review", title: "Review", kind: "approval" }]);
  const preview = await flows(["edit", id, "--steps", edit, "--name", "Shipping", ...as()]);
  expect(preview.body).toMatchObject({ applied: false, revision: 1 });
  expect(preview.body.terms[0]).toBe("Renames it to Shipping.");
  expect(preview.body.terms.join("\n")).toContain("Removes Open PR");
  expect(look(store => store.getFlow(Number(id))!.name)).toBe("Ship");
  const saved = await flows(["edit", id, "--steps", edit, "--name", "Shipping", "--yes", ...as()]);
  expect(saved.body.flow).toMatchObject({ name: "Shipping", revision: 2 });
  expect(saved.body.flow.zones.map((one: { title: string }) => one.title)).toEqual(["Build it", "Review", "Done"]);
  expect((await flows(["edit", id, "--steps", edit, "--yes", ...as()])).body).toMatchObject({ ok: false, reason: "no-change" });
  expect((await flows(["edit", id, "--steps", stepsFile([{ kind: "check", title: "Test" }]), "--yes", ...as()])).body).toMatchObject({ reason: "invalid-steps" });
});

test("trigger add previews and adds every kind, schedule scripts included; pause, resume, check and remove", async () => {
  const made = await flows(["create", "--repo", repo, "--name", "Nightly", "--template", "research", "--yes", ...as()]);
  const id = String(made.body.flow.id);
  const schedule = '{"kind":"schedule","schedule":"daily 09:00","title":"Standup"}';
  const preview = await flows(["trigger", "add", id, schedule, ...as()]);
  expect(preview.body).toMatchObject({ applied: false, trigger: { kind: "schedule", title: "Standup" } });
  expect(look(store => store.flowTriggers(Number(id)))).toEqual([]);
  const added = await flows(["trigger", "add", id, schedule, "--yes", ...as()]);
  expect(added.body).toMatchObject({ applied: true, said: "Trigger added." });
  const trigger = String(added.body.triggerId);

  // A schedule's script: saved to the project first, then named.
  const body = join(dir, "orders.sh");
  writeFileSync(body, "echo 'Order 12 is late'\n");
  const script = await flows(["script", "save", "--repo", repo, "--name", "late-orders", "--body", body, "--about", "Lists late orders", ...as()]);
  expect(script.body).toMatchObject({ ok: true, script: { name: "late-orders", version: 1, language: "shell" } });
  const fromFile = await flows(["script", "save", "--repo", repo, "--name", "enrich", "--file", "scripts/enrich.py", "--language", "python", "--about", "Adds details", "--timeout-minutes", "5", ...as()]);
  expect(fromFile.body).toMatchObject({ ok: true, script: { name: "enrich", file: "scripts/enrich.py", language: "python", timeoutMinutes: 5 } });
  expect((await flows(["script", "save", "--repo", repo, "--name", "Bad Name", "--body", body, "--about", "x", ...as()])).body).toMatchObject({ reason: "invalid-script" });
  expect((await flows(["script", "save", "--repo", other, "--name", "x", "--body", body, "--about", "x", ...as()])).body).toMatchObject({ reason: "unknown-project" });
  const scripted = await flows(["trigger", "add", id, '{"kind":"schedule","schedule":"daily 07:00","script":"late-orders"}', "--yes", ...as()]);
  expect(scripted.body.applied).toBe(true);

  // A webhook: its secret address is shown once.
  const hook = await flows(["trigger", "add", id, '{"kind":"webhook","title":"Posted"}', "--yes", ...as()]);
  expect(hook.body.reveal.path).toMatch(/^\/hooks\/flow\/[A-Za-z0-9_-]+$/);
  // Settings from a file, and a GitHub trigger checked now through gh.
  const settings = join(dir, "trigger.json");
  writeFileSync(settings, JSON.stringify({ kind: "github", repo: "acme/shop", watch: "pulls" }));
  const github = await flows(["trigger", "add", id, settings, "--yes", ...as()]);
  expect(github.body.applied).toBe(true);
  const asked: string[][] = [];
  const checked = await flows(["trigger", "check", id, String(github.body.triggerId), ...as()], { flowTriggerIo: { gh: async (_file, args) => { asked.push([...args]); return { code: 0, stdout: "[]", stderr: "" }; } } });
  expect(checked.body).toMatchObject({ ok: true, applied: true });
  expect(asked[0]).toContain("repos/acme/shop/pulls?state=open&sort=created&direction=desc&per_page=30");
  expect((await flows(["trigger", "check", id, trigger, ...as()])).body).toMatchObject({ ok: false, reason: "check-failed" });

  expect((await flows(["trigger", "add", id, '{"kind":"schedule","schedule":"daily 09:00","title":"x","zone":"nowhere"}', "--yes", ...as()])).body).toMatchObject({ reason: "invalid-trigger", message: "zone: this flow has no zone called nowhere" });
  expect((await flows(["trigger", "pause", id, trigger, ...as()])).body.said).toBe("Trigger paused.");
  expect((await flows(["show", id])).body.flow.triggers.find((one: { id: number }) => String(one.id) === trigger)).toMatchObject({ state: "paused", kind: "schedule" });
  expect((await flows(["trigger", "resume", id, trigger, ...as()])).body.said).toBe("Trigger on again.");
  expect((await flows(["trigger", "remove", id, trigger, ...as()])).body.said).toBe("Trigger removed.");
  expect((await flows(["trigger", "pause", id, trigger, ...as()])).body).toMatchObject({ reason: "unknown-trigger" });
  const shown = await flows(["show", id]);
  expect(shown.body.flow.triggers.map((one: { kind: string }) => one.kind)).toEqual(["schedule", "webhook", "github"]);
  expect(ledger().filter((one: any) => one.action === "flows trigger add" && one.outcome === "accepted")).toHaveLength(4);
});

test("card add starts in the first zone or a named one; archive previews, then archives", async () => {
  const made = await flows(["create", "--repo", repo, "--name", "Replies", "--template", "email-replies", "--yes", ...as()]);
  const id = String(made.body.flow.id);
  const zones = made.body.flow.zones as { id: string; title: string }[];
  const card = await flows(["card", "add", id, "--title", "Do you ship to Canada?", "--description", "From sam@example.com", ...as()]);
  expect(card.body).toMatchObject({ ok: true, card: { title: "Do you ship to Canada?" } });
  const named = await flows(["card", "add", id, "--title", "Refund", "--zone", zones[1]!.title, ...as()]);
  expect(named.body.card.zone).toBe(zones[1]!.id);
  expect((await flows(["card", "add", id, "--title", "Lost", "--zone", "nowhere", ...as()])).body).toMatchObject({ reason: "unknown-zone" });
  expect((await flows(["card", "add", "999", "--title", "Lost", ...as()])).body).toMatchObject({ reason: "unknown-flow" });
  expect((await flows(["show", id])).body.flow.cards.map((one: { title: string }) => one.title).sort()).toEqual(["Do you ship to Canada?", "Refund"]);

  const preview = await flows(["archive", id, ...as()]);
  expect(preview.body).toMatchObject({ applied: false, title: "Archive the Replies flow" });
  expect((await flows(["list"])).body.flows).toHaveLength(1);
  expect((await flows(["archive", id, "--yes", ...as()])).body).toMatchObject({ applied: true });
  expect((await flows(["list"])).body.flows).toEqual([]);
  expect((await flows(["show", id])).body).toMatchObject({ ok: false, reason: "unknown-flow" });
});

test("a starter flow switches on with its trigger through the same door as onboarding", async () => {
  const preview = await flows(["create", "--repo", repo, "--template", "overnight", ...as()]);
  expect(preview.body).toMatchObject({ applied: false, starter: "overnight" });
  const on = await flows(["create", "--repo", repo, "--template", "overnight", "--yes", ...as()]);
  expect(on.body.flow.triggers).toHaveLength(1);
  expect((await flows(["create", "--repo", repo, "--template", "overnight", "--yes", ...as()])).body).toMatchObject({ reason: "already-on" });
  // Not on GitHub, so a GitHub starter can't watch it.
  expect((await flows(["create", "--repo", repo, "--template", "issue-task", "--yes", ...as()])).body).toMatchObject({ reason: "blocked" });
});

test("the command contract and the operating guide include flows", async () => {
  const lines: string[] = [];
  expect(await main(["contract", "--commands", "--json"], line => lines.push(line))).toBe(0);
  const rows = (JSON.parse(lines.join("\n")).commands as { invocation: string }[]).map(one => one.invocation);
  for (const verb of ["list", "show", "create", "edit", "trigger add", "trigger pause", "trigger resume", "trigger remove", "trigger check", "script save", "card add", "archive"]) expect(rows).toContain(`flows ${verb}`);
  const guide: string[] = [];
  expect(await main(["skills", "get", "operating"], line => guide.push(line))).toBe(0);
  expect(guide.join("\n")).toContain("flows create --repo PATH");
});

function approvalCard(): { flow: number; card: number } {
  return look(store => {
    const flow = store.createFlow({ repo, name: "Publish", by: "alex", definitionJson: JSON.stringify(flowFromSteps([
      { title: "Inbox", kind: "inbox" },
      { id: "draft", title: "Write it", kind: "draft", instructions: "Write {{card.title}}" },
      { id: "ok", title: "Publish to toolroll.dev?", kind: "approval", decider: "owner", ifFails: "Write it" },
      { id: "done", title: "Published", kind: "done" },
    ], null)) }, NOW);
    return { flow, card: store.addFlowCard({ flow, title: "Release notes", description: null, stage: "ok", by: "alex" }, NOW) };
  });
}
const events = (card: number) => look(store => store.handle.prepare("SELECT from_stage, to_stage, outcome, actor, note FROM flow_event WHERE card=? AND outcome<>'created' ORDER BY id").all(card));

test("card approve moves a waiting approval card on as the console's Approve does, and is a line in the ledger", async () => {
  const { flow, card } = approvalCard();
  const bare = await flows(["card", "approve", String(flow), String(card)]);
  expect(bare).toMatchObject({ code: 3, body: { reason: "unauthenticated" } });
  const approved = await flows(["card", "approve", String(flow), String(card), ...as()]);
  expect(approved).toMatchObject({ code: 0, body: { ok: true, command: "flows card approve", applied: true, said: "Approved. Moved to Published." } });
  expect(events(card)).toEqual([{ from_stage: "ok", to_stage: "done", outcome: "approved", actor: "alex", note: null }]);
  expect(ledger()).toEqual([{ actor: "alex", repo, action: "flows card approve", outcome: "accepted", source: "request", detail: `command line · flow #${flow} card #${card} · Publish to toolroll.dev?` }]);
  // A second approve of the same card finds it has moved on: refused, and nothing else changes.
  const again = await flows(["card", "approve", String(flow), String(card), ...as()]);
  expect(again).toMatchObject({ code: 3, body: { ok: false } });
  expect(events(card)).toHaveLength(1);
  expect(ledger().at(-1)).toMatchObject({ action: "flows card approve", outcome: "refused" });
});

test("card send-back needs a note, then returns the card with it, as the console's Send back does", async () => {
  const { flow, card } = approvalCard();
  expect(await flows(["card", "send-back", String(flow), String(card), ...as()])).toMatchObject({ code: 2, body: { reason: "usage" } });
  const back = await flows(["card", "send-back", String(flow), String(card), "--note", "Mention the new pricing.", ...as()]);
  expect(back).toMatchObject({ code: 0, body: { ok: true, command: "flows card send-back", said: "Sent back to Write it with your note." } });
  expect(events(card)).toEqual([{ from_stage: "ok", to_stage: "draft", outcome: "sent-back", actor: "alex", note: "Mention the new pricing." }]);
  expect(ledger()).toEqual([expect.objectContaining({ action: "flows card send-back", outcome: "accepted" })]);
});

test("a card approve by someone who isn't the decider is refused and changes nothing", async () => {
  const { flow, card } = approvalCard();
  const made = look(store => addApprover(store, "sam", NOW, { name: "alex", token: alex }));
  if (!made.ok) throw new Error("sam");
  const refused = await flows(["card", "approve", String(flow), String(card), "--as", "sam", "--token", made.token]);
  expect(refused).toMatchObject({ code: 3, body: { ok: false, message: "Only alex decides here." } });
  expect(events(card)).toEqual([]);
  expect(look(store => store.getFlowCard(card))).toMatchObject({ stage: "ok", state: "active" });
});

test("at a Person chooses step, card approve takes --option, through the console's choice door", async () => {
  const { flow, card } = look(store => {
    const flow = store.createFlow({ repo, name: "Triage", by: "alex", definitionJson: JSON.stringify(flowFromSteps([
      { id: "build", title: "Build", kind: "inbox" },
      { id: "choose", title: "What next?", kind: "choose", options: [{ label: "Ship it", goesTo: "Ship" }, { label: "Ignore", goesTo: "end" }] },
      { id: "ship", title: "Ship", kind: "inbox" },
    ], null)) }, NOW);
    return { flow, card: store.addFlowCard({ flow, title: "Checkout rounding", description: null, stage: "choose", by: "alex" }, NOW) };
  });
  const missing = await flows(["card", "approve", String(flow), String(card), ...as()]);
  expect(missing).toMatchObject({ code: 2, body: { ok: false, reason: "choose-option" } });
  expect(missing.body.message).toContain("1 “Ship it”");
  expect(await flows(["card", "send-back", String(flow), String(card), "--option", "1", ...as()])).toMatchObject({ code: 2, body: { reason: "usage" } });
  const chosen = await flows(["card", "approve", String(flow), String(card), "--option", "ship it", ...as()]);
  expect(chosen).toMatchObject({ code: 0, body: { ok: true, said: "Ship it. Moved to Ship." } });
  expect(look(store => store.handle.prepare("SELECT outcome, detail FROM action_ledger WHERE action = 'flow choice'").all())).toEqual([{ outcome: "chosen", detail: `Triage · card ${card} · What next?: “Ship it” · via the command line` }]);
});
