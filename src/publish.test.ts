/**
 * Publication: the grant is the whole permission, the intent survives every
 * crash, and the PR worker adopts before it creates — proved against a
 * scripted git and gh, never the network.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { openStore, type Store } from "./store.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureTerminalDiff, storeEvidence } from "./evidence.js";
import { addApprover } from "./scope.js";
import {
  bodyHashOf,
  observeChecks,
  publicationBody,
  permitsPublication,
  publishPass,
  MAX_PUBLISH_ATTEMPTS,
  type PublishExec,
} from "./publish.js";

/** A task with no scope presents the bare word `legacy` for the exact pair
 * it spends as (atomic authority closure): nothing opens unstamped. */
const bareLegacy = (phase: "build" | "plan" | "repair" | "review", provider: string = "claude", model: string | null = null) => ({
  route: { routeDigest: "legacy", phase, provider, model, chosen: "legacy" as const },
});

const T0 = new Date("2026-08-12T06:00:00.000Z");
const REPO = "/repo/main";

const OK = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };

function scripted(answers: Record<string, { code?: number; stdout?: string; stderr?: string }> = {}) {
  const calls: { file: string; args: string[] }[] = [];
  const exec: PublishExec = async (file, args) => {
    calls.push({ file, args: [...args] });
    const key = `${file} ${args.slice(0, 2).join(" ")}`;
    const match = Object.entries(answers).find(([prefix]) => key.startsWith(prefix));
    return { ...OK, ...(match?.[1] ?? {}) };
  };
  return { exec, calls };
}

describe("publication", () => {
  let store: Store;
  let taskRef: number;
  let runId: number;

  const grantIt = (over: Record<string, unknown> = {}) =>
    store.savePublicationGrant(
      {
        repo: REPO,
        githubRepo: "alex/thing",
        remote: "origin",
        headPrefix: "standing-orders/",
        base: "main",
        capabilities: ["push-branch", "open-pr"],
        selector: "all",
        draft: true,
        grantedBy: "alex",
        ...over,
      } as Parameters<Store["savePublicationGrant"]>[0],
      T0,
    );

  const intendIt = () =>
    store.createPublicationIntent(
      {
        run: runId,
        taskRef,
        githubRepo: "alex/thing",
        remote: "origin",
        base: "main",
        head: "standing-orders/t-1",
        headSha: "abc123def",
        bodyHash: "x",
        draft: true,
      },
      T0,
    );

  beforeEach(() => {
    store = openStore(":memory:");
    store.createTask({ id: "t-1", title: "wire the payout guard" }, T0);
    taskRef = store.refFor("built-in", "t-1").id;
    runId = store.startRun({
      taskRef,
      leaseId: "lease-1",
      runner: "builder-1",
      branch: "standing-orders/t-1",
      worktree: "/pool/t-1",
      ...bareLegacy("build", "claude", null), now: T0,
    });
    store.stampRun(runId, { baseRevision: "base999" });
    store.recordOutcomeFacts(runId, {
      headRevision: "abc123def",
      handoff: "Added the guard. Fixes #1 should stay prose.",
    });
  });

  afterEach(() => store.close());

  test("the grant is checked whole: repo, remote, base, prefix, capability", () => {
    const shape = { githubRepo: "alex/thing", remote: "origin", base: "main", head: "standing-orders/t-1", state: "intended" as const };

    expect(permitsPublication(null, shape)).toMatchObject({ ok: false });

    grantIt();
    const grant = store.publicationGrantFor(REPO);
    expect(permitsPublication(grant, shape)).toMatchObject({ ok: true });
    expect(permitsPublication(grant, { ...shape, head: "main" })).toMatchObject({ ok: false });
    expect(permitsPublication(grant, { ...shape, base: "release" })).toMatchObject({ ok: false });
    expect(permitsPublication(grant, { ...shape, githubRepo: "other/repo" })).toMatchObject({ ok: false });

    grantIt({ capabilities: ["push-branch"] });
    const pushOnly = store.publicationGrantFor(REPO);
    expect(permitsPublication(pushOnly, shape)).toMatchObject({ ok: true });
    expect(permitsPublication(pushOnly, { ...shape, state: "pushed" as const })).toMatchObject({ ok: false });
  });

  test("the body is reproducible from rows alone, and quotes the agent inertly", () => {
    intendIt();
    const publication = store.publicationForRun(runId)!;

    const body = publicationBody(store, publication);
    expect(body).toContain("wire the payout guard");
    expect(body).toContain("abc123def");
    expect(body).toContain("base999");
    // The agent's words are inside a fence — never bare markdown semantics.
    // Indented, not fenced (audit IV-9): no agent text can terminate indentation.
    expect(body).toContain("    Added the guard. Fixes #1 should stay prose.");
    expect(body).not.toContain("```");

    expect(publicationBody(store, publication)).toBe(body);
    expect(bodyHashOf(body)).toBe(bodyHashOf(publicationBody(store, publication)));
  });

  test("push names the exact SHA, then the PR opens — each phase durable", async () => {
    grantIt();
    intendIt();

    // First pass crashes conceptually after the push: script the PR listing
    // to fail so the row stays 'pushed'.
    const first = scripted({ "gh pr": { code: 1, stderr: "network is down" } });
    const one = await publishPass(store, { repo: REPO, clock: () => T0, exec: first.exec });

    expect(one.pushed).toBe(1);
    expect(first.calls[0]).toMatchObject({
      file: "git",
      args: ["push", "origin", "abc123def:refs/heads/standing-orders/t-1"],
    });
    expect(store.publicationForRun(runId)?.state).toBe("pushed");

    // The next pass resumes exactly where the last stopped: no second push.
    const second = scripted({
      "gh pr": { code: 0, stdout: "[]" },
    });
    // pr create answers with the URL on stdout.
    const answers: Record<string, { code?: number; stdout?: string }> = {
      "gh pr list": { code: 0, stdout: "[]" },
      "gh pr create": { code: 0, stdout: "https://github.com/alex/thing/pull/7\n" },
    };
    const resumed = scripted(answers);
    const two = await publishPass(store, { repo: REPO, clock: () => T0, exec: resumed.exec });
    void second;

    expect(two.opened).toBe(1);
    expect(resumed.calls.some(call => call.file === "git")).toBe(false);
    const created = resumed.calls.find(call => call.args[1] === "create");
    expect(created?.args).toContain("--draft");
    expect(created?.args).toContain("--body-file");
    expect(created?.args).not.toContain("--body");

    const done = store.publicationForRun(runId);
    expect(done).toMatchObject({ state: "opened", prNumber: 7, prUrl: "https://github.com/alex/thing/pull/7" });
    // The morning hears about it.
    expect(store.listNotifications("pending").some(one_ => one_.kind === "publication-opened")).toBe(true);
  });

  test("v102: a branch that changed protected files on a one-person approval isn't pushed until someone else marks it complete", async () => {
    const root = mkdtempSync(join(tmpdir(), "so-publish-held-"));
    try {
      const alex = addApprover(store, "alex", T0);
      if (!alex.ok) throw new Error("alex");
      expect(addApprover(store, "sam", T0, { name: "alex", token: alex.token }).ok).toBe(true);
      store.placeTask(taskRef, REPO, {}, T0);
      store.setApprovalRules(REPO, { notRequester: false, protectProject: false, protectedPaths: ["infra/**"] }, "alex", T0);
      storeEvidence(store, root, runId, "diff-stat", "terminal-diff-stat.json", Buffer.from(JSON.stringify({ filesTruncated: false, files: [{ path: "infra/main.tf", added: 1, deleted: 0 }] })), "git diff --numstat", T0, { captureStatus: "ok" });
      grantIt();
      intendIt();
      const held = scripted();
      const one = await publishPass(store, { repo: REPO, clock: () => T0, exec: held.exec, evidenceRoot: root });
      expect(one.pushed).toBe(0);
      expect(held.calls).toEqual([]);
      expect(one.problems[0]).toContain("held: it changed protected files");
      // Approval policy §1.7a: a completion sam's lead or API token made, or one from before completions said who made
      // them, is not a second person; it stays held.
      for (const detail of ["proof machine", null]) {
        store.recordAction({ at: T0.toISOString(), actor: "operator:sam", repo: REPO, taskId: "t-1", runId, action: "assignment handoff checked", outcome: "x".repeat(64), source: "work", detail });
        const still = await publishPass(store, { repo: REPO, clock: () => T0, exec: held.exec, evidenceRoot: root });
        expect(still.pushed, String(detail)).toBe(0);
      }
      // sam (not its approver or requester) marks the result complete as a person: the push goes.
      store.recordAction({ at: T0.toISOString(), actor: "operator:sam", repo: REPO, taskId: "t-1", runId, action: "assignment handoff checked", outcome: "x".repeat(64), source: "work", detail: "proof person" });
      const two = await publishPass(store, { repo: REPO, clock: () => T0, exec: scripted({ "gh pr list": { code: 0, stdout: "[]" }, "gh pr create": { code: 0, stdout: "https://github.com/alex/thing/pull/8\n" } }).exec, evidenceRoot: root });
      expect(two.pushed).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an added real key blocks publication and alerts once per head; a removed line or placeholder does not", async () => {
    const root = mkdtempSync(join(tmpdir(), "so-publish-secret-"));
    try {
      // Key-shaped values are assembled here, never written out whole.
      const real = ["AKIA", "Q7ZC4M2XWB9KT3LP"].join("");
      const docs = ["AKIA", "IOSFODNN7", "EXAMPLE"].join("");
      const patchWith = (lines: string[]) => ["diff --git a/src/pay.ts b/src/pay.ts", "--- a/src/pay.ts", "+++ b/src/pay.ts", "@@ -3,2 +3,2 @@", " const a = 1;", ...lines, ""].join("\n");
      const git = (patch: string) => async (_file: string, args: readonly string[]) => ({ ...OK, stdout: args.includes("--numstat") ? "1\t1\tsrc/pay.ts\0" : patch });
      const alerts = () => store.listNotifications("all").filter(one => one.kind === "secret-detected");

      // A stale base's removed key and a documented example: nothing to flag.
      await captureTerminalDiff(store, git(patchWith([`-const old = "${real}";`, `+const docs = "${docs}";`])), "/pool/t-1", "base999", "abc123def", root, runId, T0);
      expect(store.hasRedactedTerminalDiff(runId)).toBe(false);
      expect(alerts()).toEqual([]);

      // A later run on the same candidate head adds a real key.
      const later = store.startRun({ taskRef, leaseId: "lease-2", runner: "builder-1", branch: "standing-orders/t-1", worktree: "/pool/t-1", ...bareLegacy("build", "claude", null), now: T0 });
      const added = patchWith([`-const key = process.env.KEY;`, `+const key = "${real}";`]);
      const { diffId } = await captureTerminalDiff(store, git(added), "/pool/t-1", "base999", "abc123def", root, later, T0);
      const artifact = store.getArtifact(diffId)!;
      expect(artifact.redacted).toBe(true);
      expect(readFileSync(join(root, artifact.key), "utf8")).not.toContain(real);
      expect(alerts()).toHaveLength(1);
      expect(alerts()[0]!.body).toContain("src/pay.ts:4 (aws-access-key)");
      expect(alerts()[0]!.body).toContain("rotate it and rewrite the branch");
      // Gated again over the same head: no second alert.
      const again = store.startRun({ taskRef, leaseId: "lease-3", runner: "builder-1", branch: "standing-orders/t-1", worktree: "/pool/t-1", ...bareLegacy("build", "claude", null), now: T0 });
      await captureTerminalDiff(store, git(added), "/pool/t-1", "base999", "abc123def", root, again, T0);
      expect(alerts()).toHaveLength(1);

      grantIt();
      store.createPublicationIntent({ run: later, taskRef, githubRepo: "alex/thing", remote: "origin", base: "main", head: "standing-orders/t-1", headSha: "abc123def", bodyHash: "x", draft: true }, T0);
      const script = scripted();
      const report = await publishPass(store, { repo: REPO, clock: () => T0, exec: script.exec, evidenceRoot: root });
      expect(report.pushed).toBe(0);
      expect(script.calls).toEqual([]);
      expect(store.publicationForRun(later)?.state).toBe("failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an existing PR on the head is adopted, never twinned", async () => {
    grantIt();
    intendIt();
    store.markPublicationPushed(store.publicationForRun(runId)!.id, T0);

    const script = scripted({
      "gh pr list": { code: 0, stdout: JSON.stringify([{ number: 4, url: "https://github.com/alex/thing/pull/4" }]) },
    });
    const report = await publishPass(store, { repo: REPO, clock: () => T0, exec: script.exec });

    expect(report.adopted).toBe(1);
    expect(script.calls.some(call => call.args[1] === "create")).toBe(false);
    expect(store.publicationForRun(runId)).toMatchObject({ state: "opened", prNumber: 4 });
  });

  test("a revoked grant stops the morning's pushes, immediately", async () => {
    grantIt();
    intendIt();
    store.revokePublicationGrant(REPO, "alex", T0);

    const script = scripted();
    const report = await publishPass(store, { repo: REPO, clock: () => T0, exec: script.exec });

    expect(script.calls).toHaveLength(0);
    expect(report.problems[0]).toContain("no live publication grant");
    expect(store.publicationForRun(runId)?.state).toBe("intended");
  });

  test("retries end in a durable failure that pages a person, and the commit stays safe", async () => {
    grantIt();
    intendIt();

    const script = scripted({ git: { code: 1, stderr: "remote: permission denied" } });
    for (let attempt = 0; attempt < MAX_PUBLISH_ATTEMPTS; attempt++) {
      await publishPass(store, { repo: REPO, clock: () => T0, exec: script.exec });
    }

    const failed = store.publicationForRun(runId);
    expect(failed?.state).toBe("failed");
    expect(failed?.lastError).toContain("permission denied");
    const page = store.listNotifications("pending").find(one => one.kind === "publication-failed");
    expect(page?.body).toContain("abc123def");

    // And a later pass owes nothing — failed is terminal, not a loop.
    const idle = scripted();
    await publishPass(store, { repo: REPO, clock: () => T0, exec: idle.exec });
    expect(idle.calls).toHaveLength(0);
  });
});

describe("watching CI on opened PRs", () => {
  let store: Store;
  let taskRef: number;
  let runId: number;

  const opened = () => {
    const id = store.createPublicationIntent(
      {
        run: runId,
        taskRef,
        githubRepo: "alex/thing",
        remote: "origin",
        base: "main",
        head: "standing-orders/t-1",
        headSha: "abc123",
        bodyHash: "x",
        draft: true,
      },
      T0,
    );
    store.markPublicationPushed(id, T0);
    store.markPublicationOpened(id, 9, "https://github.com/alex/thing/pull/9", T0);
    return id;
  };

  const ghSaying = (payload: unknown) =>
    scripted({ "gh pr": { code: 0, stdout: JSON.stringify(payload) } });

  const ciRows = () =>
    store
      .listNotifications("all")
      .filter(one => one.dedupeKey.startsWith("ci:"))
      .map(one => ({ key: one.dedupeKey, resolved: one.resolvedAt !== null }));

  beforeEach(() => {
    store = openStore(":memory:");
    store.createTask({ id: "t-1", title: "the work" }, T0);
    taskRef = store.refFor("built-in", "t-1").id;
    runId = store.startRun({
      taskRef,
      leaseId: "lease-1",
      runner: "builder-1",
      branch: "standing-orders/t-1",
      worktree: "/pool/t-1",
      ...bareLegacy("build", "claude", null), now: T0,
    });
    opened();
  });

  afterEach(() => store.close());

  test("a red head pages once, keyed by PR and exact commit", async () => {
    const red = ghSaying({ headRefOid: "oid-1", statusCheckRollup: [{ conclusion: "FAILURE" }] });

    await observeChecks(store, { clock: () => T0, exec: red.exec });
    await observeChecks(store, { clock: () => T0, exec: red.exec });

    expect(ciRows()).toEqual([{ key: "ci:alex/thing:9:oid-1", resolved: false }]);
    const page = store.listNotifications("pending").find(one => one.kind === "ci-failing");
    expect(page?.subject).toContain("t-1");
    expect(page?.body).toContain("oid-1");
  });

  test("the same head turning green resolves the episode; a new head buries the old one", async () => {
    await observeChecks(store, {
      clock: () => T0,
      exec: ghSaying({ headRefOid: "oid-1", statusCheckRollup: [{ conclusion: "FAILURE" }] }).exec,
    });

    // Someone pushed a fix: the failing commit is gone, its page resolves
    // even though the new head is still running — running is not green.
    await observeChecks(store, {
      clock: () => T0,
      exec: ghSaying({ headRefOid: "oid-2", statusCheckRollup: [{ status: "IN_PROGRESS" }] }).exec,
    });
    expect(ciRows()).toEqual([{ key: "ci:alex/thing:9:oid-1", resolved: true }]);

    // The new head fails too: a fresh page, its own key.
    await observeChecks(store, {
      clock: () => T0,
      exec: ghSaying({ headRefOid: "oid-2", statusCheckRollup: [{ conclusion: "FAILURE" }] }).exec,
    });
    expect(ciRows()).toEqual([
      { key: "ci:alex/thing:9:oid-1", resolved: true },
      { key: "ci:alex/thing:9:oid-2", resolved: false },
    ]);

    // And green closes it.
    await observeChecks(store, {
      clock: () => T0,
      exec: ghSaying({ headRefOid: "oid-2", statusCheckRollup: [{ conclusion: "SUCCESS" }] }).exec,
    });
    expect(ciRows().every(row => row.resolved)).toBe(true);
  });

  test("a rollup that could not be read neither pages nor resolves — and says so", async () => {
    await observeChecks(store, {
      clock: () => T0,
      exec: ghSaying({ headRefOid: "oid-1", statusCheckRollup: [{ conclusion: "FAILURE" }] }).exec,
    });

    const dead = scripted({ "gh pr": { code: 1, stderr: "api.github.com refused" } });
    const report = await observeChecks(store, { clock: () => T0, exec: dead.exec });

    expect(report.problems[0]).toContain("not read");
    expect(ciRows()).toEqual([{ key: "ci:alex/thing:9:oid-1", resolved: false }]);
  });
});
