import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Server } from "node:http";
import { openStore, type Store } from "./store.js";
import { addApprover, authenticateApprover, hashPassword } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { readProjectAccess } from "./project-access.js";
import { csvCell } from "./ledger-csv.js";
import { presetTerms, modeDigestOf, modeTermsJson } from "./modes.js";

describe("project access and the action ledger", () => {
  let store: Store;
  let server: Server;
  let root: string;
  let alpha: string;
  let beta: string;
  let base: string;
  let ownerToken: string;
  const now = new Date("2026-09-12T10:00:00Z");
  const password = "team-member-password";

  function invite(name: string, role: "approver" | "viewer", projects: string[] | null) {
    const minted = store.mintInvite(role, "owner", now, undefined, projects);
    expect(store.admitInviteAttempt(minted.token, now)).not.toBeNull();
    expect(store.consumeInviteAndCreateAccount({ tokenValue: minted.token, name, credentialHash: hashPassword(password) }, now).ok).toBe(true);
    return minted;
  }
  function get(path: string, name = "member") {
    return fetch(base + path, { headers: { authorization: `Bearer ${name}:${name === "owner" ? ownerToken : password}` }, redirect: "manual" });
  }
  function post(path: string, values: Record<string, string>, name = "member") {
    return fetch(base + path, { method: "POST", headers: { authorization: `Bearer ${name}:${name === "owner" ? ownerToken : password}` }, body: new URLSearchParams(values), redirect: "manual" });
  }
  async function login(name: string) {
    const response = await fetch(base + "/login", { method: "POST", body: new URLSearchParams({ name, token: name === "owner" ? ownerToken : password }), redirect: "manual" });
    expect(response.status).toBe(303);
    return response.headers.get("set-cookie")!.split(";")[0]!;
  }
  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "so-project-access-")));
    alpha = join(root, "alpha"); beta = join(root, "beta");
    mkdirSync(alpha); mkdirSync(beta);
    store = openStore(":memory:");
    const owner = addApprover(store, "owner", now);
    if (!owner.ok) throw new Error("bootstrap failed");
    ownerToken = owner.token;
    for (const [id, repo, title] of [["alpha-task", alpha, "ALPHA VISIBLE WORK"], ["beta-task", beta, "BETA PRIVATE WORK"]]) {
      store.createTask({ id: id!, title: title! }, now);
      store.placeTask(store.refFor("built-in", id!).id, repo!);
    }
    invite("member", "approver", [alpha]);
    invite("viewer", "viewer", [alpha]);
    server = createDecisionServer({ store, evidenceRoot: root, repos: [alpha, beta], clock: () => now });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close(); rmSync(root, { recursive: true, force: true });
  });

  test("scope is pinned at invite redemption, with no global or self-grant authority", () => {
    expect(store.accountOf("member")?.projects).toEqual([alpha]);
    expect(authenticateApprover(store, "member", password, alpha).ok).toBe(true);
    expect(authenticateApprover(store, "member", password, beta).ok).toBe(false);
    expect(authenticateApprover(store, "member", password).ok).toBe(false);
    expect(store.setAccountProjects("member", null, "member", now).ok).toBe(false);
    expect(() => store.mintInvite("approver", "member", now)).toThrow("instance operator");
    expect(store.setAccountProjects("owner", [alpha], "owner", now)).toEqual({ ok: false, reason: "last-instance-operator" });
    expect(store.revokeAccount("owner", "owner", now)).toMatchObject({ ok: false, reason: "last-approver" });
    for (const corrupt of [undefined, "null", "{}", '"all"', "[42]", "garbage", '["relative"]']) expect(readProjectAccess(corrupt)).toEqual([]);
  });

  test("all accessible collections and direct links exclude other projects, including cached chrome", async () => {
    await get("/projects", "owner");
    const home = await get("/");
    expect(home.status).toBe(303);
    expect(home.headers.get("location")).toBe("/work");
    for (const path of ["/work", "/inbox", "/projects", "/people", "/tasks", "/tasks/new", "/board", "/board?scope=all", "/board?view=order", "/runs", "/review", "/done", "/ledger", "/settings", "/settings/learning", "/t/alpha-task"]) {
      const response = await get(path);
      expect(response.status, path).toBe(200);
      const text = await response.text();
      expect(text, path).not.toContain("BETA PRIVATE WORK");
      expect(text, path).not.toContain(beta);
      expect(text, path).not.toContain("beta-task");
    }
    expect((await get("/t/beta-task")).status).toBe(404);
    expect((await get("/ledger?project=" + encodeURIComponent(beta))).status).toBe(403);
    expect((await get("/settings/learning?repo=" + encodeURIComponent(beta))).status).toBe(403);
    expect((await get("/settings/knowledge?repo=" + encodeURIComponent(beta))).status).toBe(403);
    const knowledge = await get('/settings/knowledge?repo=' + encodeURIComponent(alpha));
    expect(knowledge.status).toBe(200);expect(await knowledge.text()).not.toContain('BETA PRIVATE WORK');
    const settings = await (await get("/settings")).text();
    expect(settings).toContain('href="/settings/learning"');
    expect(settings).not.toContain('action="/settings/quality-default"');
    expect(settings).not.toContain('action="/settings/telegram"');
    const header = await fetch(base + "/tasks", { headers: { authorization: `Bearer member:${password}`, "x-standing-orders-project": beta } });
    expect(header.status).toBe(403);
    for (const path of ["/settings/quality-default", "/settings/telegram", "/system", "/fleet", "/projects/browse", "/projects/github", "/chat", "/workbench", "/control", "/unknown-new-route"]) expect((await get(path)).status, path).toBe(403);
  });

  test("operators can manage assigned work; forged bodies, foreign resources, and viewers cannot", async () => {
    expect((await post("/t/alpha-task/hold", {})).status).toBe(303);
    expect((await post("/t/beta-task/cancel", {})).status).toBe(404);
    expect(store.getTask("beta-task")?.state).toBe("queued");
    expect((await post("/tasks/add", { id: "injected", title: "bad", repo: beta })).status).toBe(403);
    expect(store.getTask("injected")).toBeNull();
    expect((await post("/tasks/add", { id: "new-alpha", title: "new work", repo: alpha })).status).toBe(303);
    expect(store.lookupRef("new-alpha")?.repo).toBe(alpha);
    expect(store.actionLedger({ repos: [alpha], source: "request", outcome: "accepted" })).toEqual(expect.arrayContaining([expect.objectContaining({ action: "tasks add", taskId: "new-alpha" })]));
    store.setAccountProjects("member", [alpha, beta], "owner", now);
    expect((await post("/tasks/add", { id: "new-beta", title: "Other assigned project", repo: beta })).status).toBe(303);
    expect(store.actionLedger({ repos: [beta], source: "request", outcome: "accepted" })).toEqual(expect.arrayContaining([expect.objectContaining({ actor: "member", action: "tasks add", taskId: "new-beta" })]));
    expect((await post("/t/alpha-task/cancel", {}, "viewer")).status).toBe(403);
    expect((await post("/people/invite", { role: "approver", token: password })).status).toBe(403);
    expect((await post("/settings/quality-default", { "quality-mode": "strict" })).status).toBe(403);
  });

  test("access changes invalidate cookies and restrict existing bearer credentials", async () => {
    const cookie = await login("member");
    expect((await fetch(base + "/tasks", { headers: { cookie } })).status).toBe(200);
    expect(store.setAccountProjects("member", [beta], "owner", now).ok).toBe(true);
    const stale = await fetch(base + "/tasks", { headers: { cookie }, redirect: "manual" });
    expect(stale.status).toBe(303);
    expect(stale.headers.get("location")).toBe("/login");
    expect((await get("/t/alpha-task")).status).toBe(404);
    expect((await get("/t/beta-task")).status).toBe(200);
    expect(store.setAccountProjects("member", [], "owner", now).ok).toBe(true);
    expect((await get("/tasks")).status).toBe(403);
    const ledger = await (await get("/ledger?format=json")).json();
    expect(ledger.entries).toEqual([]);
  });

  test("the People forms grant selected projects and changing access records the actor", async () => {
    const cookie = await login("owner");
    const page = await (await fetch(base + "/people", { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(page)![1]!;
    const response = await fetch(base + "/people/invite", { method: "POST", headers: { cookie }, body: new URLSearchParams({ csrf, token: ownerToken, role: "viewer", access: "selected", projects: beta }), redirect: "manual" });
    expect(response.status).toBe(200);
    const invitePage = await response.text();
    const token = /\/join\/([A-Za-z0-9_-]{16,64})/.exec(invitePage)![1]!;
    const joined = await fetch(base + "/join/" + token, { method: "POST", body: new URLSearchParams({ name: "new-person", password, role: "approver", access: "all" }), redirect: "manual" });
    expect(joined.status).toBe(303);
    expect(store.accountOf("new-person")).toMatchObject({ role: "viewer", projects: [beta] });
    const changed = await fetch(base + "/people/projects", { method: "POST", headers: { cookie }, body: new URLSearchParams({ csrf, token: ownerToken, name: "member", access: "selected", projects: beta }), redirect: "manual" });
    expect(changed.status).toBe(303);
    expect(store.accountOf("member")?.projects).toEqual([beta]);
    expect(store.actionLedger({ repos: [alpha], source: "access" })).toEqual(expect.arrayContaining([expect.objectContaining({ actor: "owner", outcome: "removed" })]));
  });

  test("an empty project grant stays empty even on a legacy unscoped server", async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    server = createDecisionServer({ store, evidenceRoot: root, clock: () => now });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
    store.setAccountProjects("member", [], "owner", now);
    for (const path of ["/people", "/projects", "/ledger"]) {
      const response = await get(path);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain("BETA PRIVATE WORK");
      expect(text).not.toContain("beta-task");
      expect(text).not.toContain("alpha-task");
    }
    expect((await get("/tasks")).status).toBe(403);
    expect((await post("/tasks/add", { id: "no-grant", title: "No grant", repo: alpha })).status).toBe(403);
  });

  test("ledger captures worker transitions atomically and never copies decision or request secrets", async () => {
    const ref = store.lookupRef("alpha-task")!;
    store.raw().prepare("INSERT INTO run(task_ref, lease_id, runner, role, started_at, branch, worktree) VALUES (?, 'fixture-lease', 'worker-one', 'builder', ?, 'fixture-branch', '/fixture-worktree')").run(ref.id, now.toISOString());
    const runId = Number(store.raw().prepare("SELECT MAX(id) AS id FROM run").get()!.id);
    store.raw().prepare("UPDATE run SET outcome='built', finished_at=? WHERE id=?").run(now.toISOString(), runId);
    const before = store.actionLedger({ repos: [alpha], source: "work" });
    expect(before).toEqual(expect.arrayContaining([expect.objectContaining({ actor: "worker-one", action: "run started", runId }), expect.objectContaining({ action: "run finished", outcome: "built", runId })]));
    expect(() => store.transact(() => { store.raw().prepare("UPDATE task SET state='cancelled' WHERE id='alpha-task'").run(); throw new Error("rollback"); })).toThrow("rollback");
    expect(store.actionLedger({ repos: [alpha], source: "work" })).toEqual(before);
    expect(() => store.raw().exec("DELETE FROM action_ledger")).toThrow("append-only");
    const secret = "DO-NOT-LOG-THIS-SECRET";
    await post("/t/alpha-task/hold", { token: secret, note: secret });
    const all = store.actionLedger({ repos: null, limit: 100 });
    expect(JSON.stringify(all)).not.toContain(secret);
    expect(all).toEqual(expect.arrayContaining([expect.objectContaining({ actor: "member", action: "task hold", source: "request", outcome: "accepted" })]));
    const response = await (await get("/ledger?format=json&source=work&actor=worker-one")).json();
    expect(response.entries).toHaveLength(2);
    expect(response.entries.every((row: { repo: string }) => row.repo === alpha)).toBe(true);
  });

  test("CSV exports every matching page with the same permissions and spreadsheet-safe fields", async () => {
    for (let i = 0; i < 235; i++) store.recordAction({ at: now.toISOString(), actor: "exporter", repo: alpha, taskId: "alpha-task", runId: null, action: i === 0 ? 'quoted, "action"\nsecond line' : "exported action", outcome: "recorded", source: "work" });
    store.recordAction({ at: now.toISOString(), actor: "exporter", repo: beta, taskId: "beta-task", runId: null, action: "private action", outcome: "recorded", source: "work" });
    const response = await get("/ledger?format=csv&actor=exporter&source=work&outcome=recorded&task=alpha-task&before=1", "viewer");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="standing-orders-actions.csv"');
    const csv = await response.text();
    expect(csv.match(/"exporter"/g)).toHaveLength(235);
    expect(csv).toContain('"quoted, ""action""\nsecond line"');
    expect(csv).not.toContain("private action");
    expect(csv).not.toContain(beta);
    expect((await get("/ledger?format=csv&project=" + encodeURIComponent(beta))).status).toBe(403);
    expect((await get("/ledger?format=csv&actor=exporter&outcome=absent")).headers.get("content-type")).toContain("text/csv");
    for (const input of ["=SUM(1,1)", "+CMD", "-CMD", "@formula", "  =formula", "\tformula", "\rformula"]) expect(csvCell(input)).toBe('"\'' + input + '"');
    store.setAccountProjects("member", [], "owner", now);
    expect(await (await get("/ledger?format=csv")).text()).not.toContain("exporter");
  });

  test("mode signing binds planner authority and the selected repository to the reviewed form", async () => {
    const cookie = await login("owner");
    const page = await (await fetch(base + "/tasks/new", { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)![1]!;
    const send = (path: string, input: Record<string, string> | URLSearchParams) => fetch(base + path, { method: "POST", headers: { cookie }, body: new URLSearchParams({ csrf, ...Object.fromEntries(input instanceof URLSearchParams ? input : Object.entries(input)) }), redirect: "manual" });
    await send("/projects/select", { path: alpha });
    const terms = { name: "standard", days: "1", "auto-approve": "1", "plan-auto": "1" };
    expect((await send("/mode/confirm", { ...terms, "auto-approve": "0" })).status).toBe(400);
    expect((await send("/mode/confirm", { ...terms, "review-auto": "1" })).status).toBe(400);
    expect((await send("/mode/confirm", { ...terms, "review-retry-auto": "1" })).status).toBe(400);
    const confirm = async () => {
      const response = await send("/mode/confirm", terms);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("unresolved questions still wait");
      expect(html).not.toContain("review-retry-auto");
      return new URLSearchParams([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map(one => [one[1]!, one[2]!]));
    };
    const wrongProject = await confirm(); wrongProject.set("token", ownerToken);
    await send("/projects/select", { path: beta });
    expect((await send("/mode/sign", wrongProject)).status).toBe(409);
    expect(store.activeMode(beta, now)).toBeNull();
    await send("/projects/select", { path: alpha });
    const changed = await confirm(); changed.set("token", ownerToken); changed.set("plan-auto", "0");
    expect((await send("/mode/sign", changed)).status).toBe(409);
    const retryChanged = await confirm(); retryChanged.set("token", ownerToken); retryChanged.set("review-retry-auto", "1");
    expect((await send("/mode/sign", retryChanged)).status).toBe(400);
    const signed = await confirm(); signed.set("token", ownerToken);
    expect((await send("/mode/sign", signed)).status).toBe(303);
    expect(JSON.parse(store.activeMode(alpha, now)!.termsJson).planAuto).toBe(true);
    expect(JSON.parse(store.activeMode(alpha, now)!.termsJson).reviewRetryAuto).toBe(false);
  });

  test("console filings defer planning approval to the signed mode; bearer filings cannot spend it", async () => {
    for (const phase of ["plan", "build", "review"]) store.setPhaseConfig("installation", phase, "claude", "sonnet", "owner", now);
    const terms = { ...presetTerms("standard", new Date(now.getTime() + 3600000).toISOString()), autoApproveFiling: true, planAuto: true };
    store.signMode({ repo: alpha, name: terms.name, signedBy: "owner", digest: modeDigestOf(terms), termsJson: modeTermsJson(terms), publication: terms.publication, absoluteExpiry: terms.absoluteExpiry }, now);
    const cookie = await login("owner");
    const page = await (await fetch(base + "/tasks/new", { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)![1]!;
    const input = { title: "A bounded task", repo: alpha, goal: "Keep the filed goal", acceptance: "Checks pass | check", touches: "src/example.ts", "planning-policy": "choice", "plan-first": "1" };
    const response = await fetch(base + "/tasks/add", { method: "POST", headers: { cookie }, body: new URLSearchParams({ ...input, id: "planned-auto", csrf }), redirect: "manual" });
    expect(response.status).toBe(303);
    expect(store.scopeSealed("planned-auto")).toBe(false);
    expect(store.raw().prepare("SELECT signed_by FROM plan_authorization WHERE task_id='planned-auto'").get()?.signed_by).toBe("owner");
    expect((await post("/tasks/add", { ...input, id: "machine-auto" }, "owner")).status).toBe(303);
    expect(store.raw().prepare("SELECT 1 FROM plan_authorization WHERE task_id='machine-auto'").get()).toBeUndefined();
    const direct = await fetch(base + "/tasks/add", { method: "POST", headers: { cookie }, body: new URLSearchParams({ ...input, id: "direct-auto", "plan-first": "0", csrf }), redirect: "manual" });
    expect(direct.status).toBe(303);
    expect(store.scopeSealed("direct-auto")).toBe(true);
    const blocked = await fetch(base + "/tasks/add", { method: "POST", headers: { cookie }, body: new URLSearchParams({ ...input, id: "bad-dependency", "plan-first": "0", after: "missing-task", csrf }), redirect: "manual" });
    expect(blocked.status).toBe(200);
    expect(store.scopeSealed("bad-dependency")).toBe(false);
    expect(store.raw().prepare("SELECT 1 FROM plan_authorization WHERE task_id='bad-dependency'").get()).toBeUndefined();
    const taskPage = await (await fetch(base + "/t/planned-auto", { headers: { cookie } })).text();
    expect(taskPage).toContain("Automatic approval is enabled for a verified plan");
    store.revokeMode(alpha, "owner", "operator", now);
    expect(await (await fetch(base + "/t/planned-auto", { headers: { cookie } })).text()).not.toContain("Automatic approval is enabled for a verified plan");
  });

  test("ledger pagination is stable under new actions and renders untrusted labels as text", async () => {
    for (let i = 0; i < 55; i++) store.recordAction({ at: now.toISOString(), actor: '<script>alert("x")</script>', repo: alpha, taskId: "alpha-task", runId: null, action: "fixture", outcome: "recorded", source: "work" });
    const first = await (await get("/ledger?format=json")).json();
    expect(first.entries).toHaveLength(50);
    store.recordAction({ at: now.toISOString(), actor: "later", repo: alpha, taskId: null, runId: null, action: "fixture", outcome: "recorded", source: "work" });
    const second = await (await get(`/ledger?format=json&before=${first.nextBefore}`)).json();
    expect(second.entries.every((row: { id: number }) => row.id < first.nextBefore)).toBe(true);
    const text = await (await get("/ledger")).text();
    expect(text).toContain("&lt;script&gt;");
    expect(text).not.toContain('<script>alert("x")</script>');
  });
});
