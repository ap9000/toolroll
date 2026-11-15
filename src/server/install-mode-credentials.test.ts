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

const PASSWORD = "alex-password-1";
let dir: string, repo: string, store: Store, server: Server, base: string, cookie = "", csrf = "";
/** What happens while an import reads this computer's tools (the console's wait between the password and the write). */
let duringImport: () => void = () => {};

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-solo-cred-")));
  mkdirSync(join(dir, "config"));
  repo = join(dir, "main");
  mkdirSync(repo);
  store = openStore(join(dir, "toolroll.db"));
  expect(store.bootstrapApproverIfNone("alex", hashPassword(PASSWORD), new Date())).toEqual({ ok: true });
  store.upsertProject(repo, "main", new Date());
  server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repos: [repo], configDir: join(dir, "config"), telegramTokenFile: join(dir, "config", "telegram-token"),
    codexToolList: async () => { duringImport(); return "[]"; } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const login = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token: PASSWORD }), redirect: "manual" });
  cookie = login.headers.getSetCookie().map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session="))!;
  csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(await (await fetch(`${base}/settings/general`, { headers: { cookie } })).text())![1]!;
  // No remembered password: what follows stands on the mode alone.
  expect((await post("/session/forget-password", { return: "/settings/general" })).status).toBe(303);
});
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

  // Last: it rotates the account's password.
  test("an import holds the proved account across its waits: a password changed meanwhile adds nothing", async () => {
    duringImport = () => store.saveApprover("alex", hashPassword("alex-password-2"), new Date());
    const answer = await post("/settings/tools/change", { repo, shown: repo, action: "import", import: "anything", password: PASSWORD });
    expect(await said(answer)).toMatch(/Your access changed while this was read/);
    expect(projectToolsOf(store, repo)).toEqual([]);
  });
});
