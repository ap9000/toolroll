/**
 * One-tap release approval (docs/plans/trusted-release-reports.md, slice A), over a real plane database and a real
 * repository: the card reads both sealed forms and says every field; verified release history and a complete,
 * candidate-bound change list; commit subjects as control-free display text; the one card-approval wrapper (a stale
 * card, a CI re-run, a hold or a changed scope refuses, inside the seal's transaction too, and the snapshot's scope
 * digest is what approve() gets); the proofs exactly as today; the notification's whole life and the push it becomes.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { releaseFixture, FIXTURE_PASSWORD, RELEASE_REFUSALS, VERSION, type ReleaseFixture } from "../test/release-fixture.js";
import { releaseCheckPurposeSchema } from "./contracts/release-terms.js";
import { pullRequestCommits, PULL_REQUEST_COMMITS_MAX, RELEASE_CHECK_LABELS, recordVerifiedRelease, schemaLeaves, subjectText, verifiedReleaseBaseline, type PullRequestReader } from "./release-card.js";
import {
  approveReleaseCard, noteReleaseReady, noteReleaseStopped, RELEASE_PUSH_WORDS, recordReleaseCi, releaseApprovalCard, releaseCardLines, releasePushOf, releaseReadyObsolete,
  retireReleaseReady, type ReleaseApprovalCard,
} from "./release-approval.js";
import { approve, freshFacts, personApprovalOf, propose, withFreshness, type FreshFacts } from "./scope.js";
import { releaseCheckPurposeFor } from "./release-carry.js";
import { setPasswordless } from "./passwordless.js";
import { buildPushPayload } from "./push.js";
import type { Store } from "./store.js";
import { holdApprovalForCi } from "./release-auto.js";

let f: ReleaseFixture;
const NOW = new Date("2026-10-25T12:00:00.000Z");

/** A merged earlier release on the plane's record (its merge operation succeeded), so the change list reads Git only. */
function recordMergedRelease(store: Store, repo: string, mergeCommit: string): void {
  const db = store.handle;
  const id = Number(db.prepare(`INSERT INTO release_authority (repo, generation, version, pr, branch, base, anchor_task, anchor_digest, approved_sha, approved_tree, tip_sha, tip_task,
    policy_json, policy_digest, verify_command, verify_digest, access_digest, state, expires_at, created_at) VALUES (?,1,'0.9.70',1,'b','main','t','d',?,?,?,'t','{}','p',1,'v','a','merged',?,?)`)
    .run(repo, mergeCommit, mergeCommit, mergeCommit, NOW.toISOString(), NOW.toISOString()).lastInsertRowid);
  db.prepare("INSERT INTO release_operation (id, authority, kind, task_id, candidate, epoch, state, external_ref, reserved_at, finished_at) VALUES (?,?, 'merge', 't', ?, 1, 'succeeded', ?, ?, ?)")
    .run(`op-${id}`, id, mergeCommit, mergeCommit, NOW.toISOString(), NOW.toISOString());
}
const cardOf = (taskId = f.taskId): ReleaseApprovalCard => { const built = releaseApprovalCard(f.store, taskId); if (!built.ok) throw new Error(built.why); return built.card; };
const typed = (taskId = f.taskId) => (digest: string) => approve(f.store, taskId, "alex", NOW, digest, FIXTURE_PASSWORD);
const ci = (state: "passed" | "running" | "failed", runs: { id: number; name: string; status: string; conclusion: string | null }[], failed: string[] = []) =>
  recordReleaseCi(f.store, { taskId: f.taskId, candidate: f.approved, state, failed, runs, now: NOW });

beforeEach(() => {
  // Toolroll's own shape: checks outside the sandbox, so the release seals a release check's purpose (not terms).
  f = releaseFixture({ termsless: true, approve: false, intermediate: { "src/queue.js": "export const q = 1;\n" }, candidate: { "src/card.js": "export const c = 1;\n" } });
  recordMergedRelease(f.store, f.repo, f.base);
});
afterEach(() => { vi.unstubAllEnvs(); f.close(); });

describe("one card, both sealed forms", () => {
  test("a release check's purpose: every field in the full terms, the unsandboxed consequence before consent", () => {
    expect(schemaLeaves(releaseCheckPurposeSchema).filter(leaf => RELEASE_CHECK_LABELS[leaf] === undefined)).toEqual([]);
    const card = cardOf();
    expect(card.seal.kind).toBe("check");
    const purpose = card.terms.filter(line => line.key.startsWith("releaseCheck."));
    expect(purpose.map(line => line.key.slice("releaseCheck.".length)).sort()).toEqual(schemaLeaves(releaseCheckPurposeSchema).sort());
    expect(purpose.find(line => line.key === "releaseCheck.approvedSha")?.value).toBe(f.approved);
    expect(purpose.find(line => line.key === "releaseCheck.access")?.value).toBe("unsandboxed");
    expect(purpose.every(line => line.value !== "none")).toBe(true);
    // Never the release terms' "none" lines in place of the purpose.
    expect(card.terms.some(line => line.key.startsWith("release."))).toBe(false);
    const lines = releaseCardLines(card).join("\n");
    expect(lines).toContain("The release check runs this commit's code with full access to this computer.");
    expect(lines).toContain("Every later commit asks again.");
    expect(lines).toContain(`Release ${VERSION} · pull request #240 · release-0.9.71`);
    expect(lines).toContain(`GitHub CI on ${f.approved.slice(0, 7)} hasn't been read yet.`);
    // The chat card reads the purpose too: its version and change list, never "Deploy gate".
    expect(card.card.short).toContain(`Release ${VERSION}`);
    expect(card.card.changes.commits?.map(one => one.subject)).toEqual(["candidate", "intermediate"]);
  });

  test("release terms (a sandboxed project) read as before: carrying said, no access sentence", () => {
    const g = releaseFixture({ approve: false, candidate: { "src/x.js": "1\n" } });
    try {
      const built = releaseApprovalCard(g.store, g.taskId, { read: () => ({ status: 1, stdout: "" }) });
      if (!built.ok) throw new Error(built.why);
      expect(built.card.seal.kind).toBe("terms");
      const lines = releaseCardLines(built.card).join("\n");
      expect(lines).toContain("Later commits that only change tests, docs or the changelog carry this approval.");
      expect(lines).not.toContain("full access to this computer");
    } finally { g.close(); }
  });

  test("a task that isn't a release scope has no card, whatever its title or id says", () => {
    f.store.createTask({ id: "release-9.9.9-abcdef0", title: "Release 9.9.9" }, NOW);
    f.store.placeTask(f.store.refFor("built-in", "release-9.9.9-abcdef0").id, f.repo, {}, NOW);
    propose(f.store, { taskId: "release-9.9.9-abcdef0", goal: "Looks like a release", now: NOW });
    expect(releaseApprovalCard(f.store, "release-9.9.9-abcdef0").ok).toBe(false);
  });
});

describe("verified release history and the change list", () => {
  test("a verified release is recorded only when its merge commit holds the approved tree, and the next list starts there", () => {
    expect(recordVerifiedRelease(f.store, { taskId: f.taskId, merge: f.base, now: NOW })).toBe(false); // another tree
    expect(recordVerifiedRelease(f.store, { taskId: "no-such-task", merge: f.approved, now: NOW })).toBe(false);
    expect(recordVerifiedRelease(f.store, { taskId: f.taskId, merge: "not a sha", now: NOW })).toBe(false);
    // Main's squash merge: a new commit with exactly the approved tree.
    const merge = f.commit({}, "Release 0.9.71 (#240)");
    expect(recordVerifiedRelease(f.store, { taskId: f.taskId, merge, now: new Date(NOW.getTime() + 1000) })).toBe(true);
    expect(verifiedReleaseBaseline(f.store, f.repo)).toEqual({ recorded: true, sha: merge });
  });

  const reader = (head: string, commits: { sha: string; subject: string }[], total = commits.length, prHead = head): PullRequestReader => args =>
    args.includes("--paginate") ? { status: 0, stdout: commits.map(one => `${one.sha}\t${JSON.stringify(one.subject)}`).join("\n") + "\n" } : { status: 0, stdout: `${prHead}\t${total}\n` };
  const sha = (n: number) => n.toString(16).padStart(40, "0");
  test.each([
    ["whole and bound to the head", reader(sha(3), [{ sha: sha(1), subject: "one" }, { sha: sha(2), subject: "two" }, { sha: sha(3), subject: "three" }]), { ok: true }],
    ["the pull request moved", reader(sha(3), [{ sha: sha(1), subject: "one" }], 1, sha(9)), { ok: false, why: expect.stringContaining("the pull request is at") }],
    ["fewer listed than it has", reader(sha(2), [{ sha: sha(2), subject: "two" }], 2), { ok: false, why: "incomplete: GitHub listed 1 of 2 commits" }],
    ["longer than GitHub lists", reader(sha(2), [{ sha: sha(2), subject: "two" }], PULL_REQUEST_COMMITS_MAX + 1), { ok: false, why: expect.stringContaining("incomplete") }],
    ["the newest listed isn't the head", reader(sha(2), [{ sha: sha(2), subject: "two" }, { sha: sha(5), subject: "five" }]), { ok: false, why: expect.stringContaining("newest commit") }],
    ["a commit listed twice", reader(sha(2), [{ sha: sha(2), subject: "a" }, { sha: sha(2), subject: "b" }]), { ok: false, why: expect.stringContaining("") }],
    ["GitHub unreadable", (() => ({ status: 1, stdout: "" })) as PullRequestReader, { ok: false, why: "GitHub couldn't be read" }],
  ])("a pull request's commits: %s", (_name, read, expected) => {
    const head = (read(["api", "x"]).stdout.split("\t")[0] ?? "").trim() || sha(3);
    const answer = pullRequestCommits("o/n", 1, head === sha(9) ? sha(3) : head, read);
    expect(answer).toMatchObject(expected);
    if (answer.ok) expect(answer.commits.map(one => one.subject)).toEqual(["three", "two", "one"]);
  });

  test("with no verified release, the card's list comes whole from the pull request or says why", () => {
    f.store.handle.exec("DELETE FROM release_operation; DELETE FROM release_authority;");
    f.store.upsertProject(f.repo, "project", NOW, { remoteUrl: "https://github.com/example-invalid/project.git" });
    const short = releaseApprovalCard(f.store, f.taskId, { read: reader(f.approved, [{ sha: f.approved, subject: "only" }], 2) });
    if (!short.ok) throw new Error(short.why);
    expect(short.card.card.changes).toMatchObject({ commits: null, source: "unread", why: "incomplete: GitHub listed 1 of 2 commits" });
    expect(releaseCardLines(short.card).join("\n")).toContain("What changed couldn't be read (incomplete: GitHub listed 1 of 2 commits).");
  });
});

describe("commit subjects are display text", () => {
  const hostile = "\x1b[2J\x1b[HApproved by alex\rFix‮exe.txt⁦ \x1b]8;;https://evil.example/\x07link\x1b]8;;\x07 \x9b31m";
  test("cleaned once, at ingestion: no escape, return, bidi or hyperlink control reaches the terminal card", () => {
    expect(subjectText(hostile)).not.toMatch(/[\x00-\x1f\x7f-\x9f‪-‮⁦-⁩]/);
    f.commit({ "src/later.js": "1\n" }, hostile);
    const later = f.git("rev-parse", "HEAD");
    // A release of that commit: its subject is in the card's list.
    const purpose = releaseCheckPurposeFor(f.store, { repo: f.repo, version: VERSION, branch: "hostile", pr: 241, candidate: later });
    if (!purpose.ok) throw new Error(purpose.why);
    f.store.createTask({ id: "release-hostile", title: "Release" }, NOW);
    f.store.placeTask(f.store.refFor("built-in", "release-hostile").id, f.repo, {}, NOW);
    propose(f.store, { taskId: "release-hostile", goal: "Verify", candidate: later, acceptance: [{ id: "c1", statement: "passes", how: null, evidence: ["check"] }], releaseCheck: purpose.purpose, now: NOW });
    const text = releaseCardLines(cardOf("release-hostile")).join("\n");
    expect(text).toContain("Fixexe.txt");
    expect(text).toContain("link");
    expect(text).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f‪-‮⁦-⁩]/);
  });
});

describe("the one card-approval wrapper", () => {
  test("approves with the snapshot's scope digest, through the unchanged approve()", () => {
    const card = cardOf();
    const seen: string[] = [];
    const answer = approveReleaseCard(f.store, { taskId: f.taskId, cardDigest: card.digest, approveNow: digest => { seen.push(digest); return typed()(digest); } });
    expect(answer.ok).toBe(true);
    expect(seen).toEqual([card.scope.digest]);
    expect(personApprovalOf(f.store, f.taskId)).toMatchObject({ ok: true, by: "alex", method: "password-now" });
  });

  test.each([
    ["a stale card digest", () => "0".repeat(64)],
    ["a digest that isn't one", () => "nope"],
  ])("%s refuses and approve() never runs", (_name, digest) => {
    const approveNow = vi.fn(typed());
    expect(approveReleaseCard(f.store, { taskId: f.taskId, cardDigest: digest(), approveNow })).toMatchObject({ ok: false, reason: "changed" });
    expect(approveNow).not.toHaveBeenCalled();
    expect(f.store.getScope(f.taskId)!.approvedAt).toBeNull();
  });

  test("a CI re-run (a new attempt) after reading refuses; a queued check starting doesn't", () => {
    ci("running", [{ id: 1, name: "Unit tests", status: "queued", conclusion: null }]);
    const shown = cardOf();
    ci("running", [{ id: 1, name: "Unit tests", status: "in_progress", conclusion: null }]);
    expect(cardOf().digest).toBe(shown.digest);
    ci("running", [{ id: 2, name: "Unit tests", status: "queued", conclusion: null }]);
    const approveNow = vi.fn(typed());
    expect(approveReleaseCard(f.store, { taskId: f.taskId, cardDigest: shown.digest, approveNow })).toMatchObject({ ok: false, reason: "changed" });
    expect(approveNow).not.toHaveBeenCalled();
  });

  test("a change after the card was rebuilt, inside the seal's transaction, still refuses", () => {
    const shown = cardOf();
    const original = f.store.transact.bind(f.store);
    vi.spyOn(f.store, "transact").mockImplementationOnce(body => { ci("running", [{ id: 7, name: "Unit tests", status: "queued", conclusion: null }]); return original(body); });
    const approveNow = vi.fn(typed());
    expect(approveReleaseCard(f.store, { taskId: f.taskId, cardDigest: shown.digest, approveNow })).toMatchObject({ ok: false, reason: "changed" });
    expect(approveNow).not.toHaveBeenCalled();
  });

  test("shown refusals refuse: CI failed, a CI hold, a scope rewritten", () => {
    ci("failed", [{ id: 3, name: "E2E", status: "completed", conclusion: "failure" }], ["E2E (failure)"]);
    const failed = cardOf();
    expect(failed.refusal).toContain("GitHub CI failed");
    expect(approveReleaseCard(f.store, { taskId: f.taskId, cardDigest: failed.digest, approveNow: typed() })).toMatchObject({ ok: false, reason: "refused" });
    ci("passed", [{ id: 4, name: "E2E", status: "completed", conclusion: "success" }]);
    const passing = cardOf();
    holdApprovalForCi(f.store, { taskId: f.taskId, candidate: f.approved, now: NOW });
    expect(approveReleaseCard(f.store, { taskId: f.taskId, cardDigest: passing.digest, approveNow: typed() })).toMatchObject({ ok: false, reason: "changed" });
    expect(cardOf().refusal).toContain("GitHub CI is still running");
    expect(f.store.getScope(f.taskId)!.approvedAt).toBeNull();
  });
});

describe("every approval road refuses what the sheet refuses", () => {
  const nothingKept = () => {
    const scope = f.store.getScope(f.taskId)!;
    expect(scope.approvedAt === null || scope.approvedDigest !== scope.digest).toBe(true);
  };
  test.each(RELEASE_REFUSALS.map(one => [one.name, one] as const))("%s: the shared core (approve(), as the task page, Home and the CLI call it) refuses in the sheet's words", (_name, one) => {
    one.apply(f, NOW);
    const sheetSays = cardOf().refusal;
    expect(sheetSays).toMatch(one.words);
    const votes = () => f.store.handle.prepare("SELECT COUNT(*) AS n FROM action_ledger WHERE task_id = ?").get(f.taskId)!["n"];
    const before = votes();
    expect(approve(f.store, f.taskId, "alex", NOW, f.store.getScope(f.taskId)!.digest, FIXTURE_PASSWORD)).toEqual({ ok: false, reason: "policy", message: sheetSays });
    // Refused before any vote or proof row is written.
    expect(votes()).toBe(before);
    nothingKept();
  });
  test.each(RELEASE_REFUSALS.map(one => [one.name, one] as const))("%s: the sheet still refuses it, approve() never runs", (_name, one) => {
    one.apply(f, NOW);
    const card = cardOf();
    const approveNow = vi.fn(typed());
    expect(approveReleaseCard(f.store, { taskId: f.taskId, cardDigest: card.digest, approveNow })).toEqual({ ok: false, reason: "refused", message: card.refusal });
    expect(approveNow).not.toHaveBeenCalled();
    nothingKept();
  });
  test("a clean release: the sheet and the core both approve, and a task that isn't a release is untouched by the rule", () => {
    expect(cardOf().refusal).toBeNull();
    expect(approveReleaseCard(f.store, { taskId: f.taskId, cardDigest: cardOf().digest, approveNow: typed() })).toMatchObject({ ok: true });
    const g = releaseFixture({ termsless: true, approve: false, candidate: { "src/card.js": "1\n" } });
    try {
      expect(approve(g.store, g.taskId, "alex", NOW, g.store.getScope(g.taskId)!.digest, FIXTURE_PASSWORD)).toMatchObject({ ok: true });
      // An ordinary task with a failed release-check row and a failed CI reading under its id: not a release, so no release rule.
      g.store.createTask({ id: "plain-work", title: "Release 9.9.9" }, NOW);
      g.store.placeTask(g.store.refFor("built-in", "plain-work").id, g.repo, {}, NOW);
      const plain = propose(g.store, { taskId: "plain-work", goal: "Ordinary work", now: NOW });
      g.store.handle.prepare("INSERT INTO release_step (task_id, tag, version, pr, step, state, started_at, updated_at) VALUES ('plain-work', 'v9.9.9', '9.9.9', 1, 'check', 'failed', ?, ?)").run(NOW.toISOString(), NOW.toISOString());
      expect(approve(g.store, "plain-work", "alex", NOW, plain.digest, FIXTURE_PASSWORD)).toMatchObject({ ok: true });
    } finally { g.close(); }
  });
});

describe("who can approve: the proofs exactly as today", () => {
  const facts = (over: Partial<FreshFacts> = {}): FreshFacts => ({ actor: "alex", local: true, allowlisted: true, live: () => true, passwordAt: () => null, ssoReauthAt: () => null,
    ssoNow: () => null, consumeSsoNow: () => () => {}, floor: () => 0, stamp: () => {}, ...over });
  const viaCard = (token: string) => approveReleaseCard(f.store, { taskId: f.taskId, cardDigest: cardOf().digest, approveNow: digest => approve(f.store, f.taskId, "alex", NOW, digest, token) });

  test("an explicit identity-provider re-check approves (sso-now)", () => {
    expect(freshFacts.run(facts({ ssoNow: () => Date.now() }), () => viaCard(""))).toMatchObject({ ok: true });
    expect(personApprovalOf(f.store, f.taskId)).toMatchObject({ ok: true, method: "sso-now" });
  });
  test("under Passwordless, the person's live browser session approves", () => {
    setPasswordless(f.store, true, "alex", NOW);
    expect(freshFacts.run(facts(), () => viaCard(""))).toMatchObject({ ok: true });
    expect(personApprovalOf(f.store, f.taskId)).toMatchObject({ ok: true, method: "session" });
  });
  test("a remembered password stands exactly where freshlyApprovable lets it, as on the task page", () => {
    const remembered = () => freshFacts.run(facts({ passwordAt: () => Date.now() - 1000 }), () => withFreshness("approve-standard", () => viaCard("")));
    // Written by another machine (a lead's confirmed proposal): its own password ceremony, typed now.
    f.store.handle.prepare("UPDATE task_scope SET proposed_via = 'mate' WHERE task_id = ?").run(f.taskId);
    expect(remembered()).toMatchObject({ ok: false, reason: "approve", result: { reason: "password-now" } });
    expect(f.store.getScope(f.taskId)!.approvedAt).toBeNull();
    // Everyday terms a person filed: the remembered password stands, recorded as remembered (never as typed now).
    f.store.handle.prepare("UPDATE task_scope SET proposed_via = NULL WHERE task_id = ?").run(f.taskId);
    expect(remembered()).toMatchObject({ ok: true });
    expect(personApprovalOf(f.store, f.taskId)).toMatchObject({ ok: true, method: "fresh-password" });
  });
  test("an empty password with nothing standing behind it proves no one", () => {
    expect(viaCard("")).toMatchObject({ ok: false, reason: "approve", result: { reason: "not-an-approver" } });
  });
});

describe("the notification's whole life", () => {
  const rows = () => f.store.handle.prepare("SELECT * FROM notification WHERE kind = 'release-ready' ORDER BY id").all();
  test("one per task and scope digest: asking again (a resumed gate) adds nothing", () => {
    expect(noteReleaseReady(f.store, { taskId: f.taskId, now: NOW })).toBe(true);
    expect(noteReleaseReady(f.store, { taskId: f.taskId, now: NOW })).toBe(false);
    const [row] = rows();
    expect(row).toMatchObject({ push_class: "decision", link: `/t/${f.taskId}/release`, resolved_at: null, task_id: f.taskId, subject: `Release ${VERSION} is ready for your approval` });
    expect(String(row!["body"])).toContain("You can approve now");
  });

  test("the push carries the fixed phrase and an opaque locator, derived from the plane's state", () => {
    noteReleaseReady(f.store, { taskId: f.taskId, now: NOW });
    const row = f.store.notificationById(Number(rows()[0]!["id"]))!;
    const release = releasePushOf(f.store, row);
    expect(release).toEqual({ link: `/approve/${row.taskRef}` });
    const payload = buildPushPayload(row, 1, release);
    expect(JSON.parse(payload)).toEqual({ title: "Toolroll", body: RELEASE_PUSH_WORDS, url: `/approve/${row.taskRef}`, tag: `so-${row.id}`, waiting: 1 });
    for (const secret of [VERSION, f.approved.slice(0, 7), "release-0.9.71", f.taskId]) expect(payload).not.toContain(secret);
  });

  test("approving before delivery retires it: the push pass never sends it", () => {
    noteReleaseReady(f.store, { taskId: f.taskId, now: NOW });
    expect(approveReleaseCard(f.store, { taskId: f.taskId, cardDigest: cardOf().digest, approveNow: typed() }).ok).toBe(true);
    const row = f.store.notificationById(Number(rows()[0]!["id"]))!;
    expect(row.resolvedAt).not.toBeNull();
    expect(releasePushOf(f.store, row)).toBeNull();
    expect(releaseReadyObsolete(f.store, { ...row, resolvedAt: null })).toBe(true);
  });

  test("a new commit's task supersedes the old one's notice", () => {
    noteReleaseReady(f.store, { taskId: f.taskId, now: NOW });
    const next = f.commit({ "src/next.js": "1\n" }, "next");
    const purpose = releaseCheckPurposeFor(f.store, { repo: f.repo, version: VERSION, branch: "release-0.9.71", pr: 240, candidate: next });
    if (!purpose.ok) throw new Error(purpose.why);
    f.store.createTask({ id: "release-next", title: "Release" }, NOW);
    f.store.placeTask(f.store.refFor("built-in", "release-next").id, f.repo, {}, NOW);
    propose(f.store, { taskId: "release-next", goal: "Verify", candidate: next, acceptance: [{ id: "c1", statement: "passes", how: null, evidence: ["check"] }], releaseCheck: purpose.purpose, now: NOW });
    expect(noteReleaseReady(f.store, { taskId: "release-next", now: NOW })).toBe(true);
    expect(rows().map(row => [row["task_id"], row["resolved_at"] === null])).toEqual([[f.taskId, false], ["release-next", true]]);
  });

  test("a forged or obsolete row is never a release push: a fake release-named task gets the ordinary ping and its task's locator", () => {
    f.store.createTask({ id: "release-9.9.9-abcdef0", title: "Release 9.9.9" }, NOW);
    const ref = f.store.refFor("built-in", "release-9.9.9-abcdef0").id;
    f.store.placeTask(ref, f.repo, {}, NOW);
    propose(f.store, { taskId: "release-9.9.9-abcdef0", goal: "Looks like a release", now: NOW });
    const digest = f.store.getScope("release-9.9.9-abcdef0")!.digest;
    f.store.enqueueNotification({ dedupeKey: `release-ready:${ref}:${digest}`, kind: "release-ready", pushClass: "decision", link: `/approve/${ref}`, source: { taskRef: ref }, subject: "x", body: "y" }, NOW);
    const row = f.store.notificationById(Number(f.store.handle.prepare("SELECT id FROM notification WHERE task_ref = ? AND kind = 'release-ready'").get(ref)!["id"]))!;
    expect(releasePushOf(f.store, row)).toBeNull();
    expect(JSON.parse(buildPushPayload(row, null, releasePushOf(f.store, row)))).toMatchObject({ body: `#${ref} has a question`, url: `/n/${ref}` });
    // The real release's row under another task's ref, or another digest, is no release push either.
    noteReleaseReady(f.store, { taskId: f.taskId, now: NOW });
    const real = f.store.notificationById(Number(rows().find(one => one["task_id"] === f.taskId)!["id"]))!;
    expect(releasePushOf(f.store, { ...real, taskRef: ref })).toBeNull();
    expect(releasePushOf(f.store, { ...real, dedupeKey: real.dedupeKey.replace(/[0-9a-f]+$/, "0".repeat(32)) })).toBeNull();
  });

  test("a manual release's stop files one attention notice, and retires the ask unless it only stopped waiting", () => {
    noteReleaseReady(f.store, { taskId: f.taskId, now: NOW });
    expect(noteReleaseStopped(f.store, { taskId: f.taskId, step: "approval", reason: "timeout", message: "Still waiting for a person after 1440 minutes.", now: NOW })).toBe(true);
    expect(rows()[0]!["resolved_at"]).toBeNull();
    expect(noteReleaseStopped(f.store, { taskId: f.taskId, step: "approval", reason: "timeout", message: "again", now: NOW })).toBe(false);
    expect(noteReleaseStopped(f.store, { taskId: f.taskId, step: "deploy", reason: "deploy", message: "\x1b[31mThe deploy failed\x1b[0m", now: NOW })).toBe(true);
    expect(rows()[0]!["resolved_at"]).not.toBeNull();
    const stopped = f.store.handle.prepare("SELECT subject, body, push_class FROM notification WHERE kind = 'release-stopped' ORDER BY id").all();
    expect(stopped.map(row => [row["subject"], row["push_class"]])).toEqual([[`Release ${VERSION} stopped at approval`, "attention"], [`Release ${VERSION} stopped at deploy`, "attention"]]);
    expect(String(stopped[1]!["body"])).toBe("The deploy failed");
    expect(retireReleaseReady(f.store, f.store.lookupRef(f.taskId)!.id, NOW)).toBe(0);
  });
});
