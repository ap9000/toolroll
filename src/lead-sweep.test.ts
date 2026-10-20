/**
 * Lead fan-out (docs/plans/lead-fan-out.md): one sweep card files N ordinary tasks under one shared brief and approves
 * each one's scope with one ceremony — all filed or none; a child the approval refuses stays filed and unapproved.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { verifyApproverStanding, type VerifiedApprover } from "./principal.js";
import { fileTaskProposal } from "./proposal.js";
import { prepareSharedAction, mintSharedActionReview, type ChatAction } from "./chat-actions.js";
import { confirmLeadProposal } from "./lead-doors.js";

describe("lead sweeps", () => {
  let root: string,
    repo: string,
    db: string,
    store: Store,
    who: VerifiedApprover,
    password: string,
    thread: number,
    session: number;
  const now = new Date("2026-09-17T12:00:00Z");
  let serial = 0;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "shared-chat-")));
    repo = join(root, "repo");
    db = join(root, "state.db");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, "README.md"), "Action tests\n");
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", [
      "-C",
      repo,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@localhost",
      "commit",
      "-qm",
      "seed",
    ]);
    store = openStore(db);
    const account = addApprover(store, "operator", now);
    if (!account.ok) throw Error("account");
    password = account.token;
    for (const phase of ["plan", "build", "review"] as const)
      store.setPhaseConfig(
        "installation",
        phase,
        "claude",
        "sonnet",
        "fixture",
        now,
      );
    const verified = verifyApproverStanding(
      store,
      "operator",
      store.accountOf("operator")!.generation,
      [repo],
    );
    if (!verified.ok) throw Error("identity");
    who = verified.who;
    session = store.mintLeadSession(
      {
        approver: who.name,
        approverGeneration: who.generation,
        credentialKey: "shared-fixture",
        ceilingMicrousd: 10000000,
        ceilingDigest: who.ceilingDigest,
        termsDigest: "fixture",
      },
      now,
    );
    thread = store.openLeadThread(who.name, who.ceilingDigest, now).thread.id;
  });
  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  void fileTaskProposal;
  function task() {
    const id = `action-${++serial}`;
    const made = fileTaskProposal(
      store,
      {
        id,
        title: "Make acceptance clearer",
        repo,
        filedVia: "cli",
        planning: "skip",
      },
      now,
    );
    if (!made.ok) throw Error(made.message);
    return id;
  }
  function proposal(operation: ChatAction, input: Record<string, unknown>) {
    const payload = prepareSharedAction(
      store,
      who,
      operation,
      input,
      root,
      now,
    );
    const turn = store.openLeadTurn(
      {
        approver: who.name,
        session,
        thread,
        credentialKey: "shared-fixture",
        reservedMicrousd: 0,
        dailyTurns: 100,
        weeklyCeilingMicrousd: 10000000,
        deadlineMs: 60000,
      },
      now,
    );
    if (!turn.ok) throw Error(turn.reason);
    const started = store.startLeadTurn(turn.id, now);
    if (!started.ok) throw Error("start");
    const id = store.draftLeadProposal(
      {
        thread,
        turn: turn.id,
        kind: "action",
        payload: { ...payload },
        ceilingDigest: who.ceilingDigest,
      },
      now,
    );
    store.finalizeLeadTurn(
      turn.id,
      started.generation,
      {
        state: "answered",
        settledMicrousd: 0,
        tokensIn: 0,
        tokensOut: 0,
        message: { text: "Review the proposed action.", activity: "" },
      },
      now,
    );
    return id;
  }
  function confirm(id: number, secure = false, credential = password) {
    const review = secure
      ? mintSharedActionReview(store, who, id, root, now)
      : null;
    return confirmLeadProposal(store, who, id, now, {
      via: secure ? "web" : "telegram",
      evidenceRoot: root,
      ...(review
        ? {
            confirm: true,
            actionReview: { nonce: review.nonce, password: credential },
          }
        : {}),
    });
  }
  const ITEMS = [{ title: "Router timeout", item: "The router times out after 30 seconds." }, { title: "Cache TTL", item: "Opus gets the 5-minute cache." }, { title: "Zero usage", item: "Tokens read 0 with a third-party model." }];
  const ACCEPTANCE = [{ id: "c1", statement: "Fixed with proof, or shown not reproducible.", evidence: ["check"] }];
  const sweepCard = (over: Record<string, unknown> = {}) => proposal("sweep_file", { repo, title: "Discord bug sweep", brief: "Reproduce first; not reproducible is a valid result.", items: ITEMS, acceptance: ACCEPTANCE, maxParallel: 2, ...over });

  test("one card shows every item and the shared rules; a tap alone does nothing; the password files and approves all", () => {
    const id = sweepCard();
    const saved = store.getLeadProposal(id)!.payload as { title: string; terms: string[] };
    expect(saved.title).toContain("Discord bug sweep");
    expect(saved.terms.join("\n")).toContain("Item 2 — Cache TTL: Opus gets the 5-minute cache.");
    expect(saved.terms.join("\n")).toContain("at most 2 running at once");
    expect(confirm(id)).toMatchObject({ ok: false, reason: "needs-confirm" });
    expect(store.sweepOfProposal(id)).toBeNull();
    const done = confirm(id, true);
    expect(done).toMatchObject({ ok: true });
    const sweep = store.sweepOfProposal(id)!;
    expect(store.getSweep(sweep)).toMatchObject({ title: "Discord bug sweep", maxParallel: 2, repo });
    const children = store.sweepTasks(sweep);
    expect(children.map(one => one.label)).toEqual(ITEMS.map(one => one.title));
    for (const child of children) {
      expect(store.getScope(child.rootTask)?.goal).toContain("This item:");
      expect(store.scopeSealed(child.rootTask)).toBe(true);
      expect(store.sweepOfTask(child.rootTask)?.id).toBe(sweep);
    }
  });

  test("all or none: a child that can't be filed files nothing", () => {
    const id = sweepCard({ acceptance: [{ id: "", statement: "", evidence: [] }] });
    expect(confirm(id, true)).toMatchObject({ ok: false });
    expect(store.sweepOfProposal(id)).toBeNull();
    expect(Number(store.handle.prepare("SELECT COUNT(*) AS n FROM task").get()!["n"])).toBe(0);
  });

  test("a project that keeps work from its requester: every child is filed and waits for its own approval", () => {
    store.setApprovalRules(repo, { notRequester: true, protectProject: false, protectedPaths: [] }, "operator", now);
    const done = confirm(sweepCard(), true);
    expect(done).toMatchObject({ ok: true });
    expect((done as { said: string }).said).toMatch(/0 of 3 approved; 3 wait for their own approval/);
    const sweep = Number(store.handle.prepare("SELECT id FROM lead_sweep ORDER BY id DESC LIMIT 1").get()!["id"]);
    for (const child of store.sweepTasks(sweep)) expect(store.scopeSealed(child.rootTask)).toBe(false);
  });

  test("a sweep is 2 to 20 items, and 1 to 8 at once", () => {
    expect(() => prepareSharedAction(store, who, "sweep_file", { repo, title: "t", brief: "b", items: [ITEMS[0]], acceptance: ACCEPTANCE, maxParallel: 2 }, root, now)).toThrow(/items|2 to 20/);
    expect(() => prepareSharedAction(store, who, "sweep_file", { repo, title: "t", brief: "b", items: ITEMS, acceptance: ACCEPTANCE, maxParallel: 9 }, root, now)).toThrow(/maxParallel|1 to 8/);
  });
});
