/**
 * Attack: a crafted GET that starts a conversation (quiet page visits, 2026-10-27). A page view used to start the
 * signed-in approver's membership conversation (a lead session and its thread), so anything that made their browser
 * fetch a page could start one: a link prefetch, a chat app's link preview, an <img src> pointing at /chat or a task
 * page, a stale "Open chat" link from the Agents → Live view. Now a visit only shows the page: a session, thread or
 * turn starts only from a POST that carries the person's CSRF token. Positive control: that POST starts exactly one.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { LeadProviderAnswer } from "../../src/converse.js";
import { addApprover } from "../../src/scope.js";
import { createDecisionServer } from "../../src/serve.js";
import { openStore, type Store } from "../../src/store.js";

const T0 = new Date("2026-10-27T12:00:00.000Z");
let store: Store, server: Server, base: string, token: string, evidenceRoot: string, repo: string;
let providerCalls: number, answers: LeadProviderAnswer[];

beforeEach(async () => {
  store = openStore(":memory:");
  for (const phase of ["build", "plan", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", T0);
  evidenceRoot = mkdtempSync(join(tmpdir(), "so-quiet-ev-"));
  repo = realpathSync(mkdtempSync(join(tmpdir(), "so-quiet-repo-")));
  const added = addApprover(store, "alex", T0);
  if (!added.ok) throw new Error("bootstrap failed");
  token = added.token;
  store.setChatConfig({ provider: "claude-subscription", model: "default", dailyTurns: 50, weeklyCeilingMicrousd: 0, priceInMicrousd: 0, priceOutMicrousd: 0 }, "alex", T0);
  const made = store.createConsoleTask({ id: "a", title: "task a", repo, goal: "do a", acceptance: [{ id: "c1", statement: "a is done.", evidence: ["manual-review"] }], filedVia: "cli" }, T0);
  if (!made.ok) throw new Error(made.reason);
  providerCalls = 0;
  answers = [];
  server = createDecisionServer({
    store, evidenceRoot, clock: () => T0, repo, admittedRepos: () => [repo],
    // Every model call the lead could make goes through here: a GET must never reach it.
    subscriptionChatRunner: async () => {
      providerCalls++;
      const next = answers.shift();
      if (next === undefined) throw new Error("no answer scripted");
      return { ok: true, answer: next };
    },
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("no address");
  base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  await new Promise<void>(done => server.close(() => done()));
  store.close();
  rmSync(evidenceRoot, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

const counts = () => store.raw().prepare(`SELECT (SELECT COUNT(*) FROM lead_session) AS sessions, (SELECT COUNT(*) FROM lead_thread) AS threads,
  (SELECT COUNT(*) FROM lead_message) AS messages, (SELECT COUNT(*) FROM mate_turn) AS turns`).get();
const login = async (): Promise<string> => {
  const response = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token }), redirect: "manual" });
  expect(response.status).toBe(303);
  return (response.headers.get("set-cookie") ?? "").split(";")[0]!;
};

describe("attack: a crafted GET starts the signed-in approver's conversation", () => {
  test("prefetches, link previews, image loads and send-shaped query strings start nothing and reach no model; a CSRF-bound POST does", async () => {
    const cookie = await login();
    const project = encodeURIComponent(repo);
    const targets = ["/chat", "/chat?task=a", `/chat?project=${project}`, "/t/a", `/work?project=${project}`, "/chat/mate/status?task=a",
      // The send's own fields, put in a query string.
      `/chat?message=${encodeURIComponent("ship it")}&request-session=0&request=${"a".repeat(32)}`,
      `/chat?task=a&message=hi&request-session=0&mode=build`,
      // POST-only doors, fetched.
      "/chat/mate/mint", "/chat/mate/follow"];
    const shapes: Record<string, Record<string, string>> = {
      prefetch: { cookie, purpose: "prefetch", "sec-purpose": "prefetch", "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" },
      preview: { cookie, "user-agent": "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)" },
      image: { cookie, accept: "image/avif,image/webp,*/*", "sec-fetch-dest": "image", "sec-fetch-mode": "no-cors", "sec-fetch-site": "cross-site", referer: "https://evil.example/" },
      navigation: { cookie, "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "sec-fetch-site": "none" },
      // A preview bot has no session at all.
      anonymous: { "user-agent": "facebookexternalhit/1.1" },
    };
    for (const [shape, headers] of Object.entries(shapes)) {
      for (const target of targets) {
        for (const method of ["GET", "HEAD"]) {
          const response = await fetch(base + target, { method, headers, redirect: "manual" });
          await response.arrayBuffer();
          expect(response.status, `${shape} ${method} ${target}`).not.toBe(500);
          expect(counts(), `${shape} ${method} ${target}`).toEqual({ sessions: 0, threads: 0, messages: 0, turns: 0 });
        }
      }
    }
    expect(providerCalls).toBe(0);
    // A cross-site POST without the CSRF token is refused too.
    const forged = await fetch(`${base}/chat`, { method: "POST", headers: { cookie, origin: "https://evil.example" }, body: new URLSearchParams({ message: "ship it", "request-session": "0" }), redirect: "manual" });
    expect(forged.status).toBeGreaterThanOrEqual(400);
    expect(counts()).toEqual({ sessions: 0, threads: 0, messages: 0, turns: 0 });
    // Positive control: the person's own send starts exactly one conversation and one turn.
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(await (await fetch(`${base}/chat`, { headers: { cookie } })).text())![1]!;
    answers.push({ text: "Hello.", calls: [], tokensIn: 1, tokensOut: 1, reportedCostMicrousd: null });
    const sent = await fetch(`${base}/chat`, { method: "POST", headers: { cookie, origin: base, accept: "application/json" },
      body: new URLSearchParams({ csrf, message: "Hi", request: "b".repeat(32), "request-session": "0" }), redirect: "manual" });
    expect(sent.status).toBe(202);
    for (let i = 0; i < 200 && store.liveLeadTurnFor("alex") !== null; i++) await new Promise(done => setTimeout(done, 10));
    expect(counts()).toMatchObject({ sessions: 1, threads: 1, turns: 1 });
    expect(providerCalls).toBe(1);
  });
});
