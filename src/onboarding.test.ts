/**
 * Onboarding (docs/design/onboarding.md): the one-time sign-in link, the
 * wrong-host page, this computer's tailnet name, the lead on by default with
 * the signed-in agent, Chat asking again on its own while none is, and
 * Settings → Lead. Real console, stubbed sign-in checks: no model, no network.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ExecResult } from "./exec.js";
import { htmlString } from "./html.js";
import { addApprover } from "./scope.js";
import { createDecisionServer, redactedPath, SIGN_IN_LINK_MS, wrongHostPage, type DecisionServer } from "./serve.js";
import { openStore, type Store } from "./store.js";

const answer = (stdout: string, code = 0): ExecResult => ({ code, stdout, stderr: "", timedOut: false, notFound: false });
const notInstalled: ExecResult = { code: -1, stdout: "", stderr: "", timedOut: false, notFound: true };
/** Who is signed in on this pretend computer: "claude", "codex", or nobody. */
let signedIn: "claude" | "codex" | null = null;
const probe = async (file: string): Promise<ExecResult> => {
  if (file === "claude") return signedIn === "claude" ? answer(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" })) : notInstalled;
  if (file === "codex") return signedIn === "codex" ? answer("Logged in using ChatGPT\n") : notInstalled;
  return notInstalled;
};

let dir: string, store: Store, server: DecisionServer, base: string, port: number, password: string;

async function start(extra: Partial<Parameters<typeof createDecisionServer>[0]> = {}) {
  server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repo: join(dir, "shop"), configDir: dir, connectionHome: join(dir, "home"),
    connectionProbe: probe as never, firstTaskRunner: async () => answer("", 1), chatEnv: {}, platform: "darwin", ...extra });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  port = typeof address === "object" && address !== null ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
}

beforeEach(() => {
  signedIn = null;
  dir = mkdtempSync(join(tmpdir(), "toolroll-onboarding-"));
  mkdirSync(join(dir, "shop")); mkdirSync(join(dir, "home")); mkdirSync(join(dir, "evidence"));
  writeFileSync(join(dir, "shop", "README.md"), "# Shop\n");
  execFileSync("git", ["init", "-q"], { cwd: join(dir, "shop") });
  store = openStore(":memory:");
  const added = addApprover(store, "alex", new Date());
  if (!added.ok) throw new Error("no approver");
  password = added.token;
});
afterEach(async () => {
  vi.useRealTimers();
  await new Promise<void>(done => server.close(() => done()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A raw request, so the Host header and the peer are exactly what's given (fetch corrects a spoofed Host). */
function raw(path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, headers: { Host: `127.0.0.1:${port}`, ...headers } }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}
const cookieOf = (headers: Record<string, string | string[] | undefined>) => String([headers["set-cookie"] ?? ""].flat()[0]).split(";")[0]!;
async function signIn(): Promise<string> {
  const response = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token: password }), redirect: "manual" });
  return (response.headers.get("set-cookie") ?? "").split(";")[0]!;
}
const workspace = async (cookie: string, path = "/chat") => (await fetch(`${base}${path}${path.includes("?") ? "&" : "?"}format=workspace`, { headers: { cookie } })).json() as Promise<import("./browser-workspace.js").BrowserWorkspace>;
const until = async (what: () => boolean) => { for (let i = 0; i < 100 && !what(); i++) await new Promise(done => setTimeout(done, 20)); };

test("the one-time sign-in link: this computer only, once, for ten minutes, and never in the ledger", async () => {
  await start({ allowedHosts: ["pi.local:4180"] });
  const link = server.mintSignInLink("alex")!;
  expect(link).toMatch(/^\/login\/once\/[A-Za-z0-9_-]{43}$/);
  expect(server.mintSignInLink("nobody")).toBeNull();

  const first = await raw(link);
  expect(first.status).toBe(303);
  expect(first.headers.location).toBe("/chat");
  const chat = await fetch(`${base}/chat`, { headers: { cookie: cookieOf(first.headers) }, redirect: "manual" });
  expect(chat.status).toBe(200);
  // Single use.
  const again = await raw(link);
  expect(again.status).toBe(410);
  expect(again.headers["set-cookie"]).toBeUndefined();
  expect(again.body).toContain("That sign-in link has been used or has expired.");

  // Not from another device: a forwarded request, or one that names another address, is refused (and spends the link).
  const forwarded = server.mintSignInLink("alex")!;
  expect((await raw(forwarded, { "X-Forwarded-For": "100.64.0.7" })).status).toBe(403);
  expect((await raw(forwarded)).status).toBe(410);
  const elsewhere = server.mintSignInLink("alex")!;
  const named = await raw(elsewhere, { Host: "pi.local:4180" });
  expect(named.status).toBe(403);
  expect(named.body).toContain("works only in a browser on the computer running Toolroll");

  // Ten minutes.
  const late = server.mintSignInLink("alex")!;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + SIGN_IN_LINK_MS + 1000);
  expect((await raw(late)).status).toBe(410);
  vi.useRealTimers();

  // The ledger notes the sign-in, never the link.
  const ledger = JSON.stringify(store.handle.prepare("SELECT * FROM action_ledger").all());
  expect(ledger).toContain("one-time link");
  for (const one of [link, forwarded, elsewhere, late]) expect(ledger).not.toContain(one.slice("/login/once/".length));
  expect(redactedPath(link)).toBe("/login/once/…");
});

test("a wrong host explains itself: the address opened, where it answers, and the exact command", async () => {
  await start({ upConsole: true, allowedHosts: ["pi.local:4180"] });
  const refused = await raw("/chat", { Host: "studio.lan:8080" });
  expect(refused.status).toBe(421);
  expect(refused.headers["content-type"]).toContain("text/html");
  expect(refused.body).toContain("Toolroll isn't set up for this address");
  expect(refused.body).toContain(`You opened it at <code>studio.lan:8080</code>. It answers at <code>127.0.0.1:${port}</code>`);
  expect(refused.body).toContain(`toolroll up --port ${port} --allow-host pi.local:4180,studio.lan:8080`);
  expect(refused.body).not.toContain("<script");
  // A name that isn't a host gets no command, and nothing it sent comes back.
  const odd = await raw("/", { Host: "<b>x</b>" });
  expect(odd.status).toBe(421);
  expect(odd.body).not.toContain("<b>x</b>");
  expect(odd.body).not.toContain("--allow-host");
  expect(htmlString(wrongHostPage({ opened: "a.b:1", served: "127.0.0.1:4180", command: "toolroll up --allow-host a.b:1" }))).toContain("<pre><code>toolroll up --allow-host a.b:1</code></pre>");
});

test("localhost, 127.0.0.1 and this computer's own tailnet name on the served port are allowed without asking", async () => {
  await start({ tailnetNames: async () => ["mac.tail1234.ts.net", "mac"] });
  await until(() => false);
  for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `mac.tail1234.ts.net:${port}`, `mac:${port}`]) {
    expect((await raw("/login", { Host: host })).status, host).toBe(200);
  }
  for (const host of ["mac.tail1234.ts.net:1", `other.tail1234.ts.net:${port}`, "mac.tail1234.ts.net"]) {
    expect((await raw("/login", { Host: host })).status, host).toBe(421);
  }
});

test("with Claude Code signed in, the lead is on by default, says so in one line, and nothing was typed", async () => {
  signedIn = "claude";
  await start({ leadByDefault: true });
  await until(() => store.getChatConfig() !== null);
  expect(store.getChatConfig()).toMatchObject({ provider: "claude-subscription", model: "default", dailyTurns: 50, weeklyCeilingMicrousd: 0, updatedBy: "toolroll" });
  const cookie = cookieOf((await raw(server.mintSignInLink("alex")!)).headers);
  // The link lands on Chat, which opens ready to talk: no password, no form.
  expect((await fetch(`${base}/chat`, { headers: { cookie } })).status).toBe(200);
  const shown = await workspace(cookie);
  expect(shown.conversation).not.toBeNull();
  expect(shown.firstRun?.lead).toEqual({ words: "The lead uses your Claude Code sign-in", href: "/settings/lead" });
  expect(shown.firstRun?.intro).toBe("Ask for a change. The lead writes a short plan; you approve it; an agent builds it on its own branch; it's Ready when your tests pass.");
  expect(shown.firstRun?.suggestions).toHaveLength(3);
  expect(shown.firstRun?.recheck).toBeNull();
});

test("with only Codex signed in, Codex runs the lead", async () => {
  signedIn = "codex";
  await start({ leadByDefault: true });
  await until(() => store.getChatConfig() !== null);
  expect(store.getChatConfig()?.provider).toBe("codex-subscription");
});

test("with no agent signed in, Chat shows the install-and-sign-in command for this computer and asks again on its own", async () => {
  await start({ leadByDefault: true });
  const cookie = await signIn();
  await workspace(cookie); // the first look starts this computer's check
  await new Promise(done => setTimeout(done, 100));
  const shown = await workspace(cookie);
  expect(shown.conversation).toBeNull();
  const agent = shown.firstRun!.steps.find(one => one.key === "agent")!;
  expect(agent.done).toBe(false);
  expect(agent.action).toEqual({ kind: "command", command: "npm install -g @anthropic-ai/claude-code && claude auth login" });
  expect(shown.firstRun!.recheck).toBe("/lead/status");
  // The page may ask: its policy lets it reach this server.
  expect((await fetch(`${base}/chat`, { headers: { cookie } })).headers.get("content-security-policy")).toContain("connect-src 'self'");
  // No jargon form on Chat any more.
  expect(shown.pageHtml ?? "").not.toContain('action="/chat/config"');
  expect(shown.pageHtml ?? "").not.toContain("Weekly ceiling");

  expect(await (await fetch(`${base}/lead/status`, { headers: { cookie } })).json()).toMatchObject({ lead: "off", agent: false });
  // The person runs the command; the next check finds it and the lead turns on.
  signedIn = "claude";
  // The next check is due 4 s on: move the clock, not the wall.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 4100);
  expect(await (await fetch(`${base}/lead/status`, { headers: { cookie } })).json()).toMatchObject({ lead: "on", agent: true });
  expect(store.getChatConfig()?.provider).toBe("claude-subscription");
  expect((await fetch(`${base}/lead/status`, { redirect: "manual" })).status).toBe(303);
}, 15_000);

test("Settings → Lead: one line, the full form under Advanced, and a lead turned off stays off", async () => {
  signedIn = "claude";
  await start({ leadByDefault: true });
  await until(() => store.getChatConfig() !== null);
  const cookie = await signIn();
  const page = await (await fetch(`${base}/settings/lead`, { headers: { cookie } })).text();
  expect(page).toContain("The lead uses your Claude Code sign-in.");
  expect(page).toContain("<summary>Advanced</summary>");
  expect(page).toContain('action="/chat/config"');
  const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(page)![1]!;
  const off = await fetch(`${base}/chat/config`, { method: "POST", headers: { cookie, origin: base }, redirect: "manual",
    body: new URLSearchParams({ csrf, return: "/settings/lead", off: "1", token: password }) });
  expect(off.headers.get("location")).toMatch(/^\/settings\/lead\?said=/);
  expect(store.getChatConfig()).toBeNull();
  // The next check is due 4 s on: move the clock, not the wall.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 4100);
  expect(await (await fetch(`${base}/lead/status`, { headers: { cookie } })).json()).toMatchObject({ lead: "off", agent: true });
  expect(store.getChatConfig()).toBeNull();
  // One tap turns it back on with the signed-in agent; no password, it spends no dollars.
  const again = await (await fetch(`${base}/settings/lead`, { headers: { cookie } })).text();
  expect(again).toContain("Use your Claude Code sign-in");
  const on = await fetch(`${base}/settings/lead/on`, { method: "POST", headers: { cookie, origin: base }, redirect: "manual", body: new URLSearchParams({ csrf }) });
  expect(on.headers.get("location")).toBe("/chat");
  expect(store.getChatConfig()?.provider).toBe("claude-subscription");
}, 15_000);

test("after the first Ready result, Chat offers the phone once, until put away; the setup itself stays in Settings → Chat apps", async () => {
  signedIn = "claude";
  await start({ leadByDefault: true, tailnetNames: async () => ["mac.tail1234.ts.net", "mac"], telegramTokenFile: join(dir, "telegram-token") });
  await until(() => store.getChatConfig() !== null);
  const cookie = await signIn();
  expect((await workspace(cookie)).phone).toBeUndefined();
  store.recordInstallationFact("first-success-at", new Date().toISOString(), new Date());
  const shown = await workspace(cookie);
  expect(shown.firstRun).toBeUndefined();
  expect(shown.phone).toEqual({
    chatApps: [{ label: "Telegram", href: "/settings/telegram" }, { label: "Slack", href: "/settings/slack" }, { label: "Discord", href: "/settings/discord" }, { label: "Teams", href: "/settings/teams" }],
    tailnet: { address: `http://mac.tail1234.ts.net:${port}/`, restart: `toolroll serve --host 0.0.0.0 --port ${port}` },
    dismissHref: "/onboarding/phone/dismiss",
  });
  const page = await (await fetch(`${base}/settings/lead`, { headers: { cookie } })).text();
  const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(page)![1]!;
  const put = await fetch(`${base}/onboarding/phone/dismiss`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf, quiet: "1" }) });
  expect(put.status).toBe(204);
  expect((await workspace(cookie)).phone).toBeUndefined();
  // Putting chat's line away leaves the setup in Settings, in both the page and its fallback.
  const settings = await workspace(cookie, "/settings");
  expect(settings.view?.kind === "settings" ? settings.view.phone?.chatApps.map(one => one.label) : null).toEqual(["Telegram", "Slack", "Discord", "Teams"]);
  const fallback = await (await fetch(`${base}/settings`, { headers: { cookie } })).text();
  expect(fallback).toContain('data-phone-card><h2 id="phone-card-title">Use it from your phone</h2>');
});
