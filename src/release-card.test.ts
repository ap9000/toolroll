/**
 * The release card (docs/plans/chat-management.md §0a.5), at the chat-decide door every chat app uses, over a real
 * plane database and a real repository: a deploy gate (release terms, or only a candidate) is approved from chat only
 * through Continue then Approve, bound to the card's digest (scope, plan form, recorded baseline, change list); the
 * plain plan card and any other chat seal refuse; a group, another chat or a nightly check does nothing; the change list
 * comes from the plane's record of the last verified release, never a tag; and the terms renderer names every field.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, releaseAuthorityOfTask, type Store } from "./store.js";
import { addApprover, deployGateScope, personApprovalOf, propose } from "./scope.js";
import { releaseTermsFor } from "./release-carry.js";
import { setChatApproval } from "./chat-approval.js";
import { verifyApproverStanding } from "./principal.js";
import { applyDecideTap, decideOffer, mintDecideButtons, planInChat, privateReleaseChat, type DecideSeat } from "./chat-decide.js";
import { approvalTermsOf, cardDigestOf, RELEASE_TERM_LABELS, releaseBaseline, releaseCardOf, SCOPE_TERM_LABELS, schemaLeaves } from "./release-card.js";
import { releaseTermsSchema, type ReleaseTerms } from "./contracts/release-terms.js";
import { scopeTermsSchema } from "./contracts/scope.js";

const NOW = new Date("2026-10-25T12:00:00.000Z");
const VERSION = "0.9.73";
let dir: string, repo: string, store: Store, root: string;
const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=T", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
const commit = (file: string, message: string) => { writeFileSync(join(repo, file), `${message}\n`); git("add", "-A"); git("commit", "-q", "-m", message); return git("rev-parse", "HEAD"); };
let baseline: string, candidate: string;
const seat = (chat = "4242"): DecideSeat => ({ channel: "telegram", binding: 1, chat, approver: "alex", generation: store.accountOf("alex")!.generation });
const who = () => { const verified = verifyApproverStanding(store, "alex", store.accountOf("alex")!.generation, [repo]); if (!verified.ok) throw new Error("standing"); return verified.who; };

/** A merged earlier release on the plane's record: its merge operation succeeded with this merge commit. */
function recordMergedRelease(mergeCommit: string, version = "0.9.72"): void {
  const db = store.handle;
  const id = Number(db.prepare(`INSERT INTO release_authority (repo, generation, version, pr, branch, base, anchor_task, anchor_digest, approved_sha, approved_tree, tip_sha, tip_task,
    policy_json, policy_digest, verify_command, verify_digest, access_digest, state, expires_at, created_at) VALUES (?,1,?,1,'b','main','t','d',?,?,?,'t','{}','p',1,'v','a','merged',?,?)`)
    .run(repo, version, mergeCommit, mergeCommit, mergeCommit, NOW.toISOString(), NOW.toISOString()).lastInsertRowid);
  db.prepare("INSERT INTO release_operation (id, authority, kind, task_id, candidate, epoch, state, external_ref, reserved_at, finished_at) VALUES (?,?, 'merge', 't', ?, 1, 'succeeded', ?, ?, ?)")
    .run(`op-${id}`, id, mergeCommit, mergeCommit, NOW.toISOString(), NOW.toISOString());
}

/** A deploy gate filed as `toolroll release` files one: its candidate and release terms, never approved. */
function fileGate(taskId = "release-0.9.73", options: { terms?: boolean } = {}): string {
  store.createTask({ id: taskId, title: `Release ${VERSION}` }, NOW);
  store.placeTask(store.refFor("built-in", taskId).id, repo, {}, NOW);
  const terms = releaseTermsFor(store, { repo, version: VERSION, branch: "release-0.9.73", pr: 260, candidate, now: NOW });
  if (!terms.ok) throw new Error(terms.why);
  propose(store, { taskId, goal: `Verify ${VERSION}`, candidate, acceptance: [{ id: "c1", statement: "The release check passes", how: null, evidence: ["check"] }],
    ...(options.terms === false ? {} : { releaseTerms: terms.terms }), now: NOW });
  return taskId;
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-release-card-")));
  root = join(dir, "evidence");
  repo = join(dir, "project");
  mkdirSync(repo);
  git("init", "-q", "-b", "main");
  baseline = commit("a.txt", "The last release");
  commit("b.txt", "Fix the queue");
  candidate = commit("c.txt", "Add the release card");
  store = openStore(join(dir, "orders.db"));
  store.upsertProject(repo, "project", NOW, { remoteUrl: "https://github.com/example-invalid/project.git" });
  if (!addApprover(store, "alex", NOW).ok) throw new Error("approver");
  for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "test", NOW);
  store.setVerifyCommand({ repo, command: "node scripts/release-check.mjs --full", timeoutMs: 60_000, approvedBy: "alex" }, NOW);
  if (!setChatApproval(store, { approver: "alex", scope: "*", enabled: true, limits: { fullAccess: true, capMicrousd: null }, via: "test" }, NOW).ok) throw new Error("chat approval");
  recordMergedRelease(baseline);
  // The person's paired chats, as the bridges record them: Telegram (a private chat is the user's own id) and Slack.
  bind("telegram", 1, "4242", "4242", "alex");
  bind("slack", 2, "U1", "D0ALEX", "alex");
  bind("telegram", 3, "5353", "5353", "sam");
});
function bind(provider: string, id: number, member: string, channel: string, approver: string): void {
  store.handle.prepare("INSERT INTO chat_binding (provider, id, installation, team, app, member, channel, approver, generation, created) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(provider, id, "i", "t", "a", member, channel, approver, store.accountOf(approver)?.generation ?? 1, NOW.toISOString());
}
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

/** Offer the card, tap Continue, then return the Approve tap. */
function continueCard(taskId: string, chat = "4242") {
  const offer = decideOffer(store, { kind: "plan", taskId }, who(), NOW, "telegram", root);
  if (offer === null) throw new Error("no release card offered");
  const minted = mintDecideButtons(store, seat(chat), { kind: "plan", taskId }, offer, NOW, "m1");
  const tapped = applyDecideTap(store, seat(chat), { token: minted.tokens[0]!, message: "m1", shown: offer.text ?? "", repos: [repo], root, now: NOW });
  return { offer, minted, tapped };
}

describe("the release card", () => {
  test("a gate with no authority row: the plain plan card refuses, Continue then Approve seals it as a person's chat yes and opens the authority", () => {
    const taskId = fileGate();
    expect(deployGateScope(store.getScope(taskId)!)).toBe(true);
    expect(releaseAuthorityOfTask(store, taskId)).toBeNull();
    // The card: the common terms in a few lines, every term as a file, Continue first.
    const { offer, minted, tapped } = continueCard(taskId);
    expect(offer.text).toContain(`Release ${VERSION}: Release ${VERSION}`);
    expect(offer.text).toContain(`Changes since the last verified release (${baseline.slice(0, 7)}):`);
    expect(offer.text).toContain("Add the release card");
    expect(offer.file?.name).toBe(`release-${VERSION}-terms.txt`);
    expect(offer.file?.text).toContain(`Approved commit: ${candidate}`);
    expect(minted.rows[0]![0]!.label).toBe("Continue");
    // Continue: the file again, then Approve.
    expect(tapped?.file?.text).toContain("Release check access: sandboxed");
    const approve = tapped!.edit!.rows[0]![0]!;
    expect(approve.label).toBe("Approve");
    // The plain plan card's own token, minted as before: refused, pointing to the release card.
    const plan = planInChat(store, taskId, "alex", NOW, "telegram", root);
    if (!plan.ok) throw new Error(plan.why);
    const plain = mintDecideButtons(store, seat(), { kind: "plan", taskId }, { text: null, rows: [[{ act: "approve", run: null, digest: plan.digest }]] }, NOW, "m2");
    const refused = applyDecideTap(store, seat(), { token: plain.tokens[0]!, message: "m2", shown: "", repos: [repo], root, now: NOW });
    expect(refused?.edit?.text).toContain("This is a release: approve it from its release card.");
    // Any other chat seal of a deploy gate, without the release card's evidence, refuses in the primitive.
    expect(store.sealScopeApproval(taskId, "alex", NOW, {}, { kind: "chat", modeDigest: "m" })).toBe(false);
    expect(store.getScope(taskId)!.approvedAt).toBeNull();
    // Approve.
    const done = applyDecideTap(store, seat(), { token: "token" in approve ? approve.token : "", message: "m1", shown: tapped!.edit!.text, repos: [repo], root, now: NOW });
    expect(done?.edit?.text).toContain("✓ Release approved");
    const sealed = store.getScope(taskId)!;
    expect(sealed).toMatchObject({ approvedBy: "alex", approvalBasis: "chat", approvedDigest: sealed.digest });
    expect(releaseAuthorityOfTask(store, taskId)).not.toBeNull();
    // A person's proof, which the release and deploy gates accept, and it names the card it came from.
    expect(personApprovalOf(store, taskId)).toMatchObject({ ok: true, by: "alex", method: "chat" });
    const proof = store.handle.prepare("SELECT detail FROM action_ledger WHERE task_id = ? AND action = 'approval proved'").get(taskId);
    expect(JSON.parse(String(proof!["detail"]))).toMatchObject({ v: 1, card: "release", digest: sealed.digest });
    // Announced everywhere the person hears from Toolroll, naming the chat.
    const notice = store.handle.prepare("SELECT subject, recipient, push_class FROM notification WHERE kind = 'release-approved'").get();
    expect(notice).toMatchObject({ subject: `Release ${VERSION} approved from Telegram`, recipient: "alex", push_class: "attention" });
  });

  test("a fallback gate filed with only a candidate is a deploy gate too, from its signed terms", () => {
    const taskId = fileGate("gate-only", { terms: false });
    expect(deployGateScope(store.getScope(taskId)!)).toBe(true);
    expect(store.sealScopeApproval(taskId, "alex", NOW, {}, { kind: "chat", modeDigest: "m" })).toBe(false);
    const { tapped } = continueCard(taskId);
    expect(tapped?.edit?.rows[0]![0]!.label).toBe("Approve");
  });

  test.each(["scope", "baseline", "changes"] as const)("a changed %s between Continue and Approve refuses, with the new card", what => {
    const taskId = fileGate();
    const { tapped } = continueCard(taskId);
    const approve = tapped!.edit!.rows[0]![0]!;
    if (what === "scope") propose(store, { taskId, goal: `Verify ${VERSION}, again`, candidate, now: NOW, acceptance: [{ id: "c1", statement: "The release check passes", how: null, evidence: ["check"] }], releaseTerms: store.getScope(taskId)!.releaseTerms! });
    if (what === "baseline") recordMergedRelease(git("rev-parse", "HEAD~1"), "0.9.72-1");
    // The list read differently now: the project's Git config gained a setting the release won't read with.
    if (what === "changes") git("config", "--local", "http.proxy", "http://127.0.0.1:9");
    const done = applyDecideTap(store, seat(), { token: "token" in approve ? approve.token : "", message: "m1", shown: tapped!.edit!.text, repos: [repo], root, now: NOW });
    expect(store.getScope(taskId)!.approvedAt).toBeNull();
    expect(done?.ack).toMatch(/changed/);
  });

  test("a moved tag changes nothing: the list comes from the recorded merge commit, as objects", () => {
    const taskId = fileGate();
    const before = releaseCardOf(store, store.getScope(taskId)!, "form", { profile: () => null });
    git("tag", "v0.9.72", baseline);
    git("tag", "-f", "v0.9.72", candidate);
    git("tag", "-f", baseline, candidate);
    const after = releaseCardOf(store, store.getScope(taskId)!, "form", { profile: () => null });
    expect(after.changes).toEqual(before.changes);
    expect(after.digest).toBe(before.digest);
    expect(after.changes.commits?.map(one => one.subject)).toEqual(["Add the release card", "Fix the queue"]);
    // The baseline is bound into the digest.
    expect(cardDigestOf("s", "f", { baseline, digest: "x" })).not.toBe(cardDigestOf("s", "f", { baseline: candidate, digest: "x" }));
    expect(releaseBaseline(store, repo)).toBe(baseline);
  });

  test("no earlier verified release: the card says so", () => {
    store.handle.prepare("DELETE FROM release_operation").run();
    const taskId = fileGate();
    const card = releaseCardOf(store, store.getScope(taskId)!, "form", { profile: () => null });
    expect(card.changes.baseline).toBeNull();
    expect(card.short).toContain("No earlier verified release is recorded.");
  });

  test.each(["sandboxed", "unsandboxed"] as const)("checks %s: the card says whether later commits run outside the sandbox unseen", access => {
    const taskId = fileGate();
    const scope = store.getScope(taskId)!;
    const terms = { ...scope.releaseTerms!, access, policy: { ...scope.releaseTerms!.policy, unsandboxedCarry: access !== "sandboxed" } };
    const card = releaseCardOf(store, { ...scope, releaseTerms: terms }, "form", { profile: () => null });
    expect(card.short.includes("will run outside the sandbox without being shown to you first")).toBe(access !== "sandboxed");
    expect(card.full).toContain(`Carry when checks aren't sandboxed: ${access === "sandboxed" ? "no" : "yes"}`);
  });

  test("a tap from a group, another chat or a forwarded card does nothing; a nightly check is never approved from chat", () => {
    const taskId = fileGate();
    const offer = decideOffer(store, { kind: "plan", taskId }, who(), NOW, "telegram", root)!;
    const minted = mintDecideButtons(store, seat(), { kind: "plan", taskId }, offer, NOW, "m1");
    // The same button pressed in a group, or on another message (a forward): not for this chat.
    expect(applyDecideTap(store, seat("-100200"), { token: minted.tokens[0]!, message: "m1", shown: "", repos: [repo], root, now: NOW })).toMatchObject({ ignored: true });
    expect(applyDecideTap(store, seat(), { token: minted.tokens[0]!, message: "m9", shown: "", repos: [repo], root, now: NOW })).toMatchObject({ ignored: true });
    // A card minted into a group: its Continue refuses.
    const group = mintDecideButtons(store, seat("-100200"), { kind: "plan", taskId }, offer, NOW, "g1");
    const inGroup = applyDecideTap(store, seat("-100200"), { token: group.tokens[0]!, message: "g1", shown: "", repos: [repo], root, now: NOW });
    expect(inGroup?.edit?.text).toContain("only in your private chat");
    // A nightly check: no card at all.
    store.handle.prepare("INSERT INTO nightly_check (repo, sha, task, at) VALUES (?,?,?,?)").run(repo, candidate, taskId, NOW.toISOString());
    expect(decideOffer(store, { kind: "plan", taskId }, who(), NOW, "telegram", root)).toBeNull();
    expect(store.getScope(taskId)!.approvedAt).toBeNull();
  });
});

test("a release card works only in the person's own private chat, from the binding's record: fail closed", () => {
  const telegram = { channel: "telegram" as const, binding: 1, chat: "4242", approver: "alex" };
  expect(privateReleaseChat(store, telegram)).toBe(true);
  expect(privateReleaseChat(store, { channel: "slack", binding: 2, chat: "D0ALEX", approver: "alex" })).toBe(true);
  // A missing chat, a group, a chat that isn't the binding's, another person's binding or DM, an unknown binding.
  expect(privateReleaseChat(store, { ...telegram, chat: "" })).toBe(false);
  expect(privateReleaseChat(store, { ...telegram, chat: "-1004242" })).toBe(false);
  expect(privateReleaseChat(store, { ...telegram, chat: "5353" })).toBe(false);
  expect(privateReleaseChat(store, { ...telegram, binding: 3, chat: "5353" })).toBe(false);
  expect(privateReleaseChat(store, { ...telegram, binding: 99 })).toBe(false);
  expect(privateReleaseChat(store, { channel: "slack", binding: 2, chat: "C0TEAM", approver: "alex" })).toBe(false);
  // Discord and Teams have no private-chat record to prove: the card isn't offered there.
  expect(privateReleaseChat(store, { channel: "discord", binding: 1, chat: "4242", approver: "alex" })).toBe(false);
  expect(privateReleaseChat(store, { channel: "teams", binding: 1, chat: "4242", approver: "alex" })).toBe(false);
});

describe("the complete terms renderer (contract)", () => {
  const terms = (): ReleaseTerms => ({
    version: 1, repo, packageVersion: "9.8.7", branch: "release-x", pr: 4321, base: "main", approvedSha: "a".repeat(40), approvedTree: "b".repeat(40),
    policy: { version: 1, rules: 1, carry: true, protectProject: false, protectedPaths: ["src/policy.ts", "docs/secret.md"], limits: { lines: 111, files: 22, churn: 333 }, unsandboxedCarry: true },
    grant: { id: 77, digest: "grant-digest-xyz" }, access: "sandboxed", expiresAt: "2026-10-28T12:00:00.000Z",
  });

  test("every release term and every scope term has a line", () => {
    for (const leaf of schemaLeaves(releaseTermsSchema)) expect(RELEASE_TERM_LABELS[leaf], leaf).toBeDefined();
    for (const key of Object.keys((scopeTermsSchema as unknown as { unwrap: () => { shape: Record<string, unknown> } }).unwrap().shape)) expect(Object.keys(SCOPE_TERM_LABELS), key).toContain(key);
    for (const key of ["budgetMicrousd", "candidate", "checks", "checkAccess", "agents", "title", "project", "filedBy"]) expect(Object.keys(SCOPE_TERM_LABELS)).toContain(key);
  });

  test("with every field set, each value is in the output", () => {
    store.createTask({ id: "full", title: "Every field", filedBy: { name: "alex", kind: "person" } }, NOW);
    store.placeTask(store.refFor("built-in", "full").id, repo, {}, NOW);
    propose(store, { taskId: "full", goal: "The goal words", outOfScope: "The exclusion words", touches: ["src/one.ts"], budgetMicrousd: 4_500_000, candidate,
      acceptance: [{ id: "c1", statement: "The statement words", how: null, evidence: ["check"] }], now: NOW });
    const scope = { ...store.getScope("full")!, releaseTerms: terms() };
    const text = approvalTermsOf(store, scope, { profile: () => "the permission words" }).map(line => `${line.label}: ${line.value}`).join("\n");
    for (const value of ["Every field", "project (", "alex", "The goal words", "The exclusion words", "src/one.ts", "c1: The statement words", "claude · sonnet", "the permission words", "Checks:", "Check access: sandboxed", "$4.50", candidate,
      repo, "9.8.7", "release-x", "#4321", "Base: main", "a".repeat(40), "b".repeat(40), "Carry later commits: yes", "Protected: the whole project: no", "src/policy.ts, docs/secret.md", "lines: 111", "files: 22", "churn: 333", "Carry when checks aren't sandboxed: yes", "77", "grant-digest-xyz", "Release check access: sandboxed", "2026-10-28T12:00:00.000Z"]) {
      expect(text, value).toContain(value);
    }
  });

  test.each([...Object.keys(SCOPE_TERM_LABELS).filter(key => ["outOfScope", "touches", "acceptance", "budgetMicrousd", "candidate"].includes(key)), "release"])("with %s omitted, the line says none rather than dropping", omitted => {
    store.createTask({ id: "sparse", title: "Sparse" }, NOW);
    store.placeTask(store.refFor("built-in", "sparse").id, repo, {}, NOW);
    propose(store, { taskId: "sparse", goal: "Only a goal", now: NOW });
    const scope = store.getScope("sparse")!;
    const lines = approvalTermsOf(store, scope, { profile: () => null });
    const keys = omitted === "release" ? lines.filter(line => line.key.startsWith("release.")).map(line => line.key) : [omitted];
    for (const key of keys) expect(lines.find(line => line.key === key), key).toMatchObject({ value: "none" });
    expect(lines.length).toBe(Object.keys(SCOPE_TERM_LABELS).length + schemaLeaves(releaseTermsSchema).length);
  });
});
