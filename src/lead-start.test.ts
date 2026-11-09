/**
 * propose_start in the lead's turn loop (docs/plans/one-step-chat.md C3), against a real store and a scripted provider:
 * the input is validated before the classifier is asked, the preview is prepared by the loop for this call in this turn
 * (never from the model's arguments), standing is re-proved after the wait, and anything Toolroll can't start right away
 * is an ordinary task card with the reason.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type ChatConfig, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { verifyApproverStanding, type VerifiedApprover } from "./principal.js";
import { credentialKeyOf } from "./converse.js";
import { runLeadTurn } from "./lead.js";
import { executeLeadTool } from "./lead-tools.js";
import { register } from "./runner.js";
import { installFilingSizer, type Sizer } from "./task-sizing.js";
import { readSharedAction } from "./contracts/chat-actions.js";

const T0 = new Date("2026-11-09T12:00:00.000Z");
const KEY = "sk-ant-test-key";
const CREDENTIAL = credentialKeyOf("anthropic-api", KEY);
const CONFIG: ChatConfig = { provider: "anthropic-api", model: "claude-sonnet-5", dailyTurns: 50, weeklyCeilingMicrousd: 25_000_000, priceInMicrousd: 3, priceOutMicrousd: 15, updatedAt: T0.toISOString(), updatedBy: "alex" };
type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const answer = (blocks: Block[]) => json({ type: "message", content: blocks, usage: { input_tokens: 100, output_tokens: 20 } });
const text = (value: string) => answer([{ type: "text", text: value }]);
let serial = 0;
const call = (name: string, input: Record<string, unknown> = {}): Block => ({ type: "tool_use", id: `${name}-${++serial}`, name, input });
function scripted(responses: Response[]) {
  const bodies: string[] = [];
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(String(init?.body ?? ""));
    const next = responses.shift();
    if (next === undefined) throw new Error("the script ran out of responses");
    return next;
  }) as unknown as typeof fetch;
  return { fetcher, bodies };
}

let dir: string, repo: string, store: Store, who: VerifiedApprover, dropSizer: () => void, sizerCalls: number;
const SMALL: Sizer = async () => { sizerCalls++; return { size: "small", risky: false, reason: "one word" }; };
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "lead-start-")));
  repo = join(dir, "shop");
  mkdirSync(repo);
  store = openStore(join(dir, "orders.db"));
  if (!addApprover(store, "alex", T0).ok) throw new Error("alex");
  for (const phase of ["plan", "build", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "fixture", T0);
  store.upsertProject(repo, "shop", T0);
  register(store, { name: "worker", host: "fixture", capacity: 4, repos: [repo], now: T0, newToken: () => "tok" });
  sizerCalls = 0;
  dropSizer = installFilingSizer(SMALL);
  const verified = verifyApproverStanding(store, "alex", store.accountOf("alex")!.generation, [repo]);
  if (!verified.ok) throw new Error(verified.reason);
  who = verified.who;
});
afterEach(() => { dropSizer(); store.close(); rmSync(dir, { recursive: true, force: true }); });

const session = () => {
  const id = store.mintLeadSession({ approver: "alex", approverGeneration: who.generation, credentialKey: CREDENTIAL, ceilingMicrousd: 10_000_000, ceilingDigest: who.ceilingDigest, termsDigest: "t".repeat(64) }, T0);
  return store.getLeadSession(id)!;
};
const turn = (fetcher: typeof fetch, thread = store.openLeadThread("alex", who.ceilingDigest, T0).thread) =>
  runLeadTurn({ store, who, session: session(), thread, config: CONFIG, key: KEY, message: "just fix the typo in the footer", fetcher, clock: () => T0 });
const proposals = () => store.handle.prepare("SELECT id, kind, payload_json, turn, state FROM lead_proposal ORDER BY id").all().map(row => ({ id: Number(row["id"]), kind: String(row["kind"]), payload: JSON.parse(String(row["payload_json"])) as Record<string, unknown>, turn: Number(row["turn"]), state: String(row["state"]) }));
const previews = () => store.handle.prepare("SELECT id, via, turn, actor FROM fast_preview ORDER BY created_at, id").all();
const START = { repo: "r1", title: "Fix the typo in the footer" };

describe("propose_start", () => {
  test("a small request drafts a Start card whose preview came from the loop, in this turn", async () => {
    const script = scripted([answer([call("get_capabilities", { repo: "r1" })]), answer([call("propose_start", START)]), text("Tap Start work.")]);
    const outcome = await turn(script.fetcher);
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true, proposals: 1 });
    const [card] = proposals();
    expect(card).toMatchObject({ kind: "action", state: "pending" });
    const action = readSharedAction(card!.payload);
    if (!action.ok) throw new Error("unreadable");
    expect(action.value.operation).toBe("task_start");
    const saved = previews();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ via: "chat", turn: card!.turn, actor: "alex" });
    expect(action.value.request["preview"]).toBe(saved[0]!["id"]);
    expect(sizerCalls).toBe(1);
  });

  test("a preview id in the arguments is ignored", async () => {
    const forged = "f".repeat(32);
    const script = scripted([answer([call("get_capabilities", { repo: "r1" })]), answer([call("propose_start", { ...START, preview: forged })]), text("ok")]);
    expect(await turn(script.fetcher)).toMatchObject({ ok: true, proposals: 1 });
    const action = readSharedAction(proposals()[0]!.payload);
    if (!action.ok) throw new Error("unreadable");
    expect(action.value.request["preview"]).not.toBe(forged);
    expect(action.value.request["preview"]).toBe(previews()[0]!["id"]);
  });

  test("invalid input makes no classifier call: no capabilities read first, an unknown project, an empty title", async () => {
    const script = scripted([
      answer([call("propose_start", START)]),
      answer([call("get_capabilities", { repo: "r1" })]),
      answer([call("propose_start", { repo: "r9", title: "Fix it" }), call("propose_start", { repo: "r1", title: "" })]),
      text("couldn't"),
    ]);
    expect(await turn(script.fetcher)).toMatchObject({ ok: true, proposals: 0 });
    expect(sizerCalls).toBe(0);
    expect(previews()).toHaveLength(0);
    expect(script.bodies[1]).toContain("Read get_capabilities first");
  });

  test("two calls in one turn get two previews, two cards", async () => {
    const script = scripted([answer([call("get_capabilities", { repo: "r1" })]), answer([call("propose_start", START), call("propose_start", { repo: "r1", title: "Fix the typo in the header" })]), text("two")]);
    expect(await turn(script.fetcher)).toMatchObject({ ok: true, proposals: 2 });
    const cards = proposals().map(one => readSharedAction(one.payload)).map(one => (one.ok ? String(one.value.request["preview"]) : ""));
    expect(new Set(cards).size).toBe(2);
    expect(previews().map(one => one["id"]).sort()).toEqual([...cards].sort());
  });

  test("access removed during the classifier's wait drafts nothing", async () => {
    dropSizer();
    dropSizer = installFilingSizer(async () => { store.handle.prepare("UPDATE approver SET revoked_at = ? WHERE name = 'alex'").run(T0.toISOString()); return { size: "small", risky: false, reason: "x" }; });
    const script = scripted([answer([call("get_capabilities", { repo: "r1" })]), answer([call("propose_start", START)]), text("never")]);
    const outcome = await turn(script.fetcher);
    expect(outcome).toMatchObject({ ok: false });
    expect(proposals().filter(one => one.state !== "dismissed" && one.state !== "expired")).toEqual([]);
  });

  test.each([
    ["medium", () => { dropSizer(); dropSizer = installFilingSizer(async () => ({ size: "medium", risky: false, reason: "a few files" })); }, "This looks bigger than a small change."],
    ["protected", () => { store.setApprovalRules(repo, { notRequester: false, protectProject: true, protectedPaths: [] }, "alex", T0); }, "This may reach protected work."],
    ["a classifier that never answers", () => { dropSizer(); dropSizer = installFilingSizer(async () => null); }, "Toolroll couldn't confirm this is a small change."],
  ])("%s drafts an ordinary task card with the reason", async (_name, arrange, why) => {
    arrange();
    const script = scripted([answer([call("get_capabilities", { repo: "r1" })]), answer([call("propose_start", START)]), text("A task card instead.")]);
    expect(await turn(script.fetcher)).toMatchObject({ ok: true, proposals: 1 });
    const [card] = proposals();
    expect(card).toMatchObject({ kind: "task", payload: { title: START.title, goal: START.title, planning: "skip" } });
    expect(script.bodies[2]).toContain(why);
    expect(previews()).toHaveLength(0);
  });

  test("a team chat refuses", () => {
    const thread = store.openLeadThread("alex", who.ceilingDigest, T0).thread.id;
    store.handle.exec("PRAGMA foreign_keys = OFF");
    store.handle.prepare("INSERT INTO team_conversation (id, lead, title, visibility, projects_json, thread, created_by, created_at) VALUES ('c1', 'l1', 'Team', 'team', '[]', ?, 'alex', ?)").run(thread, T0.toISOString());
    store.handle.exec("PRAGMA foreign_keys = ON");
    const draft = vi.fn(() => 1);
    expect(executeLeadTool({ store, who, now: T0, step: 2, readDecisions: new Map(), draft, thread }, "propose_start", START))
      .toMatchObject({ ok: false, message: "Starting work in one step is for the person's own chat. Use propose_task here." });
    expect(draft).not.toHaveBeenCalled();
  });

  test("credentials in the title are refused, as propose_task refuses them", () => {
    const draft = vi.fn(() => 1);
    expect(executeLeadTool({ store, who, now: T0, step: 2, readDecisions: new Map(), draft }, "propose_start", { repo: "r1", title: "Use sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 here" })).toMatchObject({ ok: false });
    expect(draft).not.toHaveBeenCalled();
  });

  test("outside a turn (no loop-prepared preview) it is an ordinary task card", () => {
    const draft = vi.fn(() => 7);
    expect(executeLeadTool({ store, who, now: T0, step: 2, readDecisions: new Map(), draft }, "propose_start", START)).toMatchObject({ ok: true, body: { kind: "task", startsNow: false } });
    expect(draft).toHaveBeenCalledWith("task", expect.objectContaining({ planning: "skip", title: START.title }));
  });
});
