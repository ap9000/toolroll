/** Settings → Project → Check access (check-access.ts): what the console shows, and who may change it how. */
import { afterEach, beforeEach, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { createDecisionServer } from "./serve.js";

let dir: string, repo: string, store: Store, server: Server, base: string;
const tokens: Record<string, string> = {};
const NOW = new Date();

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "so-check-access-ui-"));
  repo = join(dir, "shop");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  store = openStore(join(dir, "orders.db"));
  const alex = addApprover(store, "alex", NOW);
  if (!alex.ok) throw new Error("alex");
  tokens["alex"] = alex.token;
  const sam = addApprover(store, "sam", NOW, { name: "alex", token: alex.token });
  if (!sam.ok) throw new Error("sam");
  tokens["sam"] = sam.token;
  expect(store.setAccountProjects("sam", [repo], "alex", NOW)).toEqual({ ok: true });
  const made = store.createConsoleTask({ title: "known", repo, filedVia: "console", filedBy: { name: "alex", kind: "person" } }, NOW);
  if (!made.ok) throw new Error(made.reason);
  server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repo });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("listen");
  base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const signIn = async (name: string) => (await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name, token: tokens[name]! }), redirect: "manual" }))
  .headers.getSetCookie().map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session="))!;
const page = async (cookie: string) => (await fetch(`${base}/settings/project?repo=${encodeURIComponent(repo)}`, { headers: { cookie } })).text();
const save = async (cookie: string, fields: Record<string, string>) => {
  const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(await page(cookie))![1]!;
  const answer = await fetch(`${base}/settings/project/check-access`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf, repo, ...fields }), redirect: "manual" });
  return { status: answer.status, said: decodeURIComponent(answer.headers.get("location") ?? "") || ((text: string) => text.slice(text.indexOf("Request refused</h1>") + 20).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200))(await answer.text()) };
};

test("the section says the level and shows each wider level's warning before anyone chooses it", async () => {
  const html = await page(await signIn("alex"));
  expect(html, html.slice(-3000)).toContain(`id="check-access"`);
  expect(html).toContain("<h2 id=\"check-access-title\">Check access</h2><p><strong>Sandboxed</strong></p>");
  // Each wider level's warning sits once, under its own option (shown while it is chosen).
  expect(html).toMatch(/data-check-access-warning="sign-ins">This project(?:'|&#39;)s checks can read your Claude, Codex and GitHub sign-ins/);
  expect(html).toMatch(/data-check-access-warning="unsandboxed">This project(?:'|&#39;)s checks get your full access/);
  expect(html).toContain("Flow script steps always run sandboxed. Tasks already approved keep their level.");
});

test("an instance operator widens it with a password typed now; a wrong one changes nothing; the sign-ins name the hosts they'd need", async () => {
  const alex = await signIn("alex");
  expect((await save(alex, { level: "sign-ins", password: "wrong" })).said).toMatch(/Enter your Toolroll password/);
  expect(store.projectCheckAccess(repo)).toBe("sandboxed");
  expect((await save(alex, { level: "sign-ins", password: tokens["alex"]! })).said).toMatch(/Saved/);
  expect(store.projectCheckAccess(repo)).toBe("sign-ins");
  // Never added to the network: the page says which hosts and where to add them, as a change of its own.
  expect(store.projectNetwork(repo).hosts).toEqual([]);
  const shown = await page(alex);
  expect(shown).toMatch(/data-sign-in-hosts>8 sign-in hosts aren(?:'|&#39;)t allowed yet · <a href="#network">Add them<\/a>/);
  expect(shown).toMatch(/<summary>Show hosts<\/summary><p class="tool-name">api\.anthropic\.com, /);
});

test("an approver limited to this project can't change it here (the settings area needs instance access): nothing changes", async () => {
  const sam = await signIn("sam");
  const widened = await save(sam, { level: "unsandboxed", password: tokens["sam"]! });
  expect(widened.status).toBe(403);
  expect(widened.said).toMatch(/requires instance access/);
  expect(store.projectCheckAccess(repo)).toBe("sandboxed");
  // (Narrowing is theirs through the CLI, project check-access: check-access.test.ts.)
});

test("sign-ins with an open network takes a second, explicit yes", async () => {
  store.setProjectNetwork(repo, { mode: "open", hosts: [], loopback: "proxy-only" }, "alex", NOW);
  const alex = await signIn("alex");
  expect(await page(alex)).toContain('name="confirm-open"');
  expect((await save(alex, { level: "sign-ins", password: tokens["alex"]! })).said).toMatch(/confirm that its checks could send your sign-ins to any host/);
  expect(store.projectCheckAccess(repo)).toBe("sandboxed");
  expect((await save(alex, { level: "sign-ins", "confirm-open": "yes", password: tokens["alex"]! })).said).toMatch(/Saved/);
  expect(store.projectCheckAccess(repo)).toBe("sign-ins");
});

test("widening takes a password typed now on both roads: an identity-provider re-check never widens", async () => {
  // A live re-check needs a provider session; the rule is pinned where each road decides (as passwordless-credentials does).
  const { readFileSync } = await import("node:fs");
  const settings = readFileSync("src/server/settings.ts", "utf8");
  const cli = readFileSync("src/operate.ts", "utf8");
  expect(settings).toMatch(/if \(widening && \(proved\.method !== "password-now" \|\| !store\.isInstanceOperator\(who\.name\)\)\)/);
  expect(cli).toMatch(/proved\.method !== "password-now" \|\| !context\.store\.isInstanceOperator\(acting\.name\)/);
  // And the write itself refuses a widening by anyone but an instance operator, whatever was claimed.
  expect(store.setProjectCheckAccess(repo, "unsandboxed", "sam", NOW, { may: "widen" })).toBeNull();
});

test("on a machine that can't sandbox checks at all, the section says so before anyone chooses", async () => {
  const { projectSettingsHtml } = await import("./project-delete-ui.js");
  expect(typeof projectSettingsHtml).toBe("function");
  // The words the section shows when no OS sandbox exists (rendered in the page; the flag comes from serve.ts).
  const ui = (await import("node:fs")).readFileSync("src/project-delete-ui.ts", "utf8");
  expect(ui).toContain("This machine can't sandbox checks, so they run without a sandbox whatever is chosen here.");
  expect((await import("node:fs")).readFileSync("src/serve.ts", "utf8")).toMatch(/unconfinedHere: !\(macosFenceAvailable\(\) \|\| linuxFenceAvailable\(\)\) && store\.unfencedAgentsAllowed\(\)/);
});
