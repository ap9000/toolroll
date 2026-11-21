/** Actual isolated Store + scripted gh only; no network, provider or installation state. */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { openStore, settleObservedMergeIntent, mergeIntentRecoveryHeld, type Store } from "./store.js";
import { checkRequestDigest, representCheckHoldDetail, CHECK_RECOVERY_HELD } from "./check-recovery-hold.js";
import { runOperate } from "./operate.js";
import { addApprover } from "./scope.js";
import { mergeTermsHash, observeChecks, sweepMerges, type PublishExec } from "./publish.js";
const NOW = new Date("2026-11-20T12:00:00.000Z"), REPO = "/synthetic/project", HEAD = "a".repeat(40), LATER = new Date(NOW.getTime() + 600_000);
const OK = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
let dir: string, database: string, ownerToken: string;
let store: Store, ref: number, run: number, publication: number, intent: number;
function row() { return store.handle.prepare("SELECT * FROM merge_intent WHERE id=?").get(intent); }
function hold(invalid = false) {
  const detail = `${HEAD} · person · ${"b".repeat(16)}`;
  const id = store.recordAction({ at: NOW.toISOString(), actor: "alex", repo: REPO, taskId: "task", runId: run, source: "work", action: "checks requested", outcome: "full", detail });
  const q = checkRequestDigest({ id, repo: REPO, taskId: "task", runId: run, action: "checks requested", outcome: "full", detail })!;
  store.recordAction({ at: NOW.toISOString(), actor: "toolroll", repo: REPO, taskId: "task", runId: run, source: "work", action: CHECK_RECOVERY_HELD, outcome: String(id), detail: invalid ? "{}" : representCheckHoldDetail({ v: 1, q, g: "e".repeat(32), r: ref })! });
}
function phase(state: string) { store.handle.prepare("UPDATE merge_intent SET state=?, claimed_by='test', claimed_until=?, firing_at=?, firing_deadline=? WHERE id=?").run(state, NOW.toISOString(), NOW.toISOString(), NOW.toISOString(), intent); }
function admitted() {
  const claim = store.claimMergeIntent(intent, "synthetic", 1000, NOW); if (claim === null) throw Error("claim");
  expect(store.fireMergeIntent(intent, claim.generation, { repo: REPO, headSha: HEAD, liveGrantTermsHash: mergeTermsHash(store.publicationGrantFor(REPO)!), graceMs: 0 }, NOW)).toEqual({ ok: true });
}
function facts(over: Record<string, unknown> = {}) { return { state: "MERGED", number: 7, url: "https://github.com/o/r/pull/7", baseRefName: "main", headRefOid: HEAD, mergeCommit: { oid: "c".repeat(40) }, statusCheckRollup: [], ...over }; }
function execFor(payload: unknown, during?: (args: string[]) => void): { exec: PublishExec; calls: string[][] } {
  const calls: string[][] = [];
  return { calls, exec: async (file, args) => { calls.push([file, ...args]); during?.(args); if (args[0] === "api") return args.includes("--paginate") ? { ...OK, stdout: "[[]]" } : { ...OK, code: 1, stdout: "HTTP/2 404" }; return { ...OK, stdout: JSON.stringify(payload) }; } };
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "toolroll-publish-recovery-")); database = join(dir, "state.db"); store = openStore(database); const person = addApprover(store, "alex", NOW); if (!person.ok) throw Error("synthetic account"); ownerToken = person.token; store.createTask({ id: "task", title: "Synthetic publish" }, NOW); ref = store.refFor("built-in", "task").id; store.placeTask(ref, REPO);
  run = store.startRun({ taskRef: ref, leaseId: "synthetic-lease", runner: "synthetic", branch: "standing-orders/task", worktree: "/synthetic/pool", now: NOW, route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" } });
  store.recordOutcomeFacts(run, { headRevision: HEAD, handoff: "Synthetic" });
  store.savePublicationGrant({ repo: REPO, githubRepo: "o/r", remote: "origin", headPrefix: "standing-orders/", base: "main", capabilities: ["push-branch", "open-pr"], selector: "all", draft: false, grantedBy: "alex", merge: true, mergeMethod: "squash", mergeDeleteBranch: false }, NOW);
  publication = store.createPublicationIntent({ run, taskRef: ref, githubRepo: "o/r", remote: "origin", base: "main", head: "standing-orders/task", headSha: HEAD, bodyHash: "synthetic", draft: false }, NOW); store.markPublicationPushed(publication, NOW); store.markPublicationOpened(publication, 7, "https://github.com/o/r/pull/7", NOW);
  store.createMergeIntent({ publication, repo: REPO, grantTermsHash: mergeTermsHash(store.publicationGrantFor(REPO)!), headSha: HEAD, method: "squash", deleteBranch: false }, NOW); intent = store.mergeIntentFor(publication)!.id;
});
afterEach(() => { vi.restoreAllMocks(); store.close(); rmSync(dir, { recursive: true, force: true }); });

describe("held durable merge-intent admission", () => {
  test.each([false, true])("all direct methods preserve held row; invalid=%s", invalid => {
    hold(invalid); const before = row();
    expect(mergeIntentRecoveryHeld(store, publication)).toBe(true);
    expect(store.createMergeIntent({ publication, repo: REPO, grantTermsHash: "bad", headSha: HEAD, method: "merge", deleteBranch: true }, NOW)).toBe("recovery-held");
    expect(store.claimMergeIntent(intent, "test", 1000, NOW)).toBeNull();
    expect(store.authorizeMergeIntent(intent, HEAD, "alex", NOW)).toMatchObject({ ok: false, reason: "recovery-held" });
    expect(store.fireMergeIntent(intent, 0, { repo: REPO, headSha: HEAD, liveGrantTermsHash: "bad", graceMs: 1000 }, NOW)).toMatchObject({ ok: false, outcome: "recovery-held" });
    expect(store.refireMergeIntent(intent, "alex", LATER)).toMatchObject({ ok: false, reason: "recovery-held" });
    expect(store.rearmMergeIntent(publication)).toBe("recovery-held");
    for (const state of ["pending", "waiting-human", "refused", "superseded", "merged"] as const) expect(store.settleMergeIntent(intent, 0, state, NOW, { countAttempt: true, bumpGeneration: true, ...({ observed: true, exact: true } as {}) })).toBe(false);
    expect(row()).toEqual(before);
  });
  test("initially held sweep has zero external commands and leaves claim unchanged", async () => { phase("claimed"); hold(); const before = row(), gh = execFor(facts()); expect(await sweepMerges(store, { repo: REPO, exec: gh.exec, clock: () => LATER })).toMatchObject({ merged: 0 }); expect(gh.calls).toEqual([]); expect(row()).toEqual(before); });
  test("unreadable binding under global evidence refuses unchanged", () => { hold(); const before = row(); vi.spyOn(store.handle, "prepare").mockImplementationOnce(() => { throw Error("synthetic unavailable lookup"); }); expect(mergeIntentRecoveryHeld(store, publication)).toBe(true); expect(row()).toEqual(before); });
  test("publication/run relationship mismatch refuses under global evidence", () => { hold(); store.handle.prepare("UPDATE publication SET task_ref=? WHERE id=?").run(store.refFor("built-in", "other").id, publication); expect(mergeIntentRecoveryHeld(store, publication)).toBe(true); expect(store.claimMergeIntent(intent, "test", 1000, NOW)).toBeNull(); });
  test.each(["pending", "claimed", "firing"])("mode changes preserve held %s custody", state => { phase(state); hold(); const before = row(); for (const publication of ["notify", "automerge"] as const) { store.signMode({ repo: REPO, name: "hands-off", termsJson: JSON.stringify({ publication }), digest: "synthetic-mode", signedBy: "alex", absoluteExpiry: LATER.toISOString(), publication }, NOW); expect(row()).toEqual(before); store.revokeMode(REPO, "alex", "synthetic", NOW); expect(row()).toEqual(before); } });
  test.each([["merge", "waiting-human"], ["refire", "firing"], ["rearm", "refused"]] as const)("CLI %s refuses held state without success or episode resolution", async (action, state) => {
    phase(state); hold(); store.enqueueEpisode(`merge-attn:${publication}`, { source: { run }, kind: "merge", subject: "Synthetic wait", body: "Synthetic review evidence", pushClass: "merge", link: "/tasks" }, "synthetic", NOW);
    const before = row(), attention = store.handle.prepare("SELECT * FROM notification").all(), lines: string[] = [], calls: string[][] = [];
    const code = await runOperate("publish", [action, "7", "--as", "alex", "--token", ownerToken, "--json"], line => lines.push(line), { databaseFile: database, publishExec: async (file, args) => { calls.push([file, ...args]); return OK; } });
    expect(code).not.toBe(0); expect(JSON.parse(lines.join("\n"))).toMatchObject({ ok: false, reason: "recovery-held" }); expect(row()).toEqual(before); expect(calls).toEqual([]); expect(store.handle.prepare("SELECT * FROM notification").all()).toEqual(attention);
  });
  test("hold at create boundary adds no waiting-human guidance or notification", async () => {
    phase("waiting-human"); const before = row(), attention = store.handle.prepare("SELECT * FROM notification").all(); let inserted = false;
    const gh = execFor(facts()); await sweepMerges(store, { repo: REPO, exec: gh.exec, clock: () => { if (!inserted) { inserted = true; hold(); } return NOW; } });
    expect(inserted).toBe(true); expect(row()).toEqual(before); expect(gh.calls).toEqual([]); expect(store.handle.prepare("SELECT * FROM notification").all()).toEqual(attention);
  });
  test("hold at final firing method reproof preserves claim and issues no merge", async () => {
    const fire = store.fireMergeIntent.bind(store); vi.spyOn(store, "fireMergeIntent").mockImplementationOnce((...args) => { hold(); return fire(...args); });
    const gh = execFor(facts({ state: "OPEN", statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }] })); await sweepMerges(store, { repo: REPO, exec: gh.exec, clock: () => NOW });
    expect(gh.calls.some(args => args.includes("merge"))).toBe(false); expect(row()?.["state"]).toBe("claimed"); expect(row()?.["firing_at"]).toBeNull(); expect(row()?.["attempts"]).toBe(0);
  });
  test("hold between queue reads prevents next command and firing", async () => { const gh = execFor(facts(), args => { if (args.includes("--paginate")) hold(); }); await sweepMerges(store, { repo: REPO, exec: gh.exec, clock: () => NOW }); expect(gh.calls).toHaveLength(1); expect(row()?.["state"]).toBe("claimed"); });
});

describe("held firing custody and exact observations", () => {
  test.each([{ state: "OPEN" }, { state: "CLOSED" }, { state: "OPEN", isDraft: true }, { headRefOid: "f".repeat(40) }, { baseRefName: "other" }, { url: "https://github.com/other/r/pull/7" }, { number: 8 }, { url: "https://github.com/o/r/pull/8" }])("retains firing for nonconfirming %j", async over => {
    admitted(); hold(); const before = row(), gh = execFor(facts(over));
    for (let i = 0; i < 2; i++) expect(await sweepMerges(store, { repo: REPO, exec: gh.exec, clock: () => LATER })).toMatchObject({ merged: 0 });
    expect(row()).toEqual(before); expect(gh.calls.some(args => args.includes("merge"))).toBe(false);
  });
  test("exact fresh merged can settle once after grant revocation", async () => { admitted(); hold(); store.revokePublicationGrant(REPO, "alex", LATER); const gh = execFor(facts()); expect(await sweepMerges(store, { repo: REPO, exec: gh.exec, clock: () => LATER })).toMatchObject({ merged: 1 }); expect(row()?.["state"]).toBe("merged"); expect(await sweepMerges(store, { repo: REPO, exec: gh.exec, clock: () => LATER })).toMatchObject({ merged: 0 }); });
  test("losing observation neither settles nor clears merge attention/blocker", async () => { phase("firing"); hold(); store.createMergeBlocker(publication, "repair", NOW); const gh = execFor(facts(), args => { if (args[0] === "pr") store.reserveObservation("o/r", 7); }); const before = row(); const report = await observeChecks(store, { exec: gh.exec, clock: () => NOW }); expect(report.observed).toBe(1); expect(row()).toEqual(before); expect(store.mergeBlockerFor(publication)).not.toBeNull(); });
  test("direct terminal strings and fabricated proof cannot settle", () => { phase("firing"); hold(); const before = row(); expect(store.settleMergeIntent(intent, 0, "merged", NOW, { receipt: "observed merged", ...({ observed: true, exact: true } as {}) })).toBe(false); expect(row()).toEqual(before); });
  test.each(["store", "raw", "savepoint"])("proof factory refuses nested %s transaction and rollback reuse", kind => {
    admitted(); hold(); const generation = store.reserveObservation("o/r", 7), before = row();
    const captured = () => settleObservedMergeIntent(store, publication, { githubRepo: "o/r", prNumber: 7, generation, head: HEAD, base: "main", url: "https://github.com/o/r/pull/7", number: 7, state: "MERGED" }, NOW);
    if (kind === "store") expect(() => store.transact(() => { expect(captured()).toEqual({ won: false, settled: false, resolved: 0 }); throw Error("rollback"); })).toThrow("rollback");
    else { store.handle.exec(kind === "raw" ? "BEGIN" : "SAVEPOINT test_observation"); expect(captured()).toEqual({ won: false, settled: false, resolved: 0 }); store.handle.exec(kind === "raw" ? "ROLLBACK" : "ROLLBACK TO test_observation; RELEASE test_observation"); }
    expect(row()).toEqual(before); expect(captured()).toEqual({ won: false, settled: false, resolved: 0 });
    const next = store.reserveObservation("o/r", 7); expect(settleObservedMergeIntent(store, publication, { githubRepo: "o/r", prNumber: 7, generation: next, head: HEAD, base: "main", url: "https://github.com/o/r/pull/7", number: 7, state: "MERGED" }, NOW)).toMatchObject({ won: true, settled: true });
  });  test.each(["committed-nested", "rollback-nested", "raw-rollback"])("numeric %s reservation cannot authorize after another Store recreates generation/tuple", kind => {
    admitted(); hold(); let generation = 0;
    if (kind === "committed-nested") generation = store.transact(() => store.reserveObservation("o/r", 7));
    else if (kind === "rollback-nested") expect(() => store.transact(() => { generation = store.reserveObservation("o/r", 7); throw Error("rollback"); })).toThrow("rollback");
    else { store.handle.exec("BEGIN"); expect(() => store.reserveObservation("o/r", 7)).toThrow(); store.handle.exec("ROLLBACK"); }
    const other = openStore(database);
    try { const reserved = other.reserveObservation("o/r", 7); if (kind === "rollback-nested") expect(reserved).toBe(generation); generation = reserved; other.settleObservation({ githubRepo: "o/r", prNumber: 7, generation, headSha: HEAD, state: "none" }, NOW); } finally { other.close(); }
    const before = row(); expect(settleObservedMergeIntent(store, publication, { githubRepo: "o/r", prNumber: 7, generation, head: HEAD, base: "main", url: "https://github.com/o/r/pull/7", number: 7, state: "MERGED" }, NOW)).toEqual({ won: false, settled: false, resolved: 0 }); expect(row()).toEqual(before);
  });
  test("compound rollback consumes eligibility and leaks no held settlement authority", () => {
    admitted(); hold(); const generation = store.reserveObservation("o/r", 7), before = row();
    vi.spyOn(store, "liftMergeBlocker").mockImplementationOnce(() => { throw Error("synthetic post-CAS failure"); });
    const settle = () => settleObservedMergeIntent(store, publication, { githubRepo: "o/r", prNumber: 7, generation, head: HEAD, base: "main", url: "https://github.com/o/r/pull/7", number: 7, state: "MERGED" }, NOW);
    expect(settle).toThrow("synthetic post-CAS failure"); expect(row()).toEqual(before); expect(settle()).toEqual({ won: false, settled: false, resolved: 0 }); expect(store.settleMergeIntent(intent, 0, "merged", NOW)).toBe(false); expect(row()).toEqual(before);
  });
  test("changed intent generation after reserved read prevents settlement/count", () => {
    admitted(); hold(); const generation = store.reserveObservation("o/r", 7); store.handle.prepare("UPDATE merge_intent SET generation=generation+1 WHERE id=?").run(intent); const before = row();
    expect(settleObservedMergeIntent(store, publication, { githubRepo: "o/r", prNumber: 7, generation, head: HEAD, base: "main", url: "https://github.com/o/r/pull/7", number: 7, state: "MERGED" }, NOW)).toMatchObject({ settled: false }); expect(row()).toEqual(before);
  });
  test("no-event ordinary merge still dispatches once", async () => { const gh = execFor(facts({ state: "OPEN", statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS", __typename: "CheckRun" }] })); const report = await sweepMerges(store, { repo: REPO, exec: gh.exec, clock: () => NOW }); expect(report.merged).toBe(1); expect(gh.calls.filter(args => args.includes("merge"))).toHaveLength(1); });
  test("same-Store write rollback and recreated identical scope invalidates eligible reservation", () => {
    admitted(); hold(); const generation = store.reserveObservation("o/r", 7), before = row();
    expect(() => store.transact(() => { store.handle.prepare("UPDATE merge_intent SET last_error='temporary' WHERE id=?").run(intent); throw Error("rollback"); })).toThrow("rollback");
    expect(row()).toEqual(before); expect(settleObservedMergeIntent(store, publication, { githubRepo: "o/r", prNumber: 7, generation, head: HEAD, base: "main", url: "https://github.com/o/r/pull/7", number: 7, state: "MERGED" }, NOW)).toEqual({ won: false, settled: false, resolved: 0 }); expect(row()).toEqual(before);
  });
  test.each(["OPEN", "CLOSED", "UNREADABLE", "WRONG-BASE", "EXACT"])("hold arriving during issued exit0 retains unknown unless exact observation: %s", async outcome => {
    let issued = false, reserved: unknown; const calls: string[][] = [];
    const exec: PublishExec = async (file, args) => {
      calls.push([file, ...args]);
      if (args[0] === "api") return args.includes("--paginate") ? { ...OK, stdout: "[[]]" } : { ...OK, code: 1, stdout: "HTTP/2 404" };
      if (args.includes("merge")) { issued = true; reserved = row(); hold(); return OK; }
      if (!issued) return { ...OK, stdout: JSON.stringify(facts({ state: "OPEN", statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }] })) };
      return { ...OK, code: outcome === "UNREADABLE" ? 1 : 0, stdout: JSON.stringify(facts({ state: outcome === "OPEN" || outcome === "CLOSED" ? outcome : "MERGED", baseRefName: outcome === "WRONG-BASE" ? "other" : "main" })) };
    };
    const report = await sweepMerges(store, { repo: REPO, exec, clock: () => NOW }); expect(issued).toBe(true); expect(calls.filter(args => args.includes("merge"))).toHaveLength(1);
    if (outcome === "EXACT") { expect(report.merged).toBe(1); expect(row()?.["state"]).toBe("merged"); } else { expect(report.merged).toBe(0); expect(row()).toEqual(reserved); }
  });
  test("factually recorded remote terminal cannot hide held firing from later reconciliation", async () => {
    admitted(); hold(); const wrong = execFor(facts({ baseRefName: "other" })); await observeChecks(store, { exec: wrong.exec, clock: () => NOW }); expect(store.publicationForRun(run)?.remoteState).toBe("MERGED"); expect(row()?.["state"]).toBe("firing");
    const exact = execFor(facts()); expect(await sweepMerges(store, { repo: REPO, exec: exact.exec, clock: () => LATER })).toMatchObject({ merged: 1 }); expect(exact.calls.some(args => args.includes("merge"))).toBe(false);
  });
  test("other-Store commit between preflight and actual BEGIN invalidates reservation", () => {
    admitted(); hold(); const other = openStore(database), generation = store.reserveObservation("o/r", 7), before = row();
    try {
      const transact = store.transact.bind(store); vi.spyOn(store, "transact").mockImplementationOnce(body => { other.handle.prepare("UPDATE ci_observation SET observed_at=? WHERE github_repo='o/r' AND pr_number=7").run(NOW.toISOString()); return transact(body); });
      expect(settleObservedMergeIntent(store, publication, { githubRepo: "o/r", prNumber: 7, generation, head: HEAD, base: "main", url: "https://github.com/o/r/pull/7", number: 7, state: "MERGED" }, NOW)).toEqual({ won: false, settled: false, resolved: 0 }); expect(row()).toEqual(before);
    } finally { other.close(); }
  });
  test.each([{ url: "https://github.com/other/r/pull/7" }, { number: 8 }, { url: "https://github.com/o/r/pull/8" }])("wrong returned identity writes no attributed CI/remote/attention facts: %j", async over => {
    phase("firing"); hold(); store.createMergeBlocker(publication, "repair", NOW); const before = store.publicationForRun(run), prior = row(), gh = execFor(facts(over));
    const report = await observeChecks(store, { exec: gh.exec, clock: () => NOW }); expect(report.seen).toEqual([]); expect(report.resolved).toBe(0); expect(row()).toEqual(prior); expect(store.publicationForRun(run)).toEqual(before); expect(store.handle.prepare("SELECT * FROM ci_check").all()).toEqual([]); expect(store.mergeBlockerFor(publication)).not.toBeNull();
  });
  test.each(["wrong-state", "wrong-generation", "wrong-id"])("reentrant %s attempt consumes private terminal marker before validation", kind => {
    admitted(); hold(); const generation = store.reserveObservation("o/r", 7), before = row(), settle = store.settleMergeIntent.bind(store);
    vi.spyOn(store, "settleMergeIntent").mockImplementationOnce((id, epoch, state, now, detail) => {
      expect(settle(kind === "wrong-id" ? id + 1 : id, kind === "wrong-generation" ? epoch + 1 : epoch, kind === "wrong-state" ? "pending" : state, now, detail)).toBe(false);
      return settle(id, epoch, state, now, detail);
    });
    expect(settleObservedMergeIntent(store, publication, { githubRepo: "o/r", prNumber: 7, generation, head: HEAD, base: "main", url: "https://github.com/o/r/pull/7", number: 7, state: "MERGED" }, NOW)).toMatchObject({ won: true, settled: false }); expect(row()).toEqual(before);
    expect(store.settleMergeIntent(intent, 0, "merged", NOW)).toBe(false);
  });

});

describe("explicit immutable firing admission", () => {
  const action = "merge firing admitted";
  const entries = () => store.handle.prepare("SELECT * FROM action_ledger WHERE action=?").all(action);
  function corrupt(extra: Record<string, unknown>, detailChange?: (value: Record<string, unknown>) => string) {
    const original = entries()[0]!;
    const row = { ...original, ...extra };
    const detail = detailChange === undefined ? String(row["detail"]) : detailChange(JSON.parse(String(original["detail"])));
    // Deliberate corruption/duplicate fixture, never the positive writer or a public capability.
    store.handle.prepare("INSERT INTO action_ledger(at,actor,repo,task_id,run_id,action,outcome,source,detail) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(row["at"],row["actor"],row["repo"],row["task_id"],row["run_id"],action,row["outcome"],row["source"],detail);
  }
  test("only actual successful fire writes one strict capsule, generic writer cannot forge it", () => {
    expect(() => store.recordAction({ at: NOW.toISOString(), actor: "toolroll", repo: REPO, taskId: "task", runId: run, source: "work", action, outcome: `${intent}:1`, detail: "{}" })).toThrow("only by the firing transaction"); expect(entries()).toEqual([]);
    const grantId = store.publicationGrantFor(REPO)!.id; admitted(); const event = entries()[0]!, capsule = JSON.parse(String(event["detail"]));
    expect(entries()).toHaveLength(1); expect(Object.keys(capsule)).toEqual(["v","i","g","p","r","u","j","s"]); expect(capsule).toMatchObject({ v:1,i:intent,g:1,p:publication,r:ref,u:run,j:grantId }); expect(String(event["detail"]).length).toBeLessThanOrEqual(204); expect(String(event["detail"])).toMatch(/^[\x20-\x7e]+$/);
    expect(store.fireMergeIntent(intent, 1, { repo: REPO, headSha: HEAD, liveGrantTermsHash: mergeTermsHash(store.publicationGrantFor(REPO)!), graceMs: 0 }, NOW)).toMatchObject({ ok:false }); expect(entries()).toHaveLength(1);
  });
  test.each(["repo", "method", "delete", "remote", "prefix"])("actual %s drift cannot be authorized by caller hash", field => {
    const claim = store.claimMergeIntent(intent, "synthetic", 1000, NOW)!; const before = row(), grant = store.publicationGrantFor(REPO)!;
    if (field === "method") store.handle.prepare("UPDATE merge_intent SET method='merge' WHERE id=?").run(intent);
    if (field === "delete") store.handle.prepare("UPDATE merge_intent SET delete_branch=1 WHERE id=?").run(intent);
    if (field === "remote") store.handle.prepare("UPDATE publication SET remote='other' WHERE id=?").run(publication);
    if (field === "prefix") store.handle.prepare("UPDATE publication SET head='outside/task' WHERE id=?").run(publication);
    const actual = row(); expect(store.fireMergeIntent(intent, claim.generation, { repo: field === "repo" ? "/other" : REPO, headSha: HEAD, liveGrantTermsHash: mergeTermsHash(grant), graceMs: 0 }, NOW)).toMatchObject({ ok:false }); expect(entries()).toEqual([]); expect(row()).toEqual(actual); expect(before?.["state"]).toBe("claimed");
  });
  test.each(["standalone", "caught-outer"])("append failure rolls firing CAS back and leaves no capsule: %s", boundary => {
    const claim = store.claimMergeIntent(intent, "synthetic", 1000, NOW)!, before = row(), prepare = store.handle.prepare.bind(store.handle);
    vi.spyOn(store.handle, "prepare").mockImplementation(sql => { const statement = prepare(sql); if (!sql.startsWith("INSERT INTO action_ledger")) return statement; return { get: statement.get.bind(statement), all: statement.all.bind(statement), run: (...args) => { if (args.includes(action)) throw Error("synthetic admission append failure"); return statement.run(...args); } }; });
    const fire = () => store.fireMergeIntent(intent, claim.generation, { repo: REPO, headSha: HEAD, liveGrantTermsHash: mergeTermsHash(store.publicationGrantFor(REPO)!), graceMs: 0 }, NOW);
    if (boundary === "standalone") expect(fire).toThrow("synthetic admission append failure"); else store.transact(() => { expect(fire).toThrow("synthetic admission append failure"); });
    expect(row()).toEqual(before); expect(entries()).toEqual([]);
  });
  test.each([NOW, new Date(NOW.getTime()-1000)])("legacy missing binding stays unknown after legal same/backdated regrant %s", async at => {
    const grant = store.publicationGrantFor(REPO)!; phase("firing"); hold(); store.savePublicationGrant(grant, at); const before = row(), gh = execFor(facts());
    expect(await sweepMerges(store, { repo: REPO, exec: gh.exec, clock: () => LATER })).toMatchObject({ merged:0 }); expect(row()).toEqual(before); expect(entries()).toEqual([]); expect(gh.calls.some(args => args.includes("merge"))).toBe(false);
  });
  test.each([NOW, new Date(NOW.getTime()-1000)])("bound original row survives legal replacement grant %s", async at => {
    const grant = store.publicationGrantFor(REPO)!; admitted(); hold(); store.savePublicationGrant(grant, at); expect(store.publicationGrantFor(REPO)!.id).not.toBe(grant.id);
    expect(JSON.parse(String(entries()[0]!["detail"])).j).toBe(grant.id); const gh = execFor(facts()); expect(await sweepMerges(store, { repo: REPO, exec: gh.exec, clock: () => LATER })).toMatchObject({ merged:1 });
  });
  test.each(["missing", "changed"])("original grant %s cannot be replaced by matching new row", async damage => {
    const grant = store.publicationGrantFor(REPO)!; admitted(); hold(); store.savePublicationGrant(grant, NOW);
    if (damage === "missing") store.handle.prepare("DELETE FROM publication_grant WHERE id=?").run(grant.id); else store.handle.prepare("UPDATE publication_grant SET base='other' WHERE id=?").run(grant.id);
    const before = row(), gh = execFor(facts()); expect(await sweepMerges(store, { repo: REPO, exec: gh.exec, clock: () => LATER })).toMatchObject({ merged:0 }); expect(row()).toEqual(before);
  });
  test.each(["duplicate", "actor", "source", "outcome", "run", "task", "repo", "truncated", "spaces", "extra", "unsafe", "version", "intent-locator", "grant", "scope", "future-epoch"])("corrupt/duplicate %s candidate cannot vanish before trust filtering", async attack => {
    admitted(); hold(); const before = row();
    if (attack === "duplicate") corrupt({});
    if (attack === "actor") corrupt({ actor:"someone" });
    if (attack === "source") corrupt({ source:"request" });
    if (attack === "outcome") corrupt({ outcome:"999:999" });
    if (attack === "run") corrupt({ run_id:run+999 });
    if (attack === "task") corrupt({ task_id:"other" });
    if (attack === "repo") corrupt({ repo:"/other" });
    if (attack === "truncated") corrupt({}, () => "{");
    if (attack === "spaces") corrupt({}, value => JSON.stringify(value,null,1));
    if (attack === "extra") corrupt({}, value => JSON.stringify({ ...value, extra:true }));
    if (attack === "unsafe") corrupt({}, value => JSON.stringify({ ...value, j:Number.MAX_SAFE_INTEGER+1 }));
    if (attack === "version") corrupt({}, value => JSON.stringify({ ...value, v:2 }));
    if (attack === "intent-locator") corrupt({}, value => JSON.stringify({ ...value, i:intent+999 }));
    if (attack === "grant") corrupt({}, value => JSON.stringify({ ...value, j:999 }));
    if (attack === "scope") corrupt({}, value => JSON.stringify({ ...value, s:"f".repeat(64) }));
    if (attack === "future-epoch") corrupt({}, value => JSON.stringify({ ...value, g:2 }));
    const gh = execFor(facts()); expect(await sweepMerges(store, { repo: REPO, exec: gh.exec, clock: () => LATER })).toMatchObject({ merged:0 }); expect(row()).toEqual(before); expect(gh.calls.some(args => args.includes("merge"))).toBe(false);
  });  test("changed-basis real refire conservatively refuses unreconstructable older history", () => {
    admitted(); expect(store.refireMergeIntent(intent, "alex", LATER)).toEqual({ ok:true }); const claim = store.claimMergeIntent(intent, "synthetic", 1000, LATER)!, before = row();
    expect(store.fireMergeIntent(intent, claim.generation, { repo:REPO, headSha:HEAD, liveGrantTermsHash:mergeTermsHash(store.publicationGrantFor(REPO)!), graceMs:0 }, LATER)).toMatchObject({ ok:false, why:"the firing admission history is inconsistent" }); expect(row()).toEqual(before); expect(entries()).toHaveLength(1);
  });
  test("fully reconstructable earlier human epoch is history, not authority for current epoch", async () => {
    phase("waiting-human"); expect(store.authorizeMergeIntent(intent, HEAD, "alex", NOW)).toEqual({ ok:true }); admitted();
    expect(store.refireMergeIntent(intent, "alex", LATER)).toEqual({ ok:true }); const claim = store.claimMergeIntent(intent, "synthetic", 1000, LATER)!;
    expect(store.fireMergeIntent(intent, claim.generation, { repo:REPO, headSha:HEAD, liveGrantTermsHash:mergeTermsHash(store.publicationGrantFor(REPO)!), graceMs:0 }, LATER)).toEqual({ ok:true }); expect(entries()).toHaveLength(2); hold();
    const gh = execFor(facts()); expect(await sweepMerges(store, { repo:REPO, exec:gh.exec, clock:()=>LATER })).toMatchObject({ merged:1 });
  });
  test("same external task ID in an unrelated project cannot poison current admission discovery", async () => {
    const unrelated = store.refFor("external-test", "task").id; store.placeTask(unrelated, "/unrelated/project"); expect(unrelated).not.toBe(ref); expect(store.handle.prepare("SELECT repo,external_id FROM task_ref WHERE id=?").get(unrelated)).toMatchObject({ repo:"/unrelated/project", external_id:"task" });
    admitted(); hold();
    store.handle.prepare("INSERT INTO action_ledger(at,actor,repo,task_id,run_id,action,outcome,source,detail) VALUES (?,?,?,?,?,?,?,?,?)").run(NOW.toISOString(),"toolroll","/unrelated/project","task",999,action,"999:1","work","{");
    const gh = execFor(facts()); expect(await sweepMerges(store, { repo:REPO, exec:gh.exec, clock:()=>LATER })).toMatchObject({ merged:1 });
  });
  test("duplicate fully reconstructable earlier epoch cannot be ignored as history", async () => {
    phase("waiting-human"); expect(store.authorizeMergeIntent(intent,HEAD,"alex",NOW)).toEqual({ ok:true }); admitted(); expect(store.refireMergeIntent(intent,"alex",LATER)).toEqual({ ok:true });
    const claim = store.claimMergeIntent(intent,"synthetic",1000,LATER)!; expect(store.fireMergeIntent(intent,claim.generation,{ repo:REPO,headSha:HEAD,liveGrantTermsHash:mergeTermsHash(store.publicationGrantFor(REPO)!),graceMs:0 },LATER)).toEqual({ ok:true }); hold(); const before = row(); corrupt({});
    const gh = execFor(facts()); expect(await sweepMerges(store,{ repo:REPO,exec:gh.exec,clock:()=>LATER })).toMatchObject({ merged:0 }); expect(row()).toEqual(before);
  });

});
