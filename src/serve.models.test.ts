/**
 * Settings → Models over real HTTP (docs/plans/spend-dashboard.md slice 3): changing a model is an instance
 * operator's browser step-up. The shared guard refuses a missing or doubled form token and a foreign origin; bearers
 * (an API token, a password used as a token) never reach it; an ended session and a project approver are refused; a
 * stale form writes nothing; a Passwordless session passes with no password; a preset applies exactly the diff it
 * showed. An identity-provider re-check is proved the same way, through the shared prover, and reaches the same write.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { openStore, type Store } from "./store.js";
import { addApprover, authenticateApprover, freshFacts, type FreshFacts } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { mintApiToken } from "./api-tokens.js";
import { INSTALLATION_SCOPE } from "./agentconfig.js";
import { applyModelChoices, OPUS, presetChange, presetInUse, previewModelChange, SONNET } from "./model-choices.js";
import { approveSetup, previewSetup } from "./control-setup.js";

let dir: string, repo: string, store: Store, server: Server, base: string, password: string;

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-models-http-")));
  repo = realpathSync(mkdtempSync(join(tmpdir(), "so-models-repo-")));
  store = openStore(join(dir, "orders.db"));
  const added = addApprover(store, "alex", new Date());
  if (!added.ok) throw new Error("bootstrap");
  password = added.token;
  server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repos: [repo], configDir: dir, terminalHost: null } as Parameters<typeof createDecisionServer>[0]);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("listen");
  base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
  for (const one of [dir, repo]) rmSync(one, { recursive: true, force: true });
});

const login = async (name: string, token: string) => (await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name, token }), redirect: "manual" }))
  .headers.getSetCookie().map(one => one.split(";")[0]!).find(one => one.startsWith("standing-orders_session="))!;
const page = async (cookie: string, path = "/settings/models") => (await fetch(`${base}${path}`, { headers: { cookie } })).text();
const field = (html: string, name: string) => new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? "";
const post = async (headers: Record<string, string>, path: string, body: URLSearchParams) => {
  const response = await fetch(`${base}${path}`, { method: "POST", headers: { origin: base, ...headers }, body, redirect: "manual" });
  return { status: response.status, location: decodeURIComponent(response.headers.get("location") ?? "") };
};
const rows = () => store.listPhaseConfig(INSTALLATION_SCOPE).map(one => `${one.phase}:${one.model}`);

test("the editor's save: forged, foreign, bearer, ended and limited callers change nothing; the operator's password saves", async () => {
  const cookie = await login("alex", password);
  const html = await page(cookie);
  const csrf = field(html, "csrf"), digest = field(html, "digest");
  expect(csrf).not.toBe("");
  expect(digest).toMatch(/^[0-9a-f]{64}$/);
  const form = (over: Record<string, string> = {}) => new URLSearchParams({ csrf, digest, scope: INSTALLATION_SCOPE, build: `claude|${SONNET}`, plan: `claude|${OPUS}`, review: `claude|${OPUS}`, password, ...over });

  // The shared guard: a missing or doubled form token, and another site's page.
  const noToken = form(); noToken.delete("csrf");
  expect((await post({ cookie }, "/settings/models/agent", noToken)).status).toBe(403);
  const twice = form(); twice.append("csrf", csrf);
  expect((await post({ cookie }, "/settings/models/agent", twice)).status).toBe(400);
  expect((await post({ cookie, origin: "https://evil.example" }, "/settings/models/agent", form())).status).toBe(403);
  // A doubled digest is refused by the same guard.
  const twoDigests = form(); twoDigests.append("digest", digest);
  expect((await post({ cookie }, "/settings/models/agent", twoDigests)).status).toBe(400);
  // Bearers never reach a step-up: the password as a token, and a full-access API token.
  const minted = mintApiToken();
  store.createApiToken({ id: minted.id, account: "alex", name: "act", secretHash: minted.hash, access: "act", projects: null, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), by: "alex" }, new Date());
  for (const bearer of [password, minted.token]) expect([401, 403]).toContain((await post({ authorization: `Bearer ${bearer}` }, "/settings/models/agent", form())).status);
  // A wrong password, and a stale form.
  expect((await post({ cookie }, "/settings/models/agent", form({ password: "wrong" }))).location).toMatch(/problem=Enter your Toolroll password/);
  expect((await post({ cookie }, "/settings/models/agent", form({ digest: "0".repeat(64) }))).location).toMatch(/problem=Models changed since this page loaded/);
  // A project approver is not an instance operator.
  const sam = addApprover(store, "sam", new Date(), { name: "alex", token: password });
  if (!sam.ok) throw new Error("sam");
  expect(store.setAccountProjects("sam", [repo], "alex", new Date())).toEqual({ ok: true });
  const samCookie = await login("sam", sam.token);
  const samPage = await page(samCookie);
  expect(samPage).not.toContain('action="/settings/models/agent"');
  expect((await post({ cookie: samCookie }, "/settings/models/agent", new URLSearchParams({ csrf: field(samPage, "csrf"), digest, scope: INSTALLATION_SCOPE, build: `claude|${SONNET}`, password: sam.token }))).status).toBe(403);
  expect(rows()).toEqual([]);

  // The operator, with the password: one save, every role.
  expect((await post({ cookie }, "/settings/models/agent", form())).location).toMatch(/said=All projects: 3 changes saved/);
  expect(rows()).toEqual([`build:${SONNET}`, `plan:${OPUS}`, `review:${OPUS}`]);

  // An ended session changes nothing, even with the right password and form.
  const ended = await login("alex", password);
  const endedPage = await page(ended);
  await post({ cookie: ended }, "/logout", new URLSearchParams({ csrf: field(endedPage, "csrf") }));
  expect((await post({ cookie: ended }, "/settings/models/agent", new URLSearchParams({ csrf: field(endedPage, "csrf"), digest: field(endedPage, "digest"), scope: INSTALLATION_SCOPE, build: `claude|${OPUS}`, password }))).location).not.toMatch(/said=/);
  expect(rows()).toEqual([`build:${SONNET}`, `plan:${OPUS}`, `review:${OPUS}`]);
});

test("a preset shows its exact diff first; applying it carries that diff's digest; Passwordless needs no password", async () => {
  const cookie = await login("alex", password);
  const csrf = field(await page(cookie), "csrf");
  expect((await post({ cookie }, "/settings/passwordless", new URLSearchParams({ csrf, action: "on", password }))).location).toMatch(/Passwordless is on/);
  const preview = await page(cookie, "/settings/models?preset=sized");
  expect(preview).toContain('action="/settings/models/apply"');
  expect(preview).not.toMatch(/type="password" name="password"/);
  expect(preview).toContain("claude-haiku-5-5");
  const hidden = (name: string) => field(preview.slice(preview.indexOf('action="/settings/models/apply"')), name);
  const apply = (over: Record<string, string> = {}) => new URLSearchParams({ csrf, scope: hidden("scope"), preset: hidden("preset"), digest: hidden("digest"), change: hidden("change"), ...over });
  // A different preset under this preview's digest is not what was reviewed.
  expect((await post({ cookie }, "/settings/models/apply", apply({ preset: "opus" }))).location).toMatch(/problem=This change is not the one you reviewed/);
  expect(rows()).toEqual([]);
  expect((await post({ cookie }, "/settings/models/apply", apply())).location).toMatch(/said=Sized by job: 7 changes saved/);
  expect(store.phaseTierConfig(INSTALLATION_SCOPE, "build", "light")?.model).toBe("claude-haiku-5-5");
  // The same preview, applied again, is stale: the rows it was computed from moved.
  expect((await post({ cookie }, "/settings/models/apply", apply())).location).toMatch(/problem=Models changed since this page loaded/);
});

test("an identity-provider re-check stands in for the password, through the shared prover, and reaches the same write", () => {
  let spent = false;
  const facts: FreshFacts = { actor: "alex", local: true, allowlisted: false, live: () => true, passwordAt: () => null, ssoReauthAt: () => null,
    ssoNow: () => (spent ? null : Date.now()), consumeSsoNow: () => { spent = true; return () => {}; }, floor: () => 0, stamp: () => {} };
  const proved = freshFacts.run(facts, () => authenticateApprover(store, "alex", ""));
  expect(proved).toMatchObject({ ok: true, method: "sso-now" });
  const change = presetChange("opus");
  const preview = previewModelChange(store, INSTALLATION_SCOPE, change);
  const result = applyModelChoices(store, { scope: INSTALLATION_SCOPE, change, expected: { state: preview.state, change: preview.change }, strict: true, knownProject: () => false },
    { actor: "alex", generation: store.accountOf("alex")!.generation, method: proved.ok ? proved.method : "", live: facts.live }, new Date());
  expect(result).toMatchObject({ ok: true });
  // Spent: the same re-check doesn't prove a second change.
  expect(freshFacts.run(facts, () => authenticateApprover(store, "alex", ""))).toMatchObject({ ok: false });
});

test("a fresh installation: the page opens on Sized by job, ready to apply, with no terminal command; setup applies it", async () => {
  const cookie = await login("alex", password);
  const html = await page(cookie);
  expect(html).toContain("Start with Sized by job");
  expect(html).not.toMatch(/config set|toolroll config/);
  // Project setup on a fresh installation previews and applies the whole default, through the same write path.
  const inputs = { provider: "claude", model: SONNET, command: "", seconds: "300" };
  const preview = previewSetup(store, repo, inputs);
  if (!preview.ok) throw new Error(preview.message);
  expect(preview.models?.rows.length).toBe(7);
  expect(approveSetup(store, repo, inputs, preview.fingerprint, "alex", password, new Date())).toEqual({ ok: true });
  expect(presetInUse(store, INSTALLATION_SCOPE)).toBe("sized");
  expect(presetInUse(store, repo)).toBe("sized");
  expect(store.phaseConfig(repo, "build")).toBeNull(); // Sonnet 5.5 is what it inherits: no project row of its own
  // A second project's setup leaves the chosen installation alone.
  expect(previewSetup(store, repo, inputs)).toMatchObject({ ok: true, models: null });
});
