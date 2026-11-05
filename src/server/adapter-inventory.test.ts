/**
 * Easy-start C1, the adapter inventory: every way into this console is classified for a laptop's local owner, and a
 * new one fails here until someone decides it. Route rows (each marked allow or deny, an allow naming its act), the
 * edge rows (each in EDGE_LOCAL), the one WebSocket listener, every lead proposal kind and chat operation, every
 * declared CLI command — and every GET, requested with a signed-in cookie against a seeded store, writes nothing but the
 * allowlisted bookkeeping (the session's last-seen touch and a review's ceremony nonce).
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { EDGE_LOCAL, LOCAL_MARKED_IDS, ROUTES } from "./route-table.js";
import { CHAT_ACTION_LOCAL_ACTS, CHAT_TASK_ACTION_LOCAL_ACTS, LOCAL_OWNER_ACTS, LOCAL_OWNER_PROPOSALS, PROPOSAL_LOCAL_ACTS, localOwnerMayConfirm } from "../local-owner.js";
import { CHAT_ACTIONS } from "../chat-actions.js";
import { CHAT_TASK_ACTIONS } from "../chat-task-actions.js";
import { GUIDE_INVOCATIONS, LOCAL_ALLOWED_INVOCATIONS, LOCAL_POLICY } from "../surface.js";
import { inReadOnlyRequest } from "../read-only-request.js";
import { openQuietWorld, type QuietWorld } from "../../test/quiet-world.js";

test("every route row is marked for the local owner; an allow names one of its acts; no mark names a missing row", () => {
  for (const row of ROUTES) {
    expect(["allow", "deny"], row.id).toContain(row.local);
    if (row.local === "allow") expect(LOCAL_OWNER_ACTS, row.id).toContain(row.localAct);
    else expect(row.localAct, row.id).toBeNull();
  }
  const ids = new Set(ROUTES.map(row => row.id));
  expect(LOCAL_MARKED_IDS.filter(id => !ids.has(id))).toEqual([]);
  // The console POSTs a local owner may make, pinned: adding one is a decision this test makes someone write down.
  expect(ROUTES.filter(row => row.stage === "console" && row.method === "POST" && row.local === "allow").map(row => `${row.id}=${row.localAct}`).sort()).toEqual([
    "agents.seen=mark-seen", "agents.watch=watch-agent", "chat.file=file-task", "chat.mate-end=lead-send", "chat.mate-follow=lead-send", "chat.mate-mint=lead-send",
    "chat.mate-stop=lead-send", "chat.proposal.confirm=lead-send", "chat.proposal.dismiss=lead-send", "chat.queued-remove=lead-send", "chat.send=lead-send",
    "decision.answer=answer-question", "projects.github-list=add-project", "projects.onboard-confirm=add-project", "projects.onboard-preview=add-project",
    "projects.open=add-project", "projects.select=read", "run.act.comment=request-revision", "run.act.note=request-revision", "run.act.revise=request-revision", "settings.lead-on=choose-default-agent",
    // Results routing: lowering only, each in its exact act (route-store.ts proveRuleDoor re-checks it in the write).
    "settings.models-not-now=dismiss-suggestion", "settings.models-stop=trial-stop", "settings.models-suggest-off=dismiss-suggestion", "settings.models-turn-off=routing-turn-off",
    "task.act.approve=approve-plan", "task.act.archive=archive-task", "task.act.cancel=stop-run", "task.act.complete=complete-task", "task.act.hold=pause-run",
    "task.act.pause=pause-run", "task.act.reply=answer-question", "task.act.restore=archive-task", "task.act.resume-arm=resume-run", "task.act.resume=resume-run",
    "task.act.steer=lead-send", "task.act.stop=stop-run", "task.act.unhold=resume-run", "tasks.add=file-task", "welcome.sample=add-project",
  ]);
  // Every console GET is a read.
  for (const row of ROUTES.filter(one => one.stage === "console" && one.method !== "POST")) expect([row.local, row.localAct], row.id).toEqual(["allow", "read"]);
});

test("every edge row is in the inventory map, and the map names only edge rows", () => {
  const edges = ROUTES.filter(row => row.stage === "edge").map(row => row.id).sort();
  expect(Object.keys(EDGE_LOCAL).sort()).toEqual(edges);
  for (const [id, mark] of Object.entries(EDGE_LOCAL)) expect(mark.why.length, id).toBeGreaterThan(5);
  // The edge rows a cookie reaches with authority are decided deny; their adapters refuse a local owner themselves.
  for (const id of ["edge.team-read", "edge.team-send", "edge.oauth-authorize", "edge.oauth-consent", "edge.google-callback", "edge.connect-callback"]) expect(EDGE_LOCAL[id]?.local, id).toBe("deny");
});

test("exactly one WebSocket upgrade listener exists in the server's source (the terminals', which refuses a local owner)", () => {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { if (name !== "browser") walk(path); continue; }
      if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) continue;
      for (const line of readFileSync(path, "utf8").split("\n")) if (/\bon\(\s*["']upgrade["']/.test(line)) found.push(`${path}: ${line.trim().slice(0, 60)}`);
    }
  };
  walk(join(import.meta.dirname, ".."));
  expect(found).toHaveLength(1);
  expect(found[0]).toContain("server/terminals.ts");
});

test("every lead proposal kind and chat operation is decided, and the decisions agree", () => {
  const kinds = ["task", "next", "reserve", "hold", "unhold", "steer", "scope", "cancel", "answer", "repair", "agents", "review", "control", "task_action", "action"];
  expect(Object.keys(LOCAL_OWNER_PROPOSALS).sort()).toEqual([...kinds].sort());
  expect(Object.keys(PROPOSAL_LOCAL_ACTS).sort()).toEqual([...kinds].sort());
  for (const kind of kinds) {
    const act = PROPOSAL_LOCAL_ACTS[kind as keyof typeof PROPOSAL_LOCAL_ACTS];
    if (kind === "action" || kind === "task_action") expect(act, kind).toBeNull();
    else expect(act !== null, kind).toBe(LOCAL_OWNER_PROPOSALS[kind as keyof typeof LOCAL_OWNER_PROPOSALS] === "allow");
    if (act !== null) expect(localOwnerMayConfirm(kind, act), kind).toBe(true);
  }
  expect(Object.keys(CHAT_ACTION_LOCAL_ACTS).sort()).toEqual(Object.keys(CHAT_ACTIONS).sort());
  expect(Object.keys(CHAT_TASK_ACTION_LOCAL_ACTS).sort()).toEqual(Object.keys(CHAT_TASK_ACTIONS).sort());
  expect(Object.entries(CHAT_ACTION_LOCAL_ACTS).filter(([, act]) => act !== null).sort()).toEqual([
    ["result_accept", "complete-task"], ["scope_approve", "approve-plan"], ["suggestion_not_now", "dismiss-suggestion"], ["task_cancel", "stop-run"], ["task_resume", "resume-run"], ["trial_stop", "trial-stop"]]);
});

test("every declared CLI command is marked for the local owner, and no mark names a missing command", () => {
  expect([...LOCAL_POLICY.keys()].sort()).toEqual([...GUIDE_INVOCATIONS].sort());
  expect(LOCAL_ALLOWED_INVOCATIONS.filter(one => !GUIDE_INVOCATIONS.includes(one))).toEqual([]);
  for (const [invocation, mark] of LOCAL_POLICY) if (mark.local === "allow") expect(LOCAL_OWNER_ACTS, invocation).toContain(mark.act);
  // Never a credential, people, policy or machine command.
  for (const invocation of ["tokens create", "people invite", "approver add", "mode set", "config set", "lead token", "up", "serve", "release", "update", "keys set", "project check-access"]) {
    if (LOCAL_POLICY.has(invocation)) expect(LOCAL_POLICY.get(invocation), invocation).toEqual({ local: "deny" });
  }
});

// ---- GET writes nothing beyond the allowlist (plan C1 N1) ------------------------------------------------------------

let world: QuietWorld;
beforeEach(async () => { world = await openQuietWorld(() => {}); });
afterEach(async () => { vi.restoreAllMocks(); await world.close(); });

/**
 * Every table, hashed, but the allowlisted writes: a session's last-seen touch, and a review's ceremony nonce. And the
 * bookkeeping no authority rides on: the request budget's counters, a slow request's timeline, the action ledger's
 * hash-chain seals of entries already written (the ledger page seals before it reads, ledger-chain.ts), and the
 * workspace's content revision those writes bump (a cache key).
 */
function snapshot(): Record<string, string> {
  const store = world.store.raw();
  const tables = store.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map(row => String(row["name"]))
    .filter(name => !["ceremony_nonce", "request_budget_usage", "latency_timeline", "ledger_seal"].includes(name));
  return Object.fromEntries(tables.map(table => {
    const rows = store.prepare(`SELECT * FROM "${table}"`).all().filter(row => !(table === "service_cursor" && row["key"] === "workspace-content:v1")).map(row => {
      if (table !== "web_session") return row;
      const { last_seen: _seen, ...kept } = row;
      return kept;
    });
    return [table, createHash("sha256").update(JSON.stringify(rows)).digest("hex")];
  }));
}

test("every GET row, with a signed-in cookie and no key: the table diff holds only the session touch and a ceremony nonce", async () => {
  const { cookie } = await world.signIn();
  // A finished run whose opening used to write the seen mark (now the keyed POST /agents/seen) and an agent page that
  // used to take a watch lease (now POST /agents/watch).
  await new Promise(done => setTimeout(done, 200));
  const sweep = world.store.sweepStaleLeadTurns.bind(world.store);
  vi.spyOn(world.store, "sweepStaleLeadTurns").mockImplementation(now => inReadOnlyRequest() ? sweep(now) : 0);
  const rows = ROUTES.filter(row => row.method !== "POST" && row.id !== "live");
  const found: string[] = [];
  for (const row of rows) {
    const before = snapshot();
    const answer = await world.send(row.sample, "GET", { cookie });
    await new Promise(done => setTimeout(done, 10));
    const after = snapshot();
    const changed = Object.keys(after).filter(key => before[key] !== after[key]);
    if (changed.length > 0) found.push(`GET ${row.sample} (${row.id}) ${answer.status}: ${changed.join(", ")}`);
  }
  expect(found).toEqual([]);
}, 60_000);
