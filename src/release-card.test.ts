/**
 * The release card (docs/plans/chat-management.md §0a.5), at the chat-decide door every chat app uses, over a real
 * plane database and a real repository: a deploy gate (release terms, or only a candidate) is approved from chat only
 * through Continue then Approve, bound to the card's digest (scope, plan form, recorded baseline, change list); the
 * plain plan card and any other chat seal refuse; a group, another chat or a nightly check does nothing; the change list
 * comes from the plane's record of the last verified release, never a tag; and the terms renderer names every field.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, releaseAuthorityOfTask, type Store } from "./store.js";
import { addApprover, deployGateScope, digestOf, personApprovalOf, propose, type ExecutionProfile, type QualityMode } from "./scope.js";
import { releaseTermsFor } from "./release-carry.js";
import { setChatApproval } from "./chat-approval.js";
import { verifyApproverStanding } from "./principal.js";
import { applyDecideTap, decideOffer, mintDecideButtons, permissionPlainWords, planInChat, privateReleaseChat, type DecideSeat } from "./chat-decide.js";
import { approvalTermsOf, cardDigestOf, RELEASE_TERM_LABELS, releaseBaseline, releaseCardOf, SCOPE_TERM_LABELS, schemaLeaves, termsText } from "./release-card.js";
import { routeFromJson } from "./phase-routing.js";
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
    // (A list that can't be read now refuses the card outright.)
    if (what === "changes") expect(done?.edit?.text).toContain("list of changes couldn't be read");
    else expect(done?.ack).toMatch(/changed/);
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

  test.each(["shallow", "grafts", "replace"] as const)("history rewritten around the objects (%s) refuses the list and the card, never shortens it (0.9.73 review, finding 4)", how => {
    const taskId = fileGate();
    const gitDir = join(repo, ".git");
    // What a build can write in its checkout's .git after filing: a boundary at the candidate hides the commits before it.
    if (how === "shallow") writeFileSync(join(gitDir, "shallow"), `${candidate}\n`);
    if (how === "grafts") { mkdirSync(join(gitDir, "info"), { recursive: true }); writeFileSync(join(gitDir, "info", "grafts"), `${candidate} ${baseline}\n`); }
    if (how === "replace") git("replace", "--graft", candidate, baseline);
    const card = releaseCardOf(store, store.getScope(taskId)!, "form", { profile: () => null });
    expect(card.changes.commits).toBeNull();
    expect(card.short).toContain("The change list couldn't be read.");
    expect(card.short).not.toContain("Add the release card");
    // No Continue leads to Approve on it: the offer refuses.
    expect(decideOffer(store, { kind: "plan", taskId }, who(), NOW, "telegram", root)?.rows.flat().some(one => "act" in one && one.act === "approve") ?? false).toBe(false);
  });

  test("the change list runs the release path's own Git by its absolute path, never one a PATH names first", () => {
    const taskId = fileGate();
    const bin = join(dir, "planted-bin"), ran = join(dir, "planted-ran");
    mkdirSync(bin);
    writeFileSync(join(bin, "git"), `#!/bin/sh\ntouch ${JSON.stringify(ran)}\nexit 1\n`, { mode: 0o755 });
    vi.stubEnv("PATH", `${bin}:${process.env["PATH"] ?? ""}`);
    try {
      const card = releaseCardOf(store, store.getScope(taskId)!, "form", { profile: () => null });
      expect(card.changes.commits?.map(one => one.subject)).toEqual(["Add the release card", "Fix the queue"]);
      expect(existsSync(ran)).toBe(false);
    } finally { vi.unstubAllEnvs(); }
  });

  test("the range is proved to stop only in the last release's own history, within reach; past it the list refuses", async () => {
    const { verifiedRange } = await import("./commit-extract.js");
    // A side line from the baseline, two commits long, merged into main: the merge's range stops at the baseline.
    git("checkout", "-q", "-b", "side", baseline);
    commit("d.txt", "Side work");
    const side = commit("e.txt", "More side work");
    git("checkout", "-q", "main");
    git("merge", "-q", "--no-ff", "-m", "Merge side", side);
    const merged = git("rev-parse", "HEAD");
    const range = verifiedRange(join(repo, ".git"), baseline, merged);
    expect(range.ok && range.value.map(one => one.message.split("\n")[0]).sort()).toEqual(["Add the release card", "Fix the queue", "Merge side", "More side work", "Side work"]);
    // Measured from the side line's tip, the range stops at the baseline, two commits back: proved within reach, not within one.
    expect(verifiedRange(join(repo, ".git"), side, candidate)).toMatchObject({ ok: true });
    expect(verifiedRange(join(repo, ".git"), side, candidate, { reach: 1 })).toMatchObject({ ok: false, message: expect.stringContaining("isn't verified as part of the last release's history") });
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

  test("every input of the approval digest is in the terms: changing any one signed value changes the text too (0.9.73 review, finding 5)", () => {
    store.createTask({ id: "full", title: "Every field", filedBy: { name: "alex", kind: "person" } }, NOW);
    store.placeTask(store.refFor("built-in", "full").id, repo, {}, NOW);
    propose(store, { taskId: "full", goal: "The goal words", outOfScope: "The exclusion words", touches: ["src/one.ts"], budgetMicrousd: 4_500_000, candidate,
      acceptance: [{ id: "c1", statement: "The statement words", how: "advisory, never signed", evidence: ["check", "screenshot"] }], releaseTerms: terms(), now: NOW });
    const filed = store.getScope("full")!;
    const route = routeFromJson(filed.proposedRouteJson ?? null);
    expect(route).not.toBeNull();
    // Every optional setting a profile can seal, present, so each is varied too.
    const profile = { ...filed.profile!, readDeny: ["~/private"], machLookup: ["com.example.service"], checkAccess: "unsandboxed", fencePolicy: 2, timeoutKind: "idle" } as unknown as ExecutionProfile;
    const inputs = { scope: { goal: filed.goal, outOfScope: filed.outOfScope, touches: filed.touches, budgetMicrousd: filed.budgetMicrousd, acceptance: filed.acceptance,
      qualityMode: "standard" as QualityMode, candidate: filed.candidate ?? null, releaseTerms: filed.releaseTerms! }, profile, route: route! };
    type Inputs = typeof inputs;
    const digest = (one: Inputs) => digestOf(one.scope, one.profile, one.route);
    const text = (one: Inputs) => termsText(approvalTermsOf(store, { ...filed, ...one.scope, profile: one.profile, proposedRouteJson: JSON.stringify(one.route) }, { profile: permissionPlainWords }));
    // Each leaf of every input, changed in turn: a string gains a letter, a number one, a flag flips, a list gains an entry.
    const variants: { path: string; changed: Inputs }[] = [];
    const walk = (value: unknown, path: (string | number)[]): void => {
      const set = (next: unknown) => {
        const changed = structuredClone(inputs) as Record<string | number, unknown>;
        let at = changed;
        for (const key of path.slice(0, -1)) at = at[key] as Record<string | number, unknown>;
        at[path.at(-1)!] = next;
        variants.push({ path: path.join("."), changed: changed as unknown as Inputs });
      };
      if (Array.isArray(value)) { set([...value, value.every(one => typeof one === "string") ? "extra" : structuredClone(value[0])]); value.forEach((one, index) => walk(one, [...path, index])); }
      else if (value !== null && typeof value === "object") for (const [key, one] of Object.entries(value)) walk(one, [...path, key]);
      else if (typeof value === "string") set(`${value}x`);
      else if (typeof value === "number") set(value + 1);
      else if (typeof value === "boolean") set(!value);
      else set("set");
    };
    walk(inputs, []);
    variants.push({ path: "scope.qualityMode=strict", changed: { ...inputs, scope: { ...inputs.scope, qualityMode: "strict" } } });
    const before = { digest: digest(inputs), text: text(inputs) };
    let signed = 0;
    for (const { path, changed } of variants) {
      if (digest(changed) === before.digest) continue;
      signed += 1;
      expect(text(changed), path).not.toBe(before.text);
    }
    // The profile's read denies and the evidence each criterion needs are among them (the review's two examples).
    expect(variants.some(one => one.path.startsWith("profile.readDeny"))).toBe(true);
    expect(variants.some(one => one.path.includes("acceptance.0.evidence"))).toBe(true);
    expect(signed).toBeGreaterThan(40);
    // Unnamed paths are no limit, said so.
    expect(text({ ...inputs, scope: { ...inputs.scope, touches: [] } })).toContain("Paths it may touch: any file in the project");
  });

  test.each([...Object.keys(SCOPE_TERM_LABELS).filter(key => ["outOfScope", "acceptance", "budgetMicrousd", "candidate"].includes(key)), "release"])("with %s omitted, the line says none rather than dropping", omitted => {
    store.createTask({ id: "sparse", title: "Sparse" }, NOW);
    store.placeTask(store.refFor("built-in", "sparse").id, repo, {}, NOW);
    propose(store, { taskId: "sparse", goal: "Only a goal", now: NOW });
    const scope = store.getScope("sparse")!;
    const lines = approvalTermsOf(store, scope, { profile: () => null });
    const keys = omitted === "release" ? lines.filter(line => line.key.startsWith("release.")).map(line => line.key) : [omitted];
    for (const key of keys) expect(lines.find(line => line.key === key), key).toMatchObject({ value: "none" });
    expect(lines.filter(line => !/^(profile|route)\b/.test(line.key)).length).toBe(Object.keys(SCOPE_TERM_LABELS).length + schemaLeaves(releaseTermsSchema).length);
  });
});
