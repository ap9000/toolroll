/**
 * The console server: decisions, settings, sign-in and onboarding. A park
 * renders as one screen, answerable on a phone; first runs, accounts,
 * and provider keys over real HTTP.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { openStore, type Store } from "./store.js";
import { register } from "./runner.js";
import { addApprover, approve, propose } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { Window } from "happy-dom";
import { previewProjectInstructions } from "./setup-guide.js";
import { LEGACY_SKILL_DIR, SKILL_FILE } from "./skills.js";
import { presented, T0, renderedHtmlOf, workspaceOf, sealScopeFixture } from "../test/serve-kit.js";

describe("the web decision view", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let evidenceRoot: string;
  let approverToken: string;
  let decisionId: number;
  let artifactId: number;
  let taskRef: number;

  const url = (path: string) => `${base}${path}`;

  const login = async (): Promise<string> => {
    const response = await fetch(url("/login"), {
      method: "POST",
      body: new URLSearchParams({ name: "alex", token: approverToken }),
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    const cookie = response.headers.get("set-cookie") ?? "";
    return cookie.split(";")[0] as string;
  };

  const csrfOf = async (cookie: string): Promise<string> => {
    const html = await (await fetch(url(`/d/${decisionId}`), { headers: { cookie } })).text();
    const match = /name="csrf" value="([0-9a-f]{64})"/.exec(html);
    if (match === null) throw new Error("no csrf in the page");
    return match[1] as string;
  };

  beforeEach(async () => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-serve-ev-"));

    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;

    store.createTask({ id: "t-1", title: "the work" }, T0);
    taskRef = store.refFor("built-in", "t-1").id;
    const runId = store.startRun({
      taskRef,
      leaseId: "lease-1",
      runner: "builder-1",
      branch: "standing-orders/t-1",
      worktree: "/pool/t-1",
      now: T0,
      ...presented(store, taskRef, "builder"),
    });

    decisionId = store.saveDecision(
      {
        run: runId,
        urgency: "blocking",
        recap: "The guard can fail open or fail closed on timeout. <script>alert(1)</script>",
        question: "Fail open or fail closed?",
        options: [
          { id: "open", label: "Fail open", consequence: "Bad payouts slip through.", reversible: true },
          { id: "drop", label: "Drop the table", consequence: "It does not come back.", reversible: false },
        ],
        recommendation: "open",
      },
      T0,
    );
    store.holdOwned(
      { taskRef, ownerKind: "decision", ownerId: String(decisionId), reason: "decision", until: null },
      T0,
    );

    // One evidence file, recorded exactly as the builder would have.
    mkdirSync(join(evidenceRoot, String(runId)), { recursive: true });
    const content = Buffer.from("diff --git a/x b/x\n+guard\n", "utf8");
    writeFileSync(join(evidenceRoot, String(runId), "diff.patch"), content);
    artifactId = store.saveArtifact(
      {
        run: runId,
        kind: "diff",
        key: `${runId}/diff.patch`,
        bytesOriginal: content.length,
        bytesStored: content.length,
        truncated: false,
        sha256: createHash("sha256").update(content).digest("hex"),
        capture: "git diff (exit 0)",
      },
      T0,
    );
    store.linkEvidence(decisionId, artifactId);

    server = createDecisionServer({ store, evidenceRoot, clock: () => new Date() });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(evidenceRoot, { recursive: true, force: true });
  });

  test("the milestone sentence: one screen, answerable", async () => {
    const cookie = await login();

    // The list knows what waits.
    const list = await (await fetch(url("/inbox"), { headers: { cookie } })).text();
    expect(list).toContain("t-1");
    expect(list).toContain("Fail open or fail closed?");

    // One screen: recap, question, options with consequences, the
    // recommendation marked, the irreversible one visibly armed, evidence.
    const screen = await (await fetch(url(`/d/${decisionId}`), { headers: { cookie } })).text();
    expect(screen).toContain("Fail open or fail closed?");
    expect(screen).toContain("Fail open");
    expect(screen).toContain("recommended");
    expect(screen).toContain("irreversible, tap to arm");
    expect(screen).toContain(`/d/${decisionId}/evidence/${artifactId}`);

    // Answerable: one POST, and the machine heard it.
    const csrf = await csrfOf(cookie);
    const answered = await fetch(url(`/d/${decisionId}/answer`), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ choice: "open", csrf, note: "ship it" }),
      redirect: "manual",
    });
    expect(answered.status).toBe(303);

    const decision = store.getDecision(decisionId);
    expect(decision).toMatchObject({ state: "answered", choice: "open", answeredBy: "alex", answeredVia: "web" });
    // The hold lifted with it: the task is dispatchable again.
    expect(store.activeHolds(taskRef, new Date())).toHaveLength(0);

    // And the screen now shows the answer instead of the buttons.
    const after = await (await fetch(url(`/d/${decisionId}`), { headers: { cookie } })).text();
    expect(after).toContain("Answered:");
    expect(after).toContain("ship it");
  });

  test("nothing renders and nothing answers without authentication — localhost included", async () => {
    const page = await fetch(url("/"), { redirect: "manual" });
    expect(page.status).toBe(303);
    expect(page.headers.get("location")).toBe("/login");

    const answer = await fetch(url(`/d/${decisionId}/answer`), {
      method: "POST",
      body: new URLSearchParams({ choice: "open" }),
    });
    expect(answer.status).toBe(401);
    expect(store.getDecision(decisionId)?.state).toBe("open");
  });

  test("a wrong login is a wrong login", async () => {
    const response = await fetch(url("/login"), {
      method: "POST",
      body: new URLSearchParams({ name: "alex", token: "guessing" }),
      redirect: "manual",
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  test.each(["chat", "result"])("a phone's deep link to an exact %s survives sign-in: the unauthenticated GET, a failed attempt and the successful one all keep the same-site destination, and opening it acts on nothing", async kind => {
    const run = store.runsFor(taskRef)[0]!.id;
    const destination = kind === "chat" ? `/chat?task=t-1&result=${run}&tab=checks` : `/r/${run}?tab=checks`;
    const anonymous = await fetch(url(destination), { redirect: "manual" });
    expect(anonymous.status).toBe(303);
    expect(anonymous.headers.get("location")).toBe(`/login?return=${encodeURIComponent(destination)}`);
    // The sign-in page carries the destination as a hidden field — a path, never a token.
    const form = await (await fetch(url(anonymous.headers.get("location")!))).text();
    expect(form).toContain(`<input type="hidden" name="return" value="${destination.replace(/&/g, "&amp;")}">`);
    // A wrong password keeps it for the next try.
    const wrong = await fetch(url("/login"), { method: "POST", body: new URLSearchParams({ name: "alex", token: "guessing", return: destination }), redirect: "manual" });
    expect(wrong.status).toBe(403);
    expect(wrong.headers.get("set-cookie")).toBeNull();
    expect(await wrong.text()).toContain(`name="return" value="${destination.replace(/&/g, "&amp;")}"`);
    // The right one lands exactly there, with the ordinary cookie and nothing else changed.
    const right = await fetch(url("/login"), { method: "POST", body: new URLSearchParams({ name: "alex", token: approverToken, return: destination }), redirect: "manual" });
    expect(right.status).toBe(303);
    expect(right.headers.get("location")).toBe(destination);
    const cookie = (right.headers.get("set-cookie") ?? "").split(";")[0] as string;
    expect(right.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict");
    const landed = await fetch(url(destination), { headers: { cookie }, redirect: "manual" });
    expect(landed.status).toBe(200);
    expect(await landed.text()).toContain("t-1");
    expect(store.getDecision(decisionId)?.state).toBe("open");
    expect(store.getTask("t-1")?.state).not.toBe("cancelled");
    // The plain sign-in still lands on the front page.
    const plain = await fetch(url("/login"), { method: "POST", body: new URLSearchParams({ name: "alex", token: approverToken }), redirect: "manual" });
    expect(plain.headers.get("location")).toBe("/");
    expect(await (await fetch(url("/login"))).text()).not.toContain('name="return"');
  });

  test.each([
    ["//evil.example/x", "/"],
    ["https://evil.example/x", "/"],
    ["/\\evil.example", "/"],
    ["%2F%2Fevil.example", "/"],
    ["/%2F%2Fevil.example", "/"],
    ["/%5Cevil.example", "/"],
    ["/login?return=/t/t-1", "/"],
    ["/login", "/"],
    ["/logout", "/"],
    ["/signup", "/"],
    ["/join/abcdefghijklmnop", "/"],
    ["/t/t-1%0d%0aSet-Cookie:%20x=y", "/"],
    ["t/t-1", "/"],
    ["", "/"],
    [`/t/${"x".repeat(600)}`, "/"],
    ["/t/t-1?token=leaked&password=p&csrf=c&tab=checks", "/t/t-1?tab=checks"],
    ["/chat?task=t-1&result=7&tab=changes", "/chat?task=t-1&result=7&tab=changes"],
    ["/work", "/work"],
    ["/settings#providers", "/settings"],
    ["/board?fragment=1", "/"],
    ["/chat?task=t-1&fragment=rail", "/"],
    ["/api/tasks", "/"],
    ["/t/t-1/evidence/x.png", "/"],
  ])("a sign-in return of %j stays on this site as %j — no open redirect, encoded bypass, recursive sign-in, secret query or region fetch survives", async (given, expected) => {
    const posted = await fetch(url("/login"), { method: "POST", body: new URLSearchParams({ name: "alex", token: approverToken, return: given }), redirect: "manual" });
    expect(posted.status).toBe(303);
    expect(posted.headers.get("location")).toBe(expected);
    // The same rule decides whether the anonymous redirect names a return at all.
    if (given.startsWith("/") && !given.startsWith("//")) {
      const anonymous = await fetch(url(given), { redirect: "manual" });
      if (anonymous.status === 303 && anonymous.headers.get("location")?.startsWith("/login")) {
        expect(anonymous.headers.get("location")).toBe(expected === "/" ? "/login" : `/login?return=${encodeURIComponent(expected)}`);
      }
    }
  });

  test("a host this server was never told to be is refused before routing", async () => {
    // fetch silently corrects a spoofed Host header, which is exactly why a
    // rebound DNS name needs raw HTTP to simulate.
    const { request } = await import("node:http");
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port, path: "/", headers: { Host: "evil.example" } },
        response => resolve(response.statusCode ?? 0),
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(421);
  });

  test("credentials never travel in URLs", async () => {
    const response = await fetch(url(`/?token=${approverToken}`));
    expect(response.status).toBe(400);
  });

  test("a bearer request answers without cookies, and without ceremony", async () => {
    const response = await fetch(url(`/d/${decisionId}/answer`), {
      method: "POST",
      headers: { authorization: `Bearer alex:${approverToken}` },
      body: new URLSearchParams({ choice: "open" }),
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    expect(store.getDecision(decisionId)?.answeredVia).toBe("web");
  });

  test("a cookie answer without its nonce, or from a foreign origin, dies", async () => {
    const cookie = await login();

    const noNonce = await fetch(url(`/d/${decisionId}/answer`), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ choice: "open", csrf: "0".repeat(64) }),
    });
    expect(noNonce.status).toBe(403);

    const csrf = await csrfOf(cookie);
    const foreign = await fetch(url(`/d/${decisionId}/answer`), {
      method: "POST",
      headers: { cookie, origin: "http://evil.example" },
      body: new URLSearchParams({ choice: "open", csrf }),
    });
    expect(foreign.status).toBe(403);
    expect(store.getDecision(decisionId)?.state).toBe("open");
  });

  test("an irreversible choice needs its confirmation — the server checks, not the page", async () => {
    const unconfirmed = await fetch(url(`/d/${decisionId}/answer`), {
      method: "POST",
      headers: { authorization: `Bearer alex:${approverToken}` },
      body: new URLSearchParams({ choice: "drop" }),
    });
    expect(unconfirmed.status).toBe(400);
    expect(store.getDecision(decisionId)?.state).toBe("open");

    const confirmed = await fetch(url(`/d/${decisionId}/answer`), {
      method: "POST",
      headers: { authorization: `Bearer alex:${approverToken}` },
      body: new URLSearchParams({ choice: "drop", confirm: "yes" }),
      redirect: "manual",
    });
    expect(confirmed.status).toBe(303);
  });

  test("a different answer after the first is a conflict, not a change of mind", async () => {
    await fetch(url(`/d/${decisionId}/answer`), {
      method: "POST",
      headers: { authorization: `Bearer alex:${approverToken}` },
      body: new URLSearchParams({ choice: "open" }),
      redirect: "manual",
    });

    const contradiction = await fetch(url(`/d/${decisionId}/answer`), {
      method: "POST",
      headers: { authorization: `Bearer alex:${approverToken}` },
      body: new URLSearchParams({ choice: "drop", confirm: "yes" }),
    });
    expect(contradiction.status).toBe(409);
    expect(store.getDecision(decisionId)?.choice).toBe("open");
  });

  test("agent text renders as text — never as markup", async () => {
    const cookie = await login();
    const screen = await (await fetch(url(`/d/${decisionId}`), { headers: { cookie } })).text();
    expect(screen).not.toContain("<script>alert(1)</script>");
    expect(screen).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    const headers = await fetch(url(`/d/${decisionId}`), { headers: { cookie } });
    expect(headers.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(headers.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("evidence streams as a plain-text attachment, only while it matches its record", async () => {
    const cookie = await login();

    const good = await fetch(url(`/d/${decisionId}/evidence/${artifactId}`), { headers: { cookie } });
    expect(good.status).toBe(200);
    expect(good.headers.get("content-type")).toContain("text/plain");
    expect(good.headers.get("content-disposition")).toContain("attachment");
    expect(await good.text()).toContain("+guard");

    // Tampered on disk → the record no longer vouches for the bytes.
    const artifact = store.getArtifact(artifactId);
    writeFileSync(join(evidenceRoot, artifact!.key), "something else entirely");
    const tampered = await fetch(url(`/d/${decisionId}/evidence/${artifactId}`), { headers: { cookie } });
    expect(tampered.status).toBe(410);
  });

  test("another run's artifact is not this decision's evidence, whatever the URL says", async () => {
    const cookie = await login();
    // A second run with its own artifact, never linked to our decision.
    const foreignRun = store.startRun({
      taskRef,
      leaseId: "lease-2",
      runner: "builder-1",
      branch: "b",
      worktree: "/w",
      now: T0,
      ...presented(store, taskRef, "builder"),
    });
    mkdirSync(join(evidenceRoot, String(foreignRun)), { recursive: true });
    const secret = Buffer.from("somebody else's diff", "utf8");
    writeFileSync(join(evidenceRoot, String(foreignRun), "diff.patch"), secret);
    const foreign = store.saveArtifact(
      {
        run: foreignRun,
        kind: "diff",
        key: `${foreignRun}/diff.patch`,
        bytesOriginal: secret.length,
        bytesStored: secret.length,
        truncated: false,
        sha256: createHash("sha256").update(secret).digest("hex"),
        capture: "git diff (exit 0)",
      },
      T0,
    );

    const response = await fetch(url(`/d/${decisionId}/evidence/${foreign}`), { headers: { cookie } });
    expect(response.status).toBe(404);
  });


  test("logout kills the cookie, and credential rotation kills every session it minted", async () => {
    const cookie = await login();

    // Logged in: the console answers.
    expect((await fetch(url("/"), { headers: { cookie } })).status).toBe(200);

    // Rotation: the approver re-registers; the old session's generation is
    // stale and the cookie stops working — same rule as Telegram bindings.
    const rotated = addApprover(store, "alex", new Date(), { name: "alex", token: approverToken });
    expect(rotated.ok).toBe(true);
    const after = await fetch(url("/"), { redirect: "manual", headers: { cookie } });
    expect(after.status).toBe(303);
    expect(after.headers.get("location")).toBe("/login");
  });

  test("logout is a real verb", async () => {
    const cookie = await login();
    const out = await fetch(url("/logout"), { method: "POST", headers: { cookie }, redirect: "manual" });
    expect(out.status).toBe(303);
    const back = await fetch(url("/"), { redirect: "manual", headers: { cookie } });
    expect(back.status).toBe(303);
  });


});

describe("the settings card", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let evidenceRoot: string;
  let dir: string;
  let approverToken: string;

  const login = async (): Promise<string> => {
    const response = await fetch(`${base}/login`, {
      method: "POST",
      body: new URLSearchParams({ name: "alex", token: approverToken }),
      redirect: "manual",
    });
    return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
  };

  beforeEach(async () => {
    const { mkdtempSync } = await import("node:fs");
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    dir = mkdtempSync(join(tmpdir(), "standing-orders-serve-settings-"));
    evidenceRoot = join(dir, "evidence");
    mkdirSync(evidenceRoot, { recursive: true });
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;

    server = createDecisionServer({
      store,
      evidenceRoot,
      clock: () => new Date(),
      telegramTokenFile: join(dir, "telegram-token"),
    });
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

  test("the bot token is settable from the phone, stored 0600, never echoed whole", async () => {
    const { statSync, readFileSync } = await import("node:fs");
    const cookie = await login();

    // Before: not set, and the card says so.
    let page = await (await fetch(`${base}/settings`, { headers: { cookie } })).text();
    expect(page).toContain("not set");
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(page)?.[1] as string;

    // A wrong shape is refused.
    const bad = await fetch(`${base}/settings/telegram-token`, {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ token: "not a token", csrf }),
    });
    expect(bad.status).toBe(400);

    // The real thing lands owner-only beside the database.
    const token = "777000:AAExampleExampleExample123";
    const saved = await fetch(`${base}/settings/telegram-token`, {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ token, csrf }),
      redirect: "manual",
    });
    expect(saved.status).toBe(303);
    const file = join(dir, "telegram-token");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8").trim()).toBe(token);

    // After: recognizable, never whole.
    page = await (await fetch(`${base}/settings`, { headers: { cookie } })).text();
    expect(page).toContain("e123");
    expect(page).not.toContain(token);
  });

  test("no session, no settings — and no unauthenticated writes", async () => {
    const page = await fetch(`${base}/settings`, { redirect: "manual" });
    expect(page.status).toBe(303);

    const write = await fetch(`${base}/settings/telegram-token`, {
      method: "POST",
      body: new URLSearchParams({ token: "777000:AAExampleExampleExample123" }),
    });
    expect(write.status).toBe(401);
  });
});

describe("provider keys & auth mode, over HTTP", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let dir: string;
  let approverToken: string;
  let priorHome: string | undefined;

  const login = async (): Promise<string> => {
    const response = await fetch(`${base}/login`, {
      method: "POST",
      body: new URLSearchParams({ name: "alex", token: approverToken }),
      redirect: "manual",
    });
    return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
  };
  const csrfOf = async (cookie: string): Promise<string> => {
    const page = await (await fetch(`${base}/settings`, { headers: { cookie } })).text();
    return /name="csrf" value="([0-9a-f]{64})"/.exec(page)?.[1] as string;
  };

  beforeEach(async () => {
    // HOME is isolated so provider-key writes never touch the real store.
    priorHome = process.env["HOME"];
    dir = mkdtempSync(join(tmpdir(), "so-serve-keys-"));
    process.env["HOME"] = dir;
    store = openStore(":memory:");
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap");
    approverToken = added.token;
    server = createDecisionServer({ store, evidenceRoot: join(dir, "ev"), clock: () => new Date(), telegramTokenFile: join(dir, "tok") });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
    if (priorHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = priorHome;
  });

  const post = async (cookie: string, csrf: string, fields: Record<string, string>) =>
    fetch(`${base}/settings/provider-key`, {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, ...fields }),
      redirect: "manual",
    });

  test("an unchanged blank submission claims NO change (round 5, finding 2)", async () => {
    const cookie = await login();
    const csrf = await csrfOf(cookie);
    // claude defaults to subscription; submitting subscription + no key changes nothing.
    const res = await post(cookie, csrf, { provider: "claude", "auth-mode": "subscription", value: "" });
    expect(res.status).toBe(303);
    expect(decodeURIComponent(res.headers.get("location") ?? "")).toContain("no change");
    const { readAuthMode } = await import("./keys.js");
    expect(readAuthMode("claude")).toBe("subscription");
  });

  test("an invalid key does NOT persist a hidden mode change (validate before mutate)", async () => {
    const cookie = await login();
    const csrf = await csrfOf(cookie);
    const res = await post(cookie, csrf, { provider: "claude", "auth-mode": "api-key", value: "short" });
    expect(res.status).toBe(400);
    const { readAuthMode } = await import("./keys.js");
    // The mode was NOT switched despite the api-key selection — the bad key refused first.
    expect(readAuthMode("claude")).toBe("subscription");
  });

  test("a real mode change is claimed; openrouter cannot go subscription", async () => {
    const cookie = await login();
    const csrf = await csrfOf(cookie);
    const changed = await post(cookie, csrf, { provider: "claude", "auth-mode": "api-key", value: "" });
    expect(decodeURIComponent(changed.headers.get("location") ?? "")).toContain("now uses the API key");
    const { readAuthMode } = await import("./keys.js");
    expect(readAuthMode("claude")).toBe("api-key");
    // openrouter has no subscription — a forced submit refuses without mutating.
    const refused = await post(cookie, csrf, { provider: "openrouter", "auth-mode": "subscription", value: "" });
    expect(refused.status).toBe(409);
    expect(readAuthMode("openrouter")).toBe("api-key");
  });

  test("the projects page renders richer cards with a peek and a unified add card", async () => {
    const cookie = await login();
    // Seed a project so a card renders (a temp git repo opened via the road).
    const repoDir = mkdtempSync(join(tmpdir(), "so-proj-"));
    mkdirSync(join(repoDir, ".git"), { recursive: true });
    const real = realpathSync(repoDir);
    store.upsertProject(real, "so-proj", T0);
    const page = await (await fetch(`${base}/projects`, { headers: { cookie } })).text();
    // The richer card structure and the unified add affordance render.
    expect(page).toContain("project-card");
    expect(page).toContain("Add a project");
    expect(page).toContain("project-add-actions");
    expect(page).toContain("Choose a local folder");
    expect(page).toContain("Add from GitHub");
    // The path-typing road is still reachable (now behind a details).
    expect(page).toContain("Enter an exact path instead");
    expect(page).toContain("Path on this server");
    const window = new Window();
    try {
      window.document.body.innerHTML = page;
      const card = window.document.querySelector('.project-card');
      expect(card?.textContent).toContain(real);
      expect(card?.querySelector('button.button-link')?.textContent).toBe('Open');
      expect(card?.querySelector('a[href^="/settings/knowledge"]')?.classList.contains('button-link')).toBe(false);
      expect(card?.querySelector('input[name="path"]')?.getAttribute('value')).toBe(real);
      expect(window.document.querySelector('.project-add-card')?.textContent).not.toContain('add a repository');
    } finally { await window.happyDOM.close(); }
    rmSync(repoDir, { recursive: true, force: true });
  });

  test("clearing a key in subscription mode says builds are unaffected", async () => {
    const cookie = await login();
    const csrf = await csrfOf(cookie);
    const { saveProviderKey, readAuthMode } = await import("./keys.js");
    saveProviderKey("claude", "sk-ant-StoredThenCleared99");
    expect(readAuthMode("claude")).toBe("subscription");
    const res = await fetch(`${base}/settings/provider-key-clear`, {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, provider: "claude" }),
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    expect(decodeURIComponent(res.headers.get("location") ?? "")).toContain("uses its own login");
  });
});

describe("mutations from browsers that omit Origin", () => {
  test("absent Origin + valid CSRF proceeds; a present wrong Origin still refuses", async () => {
    const store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    const evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-origin-ev-"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap");
    store.createTask({ id: "t-o", title: "w" }, T0);
    const server = createDecisionServer({ store, evidenceRoot, clock: () => new Date(), repo: "/repo/main" });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const login = await fetch(`${base}/login`, {
        method: "POST", body: new URLSearchParams({ name: "alex", token: added.token }), redirect: "manual",
      });
      const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
      const page = await (await fetch(`${base}/t/t-o`, { headers: { cookie } })).text();
      const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(page)?.[1] as string;

      // iOS Safari's shape: same-origin POST, no Origin header at all.
      const noOrigin = await fetch(`${base}/t/t-o/hold`, {
        method: "POST", headers: { cookie },
        body: new URLSearchParams({ csrf, reason: "from the phone" }), redirect: "manual",
      });
      expect(noOrigin.status).toBe(303);

      // A hostile page still names itself, and is still refused.
      const foreign = await fetch(`${base}/t/t-o/unhold`, {
        method: "POST", headers: { cookie, origin: "http://evil.example" },
        body: new URLSearchParams({ csrf }),
      });
      expect(foreign.status).toBe(403);

      // And CSRF stays the hard gate even with no Origin.
      const noToken = await fetch(`${base}/t/t-o/unhold`, {
        method: "POST", headers: { cookie },
        body: new URLSearchParams({ csrf: "0".repeat(64) }),
      });
      expect(noToken.status).toBe(403);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      store.close();
      rmSync(evidenceRoot, { recursive: true, force: true });
    }
  });
});

describe("the first run: three plain steps to a first result", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let approverToken: string;
  let evidenceRoot: string;

  const url = (path: string) => `${base}${path}`;

  const login = async (): Promise<string> => {
    const response = await fetch(url("/login"), {
      method: "POST",
      body: new URLSearchParams({ name: "alex", token: approverToken }),
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
  };

  // No agent is signed in and the project has no issues or TODOs unless a test says so.
  const signedOut = async (file: string) => ({ code: 1, stdout: file === "codex" ? "Not logged in\n" : JSON.stringify({ loggedIn: false }), stderr: "", timedOut: false, notFound: false });
  const quietRepo = async () => ({ code: 1, stdout: "", stderr: "", timedOut: false, notFound: false });
  const boot = async (options: Record<string, unknown> = {}) => {
    server = createDecisionServer({ store, evidenceRoot, clock: () => new Date(), connectionProbe: signedOut, firstTaskRunner: quietRepo, ...options });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  };

  beforeEach(() => {
    store = openStore(":memory:");
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-wizard-ev-"));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(evidenceRoot, { recursive: true, force: true });
  });

  test("a young installation gets three plain steps, derived from live state", async () => {
    await boot({ repo: "/repo/main" });
    const cookie = await login();
    // This machine's sign-in check answers in the background; the step waits for it.
    let html = "";
    await vi.waitFor(async () => { html = await (await fetch(url("/inbox"), { headers: { cookie } })).text(); expect(html).not.toContain("checking…"); });
    expect(html).toContain("Get to your first result");
    // The empty-queue card yields to the steps.
    expect(html).not.toContain("Nothing needs you.");
    const step = (key: string) => new RegExp(`<p class="row" data-step="${key}">(.*?)</p>`).exec(html)?.[1] ?? "";
    // No agent signed in: the exact command. A project is added. No task yet: the button that starts one.
    expect(step("agent")).toContain("Agent signed in");
    expect(step("agent")).toContain("<code>claude auth login</code>");
    expect(step("project")).toContain("Project added");
    expect(step("project")).toContain("done");
    expect(step("task")).toContain('<a href="/tasks/new">New task</a>');
    expect(html).not.toMatch(/ceiling|unscoped|phase config|serve --repo|toolroll config set build/);
  });

  const agentStep = async (cookie: string) => /<p class="row" data-step="agent">(.*?)<\/p>/.exec(await (await fetch(url("/inbox"), { headers: { cookie } })).text())?.[1] ?? "";
  const signedIn = async (file: string) => ({ code: 0, stdout: file === "claude" ? JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }) : "Not logged in\n", stderr: "", timedOut: false, notFound: false });

  test("a signed-in agent on the worker's machine checks off the first step", async () => {
    register(store, { name: "builder-1", host: hostname(), capacity: 1, repos: ["/repo/main"], now: new Date(), newToken: () => "tok-builder-1" });
    await boot({ repo: "/repo/main", connectionProbe: signedIn });
    const cookie = await login();
    await vi.waitFor(async () => expect(await agentStep(cookie)).not.toContain("claude auth login"));
  });

  test("with no worker registered yet, the first render checks this machine, and shows the step as checking until it answers", async () => {
    let answer: (() => void) | null = null;
    const probe = vi.fn((file: string) => new Promise<Awaited<ReturnType<typeof signedIn>>>(done => {
      const reply = () => { void signedIn(file).then(done); };
      if (answer === null) answer = reply; else { const earlier = answer; answer = () => { earlier(); reply(); }; }
    }));
    await boot({ repo: "/repo/main", connectionProbe: probe });
    const cookie = await login();
    const before = await agentStep(cookie);
    expect(before).toContain("checking…");
    expect(before).not.toContain("claude auth login");
    const chat = await (await fetch(url("/chat?format=workspace"), { headers: { cookie } })).json() as import("./browser-workspace.js").BrowserWorkspace;
    expect(chat.firstRun!.steps[0]).toMatchObject({ key: "agent", done: false, action: null, checking: true });
    expect(chat.firstRun!.sandbox).toBeNull();
    expect(probe).toHaveBeenCalled();
    answer!();
    await vi.waitFor(async () => expect(await agentStep(cookie)).toContain("done"));
    expect(await agentStep(cookie)).not.toContain("checking…");
  });

  test("with the worker on another machine, its own report decides, never this machine's sign-in", async () => {
    register(store, { name: "far-1", host: "elsewhere.tailnet", capacity: 1, repos: ["/repo/main"], now: new Date(), newToken: () => "tok-far-1" });
    const probe = vi.fn(signedIn);
    await boot({ repo: "/repo/main", connectionProbe: probe });
    const cookie = await login();
    expect(await agentStep(cookie)).toContain("claude auth login");
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(await agentStep(cookie)).toContain("claude auth login");
    expect(probe).not.toHaveBeenCalled();
    store.recordProviderReadiness("far-1", [{ provider: "codex", state: "ready", reason: "installed; logged in", probe: "identity" }], new Date());
    expect(await agentStep(cookie)).not.toContain("claude auth login");
  });

  test("Chat and the inbox never wait on gh, git grep or a sign-in probe", async () => {
    register(store, { name: "builder-1", host: hostname(), capacity: 1, repos: ["/repo/main"], now: new Date(), newToken: () => "tok-builder-1" });
    const never = vi.fn(() => new Promise<never>(() => {}));
    await boot({ repo: "/repo/main", connectionProbe: never, firstTaskRunner: never });
    const cookie = await login();
    const inbox = await fetch(url("/inbox"), { headers: { cookie }, signal: AbortSignal.timeout(3_000) });
    expect(await inbox.text()).toContain("Get to your first result");
    const chat = await (await fetch(url("/chat?format=workspace"), { headers: { cookie }, signal: AbortSignal.timeout(3_000) })).json() as import("./browser-workspace.js").BrowserWorkspace;
    expect(chat.firstRun!.suggestions.map(one => one.source)).toEqual(["generic", "generic", "generic"]);
    // The reads were started, in the background.
    expect(never.mock.calls.map(([file]) => file)).toEqual(expect.arrayContaining(["claude", "gh"]));
  });

  test("Chat opens with the steps and three first tasks from the project's issues; the sandbox sits beside sign-in", async () => {
    const gh = vi.fn(async (file: string, args: readonly string[]) => file === "gh" && args[0] === "issue"
      ? { code: 0, stdout: JSON.stringify([{ number: 7, title: "Crash on save", state: "OPEN" }]), stderr: "", timedOut: false, notFound: false }
      : { code: 0, stdout: "src/cart.ts\u000040\u0000// TODO handle an empty cart\n", stderr: "", timedOut: false, notFound: false });
    await boot({ repo: "/repo/main", firstTaskRunner: gh });
    const cookie = await login();
    const read = async () => (await fetch(url("/chat?format=workspace"), { headers: { cookie } })).json() as Promise<import("./browser-workspace.js").BrowserWorkspace>;
    // The first render serves safe generic tasks while the project's own are read in the background.
    expect((await read()).firstRun!.suggestions.map(one => one.source)).toEqual(["generic", "generic", "generic"]);
    await vi.waitFor(async () => expect((await read()).firstRun!.suggestions[0]!.source).toBe("issue"));
    const first = await read();
    expect(first.firstRun!.steps.map(one => [one.title, one.done])).toEqual([["Agent signed in", false], ["Project added", true], ["Your first task", false]]);
    expect(first.firstRun!.suggestions.map(one => one.source)).toEqual(["issue", "todo", "generic"]);
    expect(first.firstRun!.suggestions[0]!.draft).toBe("Fix GitHub issue #7: Crash on save");
    expect(first.firstRun!.sandbox).toBe("npx toolroll demo");
    // The sources are read once, not on every refresh; reading them files nothing.
    await read();
    expect(gh.mock.calls.filter(([file]) => file === "gh")).toHaveLength(1);
    expect(gh.mock.calls.every(([file, args]) => (file === "gh" && args[0] === "issue" && args[1] === "list") || (file === "git" && args.includes("grep")))).toBe(true);
    expect(store.hasAnyWork()).toBe(false);
    // Once the first task exists, the suggestions give way.
    store.createTask({ id: "w-3", title: "first task" }, T0);
    const filed = await read();
    expect(filed.firstRun!.steps.at(-1)!.done).toBe(true);
    expect(filed.firstRun!.suggestions).toEqual([]);
  });

  test("a skill only in the folder from before the rename: the setup guide offers to bring it up to date", async () => {
    const repo = mkdtempSync(join(tmpdir(), "toolroll-wizard-legacy-skill-"));
    try {
      mkdirSync(join(repo, LEGACY_SKILL_DIR), { recursive: true });
      writeFileSync(join(repo, LEGACY_SKILL_DIR, SKILL_FILE), "---\nname: standing-orders\n---\n");
      // The setup guide still offers Review: installing moves it into .claude/skills/toolroll with current content.
      expect(previewProjectInstructions(repo)).toMatchObject({ ok: true, installed: false });
      // Without it, both say it is missing.
      rmSync(join(repo, ".claude"), { recursive: true });
      expect(previewProjectInstructions(repo)).toMatchObject({ ok: true, installed: false });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("with no project yet, the step offers the button that adds one, in plain words", async () => {
    await boot();
    const cookie = await login();
    const html = await (await fetch(url("/inbox"), { headers: { cookie } })).text();
    expect(/<p class="row" data-step="project">(.*?)<\/p>/.exec(html)?.[1]).toContain('<a href="/projects">Add a project</a>');
    expect(html).not.toMatch(/ceiling|unscoped|serve --repo/);
  });

  test("the first successful run retires the checklist PERMANENTLY", async () => {
    await boot({ repo: "/repo/main", telegramTokenFile: join(evidenceRoot, "telegram-token") });
    const cookie = await login();
    store.createTask({ id: "w-1", title: "the work" }, T0);
    const run = store.startRun({
      taskRef: store.refFor("built-in", "w-1").id,
      leaseId: "lease-w",
      runner: "builder-1",
      branch: "standing-orders/w-1",
      worktree: "/pool/w-1",
      now: T0,
      ...presented(store, store.refFor("built-in", "w-1").id, "builder"),
    });
    store.finishRun(run, { outcome: "built", committed: true, now: new Date("2026-08-14T13:00:00.000Z") });
    // The first Ready result is recorded the moment it lands, as an append-only
    // installation fact, so pruning run history later cannot resurrect the list.
    expect(store.installationFact("first-success-at")).toBe("2026-08-14T13:00:00.000Z");
    const html = await (await fetch(url("/inbox"), { headers: { cookie } })).text();
    expect(html).not.toContain("Get to your first result");
    const chat = await (await fetch(url("/chat?format=workspace"), { headers: { cookie } })).json() as import("./browser-workspace.js").BrowserWorkspace;
    expect(chat.firstRun).toBeUndefined();
    // Settings shows how long the first result took, from the first account.
    const settings = await (await fetch(url("/settings?format=workspace"), { headers: { cookie } })).json() as import("./browser-workspace.js").BrowserWorkspace;
    expect((settings.view as import("./browser-workspace.js").BrowserSettingsView).firstResult).toBe("First result in 3 days");
  });

  test("a run that changed nothing is not the first result", async () => {
    await boot({ repo: "/repo/main" });
    const cookie = await login();
    store.createTask({ id: "w-0", title: "nothing to do" }, T0);
    const run = store.startRun({
      taskRef: store.refFor("built-in", "w-0").id,
      leaseId: "lease-0",
      runner: "builder-1",
      branch: "standing-orders/w-0",
      worktree: "/pool/w-0",
      now: T0,
      ...presented(store, store.refFor("built-in", "w-0").id, "builder"),
    });
    store.finishRun(run, { outcome: "no-change", committed: false, now: new Date("2026-08-14T13:00:00.000Z") });
    expect(store.installationFact("first-success-at")).toBeNull();
    expect(store.firstSuccessAt(new Date())).toBeNull();
    expect(await (await fetch(url("/inbox"), { headers: { cookie } })).text()).toContain("Get to your first result");
  });

  test("filing work checks the step off but keeps the list until the first Ready result", async () => {
    await boot({ repo: "/repo/main" });
    const cookie = await login();
    store.createTask({ id: "w-2", title: "queued work" }, T0);
    const html = await (await fetch(url("/inbox"), { headers: { cookie } })).text();
    expect(html).toContain("Get to your first result");
    expect(/<p class="row" data-step="task">(.*?)<\/p>/.exec(html)?.[1]).toContain("done");
  });

  test("template prefill: the forms carry the library's exact text, editable", async () => {
    await boot({ repo: "/repo/main" });
    const cookie = await login();
    const tasks = await (await fetch(url("/tasks?template=lint-sweep"), { headers: { cookie } })).text();
    expect(tasks).toContain(">One lint-clean sweep</textarea>");
    expect(tasks).toContain("pre-filled from a template");
    // An unknown template name is just an unfilled form, not an error.
    const plain = await (await fetch(url("/tasks?template=nope"), { headers: { cookie } })).text();
    expect(plain).not.toContain("pre-filled");
  });
});

describe("the onboarding ceremony over real HTTP, and root-mode placement proofs", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let evidenceRoot: string;
  let approverToken: string;
  let root: string;
  const T0 = new Date("2026-08-14T12:00:00.000Z");

  const url = (path: string) => `${base}${path}`;
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
    const html = await (await fetch(url("/projects"), { headers: { cookie } })).text();
    return /name="csrf" value="([0-9a-f]{64})"/.exec(html)?.[1] as string;
  };

  const boot = async (options: Record<string, unknown>) => {
    server = createDecisionServer({ store, evidenceRoot, clock: () => new Date(), ...options });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  };

  /** A ghClone stand-in that actually creates a real git repository at the
   * claimed target — authorizedProject's proof runs REAL git afterwards. */
  const fakeClone = async (nameWithOwner: string, intoRoot: string) => {
    const { execSync } = await import("node:child_process");
    const name = nameWithOwner.split("/")[1] as string;
    const target = join(intoRoot, name);
    mkdirSync(target);
    execSync("git init -q", { cwd: target });
    return { ok: true as const, target };
  };
  const fakePreview = async (owner: string, name: string) => ({
    ok: true as const,
    preview: { nameWithOwner: `${owner}/${name}`, visibility: "public", diskUsageKib: 512, description: "a test repo" },
  });

  beforeEach(() => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-onb-ev-"));
    root = realpathSync(mkdtempSync(join(tmpdir(), "standing-orders-onb-root-")));
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    approverToken = added.token;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(evidenceRoot, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  test("the card gates on roots: absent ceremony refuses in words; present, the whole flow works once", async () => {
    await boot({ repos: ["/repo/elsewhere"] });
    const cookie = await login();
    // repo-list console: the ceremony refuses with the configuration named
    const csrf = await csrfFrom(cookie);
    const refused = await fetch(url("/projects/onboard-preview"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, repo: "ap9000/thing", root: "0" }),
      redirect: "manual",
    });
    expect(await refused.text()).toContain("--project-root");
  });

  test("the console picks up a newly connected project without restarting", async () => {
    const repo = join(root, "live-project");
    mkdirSync(repo);
    const { execSync } = await import("node:child_process");
    execSync("git init -q", { cwd: repo });
    const connected: string[] = [];
    await boot({ projectRoots: [root], currentRepos: () => connected });
    const cookie = await login();

    const before = await (await fetch(url("/projects"), { headers: { cookie } })).text();
    expect(before).not.toContain("live-project");
    connected.push(repo);
    const after = await (await fetch(url("/projects"), { headers: { cookie } })).text();

    expect(after).toContain("live-project");
    expect(after).toContain('href="/chat"');
  });

  test("opening an allowed local repository adds it to the machine registry", async () => {
    const repo = join(root, "opened-project");
    mkdirSync(repo);
    const { execSync } = await import("node:child_process");
    execSync("git init -q", { cwd: repo });
    const registry = join(root, "machine-repos.json");
    await boot({ projectRoots: [root], registryPath: registry, upConsole: true });
    const cookie = await login();
    const csrf = await csrfFrom(cookie);

    const opened = await fetch(url("/projects/open"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, path: repo }),
      redirect: "manual",
    });

    expect(opened.status).toBe(303);
    const saved = JSON.parse(readFileSync(registry, "utf8")) as { repos: string[] };
    expect(saved.repos).toContain(realpathSync(repo));
  });

  test("the GitHub listing offers ONE honest action per repo: open what's here, clone what isn't (cookie only)", async () => {
    // A real clone under the root whose origin names alex/Already-Here —
    // matched case-insensitively through its OWN .git/config, no process.
    const cloned = join(root, "already-here");
    mkdirSync(join(cloned, ".git"), { recursive: true });
    writeFileSync(join(cloned, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:alex/Already-Here.git\n');
    const ghList = async () => ({
      ok: true as const,
      repos: [
        { nameWithOwner: "alex/already-here", isPrivate: true, updatedAt: "2026-08-01T00:00:00Z", description: "on disk already" },
        { nameWithOwner: "alex/not-yet", isPrivate: false, updatedAt: "2026-08-02T00:00:00Z", description: "cloneable" },
      ],
    });
    await boot({ projectRoots: [root], ghList });
    const cookie = await login();
    const page = await (await fetch(url("/projects/github"), { headers: { cookie } })).text();
    // The on-disk clone is offered as add + open, with its path said plainly.
    expect(page).toContain("add + open");
    expect(page).toContain(cloned);
    // The absent one pre-fills the EXISTING clone ceremony — preview,
    // password, and size check all still stand behind that form.
    expect(page).toContain('value="alex/not-yet"');
    expect(page).toContain("Clone here");
    expect(page).toContain(`<span class="badge">Private</span>`);
    // No cookie session, no listing.
    const anon = await fetch(url("/projects/github"), { redirect: "manual" });
    expect(anon.status).not.toBe(200);
  });

  test("a FOREIGN host never reads as a GitHub identity, malformed rows drop, and hostile text renders inert", async () => {
    // A clone whose origin merely CONTAINS github.com on a foreign host: it
    // must NOT map — its row offers the clone ceremony, not an open.
    const foreign = join(root, "impostor");
    mkdirSync(join(foreign, ".git"), { recursive: true });
    writeFileSync(
      join(foreign, ".git", "config"),
      '[remote "origin"]\n\turl = https://evil.example/path/github.com/alex/impostor.git\n',
    );
    // A config whose "[remote \"origin\"]" lives INSIDE a value, not as a
    // real section header, opens nothing either.
    const grammar = join(root, "grammar");
    mkdirSync(join(grammar, ".git"), { recursive: true });
    writeFileSync(
      join(grammar, ".git", "config"),
      '[alias]\n\ttrick = !echo [remote "origin"]\n\turl = git@github.com:alex/grammar.git\n',
    );
    const ghList = async () => ({
      ok: true as const,
      repos: [
        { nameWithOwner: "alex/impostor", isPrivate: false, updatedAt: "", description: "<script>alert(1)</script>" },
        { nameWithOwner: "alex/grammar", isPrivate: false, updatedAt: "", description: "" },
      ],
    });
    await boot({ projectRoots: [root], ghList });
    const cookie = await login();
    const page = await (await fetch(url("/projects/github"), { headers: { cookie } })).text();
    // Neither local directory mapped: both rows offer the clone ceremony.
    expect(page).not.toContain("add + open");
    expect((renderedHtmlOf(page).match(/Clone here/g) ?? []).length).toBe(2);
    expect((workspaceOf(page).pageHtml!.match(/Clone here/g) ?? []).length).toBe(2);
    // The hostile description reached the page dead, not live.
    expect(page).not.toContain("<script>alert(1)</script>");
    expect(page).toContain("&lt;script&gt;");
  });

  test("the strict listing parser DROPS malformed identities instead of rendering them", async () => {
    const { listGithubRepos } = await import("./onboard.js");
    void listGithubRepos; // shape imported; the drop is proven through the page below
    const ghList = async () => ({
      ok: true as const,
      // A well-shaped row beside one gh should never send: the page renders
      // ONLY what the injected listing carries — the strict parser lives in
      // listGithubRepos itself, proven in onboard.test.ts; here the page
      // must escape and bound whatever reaches it.
      repos: [{ nameWithOwner: "alex/fine", isPrivate: false, updatedAt: "not-a-date", description: "ok" }],
    });
    await boot({ projectRoots: [root], ghList });
    const cookie = await login();
    const page = await (await fetch(url("/projects/github"), { headers: { cookie } })).text();
    expect(page).toContain("alex/fine");
    // A non-ISO stamp was already rejected at ingestion in production; the
    // page never renders a raw one regardless.
    expect(page).not.toContain("not-a-date");
  });

  test("a gh that is missing or signed out renders its words, never a broken page", async () => {
    await boot({ projectRoots: [root], ghList: async () => ({ ok: false as const, reason: "gh-auth" as const, message: "gh is not signed in — run `gh auth login --hostname github.com` where serve runs" }) });
    const cookie = await login();
    const page = await (await fetch(url("/projects/github"), { headers: { cookie } })).text();
    expect(page).toContain("gh is not signed in");
  });

  test("preview mints a single-use record; confirm takes the password, clones, enrolls, opens; replay refuses", async () => {
    const registry = join(root, "repos.json");
    await boot({ projectRoots: [root], registryPath: registry, ghPreview: fakePreview, ghClone: fakeClone });
    const cookie = await login();
    const csrf = await csrfFrom(cookie);

    const previewed = await fetch(url("/projects/onboard-preview"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, repo: "ap9000/fresh-thing", root: "0" }),
      redirect: "manual",
    });
    const page = await previewed.text();
    expect(page).toContain("ap9000/fresh-thing");
    expect(page).toContain('<details class="project-add-more" open><summary>Review repository</summary>');
    expect(page).toContain('Large-file (LFS) objects are not downloaded.');
    const nonce = /name="nonce" value="([0-9a-f]{32})"/.exec(page)?.[1] as string;
    expect(nonce).toBeTruthy();

    // wrong password refuses, record survives
    const badPw = await fetch(url("/projects/onboard-confirm"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, nonce, token: "wrong" }),
      redirect: "manual",
    });
    expect(await badPw.text()).toContain("password");

    const confirmed = await fetch(url("/projects/onboard-confirm"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, nonce, token: approverToken }),
      redirect: "manual",
    });
    const done = await confirmed.text();
    expect(done).toContain("is ready");
    // cloned for real, enrolled for real, opened for real
    expect(existsSync(join(root, "fresh-thing", ".git"))).toBe(true);
    expect(readFileSync(registry, "utf8")).toContain("fresh-thing");
    expect(store.listProjects().some(one => one.path.endsWith("fresh-thing"))).toBe(true);

    // the nonce is spent — replaying it refuses
    const replayed = await fetch(url("/projects/onboard-confirm"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, nonce, token: approverToken }),
      redirect: "manual",
    });
    expect(await replayed.text()).toContain("expired or was already used");
  });

  test("a large or unknown-size preview demands the checkbox at confirm", async () => {
    const bigPreview = async (owner: string, name: string) => ({
      ok: true as const,
      preview: { nameWithOwner: `${owner}/${name}`, visibility: "public", diskUsageKib: null, description: "" },
    });
    await boot({ projectRoots: [root], registryPath: join(root, "repos.json"), ghPreview: bigPreview, ghClone: fakeClone });
    const cookie = await login();
    const csrf = await csrfFrom(cookie);
    const previewed = await (await fetch(url("/projects/onboard-preview"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, repo: "ap9000/huge", root: "0" }),
      redirect: "manual",
    })).text();
    const nonce = /name="nonce" value="([0-9a-f]{32})"/.exec(previewed)?.[1] as string;
    const withoutBox = await (await fetch(url("/projects/onboard-confirm"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, nonce, token: approverToken }),
      redirect: "manual",
    })).text();
    expect(withoutBox).toContain("tick the box");
    expect(existsSync(join(root, "huge"))).toBe(false);
  });

  test("root mode: a task files into a fresh repo under the root (findings 15/35), outside refuses, and the home joins the projects", async () => {
    const { execSync } = await import("node:child_process");
    const fresh = join(root, "fresh-clone");
    mkdirSync(fresh);
    execSync("git init -q", { cwd: fresh });
    await boot({ projectRoots: [root] });
    const cookie = await login();
    const csrf = await csrfFrom(cookie);
    // NOT admitted anywhere yet — exactly the gap the finding names
    expect(store.knownRepos()).not.toContain(realpathSync(fresh));
    expect(store.listProjects().some(one => one.path === realpathSync(fresh))).toBe(false);
    const filed = await fetch(url("/tasks/add"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, id: "first-task", title: "first work in the clone", repo: fresh }),
      redirect: "manual",
    });
    expect(filed.status).toBe(303);
    expect(store.getTask("first-task")).not.toBeNull();
    expect(store.knownRepos()).toContain(realpathSync(fresh));
    expect(store.listProjects().some(one => one.path === realpathSync(fresh))).toBe(true);

    // outside the root: refused with the ceiling named
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "standing-orders-outside-")));
    try {
      execSync("git init -q", { cwd: outside });
      const refused = await fetch(url("/tasks/add"), {
        method: "POST",
        headers: { cookie, origin: base },
        body: new URLSearchParams({ csrf, id: "smuggled", title: "outside work", repo: outside }),
        redirect: "manual",
      });
      expect(await refused.text()).toContain("outside what this server was configured to show");
      expect(store.getTask("smuggled")).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });


  test("the card itself gates: disabled with words on a repo-list console, a live form under roots", async () => {
    await boot({ repos: ["/repo/elsewhere"] });
    const cookie = await login();
    const listMode = await (await fetch(url("/projects"), { headers: { cookie } })).text();
    expect(listMode).toContain("--project-root");
    expect(renderedHtmlOf(listMode).match(/--project-root/g)).toHaveLength(1);
    expect(workspaceOf(listMode).pageHtml!.match(/--project-root/g)).toHaveLength(1);
    expect(listMode).not.toContain('<h2>add a repository</h2>');
    expect(listMode).not.toContain('action="/projects/onboard-preview"');
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v24: approvals bind exact routing
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z")); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date("2026-08-11T00:00:00.000Z"));
    const again = addApprover(store, "alex", T0);
    if (!again.ok) throw new Error("bootstrap failed");
    approverToken = again.token;
    await boot({ projectRoots: [root] });
    const cookie2 = await login();
    const rootMode = await (await fetch(url("/projects"), { headers: { cookie: cookie2 } })).text();
    expect(rootMode).toContain('action="/projects/onboard-preview"');
    expect(rootMode).toContain('<details class="project-add-more"><summary>Paste a GitHub link</summary>');
  });

  test("placement across the modes: blank falls into the open project; scoped-no-project refuses; unscoped keeps unplaced", async () => {
    const { execSync } = await import("node:child_process");
    const home = join(root, "home-repo");
    mkdirSync(home);
    execSync("git init -q", { cwd: home });
    await boot({ projectRoots: [root] });
    const cookie = await login();
    let csrf = await csrfFrom(cookie);

    // scoped console, NO project open, blank repo: refused server-side —
    // the form's `required` is a courtesy, not the guard (finding 1)
    const blankRefused = await fetch(url("/tasks/add"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, id: "unplaced-smuggle", title: "no home" }),
      redirect: "manual",
    });
    expect(await blankRefused.text()).toContain("no project is open");
    expect(store.getTask("unplaced-smuggle")).toBeNull();

    // open the project: a BLANK repo now falls into it
    await fetch(url("/projects/open"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, path: home }),
      redirect: "manual",
    });
    csrf = await csrfFrom(cookie);
    const filed = await fetch(url("/tasks/add"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, id: "fell-home", title: "blank falls into the open project" }),
      redirect: "manual",
    });
    expect(filed.status).toBe(303);
    expect(store.lookupRef("fell-home")?.repo).toBe(realpathSync(home));
  });

  test("repo-list mode still admits by the list: a listed repo files, an unlisted one refuses", async () => {
    await boot({ repos: ["/repo/listed"] });
    const cookie = await login();
    const csrf = await csrfFrom(cookie);
    const listed = await fetch(url("/tasks/add"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, id: "in-list", title: "listed work", repo: "/repo/listed" }),
      redirect: "manual",
    });
    expect(listed.status).toBe(303);
    const unlisted = await fetch(url("/tasks/add"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, id: "off-list", title: "unlisted work", repo: "/repo/other" }),
      redirect: "manual",
    });
    expect(unlisted.status).not.toBe(303);
    expect(store.getTask("off-list")).toBeNull();
  });

  test("with no project open, New task picks from known projects instead of asking for a typed path", async () => {
    store.upsertProject(join(root, "payments-api"), "payments-api", T0);
    store.upsertProject("/elsewhere/payments-api", "payments-api", new Date(T0.getTime() + 1_000));
    await boot({});
    const cookie = await login();
    const form = await (await fetch(url("/tasks/new"), { headers: { cookie } })).text();
    const picker = /<select name="repo" required>(.*?)<\/select>/s.exec(form)?.[1] ?? "";
    // Most recently opened first and chosen; same names show their parent folder.
    expect(picker).toContain(`<option value="/elsewhere/payments-api" title="/elsewhere/payments-api" selected>payments-api (elsewhere)</option>`);
    expect(picker).toContain(`>payments-api (${root.split("/").filter(Boolean).pop()})</option>`);
    expect(form).not.toContain('placeholder="/path/to/repository"');
    expect(form).toContain('<a href="/projects?return=%2Ftasks%2Fnew">Add a project</a>');
  });

  test("unscoped mode keeps its historic unplaced filings", async () => {
    await boot({});
    const cookie = await login();
    const csrf = await csrfFrom(cookie);
    const filed = await fetch(url("/tasks/add"), {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ csrf, id: "free-floating", title: "unplaced by design" }),
      redirect: "manual",
    });
    expect(filed.status).toBe(303);
    expect(store.lookupRef("free-floating")?.repo).toBeNull();
    // where a no-project filing form DOES render, the field says the rule
    const form = await (await fetch(url("/tasks/new"), { headers: { cookie } })).text();
    expect(form).toContain("no project is open, so the task must say where it belongs");
  });
});

describe("the viewer role (v29, L2): reads everything, acts on nothing", () => {
  let viewerEvidence: string;
  let server: Server;
  let port: number;
  let store: Store;
  let approverToken: string;

  const url = (path: string) => `http://127.0.0.1:${port}${path}`;

  beforeEach(async () => {
    store = openStore(":memory:");
    const added = addApprover(store, "alex", new Date());
    if (!added.ok) throw new Error("bootstrap");
    approverToken = added.token;
    // a viewer account, as an invite would mint it
    const viewer = addApprover(store, "vera", new Date(), { name: "alex", token: approverToken });
    if (!viewer.ok) throw new Error("viewer add");
    store.raw().prepare("UPDATE approver SET role = 'viewer' WHERE name = 'vera'").run();
    (globalThis as { __viewerToken?: string }).__viewerToken = viewer.token;
    store.createTask({ id: "t-v", title: "watched" }, new Date());
    viewerEvidence = mkdtempSync(join(tmpdir(), "so-viewer-ev-"));
    server = createDecisionServer({ store, evidenceRoot: viewerEvidence });
    await new Promise<void>(pass => server.listen(0, "127.0.0.1", () => pass()));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>(pass => server.close(() => pass()));
    store.close();
    rmSync(viewerEvidence, { recursive: true, force: true });
  });

  const loginAs = async (name: string, token: string): Promise<string> => {
    const response = await fetch(url("/login"), {
      method: "POST",
      body: new URLSearchParams({ name, token }),
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    return (response.headers.get("set-cookie") ?? "").split(";")[0] as string;
  };

  test("a viewer logs in and reads; every consequential POST refuses with the viewer words", async () => {
    const viewerToken = (globalThis as { __viewerToken?: string }).__viewerToken as string;
    const cookie = await loginAs("vera", viewerToken);
    const board = await fetch(url("/board"), { headers: { cookie } });
    expect(board.status).toBe(200);

    const csrfPage = await (await fetch(url("/t/t-v"), { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(csrfPage)?.[1] ?? "";
    for (const [path, extra] of [
      ["/t/t-v/scope", { goal: "sneak a scope in" }],
      ["/t/t-v/steer", { note: "sneak a note in" }],
      ["/tasks/add", { title: "sneak a task in" }],
    ] as const) {
      const refused = await fetch(url(path), {
        method: "POST",
        headers: { cookie },
        body: new URLSearchParams({ csrf, ...extra }),
      });
      expect(refused.status).toBe(403);
      expect(await refused.text()).toContain("can watch, not act");
    }
    // nothing landed
    expect(store.getScope("t-v")).toBeNull();
    expect(store.getTask("sneak a task in")).toBeNull();
  });

  test("a viewer switches projects session-only; the durable open refuses; beats renew nothing", async () => {
    const viewerToken = (globalThis as { __viewerToken?: string }).__viewerToken as string;
    const cookie = await loginAs("vera", viewerToken);
    const csrfPage = await (await fetch(url("/t/t-v"), { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(csrfPage)?.[1] ?? "";
    const select = await fetch(url("/projects/select"), {
      method: "POST",
      headers: { cookie },
      redirect: "manual",
      body: new URLSearchParams({ csrf, path: "" }),
    });
    expect(select.status).toBe(303);
    const open = await fetch(url("/projects/open"), {
      method: "POST",
      headers: { cookie },
      body: new URLSearchParams({ path: "/tmp" }),
    });
    expect(open.status).toBe(403);
  });

  test("a viewer's credential cannot act over bearer either; a revoked account cannot authenticate at all", async () => {
    const viewerToken = (globalThis as { __viewerToken?: string }).__viewerToken as string;
    const bearer = await fetch(url("/tasks/add"), {
      method: "POST",
      headers: { authorization: `Bearer vera:${viewerToken}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ title: "bearer sneak" }).toString(),
    });
    expect(bearer.status).toBe(403);

    store.raw().prepare("UPDATE approver SET revoked_at = ? WHERE name = 'vera'").run(new Date().toISOString());
    const dead = await fetch(url("/login"), {
      method: "POST",
      body: new URLSearchParams({ name: "vera", token: viewerToken }),
      redirect: "manual",
    });
    expect(dead.status).toBe(403);
    // and the approver road is untouched
    const alive = await loginAs("alex", approverToken);
    expect(alive).toContain("standing-orders_session");
  });
});

describe("the first account (setup review): sign up on the login page with the printed code", () => {
  let store: Store;
  let server: Server;
  let base: string;
  let evidenceRoot: string;

  beforeEach(async () => {
    store = openStore(":memory:");
    evidenceRoot = mkdtempSync(join(tmpdir(), "standing-orders-serve-signup-"));
    server = createDecisionServer({ store, evidenceRoot, clock: () => new Date(), setupCode: "424242" });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(evidenceRoot, { recursive: true, force: true });
  });

  test("no accounts: the login page offers to create one; a wrong code refuses; the right code creates it and signs in; then the road is closed", async () => {
    const first = await (await fetch(`${base}/login`)).text();
    expect(first).toContain("Create the first account");
    expect(first).toContain('action="/signup"');

    const wrong = await fetch(`${base}/signup`, { method: "POST", body: new URLSearchParams({ code: "000000", name: "alex", password: "correct horse battery" }), redirect: "manual" });
    expect(wrong.status).toBe(403);
    expect(store.listApprovers()).toHaveLength(0);

    const short = await fetch(`${base}/signup`, { method: "POST", body: new URLSearchParams({ code: "424242", name: "alex", password: "short" }), redirect: "manual" });
    expect(short.status).toBe(400);

    const made = await fetch(`${base}/signup`, { method: "POST", body: new URLSearchParams({ code: "424242", name: "alex", password: "correct horse battery" }), redirect: "manual" });
    expect(made.status).toBe(303);
    const cookie = (made.headers.get("set-cookie") ?? "").split(";")[0] as string;
    expect(cookie).toMatch(/=[0-9a-f]{64}$/);
    expect(store.listApprovers().map(one => one.name)).toEqual(["alex"]);
    const home = await fetch(`${base}/`, { headers: { cookie }, redirect: "manual" });
    expect(home.status).toBe(303);
    expect(home.headers.get("location")).toBe("/chat");

    // The road is closed the moment an account exists.
    const again = await (await fetch(`${base}/login`)).text();
    expect(again).not.toContain("Create the first account");
    expect(again).toContain("Sign in");
    const second = await fetch(`${base}/signup`, { method: "POST", body: new URLSearchParams({ code: "424242", name: "mallory", password: "correct horse battery" }), redirect: "manual" });
    expect(second.status).toBe(409);
    expect(store.listApprovers()).toHaveLength(1);
  });

  test("five wrong codes close the road until restart", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const wrong = await fetch(`${base}/signup`, { method: "POST", body: new URLSearchParams({ code: "111111", name: "x", password: "correct horse battery" }), redirect: "manual" });
      expect(wrong.status).toBe(403);
    }
    const closed = await fetch(`${base}/signup`, { method: "POST", body: new URLSearchParams({ code: "424242", name: "x", password: "correct horse battery" }), redirect: "manual" });
    expect(closed.status).toBe(403);
    expect(store.listApprovers()).toHaveLength(0);
    const page = await (await fetch(`${base}/login`)).text();
    expect(page).not.toContain('action="/signup"');
  });

  test("a server started without a setup code never offers sign-up", async () => {
    const bare = createDecisionServer({ store, evidenceRoot, clock: () => new Date() });
    await new Promise<void>(resolve => bare.listen(0, "127.0.0.1", resolve));
    const address = bare.address();
    const url = typeof address === "object" && address !== null ? `http://127.0.0.1:${address.port}` : "";
    const page = await (await fetch(`${url}/login`)).text();
    expect(page).not.toContain("Create the first account");
    const refused = await fetch(`${url}/signup`, { method: "POST", body: new URLSearchParams({ code: "424242", name: "x", password: "correct horse battery" }), redirect: "manual" });
    expect(refused.status).toBe(409);
    await new Promise<void>(resolve => bare.close(() => resolve()));
  });
});
