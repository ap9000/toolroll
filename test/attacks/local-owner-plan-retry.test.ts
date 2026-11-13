/**
 * Local-owner slices 2 and 3 (docs/plans/local-owner-acts.md §1–2, v2 items 2, 3 and 6): the laptop's local owner asks
 * for a plan, and retries its own approved build, with no password, from the terminal (runAsLocalOwner, as the terminal
 * UI runs commands) and the browser (its local session). Each act is bound to what the screen read, proved inside its own
 * transaction (the exact act, the owner's current project access, the one work rule), approves and pins nothing, and is
 * idempotent. Everything around it is refused: stale screens, saved pins, inherited pre-authorizations, put-away work,
 * releases, protected, coordinator, imported and unsandboxed work, the wrong act, a lead or remote chain, and every caller
 * that isn't the local owner keeps exactly the road it had.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { join } from "node:path";
import { openLocalWorld, LOCAL_T0, LOCAL_WORLD_SETUP_MS, type LocalWorld } from "../local-owner-world.js";
import { runOperate } from "../../src/operate.js";
import { asLocalOwner, runAsLocalOwner, type LocalOwnerAct, type LocalPrincipal } from "../../src/local-owner.js";
import { LOCAL_PLAN_ACTION, LOCAL_RETRY_ACTION, LOCAL_RETRY_SPENT, planSourceOf, requestPlanAsLocalOwner, retryAsLocalOwner, retryPinsOf } from "../../src/local-owner-acts.js";
import { APPROVAL_PROOF, approvalProofDetail, approve, propose } from "../../src/scope.js";
import { register } from "../../src/runner.js";
import { archiveTaskFamily, setLocalModeOff } from "../../src/store.js";
import { withActor } from "../../src/actor.js";
import { withRemote, type RemoteRun } from "../../src/remote-run.js";
import { PasswordGuard } from "../../src/sign-in-guard.js";
import { modeDigestOf, modeTermsJson, presetTerms } from "../../src/modes.js";
import { ISSUE_IMPORT_FILED_VIA } from "../../src/task-source.js";
import { createTuiSource } from "../../src/tui-source.js";
import type { ReleaseCheckPurpose } from "../../src/contracts/release-terms.js";

const T0 = LOCAL_T0;
let world: LocalWorld, file: string, serial = 0;
beforeEach(async () => {
  world = await openLocalWorld();
  file = join(world.configDir, "state.db");
}, LOCAL_WORLD_SETUP_MS);
afterEach(async () => { vi.restoreAllMocks(); await world.close(); });

/** A command exactly as the terminal UI sends it: as the local owner, with --json, on the laptop's database. */
async function terminal(words: string[]): Promise<{ code: number; envelope: Record<string, unknown> }> {
  let out = "";
  const code = await runAsLocalOwner(() => runOperate("task", [...words, "--json", "--db", file], text => { out += text; }, { now: T0 }));
  return { code, envelope: JSON.parse(out.trim() || "{}") as Record<string, unknown> };
}
const rows = (sql: string, ...values: (string | number)[]) => world.store.handle.prepare(sql).all(...values);
const owner = (act: LocalOwnerAct, transport: LocalPrincipal["transport"] = "terminal"): LocalPrincipal =>
  ({ account: "alex", localGeneration: 1, accountGeneration: world.store.accountOf("alex")!.generation, transport, act, sessionHash: null, request: null });
function remoteRun(): RemoteRun {
  return { account: "alex", scope: "act", tokenName: "laptop", source: "api", secret: "s".repeat(32), allows: () => true, lens: null, noteTask: () => undefined, files: {} };
}

// ---- ask for a plan (slice 2) -----------------------------------------------------------------------------------------

/** A task in the laptop's project, filed for planning: a scope (unapproved) or, with `scoped: false`, only a title. */
function plannable({ scoped = true, touches = ["src/footer.ts"] }: { scoped?: boolean; touches?: string[] } = {}): string {
  const id = `plan-${++serial}`;
  world.store.createTask({ id, title: "Fix the footer link" }, T0);
  world.store.placeTask(world.store.refFor("built-in", id).id, world.repo, {}, T0);
  if (scoped) propose(world.store, { taskId: id, goal: "Make the footer link work.", touches, acceptance: [{ id: "c1", statement: "The link works.", how: null, evidence: ["check"] }], now: T0 });
  return id;
}
const plan = (id: string) => world.store.lookupRef(id)!.plan;
const planRows = (id: string) => rows("SELECT actor, outcome, detail FROM action_ledger WHERE action = ? AND task_id = ?", LOCAL_PLAN_ACTION, id);
const armed = (id: string) => rows("SELECT signed_by, basis FROM plan_authorization WHERE task_id = ?", id);
/** Everything a plan request could write about a task. */
const planState = (id: string) => JSON.stringify([world.store.lookupRef(id), armed(id), planRows(id), rows("SELECT digest, approved_digest, approved_by FROM task_scope WHERE task_id = ?", id),
  rows("SELECT state FROM task WHERE id = ?", id)]);
const ask = (id: string, source = planSourceOf(world.store, id)!) => terminal(["plan", id, "--digest", source]);

describe("asking for a plan, as the local owner", () => {
  test("from the terminal, with a scope and with only a title: requested, recorded from the terminal, nothing approved or pinned", async () => {
    for (const scoped of [true, false]) {
      const id = plannable({ scoped });
      const answer = await ask(id);
      expect(answer.envelope, JSON.stringify(answer.envelope)).toMatchObject({ ok: true, replayed: false, autoPlan: false });
      expect(plan(id)).toBe("requested");
      expect(world.store.lookupRef(id)).toMatchObject({ planProvider: null, planModel: null });
      expect(world.store.getScope(id)?.approvedDigest ?? null).toBeNull();
      const recorded = planRows(id);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({ actor: "operator:alex", outcome: "requested" });
      expect(JSON.parse(String(recorded[0]!["detail"]))).toEqual({ v: 1, source: planSourceOf(world.store, id), via: "terminal" });
    }
  });

  test("under a mode the owner signed with planAuto: still no pre-authorization (the plan waits for its own yes)", async () => {
    const terms = { ...presetTerms("standard", new Date(T0.getTime() + 86_400_000).toISOString()), autoApproveFiling: true, planAuto: true };
    world.store.signMode({ repo: world.repo, name: terms.name, signedBy: "alex", digest: modeDigestOf(terms), termsJson: modeTermsJson(terms), publication: terms.publication, absoluteExpiry: terms.absoluteExpiry }, T0);
    const id = plannable();
    expect((await ask(id)).envelope).toMatchObject({ ok: true, autoPlan: false });
    expect(plan(id)).toBe("requested");
    expect(armed(id)).toEqual([]);
  });

  test("an inherited pre-authorization is withdrawn in the same write, with its audit row", async () => {
    const id = plannable();
    const scope = world.store.getScope(id)!;
    // Left by an earlier request under a mode (written straight in: no road arms one for a plan not asked for).
    world.store.handle.prepare("INSERT INTO plan_authorization (task_id, source_digest, scope_digest, mode_digest, signed_by, created_at, basis) VALUES (?, ?, ?, 'm', 'alex', ?, 'mode')")
      .run(id, planSourceOf(world.store, id)!, scope.digest, T0.toISOString());
    expect((await ask(id)).envelope).toMatchObject({ ok: true });
    expect(armed(id)).toEqual([]);
    expect(rows("SELECT actor, outcome FROM action_ledger WHERE action = 'unchanged plan pre-authorization withdrawn' AND task_id = ?", id)).toEqual([{ actor: "operator:alex", outcome: "withdrawn" }]);
  });

  test("a plan already asked for and pre-authorized (the normal order): the local owner's ask withdraws the authorization before answering \"already\"", async () => {
    const id = plannable();
    // Asked with a password, then armed as a mode does on that request (Codex review 3, finding 1).
    expect(world.store.requestPlan(world.store.lookupRef(id)!.id, T0).ok).toBe(true);
    const scope = world.store.getScope(id)!;
    world.store.handle.prepare("INSERT INTO plan_authorization (task_id, source_digest, scope_digest, mode_digest, signed_by, created_at, basis) VALUES (?, ?, ?, 'm', 'alex', ?, 'mode')")
      .run(id, planSourceOf(world.store, id)!, scope.digest, T0.toISOString());
    expect(armed(id)).toHaveLength(1);
    expect((await ask(id)).envelope).toMatchObject({ ok: true });
    expect(plan(id)).toBe("requested");
    expect(armed(id)).toEqual([]);
    expect(rows("SELECT actor, outcome FROM action_ledger WHERE action = 'unchanged plan pre-authorization withdrawn' AND task_id = ?", id)).toEqual([{ actor: "operator:alex", outcome: "withdrawn" }]);
    // Asked again: still "already", and nothing more written.
    expect((await ask(id)).envelope).toMatchObject({ ok: true });
    expect(rows("SELECT COUNT(*) AS n FROM action_ledger WHERE action = 'unchanged plan pre-authorization withdrawn' AND task_id = ?", id)).toEqual([{ n: 1 }]);
  });

  test("saved plan pins refuse (a local request never plans with an agent someone chose); naming pins refuses too", async () => {
    const id = plannable();
    expect(world.store.setPlanPins(world.store.lookupRef(id)!.id, "claude", "opus", T0).ok).toBe(true);
    const before = planState(id);
    const answer = await ask(id);
    expect(answer.envelope).toMatchObject({ ok: false, reason: "refused" });
    expect(String(answer.envelope["message"])).toMatch(/password/);
    expect(planState(id)).toBe(before);
    const other = plannable();
    const was = planState(other);
    for (const pins of [["--provider", "claude", "--model", "opus"], ["--model", "opus"]]) {
      expect((await terminal(["plan", other, "--digest", planSourceOf(world.store, other)!, ...pins])).envelope, pins.join(" ")).toMatchObject({ ok: false, reason: "local-owner" });
    }
    expect(planState(other)).toBe(was);
  });

  test("bound to the planning source read: a task changed since (reworded, approved, cancelled), put away, or a bad digest is refused, nothing written", async () => {
    const reworded = plannable();
    const read = planSourceOf(world.store, reworded)!;
    propose(world.store, { taskId: reworded, goal: "Make the footer link open in a new tab.", touches: ["src/footer.ts"], acceptance: [{ id: "c1", statement: "It opens.", how: null, evidence: ["check"] }], now: T0 });
    const before = planState(reworded);
    expect((await ask(reworded, read)).envelope).toMatchObject({ ok: false, reason: "stale", message: "This task changed. Look at it again." });
    expect(planState(reworded)).toBe(before);
    // Approved since the read (its source moves with the approval), and asked with the new source: refused either way.
    const approved = plannable();
    const seen = planSourceOf(world.store, approved)!;
    expect(world.store.sealScopeApproval(approved, "alex", T0)).toBe(true);
    expect((await ask(approved, seen)).envelope).toMatchObject({ ok: false, reason: "stale" });
    expect((await ask(approved)).envelope).toMatchObject({ ok: false, reason: "refused" });
    expect(plan(approved)).toBeNull();
    const cancelled = plannable();
    world.store.setTaskState(cancelled, "cancelled", T0);
    expect((await ask(cancelled)).envelope).toMatchObject({ ok: false });
    expect(plan(cancelled)).toBeNull();
    const away = plannable();
    archiveTaskFamily(world.store, away, { by: "alex", byKind: "person", rule: null, reason: "Not now" }, T0);
    expect((await ask(away)).envelope).toMatchObject({ ok: false, reason: "archived" });
    expect(plan(away)).toBeNull();
    for (const digest of ["", "abc", "A".repeat(64)]) expect((await terminal(["plan", away, "--digest", digest])).envelope, digest).toMatchObject({ ok: false, reason: "usage" });
    expect((await terminal(["plan", reworded])).envelope).toMatchObject({ ok: false, reason: "usage" });
  });

  test("asking twice is one request: the second answers already and writes nothing; concurrent duplicates make one", async () => {
    const id = plannable();
    expect((await ask(id)).envelope).toMatchObject({ ok: true, replayed: false });
    const after = planState(id);
    expect((await ask(id)).envelope).toMatchObject({ ok: true, replayed: true });
    expect(planState(id)).toBe(after);
    const twin = plannable();
    const answers = await Promise.all([ask(twin), ask(twin), ask(twin)]);
    expect(answers.filter(one => one.envelope["ok"] === true)).toHaveLength(3);
    expect(answers.filter(one => one.envelope["replayed"] === false)).toHaveLength(1);
    expect(planRows(twin)).toHaveLength(1);
  });

  test("the work rule: release, protected, two-person, escalated, coordinator, imported and unsandboxed work refuse, nothing written", async () => {
    const cases: [string, () => string][] = [
      ["release", () => {
        const id = plannable({ scoped: false });
        propose(world.store, { taskId: id, goal: "Release 1.2.3", touches: ["package.json"], acceptance: [{ id: "c1", statement: "Released.", how: null, evidence: ["check"] }], now: T0,
          releaseCheck: { version: 1, purpose: "release-check", repo: world.repo, packageVersion: "1.2.3", branch: "release/1.2.3", pr: 7, base: "main", approvedSha: "c".repeat(40),
            approvedTree: "d".repeat(40), grant: { id: 1, digest: "g" }, access: "sandboxed" } as ReleaseCheckPurpose });
        return id;
      }],
      ["protected", () => { world.store.setApprovalRules(world.repo, { notRequester: false, protectProject: false, protectedPaths: ["src/"] }, "alex", T0); return plannable(); }],
      ["protected (no declared paths)", () => { world.store.setApprovalRules(world.repo, { notRequester: false, protectProject: false, protectedPaths: ["infra/"] }, "alex", T0); return plannable({ scoped: false }); }],
      ["escalated", () => { const id = plannable({ scoped: false }); world.store.handle.prepare("UPDATE task_ref SET permission_mode = 'bypassPermissions' WHERE external_id = ?").run(id); return id; }],
      ["coordinator", () => {
        const id = plannable();
        world.store.handle.exec("PRAGMA foreign_keys = OFF");
        world.store.handle.prepare("UPDATE task_ref SET coordinator_cid = 'c-1' WHERE external_id = ?").run(id);
        world.store.handle.exec("PRAGMA foreign_keys = ON");
        return id;
      }],
      ["imported", () => { const id = plannable(); world.store.stampFiledVia(world.store.lookupRef(id)!.id, ISSUE_IMPORT_FILED_VIA); return id; }],
      ["unsandboxed", () => { world.store.handle.prepare("INSERT INTO project_check_access (repo, level, updated_at, updated_by) VALUES (?, 'unsandboxed', ?, 'alex')").run(world.repo, T0.toISOString()); return plannable(); }],
    ];
    for (const [name, make] of cases) {
      world.store.setApprovalRules(world.repo, { notRequester: false, protectProject: false, protectedPaths: [] }, "alex", T0);
      world.store.handle.prepare("DELETE FROM project_check_access").run();
      const id = make();
      const before = planState(id);
      const answer = await ask(id);
      expect(answer.envelope, name).toMatchObject({ ok: false, reason: "refused" });
      expect(String(answer.envelope["message"]), name).toMatch(/password/);
      expect(planState(id), name).toBe(before);
    }
  });

  test("the owner's current reach into the project, and its standing, are read in the write", async () => {
    const id = plannable();
    const before = planState(id);
    // The project taken off the owner's account (straight in, so only the reach moves, not the account's generation).
    world.store.handle.prepare("UPDATE approver SET projects_json = ? WHERE name = 'alex'").run(JSON.stringify(["/somewhere/else"]));
    expect((await ask(id)).envelope).toMatchObject({ ok: false, reason: "not-found" });
    expect(planState(id)).toBe(before);
    world.store.handle.prepare("UPDATE approver SET projects_json = NULL WHERE name = 'alex'").run();
    const source = planSourceOf(world.store, id)!;
    expect(setLocalModeOff(world.store, { name: "alex", authority: "full" }, T0)).toMatchObject({ ok: true });
    expect((await terminal(["plan", id, "--digest", source])).envelope).toMatchObject({ ok: false, reason: "refused" });
    expect(planState(id)).toBe(before);
  });

  test("only the local owner acting as exactly request-plan: the wrong act, an ended request, a lead or remote chain, and no local owner at all are refused", () => {
    const id = plannable();
    const source = planSourceOf(world.store, id)!;
    const before = planState(id);
    const call = () => requestPlanAsLocalOwner(world.store, id, source, T0);
    expect(call()).toMatchObject({ ok: false, reason: "local-owner" });
    for (const act of ["approve-plan", "file-task", "read", "complete-task"] as const) expect(asLocalOwner(owner(act), call), act).toMatchObject({ ok: false, reason: "local-owner" });
    expect(asLocalOwner({ ...owner("request-plan", "browser"), request: { ended: true } }, call)).toMatchObject({ ok: false, reason: "local-owner" });
    expect(asLocalOwner({ ...owner("request-plan"), accountGeneration: 99 }, call)).toMatchObject({ ok: false, reason: "local-owner" });
    expect(asLocalOwner(owner("request-plan"), () => withActor({ account: "alex", lead: true }, call))).toMatchObject({ ok: false, reason: "local-owner" });
    expect(asLocalOwner(owner("request-plan"), () => withRemote(remoteRun(), call))).toMatchObject({ ok: false, reason: "local-owner" });
    expect(planState(id)).toBe(before);
    // The one that is: asked.
    expect(asLocalOwner(owner("request-plan"), call)).toEqual({ ok: true, replayed: false });
  });

  test("the sign-in guard is never touched, and outside the terminal the password road is unchanged", async () => {
    const failed = vi.spyOn(PasswordGuard.prototype, "failed");
    const preflight = vi.spyOn(PasswordGuard.prototype, "preflight");
    const id = plannable();
    for (let press = 0; press < 5; press += 1) await ask(id, "f".repeat(64));
    await ask(id);
    expect(failed).not.toHaveBeenCalled();
    expect(preflight).not.toHaveBeenCalled();
    // Not the local owner: `task plan` still asks for an approver's sign-in, and --digest is not its business.
    const other = plannable();
    let out = "";
    await runOperate("task", ["plan", other, "--json", "--db", file], text => { out += text; }, { now: T0 });
    expect(JSON.parse(out)).toMatchObject({ ok: false });
    expect(plan(other)).toBeNull();
  });
});

describe("the browser's plan button, as the local owner", () => {
  test("bound to the page's source: asked; a missing or stale source is refused; never pre-authorized", async () => {
    const terms = { ...presetTerms("standard", new Date(T0.getTime() + 86_400_000).toISOString()), autoApproveFiling: true, planAuto: true };
    world.store.signMode({ repo: world.repo, name: terms.name, signedBy: "alex", digest: modeDigestOf(terms), termsJson: modeTermsJson(terms), publication: terms.publication, absoluteExpiry: terms.absoluteExpiry }, T0);
    const { cookie, csrf } = await world.localSession();
    const id = plannable();
    const before = planState(id);
    for (const form of [{ csrf }, { csrf, source: "f".repeat(64) }, { csrf, source: "nope" }]) {
      const answer = await world.post(`/t/${id}/plan`, cookie, form);
      expect(answer.status, JSON.stringify(form)).toBe(409);
      expect(planState(id)).toBe(before);
    }
    const page = await world.send(`/t/${id}`, "GET", { cookie });
    expect(page.body).toContain(`name="source" value="${planSourceOf(world.store, id)}"`);
    const answer = await world.post(`/t/${id}/plan`, cookie, { csrf, source: planSourceOf(world.store, id)! });
    expect(answer.status).toBe(303);
    expect(plan(id)).toBe("requested");
    expect(armed(id)).toEqual([]);
    expect(JSON.parse(String(planRows(id)[0]!["detail"]))).toMatchObject({ via: "browser" });
  });
});

describe("the terminal UI's plan, on the laptop's database", () => {
  test("p reads the planning source and sends exactly it; n on a bigger task asks for the plan at once", async () => {
    const source = createTuiSource({ databaseFile: file, operate: { now: T0 }, clock: () => T0 });
    try {
      const id = plannable();
      const read = await source.task(id);
      expect(read?.planAsk).toEqual({ source: planSourceOf(world.store, id) });
      expect(await source.act({ kind: "plan", id, source: read!.planAsk!.source })).toMatchObject({ ok: true, message: "Asked for a plan. You'll approve it before anything is built." });
      expect(await source.act({ kind: "plan", id, source: read!.planAsk!.source })).toEqual({ ok: true, message: "Already asked for a plan." });
      expect((await source.task(id))?.planAsk).toBeNull();
      // A stale read: the task changed after the screen read it.
      const other = plannable();
      const stale = (await source.task(other))!.planAsk!.source;
      propose(world.store, { taskId: other, goal: "Something else.", touches: ["src/footer.ts"], acceptance: [{ id: "c1", statement: "Done.", how: null, evidence: ["check"] }], now: T0 });
      expect(await source.act({ kind: "plan", id: other, source: stale })).toMatchObject({ ok: false, needsPassword: false });
      expect(plan(other)).toBeNull();
      // Filing a task in the project with n: filed, and its plan asked for straight away.
      const filed = await source.act({ kind: "new", text: "Rework the checkout page and explain it in the README", repo: world.repo });
      expect(filed).toMatchObject({ ok: true, message: "Filed. Planning: you'll approve the plan before anything is built." });
      expect(plan((filed as { id: string }).id)).toBe("requested");
    } finally { source.close(); }
  });
});

// ---- retry the owner's own approved build (slice 3) -------------------------------------------------------------------

let worker = false;
/** A task the owner approved with no password (its own person yes, from the browser), whose build then failed. */
function failedBuild({ approvedBy = "local" }: { approvedBy?: "local" | "password" | "robin" } = {}): { id: string; runId: number; digest: string } {
  const store = world.store;
  if (!worker) { register(store, { name: "worker-1", host: "test", capacity: 4, repos: [world.repo], now: T0, newToken: () => "tok-worker-1" }); worker = true; }
  const id = `retry-${++serial}`;
  store.createTask({ id, title: "Fix the checkout total" }, T0);
  store.placeTask(store.refFor("built-in", id).id, world.repo, {}, T0);
  const digest = propose(store, { taskId: id, goal: "Fix the checkout total", touches: ["src/total.ts"], acceptance: [{ id: "c1", statement: "Totals add up.", how: null, evidence: ["check"] }], now: T0 }).digest;
  if (approvedBy === "local") {
    expect(asLocalOwner(owner("approve-plan", "browser"), () => approve(store, id, "alex", T0, digest, ""))).toMatchObject({ ok: true });
  } else {
    // A person's yes with a password (alex's own, or robin's), as the ceremony records it: the seal and its proof row.
    const by = approvedBy === "password" ? "alex" : "robin";
    if (by === "robin" && store.accountOf("robin") === null) store.handle.prepare("INSERT INTO approver (name, credential_hash, added_at) VALUES ('robin', 'x', ?)").run(T0.toISOString());
    expect(store.sealScopeApproval(id, by, T0)).toBe(true);
    store.recordAction({ at: T0.toISOString(), actor: by, repo: world.repo, taskId: id, runId: null, action: APPROVAL_PROOF, outcome: "password-now", source: "work",
      detail: approvalProofDetail(T0.getTime(), store.accountOf(by)!.generation, digest) });
  }
  return { id, runId: failAgain(id), digest };
}
/** Another build of the task, which fails: its run. */
function failAgain(id: string, outcome: "failed" | "interrupted" = "failed"): number {
  const store = world.store;
  const ref = store.lookupRef(id)!.id;
  const authority = store.routeAuthorityFor(ref, "builder");
  if (!authority?.ok) throw Error("route fixture");
  const runId = store.startRun({ taskRef: ref, leaseId: `l-${id}-${++serial}`, runner: "worker-1", branch: `toolroll/${id}`, worktree: `/pool/${id}`, route: authority.stamp, now: T0 });
  store.stampRun(runId, { scopeDigest: store.getScope(id)!.digest, baseRevision: "b".repeat(40) });
  store.finishRun(runId, { outcome, reason: outcome === "failed" ? "agent" : "interrupted", now: T0 });
  store.setTaskState(id, "failed", T0);
  return runId;
}
const retry = (pins: { id: string; runId: number; digest: string }) => terminal(["requeue", pins.id, "--run", String(pins.runId), "--digest", pins.digest]);
const retryRows = (id: string) => rows("SELECT actor, outcome, run_id, detail FROM action_ledger WHERE action = ? AND task_id = ?", LOCAL_RETRY_ACTION, id);
/** The approved terms, byte for byte: what a retry must never touch. */
const terms = (id: string) => JSON.stringify(rows("SELECT * FROM task_scope WHERE task_id = ?", id));
/** Everything a retry could write about a task. */
const retryState = (id: string) => JSON.stringify([rows("SELECT state FROM task WHERE id = ?", id), terms(id), retryRows(id),
  rows("SELECT strikes, fast_start_until FROM task_ref WHERE external_id = ?", id), rows("SELECT resolved_at FROM incident WHERE run IN (SELECT id FROM run WHERE task_ref = (SELECT id FROM task_ref WHERE external_id = ?))", id)]);
const taskState = (id: string) => world.store.getTask(id)!.state;

describe("retrying its own approved build, as the local owner", () => {
  test("after a model error or a killed console: queued again, from the terminal; the approved terms byte-identical; the seal recorded", async () => {
    for (const outcome of ["failed", "interrupted"] as const) {
      const build = failedBuild();
      if (outcome === "interrupted") build.runId = failAgain(build.id, "interrupted");
      const before = terms(build.id);
      const answer = await retry(build);
      expect(answer.envelope, JSON.stringify(answer.envelope)).toMatchObject({ ok: true, replayed: false, retries: 1 });
      expect(taskState(build.id)).toBe("queued");
      expect(terms(build.id)).toBe(before);
      const recorded = retryRows(build.id);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({ actor: "operator:alex", outcome: "requeued", run_id: build.runId });
      const scope = world.store.getScope(build.id)!;
      expect(JSON.parse(String(recorded[0]!["detail"]))).toEqual({ v: 1, seal: { by: "alex", at: scope.approvedAt, digest: scope.approvedDigest }, via: "terminal" });
    }
  });

  test("its own password approval is its own yes too; a mode, a grant, the lead, an automatic seal or another person's approval is not", async () => {
    const own = failedBuild({ approvedBy: "password" });
    expect((await retry(own)).envelope).toMatchObject({ ok: true });
    const robin = failedBuild({ approvedBy: "robin" });
    const before = retryState(robin.id);
    const answer = await retry(robin);
    expect(answer.envelope).toMatchObject({ ok: false, reason: "refused" });
    expect(String(answer.envelope["message"])).toMatch(/password/);
    expect(retryState(robin.id)).toBe(before);
    for (const basis of ["mode", "grant", "lead", "auto-green"]) {
      const build = failedBuild();
      world.store.handle.prepare("UPDATE task_scope SET approval_basis = ? WHERE task_id = ?").run(basis, build.id);
      const was = retryState(build.id);
      expect((await retry(build)).envelope, basis).toMatchObject({ ok: false, reason: "refused" });
      expect(retryState(build.id), basis).toBe(was);
    }
  });

  test("bound to what the screen read: another build, a changed plan, or missing pins refuse, nothing written", async () => {
    const build = failedBuild();
    const before = retryState(build.id);
    expect((await retry({ ...build, runId: build.runId + 1000 })).envelope).toMatchObject({ ok: false, reason: "stale" });
    expect((await retry({ ...build, digest: "f".repeat(32) })).envelope).toMatchObject({ ok: false, reason: "stale" });
    for (const words of [["requeue", build.id], ["requeue", build.id, "--run", String(build.runId)], ["requeue", build.id, "--digest", build.digest], ["requeue", build.id, "--run", "0", "--digest", build.digest]]) {
      expect((await terminal(words)).envelope, words.join(" ")).toMatchObject({ ok: false, reason: "usage" });
    }
    expect(retryState(build.id)).toBe(before);
    // The plan rewritten since (unapproved now): refused as changed.
    const read = { ...build };
    propose(world.store, { taskId: build.id, goal: "Fix the checkout total, with tax", touches: ["src/total.ts"], acceptance: [{ id: "c1", statement: "Totals add up.", how: null, evidence: ["check"] }], now: T0 });
    expect((await retry(read)).envelope).toMatchObject({ ok: false });
    expect(taskState(build.id)).toBe("failed");
  });

  test("its own stop proof: an unfinished run, an expired claim with a live process, a later run, and a final result in any state refuse", async () => {
    const running = failedBuild();
    const ref = world.store.lookupRef(running.id)!.id;
    const authority = world.store.routeAuthorityFor(ref, "builder");
    if (!authority?.ok) throw Error("route");
    const open = world.store.startRun({ taskRef: ref, leaseId: `l-open-${running.id}`, runner: "worker-1", branch: `toolroll/${running.id}`, worktree: `/pool/${running.id}`, route: authority.stamp, now: T0 });
    expect((await retry(running)).envelope).toMatchObject({ ok: false, reason: "stopping" });
    world.store.finishRun(open, { outcome: "failed", reason: "agent", now: T0 });
    expect((await retry(running)).envelope).toMatchObject({ ok: false, reason: "stale" });
    // The build's own process is still alive, under a claim that has expired: the expired claim proves nothing.
    const alive = failedBuild();
    const aliveRef = world.store.lookupRef(alive.id)!.id;
    world.store.handle.prepare("INSERT INTO claim (lease_id, task_ref, lease_generation, runner, acquired_at, expires_at, heartbeat_at) VALUES (?, ?, 1, 'worker-1', ?, ?, ?)")
      .run(`expired-${alive.id}`, aliveRef, T0.toISOString(), new Date(T0.getTime() - 60_000).toISOString(), T0.toISOString());
    // Observed now (after this process began), so its pid is the build's own, not a newer process that reused it.
    const witness = world.store.reserveRunProcess(alive.runId, new Date(), false);
    world.store.handle.prepare("UPDATE run_process SET pid = ? WHERE id = ?").run(process.pid, witness);
    const before = retryState(alive.id);
    expect((await retry(alive)).envelope).toMatchObject({ ok: false, reason: "stopping", message: "The last build is still stopping. Try again in a moment." });
    expect(retryState(alive.id)).toBe(before);
    // A final result: accepted (the task failed later anyway) refuses whatever the task's state.
    const accepted = failedBuild();
    world.store.acceptProof(accepted.runId, "alex", null, T0);
    for (const state of ["failed", "done"] as const) {
      world.store.setTaskState(accepted.id, state, T0);
      expect((await retry(accepted)).envelope, state).toMatchObject({ ok: false, reason: "final" });
    }
    // Put away: refused.
    const away = failedBuild();
    archiveTaskFamily(world.store, away.id, { by: "alex", byKind: "person", rule: null, reason: "Not now" }, T0);
    expect((await retry(away)).envelope).toMatchObject({ ok: false });
    expect(taskState(away.id)).toBe("failed");
  });

  test("three local retries per seal; the fourth refuses with the way on; a fresh approval of the same bytes is a new seal; a password retry still works", async () => {
    const build = failedBuild();
    let pins = { ...build };
    for (let n = 1; n <= 3; n += 1) {
      expect((await retry(pins)).envelope, `retry ${n}`).toMatchObject({ ok: true, retries: n });
      pins = { ...pins, runId: failAgain(build.id) };
    }
    const before = retryState(build.id);
    const fourth = await retry(pins);
    expect(fourth.envelope).toMatchObject({ ok: false, reason: "limit", message: LOCAL_RETRY_SPENT });
    expect(retryState(build.id)).toBe(before);
    // The password road (a full session's Retry, which store.requeueTask is) is not counted or capped.
    expect(world.store.requeueTask(build.id, "alex", T0)).toMatchObject({ ok: true });
    pins = { ...pins, runId: failAgain(build.id) };
    // The same bytes approved again (a new person yes, a new seal): three more.
    const later = new Date(T0.getTime() + 60_000);
    world.store.handle.prepare("UPDATE task_scope SET approved_at = NULL, approved_by = NULL, approved_digest = NULL, approved_profile_json = NULL WHERE task_id = ?").run(build.id);
    expect(asLocalOwner(owner("approve-plan", "browser"), () => approve(world.store, build.id, "alex", later, build.digest, ""))).toMatchObject({ ok: true });
    expect(world.store.getScope(build.id)!.digest).toBe(build.digest);
    expect((await retry(pins)).envelope).toMatchObject({ ok: true, retries: 1 });
  });

  test("the same request again answers already and writes nothing; concurrent duplicates make one retry", async () => {
    const build = failedBuild();
    expect((await retry(build)).envelope).toMatchObject({ ok: true, replayed: false });
    const after = retryState(build.id);
    expect((await retry(build)).envelope).toMatchObject({ ok: true, replayed: true });
    expect(retryState(build.id)).toBe(after);
    const twin = failedBuild();
    const answers = await Promise.all([retry(twin), retry(twin), retry(twin)]);
    expect(answers.filter(one => one.envelope["ok"] === true)).toHaveLength(3);
    expect(answers.filter(one => one.envelope["replayed"] === false)).toHaveLength(1);
    expect(retryRows(twin.id)).toHaveLength(1);
  });

  test("the work rule: release, protected, coordinator, imported and unsandboxed work refuse after the fact, nothing written", async () => {
    const cases: [string, (id: string) => void][] = [
      ["release", id => {
        world.store.handle.prepare("UPDATE task_scope SET release_check_json = ? WHERE task_id = ?").run(JSON.stringify({ version: 1, purpose: "release-check", repo: world.repo, packageVersion: "1.2.3",
          branch: "release/1.2.3", pr: 7, base: "main", approvedSha: "c".repeat(40), approvedTree: "d".repeat(40), grant: { id: 1, digest: "g" }, access: "sandboxed" }), id);
      }],
      ["protected", () => { world.store.setApprovalRules(world.repo, { notRequester: false, protectProject: false, protectedPaths: ["src/"] }, "alex", T0); }],
      ["coordinator", id => {
        world.store.handle.exec("PRAGMA foreign_keys = OFF");
        world.store.handle.prepare("UPDATE task_ref SET coordinator_cid = 'c-1' WHERE external_id = ?").run(id);
        world.store.handle.exec("PRAGMA foreign_keys = ON");
      }],
      ["imported", id => world.store.stampFiledVia(world.store.lookupRef(id)!.id, ISSUE_IMPORT_FILED_VIA)],
      ["unsandboxed", () => { world.store.handle.prepare("INSERT INTO project_check_access (repo, level, updated_at, updated_by) VALUES (?, 'unsandboxed', ?, 'alex')").run(world.repo, T0.toISOString()); }],
    ];
    for (const [name, make] of cases) {
      world.store.setApprovalRules(world.repo, { notRequester: false, protectProject: false, protectedPaths: [] }, "alex", T0);
      world.store.handle.prepare("DELETE FROM project_check_access").run();
      const build = failedBuild();
      make(build.id);
      const before = retryState(build.id);
      const answer = await retry(build);
      expect(answer.envelope, name).toMatchObject({ ok: false, reason: "refused" });
      expect(String(answer.envelope["message"]), name).toMatch(name === "release" ? /release/i : name === "protected" ? /protected/ : name === "coordinator" ? /coordinator/
        // An unsandboxed project also stops a local seal dispatching at all (slice 0): either refusal holds.
        : name === "imported" ? /outside/ : /sandbox|no longer stands/);
      expect(retryState(build.id), name).toBe(before);
    }
  });

  test("the owner's project access and standing are read in the write; only the local owner acting as exactly retry-build", async () => {
    const build = failedBuild();
    const before = retryState(build.id);
    world.store.handle.prepare("UPDATE approver SET projects_json = ? WHERE name = 'alex'").run(JSON.stringify(["/somewhere/else"]));
    expect((await retry(build)).envelope).toMatchObject({ ok: false, reason: "not-found" });
    world.store.handle.prepare("UPDATE approver SET projects_json = NULL WHERE name = 'alex'").run();
    const call = () => retryAsLocalOwner(world.store, build.id, { run: build.runId, digest: build.digest }, T0);
    expect(call()).toMatchObject({ ok: false, reason: "local-owner" });
    for (const act of ["approve-plan", "request-plan", "stop-run", "resume-run", "read"] as const) expect(asLocalOwner(owner(act), call), act).toMatchObject({ ok: false, reason: "local-owner" });
    expect(asLocalOwner({ ...owner("retry-build", "browser"), request: { ended: true } }, call)).toMatchObject({ ok: false, reason: "local-owner" });
    expect(asLocalOwner(owner("retry-build"), () => withActor({ account: "alex", lead: true }, call))).toMatchObject({ ok: false, reason: "local-owner" });
    expect(asLocalOwner(owner("retry-build"), () => withRemote(remoteRun(), call))).toMatchObject({ ok: false, reason: "local-owner" });
    expect(retryState(build.id)).toBe(before);
    expect(setLocalModeOff(world.store, { name: "alex", authority: "full" }, T0)).toMatchObject({ ok: true });
    expect((await retry(build)).envelope).toMatchObject({ ok: false, reason: "refused" });
    expect(retryState(build.id)).toBe(before);
  });

  test("the sign-in guard is never touched; outside the terminal `task requeue` still needs a sign-in", async () => {
    const failed = vi.spyOn(PasswordGuard.prototype, "failed");
    const preflight = vi.spyOn(PasswordGuard.prototype, "preflight");
    const build = failedBuild();
    for (let press = 0; press < 5; press += 1) await retry({ ...build, digest: "f".repeat(32) });
    await retry(build);
    expect(failed).not.toHaveBeenCalled();
    expect(preflight).not.toHaveBeenCalled();
    const other = failedBuild();
    let out = "";
    await runOperate("task", ["requeue", other.id, "--json", "--db", file], text => { out += text; }, { now: T0 });
    expect(JSON.parse(out)).toMatchObject({ ok: false });
    expect(taskState(other.id)).toBe("failed");
  });
});

describe("the browser's Retry, as the local owner", () => {
  test("bound to the page's build and plan: retried, with its note; missing or stale pins refused; a duplicate files no second note", async () => {
    const { cookie, csrf } = await world.localSession();
    const build = failedBuild();
    const before = retryState(build.id);
    for (const form of [{ csrf }, { csrf, run: String(build.runId) }, { csrf, run: String(build.runId), digest: "f".repeat(32) }, { csrf, run: String(build.runId - 1), digest: build.digest }]) {
      const answer = await world.post(`/t/${build.id}/requeue`, cookie, form);
      expect(answer.status, JSON.stringify(form)).toBe(409);
      expect(retryState(build.id)).toBe(before);
    }
    // The page's Retry carries the build and plan it read (the task view the browser renders it from).
    const page = await world.send(`/t/${build.id}?format=workspace`, "GET", { cookie });
    expect(page.body).toContain(`"pins":{"run":${build.runId},"digest":"${build.digest}"}`);
    const form = { csrf, run: String(build.runId), digest: build.digest, note: "Use the rounding helper this time." };
    expect((await world.post(`/t/${build.id}/requeue`, cookie, form)).status).toBe(303);
    expect(taskState(build.id)).toBe("queued");
    expect(JSON.parse(String(retryRows(build.id)[0]!["detail"]))).toMatchObject({ via: "browser" });
    const notes = () => rows("SELECT COUNT(*) AS n FROM task_steer WHERE task_ref = (SELECT id FROM task_ref WHERE external_id = ?)", build.id)[0]!["n"];
    expect(notes()).toBe(1);
    expect((await world.post(`/t/${build.id}/requeue`, cookie, form)).status).toBe(303);
    expect(notes()).toBe(1);
    expect(retryRows(build.id)).toHaveLength(1);
  });
});

describe("the terminal UI's Retry, on the laptop's database", () => {
  test("r reads the build and plan and sends exactly them; replay is already; a stale read is changed", async () => {
    const source = createTuiSource({ databaseFile: file, operate: { now: T0 }, clock: () => T0 });
    try {
      const build = failedBuild();
      const read = (await source.task(build.id))!;
      expect(read.retry).toEqual({ runId: build.runId, digest: build.digest });
      const sent = { kind: "retry" as const, id: build.id, runId: read.retry!.runId, digest: read.retry!.digest };
      expect(await source.act(sent)).toEqual({ ok: true, message: "Retrying. It starts next." });
      expect(await source.act(sent)).toEqual({ ok: true, message: "Already retrying. It starts next." });
      expect(retryPinsOf(world.store, build.id)).toBeNull();
      const other = failedBuild();
      const stale = (await source.task(other.id))!.retry!;
      failAgain(other.id);
      expect(await source.act({ kind: "retry", id: other.id, runId: stale.runId, digest: stale.digest })).toMatchObject({ ok: false, changed: true, needsPassword: false });
      expect(taskState(other.id)).toBe("failed");
    } finally { source.close(); }
  });
});
