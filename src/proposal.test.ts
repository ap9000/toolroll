import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { fileTaskProposal, fileRoutineProposal, shouldPlanTask, validateTaskText } from "./proposal.js";
import { termsOf, routineDigestOf } from "./routine.js";

const T0 = new Date("2026-08-14T12:00:00.000Z");

describe("the one filing door", () => {
  let store: Store;
  let repo: string;

  beforeEach(() => {
    store = openStore(":memory:");
    repo = realpathSync(mkdtempSync(join(tmpdir(), "proposal-repo-")));
  });

  afterEach(() => {
    store.close();
    rmSync(repo, { recursive: true, force: true });
  });

  test("new filing cannot select legacy inheritance through provenance or extra fields", () => {
    const acceptance = [{ id: "c1", statement: "Works", evidence: ["check"] }];
    for (const field of ["goal", "outOfScope"]) {
      for (const value of ["a".repeat(8001), "😀".repeat(4001), "界".repeat(10700), "bad\u0000", "bad\u202e"]) {
        const spec = { title: "New task", goal: "valid", acceptance, [field]: value,
          filedVia: "revision", inheritLegacy: true, legacy: true, revisionOf: "source", source: { task: "source" } };
        expect(fileTaskProposal(store, spec, T0)).toMatchObject({ ok: false, reason: "bad-goal" });
        expect(store.createConsoleTask(spec, T0)).toMatchObject({ ok: false, reason: "bad-goal" });
      }
    }
    expect(store.listTasks()).toHaveLength(0);
  });

  test("files an unapproved task with provenance stamped", () => {
    const made = fileTaskProposal(
      store,
      { title: "tighten the payout guard", repo, goal: "add the missing bounds check", acceptance: [{ id: "c1", statement: "The bounds check is added.", evidence: ["check"] }], filedVia: "console" },
      T0,
    );
    if (!made.ok) throw new Error(made.reason);
    const scope = store.getScope(made.id);
    expect(scope?.approvedAt).toBeNull();
    expect(scope?.approvedBy).toBeNull();
    expect(scope?.approvedDigest).toBeNull();
    expect(store.filedViaOf(made.id)).toBe("console");
  });

  test("plans substantial implementation work by default, with explicit required and skip controls", () => {
    expect(shouldPlanTask({ title: "Rework sidebar navigation", repo, filedVia: "chat:claude" })).toBe(true);
    expect(shouldPlanTask({ title: "Fix typo", repo, filedVia: "console" })).toBe(false);
    expect(shouldPlanTask({ title: "Fix typo", repo, filedVia: "console", planning: "required" })).toBe(true);
    expect(shouldPlanTask({ title: "Rework sidebar navigation", repo, filedVia: "console", planning: "skip" })).toBe(false);
    expect(shouldPlanTask({ title: "Investigate navigation", repo, filedVia: "console", deliverable: "report", planning: "required" })).toBe(false);
    expect(shouldPlanTask({ title: "Rework sidebar navigation", repo, filedVia: "mcp:linear" })).toBe(false);
    expect(shouldPlanTask({ title: "Rework sidebar navigation", repo, filedVia: "console", proposedVia: "coordinator" })).toBe(false);

    const made = fileTaskProposal(
      store,
      { title: "Unify project workflow end to end", repo, filedVia: "chat:claude" },
      T0,
    );
    if (!made.ok) throw new Error(made.reason);
    expect(made.planning).toBe(true);
    expect(store.lookupRef(made.id)?.plan).toBe("requested");
  });

  test("provenance is set-once — a stamped row never changes", () => {
    const made = fileTaskProposal(store, { title: "one", filedVia: "intake" }, T0);
    if (!made.ok) throw new Error(made.reason);
    const ref = store.lookupRef(made.id);
    if (ref === null) throw new Error("no ref");
    store.stampFiledVia(ref.id, "cli");
    expect(store.filedViaOf(made.id)).toBe("intake");
  });

  test("disguised text in a title is refused, not laundered", () => {
    const bidi = fileTaskProposal(store, { title: "fix ‮gnihtemos", filedVia: "cli" }, T0);
    expect(bidi).toMatchObject({ ok: false, reason: "bad-title" });
    const invisible = fileTaskProposal(store, { title: "fix‎ it", filedVia: "cli" }, T0);
    expect(invisible).toMatchObject({ ok: false, reason: "bad-title" });
  });

  test("provenance tokens are audit text, not free text", () => {
    expect(fileTaskProposal(store, { title: "x", filedVia: "Console!" }, T0)).toMatchObject({
      ok: false,
      reason: "bad-provenance",
    });
  });

  test("a ceiling refuses repos outside it — and an EMPTY ceiling refuses every repo", () => {
    const outside = fileTaskProposal(
      store,
      { title: "x", repo, filedVia: "console", admittedRepos: ["/somewhere/else"] },
      T0,
    );
    expect(outside).toMatchObject({ ok: false, reason: "outside-ceiling" });
    const empty = fileTaskProposal(store, { title: "x", repo, filedVia: "console", admittedRepos: [] }, T0);
    expect(empty).toMatchObject({ ok: false, reason: "outside-ceiling" });
    // No ceiling at all (the CLI) admits it.
    const cli = fileTaskProposal(store, { title: "x", repo, filedVia: "cli" }, T0);
    expect(cli).toMatchObject({ ok: true });
  });

  test("an OMITTED repo under a ceiling refuses — repo-less filing must not bypass the bound", () => {
    const omitted = fileTaskProposal(
      store,
      { title: "x", filedVia: "console", admittedRepos: [repo] },
      T0,
    );
    expect(omitted).toMatchObject({ ok: false, reason: "outside-ceiling" });
    const emptyString = fileTaskProposal(
      store,
      { title: "x", repo: "", filedVia: "console", admittedRepos: [repo] },
      T0,
    );
    expect(emptyString).toMatchObject({ ok: false, reason: "outside-ceiling" });
    // Without a ceiling, repo-less filing stays the CLI's honest "no repo yet".
    const unbounded = fileTaskProposal(store, { title: "x", filedVia: "cli" }, T0);
    expect(unbounded).toMatchObject({ ok: true });
  });

  test("a repo that does not exist still normalizes — filing never depends on this machine seeing it", () => {
    const made = fileTaskProposal(store, { title: "x", repo: join(repo, "not-yet-cloned"), filedVia: "cli" }, T0);
    expect(made).toMatchObject({ ok: true });
  });

  test("touches obey the same bounds everywhere", () => {
    expect(
      fileTaskProposal(store, { title: "x", touches: ["ok", ""], filedVia: "cli" }, T0),
    ).toMatchObject({ ok: false, reason: "bad-goal" });
    expect(validateTaskText({ title: "x", touches: Array.from({ length: 51 }, (_, i) => `p${i}`) })).not.toBeNull();
  });

  test("files an unapproved routine, digest computed inside the door", () => {
    const made = fileRoutineProposal(
      store,
      {
        name: "nightly-deps",
        repo,
        goal: "refresh the lockfile and note anything major",
        outOfScope: null,
        touches: [],
        acceptance: [{ id: "c1", statement: "The lockfile is refreshed and anything major is noted.", evidence: ["check"] }],
        requirements: [],
        schedule: "daily:03:30",
        costCeilingUsd: null,
        filedVia: "template:nightly-deps",
      },
      T0,
    );
    if (!made.ok) throw new Error(made.reason);
    const routine = store.getRoutine(made.id);
    if (routine === null) throw new Error("no routine");
    expect(routine.approvedAt).toBeNull();
    expect(routine.filedVia).toBe("template:nightly-deps");
    // The digest the door computed is exactly the digest of the stored terms.
    expect(routine.digest).toBe(routineDigestOf(termsOf(routine)));
  });

  test("a routine's schedule and name are validated in the door", () => {
    const base = {
      repo,
      goal: "g",
      outOfScope: null,
      touches: [],
      requirements: [],
      costCeilingUsd: null,
      filedVia: "cli",
    };
    expect(
      fileRoutineProposal(store, { ...base, name: "Bad Name", schedule: "daily:03:30" }, T0),
    ).toMatchObject({ ok: false, reason: "bad-name" });
    expect(
      fileRoutineProposal(store, { ...base, name: "ok-name", schedule: "sometimes" }, T0),
    ).toMatchObject({ ok: false, reason: "bad-terms" });
  });

  test("a routine outside the caller's ceiling is refused", () => {
    expect(
      fileRoutineProposal(
        store,
        {
          name: "sneaky",
          repo,
          goal: "g",
          outOfScope: null,
          touches: [],
          requirements: [],
          schedule: "every:60",
          costCeilingUsd: null,
          filedVia: "console",
          admittedRepos: [],
        },
        T0,
      ),
    ).toMatchObject({ ok: false, reason: "outside-ceiling" });
  });
});

describe("installation facts", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
  });

  afterEach(() => store.close());

  test("set-once: the first write wins forever", () => {
    expect(store.installationFact("demo")).toBeNull();
    expect(store.isDemo()).toBe(false);
    store.recordInstallationFact("demo", "1", T0);
    expect(store.isDemo()).toBe(true);
    store.recordInstallationFact("demo", "0", new Date("2027-01-01T00:00:00.000Z"));
    expect(store.installationFact("demo")).toBe("1");
  });
});
