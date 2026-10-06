/**
 * Approving from chat as a lasting owner setting (chat-approval.ts): off by default, on for all projects or one, a
 * project's own row first, never lapsing by date but ending with the account's generation, and every change ledgered.
 * Turned on from Settings with the nonce and password; off in one step; and from the CLI with --as/--token.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Server } from "node:http";
import { openStore, type Store } from "./store.js";
import { addApprover, propose } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { runOperate } from "./operate.js";
import { ALL_PROJECTS, chatApprovalSettings, effectiveChatApproval, setChatApproval } from "./chat-approval.js";
import { chatApproveMode, planInChat } from "./chat-decide.js";
import { register } from "./runner.js";

const NOW = new Date("2026-10-06T10:00:00.000Z");
const DAY = 86_400_000;
let root: string, alpha: string, beta: string, file: string, store: Store, ownerToken: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "so-chat-approval-")));
  alpha = join(root, "alpha"); beta = join(root, "beta");
  mkdirSync(alpha); mkdirSync(beta);
  file = join(root, "orders.db");
  store = openStore(file);
  const owner = addApprover(store, "owner", NOW);
  if (!owner.ok) throw new Error("bootstrap failed");
  ownerToken = owner.token;
  store.upsertProject(alpha, "alpha", NOW);
  store.upsertProject(beta, "beta", NOW);
});
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

const ledger = () => store.handle.prepare("SELECT actor, repo, action, outcome, detail FROM action_ledger WHERE action = 'chat approval setting' ORDER BY id").all();
const on = (scope: string, limits = { fullAccess: false, capMicrousd: 5_000_000 }) => setChatApproval(store, { approver: "owner", scope, enabled: true, limits, via: "test" }, NOW);

describe("the lasting setting", () => {
  test("is off until turned on; a project's own row outranks all projects; it still holds weeks later", () => {
    expect(effectiveChatApproval(store, alpha, "owner")).toEqual({ ok: false, why: "Approving from chat isn't turned on for this project." });
    expect(on(ALL_PROJECTS)).toMatchObject({ ok: true, said: "Approving from chat is on for all your projects: plans that ask for full access open in Toolroll · attempts up to $5.00." });
    expect(effectiveChatApproval(store, alpha, "owner")).toMatchObject({ ok: true, limits: { fullAccess: false, capMicrousd: 5_000_000 } });
    // An explicit off on one project keeps it off there, and only there.
    expect(setChatApproval(store, { approver: "owner", scope: beta, enabled: false, via: "test" }, NOW))
      .toEqual({ ok: true, said: `Approving from chat is off for ${beta}.` });
    expect(effectiveChatApproval(store, beta, "owner").ok).toBe(false);
    expect(effectiveChatApproval(store, alpha, "owner").ok).toBe(true);
    // A project's own limits win over the all-projects ones.
    on(alpha, { fullAccess: true, capMicrousd: null });
    expect(effectiveChatApproval(store, alpha, "owner")).toMatchObject({ ok: true, limits: { fullAccess: true, capMicrousd: null } });
    // No expiry: a month on, the same answer (a signed mode lasts at most seven days).
    expect(chatApproveMode(store, alpha, "owner", new Date(NOW.getTime() + 30 * DAY))).toMatchObject({ ok: true, source: "setting" });
    expect(ledger()).toEqual([
      { actor: "owner", repo: null, action: "chat approval setting", outcome: "on", detail: "all projects · plans that ask for full access open in Toolroll · attempts up to $5.00 · via test" },
      { actor: "owner", repo: beta, action: "chat approval setting", outcome: "off", detail: "this project · via test" },
      { actor: "owner", repo: alpha, action: "chat approval setting", outcome: "on", detail: "this project · plans may ask for full access · any attempt limit · via test" },
    ]);
  });

  test("ends with the account: a password reset or lost project access stops it", () => {
    on(ALL_PROJECTS);
    expect(effectiveChatApproval(store, alpha, "owner").ok).toBe(true);
    store.handle.prepare("UPDATE approver SET generation = generation + 1 WHERE name = 'owner'").run();
    expect(effectiveChatApproval(store, alpha, "owner")).toEqual({ ok: false, why: "Your access changed since you turned on approving from chat. Turn it on again in Settings." });
    on(ALL_PROJECTS);
    expect(effectiveChatApproval(store, alpha, "owner").ok).toBe(true);
    // Someone else's setting is never this person's.
    expect(effectiveChatApproval(store, alpha, "sam").ok).toBe(false);
  });

  test("all-projects off rolls back every setting and ledger entry if recording a project fails", () => {
    on(ALL_PROJECTS);
    on(alpha);
    on(beta);
    const settingsBefore = chatApprovalSettings(store, "owner");
    const ledgerBefore = ledger();
    const recordAction = store.recordAction.bind(store);
    const recording = vi.spyOn(store, "recordAction").mockImplementation(entry => {
      if (entry.repo === beta) throw new Error("Ledger unavailable");
      return recordAction(entry);
    });
    try {
      expect(() => setChatApproval(store, { approver: "owner", scope: ALL_PROJECTS, enabled: false, via: "test" }, new Date(NOW.getTime() + DAY)))
        .toThrow("Ledger unavailable");
    } finally {
      recording.mockRestore();
    }
    expect(chatApprovalSettings(store, "owner")).toEqual(settingsBefore);
    expect(ledger()).toEqual(ledgerBefore);
  });

  test("keeps today's exclusions: wider access, over the limit and protected paths still open in Toolroll", () => {
    for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "owner", NOW);
    register(store, { name: "worker-1", host: "test", capacity: 9, repos: [alpha], now: NOW, newToken: () => "tok-worker-1" });
    store.createTask({ id: "plan-1", title: "Refuse over-limit payouts" }, NOW);
    store.placeTask(store.refFor("built-in", "plan-1").id, alpha, {}, NOW);
    const file = (extra: Partial<Parameters<typeof propose>[1]> = {}) => propose(store, { taskId: "plan-1", goal: "Refuse over-limit payouts.", touches: ["src/guard.ts"], budgetMicrousd: 2_000_000,
      acceptance: [{ id: "c1", statement: "Over-limit payouts are refused.", how: null, evidence: ["check"] }], now: NOW, ...extra });
    file();
    const why = () => { const plan = planInChat(store, "plan-1", "owner", NOW); return plan.ok ? "in chat" : plan.why; };
    expect(why()).toBe("Approving from chat isn't turned on for this project.");
    on(alpha, { fullAccess: false, capMicrousd: 1_000_000 });
    expect(why()).toBe("This plan has a $2.00 attempt limit, more than your chat approval limit of $1.00.");
    on(alpha);
    expect(why()).toBe("in chat");
    file({ posture: "escalated" });
    expect(why()).toBe("This plan asks for more access than your chat approval setting allows.");
    file();
    store.setApprovalRules(alpha, { notRequester: false, protectProject: false, protectedPaths: ["src/"] }, "owner", NOW);
    expect(why()).toBe("This plan touches protected work, so two people approve it in Toolroll.");
  });
});

describe("turning it on and off", () => {
  let server: Server, base: string;
  beforeEach(async () => {
    server = createDecisionServer({ store, evidenceRoot: root, repos: [alpha, beta], clock: () => NOW });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

  test("Settings turns it on with the nonce and password, refuses a stale or changed form, and turns it off in one step", async () => {
    const signedIn = await fetch(base + "/login", { method: "POST", body: new URLSearchParams({ name: "owner", token: ownerToken }), redirect: "manual" });
    const cookie = signedIn.headers.get("set-cookie")!.split(";")[0]!;
    const page = await (await fetch(base + "/tasks/new", { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)![1]!;
    const send = (path: string, values: Record<string, string> | URLSearchParams) => fetch(base + path, { method: "POST", headers: { cookie },
      body: new URLSearchParams({ csrf, ...Object.fromEntries(values instanceof URLSearchParams ? values : Object.entries(values)) }), redirect: "manual" });
    const confirm = async (values: Record<string, string>) => {
      const response = await send("/settings/chat-approval/confirm", values);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Limits: plans that ask for full access open in Toolroll · attempts up to $5.00.");
      return new URLSearchParams([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map(one => [one[1]!, one[2]!]));
    };
    // Without the password, nothing changes.
    const bare = await confirm({ scope: alpha, "cap-usd": "5" });
    expect((await send("/settings/chat-approval/save", bare)).status).toBe(403);
    expect(effectiveChatApproval(store, alpha, "owner").ok).toBe(false);
    // The nonce was spent; and a form whose limits changed after the terms were read is refused.
    bare.set("token", ownerToken);
    expect((await send("/settings/chat-approval/save", bare)).status).toBe(409);
    const changed = await confirm({ scope: alpha, "cap-usd": "5" }); changed.set("token", ownerToken); changed.set("full-access", "1");
    expect((await send("/settings/chat-approval/save", changed)).status).toBe(409);
    expect(effectiveChatApproval(store, alpha, "owner").ok).toBe(false);
    const good = await confirm({ scope: alpha, "cap-usd": "5" }); good.set("token", ownerToken);
    expect((await send("/settings/chat-approval/save", good)).status).toBe(303);
    expect(effectiveChatApproval(store, alpha, "owner")).toMatchObject({ ok: true, limits: { fullAccess: false, capMicrousd: 5_000_000 } });
    // Off: csrf only, no password.
    expect((await send("/settings/chat-approval/off", { scope: alpha })).status).toBe(303);
    expect(effectiveChatApproval(store, alpha, "owner").ok).toBe(false);
    expect(ledger().map(one => [one["outcome"], one["detail"]])).toEqual([
      ["on", "this project · plans that ask for full access open in Toolroll · attempts up to $5.00 · via the console"],
      ["off", "this project · via the console"],
    ]);
    // The same Settings action for all projects disables saved project overrides too.
    on(ALL_PROJECTS);
    on(alpha);
    on(beta, { fullAccess: true, capMicrousd: 9_000_000 });
    const beforeOff = ledger().length;
    expect((await fetch(base + "/settings/chat-approval/off", { method: "POST", headers: { cookie },
      body: new URLSearchParams({ scope: "all" }), redirect: "manual" })).status).toBe(403);
    expect(effectiveChatApproval(store, alpha, "owner").ok).toBe(true);
    expect(ledger()).toHaveLength(beforeOff);
    const off = await send("/settings/chat-approval/off", { scope: "all" });
    expect(off.status).toBe(303);
    expect(new URL(off.headers.get("location")!, base).searchParams.get("said")).toBe("Approving from chat is off for all your projects.");
    for (const repo of [alpha, beta]) expect(effectiveChatApproval(store, repo, "owner").ok).toBe(false);
    expect(chatApprovalSettings(store, "owner").map(one => [one.scope, one.enabled])).toEqual([[ALL_PROJECTS, false], [alpha, false], [beta, false]]);
    expect(ledger().slice(beforeOff)).toEqual([
      { actor: "owner", repo: null, action: "chat approval setting", outcome: "off", detail: "all projects · via the console" },
      { actor: "owner", repo: alpha, action: "chat approval setting", outcome: "off", detail: "this project · via the console" },
      { actor: "owner", repo: beta, action: "chat approval setting", outcome: "off", detail: "this project · via the console" },
    ]);
  });

  test("the CLI previews until --yes, takes --as/--token, and turns it off in one step", async () => {
    expect(addApprover(store, "sam", NOW, { name: "owner", token: ownerToken }).ok).toBe(true);
    for (const scope of [ALL_PROJECTS, alpha]) {
      expect(setChatApproval(store, { approver: "sam", scope, enabled: true, limits: { fullAccess: true, capMicrousd: null }, via: "test" }, NOW).ok).toBe(true);
    }
    const otherSettings = chatApprovalSettings(store, "sam");
    const otherLedger = ledger();
    store.close();
    let now = NOW;
    const cli = async (argv: string[], json = true) => {
      const lines: string[] = [];
      const code = await runOperate("chat-approval", [...argv, ...(json ? ["--json"] : [])], line => { lines.push(line); }, { databaseFile: file, now });
      return { code, body: json ? JSON.parse(lines.join("\n")) as Record<string, any> : {}, lines };
    };
    const as = ["--as", "owner", "--token", ownerToken];
    expect(await cli(["on", "--repo", alpha])).toMatchObject({ code: 3, body: { ok: false, reason: "unauthenticated" } });
    expect(await cli(["on", "--repo", alpha, "--cap-usd", "5", ...as])).toMatchObject({ code: 0, body: { applied: false } });
    store = openStore(file);
    expect(effectiveChatApproval(store, alpha, "owner").ok).toBe(false);
    store.close();
    expect(await cli(["on", "--repo", alpha, "--cap-usd", "5", "--yes", ...as])).toMatchObject({ code: 0, body: { applied: true, scope: alpha } });
    expect((await cli(["show", ...as])).body.settings).toEqual([{ scope: alpha, enabled: true, fullAccess: false, capMicrousd: 5_000_000, updatedAt: NOW.toISOString() }]);
    now = new Date(NOW.getTime() + DAY);
    expect(await cli(["off", ...as], false)).toMatchObject({ code: 0, lines: ["Approving from chat is off for all your projects."] });
    store = openStore(file);
    // Turning it off for all projects also disables a project's own "on".
    expect(effectiveChatApproval(store, alpha, "owner").ok).toBe(false);
    expect(effectiveChatApproval(store, beta, "owner").ok).toBe(false);
    expect(chatApprovalSettings(store, "owner")).toMatchObject([
      { scope: ALL_PROJECTS, enabled: false, updatedBy: "owner", updatedAt: now.toISOString() },
      { scope: alpha, enabled: false, fullAccess: false, capMicrousd: 5_000_000, updatedBy: "owner", updatedAt: now.toISOString() },
    ]);
    expect(chatApprovalSettings(store, "sam")).toEqual(otherSettings);
    expect(effectiveChatApproval(store, alpha, "sam").ok).toBe(true);
    expect(effectiveChatApproval(store, beta, "sam").ok).toBe(true);
    expect(ledger().filter(one => one["actor"] === "sam")).toEqual(otherLedger);
    expect(ledger().slice(otherLedger.length)).toEqual([
      { actor: "owner", repo: alpha, action: "chat approval setting", outcome: "on", detail: "this project · plans that ask for full access open in Toolroll · attempts up to $5.00 · via the command line" },
      { actor: "owner", repo: null, action: "chat approval setting", outcome: "off", detail: "all projects · via the command line" },
      { actor: "owner", repo: alpha, action: "chat approval setting", outcome: "off", detail: "this project · via the command line" },
    ]);
    // A later deliberate project enable still wins over the all-projects off row.
    store.close();
    expect(await cli(["on", "--repo", alpha, "--cap-usd", "3", "--yes", ...as])).toMatchObject({ code: 0, body: { applied: true, scope: alpha } });
    store = openStore(file);
    expect(effectiveChatApproval(store, alpha, "owner")).toMatchObject({ ok: true, limits: { fullAccess: false, capMicrousd: 3_000_000 } });
    expect(effectiveChatApproval(store, beta, "owner").ok).toBe(false);
  });
});
