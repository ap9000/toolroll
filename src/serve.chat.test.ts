/**
 * The console server: fleet chat, the mate's thread and scout digests —
 * the model drafts, the ceremony approves.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { saveSlackCredentials } from "./slack-api.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { mateTimeoutNotice, openStore, type Store } from "./store.js";
import { release } from "./claim.js";
import { addApprover, approvalOf, approve, propose } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { TURN_WALL_CLOCK_MS, type MateProviderAnswer } from "./converse.js";
import { Window } from "happy-dom";
import { presented, T0, stylesOf, workspaceOf, sealScopeFixture } from "../test/serve-kit.js";
import { TeamLeads } from './team-leads.js';
import type { TeamOperation, TeamResponse } from './team-contract.js';

describe("fleet chat — the LLM drafts, the ceremony approves (v13)", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let approverToken: string;
  let evidenceRoot: string;
  let repoDir: string;
  let fetcherResult: () => Promise<Response>;
  let clockNow: Date;

  const url = (path: string) => `${base}${path}`;
  const T0 = new Date("2026-08-14T12:00:00.000Z");

  const login = async (): Promise<string> => {
    const response = await fetch(url("/login"), {
      method: "POST",
      body: new URLSearchParams({ name: "alex", token: approverToken }),
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
  };

  const csrfFrom = async (cookie: string): Promise<string> => {
    const html = await (await fetch(url("/chat"), { headers: { cookie } })).text();
    const match = /name="csrf" value="([0-9a-f]{64})"/.exec(html);
    if (match === null) throw new Error("no csrf on /chat");
    return match[1] as string;
  };

  const envelope = (reply: string, proposals: unknown[] = []) =>
    JSON.stringify({ chatEnvelope: 1, reply, proposals });

  const anthropicWrapper = (text: string) =>
    new Response(
      JSON.stringify({
        type: "message",
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
        usage: { input_tokens: 500, output_tokens: 100 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 100; i++) {
      const busy = store.recentChatTurns("alex", 5).some(one => one.state === "queued" || one.state === "running");
      if (!busy) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error("turn never settled");
  };

  const boot = async (options: Record<string, unknown> = {}) => {
    server = createDecisionServer({
      store,
      evidenceRoot,
      clock: () => clockNow,
      repo: repoDir,
      chatEnv: { ANTHROPIC_API_KEY: "sk-test-key" },
      chatFetcher: (async () => fetcherResult()) as typeof fetch,
      ...options,
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  };

  beforeEach(() => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-chat-ev-"));
    repoDir = realpathSync(mkdtempSync(join(tmpdir(), "standing-orders-chat-repo-")));
    clockNow = T0;
    fetcherResult = async () => anthropicWrapper(envelope("all quiet"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;
    store.setChatConfig(
      { provider: "anthropic-api", model: "claude-sonnet-5", dailyTurns: 50, weeklyCeilingMicrousd: 25_000_000, priceInMicrousd: 3, priceOutMicrousd: 15 },
      "alex",
      T0,
    );
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(evidenceRoot, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  });

  test("enablement refusals are distinct and stated", async () => {
    store.clearChatConfig();
    await boot();
    const cookie = await login();
    const off = await (await fetch(url("/chat"), { headers: { cookie } })).text();
    // The lead's form lives in Settings → Lead now (onboarding); Chat names no jargon form.
    expect(off).not.toContain('action="/chat/config"');
    expect(await (await fetch(url("/settings/lead"), { headers: { cookie } })).text()).toContain("The lead is off.");
    store.setChatConfig({ provider: "anthropic-api", model: "claude-sonnet-5", dailyTurns: 50, weeklyCeilingMicrousd: 1_000_000, priceInMicrousd: 3, priceOutMicrousd: 15 }, "alex", T0);
    const noKey = await new Promise<string>(resolve => {
      server.close(() => resolve(""));
    }).then(async () => {
      await boot({ chatEnv: {} });
      const freshCookie = await login();
      return (await fetch(url("/chat"), { headers: { cookie: freshCookie } })).text();
    });
    expect(noKey).toContain("ANTHROPIC_API_KEY");
  });

  test("a demo database refuses chat outright", async () => {
    store.recordInstallationFact("demo", "1", T0);
    await boot();
    const cookie = await login();
    const html = await (await fetch(url("/chat"), { headers: { cookie } })).text();
    expect(html).toContain("Chat isn’t available in demo mode");
    expect(html).toContain("Demo data never contacts an external model. Start Toolroll with a real project to use chat: <code>npx toolroll up</code> in your repository.");
    expect(html).not.toContain("Chat is off.");
  });

  test("the saved chat catch-up identifies the unfinished prerequisite", async () => {
    for (const id of ["t-blocker", "t-dependent"]) {
      store.createTask({ id, title: id === "t-dependent" ? "must not wait forever" : "obsolete prerequisite" }, T0);
      store.placeTask(store.refFor("built-in", id).id, repoDir);
    }
    expect(store.addEdge("t-dependent", "t-blocker")).toEqual({ ok: true });
    expect(store.cancelTask("t-blocker", T0, "replaced")).toMatchObject({ ok: true });
    await boot();
    const cookie = await login();

    const html = await (await fetch(url("/chat"), { headers: { cookie } })).text();
    expect(html).toContain('<a href="/chat?task=t-dependent">must not wait forever</a>');
    expect(html).toContain("t-blocker was cancelled before it finished.");
  });

  test("the whole loop: password-gated ask, reply, draft card, password-gated file through the door", async () => {
    fetcherResult = async () =>
      anthropicWrapper(
        envelope("One draft ready.", [
          { kind: "task", repoId: "r1", title: "Deflake the webhook test", goal: "Pin the clock in the retry test.", outOfScope: null, touches: [], acceptance: [{ id: "c1", statement: "The retry test's clock is pinned.", how: null, evidence: ["check"] }] },
        ]),
      );
    await boot();
    const cookie = await login();
    const csrf = await csrfFrom(cookie);

    // No password → no turn.
    const refused = await fetch(url("/chat"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, message: "anything stuck?" }),
      redirect: "manual",
    });
    expect(refused.headers.get("location") ?? "").toContain("password");
    expect(store.recentChatTurns("alex", 5)).toHaveLength(0);

    const asked = await fetch(url("/chat"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, message: "anything stuck?", token: approverToken }),
      redirect: "manual",
    });
    expect(asked.status).toBe(303);
    await settle();
    const turn = store.recentChatTurns("alex", 1)[0];
    expect(turn?.state).toBe("answered");
    expect(turn?.settledMicrousd).toBe(500 * 3 + 100 * 15);

    const html = await (await fetch(url("/chat"), { headers: { cookie } })).text();
    expect(html).toContain("One draft ready.");
    expect(html).toContain("Deflake the webhook test");
    const fileAction = /action="(\/chat\/file\/[0-9a-f]{32})"/.exec(html)?.[1];
    if (fileAction === undefined) throw new Error("no file form");

    // Filing also takes the password; then the door files it UNAPPROVED.
    const filed = await fetch(url(fileAction), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, token: approverToken }),
      redirect: "manual",
    });
    expect(filed.status).toBe(303);
    const where = filed.headers.get("location") as string;
    expect(where).toMatch(/^\/t\//);
    const taskId = where.slice(3);
    expect(store.getScope(taskId)?.approvedAt).toBeNull();
    expect(store.filedViaOf(taskId)).toBe("chat:anthropic-api");
    // The draft is spent: filing again 404s.
    const again = await fetch(url(fileAction), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, token: approverToken }),
      redirect: "manual",
    });
    expect(again.status).toBe(404);
  });

  test("a credential-shaped message refuses BEFORE any row or request", async () => {
    let called = 0;
    fetcherResult = async () => {
      called++;
      return anthropicWrapper(envelope("x"));
    };
    await boot();
    const cookie = await login();
    const csrf = await csrfFrom(cookie);
    const posted = await fetch(url("/chat"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, message: "my token is ghp_" + "a".repeat(36), token: approverToken }),
      redirect: "manual",
    });
    expect(posted.headers.get("location") ?? "").toContain("credential");
    expect(store.recentChatTurns("alex", 5)).toHaveLength(0);
    expect(called).toBe(0);
  });

  test("a malformed reply renders ONLY the static line, and script tags in replies stay inert", async () => {
    fetcherResult = async () => anthropicWrapper("here is my answer, no JSON");
    await boot();
    const cookie = await login();
    const csrf = await csrfFrom(cookie);
    await fetch(url("/chat"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, message: "hello", token: approverToken }),
      redirect: "manual",
    });
    await settle();
    let html = await (await fetch(url("/chat"), { headers: { cookie } })).text();
    expect(html).toContain("malformed and was discarded");
    expect(html).not.toContain("here is my answer");

    fetcherResult = async () => anthropicWrapper(envelope('<script>alert(1)</script>'));
    const csrf2 = await csrfFrom(cookie);
    await fetch(url("/chat"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf: csrf2, message: "again", token: approverToken }),
      redirect: "manual",
    });
    await settle();
    html = await (await fetch(url("/chat"), { headers: { cookie } })).text();
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
  });

  test("a network failure after dispatch LATCHES the credential; the nonce ceremony lifts it", async () => {
    fetcherResult = async () => {
      throw new Error("connection reset");
    };
    await boot();
    const cookie = await login();
    const csrf = await csrfFrom(cookie);
    await fetch(url("/chat"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, message: "hello", token: approverToken }),
      redirect: "manual",
    });
    await settle();
    const turn = store.recentChatTurns("alex", 1)[0];
    expect(turn?.unknownSpend).toBe(true);

    // Latched: the next ask refuses.
    const blocked = await fetch(url("/chat"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, message: "again", token: approverToken }),
      redirect: "manual",
    });
    expect(blocked.headers.get("location") ?? "").toContain("unknown");

    // The ceremony: read the terms, nonce + password, acknowledged.
    const screen = await (await fetch(url(`/chat/ack/${turn?.id}`), { headers: { cookie } })).text();
    expect(screen).toContain("worst case");
    const nonce = /name="nonce" value="([0-9a-f]{32})"/.exec(screen)?.[1] as string;
    const acked = await fetch(url(`/chat/ack/${turn?.id}`), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, nonce, token: approverToken }),
      redirect: "manual",
    });
    expect(acked.status).toBe(303);
    expect(store.getChatTurn(turn?.id as number)?.settledMicrousd).toBe(turn?.reservedMicrousd);
    fetcherResult = async () => anthropicWrapper(envelope("back"));
    const unblocked = await fetch(url("/chat"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, message: "back?", token: approverToken }),
      redirect: "manual",
    });
    expect(unblocked.headers.get("location")).toBe("/chat#latest");
  });


  test("Settings → Lead names the lead and edits its persona; the console's chat then says that name", async () => {
    await boot();
    const cookie = await login();
    const html = await (await fetch(url("/settings/lead"), { headers: { cookie } })).text();
    expect(html).toContain("Name your lead");
    expect(html).toContain('name="name" value="Lead"');
    expect(html).toContain("Be genuinely helpful, not performative.");
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(html)?.[1] as string;
    const save = (fields: Record<string, string>) => fetch(url("/settings/lead/identity"), { method: "POST", headers: { cookie, origin: base }, redirect: "manual", body: new URLSearchParams({ csrf, ...fields }) });
    // A name that isn't plain words is refused and nothing is saved.
    const refused = await save({ name: "<b>Maya</b>", persona: "x" });
    expect(refused.headers.get("location")).toContain("said=");
    expect(store.leadConfig("alex")).toBeNull();
    const saved = await save({ name: "Maya", persona: "Dry humour. Keep it short." });
    expect(saved.status).toBe(303);
    expect(saved.headers.get("location")).toBe("/settings/lead?saved=1");
    expect(store.leadConfig("alex")).toEqual({ name: "Maya", persona: "Dry humour. Keep it short." });
    const again = await (await fetch(url("/settings/lead?saved=1"), { headers: { cookie } })).text();
    expect(again).toContain('name="name" value="Maya"');
    expect(again).toContain("Saved.");
    const workspace = await (await fetch(url("/chat?format=workspace"), { headers: { cookie } })).json() as { leadName?: string };
    expect(workspace.leadName).toBe("Maya");
  });

  test("c1: Settings → Lead edits what your lead knows about you, one line each, and refuses a note that is too long", async () => {
    await boot();
    const cookie = await login();
    const html = await (await fetch(url("/settings/lead"), { headers: { cookie } })).text();
    expect(html).toContain("What your lead knows about you");
    expect(html).toContain('action="/settings/lead/about"');
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(html)?.[1] as string;
    const save = (about: string) => fetch(url("/settings/lead/about"), { method: "POST", headers: { cookie, origin: base }, redirect: "manual", body: new URLSearchParams({ csrf, about }) });
    const refused = await save(Array.from({ length: 21 }, (_, index) => `Line ${index}`).join("\n"));
    expect(decodeURIComponent(refused.headers.get("location") ?? "")).toContain("Keep it to 20 lines.");
    expect(store.leadAbout("alex")).toEqual([]);
    const saved = await save("Keep copy terse.\n\nI test changes myself.\n");
    expect(saved.headers.get("location")).toBe("/settings/lead?saved=about");
    expect(store.leadAbout("alex")).toEqual(["Keep copy terse.", "I test changes myself."]);
    // Saving the name and persona keeps the note.
    await fetch(url("/settings/lead/identity"), { method: "POST", headers: { cookie, origin: base }, redirect: "manual", body: new URLSearchParams({ csrf, name: "Maya", persona: "Short." }) });
    expect(store.leadAbout("alex")).toEqual(["Keep copy terse.", "I test changes myself."]);
    const again = await (await fetch(url("/settings/lead?saved=about"), { headers: { cookie } })).text();
    expect(again).toContain(">Keep copy terse.\nI test changes myself.</textarea>");
  });

  test("chat is configurable from the console itself — password-gated, key stays environment-only", async () => {
    store.clearChatConfig();
    await boot();
    const cookie = await login();
    const html = await (await fetch(url("/settings/lead"), { headers: { cookie } })).text();
    // The setup form is in Settings → Lead (Advanced), and it says where the key lives.
    expect(html).toContain('action="/chat/config"');
    expect(html).toContain("never INTO the database");
    expect(html).toContain("claude-sonnet-5");
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(html)?.[1] as string;

    // Wrong password: nothing written.
    const refused = await fetch(url("/chat/config"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, provider: "anthropic-api", model: "claude-sonnet-5", "weekly-usd": "10", token: "wrong" }),
      redirect: "manual",
    });
    expect(refused.headers.get("location") ?? "").toContain("password");
    expect(store.getChatConfig()).toBeNull();

    // Unpriced model: refused with the reason.
    const unpriced = await fetch(url("/chat/config"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, provider: "anthropic-api", model: "gpt-99", "weekly-usd": "10", token: approverToken }),
      redirect: "manual",
    });
    expect(unpriced.headers.get("location") ?? "").toContain("pinned");
    expect(store.getChatConfig()).toBeNull();

    // The real thing: written whole, audited under the session's name.
    const set = await fetch(url("/chat/config"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, provider: "anthropic-api", model: "claude-sonnet-5", "weekly-usd": "12.50", "daily-turns": "25", token: approverToken }),
      redirect: "manual",
    });
    expect(set.status).toBe(303);
    expect(store.getChatConfig()).toMatchObject({
      provider: "anthropic-api",
      model: "claude-sonnet-5",
      dailyTurns: 25,
      weeklyCeilingMicrousd: 12_500_000,
      updatedBy: "alex",
    });
    // And chat now answers on this very page.
    const on = await (await fetch(url("/chat"), { headers: { cookie } })).text();
    expect(on).toContain('<details class="chat-limits"><summary>Model &amp; limits');

    // Off again — password too.
    const off = await fetch(url("/chat/config"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, off: "1", token: approverToken }),
      redirect: "manual",
    });
    expect(off.status).toBe(303);
    expect(store.getChatConfig()).toBeNull();
  });


  test("key onboarding lives in the UI: pasted once, stored 0600, never echoed, env wins, forgettable", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "standing-orders-chat-cfg-"));
    try {
      store.clearChatConfig();
      await boot({ chatEnv: {}, configDir });
      const cookie = await login();
      let html = await (await fetch(url("/settings/lead"), { headers: { cookie } })).text();
      expect(html).toContain("none yet");
      const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(html)?.[1] as string;

      // A password pasted as a "key" is refused loudly, nothing stored.
      const badKey = await fetch(url("/chat/config"), {
        method: "POST",
        headers: { cookie, origin: base },
        body: new URLSearchParams({ csrf, provider: "anthropic-api", model: "claude-sonnet-5", "weekly-usd": "5", key: "hunter2", token: approverToken }),
        redirect: "manual",
      });
      expect(decodeURIComponent(badKey.headers.get("location") ?? "")).toContain("does not look like an API key");
      expect(existsSync(join(configDir, "chat-key-anthropic-api"))).toBe(false);

      // The real thing: config + key in one authenticated save.
      const secret = "sk-ant-" + "a".repeat(40);
      const set = await fetch(url("/chat/config"), {
        method: "POST",
        headers: { cookie, origin: base },
        body: new URLSearchParams({ csrf, provider: "anthropic-api", model: "claude-sonnet-5", "weekly-usd": "5", key: secret, token: approverToken }),
        redirect: "manual",
      });
      expect(set.status).toBe(303);
      const keyFile = join(configDir, "chat-key-anthropic-api");
      expect(readFileSync(keyFile, "utf8").trim()).toBe(secret);
      expect((statSync(keyFile).mode & 0o777).toString(8)).toBe("600");

      // Chat is ON with the stored key; the page shows a tail, never the key.
      html = await (await fetch(url("/chat"), { headers: { cookie } })).text();
      expect(html).toContain('<details class="chat-limits"><summary>Model &amp; limits');
      expect(html).not.toContain(secret);
      const lead = await (await fetch(url("/settings/lead"), { headers: { cookie } })).text();
      expect(lead).toContain("stored");
      expect(lead).not.toContain(secret);
      // The database carries no key anywhere.
      expect(store.installationFact("chat-key")).toBeNull();

      // Forgetting removes the file (password again).
      const forget = await fetch(url("/chat/config"), {
        method: "POST",
        headers: { cookie, origin: base },
        body: new URLSearchParams({ csrf, "forget-key": "anthropic-api", token: approverToken }),
        redirect: "manual",
      });
      expect(forget.status).toBe(303);
      expect(existsSync(keyFile)).toBe(false);
      html = await (await fetch(url("/chat"), { headers: { cookie } })).text();
      expect(html).toContain("no anthropic-api key");
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("an environment key always wins over a stored one", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "standing-orders-chat-cfg2-"));
    try {
      writeFileSync(join(configDir, "chat-key-anthropic-api"), "sk-ant-" + "b".repeat(40), { mode: 0o600 });
      await boot({ chatEnv: { ANTHROPIC_API_KEY: "sk-test-key" }, configDir });
      const cookie = await login();
      const html = await (await fetch(url("/settings/lead"), { headers: { cookie } })).text();
      expect(html).toContain("from the environment");
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("Settings → Lead lists the lead's open promises, and the owner cancels one", async () => {
    await boot();
    const cookie = await login();
    const thread = store.openMateThread("alex", "ceiling", T0).thread.id;
    const { recordCommitment, getCommitment } = await import("./lead-commitments.js");
    const made = recordCommitment(store, { owner: "alex", repo: null, thread, turn: null, what: "Tell you when the release check passes",
      condition: { kind: "time", at: new Date(T0.getTime() + 3_600_000).toISOString() } }, T0);
    let html = await (await fetch(url("/settings/lead"), { headers: { cookie } })).text();
    expect(html).toContain("<h2>Promises</h2>");
    expect(html).toContain("Tell you when the release check passes");
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(html)?.[1] as string;
    const cancelled = await fetch(url("/settings/lead/promise/cancel"), { method: "POST", headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, promise: String(made.id) }), redirect: "manual" });
    expect(cancelled.status).toBe(303);
    expect(getCommitment(store, made.id)).toMatchObject({ state: "cancelled", closedBy: "alex" });
    html = await (await fetch(url("/settings/lead"), { headers: { cookie } })).text();
    expect(html).not.toContain("<h2>Promises</h2>");
  });

  test("bearer callers are refused — drafts have nowhere to live", async () => {
    await boot();
    const bearer = await fetch(url("/chat"), { headers: { authorization: `Bearer alex:${approverToken}` } });
    expect([401, 403]).toContain(bearer.status);
  });
});

describe("the mate's thread (mate arc, slice 2): one ceremony, then a conversation whose acts are cards", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let approverToken: string;
  let evidenceRoot: string;
  let repoDir: string;
  let script: (() => Response)[];
  let subscriptionAnswers: MateProviderAnswer[];
  /** What the scripted subscription runner was handed (package 2): the
   * exact history — with its task context — the provider would see. */
  let subscriptionRequests: { history: { role: string; text?: string }[] }[];
  let clockNow: Date;

  const url = (path: string) => `${base}${path}`;
  const T0 = new Date("2026-09-02T12:00:00.000Z");
  type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
  const answer = (blocks: Block[]) =>
    new Response(JSON.stringify({ type: "message", content: blocks, usage: { input_tokens: 100, output_tokens: 20 } }), { status: 200, headers: { "content-type": "application/json" } });

  const login = async (): Promise<string> => {
    const response = await fetch(url("/login"), { method: "POST", body: new URLSearchParams({ name: "alex", token: approverToken }), redirect: "manual" });
    expect(response.status).toBe(303);
    return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
  };
  const page = async (cookie: string): Promise<string> => (await fetch(url("/chat"), { headers: { cookie } })).text();
  const csrfFrom = (html: string): string => {
    const match = /name="csrf" value="([0-9a-f]{64})"/.exec(html);
    if (match === null) throw new Error("no csrf on /chat");
    return match[1] as string;
  };
  const post = (cookie: string, path: string, fields: Record<string, string>) =>
    fetch(url(path), { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams(fields), redirect: "manual" });
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      if (store.liveMateTurnFor("alex") === null) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("the mate turn never settled");
  };
  const mint = async (cookie: string, ceilingUsd = "50"): Promise<string> => {
    const csrf = csrfFrom(await page(cookie));
    const minted = await post(cookie, "/chat/mate/mint", { csrf, "ceiling-usd": ceilingUsd, token: approverToken });
    expect(minted.status).toBe(303);
    expect(minted.headers.get("location")).toBe("/chat");
    return csrf;
  };

  beforeEach(async () => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", T0); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", T0);
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-mate-ev-"));
    repoDir = realpathSync(mkdtempSync(join(tmpdir(), "standing-orders-mate-repo-")));
    clockNow = T0;
    script = [];
    subscriptionAnswers = [];
    subscriptionRequests = [];
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;
    store.setChatConfig({ provider: "anthropic-api", model: "claude-sonnet-5", dailyTurns: 50, weeklyCeilingMicrousd: 100_000_000, priceInMicrousd: 3, priceOutMicrousd: 15 }, "alex", T0);
    for (const id of ["a", "b"]) {
      const made = store.createConsoleTask({ id, title: `task ${id}`, repo: repoDir, goal: `do ${id}`, acceptance: [{ id: "c1", statement: `${id} is done.`, evidence: ["manual-review"] }], filedVia: "cli" }, T0);
      if (!made.ok) throw new Error(made.reason);
    }
    server = createDecisionServer({
      store,
      evidenceRoot,
      clock: () => clockNow,
      repo: repoDir,
      chatEnv: { ANTHROPIC_API_KEY: "sk-test-key" },
      chatFetcher: (async () => {
        const next = script.shift();
        if (next === undefined) throw new Error("the script ran out");
        return next();
      }) as typeof fetch,
      subscriptionChatRunner: async request => {
        subscriptionRequests.push(request as unknown as { history: { role: string; text?: string }[] });
        const next = subscriptionAnswers.shift();
        if (next === undefined) throw new Error("the subscription script ran out");
        return { ok: true, answer: next };
      },
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(evidenceRoot, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  });

  /** The status poll's JSON (package 2). */
  const status = async (cookie: string, query = ""): Promise<Record<string, unknown>> => (await fetch(url(`/chat/mate/status${query}`), { headers: { cookie } })).json() as Promise<Record<string, unknown>>;
  /** The enhanced send: the same endpoint and fields, asking for JSON. */
  const sendJson = (cookie: string, fields: Record<string, string>) =>
    fetch(url("/chat"), { method: "POST", headers: { cookie, origin: base, accept: "application/json" }, body: new URLSearchParams(fields), redirect: "manual" });

  test('team cards reuse the review projection, retain CLI summaries, and confirm or dismiss through the existing door', async () => {
    const cookie = await login(), csrf = csrfFrom(await page(cookie));
    const actor = { name: 'alex', generation: store.accountOf('alex')!.generation };
    const domain = new TeamLeads(store, () => [repoDir]);
    const team = async (operation: TeamOperation, args: Record<string, unknown>): Promise<TeamResponse> => {
      const response = await fetch(url('/api/team'), { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ operation, args }) });
      expect(response.status).toBe(200);
      return response.json() as Promise<TeamResponse>;
    };
    const createdLead = await team('create-lead', { name: 'Launch lead', projects: [repoDir] });
    const leadId = (createdLead.result as { leadId: string }).leadId;
    const created = await team('create-conversation', { leadId, title: 'Launch', visibility: 'team', projects: [repoDir] });
    const conversationId = created.snapshot!.selected!.id, thread = created.snapshot!.selected!.threadId;
    await team('authorize', { conversationId, termsDigest: created.snapshot!.chatAuthorization!.termsDigest, ceilingUsd: created.snapshot!.chatAuthorization!.conversationCeilingUsd });
    const session = store.teamMateSession('alex', thread)!;
    const openTurn = () => {
      const opened = store.openMateTurn({ approver: 'alex', session: session.id, thread, credentialKey: session.credentialKey, reservedMicrousd: 0, dailyTurns: 50, weeklyCeilingMicrousd: 100_000_000, deadlineMs: 60_000 }, T0);
      if (!opened.ok) throw Error(opened.reason);
      const started = store.startMateTurn(opened.id, T0);
      if (!started.ok) throw Error('start');
      return { id: opened.id, generation: started.generation };
    };
    // Existing rows need no migration or new linkage: the saved turn is enough.
    const turn = openTurn();
    const draft = (kind: 'hold' | 'unhold', task: string) => store.draftMateProposal({ thread, turn: turn.id, kind, payload: { task, reason: 'Wait for the audit.', sawHold: null }, ceilingDigest: session.ceilingDigest }, T0);
    const held = draft('hold', 'a'), dismissed = draft('hold', 'b'), unauthorized = draft('hold', 'b');
    expect(store.finalizeMateTurn(turn.id, turn.generation, { state: 'answered', settledMicrousd: 0, tokensIn: 0, tokensOut: 0, message: { text: 'Here are the proposed holds.', activity: '' } }, T0)).toBe(true);
    const read = async () => (await team('show', { conversationId })).snapshot!;
    let snapshot = await read();
    expect(snapshot.proposals).toMatchObject([{ id: held, turnId: turn.id, state: 'pending', card: { kind: 'hold', state: 'pending', primary: { kind: 'confirm', label: 'Hold' }, dismissable: true } }, { id: dismissed }, { id: unauthorized }]);
    const inline = snapshot.proposals![0]!.card!;
    const review = async () => (await fetch(url(snapshot.proposals![0]!.href), { headers: { cookie } })).text();
    expect(await review()).toContain(inline.body);
    expect(await review()).toContain(`action="/chat/proposal/${held}/confirm"`);
    const workspace = await (await fetch(url(`/chat?conversation=${conversationId}&format=workspace`), { headers: { cookie } })).json();
    expect(workspace.team.proposals).toEqual(snapshot.proposals);
    const cli = await (await fetch(url(`/api/team?conversation=${conversationId}`), { headers: { authorization: `Bearer alex:${approverToken}` } })).json() as TeamResponse;
    expect(cli.snapshot!.proposals![0]).toEqual({ id: held, turnId: turn.id, title: 'Review hold', state: 'pending', href: snapshot.proposals![0]!.href });

    // Provider terms changed after rendering: inline, Review and direct POST agree.
    const config = store.getChatConfig()!;
    store.setChatConfig({ ...config, dailyTurns: config.dailyTurns + 1 }, 'alex', T0);
    snapshot = await read();
    expect(snapshot.proposals![0]!.card).toMatchObject({ primary: null, dismissable: false, note: 'Enable chat in this conversation before acting on a proposal.' });
    expect(await review()).toContain(snapshot.proposals![0]!.card!.note!);
    expect(await review()).not.toContain(`action="/chat/proposal/${held}/confirm"`);
    const before = store.getMateProposal(held);
    const stale = await fetch(url(`/chat/proposal/${held}/confirm`), { method: 'POST', headers: { cookie, origin: base, accept: 'application/json' }, body: new URLSearchParams({ csrf }), redirect: 'manual' });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ ok: false, said: snapshot.proposals![0]!.card!.note, taskId: null });
    expect(store.getMateProposal(held)).toEqual(before);
    expect(store.handle.prepare('SELECT 1 FROM hold').get()).toBeUndefined();
    store.setChatConfig(config, 'alex', T0);

    store.handle.prepare("UPDATE team_participant SET role='viewer' WHERE conversation=? AND account='alex'").run(conversationId);
    snapshot = await read();
    expect(snapshot.proposals![0]!.card).toMatchObject({ primary: null, dismissable: false, note: 'An authorized contributor can act on this proposal.' });
    expect(await review()).toContain(snapshot.proposals![0]!.card!.note!);
    store.handle.prepare("UPDATE team_participant SET role='manager' WHERE conversation=? AND account='alex'").run(conversationId);

    domain.execute(actor, { operation: 'send', args: { conversationId, requestId: 'running-turn', text: 'Check the launch plan.' } }, T0);
    const claim = domain.claimNext('fixture', T0)!;
    const running = openTurn();
    expect(domain.bindTurn(claim, running.id)).toBe(true);
    const own = store.draftMateProposal({ thread, turn: running.id, kind: 'hold', payload: { task: 'b', reason: 'Its own turn.', sawHold: null }, ceilingDigest: session.ceilingDigest }, T0);
    snapshot = await read();
    expect(snapshot.proposals![0]!.card).toMatchObject({ primary: null, dismissable: false, note: 'Available when the current reply finishes.' });
    expect(await review()).toContain('Available when the current reply finishes.');
    const decide = (id: number, verb: 'confirm' | 'dismiss', token = csrf) => fetch(url(`/chat/proposal/${id}/${verb}`), { method: 'POST', headers: { cookie, origin: base, accept: 'application/json' }, body: new URLSearchParams({ csrf: token }), redirect: 'manual' });
    const holdOf = (task: string) => store.handle.prepare('SELECT reason FROM hold WHERE task_ref=?').get(store.lookupRef(task)!.id);
    // A direct POST mid-turn gets the card's words and changes nothing; dismissing stays available.
    let refused = await decide(held, 'confirm');
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ ok: false, said: snapshot.proposals![0]!.card!.note, taskId: null });
    expect(store.getMateProposal(held)?.state).toBe('pending');
    expect(holdOf('a')).toBeUndefined();
    expect(await (await decide(dismissed, 'dismiss')).json()).toMatchObject({ ok: true });
    // The proposal's own turn has finished while its message row still says running: not a live turn.
    store.finalizeMateTurn(running.id, running.generation, { state: 'answered', settledMicrousd: 0, tokensIn: 0, tokensOut: 0, message: { text: 'The plan is saved.', activity: '' } }, T0);
    expect(store.handle.prepare('SELECT status FROM team_message WHERE turn_id=?').get(running.id)).toMatchObject({ status: 'running' });
    expect((await read()).proposals!.find(one => one.id === own)!.card).toMatchObject({ primary: { kind: 'confirm' }, dismissable: true });
    expect(await (await decide(own, 'confirm')).json()).toMatchObject({ ok: true });
    expect(holdOf('b')).toMatchObject({ reason: 'Its own turn.' });
    domain.finish(claim, { status: 'answered', turnId: running.id }, T0);

    expect((await decide(held, 'confirm', 'wrong')).status).toBe(403);
    expect((await read()).proposals![0]!.state).toBe('pending');
    expect(await (await decide(held, 'confirm')).json()).toMatchObject({ ok: true });
    expect(holdOf('a')).toMatchObject({ reason: 'Wait for the audit.' });
    expect((await read()).proposals![0]!.card).toMatchObject({ state: 'confirmed', primary: null, dismissable: false });
    expect((await read()).proposals![1]!.card).toMatchObject({ state: 'dismissed', primary: null, dismissable: false, note: 'Dismissed.' });
    expect(await (await decide(dismissed, 'dismiss')).json()).toMatchObject({ ok: false });

    store.handle.prepare('UPDATE mate_session SET ended_at=? WHERE id=?').run(T0.toISOString(), session.id);
    snapshot = await read();
    expect(snapshot.proposals![2]!.card).toMatchObject({ primary: null, dismissable: false, note: 'Enable chat in this conversation before acting on a proposal.' });
    expect(await (await fetch(url(snapshot.proposals![2]!.href), { headers: { cookie } })).text()).toContain(snapshot.proposals![2]!.card!.note!);
    // Without chat authorization a direct POST is refused with the same words.
    refused = await decide(unauthorized, 'confirm');
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ ok: false, said: snapshot.proposals![2]!.card!.note, taskId: null });
    expect(store.getMateProposal(unauthorized)?.state).toBe('pending');
    expect(holdOf('b')).toMatchObject({ reason: 'Its own turn.' });
  });

  test('React workspace reads the saved conversation and receipt without replaying work', async () => {
    const cookie = await login(); const csrf = await mint(cookie);
    const initial = await fetch(url('/chat'), { headers: { cookie } });
    const initialHtml = await initial.text();
    const module = /<script type="module" src="(\/assets\/workspace.js)" nonce="([^"]+)"><\/script>/.exec(initialHtml);
    expect(module).not.toBeNull();
    expect(initial.headers.get('content-security-policy')).toContain(`script-src 'nonce-${module![2]}'`);
    expect(initial.headers.get('content-security-policy')).not.toContain("script-src 'self'");
    expect(initialHtml).toContain('standing-orders:workspace-rendered');
    expect((await fetch(url(module![1]!))).headers.get('content-type')).toContain('javascript');
    expect((await fetch(url('/assets/workspace.css'), { method: 'HEAD' })).status).toBe(200);
    expect((await fetch(url('/assets/unknown.js'), { redirect: 'manual' })).status).not.toBe(200);
    const read = async (query = '') => {
      const response = await fetch(url(`/chat?format=workspace${query}`), { headers: { cookie } });
      expect(response.headers.get('content-type')).toContain('application/json');
      return response.json() as Promise<import('./browser-workspace.js').BrowserWorkspace>;
    };
    const before = await read();
    expect(before).toMatchObject({ version: 1, user: 'alex', csrf, conversation: { messages: [], taskId: null } });
    expect(before.crew.map(one => one.id).sort()).toEqual(['a', 'b']);
    expect(before.crew.every(one => one.href.startsWith('/chat?task='))).toBe(true);
    const request = before.conversation!.requestId;
    script.push(() => answer([{ type: 'text', text: 'Inspect <script>unsafe</script> as text.' }]));
    expect((await sendJson(cookie, { csrf, message: 'Summarize current work', request, 'request-session': String(before.conversation!.sessionId) })).status).toBe(202);
    await settle();
    const after = await read(`&request=${request}`);
    expect(after.receipt).toEqual({ request, received: true });
    expect(after.conversation!.messages.map(one => one.role)).toEqual(['operator', 'assistant']);
    expect(after.conversation!.messages.at(-1)!.html).toContain('&lt;script&gt;unsafe&lt;/script&gt;');
    await read(`&request=${request}`);
    expect(store.recentMateTurns('alex', 10)).toHaveLength(1);
    expect((await fetch(url('/chat?format=workspace'), { headers: { authorization: `Bearer alex:${approverToken}` } })).status).toBe(403);
    expect((await fetch(url('/chat?format=workspace'), { redirect: 'manual' })).status).toBe(303);
  });

  test("a reply that runs past its deadline after proposing: the thread says so once, keeps the proposal's card, and the next message answers", async () => {
    const cookie = await login(); const csrf = await mint(cookie);
    const read = async () => (await (await fetch(url('/chat?format=workspace'), { headers: { cookie } })).json()) as import('./browser-workspace.js').BrowserWorkspace;
    // The proposing step comes back as the turn's two minutes run out (release check 2438); its final reply never starts.
    script.push(() => {
      clockNow = new Date(T0.getTime() + TURN_WALL_CLOCK_MS + 1_000);
      return answer([{ type: 'tool_use', id: 'h1', name: 'propose_hold', input: { task: 'a', reason: 'not this week' } }]);
    });
    expect((await sendJson(cookie, { csrf, message: 'Hold task a for now' })).status).toBe(202);
    await settle();
    // Said once: in the thread, not again as a one-off warning above it, and still there after a refresh.
    for (let view = 0; view < 2; view++) {
      const html = await page(cookie);
      expect(html.match(/data-message-role="assistant"[^>]*><div class="chat-copy"><p>The reply took too long/g)).toHaveLength(1);
      expect(html).not.toContain('<div class="problem"');
    }
    const proposal = store.listMateProposals(store.liveMateThreadFor('alex')!.id)[0]!;
    expect(proposal).toMatchObject({ kind: 'hold', state: 'pending' });
    const stopped = (await read()).conversation!.messages;
    expect(stopped.map(one => one.role)).toEqual(['operator', 'assistant']);
    expect(stopped[1]!.text).toBe(mateTimeoutNotice(true));
    expect(stopped.map(one => one.cards.length)).toEqual([0, 1]);
    expect(stopped[1]!.cardsHtml).toContain(`/chat/proposal/${proposal.id}/confirm`);
    script.push(() => answer([{ type: 'text', text: 'Nothing else needs you.' }]));
    expect((await sendJson(cookie, { csrf, message: 'Anything else?' })).status).toBe(202);
    await settle();
    expect((await read()).conversation!.messages.at(-1)).toMatchObject({ role: 'assistant', text: 'Nothing else needs you.' });
  });

  test("the lead's question shows its options as buttons that send themselves, plus Something else, until the owner answers (ask_owner)", async () => {
    const cookie = await login(); const csrf = await mint(cookie);
    const read = async () => (await (await fetch(url('/chat?format=workspace'), { headers: { cookie } })).json()) as import('./browser-workspace.js').BrowserWorkspace;
    script.push(
      () => answer([{ type: 'tool_use', id: 'q1', name: 'ask_owner', input: { question: 'Ship today or Friday?', options: ['Today', 'Friday'] } }]),
      () => answer([{ type: 'text', text: 'It depends on one thing.' }]),
    );
    expect((await sendJson(cookie, { csrf, message: 'When should the release go out?' })).status).toBe(202);
    await settle();
    const asked = (await read()).conversation!.messages.at(-1)!.html;
    expect(asked).toContain('It depends on one thing.');
    expect(asked).toContain('<strong>Ship today or Friday?</strong>');
    expect([...asked.matchAll(/<form method="post" action="\/chat"[^>]*>.*?name="message" value="([^"]+)"/g)].map(one => one[1])).toEqual(['Today', 'Friday']);
    expect(asked).toContain('<label for="lead-message" class="so-suggestion so-owner-ask-other">Something else</label>');
    // A tap is the same POST as a typed message; once answered, the buttons are gone.
    script.push(() => answer([{ type: 'text', text: 'Friday it is.' }]));
    expect((await sendJson(cookie, { csrf, message: 'Friday' })).status).toBe(202);
    await settle();
    const after = (await read()).conversation!.messages;
    expect(after.map(one => one.text).slice(-2)).toEqual(['Friday', 'Friday it is.']);
    // The question stays readable above the answer; only its buttons are gone.
    expect(after.at(-3)!.html).toContain('<strong>Ship today or Friday?</strong>');
    expect(after.some(one => one.html.includes('name="message"') || one.html.includes('Something else'))).toBe(false);
  });

  test('React projects page lists the same projects as compact rows', async () => {
    const cookie = await login();
    const response = await fetch(url('/projects?format=workspace'), { headers: { cookie } });
    expect(response.status).toBe(200);
    const data = await response.json() as import('./browser-workspace.js').BrowserWorkspace;
    expect(data.view?.kind).toBe('projects');
    const projects = data.view as import('./browser-workspace.js').BrowserProjectsView;
    const rows = [...projects.recent, ...projects.available];
    const row = rows.find(one => one.path === repoDir);
    expect(row).toMatchObject({ path: repoDir, knowledgeHref: `/settings/knowledge?repo=${encodeURIComponent(repoDir)}` });
    expect(row!.peek?.find(chip => chip.label === '2 queued')).toMatchObject({ href: '/board?view=order', tone: 'neutral' });
    expect(projects).toMatchObject({ choosing: false, problem: null });
    // The add forms are the fallback's own markup.
    expect(data.pageHtml).toContain(projects.add.html);
    const choosing = await (await fetch(url('/projects?return=%2Ftasks%2Fnew&format=workspace'), { headers: { cookie } })).json() as import('./browser-workspace.js').BrowserWorkspace;
    expect(choosing.view).toMatchObject({ kind: 'projects', choosing: true, returnTo: '/tasks/new' });
  });

  test('chat streaming: a running turn streams its steps until done; with nothing running the stream closes at once', async () => {
    const cookie = await login(); const csrf = await mint(cookie);
    const idle = await fetch(url('/chat/stream'), { headers: { cookie } });
    expect(idle.headers.get('content-type')).toBe('text/event-stream');
    expect(idle.headers.get('cache-control')).toBe('no-store');
    expect(await idle.text()).toBe('event: turn\ndata: {"steps":[],"done":true,"ok":false}\n\n');
    // A turn waiting on the provider: its step shows, then done once it answers.
    let finish!: (value: Response) => void;
    script.push(() => new Promise<Response>(resolve => { finish = resolve; }) as unknown as Response);
    expect((await sendJson(cookie, { csrf, task: 'a', message: 'Where is this?', request: 'c'.repeat(32), 'request-session': '1' })).status).toBe(202);
    const live = await fetch(url('/chat/stream?task=a'), { headers: { cookie } });
    const reader = live.body!.getReader();
    const decoder = new TextDecoder();
    let body = '';
    while (!body.includes('"steps":[{')) body += decoder.decode((await reader.read()).value);
    expect(body).toContain('"done":false');
    finish(answer([{ type: 'text', text: 'Here.' }]));
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) body += decoder.decode(chunk.value);
    expect(body.trimEnd().split('\n\n').at(-1)).toContain('"done":true,"ok":true');
    await settle();
    // Another thread has nothing running; an unknown task or a signed-out caller is refused.
    expect(await (await fetch(url('/chat/stream'), { headers: { cookie } })).text()).toContain('"done":true');
    expect((await fetch(url('/chat/stream?task=nope'), { headers: { cookie } })).status).toBe(404);
    expect((await fetch(url('/chat/stream'), { redirect: 'manual' })).status).not.toBe(200);
  });

  test('chat streaming preserves each tool outcome, including failure in an answered turn, alongside legacy labels', async () => {
    const cookie = await login(); const csrf = await mint(cookie);
    let finish!: (value: Response) => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    script.push(
      () => answer([
        { type: 'tool_use', id: 'f1', name: 'get_flows', input: { flow: 999 } },
        { type: 'tool_use', id: 'f2', name: 'get_flows', input: {} },
      ]),
      () => new Promise<Response>(resolve => { finish = resolve; entered(); }) as unknown as Response,
    );
    expect((await sendJson(cookie, { csrf, message: 'Read the flows.', request: 'd'.repeat(32), 'request-session': '1' })).status).toBe(202);
    await waiting;
    const response = await fetch(url('/chat/stream'), { headers: { cookie } });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let body = '';
    try {
      while (!body.includes('\n\n')) body += decoder.decode((await reader.read()).value);
      const snapshot = JSON.parse(body.split('data: ')[1]!.split('\n\n')[0]!);
      expect(snapshot.done).toBe(false);
      expect(snapshot.steps[0].tools).toEqual(['Reading the flows', 'Reading the flows']);
      expect(snapshot.steps[0].toolCalls).toEqual([
        { id: expect.any(String), label: 'Reading the flows', state: 'failed', reason: 'No such flow in your projects.' },
        { id: expect.any(String), label: 'Reading the flows', state: 'succeeded' },
      ]);
      expect(snapshot.steps[0].toolCalls[0].id).not.toBe(snapshot.steps[0].toolCalls[1].id);
    } finally {
      finish(answer([{ type: 'text', text: 'That flow is unavailable. I checked the list.' }]));
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) body += decoder.decode(chunk.value);
    }
    const last = JSON.parse(body.trimEnd().split('\n\n').at(-1)!.split('data: ')[1]!);
    expect(last).toMatchObject({ done: true, ok: true, steps: [{ toolCalls: [{ state: 'failed', reason: 'No such flow in your projects.' }, { state: 'succeeded' }] }, { tools: [] }] });
    await settle();
  });

  test('v77: task and project pages dock their own threads, and the chat list names them', async () => {
    const cookie = await login(); const csrf = await mint(cookie);
    type Workspace = import('./browser-workspace.js').BrowserWorkspace;
    // The task page docks task a's own conversation beside its view, and
    // drops its own Ask tab (the panel is the Ask view).
    const taskRead = await (await fetch(url('/t/a?format=workspace'), { headers: { cookie } })).json() as Workspace;
    expect(taskRead.view?.kind).toBe('task');
    expect(taskRead.conversation).toMatchObject({ taskId: 'a', messages: [] });
    expect((taskRead.view as import('./browser-workspace.js').BrowserTaskView).tabs).toEqual([]);
    // A project message lands in the project's thread, not the lead's.
    script.push(() => answer([{ type: 'text', text: 'Two tasks are queued here.' }]));
    const sent = await sendJson(cookie, { csrf, project: repoDir, message: 'What is queued?', request: 'a'.repeat(32), 'request-session': '1' });
    expect(sent.status).toBe(202);
    expect(await sent.json()).toMatchObject({ ok: true, project: repoDir });
    await settle();
    const projectThread = store.liveMateThreadFor('alex', { kind: 'project', key: repoDir })!;
    expect(store.listMateMessages(projectThread.id, 10).map(one => one.text)).toEqual(['What is queued?', 'Two tasks are queued here.']);
    const lead = store.liveMateThreadFor('alex');
    expect(lead === null ? [] : store.listMateMessages(lead.id, 10)).toEqual([]);
    // The project's Tasks page docks it, and the chat list names it.
    const projectRead = await (await fetch(url(`/work?project=${encodeURIComponent(repoDir)}&format=workspace`), { headers: { cookie } })).json() as Workspace;
    expect(projectRead.view?.kind).toBe('tasks');
    expect(projectRead.conversation).toMatchObject({ project: repoDir, taskId: null });
    expect(projectRead.conversation!.messages.map(one => one.text)).toEqual(['What is queued?', 'Two tasks are queued here.']);
    expect(projectRead.chats).toEqual([expect.objectContaining({ kind: 'project', href: `/chat?project=${encodeURIComponent(repoDir)}`, active: false })]);
    // The project's own chat page speaks in the same thread.
    const projectChat = await (await fetch(url(`/chat?project=${encodeURIComponent(repoDir)}&format=workspace`), { headers: { cookie } })).json() as Workspace;
    expect(projectChat.conversation!.messages).toHaveLength(2);
    expect(projectChat.chats![0]).toMatchObject({ active: true });
    // A project outside this console is refused, on the page and on send.
    expect((await fetch(url('/chat?project=%2Fnot%2Fhere'), { headers: { cookie }, redirect: 'manual' })).status).toBe(404);
    expect((await sendJson(cookie, { csrf, project: '/not/here', message: 'Hi', request: 'b'.repeat(32), 'request-session': '1' })).status).toBe(404);
  });

  test('React task page frames the same parts as the HTML fallback', async () => {
    const cookie = await login();
    const response = await fetch(url('/t/a?format=workspace'), { headers: { cookie } });
    expect(response.status).toBe(200);
    const data = await response.json() as import('./browser-workspace.js').BrowserWorkspace;
    // The scope awaits a signature, so the page is sensitive (no chrome
    // scripts); the rebuilt view still frames the exact ceremony.
    expect(data.sensitive).toBe(true);
    expect(data.view?.kind).toBe('task');
    const task = data.view as import('./browser-workspace.js').BrowserTaskView;
    expect(task).toMatchObject({ id: 'a', title: 'task a', tabs: [{ label: 'Overview', href: '/t/a', active: true }, { label: 'Ask', active: false }] });
    expect(task.status).toMatchObject({ label: 'Needs you', tone: 'attention', action: null });
    expect(task.approval).toContain('id="approve"');
    expect(task.approval).toContain('type="password"');
    expect(task.facts.find(fact => fact.label === 'Scope')?.parts).toEqual(['not approved']);
    expect(task.sections.map(one => one.id)).toContain('scope');
    expect(task.manage.map(one => one.id)).toContain('task-diagnostics');
    expect(task.cancel).toMatchObject({ open: false });
    expect(task.cancel!.html).toContain('action="/t/a/cancel"');
    // Every fold body is the server's own markup, byte for byte.
    for (const one of [...task.sections, ...task.manage]) expect(data.pageHtml).toContain(one.html);
    expect(data.pageHtml).toContain(task.approval);
  });

  test('React project links narrow reads without changing the selected project', async () => {
    const cookie = await login();
    const target = `/work?project=${encodeURIComponent(repoDir)}&format=workspace`;
    const response = await fetch(url(target), { headers: { cookie } });
    expect(response.status).toBe(200);
    const data = await response.json() as import('./browser-workspace.js').BrowserWorkspace;
    expect(data.crew.map(one => one.id).sort()).toEqual(['a', 'b']);
    expect(data.path).toBe(`/work?project=${encodeURIComponent(repoDir)}`);
    // The rebuilt Tasks view carries the same facts as the HTML fallback:
    // tabs keep the project filter, rows keep their ids and task links.
    expect(data.view?.kind).toBe('tasks');
    const tasksView = data.view as import('./browser-workspace.js').BrowserTasksView;
    expect(tasksView.tabs.map(tab => new URL(tab.href, base).searchParams.get('project'))).toEqual([repoDir, repoDir, repoDir, repoDir]);
    expect(tasksView.tabs.find(tab => tab.active)?.label).toBe('All');
    expect(tasksView.rows.map(row => row.id).sort()).toEqual(['a', 'b']);
    expect(tasksView.rows.every(row => row.href.startsWith('/t/'))).toBe(true);
    const window = new Window();
    try {
      window.document.body.innerHTML = data.pageHtml!;
      const views = [...window.document.querySelectorAll<HTMLAnchorElement>('.work-views a')]
        .map(link => new URL(link.getAttribute('href')!, base));
      expect(views.map(link => link.searchParams.get('view') ?? 'all')).toEqual(['all', 'needs-you', 'running', 'completed']);
      for (const link of views) {
        expect(link.pathname).toBe('/work');
        expect(link.searchParams.get('project')).toBe(repoDir);
      }
      const running = views.find(link => link.searchParams.get('view') === 'running')!;
      running.searchParams.set('format', 'workspace');
      const filteredResponse = await fetch(running, { headers: { cookie } });
      expect(filteredResponse.status).toBe(200);
      const filtered = await filteredResponse.json() as import('./browser-workspace.js').BrowserWorkspace;
      const filteredPath = new URL(filtered.path, base);
      expect(filteredPath.searchParams.get('project')).toBe(repoDir);
      expect(filteredPath.searchParams.get('view')).toBe('running');
      expect(filtered.crew.every(one => one.project === repoDir)).toBe(true);
      window.document.body.innerHTML = filtered.pageHtml!;
      expect(window.document.querySelector('[data-work-empty="running"]')).not.toBeNull();
      const allWork = window.document.querySelector<HTMLAnchorElement>('[data-work-empty="running"] a')!;
      expect(allWork.textContent).toBe('See all tasks →');
      const allPath = new URL(allWork.getAttribute('href')!, base);
      expect(allPath.pathname).toBe('/work');
      expect(allPath.searchParams.get('project')).toBe(repoDir);
      expect(allPath.searchParams.has('view')).toBe(false);
    } finally { await window.happyDOM.close(); }
    expect((await fetch(url('/work?project=%2Fforeign&format=workspace'), { headers: { cookie } })).status).toBe(404);
    expect((await fetch(url(`/work?project=${encodeURIComponent(repoDir)}&project=%2Fforeign&format=workspace`), { headers: { cookie } })).status).toBe(404);
  });

  test("automatic crew updates are explicit, scoped to this conversation, and pausable without a new thread", async () => {
    const cookie = await login(), before = await page(cookie);
    expect(before).toContain('aria-label="Project catch-up"');
    expect(before.indexOf('aria-label="Project catch-up"')).toBeLessThan(before.indexOf('class="card mate-mint"'));
    expect(before).toContain('name="follow" value="yes"');
    const csrf = await mint(cookie, "5"), thread = store.liveMateThreadFor("alex")!.id;
    expect(await page(cookie)).toContain("Enable updates");
    expect((await post(cookie, "/chat/mate/follow", { csrf: "wrong", enabled: "yes" })).status).toBe(403);
    expect((await post(cookie, "/chat/mate/follow", { csrf, enabled: "yes" })).status).toBe(303);
    expect(await page(cookie)).toContain("Pause updates");
    expect((await post(cookie, "/chat/mate/follow", { csrf, enabled: "no" })).status).toBe(303);
    expect(await page(cookie)).toContain("Enable updates");
    expect(store.liveMateThreadFor("alex")!.id).toBe(thread);
    expect(store.listMateMessages(thread, 10)).toHaveLength(0);
  });

  test("the mint card is the one password ceremony; the thread then takes messages without one", async () => {
    const cookie = await login();
    const before = await page(cookie);
    expect(before).toContain('action="/chat/mate/mint"');
    expect(before).not.toContain('class="thread"');
    const csrf = csrfFrom(before);
    expect(before).not.toContain('name="hours"');
    // The signed-in approver starts their own conversation without a second
    // password; a wrong password, when one is sent, is still refused.
    const wrong = await post(cookie, "/chat/mate/mint", { csrf, "ceiling-usd": "5", token: "not-the-password" });
    expect(decodeURIComponent(wrong.headers.get("location") ?? "")).toContain("That password did not match.");
    expect(store.activeMateSession("alex")).toBeNull();
    const badTerms = await post(cookie, "/chat/mate/mint", { csrf, "ceiling-usd": "0", token: approverToken });
    expect(badTerms.headers.get("location") ?? "").toContain("dollar");
    await mint(cookie, "5");
    const session = store.activeMateSession("alex");
    expect(session).toMatchObject({ approver: "alex", ceilingMicrousd: 5_000_000, spentMicrousd: 0 });
    const thread = await page(cookie);
    expect(thread).toContain('class="thread"');
    expect(thread).toContain('class="chat-workspace"');
    expect(thread).toContain('class="chat-projects"');
    expect(thread).toContain('id="chat-project-panel"');
    expect(thread).toMatch(/<script type="module" src="\/assets\/workspace.js" nonce="[^"]+"><\/script>/);
    const workspace = workspaceOf(thread);
    expect(workspace).toMatchObject({ csrf, user: 'alex', conversation: { sessionId: session!.id, pendingTurnId: null, taskId: null } });
    expect(workspace.navigation.filter(one => one.active).map(one => one.label)).toEqual(['Chat']);
    expect(workspace.projects.map(one => one.path)).toContain(repoDir);
    expect(thread).toContain('class="chat-project-toggle quiet" aria-controls="chat-project-panel"');
    expect(workspace.controlsHtml).not.toContain('name="token"');
    const css = await stylesOf(thread, base);
    expect(css).toContain('.chat-workspace .composer { position: static; width: 100%; box-shadow: var(--shadow); }');
    expect(css).toContain('position: fixed; left: 1rem; right: 1rem; bottom: calc(3.75rem + env(safe-area-inset-bottom, 0rem));');
    expect(css).toContain('grid-template-columns: repeat(2, minmax(0, 1fr));');
    expect(css).toContain('.chat-prompts form:last-child:nth-child(odd) { grid-column: 1 / -1; }');
    expect(css).toContain('.chat-main:has(.chat-empty) .thread { min-height: 0; margin-bottom: .5rem; }');
    expect(css).toContain('width: 100%; min-width: 0; max-width: 100%; margin: 0; padding: 2rem 0 .75rem;');
    expect(css).toContain('.chat-main:has(.chat-empty) .composer { position: static; width: 100%; margin-top: .5rem; }');
    expect(thread).toContain('aria-label="Project catch-up"');
    expect(thread).not.toContain('data-card-kind="fleet-overview"');
    expect(thread).toContain('aria-label="projects in this conversation"');
    expect(thread).toContain('name="message" value="Brief me on what needs my attention, what is building, and the highest-leverage next action across every project."');
    expect(thread).toMatch(/<span class="name">All projects/);
    expect(thread).toContain('class="card composer"');
    expect(thread).not.toContain('name="token"');
    expect(thread).toContain("What do you want to get done?");
    expect(thread).toContain("Describe what you want done…");
    // Concise pass (2026-09-13): one contextual sentence over the empty
    // thread, no intro over the heading, no second hint under the
    // composer, an idle status line with nothing to say, three starters.
    expect(thread).toContain('<p class="meta">Describe a task or ask about your projects.</p></div>');
    expect(thread).not.toContain("One message is enough.");
    expect(thread).not.toContain("Ask about any project. Changes come back as cards you confirm.");
    expect(thread).not.toContain("Changes appear as cards for you to confirm.");
    expect(thread).toContain('<p class="meta composer-hint" id="chat-connection" role="status" aria-live="polite"></p>');
    expect(thread.match(/<div class="chat-prompts" aria-label="suggested questions">/g)).toHaveLength(1);
    expect([...(/<div class="chat-prompts" aria-label="suggested questions">(.*?)<\/div>/s.exec(thread)?.[1] ?? "").matchAll(/class="quiet">([^<]+)<\/button>/g)].map(m => m[1])).toEqual(["brief me", "decisions", "new task"]);
    expect(thread).not.toContain('>building now</button>');
    expect(thread).not.toContain('>prioritize queues</button>');
    expect(thread).toContain("use your judgment");
    expect(thread).toContain('>new task</button>');
    expect(thread).toContain("this conversation: $0.00 of $5.00");
    expect(thread).toContain("It stays open until you end it");
    expect(thread).toContain('action="/chat/mate/end"');
  });

  test("navigation cards offer one labelled link without implying a pending approval", async () => {
    const cookie = await login(); const csrf = await mint(cookie);
    script.push(
      () => answer([
        { type: "tool_use", id: "open-a", name: "show_control", input: { control: "result", task: "a" } },
        { type: "tool_use", id: "hold-b", name: "propose_hold", input: { task: "b", reason: "Wait for the operator's review." } },
      ]),
      () => answer([{ type: "text", text: "Review task a. The pause for task b still needs your confirmation." }]),
    );
    expect((await post(cookie, "/chat", { csrf, message: "Show task a and propose pausing b" })).status).toBe(303);
    await settle();
    const html = await page(cookie);
    const card = /<article[^>]*data-card-kind="control"[^>]*>([\s\S]*?)<\/article>/.exec(html)?.[1];
    expect(card).toBeDefined();
    expect(card).toContain('<h3>task a</h3>');
    expect(card).toContain('href="/chat?task=a" aria-label="Open result: task a"');
    expect(card?.match(/<a /g)).toHaveLength(1);
    expect(card).not.toMatch(/pending|proposed by|Open control|<form/);
    const hold = /<article[^>]*data-card-kind="hold"[^>]*>([\s\S]*?)<\/article>/.exec(html)?.[1];
    expect(hold).toContain("Pending");
    expect(hold).toContain("/confirm");
    expect(store.activeHold(store.refFor("built-in", "b").id, clockNow)).toBeNull();
  });

  test("blank lines do not reset the numbers of recommended chat actions", async () => {
    const cookie = await login(); const csrf = await mint(cookie);
    script.push(() => answer([{ type: "text", text: "1. Inspect the result.\n\n2. Read the checks.\n\n3. Review <script>unsafe</script> as text." }]));
    expect((await post(cookie, "/chat", { csrf, message: "Give me three next steps" })).status).toBe(303);
    await settle();
    const html = await page(cookie);
    expect(html).toContain('<ol><li value="1">Inspect the result.</li></ol>');
    expect(html).toContain('<ol><li value="2">Read the checks.</li></ol>');
    expect(html).toContain('<ol><li value="3">Review &lt;script&gt;unsafe&lt;/script&gt; as text.</li></ol>');
    expect(html).not.toContain('<script>unsafe</script>');
  });

  test("browser send receipts survive repeated POSTs without duplicating a completed turn", async () => {
    const cookie = await login(); const csrf = await mint(cookie);
    const html = await page(cookie);
    const request = /name="request" value="([a-f0-9]{32})"/.exec(html)![1]!;
    const session = store.activeMateSession("alex")!.id;
    const fields = { csrf, message: "What needs me?", request, "request-session": String(session) };
    script.push(() => answer([{ type: "text", text: "Here is the current picture." }]));
    expect((await post(cookie, "/chat", fields)).status).toBe(303); await settle();
    expect((await post(cookie, "/chat", fields)).status).toBe(303); await settle();
    expect(store.recentMateTurns("alex", 10)).toHaveLength(1);
    const state = await fetch(url(`/chat/mate/status?request=${request}`), { headers: { cookie } });
    expect(await state.json()).toMatchObject({ session, task: "", received: true, pending: false, version: expect.stringMatching(/^[a-f0-9]{16}$/) });
    expect(await (await fetch(url("/chat/mate/status?request=bad"), { headers: { cookie } })).json()).toMatchObject({ received: false });
    await post(cookie, "/chat", { ...fields, message: "Different work" }); await settle();
    expect(store.recentMateTurns("alex", 10)).toHaveLength(1);
    expect(await page(cookie)).toContain("different text or task context");
    const wrongSession = await post(cookie, "/chat", { ...fields, "request-session": String(session + 1) });
    expect(decodeURIComponent(wrongSession.headers.get("location")!)).toContain("conversation changed");
    expect((await post(cookie, "/chat", { ...fields, csrf: "bad" })).status).toBe(403);
    expect((await fetch(url("/chat/mate/status"), { redirect: "manual" })).status).toBe(303);
    expect((await fetch(url("/chat/mate/status"), { headers: { authorization: `Bearer alex:${approverToken}` } })).status).toBe(403);
  });

  test("a pending chat retains its mobile composer without timed full-page refreshes", async () => {
    const cookie = await login(); const csrf = await mint(cookie);
    // A hung deterministic provider keeps the pending page visible, then the
    // ordinary stop action ends it. No real provider or worker is involved.
    let finish!: (value: Response) => void;
    script.push(() => new Promise<Response>(resolve => { finish = resolve; }) as unknown as Response);
    await post(cookie, "/chat", { csrf, message: "Help me review the task" });
    const pending = await page(cookie);
    expect(pending).toContain('data-chat-busy="1"');
    expect(pending).toContain('class="card composer"');
    expect(pending).toContain("draft your next message");
    expect(pending).not.toMatch(/<meta http-equiv="refresh" content="5">/);
    const turn = store.liveMateTurnFor("alex")!.id;
    const workspace = workspaceOf(pending);
    expect(workspace.refreshUrl).toBe('/chat?format=workspace');
    expect(workspace.conversation).toMatchObject({ pendingTurnId: turn, taskId: null });
    const refreshed = await (await fetch(url(workspace.refreshUrl), { headers: { cookie } })).json();
    expect(refreshed.conversation).toMatchObject({ sessionId: workspace.conversation!.sessionId, pendingTurnId: turn });
    expect(refreshed.conversation.messages).toEqual(workspace.conversation!.messages);
    expect(store.recentMateTurns('alex', 10)).toHaveLength(1);
    await post(cookie, "/chat/mate/stop", { csrf, turn: String(turn) });
    finish(answer([{ type: "text", text: "Stopped." }])); await settle();
    expect((await (await fetch(url(workspace.refreshUrl), { headers: { cookie } })).json()).conversation.pendingTurnId).toBeNull();
  });

  test("a task's Ask view stays in the unified thread and confirms guidance without losing context", async () => {
    const cookie = await login();
    const taskHtml = await (await fetch(url("/t/a"), { headers: { cookie } })).text();
    expect(taskHtml).toContain('aria-label="task view"');
    expect(taskHtml).toContain('href="/t/a" class="active" aria-current="page">Overview</a>');
    expect(taskHtml).toContain('href="/chat?task=a">Ask</a>');

    let html = await (await fetch(url("/chat?task=a"), { headers: { cookie } })).text();
    expect(html).toContain('class="chat-workspace task-chat-workspace"');
    expect(html).toContain('aria-label="current task"');
    expect(html).toContain('href="/chat?task=a" class="active" aria-current="page">Ask</a>');
    expect(html).toContain('aria-label="assignment progress"');
    // The chat card is the task page's approval sheet: the plan open as
    // plain rows, one line of who builds, and Approve & start as the only
    // submit; no opener and no paragraph explaining the ceremony.
    expect(html).toContain('<section class="card chat-action-card chat-plan" id="task-chat-action" data-approval="');
    expect(html).toContain('<div class="approval-row"><dt>Goal</dt><dd><p class="approval-goal">do a</p></dd></div>');
    expect(html).toContain('<div class="approval-row"><dt>Done when</dt>');
    expect(html).not.toContain('<span class="button-link">Approve plan</span></summary>');
    expect(html).not.toContain("your next step");
    expect(html).not.toContain("approve to start");
    expect(html).not.toContain("These are the exact terms");
    // Edit plan opens the task page's sheet with its fields ready to edit.
    expect(html).toContain('<a class="approval-link" href="/t/a?edit=plan#plan-editor">Edit plan</a><a class="approval-link" href="/chat">Not now</a>');
    expect(html).toContain("Your password signs this approval.");
    expect(html.match(/<button type="submit" data-primary-action>Approve & start<\/button>/g)).toHaveLength(1);
    expect(html).toContain('action="/t/a/approve"');
    expect(html).toContain('name="return" value="/chat?task=a"');
    expect(html).toContain('data-poll="0"');
    expect(html).not.toContain('id="chat-project-panel"');
    expect(html).not.toContain('data-card-kind="fleet-overview"');
    const csrf = csrfFrom(html);
    const safeFragment = await (await fetch(url("/chat/task-status?task=a"), { headers: { cookie } })).text();
    expect(safeFragment).toContain('data-primary-action>Approve plan</a>');
    expect(safeFragment).not.toContain('type="password"');

    const nonce = /name="nonce" value="([0-9a-f]+)"/.exec(html)?.[1];
    const digest = /name="digest" value="([0-9a-f]+)"/.exec(html)?.[1];
    if (nonce === undefined || digest === undefined) throw new Error("no focused-chat approval ceremony");
    const approved = await post(cookie, "/t/a/approve", { csrf, nonce, digest, token: approverToken, return: "/chat?task=a" });
    expect(approved.status).toBe(303);
    expect(approved.headers.get("location")).toBe("/chat?task=a");
    expect(approvalOf(store.getScope("a"))).toMatchObject({ approved: true, by: "alex" });
    html = await (await fetch(url("/chat?task=a"), { headers: { cookie } })).text();
    expect(html).toContain('data-poll="1"');
    expect(html).not.toContain('action="/t/a/approve"');
    const fragment = await (await fetch(url("/chat/task-status?task=a"), { headers: { cookie } })).text();
    expect(fragment).toContain('id="task-chat-live"');
    expect(fragment).toContain('data-poll="1"');

    const minted = await post(cookie, "/chat/mate/mint", { csrf, "ceiling-usd": "5", token: approverToken, return: "/chat?task=a" });
    expect(minted.status).toBe(303);
    expect(minted.headers.get("location")).toBe("/chat?task=a");
    // Concise pass (2026-09-13): the focused empty thread carries the
    // title, the Overview/Ask switch, ONE contextual sentence, three
    // starters, and an idle status line with nothing to say — no intro
    // sentence under the title and no second hint under the composer.
    const focusedFresh = await (await fetch(url("/chat?task=a"), { headers: { cookie } })).text();
    expect(focusedFresh).toContain('<div class="chat-empty" data-key="empty"><strong>What do you want to understand or change?</strong><p class="meta">Ask about progress, review results, or adjust the plan.</p></div>');
    expect(focusedFresh).not.toContain("Ask, steer, or revise this task in the same unified conversation.");
    expect(focusedFresh).not.toContain("choose a useful starting point");
    expect(focusedFresh).not.toContain("Changes appear as cards for you to confirm.");
    expect(focusedFresh).toContain('<p class="meta composer-hint" id="chat-connection" role="status" aria-live="polite"></p>');
    expect([...focusedFresh.matchAll(/class="quiet">([^<]+)<\/button><\/form>/g)].map(m => m[1]).filter(one => one !== "End the conversation and forget the thread")).toEqual(["What’s happening", "Review results", "Adjust the plan", "Enable updates"]);
    expect(focusedFresh).toContain('action="/chat/mate/follow"');
    expect(focusedFresh).toContain('href="/chat?task=a" class="active" aria-current="page">Ask</a>');

    const unknown = await post(cookie, "/chat", { csrf, task: "not-in-this-workspace", message: "do something" });
    expect(decodeURIComponent(unknown.headers.get("location") ?? "")).toContain("not available in this workspace");
    expect(store.recentMateTurns("alex", 5)).toEqual([]);

    script.push(
      () => answer([
        { type: "tool_use", id: "r1", name: "get_task", input: { task: "a" } },
        { type: "tool_use", id: "s1", name: "propose_steer", input: { task: "a", note: "Polish the compact mobile navigation before broadening the sidebar." } },
      ]),
      () => answer([{ type: "text", text: "I drafted focused guidance for the next attempt." }]),
    );
    const sent = await post(cookie, "/chat", { csrf, task: "a", message: "Make the next pass focus on the mobile navigation." });
    expect(sent.status).toBe(303);
    expect(sent.headers.get("location")).toBe("/chat?task=a#latest");
    await settle();

    html = await (await fetch(url("/chat?task=a"), { headers: { cookie } })).text();
    expect(html).toContain('data-card-kind="steer"');
    expect(html).toContain("Guidance for next attempt");
    expect(html).toContain("without changing the task’s scope");
    expect(html).toContain('name="task" value="a"');
    expect(html).toContain('name="return" value="/chat?task=a"');
    expect(html).toContain('data-message-role="operator" data-key="m1"><p style="white-space:pre-wrap">Make the next pass focus on the mobile navigation.</p>');
    expect(html).not.toContain("Current task: a.");
    // The populated thread keeps every real message and card; the empty-state sentence is gone with the emptiness.
    expect(html).not.toContain('<div class="chat-empty">');
    expect(html).toContain("I drafted focused guidance for the next attempt.");
    expect(store.listSteerNotes(store.refFor("built-in", "a").id)).toEqual([]);

    const confirmed = await post(cookie, "/chat/proposal/1/confirm", { csrf, return: "/chat?task=a" });
    expect(confirmed.status).toBe(303);
    expect(confirmed.headers.get("location")).toBe("/chat?task=a#latest");
    expect(store.listSteerNotes(store.refFor("built-in", "a").id)).toMatchObject([
      { note: "Polish the compact mobile navigation before broadening the sidebar.", author: "alex", authorshipState: "verified", attachedRun: null },
    ]);
  });

  test("chat-steer: the mate reads the current agents, proposes a confirmation-gated agent change, the card says exactly what changes, and confirming goes through the authenticated route edit", async () => {
    store.setPhaseTierConfig("installation", "plan", "strong", "codex", "gpt-5-codex", "test", T0);
    const cookie = await login();
    let html = await (await fetch(url("/chat?task=a"), { headers: { cookie } })).text();
    const csrf = csrfFrom(html);
    const minted = await post(cookie, "/chat/mate/mint", { csrf, "ceiling-usd": "5", token: approverToken, return: "/chat?task=a" });
    expect(minted.status).toBe(303);
    // Approve the scope as it stands so the change has an approval to stale.
    const scope = store.getScope("a")!;
    expect(approve(store, "a", "alex", clockNow, scope.digest, approverToken).ok).toBe(true);
    script.push(
      () => answer([{ type: "tool_use", id: "g1", name: "get_agents", input: { task: "a" } }]),
      () => {
        return answer([{ type: "tool_use", id: "p1", name: "propose_agents", input: { task: "a", role: "planner", agent: { provider: "codex", model: "gpt-5-codex" }, why: "the change touches money" } }]);
      },
      () => answer([{ type: "text", text: "I propose planning on codex · gpt-5-codex." }]),
    );
    const sent = await post(cookie, "/chat", { csrf, task: "a", message: "Who plans this, and can we use the stronger planner?" });
    expect(sent.status).toBe(303);
    await settle();
    // The turn ran both tools and answered; the proposal waits pending.
    expect(store.recentMateTurns("alex", 1)[0]).toMatchObject({ state: "answered" });
    expect(store.getMateProposal(1)).toMatchObject({ kind: "agents", state: "pending", payload: expect.objectContaining({ task: "a", phase: "plan", provider: "codex", model: "gpt-5-codex", approval: "approved", before: "claude · sonnet plans, builds, and repairs" }) });
    // The card: the role, the exact agent, the approval consequence.
    html = await (await fetch(url("/chat?task=a"), { headers: { cookie } })).text();
    expect(html).toContain('data-card-kind="agents"');
    expect(html).toContain("Agents change");
    expect(html).toContain("planner on <span class=\"mono\">codex · gpt-5-codex</span>");
    expect(html).toContain("<dt>agents now</dt><dd>claude · sonnet plans, builds, and repairs</dd>");
    expect(html).toContain("The current approval no longer covers the task afterwards — approve it again on the task.");
    expect(store.refFor("built-in", "a").routeOverrides).toEqual([]);
    expect(approvalOf(store.getScope("a"))).toMatchObject({ approved: true });
    // Confirming is the operator's own act through the one route edit: recorded as alex, the approval staled.
    const confirmed = await post(cookie, "/chat/proposal/1/confirm", { csrf, return: "/chat?task=a" });
    expect(confirmed.status).toBe(303);
    const ref = store.refFor("built-in", "a");
    expect(ref.routeOverrides).toEqual([expect.objectContaining({ phase: "plan", provider: "codex", model: "gpt-5-codex", by: "alex" })]);
    expect(approvalOf(store.getScope("a"))).toMatchObject({ approved: false, reason: "changed" });
    html = await (await fetch(url("/chat?task=a"), { headers: { cookie } })).text();
    expect(html).toContain("the planner is now codex · gpt-5-codex — the earlier approval no longer covers this task; approve it again");
    expect(html).toContain('<p class="agents-summary">codex · gpt-5-codex plans; claude · sonnet builds and repairs</p>');
  });

  test("a focused chat answers a blocking decision and returns to the same conversation", async () => {
    const ref = store.refFor("built-in", "a").id;
    const scope = store.getScope("a");
    if (scope === null) throw new Error("no scope");
    expect(approve(store, "a", "alex", clockNow, scope.digest, approverToken)).toMatchObject({ ok: true });
    const run = store.startRun({ taskRef: ref, leaseId: "decision-lease", runner: "builder", branch: "standing-orders/a", worktree: "/tmp/a", now: clockNow, ...presented(store, ref, "builder") });
    const decision = store.saveDecision({
      run,
      urgency: "blocking",
      recap: "The layout can preserve or replace the existing navigation.",
      question: "Keep the familiar navigation structure?",
      options: [
        { id: "keep", label: "Keep it", consequence: "The information architecture stays familiar.", reversible: true },
        { id: "replace", label: "Replace it", consequence: "The old structure is removed.", reversible: false },
      ],
      recommendation: "keep",
    }, clockNow);
    const cookie = await login();
    const html = await (await fetch(url("/chat?task=a"), { headers: { cookie } })).text();
    const csrf = csrfFrom(html);
    expect(html).toContain("Needs your answer");
    expect(html).not.toContain("Keep the work moving");
    expect(html).toContain('<details class="decision-context"><summary>Context</summary>');
    expect(html).toContain('The old structure is removed.');
    expect(html).toContain('Irreversible');
    expect(html).toContain(`action="/d/${decision}/answer"`);
    expect(html).toContain('name="return" value="/chat?task=a"');
    expect(html).toContain(`/d/${decision}?return=%2Fchat%3Ftask%3Da`);

    const answered = await post(cookie, `/d/${decision}/answer`, { csrf, choice: "keep", return: "/chat?task=a" });
    expect(answered.status).toBe(303);
    expect(answered.headers.get("location")).toBe("/chat?task=a");
    expect(store.getDecision(decision)).toMatchObject({ state: "answered", choice: "keep", answeredBy: "alex" });
    const refreshed = await (await fetch(url("/chat?task=a"), { headers: { cookie } })).text();
    expect(refreshed).not.toContain("Keep the familiar navigation structure?");
  });

  test("a task filed from chat hands off directly to its focused conversation", async () => {
    const cookie = await login();
    const csrf = await mint(cookie, "5");
    script.push(
      () => answer([{ type: "tool_use", id: "g0", name: "get_capabilities", input: { repo: "r1" } }]),
      () => answer([{ type: "tool_use", id: "p1", name: "propose_task", input: {
        repo: "r1",
        title: "Polish the result cockpit",
        goal: "Make completed work faster to review.",
        acceptance: [{ id: "c1", statement: "A reviewer can understand the result quickly.", evidence: ["manual-review"] }],
        planning: "required",
      } }]),
      () => answer([{ type: "text", text: "I drafted the task for confirmation." }]),
    );
    const sent = await post(cookie, "/chat", { csrf, message: "Add a focused result cockpit." });
    expect(sent.status).toBe(303);
    await settle();
    let html = await page(cookie);
    expect(html).toContain('data-card-kind="task"');
    expect(html).toContain("inspect the project and draft a plan first");
    const confirmed = await post(cookie, "/chat/proposal/1/confirm", { csrf });
    expect(confirmed.status).toBe(303);
    const proposal = store.getMateProposal(1);
    const taskId = typeof proposal?.outcome?.["taskId"] === "string" ? proposal.outcome["taskId"] : null;
    if (taskId === null) throw new Error("the task proposal did not file");
    expect(store.lookupRef(taskId)?.plan).toBe("requested");
    // Package 2: the confirmation leads to the task it actually created —
    // the id is the door's recorded outcome — and the card names it.
    expect(confirmed.headers.get("location")).toBe(`/chat?task=${taskId}#task-chat-live`);
    html = await page(cookie);
    expect(html).toContain("the planner is reading the project before you approve anything");
    expect(html).toContain(`<a class="button-link" href="/chat?task=${taskId}" data-filed-task="${taskId}">Open task <span class="mono">${taskId}</span> →</a>`);
    expect(html).toContain(`href="/t/${taskId}">overview</a>`);
    const focused = await (await fetch(url(`/chat?task=${taskId}`), { headers: { cookie } })).text();
    // Since f53b7f1 the task status card alone names planning: the live
    // region carries the requested plan and no second planning card.
    expect(focused).toContain('data-plan="requested"');
    expect(focused).toContain('<section class="card assignment-summary" aria-label="assignment progress"');
    expect(focused).not.toContain("The planner is preparing a scope for you");
    expect(focused).toContain(`data-chat-task="${taskId}"`);
    // Confirming again creates no second task: the door says so, no redirect into a lens.
    const again = await post(cookie, "/chat/proposal/1/confirm", { csrf });
    expect(again.headers.get("location")).toBe("/chat#latest");
    expect(store.listTasks().filter(one => one.title === "Polish the result cockpit")).toHaveLength(1);
    expect(store.getMateProposal(1)?.state).toBe("confirmed");
  });

  test("a logged-in Codex membership has no dollar maximum in setup, minting, or the live conversation", async () => {
    const cookie = await login();
    let html = await page(cookie);
    const csrf = csrfFrom(html);
    const configured = await post(cookie, "/chat/config", {
      csrf,
      provider: "codex-subscription",
      model: "default",
      "weekly-usd": "100",
      "daily-turns": "25",
      token: approverToken,
    });
    expect(configured.status).toBe(303);
    expect(store.getChatConfig()).toMatchObject({ provider: "codex-subscription", model: "default", dailyTurns: 25, weeklyCeilingMicrousd: 0, priceInMicrousd: 0, priceOutMicrousd: 0 });

    // A membership conversation starts on its own; its settings live one tap away.
    html = await (await fetch(url("/chat?settings=1"), { headers: { cookie } })).text();
    expect(html).toContain("membership login · no dollar ceiling");
    expect(html).toContain('href="/settings/lead">Lead settings</a>');
    html = await (await fetch(url("/settings/lead"), { headers: { cookie } })).text();
    expect(html).toContain("The lead uses your Codex sign-in.");
    expect(html).toContain("Codex membership (logged-in CLI)");
    expect(html).toContain("No dollar maximum");
    expect(html).toContain("codex login");
    expect(html).not.toContain('name="weekly-usd"');
    expect(html).not.toContain('name="ceiling-usd"');
    expect(html).not.toContain('name="key"');

    const minted = await post(cookie, "/chat/mate/mint", { csrf, token: approverToken });
    expect(minted.status).toBe(303);
    expect(store.activeMateSession("alex")).toMatchObject({ ceilingMicrousd: 0, spentMicrousd: 0 });
    // The live pilot's chat message overflowed at 390px; the allowed-files
    // path is a separate case. Keep this exact path in both message roles.
    const path = "docs/assessments/WORKSPACE_5_REAL_WORK_PILOT_2026-09-14.md";
    const message = `Read AGENTS.md and ${path}.`;
    subscriptionAnswers.push({ text: `## Fleet status\n\n- **Queue:** calm\n- Run \`smoke\` next.\n\n<script>bad()</script>\n\n${message}\n\nKeep \`${path}\` visible. Rename me at https://so.example.com/settings/lead (run #3). Your settings: ${base}/settings/lead`, calls: [], tokensIn: 21, tokensOut: 5, reportedCostMicrousd: null });
    const sent = await post(cookie, "/chat", { csrf, message });
    expect(sent.status).toBe(303);
    await settle();

    html = await page(cookie);
    expect(html).toContain(`<p style="white-space:pre-wrap">${message}</p>`);
    // The lead's voice, enforced: the header is a plain line, a foreign URL a link named by its host, this console's own link named as its page, the run number gone.
    expect(html).toContain(`<div class="chat-copy"><p>Fleet status</p><ul><li><strong>Queue:</strong> calm</li><li>Run <code>smoke</code> next.</li></ul><p>&lt;script&gt;bad()&lt;/script&gt;</p><p>${message}</p><p>Keep <code>${path}</code> visible. Rename me at <a href="https://so.example.com/settings/lead" rel="noopener noreferrer" target="_blank">so.example.com</a>. Your settings: <a href="${base}/settings/lead" rel="noopener noreferrer" target="_blank">Settings → Lead</a></p></div>`);
    expect(await stylesOf(html, base)).toContain('.thread .msg { max-width: 48rem; line-height: 1.65; overflow-wrap: anywhere; }');
    expect(html).not.toContain("<script>bad()</script>");
    expect(html).toContain("membership login · no dollar ceiling");
    expect(html).not.toContain("this session: $0.00 of $0.00");
    expect(html).toContain('class="card composer"');
    expect(html).not.toContain('name="token"');
    const turn = store.recentMateTurns("alex", 1)[0];
    expect(turn).toMatchObject({ state: "answered", reservedMicrousd: 0, settledMicrousd: 0, tokensIn: 21, tokensOut: 5 });
    expect(store.raw().prepare("SELECT provider, reserved_microusd, settled_microusd FROM chat_turn WHERE mate_turn = ?").get(turn?.id)).toEqual({ provider: "codex-subscription", reserved_microusd: 0, settled_microusd: 0 });
  });

  test("lead chat: a direct confirm POST is refused mid-turn and without chat enabled, with the card's words, then confirms", async () => {
    const cookie = await login();
    const csrf = await mint(cookie);
    script.push(
      () => answer([{ type: "tool_use", id: "c1", name: "propose_next", input: { task: "b" } }]),
      () => answer([{ type: "text", text: "I propose moving b to the front." }]),
    );
    await post(cookie, "/chat", { csrf, message: "what next?" });
    await settle();
    const proposal = store.getMateProposal(1)!;
    expect(proposal.state).toBe("pending");
    const confirm = () => fetch(url("/chat/proposal/1/confirm"), { method: "POST", headers: { cookie, origin: base, accept: "application/json" }, body: new URLSearchParams({ csrf }), redirect: "manual" });
    const before = store.queuePosition("b")?.position;
    // A live turn in the same thread: the card waits and the door says why.
    const session = store.activeMateSession("alex")!;
    const opened = store.openMateTurn({ approver: "alex", session: session.id, thread: proposal.thread, credentialKey: session.credentialKey, reservedMicrousd: 0, dailyTurns: 50, weeklyCeilingMicrousd: 100_000_000, deadlineMs: 60_000 }, T0);
    if (!opened.ok) throw Error(opened.reason);
    const started = store.startMateTurn(opened.id, T0);
    if (!started.ok) throw Error("start");
    expect(await page(cookie)).toContain("Available when the current reply finishes.");
    let refused = await confirm();
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ ok: false, said: "Available when the current reply finishes.", taskId: null });
    expect(store.getMateProposal(1)?.state).toBe("pending");
    expect(store.queuePosition("b")?.position).toBe(before);
    store.finalizeMateTurn(opened.id, started.generation, { state: "answered", settledMicrousd: 0, tokensIn: 0, tokensOut: 0 }, T0);
    // Chat turned off: refused with the same plain reason, nothing moves.
    store.endMateSession(session.id, "alex", T0);
    refused = await confirm();
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ ok: false, said: "Enable chat in this conversation before acting on a proposal.", taskId: null });
    expect(store.getMateProposal(1)?.state).toBe("pending");
    expect(store.queuePosition("b")?.position).toBe(before);
    // Enabled again, with no live turn: the same POST confirms, once.
    store.mintMateSession({ approver: "alex", approverGeneration: session.approverGeneration, credentialKey: session.credentialKey, ceilingMicrousd: session.ceilingMicrousd, ceilingDigest: session.ceilingDigest, termsDigest: session.termsDigest }, T0);
    expect(await (await confirm()).json()).toMatchObject({ ok: true });
    expect(store.getMateProposal(1)).toMatchObject({ state: "confirmed", resolvedBy: "alex" });
    expect(store.queuePosition("b")?.position).toBe(1);
    expect(await (await confirm()).json()).toMatchObject({ ok: false });
  });

  test("a turn: the model reads and proposes, the card confirms through the door, a stale card refuses", async () => {
    const cookie = await login();
    const csrf = await mint(cookie);
    script.push(
      () => answer([{ type: "tool_use", id: "c1", name: "queue", input: { repo: "r1" } }, { type: "tool_use", id: "c2", name: "propose_next", input: { task: "b" } }]),
      () => answer([{ type: "text", text: "I propose moving b to the front." }]),
    );
    const sent = await post(cookie, "/chat", { csrf, message: "what is queued?" });
    expect(sent.status).toBe(303);
    await settle();
    const turn = store.recentMateTurns("alex", 1)[0];
    expect(turn).toMatchObject({ state: "answered", steps: 2 });
    let html = await page(cookie);
    expect(html).toContain('<div class="msg op" data-message-role="operator" data-key="m1"><p style="white-space:pre-wrap">what is queued?</p></div>');
    expect(html).toContain("I propose moving b to the front.");
    expect(html).not.toContain('aria-label="suggested questions"');
    expect(html).toContain('<details class="chat-activity-details"><summary>Activity</summary>');
    expect(html).toContain('class="chat-activity"');
    expect(html).toContain("read 1");
    expect(html).toContain("proposed 1");
    expect(html).toContain("2 steps");
    expect(html).toContain('data-card-kind="next"');
    expect(html).toContain('class="proposal-facts"');
    expect(html).toContain('action="/chat/proposal/1/confirm"');
    expect(html).toContain('action="/chat/proposal/1/dismiss"');
    // No csrf: the central gate refuses, nothing moves.
    const forged = await fetch(url("/chat/proposal/1/confirm"), { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({}), redirect: "manual" });
    expect(forged.status).toBe(403);
    expect(store.getMateProposal(1)?.state).toBe("pending");
    const confirmed = await post(cookie, "/chat/proposal/1/confirm", { csrf });
    expect(confirmed.status).toBe(303);
    expect(store.getMateProposal(1)).toMatchObject({ state: "confirmed", resolvedBy: "alex" });
    expect(store.queuePosition("b")?.position).toBe(1);
    html = await page(cookie);
    expect(html).toContain("b moved to the front of its column");
    expect(html).not.toContain('action="/chat/proposal/1/confirm"');
    // A second act on the same card is a no-op with a note.
    await post(cookie, "/chat/proposal/1/confirm", { csrf });
    expect(store.getMateProposal(1)?.state).toBe("confirmed");
    // A proposal the queue outran: the door refuses with the typed reason, rendered on the card.
    script.push(
      () => answer([{ type: "tool_use", id: "c3", name: "propose_next", input: { task: "a" } }]),
      () => answer([{ type: "text", text: "Now a." }]),
    );
    await post(cookie, "/chat", { csrf, message: "and a?" });
    await settle();
    expect(store.getMateProposal(2)?.state).toBe("pending");
    store.moveTaskNext("a", clockNow);
    await post(cookie, "/chat/proposal/2/confirm", { csrf });
    expect(store.getMateProposal(2)).toMatchObject({ state: "refused" });
    html = await page(cookie);
    expect(html).toContain("the queue moved since this was proposed");
    // Session spend is the two turns' settled cost, shown on the page.
    const session = store.activeMateSession("alex");
    expect(session?.spentMicrousd).toBe(4 * (100 * 3 + 20 * 15));
    expect(html).toContain("this conversation: $0.00 of $50.00");
  });

  test("unified chat renders and confirms a rich dependency repair card", async () => {
    expect(store.addEdge("b", "a")).toEqual({ ok: true });
    expect(store.cancelTask("a", T0, "obsolete")).toMatchObject({ ok: true });
    const cookie = await login();
    const csrf = await mint(cookie);
    script.push(
      () => answer([
        { type: "tool_use", id: "c1", name: "get_task", input: { task: "b" } },
        { type: "tool_use", id: "c2", name: "propose_dependency_repair", input: { task: "b", blocker: "a", operation: "unlink" } },
      ]),
      () => answer([{ type: "text", text: "I prepared the safe repair for confirmation." }]),
    );
    await post(cookie, "/chat", { csrf, message: "repair b's cancelled dependency" });
    await settle();

    let html = await page(cookie);
    expect(html).toContain('data-card-kind="repair"');
    expect(html).toContain("Task is waiting");
    expect(html).toContain("task b may be ready to run once it no longer waits for task a");
    expect(html).toContain(">continue without it</button>");
    expect(store.blockers("b")).toEqual(["a"]);

    const confirmed = await post(cookie, "/chat/proposal/1/confirm", { csrf });
    expect(confirmed.status).toBe(303);
    expect(store.getMateProposal(1)).toMatchObject({ state: "confirmed", outcome: { taskId: "b" } });
    expect(store.blockers("b")).toEqual([]);
    html = await page(cookie);
    expect(html).toContain("task b can now continue without task a");
  });

  test("a cancel card only points at the task; dismiss retires a card; ending the session forgets the thread", async () => {
    const cookie = await login();
    const csrf = await mint(cookie);
    script.push(
      () => answer([{ type: "tool_use", id: "c1", name: "propose_cancel", input: { task: "a", reason: "superseded" } }, { type: "tool_use", id: "c2", name: "propose_hold", input: { task: "b", reason: "not yet" } }]),
      () => answer([{ type: "text", text: "Two suggestions." }]),
    );
    await post(cookie, "/chat", { csrf, message: "tidy up" });
    await settle();
    let html = await page(cookie);
    expect(html).toContain("Cancelling is armed on the task itself");
    expect(html).not.toContain('action="/chat/proposal/1/confirm"');
    expect(html).toContain('action="/chat/proposal/2/confirm"');
    await post(cookie, "/chat/proposal/1/confirm", { csrf });
    expect(store.getMateProposal(1)?.state).toBe("pending");
    await post(cookie, "/chat/proposal/2/dismiss", { csrf });
    expect(store.getMateProposal(2)?.state).toBe("dismissed");
    expect(store.activeHolds(store.refFor("built-in", "b").id, clockNow)).toEqual([]);
    const threadId = store.openMateThread("alex", store.activeMateSession("alex")!.ceilingDigest, clockNow).thread.id;
    expect(store.listMateMessages(threadId, 10)).toHaveLength(2);
    const ended = await post(cookie, "/chat/mate/end", { csrf });
    expect(ended.status).toBe(303);
    expect(store.activeMateSession("alex")).toBeNull();
    expect(store.listMateMessages(threadId, 10)).toEqual([]);
    expect(store.listMateProposals(threadId)).toEqual([]);
    html = await page(cookie);
    expect(html).toContain('action="/chat/mate/mint"');
    expect(html).not.toContain('class="thread"');
  });

  test("the shared catch-up appears once, starting chat is clear, and provider limits stay available", async () => {
    const cookie = await login();
    const before = await page(cookie);
    const mintAt = before.indexOf('<div class="card mate-mint" id="latest">');
    const catchUpAt = before.indexOf('aria-label="Project catch-up"');
    const limitsAt = before.indexOf('<details class="chat-limits"><summary>Model &amp; limits');
    expect(mintAt).toBeGreaterThan(-1);
    expect(catchUpAt).toBeGreaterThan(-1);
    expect(catchUpAt).toBeLessThan(mintAt);
    expect(limitsAt).toBeGreaterThan(mintAt);
    expect(before.match(/aria-label="Project catch-up"/g)).toHaveLength(1);
    expect(before).not.toContain('<details class="chat-fleet-context">');
    // The start card speaks plainly and its act is the primary button.
    expect(before).toContain("<strong>Start a conversation</strong>");
    expect(before).toContain("<button type=\"submit\">Start chat</button>");
    expect(before).not.toContain("talk to the mate");
    expect(before).not.toContain(">unified workspace</span>");
    // The provider bar is gone from the top: no bare "answering with" row.
    expect(before).not.toContain("answering with");
    expect(before).toContain('<div class="chat-budget"><span class="mono">anthropic-api · claude-sonnet-5</span><span>0 / 50 turns today</span><span>this week $0.00 of $100.00</span></div>');
    // The project rail defaults to closed everywhere; the toggle says so.
    expect(before).toContain('class="chat-project-toggle quiet" aria-controls="chat-project-panel" aria-expanded="false"');
    expect(before).toContain('return wide.matches&&saved==="open";');
    // Escape closes the drawer and returns focus to its toggle.
    expect(before).toContain('if(ev.key==="Escape"&&workspace.classList.contains("projects-open")){apply(false);projectToggle.focus();}');
    // Exercise the shipped drawer script, not only its string markers.
    // Layout/Tab wrapping is checked in Chromium; here close must restore
    // focus and undo only the background inert state it introduced.
    const window = new Window({ width: 390, height: 844 });
    try {
      window.document.body.innerHTML = before;
      const script = [...window.document.querySelectorAll('script[nonce]:not([type])')].map(one => one.textContent ?? "").find(text => text.includes('(function(){var workspace=')) ?? "";
      const start = script.indexOf('(function(){var workspace=');
      expect(start).toBeGreaterThanOrEqual(0);
      const end = script.indexOf('})();', start);
      expect(end).toBeGreaterThan(start);
      window.eval(script.slice(start, end + 5));
      const toggle = window.document.querySelector<HTMLButtonElement>('.chat-project-toggle')!;
      const panel = window.document.querySelector<HTMLElement>('#chat-project-panel')!;
      const background = window.document.querySelector<HTMLElement>('.chat-main')!;
      toggle.focus(); toggle.click();
      expect(panel.getAttribute('aria-modal')).toBe('true');
      expect(background.inert).toBe(true);
      expect(window.document.activeElement?.getAttribute('aria-label')).toBe('close projects');
      window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(window.document.activeElement).toBe(toggle);
      expect(background.inert).toBe(false);
      expect(panel.hasAttribute('aria-modal')).toBe(false);
    } finally { await window.happyDOM.close(); }

    // Once a conversation is live: the same disclosure carries the
    // session's own ceiling, the top of the page is heading → overview
    // (folded) → thread. Routine session details do not need a second badge.
    await mint(cookie);
    const live = await page(cookie);
    expect(live).not.toContain("conversation live");
    expect(live).not.toContain("answering with");
    expect(live).toContain('<details class="chat-limits chat-session-details"><summary>Conversation details<span class="meta">anthropic-api</span></summary>');
    expect(live).toContain("<span>this conversation: $0.00 of $50.00</span>");
    expect(live.match(/aria-label="Project catch-up"/g)).toHaveLength(1);
    expect(live).not.toContain('<details class="chat-fleet-context">');
    expect(live.indexOf('aria-label="Project catch-up"')).toBeLessThan(live.indexOf('<div class="thread" data-key="thread" data-chat-list>'));
    expect(live.indexOf('<div class="thread" data-key="thread" data-chat-list>')).toBeLessThan(live.indexOf('class="card composer"'));
  });

  test("a new conversation has one catch-up and a compact empty state before its composer", async () => {
    const cookie = await login();
    await mint(cookie);
    const fresh = await page(cookie);
    // The fresh thread: the empty state, no messages, the composer after it.
    expect(fresh).toContain('<div class="chat-empty" data-key="empty"><strong>What do you want to get done?</strong>');
    expect(fresh).not.toContain('data-message-role=');
    expect(fresh.indexOf('<div class="chat-empty" data-key="empty">')).toBeLessThan(fresh.indexOf('class="card composer"'));
    expect(fresh.match(/aria-label="Project catch-up"/g)).toHaveLength(1);
    expect(fresh).not.toContain('<details class="chat-fleet-context">');
    const css = await stylesOf(fresh, base);
    expect(css).toContain('.chat-main:has(.chat-empty) .thread { min-height: 0; margin: .75rem 0 .75rem; }');
    expect(css).toContain('.chat-main:has(.chat-empty) .chat-empty { padding: clamp(1.25rem, 4vh, 2.25rem) 1rem 1rem; }');
    // The desktop rules live behind the desk breakpoint; the phone's own empty-state rules are untouched.
    const desk = css.indexOf('@media (min-width: 761px) {\n    /* A fresh conversation on a desk');
    expect(desk).toBeGreaterThan(-1);
    expect(css.indexOf('.chat-main:has(.chat-empty) .chat-fleet-context > summary { display: flex;')).toBeGreaterThan(desk);
    expect(css).toContain('.chat-main:has(.chat-empty) .thread { min-height: 0; margin-bottom: .5rem; }');
    expect(css).toContain('width: 100%; min-width: 0; max-width: 100%; margin: 0; padding: 2rem 0 .75rem;');
  });

  test("a membership chat opens ready to talk: no password card, a live conversation, settings one tap away", async () => {
    store.setChatConfig({ provider: "codex-subscription", model: "default", dailyTurns: 50, weeklyCeilingMicrousd: 0, priceInMicrousd: 0, priceOutMicrousd: 0 }, "alex", T0);
    const cookie = await login();
    expect(store.activeMateSession("alex")).toBeNull();
    const html = await page(cookie);
    expect(store.activeMateSession("alex")).not.toBeNull();
    expect(html).not.toContain('action="/chat/mate/mint"');
    expect(html).not.toContain('autocomplete="current-password"');
    expect(html).toContain('href="/settings/lead">Lead settings</a>');
    // Reloading keeps the same conversation rather than starting another.
    const first = store.activeMateSession("alex")!.id;
    await page(cookie);
    expect(store.activeMateSession("alex")!.id).toBe(first);
    // The settings view starts nothing and opens the settings.
    store.endMateSessionsFor("alex", "alex", T0);
    const settings = await (await fetch(url("/chat?settings=1"), { headers: { cookie } })).text();
    expect(store.activeMateSession("alex")).toBeNull();
    expect(settings).toContain('<p class="meta" id="chat-settings"><a href="/settings/lead">Lead settings</a>');
  });

  test("a change in reachable projects starts a new thread as before; the old one stays readable above a divider and never reaches the model", async () => {
    store.setChatConfig({ provider: "codex-subscription", model: "default", dailyTurns: 50, weeklyCeilingMicrousd: 0, priceInMicrousd: 0, priceOutMicrousd: 0 }, "alex", T0);
    const cookie = await login();
    const workspaceOf = (html: string) => JSON.parse(/<script type="application\/json" id="standing-orders-workspace-data"[^>]*>([\s\S]*?)<\/script>/.exec(html)![1]!) as import("./browser-workspace.js").BrowserWorkspace;
    const counts = () => store.raw().prepare("SELECT (SELECT COUNT(*) FROM mate_session) AS sessions, (SELECT COUNT(*) FROM mate_thread) AS threads").get();
    const csrf = csrfFrom(await page(cookie));
    subscriptionAnswers.push({ text: "The old route was through the payments project.", calls: [], tokensIn: 10, tokensOut: 5, reportedCostMicrousd: null });
    expect((await post(cookie, "/chat", { csrf, message: "Remember the payments route" })).status).toBe(303);
    await settle();
    let html = await page(cookie);
    expect(workspaceOf(html).conversation?.previous ?? null).toBeNull();
    expect(html).not.toContain("data-thread-divider");
    // The projects this lead could reach changed under the live conversation.
    const old = store.activeMateSession("alex")!;
    store.raw().prepare("UPDATE mate_session SET ceiling_digest = ? WHERE id = ?").run("f".repeat(64), old.id);
    store.raw().prepare("UPDATE mate_thread SET ceiling_digest = ? WHERE approver = 'alex' AND closed_at IS NULL").run("f".repeat(64));
    const before = counts() as { sessions: number; threads: number };
    html = await page(cookie);
    // Exactly what a GET did before: one new session and one new thread, no more.
    expect(counts()).toEqual({ sessions: before.sessions + 1, threads: before.threads + 1 });
    const workspace = workspaceOf(html);
    expect(workspace.conversation?.messages).toEqual([]);
    expect(workspace.conversation?.previous?.messages.map(one => one.text)).toEqual(["Remember the payments route", "The old route was through the payments project."]);
    expect(html).toContain('<p class="chat-previous-divider" role="separator" data-thread-divider>New conversation — the projects I can reach changed</p>');
    // Reading again, or refreshing the workspace, writes nothing more.
    const after = counts();
    await page(cookie);
    const refreshed = await (await fetch(url("/chat?format=workspace"), { headers: { cookie } })).json() as import("./browser-workspace.js").BrowserWorkspace;
    expect(refreshed.conversation?.previous?.messages).toHaveLength(2);
    expect(counts()).toEqual(after);
    // The new thread's model input carries none of the old thread's words.
    const fresh = csrfFrom(html);
    subscriptionAnswers.push({ text: "Starting fresh.", calls: [], tokensIn: 10, tokensOut: 5, reportedCostMicrousd: null });
    expect((await post(cookie, "/chat", { csrf: fresh, message: "What can you reach now?" })).status).toBe(303);
    await settle();
    expect(subscriptionRequests).toHaveLength(2);
    const input = JSON.stringify(subscriptionRequests[1]);
    expect(input).toContain("What can you reach now?");
    expect(input).not.toContain("payments route");
    expect(input).not.toContain("The old route was through the payments project.");
    // Ending the conversation forgets the current thread; the replaced one is not shown after it.
    expect((await post(cookie, "/chat/mate/end", { csrf: fresh })).status).toBe(303);
    expect(workspaceOf(await page(cookie)).conversation?.previous ?? null).toBeNull();
  });

  test("UI polish 2026-09-13: a membership never shows a dollar figure as a charge on the chat page", async () => {
    store.setChatConfig({ provider: "codex-subscription", model: "default", dailyTurns: 50, weeklyCeilingMicrousd: 0, priceInMicrousd: 0, priceOutMicrousd: 0 }, "alex", T0);
    const cookie = await login();
    const html = await (await fetch(url("/chat?settings=1"), { headers: { cookie } })).text();
    expect(html).toContain('<details class="chat-limits"><summary>Model &amp; limits<span class="meta">membership</span></summary>');
    expect(html).toContain("<span>membership login · no dollar ceiling</span>");
    expect(html).toContain("Uses your Codex membership · no dollar limit · daily turn limits apply");
    const limits = /<details class="chat-limits">.*?<\/details>/s.exec(html)?.[0] ?? "";
    expect(limits).not.toContain("$0.00");
  });

  test("a viewer sees no mint card and cannot mint; a stale-ceiling GET writes nothing", async () => {
    const cookie = await login();
    const csrf = csrfFrom(await page(cookie));
    // A viewer, joined through the real invite road.
    const invite = store.mintInvite("viewer", "alex", clockNow);
    const joined = await fetch(url(`/join/${invite.token}`), { method: "POST", headers: { origin: base }, body: new URLSearchParams({ name: "vic", password: "watching-only-1" }), redirect: "manual" });
    expect(joined.status).toBe(303);
    const viewerCookie = (joined.headers.get("set-cookie") ?? "").split(";")[0] as string;
    const viewerPage = await (await fetch(url("/chat"), { headers: { cookie: viewerCookie } })).text();
    expect(viewerPage).not.toContain('action="/chat/mate/mint"');
    expect(viewerPage).not.toContain('action="/chat/config"');
    expect(viewerPage).toContain("Read-only view");
    const viewerCsrf = /name="csrf" value="([0-9a-f]{64})"/.exec(viewerPage)?.[1] ?? csrf;
    const viewerMint = await fetch(url("/chat/mate/mint"), { method: "POST", headers: { cookie: viewerCookie, origin: base }, body: new URLSearchParams({ csrf: viewerCsrf, "ceiling-usd": "5", token: "watching-only-1" }), redirect: "manual" });
    expect(viewerMint.status).toBe(403);
    expect(store.activeMateSession("vic")).toBeNull();
    // The approver's session, minted under a different repo order than the server holds: the page says so and changes nothing.
    await mint(cookie);
    const live = store.activeMateSession("alex")!;
    store.handle.prepare("UPDATE mate_session SET ceiling_digest = ? WHERE id = ?").run("f".repeat(64), live.id);
    const html = await page(cookie);
    expect(html).toContain("Project access changed. Your tasks and results are saved. Start a conversation with the current projects to continue.");
    // Plain words, not internals (UI polish 2026-09-13): no "admitted",
    // "minted", or "ceiling" reaches the person; the required road — a
    // new password ceremony — is still the only one offered.
    expect(html).not.toContain("admitted projects");
    expect(html).not.toContain("minted");
    expect(html).toContain('action="/chat/mate/mint"');
    expect(store.activeMateSession("alex")).not.toBeNull();
  });

  test("an operator can stop one in-flight turn without ending the conversation", async () => {
    const cookie = await login();
    const csrf = await mint(cookie);
    const session = store.activeMateSession("alex");
    if (session === null) throw new Error("missing session");
    const thread = store.openMateThread("alex", session.ceilingDigest, clockNow).thread;
    const opened = store.openMateTurn(
      {
        approver: "alex",
        session: session.id,
        thread: thread.id,
        credentialKey: session.credentialKey,
        reservedMicrousd: 100,
        dailyTurns: 50,
        weeklyCeilingMicrousd: 100_000_000,
        deadlineMs: 60_000,
      },
      clockNow,
    );
    if (!opened.ok) throw new Error(opened.reason);
    expect(store.startMateTurn(opened.id, clockNow)).toMatchObject({ ok: true });

    let html = await page(cookie);
    expect(html).toContain('action="/chat/mate/stop"');
    expect(html).toContain(`name="turn" value="${opened.id}"`);
    const stopped = await post(cookie, "/chat/mate/stop", { csrf, turn: String(opened.id) });
    expect(stopped.status).toBe(303);
    expect(stopped.headers.get("location")).toBe("/chat#latest");
    expect(store.liveMateTurnFor("alex")).toBeNull();
    expect(store.activeMateSession("alex")).not.toBeNull();
    expect(store.recentMateTurns("alex", 1)[0]).toMatchObject({ state: "failed", failureReason: "stopped" });

    html = await page(cookie);
    expect(html).toContain("stopped — the conversation is still open");
    expect(html).toContain('class="card composer"');
  });

  test("coordinator proposals are cards on /chat and the task page; an irreversible answer confirms only with the field", async () => {
    const { mintCoordinator } = await import("./coordinator.js");
    const { proposeAsCoordinator } = await import("./coordinator-proposals.js");
    const minted = mintCoordinator(store, { name: "planner-bot", repos: [repoDir], by: "alex", now: clockNow });
    if (!minted.ok) throw new Error("mint");
    sealScopeFixture(store, "a", approverToken);
    const run = store.startRun({ taskRef: store.refFor("built-in", "a").id, leaseId: "l", runner: "r", branch: "b", worktree: "/w", now: clockNow, ...presented(store, store.refFor("built-in", "a").id, "builder") });
    store.saveDecision({ run, urgency: "blocking", recap: "RECAP-CANARY", question: "Ship it?", options: [{ id: "go", label: "Ship", consequence: "it ships", reversible: false }], recommendation: "go" }, clockNow);
    expect(proposeAsCoordinator(store, minted.token, "next", { ref: "b" }, clockNow)).toMatchObject({ ok: true, id: 1 });
    expect(proposeAsCoordinator(store, minted.token, "answer", { decision: 1, option: "go", rationale: "tests are green" }, clockNow, { readDecisions: new Set([1]) })).toMatchObject({ ok: true, id: 2 });
    const cookie = await login();
    let html = await page(cookie);
    const csrf = csrfFrom(html);
    expect(html).toContain("Proposed by coordinators");
    expect(html).toContain('action="/proposals/1/confirm"');
    expect(html).toContain('action="/proposals/2/confirm"');
    expect(html).toContain("it ships");
    expect(html).toContain("the builder recommends this");
    expect(html).toContain('name="confirm" value="yes"');
    expect(html).not.toContain("RECAP-CANARY");
    // The task page carries the same card, returning to the task after the act.
    const taskPage = await (await fetch(url("/t/b"), { headers: { cookie } })).text();
    expect(taskPage).toContain('action="/proposals/1/confirm"');
    expect(taskPage).toContain('name="return" value="/t/b"');
    // A backslash return is not same-site to a browser: refused to "/" (v3 review, finding 10).
    const crooked = await post(cookie, "/proposals/999/dismiss", { csrf, return: "/\\evil.example" });
    expect(crooked.headers.get("location")).toBe("/");
    const confirmed = await post(cookie, "/proposals/1/confirm", { csrf, return: "/t/b" });
    expect(confirmed.headers.get("location")).toBe("/t/b");
    expect(store.getCoordinatorProposal(1)).toMatchObject({ state: "confirmed", resolvedBy: "alex" });
    expect(store.queuePosition("b")?.position).toBe(1);
    // The irreversible answer: no field, no answer; with the field, answered as alex via the web.
    await post(cookie, "/proposals/2/confirm", { csrf });
    expect(store.getDecision(1)?.state).toBe("open");
    expect(store.getCoordinatorProposal(2)?.state).toBe("pending");
    await post(cookie, "/proposals/2/confirm", { csrf, confirm: "yes" });
    expect(store.getDecision(1)).toMatchObject({ state: "answered", answeredBy: "alex", answeredVia: "web" });
    html = await page(cookie);
    expect(html).toContain("decision #1 answered: Ship");
  });

  test("a refused turn is said once on the thread; a bearer caller and a viewer have no mate", async () => {
    const cookie = await login();
    const csrf = await mint(cookie);
    const empty = await post(cookie, "/chat", { csrf, message: "   " });
    expect(empty.headers.get("location") ?? "").toContain("characters");
    script.push(() => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }));
    await post(cookie, "/chat", { csrf, message: "hello" });
    await settle();
    let html = await page(cookie);
    expect(html).toContain("malformed");
    expect(html).toContain("Chat is paused.");
    html = await page(cookie);
    expect(html).not.toContain("malformed and was discarded");
    const bearer = await fetch(url("/chat/mate/mint"), { method: "POST", headers: { authorization: `Bearer ${approverToken}`, origin: base }, body: new URLSearchParams({ "ceiling-usd": "5", token: approverToken }), redirect: "manual" });
    expect([401, 403]).toContain(bearer.status);
  });
  test("package 2: the status poll versions the displayed facts — no churn on time or minted nonces — and returns fragments only on change, bound to the lens", async () => {
    const cookie = await login(); const csrf = await mint(cookie);
    const html = await page(cookie);
    const version = /data-chat-version="([a-f0-9]{16})"/.exec(html)?.[1];
    if (version === undefined) throw new Error("no version on the composer");
    // The composer names the account the server knows: the reconnect carry
    // (package 2 revision) is honoured only for that account.
    expect(html).toContain('data-chat-task="" data-chat-user="alex" data-chat-busy="0"');
    expect(html).toContain('<div id="chat-thread" data-chat-region="thread">');
    expect(html).toContain('<button type="button" class="chat-new-update" id="chat-new-update" hidden>New update ↓</button>');
    expect(html).toContain('<p class="meta composer-hint" id="chat-reconnect" hidden><button type="button" class="quiet">Reconnect</button></p>');
    const same = await status(cookie, `?version=${version}`);
    expect(same).toEqual({ session: 1, task: "", version, pending: false, received: false, approval: "" });
    // Ten minutes later, with nothing changed, the version is the same:
    // relative ages are not facts, and no token was minted.
    clockNow = new Date(T0.getTime() + 10 * 60_000);
    expect((await status(cookie, `?version=${version}`))["fragments"]).toBeUndefined();
    expect((await status(cookie, `?version=${version}`))["version"]).toBe(version);
    // A caller with an older version gets the three fragments.
    const fragments = (await status(cookie, "?version=stale"))["fragments"] as Record<string, string | null>;
    expect(fragments["thread"]).toContain('<div id="chat-thread" data-chat-region="thread">');
    expect(fragments["thread"]).toContain('<div class="chat-empty" data-key="empty">');
    expect(fragments["after"]).toContain('<div id="chat-after-composer" data-chat-region="after"><div class="chat-prompts"');
    expect(fragments["live"]).toBeNull();
    // A reply changes the version; the fragment carries the keyed message
    // and card, and the thinking card while a turn is live.
    let finish!: (value: Response) => void;
    script.push(() => new Promise<Response>(resolve => { finish = resolve; }) as unknown as Response);
    await post(cookie, "/chat", { csrf, message: "What is queued?" });
    const live = await status(cookie, `?version=${version}`);
    expect(live["pending"]).toBe(true);
    expect(live["version"]).not.toBe(version);
    expect((live["fragments"] as Record<string, string>)["thread"]).toContain('data-key="pending"');
    expect((live["fragments"] as Record<string, string>)["thread"]).toContain('data-key="m1"><p style="white-space:pre-wrap">What is queued?</p>');
    finish(answer([{ type: "text", text: "Two tasks are queued." }])); await settle();
    const answered = await status(cookie, `?version=${String(live["version"])}`);
    expect(answered["pending"]).toBe(false);
    expect(answered["version"]).not.toBe(live["version"]);
    expect((answered["fragments"] as Record<string, string>)["thread"]).toContain('data-message-role="assistant" data-key="m2" id="latest"');
    expect((answered["fragments"] as Record<string, string>)["thread"]).not.toContain('data-key="starters"');
    expect((answered["fragments"] as Record<string, string>)["after"]).toBe('<div id="chat-after-composer" data-chat-region="after"></div>');
    // The task lens: its own version, its approval digest, a live fragment
    // WITHOUT a password or a nonce, and no churn across polls.
    const focused = await (await fetch(url("/chat?task=a"), { headers: { cookie } })).text();
    const focusedVersion = /data-chat-version="([a-f0-9]{16})"/.exec(focused)?.[1] ?? "";
    const digest = /name="digest" value="([0-9a-f]+)"/.exec(focused)?.[1];
    expect(focused).toContain(`data-chat-approval="${digest}"`);
    expect(focused).toContain(`id="task-chat-live" aria-live="polite" data-task="a" data-execution="a" data-source="/chat/task-status?task=a" data-poll="0" data-approval="${digest}" data-plan=""`);
    const lens = await status(cookie, `?task=a&version=${focusedVersion}`);
    expect(lens).toMatchObject({ session: 1, task: "a", version: focusedVersion, approval: digest });
    expect(lens["fragments"]).toBeUndefined();
    const lensFragments = (await status(cookie, "?task=a&version=stale"))["fragments"] as Record<string, string | null>;
    expect(lensFragments["live"]).toContain('id="task-chat-live"');
    expect(lensFragments["live"]).toContain('data-primary-action>Approve plan</a>');
    expect(lensFragments["live"]).not.toContain('type="password"');
    expect(lensFragments["live"]).not.toContain('name="nonce"');
    // The task keeps its own thread (v77): the lead conversation's message
    // is not in it.
    expect(lensFragments["thread"]).not.toContain('data-key="m1"');
    expect(focusedVersion).not.toBe(String(answered["version"]));
    // Another lens answers with ITS task; an unavailable one says so.
    expect(await status(cookie, "?task=b&version=x")).toMatchObject({ task: "b" });
    expect(await status(cookie, "?task=not-here&version=x")).toEqual({ session: 1, task: "not-here", unavailable: true, received: false });
    const raw = await fetch(url("/chat/mate/status?version=x"), { headers: { cookie } });
    expect(raw.headers.get("cache-control")).toBe("no-store");
  });

  test("package 2: the enhanced send answers JSON on the same endpoint, stays one turn across a lost response and a reload, and refuses a changed session, an empty message, and an unavailable task in JSON", async () => {
    const cookie = await login(); const csrf = await mint(cookie);
    const request = /name="request" value="([a-f0-9]{32})"/.exec(await page(cookie))![1]!;
    const fields = { csrf, message: "What needs me?", request, "request-session": "1" };
    script.push(() => answer([{ type: "text", text: "Nothing needs you." }]));
    const first = await sendJson(cookie, fields);
    expect(first.status).toBe(202);
    expect(first.headers.get("content-type")).toContain("application/json");
    expect(await first.json()).toEqual({ ok: true, session: 1, task: "", request });
    await settle();
    // The response was lost and the page reloaded: the same send, resent
    // by the person, is the same turn — no second dispatch, one message.
    const again = await sendJson(cookie, fields);
    expect(again.status).toBe(202); await settle();
    expect(store.recentMateTurns("alex", 10)).toHaveLength(1);
    expect(script).toHaveLength(0);
    expect(await status(cookie, `?request=${request}`)).toMatchObject({ received: true, pending: false });
    // The native form still redirects.
    const native = await post(cookie, "/chat", fields);
    expect(native.status).toBe(303); await settle();
    expect(store.recentMateTurns("alex", 10)).toHaveLength(1);
    // Refusals carry the server's words, and nothing is dispatched.
    const changed = await sendJson(cookie, { ...fields, "request-session": "2" });
    expect(changed.status).toBe(409);
    expect(await changed.json()).toEqual({ ok: false, said: "This conversation changed. Reload it before sending your message.", session: null });
    const empty = await sendJson(cookie, { ...fields, message: "   " });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toMatchObject({ ok: false, said: expect.stringContaining("1 to"), session: 1 });
    const gone = await sendJson(cookie, { ...fields, task: "not-here" });
    expect(gone.status).toBe(404);
    expect(await gone.json()).toMatchObject({ ok: false, said: "That task is not available in this workspace." });
    expect((await sendJson(cookie, { ...fields, csrf: "bad" })).status).toBe(403);
    expect(store.recentMateTurns("alex", 10)).toHaveLength(1);
    // After the conversation ends, a JSON send says so instead of minting.
    await post(cookie, "/chat/mate/end", { csrf });
    const ended = await sendJson(cookie, fields);
    expect(ended.status).toBe(409);
    expect(await ended.json()).toEqual({ ok: false, said: "This conversation ended. Reload to continue.", session: null });
    expect((await status(cookie))["session"]).toBeNull();
  });

  test("package 2: two task lenses keep their own drafts' context — each send carries its task to the provider, and one lens's receipt cannot settle or submit the other's", async () => {
    const cookie = await login();
    let html = await page(cookie);
    let csrf = csrfFrom(html);
    await post(cookie, "/chat/config", { csrf, provider: "codex-subscription", model: "default", "weekly-usd": "100", "daily-turns": "25", token: approverToken });
    expect((await post(cookie, "/chat/mate/mint", { csrf, token: approverToken })).status).toBe(303);
    html = await (await fetch(url("/chat?task=a"), { headers: { cookie } })).text();
    csrf = csrfFrom(html);
    expect(html).toContain('data-chat-task="a"');
    const requestA = /name="request" value="([a-f0-9]{32})"/.exec(html)![1]!;
    const requestB = /name="request" value="([a-f0-9]{32})"/.exec(await (await fetch(url("/chat?task=b"), { headers: { cookie } })).text())![1]!;
    expect(requestA).not.toBe(requestB);
    subscriptionAnswers.push({ text: "About a.", calls: [], tokensIn: 10, tokensOut: 5, reportedCostMicrousd: null });
    expect((await sendJson(cookie, { csrf, task: "a", message: "Where is this?", request: requestA, "request-session": "1" })).status).toBe(202);
    await settle();
    subscriptionAnswers.push({ text: "About b.", calls: [], tokensIn: 10, tokensOut: 5, reportedCostMicrousd: null });
    expect((await sendJson(cookie, { csrf, task: "b", message: "Where is this?", request: requestB, "request-session": "1" })).status).toBe(202);
    await settle();
    expect(subscriptionRequests).toHaveLength(2);
    const contextOf = (index: number): string => [...subscriptionRequests[index]!.history].reverse().find(one => one.role === "operator")?.text ?? "";
    expect(contextOf(0)).toContain("Current task: a.");
    expect(contextOf(0)).toContain("Where is this?");
    expect(contextOf(1)).toContain("Current task: b.");
    // Each lens's status answers with its task; the receipt is per request.
    expect(await status(cookie, `?task=a&request=${requestA}`)).toMatchObject({ task: "a", received: true });
    expect(await status(cookie, `?task=b&request=${requestB}`)).toMatchObject({ task: "b", received: true });
    expect(await status(cookie, `?task=a&request=${requestB}`)).toMatchObject({ task: "a", received: true });
    // The same request key under the OTHER task's context is a different
    // message: the engine refuses it rather than replaying a's turn as b's.
    expect((await sendJson(cookie, { csrf, task: "b", message: "Where is this?", request: requestA, "request-session": "1" })).status).toBe(202);
    await settle();
    expect(store.recentMateTurns("alex", 10)).toHaveLength(2);
    expect(subscriptionRequests).toHaveLength(2);
    expect(await (await fetch(url("/chat?task=b"), { headers: { cookie } })).text()).toContain("different text or task context");
    // Each task keeps its own thread (v77): the lead conversation shows
    // neither message, and each lens's page shows only its own.
    const unified = await page(cookie);
    expect(unified.match(/data-message-role="operator"/g)).toBeNull();
    expect(unified).toContain('data-chat-task=""');
    for (const lens of ["a", "b"]) expect((await (await fetch(url(`/chat?task=${lens}`), { headers: { cookie } })).text()).match(/data-message-role="operator"/g)).toHaveLength(1);
  });

  test("package 2: changed terms during password entry — the stale form is refused by the server, the status names the new digest, and the fresh page's form approves", async () => {
    const cookie = await login();
    const opening = csrfFrom(await page(cookie));
    expect((await post(cookie, "/chat/mate/mint", { csrf: opening, "ceiling-usd": "5", token: approverToken, return: "/chat?task=a" })).status).toBe(303);
    const before = await (await fetch(url("/chat?task=a"), { headers: { cookie } })).text();
    const csrf = csrfFrom(before);
    const oldNonce = /name="nonce" value="([0-9a-f]+)"/.exec(before)?.[1] ?? "";
    const oldDigest = /name="digest" value="([0-9a-f]+)"/.exec(before)?.[1] ?? "";
    expect(oldNonce).not.toBe(""); expect(oldDigest).not.toBe("");
    expect(await status(cookie, "?task=a")).toMatchObject({ approval: oldDigest });
    // The scope changes while the form is open (the console's own edit).
    const edited = await post(cookie, "/t/a/scope", { csrf, acceptance: "c1: a is done. | manual-review", sawDigest: store.getScope("a")!.digest, goal: "do a, but narrower", not: "", touches: "" });
    expect(edited.status).toBe(303);
    const after = await status(cookie, "?task=a");
    expect(after["approval"]).not.toBe(oldDigest);
    expect(after["approval"]).toBe(store.getScope("a")!.digest);
    // The old form, submitted anyway: refused, nothing approved.
    const stale = await post(cookie, "/t/a/approve", { csrf, nonce: oldNonce, digest: oldDigest, token: approverToken, return: "/chat?task=a" });
    expect(stale.status).toBe(303);
    expect(decodeURIComponent(stale.headers.get("location") ?? "")).toContain("changed while this form was open");
    expect(approvalOf(store.getScope("a"))).toMatchObject({ approved: false });
    // Explicit review: the fresh page restates the current terms and its
    // form — new nonce, new digest — approves.
    const fresh = await (await fetch(url("/chat?task=a"), { headers: { cookie } })).text();
    expect(fresh).toContain("do a, but narrower");
    const newNonce = /name="nonce" value="([0-9a-f]+)"/.exec(fresh)?.[1] ?? "";
    const newDigest = /name="digest" value="([0-9a-f]+)"/.exec(fresh)?.[1] ?? "";
    expect(newDigest).toBe(after["approval"]); expect(newNonce).not.toBe(oldNonce);
    const approved = await post(cookie, "/t/a/approve", { csrf, nonce: newNonce, digest: newDigest, token: approverToken, return: "/chat?task=a" });
    expect(approved.headers.get("location")).toBe("/chat?task=a");
    expect(approvalOf(store.getScope("a"))).toMatchObject({ approved: true, by: "alex" });
    expect(await status(cookie, "?task=a")).toMatchObject({ approval: "" });
  });

  test("package 2 revision: from All projects (two admitted projects, none chosen) the status poll and the task fragment answer, never bounce to the opener; a task outside the ceiling is unavailable; the page's other guards stay exact", async () => {
    // Build 1550 annotation 100: `needsProject` exempted `/chat` but not
    // its read-only refresh routes, so a signed-in reader in All projects
    // got a 303 to /projects (HTML) on every poll and the page said the
    // sign-in was lost. The exemption is these two exact paths only.
    const repoTwo = realpathSync(mkdtempSync(join(tmpdir(), "standing-orders-mate-repo2-")));
    const repoOutside = realpathSync(mkdtempSync(join(tmpdir(), "standing-orders-mate-repo3-")));
    for (const [id, repo] of [["c", repoTwo], ["z", repoOutside]] as const) {
      const made = store.createConsoleTask({ id, title: `task ${id}`, repo, goal: `do ${id}`, acceptance: [{ id: "c1", statement: `${id} is done.`, evidence: ["manual-review"] }], filedVia: "cli" }, T0);
      if (!made.ok) throw new Error(made.reason);
    }
    const two = createDecisionServer({
      store, evidenceRoot, clock: () => clockNow, repos: [repoDir, repoTwo], chatEnv: { ANTHROPIC_API_KEY: "sk-test-key" },
      chatFetcher: (async () => { throw new Error("no provider call expected"); }) as typeof fetch,
      subscriptionChatRunner: async () => { throw new Error("no provider call expected"); },
    });
    await new Promise<void>(resolve => two.listen(0, "127.0.0.1", resolve));
    const twoAddress = two.address();
    if (typeof twoAddress !== "object" || twoAddress === null) throw new Error("no address");
    const twoBase = `http://127.0.0.1:${twoAddress.port}`;
    try {
      const signedIn = await fetch(`${twoBase}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token: approverToken }), redirect: "manual" });
      const cookie = (signedIn.headers.get("set-cookie") ?? "").split(";")[0] as string;
      // No project chosen: the chat page opens (as before) and mints.
      const opener = await fetch(`${twoBase}/chat`, { headers: { cookie }, redirect: "manual" });
      expect(opener.status).toBe(200);
      const html = await opener.text();
      expect(html).toContain('action="/chat/mate/mint"');
      const csrf = csrfFrom(html);
      const minted = await fetch(`${twoBase}/chat/mate/mint`, { method: "POST", headers: { cookie, origin: twoBase }, body: new URLSearchParams({ csrf, "ceiling-usd": "5", token: approverToken }), redirect: "manual" });
      expect(minted.headers.get("location")).toBe("/chat");
      const composer = await (await fetch(`${twoBase}/chat`, { headers: { cookie } })).text();
      expect(composer).toContain('data-chat-task="" data-chat-user="alex"');
      const poll = async (query: string) => fetch(`${twoBase}/chat/mate/status${query}`, { headers: { cookie }, redirect: "manual" });
      // The poll from All projects: JSON, no-store, the live session.
      const all = await poll("?version=x");
      expect(all.status).toBe(200);
      expect(all.headers.get("content-type")).toContain("application/json");
      expect(all.headers.get("cache-control")).toBe("no-store");
      const allBody = await all.json() as Record<string, unknown>;
      expect(allBody).toMatchObject({ task: "", pending: false, received: false, approval: "" });
      expect(typeof allBody["session"]).toBe("number");
      expect((allBody["fragments"] as Record<string, unknown>)["thread"]).toContain('id="chat-thread"');
      // A task lens in EITHER admitted project answers with its live region, still without choosing a project.
      for (const id of ["a", "c"]) {
        const lens = await (await poll(`?task=${id}&version=x`)).json() as Record<string, unknown>;
        expect(lens).toMatchObject({ task: id, pending: false });
        expect((lens["fragments"] as Record<string, string | null>)["live"]).toContain(`id="task-chat-live" aria-live="polite" data-task="${id}"`);
        const fragment = await fetch(`${twoBase}/chat/task-status?task=${id}`, { headers: { cookie }, redirect: "manual" });
        expect(fragment.status).toBe(200);
        expect(await fragment.text()).toContain(`data-task="${id}"`);
        expect((await fetch(`${twoBase}/chat?task=${id}`, { headers: { cookie }, redirect: "manual" })).status).toBe(200);
      }
      // A task outside the ceiling, like an unknown one, is unavailable — never rendered, never a redirect.
      const denied = await poll("?task=z&version=x");
      expect(denied.status).toBe(200);
      expect(await denied.json()).toMatchObject({ task: "z", unavailable: true, received: false });
      expect((await fetch(`${twoBase}/chat/task-status?task=z`, { headers: { cookie }, redirect: "manual" })).status).toBe(404);
      expect(await (await poll("?task=nope&version=x")).json()).toMatchObject({ task: "nope", unavailable: true });
      // The route's own guards are untouched: no cookie, a bearer, and a
      // viewer-only standing are refused; other collections still bounce
      // to the opener from All projects.
      expect((await fetch(`${twoBase}/chat/mate/status`, { redirect: "manual" })).status).toBe(303);
      expect((await fetch(`${twoBase}/chat/task-status?task=a`, { redirect: "manual" })).status).toBe(303);
      expect((await fetch(`${twoBase}/chat/mate/status`, { headers: { authorization: `Bearer alex:${approverToken}` }, redirect: "manual" })).status).toBe(403);
      const bounced = await fetch(`${twoBase}/board`, { headers: { cookie }, redirect: "manual" });
      expect(bounced.status).toBe(303);
      expect(bounced.headers.get("location")).toBe("/projects?return=%2Fboard");
      // Choosing a project afterwards keeps polling (the earlier behaviour).
      const chosen = await fetch(`${twoBase}/projects/select`, { method: "POST", headers: { cookie, origin: twoBase }, body: new URLSearchParams({ csrf, path: repoTwo, return: "/chat" }), redirect: "manual" });
      expect(chosen.status).toBe(303);
      expect((await (await poll("?task=c&version=x")).json() as Record<string, unknown>)["task"]).toBe("c");
    } finally {
      await new Promise<void>(resolve => two.close(() => resolve()));
      rmSync(repoTwo, { recursive: true, force: true });
      rmSync(repoOutside, { recursive: true, force: true });
    }
  });

  test("package 2: revoked standing, a changed ceiling, and an anonymous or bearer caller fail the poll and the send safely", async () => {
    const cookie = await login(); const csrf = await mint(cookie);
    const request = "b".repeat(32);
    expect((await status(cookie))["session"]).toBe(1);
    // A viewer-only login (approver standing lost) is refused, never
    // answered with somebody else's thread.
    expect((await fetch(url("/chat/mate/status"), { redirect: "manual" })).status).toBe(303);
    expect((await fetch(url("/chat/mate/status"), { headers: { authorization: `Bearer alex:${approverToken}` } })).status).toBe(403);
    // Revocation bumps the approver generation and ends the session's
    // authority: the poll reports no session (or refuses outright) and the
    // send refuses — no turn is dispatched under the old standing.
    const other = addApprover(store, "sam", clockNow, { name: "alex", token: approverToken });
    if (!other.ok) throw new Error(`second approver failed: ${other.reason}`);
    const revoked = store.revokeAccount("alex", "sam", clockNow);
    if (!revoked.ok) throw new Error(`revoke failed: ${revoked.reason}`);
    const gone = await fetch(url("/chat/mate/status"), { headers: { cookie }, redirect: "manual" });
    expect([200, 303, 403]).toContain(gone.status);
    if (gone.status === 200) expect(await gone.json()).toEqual({ session: null });
    const refused = await sendJson(cookie, { csrf, message: "Still me?", request, "request-session": "1" });
    expect([303, 401, 403, 409]).toContain(refused.status);
    expect(store.recentMateTurns("alex", 10)).toHaveLength(0);
  });
});

describe("scout tasks and the digest card on the console (mate arc §10)", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let evidenceRoot: string;
  let dir: string;
  let approverToken: string;

  const login = async (at = base): Promise<string> => {
    const response = await fetch(`${at}/login`, {
      method: "POST",
      body: new URLSearchParams({ name: "alex", token: approverToken }),
      redirect: "manual",
    });
    return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
  };

  beforeEach(async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    dir = mkdtempSync(join(tmpdir(), "standing-orders-serve-scout-"));
    evidenceRoot = join(dir, "evidence");
    mkdirSync(evidenceRoot, { recursive: true });
    writeFileSync(join(dir, "telegram-token"), "777000:AAExampleExampleExample123\n", { mode: 0o600 });
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;
    server = createDecisionServer({ store, evidenceRoot, clock: () => new Date(), telegramTokenFile: join(dir, "telegram-token") });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("the new-task form files a scout; the task page says so; the report renders verified and a follow-up files with the scout's authorship", async () => {
    const cookie = await login();
    const form = await (await fetch(`${base}/tasks/new`, { headers: { cookie } })).text();
    expect(form).toContain('name="scout"');
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(form)?.[1] ?? "";
    const revision = /name="projectRevision" value="(\d+)"/.exec(form)?.[1] ?? "0";
    const filed = await fetch(`${base}/tasks/add`, {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ acceptance: "c1: ok | manual-review", csrf, projectRevision: revision, title: "why does login flake", goal: "find out", repo: "/repo/main", scout: "1" }),
      redirect: "manual",
    });
    expect(filed.status).toBe(303);
    const taskId = /\/t\/([^/?]+)/.exec(filed.headers.get("location") ?? "")?.[1] ?? "";
    const ref = store.refFor("built-in", taskId);
    expect(ref.deliverable).toBe("report");
    let page = await (await fetch(`${base}/t/${taskId}`, { headers: { cookie } })).text();
    expect(page).toContain(">Scout<");
    expect(page).toContain("delivers a report, never a branch");
    // Said INSIDE the ceremony: the yes buys a report, not a branch.
    expect(page).toContain("Read-only: it reports back and changes nothing in the repository.");
    expect(page).toContain("An agent investigates without changing the repository. You'll hear when its report is ready.");

    // The report lands as evidence; the page renders it only once verified.
    sealScopeFixture(store, taskId, approverToken);
    const run = store.startRun({ taskRef: ref.id, leaseId: "scout-lease", runner: "b", role: "scout", branch: "standing-orders-scout/x", worktree: "/pool/scout", now: new Date(), ...presented(store, ref.id, "scout") });
    const { mkdirSync: mkdirS, writeFileSync: writeS } = await import("node:fs");
    mkdirS(join(evidenceRoot, String(run)), { recursive: true });
    // A screenshot the scout saved, stored as evidence and tied to its item.
    const shot = Buffer.alloc(600);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(shot, 0);
    writeS(join(evidenceRoot, String(run), "report-image-1.png"), shot);
    const shotSha = createHash("sha256").update(shot).digest("hex");
    const shotId = store.saveArtifact({ run, kind: "screenshot", key: `${run}/report-image-1.png`, bytesOriginal: shot.length, bytesStored: shot.length, truncated: false, sha256: shotSha, capture: "scout screenshot login.png (validated png) from https://app.example.com/login" }, new Date());
    const report = { title: "The cookie races the assertion", summary: "The read wins under load.", report: "## Findings\nAsync cookie in src/session.ts.\n", followUps: [{ title: "Await the cookie", goal: "Wait for it before asserting." }],
      items: [{ title: "The login page sets the cookie late", why: "The response sets it after the redirect.", url: "https://app.example.com/login", image: "login.png" }],
      images: [{ file: "login.png", caption: "The login page after submitting", url: "https://app.example.com/login", sha256: shotSha, artifact: shotId }] };
    const content = Buffer.from(JSON.stringify(report, null, 2), "utf8");
    writeS(join(evidenceRoot, String(run), "report.json"), content);
    store.saveArtifact({ run, kind: "report", key: `${run}/report.json`, bytesOriginal: content.length, bytesStored: content.length, truncated: false, sha256: createHash("sha256").update(content).digest("hex"), capture: "scout handoff (verified tree)" }, new Date());
    store.finishRun(run, { outcome: "built", reason: "report-delivered", now: new Date() });
    page = await (await fetch(`${base}/t/${taskId}`, { headers: { cookie } })).text();
    expect(page).toContain("The cookie races the assertion");
    expect(page).toContain("Async cookie in src/session.ts.");
    expect(page).toContain("File this follow-up");
    // Its items, each with its link and screenshot.
    expect(page).toContain("What it found");
    expect(page).toContain("The login page sets the cookie late");
    expect(page).toContain('href="https://app.example.com/login" rel="noopener noreferrer nofollow"');
    expect(page).toContain(`<img src="/r/${run}/evidence/${shotId}" alt="The login page after submitting"`);
    const image = await fetch(`${base}/r/${run}/evidence/${shotId}`, { headers: { cookie } });
    expect(image.headers.get("content-type")).toBe("image/png");

    // A tampered file never renders: the problem is named instead.
    writeS(join(evidenceRoot, String(run), "report.json"), content.toString("utf8").replace("Async", "Sync"));
    const tampered = await (await fetch(`${base}/t/${taskId}`, { headers: { cookie } })).text();
    expect(tampered).not.toContain("cookie in src/session.ts");
    expect(tampered).toContain("does not verify");
    const noFile = await fetch(`${base}/t/${taskId}/follow-up`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf, index: "0" }), redirect: "manual" });
    expect(noFile.status).toBe(409);
    writeS(join(evidenceRoot, String(run), "report.json"), content);

    // The follow-up files through the one door: same repo, the scout's authorship.
    const followUp = await fetch(`${base}/t/${taskId}/follow-up`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf, index: "0" }), redirect: "manual" });
    expect(followUp.status).toBe(303);
    const filedId = /\/t\/([^/?]+)/.exec(followUp.headers.get("location") ?? "")?.[1] ?? "";
    expect(store.getTask(filedId)?.title).toBe("Await the cookie");
    expect(store.refFor("built-in", filedId).repo).toBe("/repo/main");
    expect(store.handle.prepare("SELECT proposed_via FROM task_scope WHERE task_id = ?").get(filedId)?.["proposed_via"]).toBe("scout");
    const missing = await fetch(`${base}/t/${taskId}/follow-up`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf, index: "7" }), redirect: "manual" });
    expect(missing.status).toBe(409);
    // Idempotent (v4 review, finding 10): the same tap again lands on the same task, no twin.
    const again = await fetch(`${base}/t/${taskId}/follow-up`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf, index: "0" }), redirect: "manual" });
    expect(again.status).toBe(303);
    expect(again.headers.get("location")).toBe(followUp.headers.get("location"));
    expect(store.listTasksScoped(null, undefined, 100, null).filter(one => one.title === "Await the cookie")).toHaveLength(1);
  });

  test("the /next ceremony says the yes buys a report, not a branch (v4 review, finding 9)", async () => {
    const cookie = await login();
    const form = await (await fetch(`${base}/tasks/new`, { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(form)?.[1] ?? "";
    const revision = /name="projectRevision" value="(\d+)"/.exec(form)?.[1] ?? "0";
    await fetch(`${base}/tasks/add`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ acceptance: "c1: ok | manual-review", csrf, projectRevision: revision, title: "scout me", goal: "find out", repo: "/repo/main", scout: "1" }), redirect: "manual" });
    const next = await (await fetch(`${base}/next`, { headers: { cookie } })).text();
    expect(next).toContain("Approve exactly this:");
    expect(next).toContain("a read-only session investigates this goal and delivers a report");
  });

  test("Settings → Notifications saves each person's own choice: Only when I'm needed, Every step, an evening digest", async () => {
    const cookie = await login();
    let page = await (await fetch(`${base}/settings`, { headers: { cookie } })).text();
    expect(page).toContain("Only when I'm needed");
    expect(page).toContain("Every step");
    expect(page).toContain("Evening digest");
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(page)?.[1] ?? "";
    const post = (fields: Record<string, string>) => fetch(`${base}/settings/notifications`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf, ...fields }), redirect: "manual" });
    expect((await post({ mode: "loud" })).status).toBe(400);
    expect((await post({ mode: "quiet", digest: "25:00" })).status).toBe(400);
    expect((await post({ mode: "all", digest: "19:00" })).status).toBe(303);
    expect(store.notificationPreference("alex")).toMatchObject({ mode: "all", digestAt: "19:00" });
    page = await (await fetch(`${base}/settings`, { headers: { cookie } })).text();
    expect(page).toContain('value="19:00" selected');
    expect((await post({ mode: "quiet", digest: "off" })).status).toBe(303);
    expect(store.notificationPreference("alex")).toMatchObject({ mode: "quiet", digestAt: null });
    // Screenshots with results: Off by default, then First one or Up to 4; nothing else.
    expect(store.notificationPreference("alex").screenshots).toBe("off");
    expect(page).toContain("Screenshots with results");
    expect((await post({ screenshots: "some" })).status).toBe(400);
    expect((await post({ screenshots: "first" })).status).toBe(303);
    expect(store.notificationPreference("alex")).toMatchObject({ mode: "quiet", screenshots: "first" });
    expect((await post({ screenshots: "all" })).status).toBe(303);
    page = await (await fetch(`${base}/settings`, { headers: { cookie } })).text();
    expect(page).toContain('value="all" selected>Up to 4');
    expect((await post({ screenshots: "off" })).status).toBe(303);
    expect(store.notificationPreference("alex").screenshots).toBe("off");
    expect((await fetch(`${base}/settings/notifications`, { method: "POST", body: new URLSearchParams({ mode: "all" }) })).status).toBe(401);
  });

  test("c3: Settings → Notifications mutes one project's pings; Tasks and the evening digest still show it", async () => {
    store.upsertProject("/repo/main", "main", T0);
    store.upsertProject("/repo/side", "side", T0);
    const cookie = await login();
    let page = await (await fetch(`${base}/settings`, { headers: { cookie } })).text();
    expect(page).toContain('action="/settings/notifications/mute"');
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(page)?.[1] ?? "";
    const post = (fields: Record<string, string>) => fetch(`${base}/settings/notifications/mute`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf, ...fields }), redirect: "manual" });
    expect((await post({ repo: "/repo/nowhere" })).status).toBe(400);
    // A switch turned off sends no `pings`: the project is muted.
    const muted = await post({ repo: "/repo/main" });
    expect(muted.status).toBe(303);
    expect(decodeURIComponent(muted.headers.get("location") ?? "")).toContain("main muted. It still shows in Tasks and your evening digest.");
    expect(store.mutedProjects("alex")).toEqual(["/repo/main"]);
    page = await (await fetch(`${base}/settings`, { headers: { cookie } })).text();
    expect(page).toMatch(/main <span class="meta">· muted<\/span>/);
    // A muted project's fact pings nobody here, but the console's facts and the evening digest keep it.
    store.createTask({ id: "quiet-one", title: "Tidy the release notes" }, T0);
    store.placeTask(store.refFor("built-in", "quiet-one").id, "/repo/main", {}, T0);
    const fact = store.listNotifications("all").find(one => one.taskId === "quiet-one")!;
    expect(store.pingAllowed(fact, "alex")).toBe(false);
    expect(store.taskFactsSince(new Date(T0.getTime() - 1000).toISOString()).some(one => one.taskId === "quiet-one")).toBe(true);
    expect((await post({ repo: "/repo/main", pings: "on" })).status).toBe(303);
    expect(store.mutedProjects("alex")).toEqual([]);
    expect(store.pingAllowed(fact, "alex")).toBe(true);
    expect((await fetch(`${base}/settings/notifications/mute`, { method: "POST", body: new URLSearchParams({ repo: "/repo/main" }) })).status).toBe(401);
  });

  test("the digest card sets the cadence from a closed list; the choice lands in the store and says so", async () => {
    const cookie = await login();
    // The installation's cadence bundles Every step updates only; quiet chat has no routine messages to bundle.
    let page = await (await fetch(`${base}/settings`, { headers: { cookie } })).text();
    expect(page).not.toContain("Telegram digest");
    store.setNotificationPreference("alex", { mode: "all" }, "alex", T0);
    page = await (await fetch(`${base}/settings`, { headers: { cookie } })).text();
    expect(page).toContain("Telegram digest");
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(page)?.[1] ?? "";
    const bad = await fetch(`${base}/settings/telegram-digest`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf, every: "17" }), redirect: "manual" });
    expect(bad.status).toBe(400);
    const saved = await fetch(`${base}/settings/telegram-digest`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf, every: "240" }), redirect: "manual" });
    expect(saved.status).toBe(303);
    expect(store.telegramDigest()).toMatchObject({ everyMs: 4 * 3_600_000, setBy: "alex" });
    page = await (await fetch(`${base}/settings`, { headers: { cookie } })).text();
    expect(page).toContain('value="240" selected');
    expect(page).toContain("0 routine fact(s) held");
    const off = await fetch(`${base}/settings/telegram-digest`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf, every: "off" }), redirect: "manual" });
    expect(off.status).toBe(303);
    expect(store.telegramDigest().everyMs).toBeNull();
    const anonymous = await fetch(`${base}/settings/telegram-digest`, { method: "POST", body: new URLSearchParams({ every: "60" }) });
    expect(anonymous.status).toBe(401);
  });

  test("Settings groups every destination once, the same with and without the script, and each chat app says its state", async () => {
    const withApps = createDecisionServer({ store, evidenceRoot, clock: () => new Date(), telegramTokenFile: join(dir, "telegram-token"), configDir: dir });
    await new Promise<void>(resolve => withApps.listen(0, "127.0.0.1", resolve));
    const address = withApps.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    const at = `http://127.0.0.1:${address.port}`;
    const cookie = await login(at);
    const overview = async () => {
      const page = await (await fetch(`${at}/settings`, { headers: { cookie } })).text();
      const data = await (await fetch(`${at}/settings?format=workspace`, { headers: { cookie } })).json() as import("./browser-workspace.js").BrowserWorkspace;
      const view = data.view as import("./browser-workspace.js").BrowserSettingsView;
      const nav = /<nav class="settings-tiles"[\s\S]*?<\/nav>/.exec(page)?.[0] ?? "";
      return { view, nav, chat: Object.fromEntries(view.groups.flatMap(group => group.tiles).filter(tile => tile.status).map(tile => [tile.label, tile.status!.words])) };
    };
    try {
      // Only a Telegram token: it is the one service, so it gets the alerts.
      let { view, nav, chat } = await overview();
      expect(view.groups.map(group => group.title)).toEqual(["Agents", "Automation", "Chat apps", "Access and rules", "System"]);
      const hrefs = view.groups.flatMap(group => group.tiles.map(tile => tile.href));
      expect(new Set(hrefs).size).toBe(hrefs.length);
      expect([...hrefs].sort()).toEqual(["approval", "backups", "data", "discord", "flows", "integrations", "knowledge", "lead", "learning", "models", "monitoring", "policy",
        "project", "retention", "sessions", "sign-in", "skills", "slack", "storage", "teams", "telegram", "tools", "updates"].map(one => `/settings/${one}`));
      // The page without the script lists the same headings and links, in the same order.
      expect([...nav.matchAll(/<h2>([^<]+)<\/h2>/g)].map(one => one[1])).toEqual(view.groups.map(group => group.title));
      expect([...nav.matchAll(/<a href="([^"]+)"/g)].map(one => one[1])).toEqual(hrefs);
      expect(chat).toEqual({ Telegram: "Gets alerts", Slack: "Not set up", Discord: "Not set up", Teams: "Not set up" });
      expect(nav).toContain('provider-status--ok"><i aria-hidden="true"></i>Gets alerts');

      // Two services and no choice: neither claims the alerts.
      saveSlackCredentials(dir, { installation: "installation-test", team: "TTEST", app: "ATEST", bot: "UBOT", workspace: "Test workspace", appToken: "xapp-fixture", botToken: "xoxb-fixture" });
      ({ chat } = await overview());
      expect(chat).toMatchObject({ Telegram: "Connected", Slack: "Connected" });

      // A saved delivery problem is a warning, never "Connected".
      store.acquireBridgeLease("777000", "bridge", 60_000, T0);
      store.setTelegramPush("777000", { url: "https://console.example/telegram", problem: "Telegram could not reach that address" }, T0);
      ({ view, nav, chat } = await overview());
      expect(chat.Telegram).toBe("Has a problem");
      expect(view.groups.find(group => group.title === "Chat apps")?.tiles[0]?.status?.tone).toBe("warn");
      expect(nav).toContain('provider-status--warn"><i aria-hidden="true"></i>Has a problem');
    } finally {
      await new Promise<void>(resolve => withApps.close(() => resolve()));
    }
  });

  test("Settings chooses the global permission default and each task can override the sealed profile", async () => {
    store.createTask({ id: "existing-auto", title: "existing automatic task" }, T0);
    propose(store, { taskId: "existing-auto", goal: "keep the current permission profile", now: T0 });
    const cookie = await login();
    let settings = await (await fetch(`${base}/settings`, { headers: { cookie } })).text();
    expect(settings).toContain("Unattended permissions");
    expect(settings).toContain('name="permission-mode" value="auto" checked');
    // The rebuilt Settings view reads the same defaults the fallback shows.
    const settingsData = await (await fetch(`${base}/settings?format=workspace`, { headers: { cookie } })).json() as import("./browser-workspace.js").BrowserWorkspace;
    expect(settingsData.view).toMatchObject({ kind: "settings", permission: { mode: "auto", canManage: true }, quality: { mode: "default", canManage: true } });
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(settings)?.[1] ?? "";
    const permissionForm = /<form method="post" action="\/settings\/permission-default"[\s\S]*?<\/form>/.exec(settings)?.[0] ?? "";
    expect(permissionForm).toContain(`name="csrf" value="${csrf}"`);

    const global = await fetch(`${base}/settings/permission-default`, {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, "permission-mode": "bypassPermissions" }),
      redirect: "manual",
    });
    expect(global.status).toBe(303);
    expect(store.permissionDefault()).toMatchObject({ mode: "bypassPermissions", updatedBy: "alex" });

    const existingPage = await (await fetch(`${base}/t/existing-auto`, { headers: { cookie } })).text();
    const existingPermissionField = /<fieldset class="permission-field">[\s\S]*?<\/fieldset>/.exec(existingPage)?.[0] ?? "";
    expect(existingPermissionField).toContain('name="permission-mode" value="auto" checked');

    const fresh = await (await fetch(`${base}/tasks/new`, { headers: { cookie } })).text();
    expect(fresh).toContain('name="permission-mode" value="bypassPermissions" checked');
    const revision = /name="projectRevision" value="(\d+)"/.exec(fresh)?.[1] ?? "0";
    const filed = await fetch(`${base}/tasks/add`, {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ acceptance: "c1: ok | manual-review",
        csrf,
        projectRevision: revision,
        title: "unattended permissions proof",
        goal: "prove the permission policy flows end to end",
        repo: "/repo/main",
        "plan-first": "0",
        "planning-policy": "choice",
        "permission-mode": "bypassPermissions",
      }),
      redirect: "manual",
    });
    expect(filed.status).toBe(303);
    const taskId = decodeURIComponent((filed.headers.get("location") ?? "").split("/").at(-1) ?? "");
    const full = store.getScope(taskId);
    expect(store.refFor("built-in", taskId).permissionMode).toBe("bypassPermissions");
    expect(full?.profile).toMatchObject({ provider: "claude", permissionArgv: "bypassPermissions" });

    let taskPage = await (await fetch(`${base}/t/${encodeURIComponent(taskId)}`, { headers: { cookie } })).text();
    expect(taskPage).toContain('name="permission-mode" value="bypassPermissions" checked');
    const sawDigest = /name="sawDigest" value="([0-9a-f]{32})"/.exec(taskPage)?.[1] ?? "";
    const changed = await fetch(`${base}/t/${encodeURIComponent(taskId)}/scope`, {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ acceptance: "c1: ok | manual-review",
        csrf,
        sawDigest,
        goal: "prove the permission policy flows end to end",
        not: "",
        touches: "",
        "permission-mode": "auto",
      }),
      redirect: "manual",
    });
    expect(changed.status).toBe(303);
    const automatic = store.getScope(taskId);
    expect(automatic?.digest).not.toBe(full?.digest);
    expect(store.refFor("built-in", taskId).permissionMode).toBe("auto");
    expect(automatic?.profile).toMatchObject({ provider: "claude", permissionArgv: "auto" });
    settings = await (await fetch(`${base}/settings`, { headers: { cookie } })).text();
    expect(settings).toContain('name="permission-mode" value="bypassPermissions" checked');

    // A Codex task also keeps the profile it already filed if the global
    // starting value changes later; editing unrelated scope text must not
    // silently re-sandbox it.
    store.setPhaseConfig("installation", "build", "codex", "gpt-5-codex", "alex", T0);
    store.setPhaseConfig("installation", "plan", "codex", "gpt-5-codex", "alex", T0); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "codex", "gpt-5-codex", "alex", T0);
    store.createTask({ id: "existing-codex-full", title: "existing Codex full task" }, T0);
    propose(store, {
      taskId: "existing-codex-full",
      goal: "keep the current Codex permission profile",
      now: T0,
    });
    store.setPermissionDefault("auto", "alex", T0);
    const codexPage = await (await fetch(`${base}/t/existing-codex-full`, { headers: { cookie } })).text();
    const codexPermissionField = /<fieldset class="permission-field">[\s\S]*?<\/fieldset>/.exec(codexPage)?.[0] ?? "";
    expect(codexPermissionField).toContain('name="permission-mode" value="bypassPermissions" checked');
  });

  test("Settings chooses the global quality default and a task can sign its own override", async () => {
    const cookie = await login();
    let settings = await (await fetch(`${base}/settings`, { headers: { cookie } })).text();
    expect(settings).toContain("quality mode");
    expect(settings).toContain('name="quality-mode" value="default" checked');
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(settings)?.[1] ?? "";

    const global = await fetch(`${base}/settings/quality-default`, {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, "quality-mode": "strict" }),
      redirect: "manual",
    });
    expect(global.status).toBe(303);
    expect(store.qualityDefault()).toMatchObject({ mode: "strict", updatedBy: "alex" });

    const fresh = await (await fetch(`${base}/tasks/new`, { headers: { cookie } })).text();
    expect(fresh).toContain('<option value="strict" selected>Strict / release</option>');
    const revision = /name="projectRevision" value="(\d+)"/.exec(fresh)?.[1] ?? "0";
    const filed = await fetch(`${base}/tasks/add`, {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({
        csrf,
        projectRevision: revision,
        title: "fast evidence exception",
        goal: "use the fast path for this task",
        acceptance: "c1: output is reviewed | manual-review",
        "plan-first": "0",
        "planning-policy": "choice",
        "permission-mode": "auto",
        "quality-mode": "default",
      }),
      redirect: "manual",
    });
    expect(filed.status).toBe(303);
    const taskId = decodeURIComponent((filed.headers.get("location") ?? "").split("/").at(-1) ?? "");
    expect(store.refFor("built-in", taskId).qualityMode).toBe("default");
    expect(store.getScope(taskId)?.qualityMode).toBe("default");

    const taskPage = await (await fetch(`${base}/t/${encodeURIComponent(taskId)}`, { headers: { cookie } })).text();
    expect(taskPage).toContain('name="quality-mode" value="default" checked');
    expect(taskPage).toContain("Default</strong>");
  });
});
