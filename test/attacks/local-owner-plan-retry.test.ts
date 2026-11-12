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
import { openLocalWorld, LOCAL_T0, type LocalWorld } from "../local-owner-world.js";
import { runOperate } from "../../src/operate.js";
import { asLocalOwner, runAsLocalOwner, type LocalOwnerAct, type LocalPrincipal } from "../../src/local-owner.js";
import { LOCAL_PLAN_ACTION, planSourceOf, requestPlanAsLocalOwner } from "../../src/local-owner-acts.js";
import { propose } from "../../src/scope.js";
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
});
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
