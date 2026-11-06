/**
 * One-tap release approval (docs/plans/trusted-release-reports.md, slice A) against the real console: the sheet and its
 * Approve release go through the task approval door (cookie only, CSRF, the single-use nonce bound to the card digest,
 * a password or a standing proof) and the shared card wrapper; a stale card, a replayed nonce, a bearer token, another
 * project's person or a non-release task gets nothing; the push locator only redirects; the service worker opens the
 * locator while an older one falls back to /next; hostile commit subjects reach the page as escaped, control-free text;
 * and a laptop's local owner can't approve a release, even typing a password.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Server } from "node:http";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { releaseFixture, FIXTURE_PASSWORD, VERSION, type ReleaseFixture } from "../release-fixture.js";
import { createDecisionServer } from "../../src/serve.js";
import { addApprover, personApprovalOf, propose } from "../../src/scope.js";
import { recordReleaseCi } from "../../src/release-approval.js";
import { releaseCheckPurposeFor, releaseTermsFor } from "../../src/release-carry.js";
import { mintApiToken } from "../../src/api-tokens.js";
import { setLimitOverride } from "../../src/request-budget.js";
import { openLocalWorld } from "../local-owner-world.js";

const NOW = new Date("2026-10-25T12:00:00.000Z");
const HOSTILE = "Fix <script>alert(1)</script>\x1b[2J\x1b]8;;https://evil.example/\x07link\x1b]8;;\x07‮txt.exe";
let f: ReleaseFixture, server: Server, base = "", cookie = "", limitedCookie = "", bearer = "", ref = 0;

const page = async (path: string, as = cookie) => { const answer = await fetch(`${base}${path}`, { headers: { cookie: as }, redirect: "manual" }); return { status: answer.status, location: answer.headers.get("location"), body: await answer.text() }; };
const field = (body: string, name: string) => new RegExp(`name="${name}" value="([^"]*)"`).exec(body)?.[1] ?? "";
const approvePost = async (form: Record<string, string>, headers: Record<string, string> = { cookie }) => {
  const answer = await fetch(`${base}/t/${f.taskId}/approve`, { method: "POST", redirect: "manual", headers: { ...headers, origin: base, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form) });
  return { status: answer.status, location: answer.headers.get("location"), body: await answer.text() };
};
const sheetForm = (body: string) => ({ csrf: field(body, "csrf"), nonce: field(body, "nonce"), digest: field(body, "digest"), sheet: field(body, "sheet") });

beforeAll(async () => {
  f = releaseFixture({ termsless: true, approve: false, intermediate: { "src/q.js": "1\n" }, candidate: { "src/card.js": "1\n" } });
  // The hostile subject is the candidate's own commit message: amend it in.
  f.git("commit", "--amend", "-q", "-m", HOSTILE);
  const amended = f.git("rev-parse", "HEAD");
  // File the release again for the amended commit (the fixture's task named the old one).
  const purpose = releaseCheckPurposeFor(f.store, { repo: f.repo, version: VERSION, branch: "release-0.9.71", pr: 240, candidate: amended });
  if (!purpose.ok) throw new Error(purpose.why);
  propose(f.store, { taskId: f.taskId, goal: `Verify ${VERSION}`, candidate: amended, acceptance: [{ id: "c1", statement: "The release check passes", how: null, evidence: ["check"] }], releaseCheck: purpose.purpose, now: NOW });
  f.approved = amended;
  const id = Number(f.store.handle.prepare(`INSERT INTO release_authority (repo, generation, version, pr, branch, base, anchor_task, anchor_digest, approved_sha, approved_tree, tip_sha, tip_task,
    policy_json, policy_digest, verify_command, verify_digest, access_digest, state, expires_at, created_at) VALUES (?,1,'0.9.70',1,'b','main','t','d',?,?,?,'t','{}','p',1,'v','a','merged',?,?)`)
    .run(f.repo, f.base, f.base, f.base, NOW.toISOString(), NOW.toISOString()).lastInsertRowid);
  f.store.handle.prepare("INSERT INTO release_operation (id, authority, kind, task_id, candidate, epoch, state, external_ref, reserved_at, finished_at) VALUES (?,?, 'merge', 't', ?, 1, 'succeeded', ?, ?, ?)")
    .run(`op-${id}`, id, f.base, f.base, NOW.toISOString(), NOW.toISOString());
  ref = f.store.lookupRef(f.taskId)!.id;
  // Another person, limited to another project.
  const lim = addApprover(f.store, "lim", NOW, { name: "alex", token: FIXTURE_PASSWORD });
  if (!lim.ok) throw new Error("lim");
  f.store.handle.prepare(`UPDATE approver SET projects_json = '["/repo/elsewhere"]' WHERE name = 'lim'`).run();
  const minted = mintApiToken();
  f.store.createApiToken({ id: minted.id, account: "alex", name: "act", secretHash: minted.hash, access: "act", expiresAt: new Date(Date.now() + 86_400_000).toISOString(), by: "alex" }, new Date());
  bearer = minted.token;
  setLimitOverride(f.store, "*", { readPerMinute: 600, actPerMinute: 600, perDay: 10000 }, "alex", new Date());
  mkdirSync(join(f.dir, "config"), { recursive: true });
  server = createDecisionServer({ store: f.store, evidenceRoot: join(f.dir, "evidence"), repo: f.repo, configDir: join(f.dir, "config"), telegramTokenFile: join(f.dir, "config", "telegram-token") });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const login = async (name: string, token: string) => ((await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name, token }), redirect: "manual" })).headers.get("set-cookie") ?? "").split(";")[0]!;
  cookie = await login("alex", FIXTURE_PASSWORD);
  limitedCookie = await login("lim", lim.token);
});
afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  f.close();
});

describe("the sheet and its one approval", () => {
  test("the push locator only redirects to the sheet, and only for a release in the person's projects", async () => {
    const located = await page(`/approve/${ref}`);
    expect([located.status, located.location]).toEqual([303, `/t/${f.taskId}/release`]);
    expect(f.store.getScope(f.taskId)!.approvedAt).toBeNull();
    // Another project's person, a task ref that isn't a release, one that doesn't exist.
    expect([403, 404]).toContain((await page(`/approve/${ref}`, limitedCookie)).status);
    expect([403, 404]).toContain((await page(`/t/${f.taskId}/release`, limitedCookie)).status);
    f.store.createTask({ id: "release-9.9.9-abcdef0", title: "Release 9.9.9" }, NOW);
    const fake = f.store.refFor("built-in", "release-9.9.9-abcdef0").id;
    f.store.placeTask(fake, f.repo, {}, NOW);
    propose(f.store, { taskId: "release-9.9.9-abcdef0", goal: "Looks like a release", now: NOW });
    expect((await page(`/approve/${fake}`)).status).toBe(404);
    expect((await page("/approve/999999")).status).toBe(404);
  });

  test("the sheet shows the release, its CI, what approving does and every term; hostile subjects arrive as escaped text", async () => {
    const sheet = await page(`/t/${f.taskId}/release`);
    expect(sheet.status).toBe(200);
    expect(sheet.body).toContain("Ready for your approval");
    expect(sheet.body).toContain("Approve release");
    expect(sheet.body).toContain("hasn&#39;t been read yet");
    expect(sheet.body).toContain("full access to this computer");
    expect(sheet.body).toContain(f.approved);
    expect(sheet.body).not.toContain("<script>alert(1)</script>");
    expect(sheet.body).toContain("Fix &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(sheet.body).not.toMatch(/[\x1b\x07‮]/);
    expect(sheetForm(sheet.body)).toMatchObject({ sheet: "release", digest: expect.stringMatching(/^[0-9a-f]{64}$/), nonce: expect.stringMatching(/.+/) });
  });

  test("a card that changed after it was shown refuses, a replayed nonce refuses, a bearer token refuses", async () => {
    const shown = sheetForm((await page(`/t/${f.taskId}/release`)).body);
    // A CI re-run lands while the sheet is open.
    recordReleaseCi(f.store, { taskId: f.taskId, candidate: f.approved, state: "running", failed: [], runs: [{ id: 41, name: "Unit tests", status: "queued", conclusion: null }], now: new Date() });
    const stale = await approvePost({ ...shown, token: FIXTURE_PASSWORD });
    expect(stale.status).toBe(409);
    expect(stale.body).toContain("This release changed while you were reading it");
    expect(f.store.getScope(f.taskId)!.approvedAt).toBeNull();
    // The same nonce again: spent.
    expect((await approvePost({ ...shown, token: FIXTURE_PASSWORD })).body).toContain("stale");
    // An API token at the door: refused before anything is read.
    const fresh = sheetForm((await page(`/t/${f.taskId}/release`)).body);
    const machine = await approvePost({ ...fresh, token: FIXTURE_PASSWORD }, { authorization: `Bearer ${bearer}` });
    expect(machine.status).toBe(403);
    expect(f.store.getScope(f.taskId)!.approvedAt).toBeNull();
  });

  test("a remembered password stands only where freshlyApprovable lets it; the password typed now approves exactly the card", async () => {
    // Signed in moments ago, so a remembered password is on this session; terms another machine wrote need one typed now.
    f.store.handle.prepare("UPDATE task_scope SET proposed_via = 'mate' WHERE task_id = ?").run(f.taskId);
    const shown = sheetForm((await page(`/t/${f.taskId}/release`)).body);
    const empty = await approvePost({ ...shown, token: "" });
    expect(empty.status).toBe(403);
    expect(empty.body).toContain("Ready for your approval");
    expect(f.store.getScope(f.taskId)!.approvedAt).toBeNull();
    f.store.handle.prepare("UPDATE task_scope SET proposed_via = NULL WHERE task_id = ?").run(f.taskId);
    const again = sheetForm((await page(`/t/${f.taskId}/release`)).body);
    const yes = await approvePost({ ...again, token: FIXTURE_PASSWORD });
    expect([yes.status, yes.location]).toEqual([303, `/t/${f.taskId}/release`]);
    expect(personApprovalOf(f.store, f.taskId)).toMatchObject({ ok: true, by: "alex", method: "password-now" });
    const after = await page(`/t/${f.taskId}/release`);
    expect(after.body).toContain("Release approved");
    expect(after.body).not.toContain('name="nonce"');
  });
});

describe("the service worker", () => {
  /** Run a worker's notificationclick for a pushed url; the window it opens. */
  async function opened(worker: string, url: string): Promise<string> {
    const listeners: Record<string, (event: unknown) => void> = {};
    let target = "";
    const self = { addEventListener: (name: string, fn: (event: unknown) => void) => { listeners[name] = fn; }, location: { origin: "https://console.example" }, registration: {} };
    const clients = { matchAll: async () => [], openWindow: async (to: string) => { target = to; } };
    runInNewContext(worker, { self, clients, URL });
    let waited: Promise<unknown> = Promise.resolve();
    listeners["notificationclick"]!({ notification: { close() {}, data: { url } }, waitUntil: (promise: Promise<unknown>) => { waited = promise; } });
    await waited;
    return target;
  }
  test("this release's worker opens the locator; an older installed worker falls back to /next", async () => {
    const worker = await (await fetch(`${base}/sw.js`)).text();
    expect(await opened(worker, "/approve/12")).toBe("https://console.example/approve/12");
    expect(await opened(worker, "/approve/12/../t/x")).toBe("https://console.example/next");
    // The worker every phone had before this release (its allowlist, exactly): the locator is unknown to it.
    const older = worker.replace(/const SHAPES = \[[^\n]*\];/, "const SHAPES = [/^\\/next$/, /^\\/review$/, /^\\/system$/, /^\\/routines$/, /^\\/routines\\/[0-9]+$/, /^\\/d\\/[0-9]+$/, /^\\/r\\/[0-9]+$/];");
    expect(older).not.toBe(worker);
    expect(await opened(older, "/approve/12")).toBe("https://console.example/next");
  });
});

describe("a laptop's local owner", () => {
  test("can read the sheet but not approve a release, even typing a password: a full sign-in comes first", async () => {
    const world = await openLocalWorld();
    try {
      const { store, repo } = world;
      store.setVerifyCommand({ repo, command: "node scripts/release-check.mjs --full", timeoutMs: 60_000, approvedBy: "alex" }, NOW);
      // Local mode keeps checks in the sandbox, so this release seals terms.
      const head = (await import("node:child_process")).execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const terms = releaseTermsFor(store, { repo, version: VERSION, branch: "release-0.9.71", pr: 240, candidate: head, now: NOW });
      if (!terms.ok) throw new Error(terms.why);
      store.createTask({ id: "release-local", title: `Release ${VERSION}` }, NOW);
      store.placeTask(store.refFor("built-in", "release-local").id, repo, {}, NOW);
      propose(store, { taskId: "release-local", goal: "Verify", candidate: head, acceptance: [{ id: "c1", statement: "passes", how: null, evidence: ["check"] }], releaseTerms: terms.terms, now: NOW });
      const session = await world.localSession();
      const sheet = await world.send("/t/release-local/release", "GET", { cookie: session.cookie });
      expect(sheet.status).toBe(200);
      expect(sheet.body).toContain("Releases need a full sign-in on this computer.");
      expect(sheet.body).not.toContain('name="nonce"');
      const posted = await world.post("/t/release-local/approve", session.cookie, { csrf: session.csrf, sheet: "release", digest: "0".repeat(64), nonce: "forged", token: "any password" });
      expect([403, 409, 400]).toContain(posted.status);
      expect(store.getScope("release-local")!.approvedAt).toBeNull();
    } finally { await world.close(); }
  });
});
