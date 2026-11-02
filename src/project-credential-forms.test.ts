/**
 * The four project settings that widen what builds and checks reach (docs/plans/passwordless.md: network, where builds
 * write, home folder, check access) are credential acts: their handlers take a password typed now, Passwordless or not.
 * So their forms always show the password field — with Passwordless on too, where ordinary step-ups hide it.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { passwordlessOn } from "./passwordless.js";

let dir: string, repo: string, store: Store, server: Server, base: string, password: string;
const NOW = new Date();

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "so-credential-forms-"));
  repo = join(dir, "shop");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  store = openStore(join(dir, "orders.db"));
  const alex = addApprover(store, "alex", NOW);
  if (!alex.ok) throw new Error("alex");
  password = alex.token;
  const made = store.createConsoleTask({ title: "known", repo, filedVia: "console", filedBy: { name: "alex", kind: "person" } }, NOW);
  if (!made.ok) throw new Error(made.reason);
  server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repo, platform: "darwin", fenceAvailable: () => true });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("listen");
  base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const signIn = async () => (await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token: password }), redirect: "manual" }))
  .headers.getSetCookie().map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session="))!;
const page = async (cookie: string, path = `/settings/project?repo=${encodeURIComponent(repo)}`) => (await fetch(`${base}${path}`, { headers: { cookie } })).text();
const csrfOf = (html: string) => /name="csrf" value="([0-9a-f]{64})"/.exec(html)![1]!;
const post = async (cookie: string, path: string, fields: Record<string, string>) => {
  const answer = await fetch(`${base}${path}`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams(fields), redirect: "manual" });
  return decodeURIComponent(answer.headers.get("location") ?? "");
};
/** The form posting to `action`, as the page renders it. */
const formOf = (html: string, action: string): string => {
  const start = html.indexOf(`action="${action}"`);
  expect(start, `no form for ${action}`).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf("</form>", start));
};
const PASSWORD_FIELD = /<input type="password" name="password" autocomplete="current-password" required>/;
const ACTS = ["/settings/project/writes", "/settings/project/sandbox", "/settings/project/check-access", "/settings/project/network"] as const;

async function passwordlessCookie(): Promise<{ cookie: string; csrf: string }> {
  const cookie = await signIn();
  const csrf = csrfOf(await page(cookie, "/settings/passwordless"));
  expect(await post(cookie, "/settings/passwordless", { csrf, action: "on", password })).toMatch(/Passwordless is on/);
  expect(passwordlessOn(store)).toBe(true);
  return { cookie, csrf };
}

test("with Passwordless on, each of the four forms still shows the password field", async () => {
  const before = await page(await signIn());
  for (const action of ACTS) expect(formOf(before, action), action).toMatch(PASSWORD_FIELD);
  const { cookie } = await passwordlessCookie();
  const html = await page(cookie);
  for (const action of ACTS) expect(formOf(html, action), action).toMatch(PASSWORD_FIELD);
  // An ordinary step-up on the same page still drops its field: Passwordless is in force for this browser.
  expect(formOf(html, "/settings/project/live-view")).not.toMatch(/type="password"/);
});

test("with Passwordless on, each act still refuses without a typed password and saves with it", async () => {
  const { cookie, csrf } = await passwordlessCookie();
  const acts: Array<{ action: string; fields: Record<string, string>; refused: RegExp; saved: () => boolean }> = [
    { action: "/settings/project/writes", fields: { writes: "anywhere" }, refused: /Enter your Toolroll password to change where builds may write/, saved: () => store.projectWrites(repo) === "anywhere" },
    { action: "/settings/project/sandbox", fields: { "read-deny": "~/.ssh", mach: "" }, refused: /Enter your Toolroll password to change the project's sandbox/, saved: () => store.projectSandbox(repo).readDeny.length === 1 },
    { action: "/settings/project/check-access", fields: { level: "unsandboxed" }, refused: /Enter your Toolroll password to change how far checks reach/, saved: () => store.projectCheckAccess(repo) === "unsandboxed" },
    { action: "/settings/project/network", fields: { hosts: "api.stripe.com" }, refused: /Enter your Toolroll password to change what builds may reach/, saved: () => store.projectNetwork(repo).hosts.includes("api.stripe.com") },
  ];
  for (const act of acts) {
    expect(await post(cookie, act.action, { csrf, repo, ...act.fields }), act.action).toMatch(act.refused);
    expect(await post(cookie, act.action, { csrf, repo, ...act.fields, password: "wrong" }), act.action).toMatch(act.refused);
    expect(act.saved(), act.action).toBe(false);
    expect(await post(cookie, act.action, { csrf, repo, ...act.fields, password }), act.action).toMatch(/said=Saved/);
    expect(act.saved(), act.action).toBe(true);
  }
});
