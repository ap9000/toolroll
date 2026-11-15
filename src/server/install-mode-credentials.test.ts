/**
 * Solo never skips a credential check (install-mode.ts; Codex round 1 finding 1): on a solo install the signed-in
 * session stands in for ordinary step-ups, but connecting a tool, adding or importing tools, saving a tool's secret,
 * changing where monitoring sends, widening new tasks to Full access and turning pull requests on still take a
 * password typed now. Isolated store and folders; nothing leaves the machine.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { hashPassword } from "../scope.js";
import { createDecisionServer } from "../serve.js";
import { openStore, type Store } from "../store.js";
import { soloNow } from "../install-mode.js";
import { projectToolsOf } from "../project-tools.js";
import { readAuthMode } from "../keys.js";
import { loadBotToken } from "../telegram.js";
import { readEmailSettings } from "../flow-actions.js";
import { readGoogleMail } from "../google-mail.js";

const PASSWORD = "alex-password-1";
let dir: string, repo: string, store: Store, server: Server, base: string, cookie = "", csrf = "";
/** What happens while an import reads this computer's tools (the console's wait between the password and the write). */
let duringImport: () => void = () => {};
/** What happens while a tool connection asks the service for its sign-in (the wait between the password and the visit). */
let duringConnect: () => void = () => {};
const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
/** Stripe's sign-in as its servers answer it (serve.tools.test.ts), with a hook in the middle of the wait. */
const stripe = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input), method = init?.method ?? "GET";
  if (url === "https://mcp.stripe.com/" && method === "POST") { duringConnect(); return reply(401, {}, { "www-authenticate": 'Bearer resource_metadata="https://mcp.stripe.com/.well-known/oauth-protected-resource"' }); }
  if (url === "https://mcp.stripe.com/.well-known/oauth-protected-resource") return reply(200, { resource: "https://mcp.stripe.com", authorization_servers: ["https://access.stripe.com/mcp"] });
  if (url === "https://access.stripe.com/.well-known/oauth-authorization-server/mcp") return reply(200, { authorization_endpoint: "https://access.stripe.com/mcp/oauth2/authorize", token_endpoint: "https://access.stripe.com/mcp/oauth2/token",
    registration_endpoint: "https://access.stripe.com/mcp/oauth2/register", code_challenge_methods_supported: ["S256"] });
  if (url === "https://access.stripe.com/mcp/oauth2/register") return reply(201, { client_id: "client-7" });
  return reply(404, {});
}) as typeof fetch;

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-solo-cred-")));
  mkdirSync(join(dir, "config"));
  repo = join(dir, "main");
  mkdirSync(repo);
  store = openStore(join(dir, "toolroll.db"));
  expect(store.bootstrapApproverIfNone("alex", hashPassword(PASSWORD), new Date())).toEqual({ ok: true });
  store.upsertProject(repo, "main", new Date());
  server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repos: [repo], configDir: join(dir, "config"), telegramTokenFile: join(dir, "config", "telegram-token"),
    codexToolList: async () => { duringImport(); return "[]"; }, connectFetch: stripe, connectionHome: join(dir, "home") } as Parameters<typeof createDecisionServer>[0]);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await signIn(PASSWORD);
});
/** Sign in, then forget the password typed: what follows stands on the mode alone. */
async function signIn(password: string): Promise<void> {
  const login = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token: password }), redirect: "manual" });
  cookie = login.headers.getSetCookie().map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session="))!;
  csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(await (await fetch(`${base}/settings/general`, { headers: { cookie } })).text())![1]!;
  expect((await post("/session/forget-password", { return: "/settings/general" })).status).toBe(303);
}
afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function post(path: string, fields: Record<string, string>) {
  return fetch(base + path, { method: "POST", headers: { cookie, origin: base }, redirect: "manual", body: new URLSearchParams({ csrf, ...fields }) });
}
const said = async (answer: Response) => decodeURIComponent((answer.headers.get("location") ?? "") + (answer.status === 303 ? "" : await answer.text())).replace(/\+/g, " ");

describe("on a solo install, credential acts still take a password typed now", () => {
  test("the install is solo, so an ordinary step-up would stand on the session", () => {
    expect(soloNow(store)).toBe(true);
  });

  test.each([
    ["add a tool from the list", "/settings/tools/change", () => ({ repo, shown: repo, action: "add-catalog", catalog: "playwright" })],
    ["import tools", "/settings/tools/change", () => ({ repo, shown: repo, action: "import", import: "x" })],
    ["save a tool's secret", "/settings/tools/change", () => ({ repo, shown: repo, action: "secret", name: "playwright", secret: "API_KEY", value: "s3cret" })],
    ["connect a tool", "/settings/tools/connect", () => ({ repo, shown: repo, service: "linear" })],
    ["change where monitoring goes", "/settings/monitoring", () => ({ webhook: "https://hooks.example/alerts" })],
    ["turn pull requests on", "/settings/pull-requests", () => ({ repo, act: "on", github: "me/main", base: "main" })],
  ] as const)("%s: the session alone is refused, and nothing changes", async (_name, path, fields) => {
    const answer = await post(path, { ...fields(), password: "" });
    expect(await said(answer)).toMatch(/password/i);
    expect(projectToolsOf(store, repo)).toEqual([]);
  });

  test("widening new tasks to Full access: refused on the session alone, allowed with the password typed", async () => {
    const bare = await post("/settings/permission-default", { "permission-mode": "bypassPermissions", password: "" });
    expect(await said(bare)).toMatch(/problem=Enter your Toolroll password/);
    expect(store.permissionDefault().mode).toBe("auto");
    expect((await post("/settings/permission-default", { "permission-mode": "bypassPermissions", password: PASSWORD })).status).toBe(303);
    expect(store.permissionDefault().mode).toBe("bypassPermissions");
  });

  test("an AI provider key (or how it's paid): refused without the password, saved with it", async () => {
    const home = join(dir, "home");
    const fields = { provider: "claude", "auth-mode": "api-key", value: "" };
    expect(await said(await post("/settings/provider-key", { ...fields, password: "" }))).toMatch(/problem=Enter your Toolroll password to save a key/);
    expect(readAuthMode("claude", home)).toBe("subscription");
    expect(await said(await post("/settings/provider-key", { ...fields, password: PASSWORD }))).toMatch(/now uses the API key/);
    expect(readAuthMode("claude", home)).toBe("api-key");
  });

  test("the Telegram bot token: refused without the password, saved with it", async () => {
    const file = join(dir, "config", "telegram-token");
    const token = "123456789:AAHabcdefghijklmnopqrstuvwxyz0123456";
    expect(await said(await post("/settings/telegram-token", { token, password: "" }))).toMatch(/problem=Enter your Toolroll password to save the bot token/);
    expect(loadBotToken({}, file)).toBeNull();
    expect(await said(await post("/settings/telegram-token", { token, password: PASSWORD }))).toMatch(/said=Bot token saved/);
    expect(loadBotToken({}, file)?.token).toBe(token);
  });

  test("the mail account: refused without the password (the form's token), saved with it", async () => {
    const fields = { host: "smtp.example.com", port: "587", from: "me@example.com", user: "me@example.com", password: "mail-app-password" };
    expect(await said(await post("/settings/email", { ...fields, token: "" }))).toMatch(/problem=Enter your Toolroll password to save email/);
    expect(readEmailSettings(join(dir, "config"))).toBeNull();
    expect(await said(await post("/settings/email", { ...fields, token: PASSWORD }))).not.toMatch(/problem=/);
    expect(readEmailSettings(join(dir, "config"))).toMatchObject({ host: "smtp.example.com", from: "me@example.com" });
  });

  test("a Google account: refused without the password, saved with it", async () => {
    const fields = { clientId: "123456789-abcdefghij.apps.googleusercontent.com", clientSecret: "google-client-secret" };
    expect(await said(await post("/settings/google", { ...fields, password: "" }))).toMatch(/problem=Enter your Toolroll password to connect Google/);
    expect(readGoogleMail(join(dir, "config"))).toBeNull();
    const connected = await post("/settings/google", { ...fields, password: PASSWORD });
    expect(await said(connected)).not.toMatch(/problem=/);
    expect(readGoogleMail(join(dir, "config"))).toMatchObject({ clientId: "123456789-abcdefghij.apps.googleusercontent.com" });
  });

  // Last: these rotate the account's password.
  test("a tool connection holds the generation its password proved: a password changed during discovery starts nothing", async () => {
    duringConnect = () => store.saveApprover("alex", hashPassword("alex-password-2"), new Date());
    const answer = await post("/settings/tools/connect", { repo, shown: repo, service: "stripe", password: PASSWORD });
    expect(answer.headers.get("location") ?? "").not.toMatch(/stripe\.com/);
    expect(await said(answer)).toMatch(/Your sign-in changed/);
    duringConnect = () => {};
  });

  test("an import holds the proved account across its waits: a password changed meanwhile adds nothing", async () => {
    await signIn("alex-password-2");
    duringImport = () => store.saveApprover("alex", hashPassword("alex-password-3"), new Date());
    const answer = await post("/settings/tools/change", { repo, shown: repo, action: "import", import: "anything", password: "alex-password-2" });
    expect(await said(answer)).toMatch(/Your access changed while this was read/);
    expect(projectToolsOf(store, repo)).toEqual([]);
  });
});
