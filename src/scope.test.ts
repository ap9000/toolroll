import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { openStore, type Store } from "./store.js";
import { propose, approve, addApprover, approvalOf, authenticateApprover, digestOf, describeScope, profileDigestOf, profileFromJson, canonicalProfileJson, chainDigestOf, chainFromJson, canonicalChainJson, scopeAuthorityOf, MAX_TIMER_SECONDS } from "./scope.js";
import { routeDigestOf, routeFromJson } from "./phase-routing.js";
import { proveApprovedProfile } from "./builder.js";
import { register } from "./runner.js";
import { acquire } from "./claim.js";
import { invokeAgent } from "./invoke.js";
import { routeOfTask } from "./agentconfig.js";
import { readAuthModeStrict } from "./keys.js";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const T0 = new Date("2026-08-11T22:00:00.000Z");

/** The first approver bootstraps; every later one needs an existing one. */
function bootstrapApprover(store: Store): string {
  const added = addApprover(store, "alex", T0);
  if (!added.ok) throw new Error("bootstrap should never be refused");
  return added.token;
}
const later = (ms: number) => new Date(T0.getTime() + ms);

describe("agreeing what a task is allowed to become", () => {
  let store: Store;
  let approverToken: string;

  beforeEach(() => {
    store = openStore(":memory:");
    // v24: approvals bind exact routing, so the install names its default
    // model once — the same act `config set build --model sonnet` performs.
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", T0); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", T0);
    approverToken = bootstrapApprover(store);
    store.createTask({ id: "t-1", title: "fix the payouts flow" }, T0);
  });

  afterEach(() => store.close());

  const scopeIt = (goal = "add a guard on the payout path") =>
    propose(store, { taskId: "t-1", goal, now: T0 });

  test("a fresh scope is not approved", () => {
    // Writing down what you intend is not the same as somebody agreeing to it.
    expect(approvalOf(scopeIt())).toEqual({ approved: false, reason: "none" });
  });

  test("a task with no scope at all is not approved either", () => {
    expect(approvalOf(null)).toEqual({ approved: false, reason: "never-proposed" });
  });

  test("a person can agree to it", () => {
    scopeIt();

    const approved = approve(store, "t-1", "alex", later(1_000), store.getScope("t-1")!.digest, approverToken);

    expect(approved.ok).toBe(true);
    if (approved.ok) expect(approvalOf(approved.scope)).toMatchObject({ approved: true, by: "alex" });
  });

  test("rewriting the scope takes the approval away", () => {
    // The loophole this closes: an agent that could edit its own brief after
    // approval would have approval for whatever it wrote next.
    scopeIt();
    approve(store, "t-1", "alex", later(1_000), store.getScope("t-1")!.digest, approverToken);

    propose(store, { taskId: "t-1", goal: "rewrite the billing model", now: later(2_000) });

    expect(approvalOf(store.getScope("t-1"))).toEqual({ approved: false, reason: "changed" });
  });

  test("says it was approved before, rather than never", () => {
    // A more useful refusal: somebody did agree to something, and the thing
    // changed. "Never approved" would send them looking for the wrong problem.
    scopeIt();
    approve(store, "t-1", "alex", later(1_000), store.getScope("t-1")!.digest, approverToken);
    propose(store, { taskId: "t-1", goal: "something else", now: later(2_000) });

    expect(describeScope(store.getScope("t-1")!).join("\n")).toContain("then the scope was rewritten");
  });

  test("re-approving the rewritten scope restores it", () => {
    scopeIt();
    approve(store, "t-1", "alex", later(1_000), store.getScope("t-1")!.digest, approverToken);
    propose(store, { taskId: "t-1", goal: "something else", now: later(2_000) });

    approve(store, "t-1", "alex", later(3_000), store.getScope("t-1")!.digest, approverToken);

    expect(approvalOf(store.getScope("t-1")).approved).toBe(true);
  });

  test("refuses to approve a scope that moved while it was being read", () => {
    // The operator passes back the reference they were shown, so agreeing to
    // a scope that changed underneath them fails instead of approving the new
    // one silently.
    const first = scopeIt();
    propose(store, { taskId: "t-1", goal: "something else", now: later(1_000) });

    expect(approve(store, "t-1", "alex", later(2_000), first.digest, approverToken)).toEqual({
      ok: false,
      reason: "changed",
    });
  });

  test("approves when the reference still matches", () => {
    const scope = scopeIt();

    expect(approve(store, "t-1", "alex", later(1_000), scope.digest, approverToken).ok).toBe(true);
  });

  test("will not approve a task that has no scope", () => {
    expect(approve(store, "t-1", "alex", T0, "anything", approverToken)).toEqual({ ok: false, reason: "no-scope" });
  });

  describe("the digest", () => {
    test("changes when the goal changes", () => {
      const a = digestOf({ goal: "a", outOfScope: null, touches: [] });
      const b = digestOf({ goal: "b", outOfScope: null, touches: [] });

      expect(a).not.toBe(b);
    });

    test("changes when what is out of scope changes", () => {
      // This is the field most likely to be quietly widened, so it must move
      // the digest as surely as the goal does.
      const a = digestOf({ goal: "a", outOfScope: "not the billing model", touches: [] });
      const b = digestOf({ goal: "a", outOfScope: null, touches: [] });

      expect(a).not.toBe(b);
    });

    test("changes when the paths it may touch change", () => {
      const a = digestOf({ goal: "a", outOfScope: null, touches: ["src/pay.ts"] });
      const b = digestOf({ goal: "a", outOfScope: null, touches: ["src/pay.ts", "src/bill.ts"] });

      expect(a).not.toBe(b);
    });

    test("does not change for a reordering or stray whitespace", () => {
      // Otherwise an approval would evaporate over a formatting difference,
      // and operators would learn to re-approve without reading.
      const a = digestOf({ goal: "a", outOfScope: null, touches: ["b", "a"] });
      const b = digestOf({ goal: " a ", outOfScope: null, touches: ["a", "b"] });

      expect(a).toBe(b);
    });
  });
});

describe("who is allowed to say yes", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:");
    // v24: approvals bind exact routing, so the install names its default
    // model once — the same act `config set build --model sonnet` performs.
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", T0); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", T0);
    store.createTask({ id: "t-1", title: "the work" }, T0);
    propose(store, { taskId: "t-1", goal: "a guard", now: T0 });
  });

  afterEach(() => store.close());

  const digest = () => store.getScope("t-1")!.digest;

  test("nothing can be approved until somebody is allowed to approve", () => {
    // Fails closed. Treating "no approvers registered" as "approval is not
    // required here" would make the whole gate optional, which is the same as
    // not having one.
    expect(approve(store, "t-1", "alex", T0, digest(), "any")).toEqual({
      ok: false,
      reason: "no-approvers",
    });
  });

  test("an approver with the right token can", () => {
    const token = bootstrapApprover(store);

    expect(approve(store, "t-1", "alex", T0, digest(), token).ok).toBe(true);
  });

  test("the first approver bootstraps, and no later one does", () => {
    // Somebody has to be able to create the first, and there is nobody to ask
    // yet. After that the credential would be worth nothing if an agent could
    // simply mint one for itself.
    const first = addApprover(store, "alex", T0);
    expect(first).toMatchObject({ ok: true, bootstrap: true });

    expect(addApprover(store, "an-agent", T0)).toEqual({ ok: false, reason: "not-an-approver" });
    expect(addApprover(store, "an-agent", T0, { name: "alex", token: "guessed" })).toEqual({
      ok: false,
      reason: "not-an-approver",
    });
  });

  test("an existing approver can vouch for another", () => {
    const first = addApprover(store, "alex", T0);
    if (!first.ok) throw new Error("bootstrap failed");

    const second = addApprover(store, "sam", T0, { name: "alex", token: first.token });

    expect(second).toMatchObject({ ok: true, bootstrap: false });
  });

  test("knowing the digest is not enough", () => {
    // This is the gate's real threat: an agent that can run these commands can
    // read the digest straight out of `task show`. What it cannot do is hold a
    // credential nobody gave it.
    bootstrapApprover(store);

    expect(approve(store, "t-1", "alex", T0, digest(), "guessed")).toEqual({
      ok: false,
      reason: "not-an-approver",
    });
  });

  test("being a runner is not being an approver", () => {
    // A credential that could both take work and approve it would collapse the
    // separation this exists for.
    bootstrapApprover(store);

    expect(approve(store, "t-1", "builder-1", T0, digest(), "anything")).toEqual({
      ok: false,
      reason: "not-an-approver",
    });
  });
});

describe("a chosen password is a first-class credential", () => {
  test("add with --password: scrypt-stored, verifies, wrong is wrong, short refused", () => {
    const store = openStore(":memory:");
    try {
      const weak = addApprover(store, "alex", T0, undefined, undefined, {}, "short");
      expect(weak).toMatchObject({ ok: false, reason: "weak-password" });

      const added = addApprover(store, "alex", T0, undefined, undefined, {}, "hunter2hunter2");
      expect(added).toMatchObject({ ok: true, chosen: true });
      // Stored salted and stretched — never the bare digest of the password.
      expect(store.approverHash("alex")).toMatch(/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/);

      expect(authenticateApprover(store, "alex", "hunter2hunter2")).toMatchObject({ ok: true });
      expect(authenticateApprover(store, "alex", "hunter2hunter3")).toMatchObject({ ok: false });
    } finally {
      store.close();
    }
  });

  test("minted tokens and chosen passwords vouch and rotate interchangeably", () => {
    const store = openStore(":memory:");
    try {
      const first = addApprover(store, "alex", T0);
      if (!first.ok) throw new Error("bootstrap failed");

      // A minted-token approver vouches in a password approver…
      const second = addApprover(
        store, "sam", T0, { name: "alex", token: first.token }, undefined, {}, "correct-horse-battery",
      );
      expect(second).toMatchObject({ ok: true, chosen: true });

      // …and the password approver's credential vouches the other way.
      const third = addApprover(store, "kim", T0, { name: "sam", token: "correct-horse-battery" });
      expect(third).toMatchObject({ ok: true, chosen: false });

      // Rotating alex to a chosen password (self-vouched) still authenticates,
      // and the old minted token dies with the rotation.
      const rotated = addApprover(
        store, "alex", T0, { name: "alex", token: first.token }, undefined, {}, "a-new-chosen-one",
      );
      expect(rotated).toMatchObject({ ok: true, chosen: true });
      expect(authenticateApprover(store, "alex", "a-new-chosen-one")).toMatchObject({ ok: true });
      expect(authenticateApprover(store, "alex", first.token)).toMatchObject({ ok: false });
    } finally {
      store.close();
    }
  });

  test("the installation default never rewrites an approval, while a task override survives later scope rewrites", () => {
    const store = openStore(":memory:");
    try {
      store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", T0);
      store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", T0); // v47: every phase names an exact model
      store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", T0);
      store.createTask({ id: "t-1", title: "the work" }, T0);
      const approverToken = bootstrapApprover(store);
      const original = propose(store, { taskId: "t-1", goal: "a guard", now: T0 });
      expect(approve(store, "t-1", "alex", T0, original.digest, approverToken)).toMatchObject({ ok: true });

      store.setPermissionDefault("bypassPermissions", "alex", later(1_000));
      const unchanged = store.getScope("t-1")!;
      expect(approvalOf(unchanged)).toMatchObject({ approved: true });
      expect(unchanged.profile).toMatchObject({ provider: "claude", permissionArgv: "auto" });

      const taskChoice = propose(store, {
        taskId: "t-1",
        goal: "a narrower guard",
        permissionMode: "auto",
        now: later(2_000),
      });
      expect(taskChoice.digest).not.toBe(original.digest);
      expect(store.refFor("built-in", "t-1").permissionMode).toBe("auto");

      // This is the planner/mate rewrite shape: it supplies new scope text but
      // no permission field. The durable task choice still wins over global.
      const rewritten = propose(store, { taskId: "t-1", goal: "the planner's guard", now: later(3_000) });
      expect(rewritten.profile).toMatchObject({ provider: "claude", permissionArgv: "auto" });
    } finally {
      store.close();
    }
  });
});

describe("execution profiles (foundations, findings 13/14/17/21)", () => {
  const claude = {
    provider: "claude" as const,
    model: "sonnet",
    permissionArgv: "acceptEdits" as const,
    maxTurns: 40,
    repairMaxTurns: 4,
    timeoutSeconds: 1800,
    repairTimeoutSeconds: 300,
    repairModel: "inherit",
  };
  const codex = {
    provider: "codex" as const,
    model: "gpt-5.2-codex",
    sandboxMode: "workspace-write" as const,
    maxTurns: "unsupported" as const,
    repairMaxTurns: "unsupported" as const,
    timeoutSeconds: 1200,
    repairTimeoutSeconds: 300,
    repairModel: "inherit",
  };
  const openrouter = { ...codex, provider: "openrouter" as const, model: "anthropic/claude-sonnet" };

  test("the legacy digest is BYTE-PINNED — v24 changed nothing behind old approvals", () => {
    expect(digestOf({ goal: "a guard", outOfScope: null, touches: [] })).toBe("a24c72e6603f78291e1eea2e162b383e");
    expect(digestOf({ goal: "a guard", outOfScope: null, touches: [] }, null)).toBe("a24c72e6603f78291e1eea2e162b383e");
  });

  test("profile digests are stable golden vectors, one per variant plus inherit", () => {
    // Pinned by value: if these move, an approval's meaning moved.
    expect(profileDigestOf(claude)).toBe(profileDigestOf({ ...claude }));
    expect(profileDigestOf(codex)).not.toBe(profileDigestOf(openrouter));
    expect(profileDigestOf({ ...claude, repairModel: "haiku" })).not.toBe(profileDigestOf(claude));
    // canonical: key order cannot matter
    const shuffled = JSON.parse(JSON.stringify(claude)) as typeof claude;
    expect(profileDigestOf(shuffled)).toBe(profileDigestOf(claude));
    // and the digest joins the scope digest deterministically
    const withProfile = digestOf({ goal: "a guard", outOfScope: null, touches: [] }, claude);
    expect(withProfile).not.toBe("a24c72e6603f78291e1eea2e162b383e");
    expect(withProfile).toBe(digestOf({ goal: "a guard", outOfScope: null, touches: [] }, claude));
    // The EXACT profile-bearing golden from the fallback design review —
    // pinned so a chain change can never silently move a legacy approval.
    expect(profileDigestOf(claude)).toBe("6df214084f95a74ed2694ecc45b2f043");
    expect(withProfile).toBe("6d7cc772f312c1295df747e243a49717");
  });

  test("fallback chains (v30): a chain digest is domain-separated and a chain-of-one is a DISTINCT explicit target", () => {
    const chain = [{ profile: claude, authMode: "subscription" as const }];
    // A chain digest can never collide with the single-profile digest.
    expect(chainDigestOf(chain)).not.toBe(profileDigestOf(claude));
    // Order is authority: reordering entries moves the digest.
    const two = [{ profile: claude, authMode: "subscription" as const }, { profile: codex, authMode: "api-key" as const }];
    const reversed = [two[1]!, two[0]!];
    expect(chainDigestOf(two)).not.toBe(chainDigestOf(reversed));
    // An explicit chain-of-one is a DIFFERENT scope digest than the same
    // single profile — it is an explicit chain, not a legacy profile.
    const asChain = digestOf({ goal: "a guard", outOfScope: null, touches: [] }, { chain });
    const asProfile = digestOf({ goal: "a guard", outOfScope: null, touches: [] }, claude);
    expect(asChain).not.toBe(asProfile);
    // The no-profile golden is STILL untouched by any of this.
    expect(digestOf({ goal: "a guard", outOfScope: null, touches: [] })).toBe("a24c72e6603f78291e1eea2e162b383e");
    // auth mode is bound: same profile, different mode => different digest.
    const subMode = digestOf({ goal: "a guard", outOfScope: null, touches: [] }, { chain: [{ profile: claude, authMode: "subscription" as const }] });
    const keyMode = digestOf({ goal: "a guard", outOfScope: null, touches: [] }, { chain: [{ profile: claude, authMode: "api-key" as const }] });
    expect(subMode).not.toBe(keyMode);
  });

  test("chainFromJson round-trips strictly; duplicates and bad shapes are null", () => {
    const chain = [{ profile: claude, authMode: "subscription" as const }, { profile: claude, authMode: "api-key" as const }];
    const json = canonicalChainJson(chain);
    const back = chainFromJson(json);
    expect(back).not.toBeNull();
    expect(back).toHaveLength(2);
    expect(back?.[0]?.authMode).toBe("subscription");
    expect(back?.[1]?.authMode).toBe("api-key");
    // Exact duplicate entry (same profile + same auth mode) => null.
    expect(chainFromJson(canonicalChainJson([{ profile: claude, authMode: "subscription" as const }, { profile: claude, authMode: "subscription" as const }]))).toBeNull();
    // Empty, over-length, wrong version, bad auth mode => null.
    expect(chainFromJson(canonicalChainJson([]))).toBeNull();
    expect(chainFromJson('{"digestVersion":1,"chain":[{"profile":{},"authMode":"nope"}]}')).toBeNull();
    expect(chainFromJson('{"digestVersion":99,"chain":[]}')).toBeNull();
    expect(chainFromJson("not json")).toBeNull();
  });

  test("snapshots round-trip strictly; anything malformed is null, never a guess", () => {
    for (const profile of [claude, codex, openrouter]) {
      expect(profileFromJson(canonicalProfileJson(profile))).toEqual(profile);
    }
    expect(profileFromJson(null)).toBeNull();
    expect(profileFromJson("not json")).toBeNull();
    expect(profileFromJson(JSON.stringify({ digestVersion: 1, profile: claude }))).toBeNull();
    expect(profileFromJson(JSON.stringify({ digestVersion: 2, profile: { ...claude, model: "" } }))).toBeNull();
    expect(profileFromJson(JSON.stringify({ digestVersion: 2, profile: { ...codex, maxTurns: 40 } }))).toBeNull();
    expect(profileFromJson(JSON.stringify({ digestVersion: 2, profile: { ...claude, provider: "gemini" } }))).toBeNull();
  });

  test("authority-integrity: numeric and model parsing is strict — a snapshot with a negative, zero, fractional, or non-numeric bound, a clock that is not whole seconds, or a model that is not an exact id rehydrates as nothing", () => {
    const wrap = (profile: Record<string, unknown>) => JSON.stringify({ digestVersion: 2, profile });
    // Sound: exact ids and whole positive bounds.
    expect(profileFromJson(wrap({ ...claude, repairModel: "inherit" }))).not.toBeNull();
    expect(profileFromJson(wrap({ ...claude, repairModel: "haiku-4.5" }))).not.toBeNull();
    // Turn bounds.
    for (const bad of [0, -1, 1.5, "40", Number.NaN, Number.POSITIVE_INFINITY, null]) {
      expect(profileFromJson(wrap({ ...claude, maxTurns: bad }))).toBeNull();
      expect(profileFromJson(wrap({ ...claude, repairMaxTurns: bad }))).toBeNull();
    }
    // Clocks, on every provider shape.
    for (const bad of [0, -300, 0.5, "1800"]) {
      expect(profileFromJson(wrap({ ...claude, timeoutSeconds: bad }))).toBeNull();
      expect(profileFromJson(wrap({ ...claude, repairTimeoutSeconds: bad }))).toBeNull();
      expect(profileFromJson(wrap({ ...codex, timeoutSeconds: bad }))).toBeNull();
      expect(profileFromJson(wrap({ ...openrouter, repairTimeoutSeconds: bad }))).toBeNull();
    }
    // Model ids: no leading dash (argv injection), no whitespace, no control bytes, no empty, a bounded length.
    for (const bad of ["-p", "son net", "sonnet\n", "", "x".repeat(129), 42, null]) {
      expect(profileFromJson(wrap({ ...claude, model: bad }))).toBeNull();
      expect(profileFromJson(wrap({ ...claude, repairModel: bad }))).toBeNull();
      expect(profileFromJson(wrap({ ...codex, model: bad }))).toBeNull();
    }
    // A chain carrying one such entry is no chain at all — never a shorter one.
    expect(chainFromJson(canonicalChainJson([{ profile: claude, authMode: "subscription" as const }, { profile: { ...claude, model: "-p" } as typeof claude, authMode: "api-key" as const }]))).toBeNull();
    expect(chainFromJson(canonicalChainJson([{ profile: claude, authMode: "subscription" as const }, { profile: { ...claude, maxTurns: -1 } as typeof claude, authMode: "api-key" as const }]))).toBeNull();
  });
});


describe("exact-key, safe-integer, timer-safe rehydration (v48 integrity)", () => {
  const claude = { provider: "claude" as const, model: "sonnet", permissionArgv: "auto" as const, maxTurns: 40, repairMaxTurns: 4, timeoutSeconds: 1800, repairTimeoutSeconds: 300, repairModel: "inherit" };
  const codex = { provider: "codex" as const, model: "gpt-5-codex", sandboxMode: "workspace-write" as const, maxTurns: "unsupported" as const, repairMaxTurns: "unsupported" as const, timeoutSeconds: 1200, repairTimeoutSeconds: 300, repairModel: "inherit" };
  const gemini = { provider: "gemini" as const, model: "gemini-2.5-pro", approvalArgv: "auto_edit" as const, maxTurns: "unsupported" as const, repairMaxTurns: "unsupported" as const, timeoutSeconds: 1200, repairTimeoutSeconds: 300, repairModel: "inherit" };
  const wrap = (profile: Record<string, unknown>, extra: Record<string, unknown> = {}) => JSON.stringify({ digestVersion: 2, profile, ...extra });

  test("a snapshot carries exactly its provider's keys — an unknown key on the wrapper or the profile, or a missing required key, rehydrates as nothing", () => {
    for (const sound of [claude, codex, gemini]) {
      expect(profileFromJson(wrap(sound))).toEqual(sound);
      expect(profileFromJson(wrap({ ...sound, timeoutKind: "idle" }))).toEqual({ ...sound, timeoutKind: "idle" });
      expect(profileFromJson(wrap({ ...sound, extra: 1 }))).toBeNull();
      expect(profileFromJson(wrap({ ...sound, permissionMode: "auto" }))).toBeNull();
      expect(profileFromJson(wrap(sound, { note: "x" }))).toBeNull();
      const { repairModel: _dropped, ...missing } = sound;
      void _dropped;
      expect(profileFromJson(wrap(missing))).toBeNull();
    }
    // A key that belongs to ANOTHER provider's shape is an unknown key here.
    expect(profileFromJson(wrap({ ...claude, sandboxMode: "workspace-write" }))).toBeNull();
    expect(profileFromJson(wrap({ ...codex, permissionArgv: "auto" }))).toBeNull();
    expect(profileFromJson(wrap({ ...gemini, sandboxMode: "workspace-write" }))).toBeNull();
    expect(profileFromJson(JSON.stringify({ digestVersion: 2, profile: [claude] }))).toBeNull();
  });

  test("numbers are safe integers and clocks fit a timer: past MAX_SAFE_INTEGER or past 2^31−1 ms rehydrates as nothing", () => {
    expect(MAX_TIMER_SECONDS).toBe(2_147_483);
    expect(profileFromJson(wrap({ ...claude, timeoutSeconds: MAX_TIMER_SECONDS }))).not.toBeNull();
    for (const bad of [MAX_TIMER_SECONDS + 1, 2_147_483_647, Number.MAX_SAFE_INTEGER, 9007199254740993, 1e300]) {
      expect(profileFromJson(wrap({ ...claude, timeoutSeconds: bad }))).toBeNull();
      expect(profileFromJson(wrap({ ...claude, repairTimeoutSeconds: bad }))).toBeNull();
      expect(profileFromJson(wrap({ ...codex, timeoutSeconds: bad }))).toBeNull();
      expect(profileFromJson(wrap({ ...gemini, repairTimeoutSeconds: bad }))).toBeNull();
    }
    for (const bad of [9007199254740993, Number.MAX_SAFE_INTEGER + 2, 1e300]) {
      expect(profileFromJson(wrap({ ...claude, maxTurns: bad }))).toBeNull();
      expect(profileFromJson(wrap({ ...claude, repairMaxTurns: bad }))).toBeNull();
    }
    expect(profileFromJson(wrap({ ...claude, maxTurns: Number.MAX_SAFE_INTEGER }))).not.toBeNull();
  });

  test("a chain snapshot is exact too: an extra wrapper or entry key, a malformed auth mode, or an entry profile with an extra key is no chain", () => {
    const sound = [{ profile: claude, authMode: "subscription" as const }, { profile: codex, authMode: "api-key" as const }];
    expect(chainFromJson(canonicalChainJson(sound))).toEqual(sound);
    const wrapped = JSON.parse(canonicalChainJson(sound)) as { digestVersion: number; chain: Record<string, unknown>[] };
    expect(chainFromJson(JSON.stringify({ ...wrapped, extra: 1 }))).toBeNull();
    expect(chainFromJson(JSON.stringify({ ...wrapped, chain: [{ ...wrapped.chain[0], note: "x" }] }))).toBeNull();
    for (const auth of ["whatever", "", null, undefined, 1, "SUBSCRIPTION"]) {
      expect(chainFromJson(JSON.stringify({ ...wrapped, chain: [{ profile: claude, authMode: auth }] }))).toBeNull();
    }
    expect(chainFromJson(JSON.stringify({ ...wrapped, chain: [{ profile: { ...claude, extra: 1 }, authMode: "subscription" }] }))).toBeNull();
    expect(chainFromJson(JSON.stringify({ ...wrapped, chain: [{ profile: { ...claude, timeoutSeconds: MAX_TIMER_SECONDS + 1 }, authMode: "subscription" }] }))).toBeNull();
    expect(chainFromJson(JSON.stringify({ ...wrapped, chain: [{ profile: null, authMode: "subscription" }] }))).toBeNull();
  });

  test("a route snapshot is exact: an extra key on the route, a leg, a recommendation, or an override is no route", () => {
    const store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "alex", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "alex", T0);
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "alex", T0);
    store.createTask({ id: "r", title: "r" }, T0);
    const ref = store.refFor("built-in", "r").id;
    store.placeTask(ref, "/repo/r");
    expect(store.editTaskRoute(ref, { by: "alex", authenticate: () => ({ ok: true }), override: { phase: "review", provider: "claude", model: "opus" } }, T0).ok).toBe(true);
    propose(store, { taskId: "r", goal: "g", now: T0 });
    const json = store.getScope("r")!.proposedRouteJson!;
    const route = JSON.parse(json) as Record<string, unknown>;
    expect(routeFromJson(json)).not.toBeNull();
    expect((route["overrides"] as unknown[]).length).toBe(1);
    expect(routeFromJson(JSON.stringify({ ...route, extra: 1 }))).toBeNull();
    expect(routeFromJson(JSON.stringify({ ...route, legs: (route["legs"] as Record<string, unknown>[]).map((leg, i) => (i === 0 ? { ...leg, extra: 1 } : leg)) }))).toBeNull();
    expect(routeFromJson(JSON.stringify({ ...route, legs: (route["legs"] as Record<string, unknown>[]).map((leg, i) => (i === 0 ? { ...leg, recommended: { ...(leg["recommended"] as object), extra: 1 } } : leg)) }))).toBeNull();
    expect(routeFromJson(JSON.stringify({ ...route, overrides: (route["overrides"] as Record<string, unknown>[]).map(one => ({ ...one, extra: 1 })) }))).toBeNull();
    const { demands: _d, ...missing } = route;
    void _d;
    expect(routeFromJson(JSON.stringify(missing))).toBeNull();
    store.close();
  });

  test("scopeAuthorityOf is the one strict projection: it re-parses the raw bytes, requires parity, entry-zero identity, and a digest that re-derives — and the seal refuses whatever it refuses", () => {
    const store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "alex", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "alex", T0);
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "alex", T0);
    const alex = addApprover(store, "alex", T0, undefined, () => "tok-alex");
    if (!alex.ok) throw new Error("bootstrap");
    store.createTask({ id: "p", title: "p" }, T0);
    const ref = store.refFor("built-in", "p").id;
    store.placeTask(ref, "/repo/p");
    propose(store, { taskId: "p", goal: "g", acceptance: [{ id: "c1", statement: "s", how: null, evidence: ["check"] }], now: T0 });
    const sound = store.getScope("p")!;
    const authority = scopeAuthorityOf(sound);
    expect(authority).toMatchObject({ ok: true, chain: null, digest: sound.digest });
    const raw = store.raw();
    const stored = raw.prepare("SELECT profile_json, proposed_route_json, digest FROM task_scope WHERE task_id = 'p'").get() as { profile_json: string; proposed_route_json: string; digest: string };
    const restore = () => raw.prepare("UPDATE task_scope SET profile_json = ?, proposed_route_json = ?, digest = ?, proposed_chain_json = NULL, route_era = 1 WHERE task_id = 'p'").run(stored.profile_json, stored.proposed_route_json, stored.digest);
    const profile = JSON.parse(stored.profile_json) as { digestVersion: number; profile: Record<string, unknown> };
    const route = JSON.parse(stored.proposed_route_json) as Record<string, unknown>;
    const cases: [string, string, () => void][] = [
      ["profile", "profile with an extra key", () => raw.prepare("UPDATE task_scope SET profile_json = ? WHERE task_id = 'p'").run(JSON.stringify({ ...profile, profile: { ...profile.profile, extra: 1 } }))],
      ["profile", "timer-unsafe clock", () => raw.prepare("UPDATE task_scope SET profile_json = ? WHERE task_id = 'p'").run(JSON.stringify({ ...profile, profile: { ...profile.profile, timeoutSeconds: MAX_TIMER_SECONDS + 1 } }))],
      ["profile", "no profile at all", () => raw.prepare("UPDATE task_scope SET profile_json = NULL WHERE task_id = 'p'").run()],
      ["route", "route with an extra key", () => raw.prepare("UPDATE task_scope SET proposed_route_json = ? WHERE task_id = 'p'").run(JSON.stringify({ ...route, extra: 1 }))],
      ["route", "no route on a routed row", () => raw.prepare("UPDATE task_scope SET proposed_route_json = NULL WHERE task_id = 'p'").run()],
      ["parity", "repair leg not the profile's", () => raw.prepare("UPDATE task_scope SET proposed_route_json = ? WHERE task_id = 'p'").run(JSON.stringify({ ...route, legs: (route["legs"] as Record<string, unknown>[]).map(leg => (leg["phase"] === "repair" ? { ...leg, model: "opus" } : leg)) }))],
      ["chain", "chain with a malformed auth mode", () => raw.prepare("UPDATE task_scope SET proposed_chain_json = ? WHERE task_id = 'p'").run(JSON.stringify({ digestVersion: 1, chain: [{ profile: profile.profile, authMode: "bogus" }] }))],
      ["parity", "chain whose entry zero is another profile", () => raw.prepare("UPDATE task_scope SET proposed_chain_json = ? WHERE task_id = 'p'").run(JSON.stringify({ digestVersion: 1, chain: [{ profile: { ...profile.profile, model: "opus" }, authMode: "subscription" }] }))],
      ["digest", "a chain the digest never bound", () => raw.prepare("UPDATE task_scope SET proposed_chain_json = ? WHERE task_id = 'p'").run(JSON.stringify({ digestVersion: 1, chain: [{ profile: profile.profile, authMode: "subscription" }] }))],
      ["digest", "a digest that does not re-derive", () => raw.prepare("UPDATE task_scope SET digest = ? WHERE task_id = 'p'").run("f".repeat(32))],
      ["unrouted", "a pre-routing row", () => raw.prepare("UPDATE task_scope SET route_era = NULL WHERE task_id = 'p'").run()],
      // THE RAW TERMS (raw authority repair): corruption the lenient
      // readers used to filter, default, or coerce into the SAME digest —
      // a non-string touch entry, a rubric entry with a key this code
      // never writes, a text budget, a rubric that does not parse, a
      // digest version or route era no build writes — is a stated
      // problem, and no seal, consent, or yes lands on it.
      ["terms", "a touch entry that is not a string", () => raw.prepare("UPDATE task_scope SET touches = ? WHERE task_id = 'p'").run(JSON.stringify(["src", 5]))],
      ["terms", "touches that are not a list", () => raw.prepare("UPDATE task_scope SET touches = ? WHERE task_id = 'p'").run(JSON.stringify({ src: true }))],
      ["terms", "touches that are not JSON", () => raw.prepare("UPDATE task_scope SET touches = '[' WHERE task_id = 'p'").run()],
      ["terms", "a rubric entry with an unknown key", () => raw.prepare("UPDATE task_scope SET acceptance_json = ? WHERE task_id = 'p'").run(JSON.stringify([{ id: "c1", statement: "s", how: null, evidence: ["check"], extra: 1 }]))],
      ["terms", "a rubric entry that does not parse", () => raw.prepare("UPDATE task_scope SET acceptance_json = ? WHERE task_id = 'p'").run(JSON.stringify([{ id: "c1", statement: "s", how: null, evidence: ["check"] }, { id: 7 }]))],
      ["terms", "a rubric that is not a list", () => raw.prepare("UPDATE task_scope SET acceptance_json = '{}' WHERE task_id = 'p'").run()],
      ["terms", "a text budget", () => raw.prepare("UPDATE task_scope SET budget_microusd = 'lots' WHERE task_id = 'p'").run()],
      ["terms", "a fractional budget", () => raw.prepare("UPDATE task_scope SET budget_microusd = 1.5 WHERE task_id = 'p'").run()],
      ["terms", "a digest version no build writes", () => raw.prepare("UPDATE task_scope SET digest_version = 3 WHERE task_id = 'p'").run()],
      ["terms", "a route era no build writes", () => raw.prepare("UPDATE task_scope SET route_era = 99 WHERE task_id = 'p'").run()],
    ];
    const rawRestore = raw.prepare("SELECT touches, acceptance_json, budget_microusd, digest_version FROM task_scope WHERE task_id = 'p'").get() as Record<string, unknown>;
    for (const [reason, label, corrupt] of cases) {
      restore();
      raw.prepare("UPDATE task_scope SET touches = ?, acceptance_json = ?, budget_microusd = ?, digest_version = ? WHERE task_id = 'p'").run(rawRestore["touches"], rawRestore["acceptance_json"], rawRestore["budget_microusd"], rawRestore["digest_version"]);
      corrupt();
      const refused = scopeAuthorityOf(store.getScope("p")!);
      expect(refused, label).toMatchObject({ ok: false, reason });
      expect(store.sealScopeApproval("p", "alex", T0), label).toBe(false);
      const current = store.getScope("p")!;
      expect(approve(store, "p", "alex", T0, current.digest, "tok-alex").ok, label).toBe(false);
      expect(current.approvedAt, label).toBeNull();
      if (reason === "terms") {
        expect(current.termsProblem, label).toEqual(expect.any(String));
        expect(store.sealedRouteOf("p"), label).toMatchObject({ ok: false, reason: "unreadable", detail: expect.stringContaining("cannot be read exactly") });
        expect(store.routeAuthorityFor(ref, "builder"), label).toMatchObject({ ok: false, problem: expect.stringContaining("cannot be read exactly") });
      }
    }
    restore();
    raw.prepare("UPDATE task_scope SET touches = ?, acceptance_json = ?, budget_microusd = ?, digest_version = ? WHERE task_id = 'p'").run(rawRestore["touches"], rawRestore["acceptance_json"], rawRestore["budget_microusd"], rawRestore["digest_version"]);
    expect(store.getScope("p")!.termsProblem).toBeNull();
    expect(scopeAuthorityOf(store.getScope("p")!).ok).toBe(true);
    expect(approve(store, "p", "alex", T0, store.getScope("p")!.digest, "tok-alex").ok).toBe(true);
    store.close();
  });
});

describe("the gemini execution profile (Phase 3)", () => {
  const profile: import("./scope.js").ExecutionProfile = {
    provider: "gemini",
    model: "gemini-2.5-pro",
    approvalArgv: "auto_edit",
    maxTurns: "unsupported",
    repairMaxTurns: "unsupported",
    timeoutSeconds: 1200,
    repairTimeoutSeconds: 300,
    repairModel: "inherit",
  };

  test("snapshots roundtrip byte-stably through the digest chain", () => {
    const json = canonicalProfileJson(profile);
    const back = profileFromJson(json);
    expect(back).toEqual(profile);
    expect(profileDigestOf(back as ExecutionProfile)).toBe(profileDigestOf(profile));
  });

  test("rehydration is strict: a foreign approval dial or missing field is null, never a guess", () => {
    const loose = JSON.parse(canonicalProfileJson(profile)) as { profile: Record<string, unknown> };
    loose.profile["approvalArgv"] = "default";
    expect(profileFromJson(JSON.stringify(loose))).toBeNull();
    const missing = JSON.parse(canonicalProfileJson(profile)) as { profile: Record<string, unknown> };
    delete missing.profile["repairModel"];
    expect(profileFromJson(JSON.stringify(missing))).toBeNull();
  });

  test("yolo is a distinct signed byte — the digest moves", () => {
    expect(profileDigestOf({ ...profile, approvalArgv: "yolo" })).not.toBe(profileDigestOf(profile));
  });
});

describe("filing under a fallback chain (E3a): the digest binds it, the seal copies it", () => {
  let store: Store;
  const REPO = "/repos/chain";
  beforeEach(() => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "alex", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "alex", T0); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "alex", T0);
  });
  afterEach(() => store.close());

  const placeAndPropose = (id: string, goal: string) => {
    store.createTask({ id, title: goal }, T0);
    const ref = store.refFor("built-in", id).id;
    store.placeTask(ref, REPO);
    propose(store, { taskId: id, goal, now: T0 });
    return store.getScope(id)!;
  };

  test("no configured fallbacks: BYTE-IDENTICAL legacy filing — profile digest, no chain snapshot", () => {
    const scope = placeAndPropose("t-plain", "a guard");
    expect(scope.approvalKind).toBe("profile");
    expect(scope.proposedChainJson ?? null).toBeNull();
    // The digest is exactly the single-profile binding plus the exact
    // agent route every fresh row binds (v47).
    expect(scope.digest).toBe(
      digestOf({ goal: "a guard", outOfScope: null, touches: [], budgetMicrousd: null }, scope.profile ?? null, routeFromJson(scope.proposedRouteJson ?? null)),
    );
  });

  test("with fallbacks: the proposed digest binds the WHOLE chain and stores the working snapshot", () => {
    store.setFallbackConfig(REPO, [{ provider: "gemini", model: "gemini-2.5-pro", authMode: "api-key" }], "alex", T0);
    const scope = placeAndPropose("t-chain", "a guard");
    expect(scope.proposedChainJson).not.toBeNull();
    // The stored snapshot re-hydrates strictly, base first.
    const chain = chainFromJson(scope.proposedChainJson!);
    expect(chain).not.toBeNull();
    expect(chain).toHaveLength(2);
    expect(chain![0]?.profile.provider).toBe("claude");
    expect(chain![1]?.profile.provider).toBe("gemini");
    // The digest binds that exact chain — and DIFFERS from the single-profile
    // binding a plain filing would carry.
    const route = routeFromJson(scope.proposedRouteJson ?? null);
    expect(scope.digest).toBe(
      digestOf({ goal: "a guard", outOfScope: null, touches: [], budgetMicrousd: null }, { chain: chain! }, route),
    );
    expect(scope.digest).not.toBe(
      digestOf({ goal: "a guard", outOfScope: null, touches: [], budgetMicrousd: null }, scope.profile ?? null, route),
    );
    // Not yet approved: the approved snapshot stays empty until the seal.
    expect(scope.approvedChainJson ?? null).toBeNull();
    expect(scope.approvalKind).toBe("profile");
  });

  test("the seal COPIES the working chain into the immutable approved snapshot — never re-resolves", () => {
    store.setFallbackConfig(REPO, [{ provider: "gemini", model: "gemini-2.5-pro", authMode: "api-key" }], "alex", T0);
    const scope = placeAndPropose("t-seal", "a guard");
    const token = bootstrapApprover(store);
    expect(approve(store, "t-seal", "alex", T0, scope.digest, token).ok).toBe(true);
    const approved = store.getScope("t-seal")!;
    expect(approved.approvalKind).toBe("chain");
    // Byte-for-byte the working snapshot the signed digest bound.
    expect(approved.approvedChainJson).toBe(scope.proposedChainJson);
    // Mutating the config AFTER approval never moves the sealed snapshot.
    store.setFallbackConfig(REPO, [{ provider: "codex", model: "gpt-5-codex", authMode: "subscription" }], "alex", later(1_000));
    expect(store.getScope("t-seal")!.approvedChainJson).toBe(scope.proposedChainJson);
  });

  test("the approval card SAYS the chain — every entry, credential included (Layer F)", () => {
    store.setFallbackConfig(REPO, [{ provider: "gemini", model: "gemini-2.5-pro", authMode: "api-key" }], "alex", T0);
    const scope = placeAndPropose("t-words", "a guard");
    const words = describeScope(scope).join("\n");
    expect(words).toContain("runs on      claude (sonnet) — your subscription");
    expect(words).toContain("falls back to gemini (gemini-2.5-pro) — your API key; spend moves to that account");
    // A plain scope says nothing about chains.
    const plain = placeAndPropose("t-words-plain", "a guard");
    store.clearFallbackConfig(REPO);
    propose(store, { taskId: "t-words-plain", goal: "a guard", now: later(1_000) });
    expect(describeScope(store.getScope("t-words-plain")!).join("\n")).not.toContain("falls back");
    void plain;
  });

  test("a configured chain that CANNOT file makes the scope visibly UNRESOLVED — never a silent single-profile approval (F+G finding 4)", () => {
    // The config road validates, but the store can be reached directly (or
    // the base can change after a valid set): a duplicate-of-base chain.
    store.setFallbackConfig(REPO, [{ provider: "claude", model: "sonnet", authMode: "subscription" }], "alex", T0);
    const scope = placeAndPropose("t-unfileable", "a guard");
    expect(scope.profileState).toBe("unresolved");
    expect(scope.unresolvedReason).toContain("fallback chain cannot file");
    expect(scope.proposedChainJson ?? null).toBeNull();
    // Unresolved blocks approval — the operator sees WHY instead of signing
    // something other than what they configured.
    const token = bootstrapApprover(store);
    expect(approve(store, "t-unfileable", "alex", T0, scope.digest, token)).toMatchObject({ ok: false, reason: "profile-unresolved" });
  });

  test("a re-approved plain scope re-seals to 'profile' — a stale chain can never survive a rewrite", () => {
    store.setFallbackConfig(REPO, [{ provider: "gemini", model: "gemini-2.5-pro", authMode: "api-key" }], "alex", T0);
    const scope = placeAndPropose("t-rewrite", "a guard");
    const token = bootstrapApprover(store);
    expect(approve(store, "t-rewrite", "alex", T0, scope.digest, token).ok).toBe(true);
    expect(store.getScope("t-rewrite")!.approvalKind).toBe("chain");
    // The operator clears the fallbacks, then rewrites + re-approves the scope.
    store.clearFallbackConfig(REPO);
    propose(store, { taskId: "t-rewrite", goal: "a narrower guard", now: later(2_000) });
    const rewritten = store.getScope("t-rewrite")!;
    expect(rewritten.proposedChainJson ?? null).toBeNull();
    expect(approve(store, "t-rewrite", "alex", later(2_000), rewritten.digest, token).ok).toBe(true);
    const resealed = store.getScope("t-rewrite")!;
    expect(resealed.approvalKind).toBe("profile");
    expect(resealed.approvedChainJson ?? null).toBeNull();
  });
});

describe("the phase route is a signed term (v47): the digest binds it, the seal copies it, later changes stale it", () => {
  let store: Store;
  const REPO = "/repos/routed";
  beforeEach(() => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "alex", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "alex", T0); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "alex", T0);
    store.setPhaseTierConfig("installation", "build", "strong", "claude", "opus", "alex", T0);
    store.setPhaseTierConfig("installation", "review", "strong", "codex", "gpt-5-codex", "alex", T0);
    const alex = addApprover(store, "alex", T0, undefined, () => "tok-alex");
    if (!alex.ok) throw new Error("bootstrap");
  });
  afterEach(() => store.close());

  const file = (id: string, options: { risk?: "routine" | "elevated" | "high"; qualityMode?: "default" | "strict" } = {}) => {
    store.createTask({ id, title: id }, T0);
    const ref = store.refFor("built-in", id).id;
    store.placeTask(ref, REPO);
    propose(store, { taskId: id, goal: "a guard", acceptance: [{ id: "c1", statement: "guarded", how: null, evidence: ["check"] }], now: T0, ...(options.risk === undefined ? {} : { riskLevel: options.risk }), ...(options.qualityMode === undefined ? {} : { qualityMode: options.qualityMode }) });
    return { ref, scope: store.getScope(id)! };
  };

  test("EVERY route binds into the digest — a routine-shaped one included — and the route drives the profile; a high-risk route selects the strong build agent", () => {
    const routine = file("t-routine");
    const routineRoute = routeFromJson(routine.scope.proposedRouteJson ?? null)!;
    expect(routine.scope.routeEra).toBe(1);
    expect(routineRoute.posture).toBe("economy");
    // Routine-shaped routes are signed terms too: the digest with the
    // route differs from the pre-v47 profile-only binding.
    expect(routine.scope.digest).toBe(digestOf({ goal: "a guard", outOfScope: null, touches: [], budgetMicrousd: null, acceptance: routine.scope.acceptance }, routine.scope.profile ?? null, routineRoute));
    expect(routine.scope.digest).not.toBe(digestOf({ goal: "a guard", outOfScope: null, touches: [], budgetMicrousd: null, acceptance: routine.scope.acceptance }, routine.scope.profile ?? null));
    expect(routine.scope.profile?.model).toBe("sonnet");
    expect(routine.scope.profile?.repairModel).toBe("inherit");
    // Every frozen leg is exact.
    expect(routineRoute.legs.map(leg => [leg.phase, leg.provider, leg.model])).toEqual([
      ["plan", "claude", "sonnet"],
      ["build", "claude", "sonnet"],
      ["repair", "claude", "sonnet"],
      ["review", "claude", "sonnet"],
    ]);

    const risky = file("t-high", { risk: "high" });
    const riskyRoute = routeFromJson(risky.scope.proposedRouteJson ?? null)!;
    expect(risky.scope.riskLevel).toBe("high");
    // The strong tier drove the SEALED profile — route and profile agree.
    expect(risky.scope.profile?.model).toBe("opus");
    expect(riskyRoute.legs.find(one => one.phase === "build")).toMatchObject({ provider: "claude", model: "opus", tier: "strong" });
    // No strong repair row: repairs inherit the strong build model, exactly.
    expect(riskyRoute.legs.find(one => one.phase === "repair")).toMatchObject({ provider: "claude", model: "opus" });
    expect(risky.scope.digest).toBe(
      digestOf({ goal: "a guard", outOfScope: null, touches: [], budgetMicrousd: null, acceptance: risky.scope.acceptance }, risky.scope.profile ?? null, riskyRoute),
    );
    expect(risky.scope.digest).not.toBe(
      digestOf({ goal: "a guard", outOfScope: null, touches: [], budgetMicrousd: null, acceptance: risky.scope.acceptance }, risky.scope.profile ?? null),
    );
    const provenance = JSON.parse(String(store.raw().prepare("SELECT profile_provenance FROM task_scope WHERE task_id = 't-high'").get()?.["profile_provenance"])) as Record<string, unknown>;
    expect(provenance["resolvedFrom"]).toBe("route");
    expect(provenance["routeDigest"]).toBe(routeDigestOf(riskyRoute));
  });

  test("a configuration that cannot make an exact route files the scope UNRESOLVED with the words — nothing is guessed", () => {
    // The planner loses its model: the scope cannot say who plans.
    store.setPhaseConfig("installation", "plan", "claude", null, "alex", T0);
    const noPlan = file("t-noplan");
    expect(noPlan.scope.profileState).toBe("unresolved");
    expect(noPlan.scope.unresolvedReason).toContain("the planner (claude) has no exact model");
    expect(approve(store, "t-noplan", "alex", T0, noPlan.scope.digest, "tok-alex")).toMatchObject({ ok: false, reason: "profile-unresolved" });
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "alex", T0);
    // A cross-provider repair row is a stated problem on the route, and
    // the scope files unresolved rather than skipping the row.
    store.setPhaseConfig("installation", "repair", "codex", "gpt-5-codex", "alex", T0);
    const crossed = file("t-cross");
    expect(crossed.scope.profileState).toBe("unresolved");
    expect(crossed.scope.unresolvedReason).toContain("cross-provider repair does not exist");
    expect(routeFromJson(crossed.scope.proposedRouteJson ?? null)!.legs.find(one => one.phase === "repair")?.problem).toContain("cross-provider");
    store.clearPhaseConfig("installation", "repair");
    // A malformed override list on the task: unresolved, never "as if none".
    const { ref, scope } = file("t-badover");
    expect(scope.profileState).toBe("resolved");
    store.raw().prepare("UPDATE task_ref SET route_overrides_json = '[{\"phase\":\"build\"}]' WHERE id = ?").run(ref);
    const refiled = store.refileScope("t-badover", T0)!;
    expect(refiled.profileState).toBe("unresolved");
    expect(refiled.unresolvedReason).toContain("route overrides cannot be read");
  });

  test("approval seals the exact route bytes; a task-level route edit stales it; a global config change cannot rewrite the sealed route", () => {
    const { ref, scope } = file("t-seal", { risk: "elevated" });
    expect(store.approvedRouteOf("t-seal")).toBeNull();
    expect(approve(store, "t-seal", "alex", T0, scope.digest, "tok-alex").ok).toBe(true);
    const sealed = store.getScope("t-seal")!;
    expect(sealed.approvedRouteJson).toBe(sealed.proposedRouteJson);
    const approvedRoute = store.approvedRouteOf("t-seal");
    expect(approvedRoute).not.toBeNull();
    expect(approvedRoute!.legs.find(one => one.phase === "review")).toMatchObject({ provider: "codex", model: "gpt-5-codex", tier: "strong" });
    const sealedDigest = routeDigestOf(approvedRoute!);

    // Global configuration moves: the strong reviewer changes. The sealed
    // route does not — and neither does the approval.
    store.setPhaseTierConfig("installation", "review", "strong", "claude", "opus", "alex", T0);
    expect(approvalOf(store.getScope("t-seal")!).approved).toBe(true);
    expect(routeDigestOf(store.approvedRouteOf("t-seal")!)).toBe(sealedDigest);

    // A task-level override re-files the scope in ONE transaction: the
    // digest moves, the approval is stale, and the sealed route no longer
    // governs.
    const set = store.editTaskRoute(ref, { by: "alex", authenticate: () => ({ ok: true }), override: { phase: "review", provider: "claude", model: "opus" }, expectDigest: sealed.digest }, new Date(T0.getTime() + 1_000));
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    expect(set.staled).toBe(true);
    const refiled = set.scope!;
    expect(approvalOf(refiled)).toMatchObject({ approved: false, reason: "changed" });
    expect(store.approvedRouteOf("t-seal")).toBeNull();
    expect(routeFromJson(refiled.proposedRouteJson ?? null)!.legs.find(one => one.phase === "review")).toMatchObject({ provider: "claude", model: "opus", chosen: "override" });
    // The old snapshot is kept as history until a fresh yes re-seals.
    expect(refiled.approvedRouteJson).toBe(sealed.approvedRouteJson);
    // Re-approving seals the new route.
    expect(approve(store, "t-seal", "alex", T0, refiled.digest, "tok-alex").ok).toBe(true);
    expect(store.approvedRouteOf("t-seal")!.overrides).toHaveLength(1);
  });

  test("a risk change stales the approval exactly as a goal edit does — even from routine to elevated", () => {
    const { ref, scope } = file("t-risk");
    expect(approve(store, "t-risk", "alex", T0, scope.digest, "tok-alex").ok).toBe(true);
    // The digest-CAS: an edit made against a digest the editor never saw
    // is refused; null means "I saw no scope" and is not the same as a digest.
    expect(store.editTaskRoute(ref, { by: "alex", authenticate: () => ({ ok: true }), risk: "elevated", expectDigest: "0".repeat(32) }, T0)).toMatchObject({ ok: false, reason: "changed" });
    expect(store.editTaskRoute(ref, { by: "alex", authenticate: () => ({ ok: true }), risk: "elevated", expectDigest: null }, T0)).toMatchObject({ ok: false, reason: "changed" });
    expect(store.getScope("t-risk")!.riskLevel).toBe("routine");
    // An editor who is no longer an approver changes nothing either.
    expect(store.editTaskRoute(ref, { by: "mallory", authenticate: () => ({ ok: false, reason: "not-an-approver" }), risk: "elevated" }, T0)).toMatchObject({ ok: false, reason: "unauthenticated" });
    const edited = store.editTaskRoute(ref, { by: "alex", authenticate: () => ({ ok: true }), risk: "elevated", expectDigest: scope.digest }, T0);
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    const refiled = edited.scope!;
    expect(refiled.riskLevel).toBe("elevated");
    expect(approvalOf(refiled)).toMatchObject({ approved: false, reason: "changed" });
    // The words in the approval card say the route and its reasons.
    const words = describeScope(refiled);
    expect(words).toContain("  risk         elevated");
    // Elevated risk lifts planning and building to the strong tier.
    expect(words.some(line => line.includes("build  claude · opus  [recommended · strong]"))).toBe(true);
    expect(words.some(line => line.includes("risk is elevated — planning and building use the strongest configured agent"))).toBe(true);
    expect(words.some(line => /review codex|strongest configured reviewer/.test(line))).toBe(false);
  });

  test("the seal refuses a routed row whose working profile and route disagree, or whose route is gone — nothing is approved that cannot be restated exactly", () => {
    const { scope } = file("t-belt");
    // The working profile drifts from the route (a corrupt row): no seal.
    store.raw().prepare("UPDATE task_scope SET profile_json = REPLACE(profile_json, '\"model\":\"sonnet\"', '\"model\":\"haiku\"') WHERE task_id = 't-belt'").run();
    expect(store.sealScopeApproval("t-belt", "alex", T0)).toBe(false);
    expect(approvalOf(store.getScope("t-belt")!).approved).toBe(false);
    store.raw().prepare("UPDATE task_scope SET profile_json = REPLACE(profile_json, '\"model\":\"haiku\"', '\"model\":\"sonnet\"') WHERE task_id = 't-belt'").run();
    // The route removed from a routed row: no seal either.
    const kept = store.getScope("t-belt")!.proposedRouteJson;
    store.raw().prepare("UPDATE task_scope SET proposed_route_json = NULL WHERE task_id = 't-belt'").run();
    expect(store.sealScopeApproval("t-belt", "alex", T0)).toBe(false);
    store.raw().prepare("UPDATE task_scope SET proposed_route_json = ? WHERE task_id = 't-belt'").run(kept);
    // Restored: the exact seal lands, copying the route.
    expect(approve(store, "t-belt", "alex", T0, scope.digest, "tok-alex").ok).toBe(true);
    expect(store.getScope("t-belt")!.approvedRouteJson).toBe(kept);
    expect(store.sealedRouteOf("t-belt").ok).toBe(true);
  });

  test("a tampered approved route snapshot no longer proves — the seal is the digest, not the column", () => {
    const { scope } = file("t-tamper", { risk: "high" });
    expect(approve(store, "t-tamper", "alex", T0, scope.digest, "tok-alex").ok).toBe(true);
    expect(store.approvedRouteOf("t-tamper")).not.toBeNull();
    store.raw().prepare("UPDATE task_scope SET approved_route_json = REPLACE(approved_route_json, '\"risk\":\"high\"', '\"risk\":\"elevated\"') WHERE task_id = 't-tamper'").run();
    expect(store.approvedRouteOf("t-tamper")).toBeNull();
    expect(proveApprovedProfile(store.getScope("t-tamper"), null, { provider: "claude", model: "opus", maxTurns: undefined, timeoutMs: undefined, skipPermissions: false })).toMatchObject({ ok: false });
  });

  test("route edits are refused under a live claim", () => {
    const { ref } = file("t-live");
    register(store, { name: "r", host: "h", repos: [REPO], now: T0, newToken: () => "tok-r" });
    store.saveScope({ ...store.getScope("t-live")!, approvedAt: T0.toISOString(), approvedBy: "alex", approvedDigest: store.getScope("t-live")!.digest });
    const taken = acquire(store, ref, "r", { token: "tok-r", now: T0 });
    expect(taken.ok).toBe(true);
    expect(store.editTaskRoute(ref, { by: "alex", authenticate: () => ({ ok: true }), risk: "high" }, T0)).toMatchObject({ ok: false, reason: "live-claim" });
    expect(store.editTaskRoute(ref, { by: "alex", authenticate: () => ({ ok: true }), override: { phase: "build", provider: "codex", model: "gpt-5" } }, T0)).toMatchObject({ ok: false, reason: "live-claim" });
  });

  test("a plan override becomes the planner pin and re-requests a drafted plan — one transaction, no half-updated authority", () => {
    const { ref } = file("t-plan");
    store.setPlanPins(ref, "codex", "gpt-5", T0);
    store.setPlanState(ref, "drafted");
    const edited = store.editTaskRoute(ref, { by: "alex", authenticate: () => ({ ok: true }), override: { phase: "plan", provider: "claude", model: "opus" } }, T0);
    expect(edited).toMatchObject({ ok: true, replanned: true });
    const after = store.refForId(ref)!;
    expect(after).toMatchObject({ planProvider: "claude", planModel: "opus", plan: "requested" });
    expect(routeFromJson(store.getScope("t-plan")!.proposedRouteJson ?? null)!.legs[0]).toMatchObject({ phase: "plan", provider: "claude", model: "opus" });
    // Clearing the override clears the pin with it.
    const cleared = store.editTaskRoute(ref, { by: "alex", authenticate: () => ({ ok: true }), override: { phase: "plan", clear: true } }, T0);
    expect(cleared.ok).toBe(true);
    expect(store.refForId(ref)).toMatchObject({ planProvider: null, planModel: null });
    expect(routeFromJson(store.getScope("t-plan")!.proposedRouteJson ?? null)!.legs[0]).toMatchObject({ phase: "plan", provider: "claude", model: "sonnet", chosen: "recommended" });
  });
});

describe("one strict projection gates filing, consent, the seal, and dispatch (atomic authority closure)", () => {
  let store: Store;
  const REPO = "/repos/strict";
  const savedHome = process.env["HOME"];
  let home: string;
  const authFile = () => join(home, ".standing-orders", "keys", "claude.auth");
  beforeEach(() => {
    // Every auth-mode read in the store goes through the operator's home;
    // the test owns one, so the real machine's files never decide a case.
    home = mkdtempSync(join(tmpdir(), "so-strict-scope-"));
    mkdirSync(join(home, ".standing-orders", "keys"), { recursive: true });
    process.env["HOME"] = home;
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "alex", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "alex", T0);
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "alex", T0);
    store.setPhaseTierConfig("installation", "build", "strong", "claude", "opus", "alex", T0);
    const alex = addApprover(store, "alex", T0, undefined, () => "tok-alex");
    if (!alex.ok) throw new Error("bootstrap");
  });
  afterEach(() => {
    store.close();
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  const file = (id: string) => {
    store.createTask({ id, title: id }, T0);
    const ref = store.refFor("built-in", id).id;
    store.placeTask(ref, REPO);
    propose(store, { taskId: id, goal: "a guard", acceptance: [{ id: "c1", statement: "guarded", how: null, evidence: ["check"] }], now: T0 });
    return { ref, scope: store.getScope(id)! };
  };
  const runs = () => Number((store.raw().prepare("SELECT COUNT(*) AS n FROM run").get() as { n: number }).n);
  const strictEnv = { authMode: (provider: "claude" | "codex" | "gemini" | "openrouter") => readAuthModeStrict(provider) };

  /** Every door, on a scope that must not open: the projection names the
   * reason, no seal lands (password or mode), the row stays unapproved,
   * no builder can present a stamp, and no run row exists. */
  const everyDoorClosed = (id: string, ref: number, reason: string, words: RegExp) => {
    const scope = store.getScope(id)!;
    expect(scopeAuthorityOf(scope, strictEnv)).toMatchObject({ ok: false, reason, problem: expect.stringMatching(words) });
    expect(store.sealScopeApproval(id, "mode nightly", T0, {}, { kind: "mode", modeDigest: "m".repeat(32) })).toBe(false);
    expect(store.sealScopeApproval(id, "alex", T0)).toBe(false);
    expect(approve(store, id, "alex", T0, scope.digest, "tok-alex").ok).toBe(false);
    expect(store.getScope(id)!.approvedAt).toBeNull();
    expect(store.sealedRouteOf(id).ok).toBe(false);
    const authority = store.routeAuthorityFor(ref, "builder");
    expect(authority === null || authority.ok === false).toBe(true);
    expect(() =>
      store.startRun({ taskRef: ref, leaseId: "lease", runner: "r", branch: "b", worktree: "/w", provider: "claude", model: "sonnet", now: T0, route: { routeDigest: "legacy", phase: "build", provider: "claude", model: "sonnet", chosen: "legacy" } }),
    ).toThrow(/run admission refused/);
    expect(runs()).toBe(0);
  };

  test("a proposed-via marker outside mate, coordinator, scout, or null is a stated term problem — the mate quarantine cannot be bypassed by a word it does not list", () => {
    const { ref } = file("t-via");
    const raw = store.raw();
    // The quarantine as written: a mate's text never takes a mode seal.
    raw.prepare("UPDATE task_scope SET proposed_via = 'mate' WHERE task_id = 't-via'").run();
    expect(store.getScope("t-via")!.proposedVia).toBe("mate");
    expect(store.sealScopeApproval("t-via", "mode nightly", T0, {}, { kind: "mode", modeDigest: "m".repeat(32) })).toBe(false);
    // The reproduction: `bogus` used to fall outside the IN-list and seal.
    raw.prepare("UPDATE task_scope SET proposed_via = 'bogus' WHERE task_id = 't-via'").run();
    expect(store.getScope("t-via")!.termsProblem).toBe("the proposed-via marker is not one this code writes");
    expect(store.getScope("t-via")!.proposedVia).toBeNull();
    everyDoorClosed("t-via", ref, "terms", /proposed-via marker/);
    // A person's text (null) seals under a mode as before.
    raw.prepare("UPDATE task_scope SET proposed_via = NULL WHERE task_id = 't-via'").run();
    expect(store.getScope("t-via")!.termsProblem).toBeNull();
    expect(store.sealScopeApproval("t-via", "mode nightly", T0, {}, { kind: "mode", modeDigest: "m".repeat(32) })).toBe(true);
  });

  test("a present auth-mode file that says neither word closes filing, consent, and the seal in its words — never the lenient subscription default", () => {
    // Filed while the mode is well-formed: the projection proves and
    // reports the mode it read.
    const { ref, scope } = file("t-auth");
    expect(scope.profileState).toBe("resolved");
    expect(scopeAuthorityOf(scope, strictEnv)).toMatchObject({ ok: true, authMode: "subscription" });
    // The reproduction: claude.auth says `not-a-mode`.
    writeFileSync(authFile(), "not-a-mode");
    everyDoorClosed("t-auth", ref, "auth-mode", /says "not-a-mode", not subscription or api-key/);
    // Without the strict reader in hand the pure projection still proves
    // the row — the reader is the door's, and every door hands it in.
    expect(scopeAuthorityOf(store.getScope("t-auth")!)).toMatchObject({ ok: true, authMode: null });
    // Filing under the broken file goes UNRESOLVED in the same words.
    store.createTask({ id: "t-auth-2", title: "t" }, T0);
    const ref2 = store.refFor("built-in", "t-auth-2").id;
    store.placeTask(ref2, REPO);
    propose(store, { taskId: "t-auth-2", goal: "a guard", now: T0 });
    const unresolved = store.getScope("t-auth-2")!;
    expect(unresolved.profileState).toBe("unresolved");
    expect(unresolved.unresolvedReason).toMatch(/says "not-a-mode", not subscription or api-key/);
    expect(scopeAuthorityOf(unresolved, strictEnv)).toMatchObject({ ok: false, reason: "unresolved" });
    expect(approve(store, "t-auth-2", "alex", T0, unresolved.digest, "tok-alex")).toMatchObject({ ok: false, reason: "profile-unresolved" });
    // Restated, the first scope seals; api-key is a mode too.
    writeFileSync(authFile(), "api-key");
    expect(scopeAuthorityOf(store.getScope("t-auth")!, strictEnv)).toMatchObject({ ok: true, authMode: "api-key" });
    expect(approve(store, "t-auth", "alex", T0, store.getScope("t-auth")!.digest, "tok-alex").ok).toBe(true);
  });

  test("a present fallback row outside one to three exact entries is a stated problem — an empty list never shrinks a configured chain to no fallback", () => {
    const raw = store.raw();
    const write = (entries: string) =>
      raw.prepare("INSERT INTO fallback_config (scope, phase, entries_json, updated_at, updated_by) VALUES (?, 'build', ?, ?, 'alex') ON CONFLICT (scope, phase) DO UPDATE SET entries_json = excluded.entries_json").run(REPO, entries, T0.toISOString());
    const entry = (model: string) => ({ provider: "gemini", model, authMode: "api-key" });
    // The store refuses to write what it would not read back.
    expect(() => store.setFallbackConfig(REPO, [], "alex", T0)).toThrow(/1 to 3 entries, not 0/);
    expect(() => store.setFallbackConfig(REPO, [entry("a"), entry("b"), entry("c"), entry("d")], "alex", T0)).toThrow(/1 to 3 entries, not 4/);
    expect(store.fallbackConfigProblem(REPO)).toBeNull();
    // The reproduction: a present row whose list is empty.
    write("[]");
    expect(store.fallbackConfigProblem(REPO)).toMatch(/carries 0 entries, not 1 to 3/);
    expect(store.fallbackConfig(REPO)).toEqual([]);
    const { ref, scope } = file("t-empty-chain");
    expect(scope.profileState).toBe("unresolved");
    expect(scope.unresolvedReason).toMatch(/the configured fallback chain cannot file: .*carries 0 entries, not 1 to 3/);
    expect(scope.proposedChainJson ?? null).toBeNull();
    everyDoorClosed("t-empty-chain", ref, "unresolved", /carries 0 entries/);
    // Four entries is the same corruption.
    write(JSON.stringify([entry("a"), entry("b"), entry("c"), entry("d")]));
    expect(store.fallbackConfigProblem(REPO)).toMatch(/carries 4 entries, not 1 to 3/);
    // One well-formed entry files a chain as before.
    store.setFallbackConfig(REPO, [entry("gemini-2.5-pro")], "alex", T0);
    expect(store.fallbackConfigProblem(REPO)).toBeNull();
    const { scope: chained } = file("t-chain-ok");
    expect(chained.profileState).toBe("resolved");
    expect(chainFromJson(chained.proposedChainJson!)).toHaveLength(2);
  });

  test("a risk level or quality mode that disagrees with the route it was filed beside is a parity problem on the working side, the sealed side, and the dispatch proof", () => {
    const { ref, scope } = file("t-risk");
    expect(routeFromJson(scope.proposedRouteJson ?? null)!.risk).toBe("routine");
    const raw = store.raw();
    // Working side: `high` over a route recommended for `routine`.
    raw.prepare("UPDATE task_scope SET risk_level = 'high' WHERE task_id = 't-risk'").run();
    everyDoorClosed("t-risk", ref, "parity", /recommended for routine risk but the scope's risk level is high/);
    raw.prepare("UPDATE task_scope SET risk_level = 'routine', quality_mode = 'strict' WHERE task_id = 't-risk'").run();
    expect(scopeAuthorityOf(store.getScope("t-risk")!, strictEnv)).toMatchObject({ ok: false, reason: "parity", problem: expect.stringMatching(/recommended for default quality but the scope's quality mode is strict/) });
    raw.prepare("UPDATE task_scope SET quality_mode = 'default' WHERE task_id = 't-risk'").run();
    // Sealed side: approve honestly, then corrupt the column under the seal.
    expect(approve(store, "t-risk", "alex", T0, store.getScope("t-risk")!.digest, "tok-alex").ok).toBe(true);
    expect(store.sealedRouteOf("t-risk").ok).toBe(true);
    raw.prepare("UPDATE task_scope SET risk_level = 'high' WHERE task_id = 't-risk'").run();
    expect(store.sealedRouteOf("t-risk")).toMatchObject({ ok: false, reason: "unreadable", detail: expect.stringMatching(/recommended for routine risk but the scope's risk level is high/) });
    expect(proveApprovedProfile(store.getScope("t-risk"), null, { provider: "claude", model: "sonnet", maxTurns: undefined, timeoutMs: undefined, skipPermissions: false })).toMatchObject({ ok: false, message: expect.stringMatching(/recommended for routine risk .* \(stale-approval\)/) });
    expect(store.routeAuthorityFor(ref, "builder")).toMatchObject({ ok: false });
    expect(() =>
      store.startRun({ taskRef: ref, leaseId: "lease", runner: "r", branch: "b", worktree: "/w", provider: "claude", model: "sonnet", now: T0, route: { routeDigest: routeDigestOf(routeFromJson(scope.proposedRouteJson ?? null)!), phase: "build", provider: "claude", model: "sonnet", chosen: "recommended" } }),
    ).toThrow(/run admission refused/);
    expect(runs()).toBe(0);
    raw.prepare("UPDATE task_scope SET risk_level = 'routine' WHERE task_id = 't-risk'").run();
    expect(store.sealedRouteOf("t-risk").ok).toBe(true);
  });

  test("auth parity (final authority closure): a chain filed under one credential for its base entry, read beside a live mode file that now says the other, holds no authority — no seal, no plan authority, no run — until it is filed again under today's mode", () => {
    store.setFallbackConfig(REPO, [{ provider: "gemini", model: "gemini-2.5-pro", authMode: "api-key" }], "alex", T0);
    const { ref, scope } = file("t-auth-parity");
    expect(scope.profileState).toBe("resolved");
    const chain = chainFromJson(scope.proposedChainJson ?? null)!;
    expect(chain[0]).toMatchObject({ authMode: "subscription" });
    expect(scopeAuthorityOf(scope, strictEnv)).toMatchObject({ ok: true, authMode: "subscription" });
    const planLeg = store.routeAuthorityFor(ref, "planner");
    expect(planLeg).toMatchObject({ ok: true, stamp: { phase: "plan", chosen: "recommended" } });
    if (planLeg === null || !planLeg.ok) throw new Error("plan leg");
    // The reproduction: the operator moves claude to an API key AFTER the
    // chain was filed pinned to the subscription.
    writeFileSync(authFile(), "api-key");
    const words = /fallback chain pins its base entry to your subscription for claude, but the live auth mode is now your API key — re-file the scope under today's mode/;
    everyDoorClosed("t-auth-parity", ref, "auth-mode", words);
    // The planner's claim, admission, and spawn-time proof all refuse it.
    expect(store.workingPlanRouteOf("t-auth-parity")).toMatchObject({ ok: false, problem: expect.stringMatching(words) });
    expect(store.routeAuthorityFor(ref, "planner")).toMatchObject({ ok: false, problem: expect.stringMatching(words) });
    expect(() =>
      store.startRun({ taskRef: ref, leaseId: "lease", runner: "r", role: "planner", branch: "b", worktree: "/w", provider: "claude", model: "sonnet", now: T0, route: planLeg.stamp }),
    ).toThrow(words);
    expect(runs()).toBe(0);
    // Restated to the pinned mode, the same scope proves and seals.
    writeFileSync(authFile(), "subscription");
    expect(scopeAuthorityOf(store.getScope("t-auth-parity")!, strictEnv)).toMatchObject({ ok: true, authMode: "subscription" });
    expect(approve(store, "t-auth-parity", "alex", T0, store.getScope("t-auth-parity")!.digest, "tok-alex").ok).toBe(true);
    // Sealed side: the live mode moving after the yes stales the seal too.
    writeFileSync(authFile(), "api-key");
    expect(scopeAuthorityOf(store.getScope("t-auth-parity")!, strictEnv)).toMatchObject({ ok: false, reason: "auth-mode" });
  });

  test("the planner re-proves the strict scope projection at the claim, the admission, and the invocation (final authority closure): a corrupt proposed-via marker, a risk the route was not recommended for, and an unresolved fallback `[]` each create no run and invoke no provider", async () => {
    register(store, { name: "r", host: "test", capacity: 9, repos: [REPO], now: T0, newToken: () => "tok-r" });
    const { ref, scope } = file("t-plan");
    const raw = store.raw();
    const planLeg = store.routeAuthorityFor(ref, "planner");
    if (planLeg === null || !planLeg.ok) throw new Error("plan leg");
    expect(routeOfTask(store, "t-plan", store.refForId(ref), T0)).toMatchObject({ kind: "route", source: "proposed" });
    expect(store.workingPlanRouteOf("t-plan")).toMatchObject({ ok: true });
    const sound = raw.prepare("SELECT proposed_via, risk_level, proposed_chain_json FROM task_scope WHERE task_id = 't-plan'").get() as Record<string, unknown>;
    const restore = () => raw.prepare("UPDATE task_scope SET proposed_via = ?, risk_level = ?, proposed_chain_json = ? WHERE task_id = 't-plan'").run(sound["proposed_via"], sound["risk_level"], sound["proposed_chain_json"]);
    const cases: [string, string, RegExp][] = [
      ["a corrupt proposed-via marker", "UPDATE task_scope SET proposed_via = 'bogus' WHERE task_id = 't-plan'", /proposed-via marker is not one this code writes/],
      ["a risk the route was not recommended for", "UPDATE task_scope SET risk_level = 'high' WHERE task_id = 't-plan'", /recommended for routine risk but the scope's risk level is high/],
      ["an unresolved fallback []", `UPDATE task_scope SET proposed_chain_json = '${JSON.stringify({ digestVersion: 1, chain: [] })}' WHERE task_id = 't-plan'`, /fallback chain cannot be read exactly/],
    ];
    for (const [label, sql, words] of cases) {
      restore();
      raw.exec(sql);
      // THE CLAIM: the working plan authority the tick asks for before any
      // claim refuses in words (the lenient display route still reads).
      expect(store.workingPlanRouteOf("t-plan"), label).toMatchObject({ ok: false, problem: expect.stringMatching(words) });
      // THE ADMISSION: neither the store's own answer nor the stamp the
      // planner held before the corruption opens a run.
      expect(store.routeAuthorityFor(ref, "planner"), label).toMatchObject({ ok: false, problem: expect.stringMatching(words) });
      expect(() =>
        store.startRun({ taskRef: ref, leaseId: "lease", runner: "r", role: "planner", branch: "b", worktree: "/w", provider: "claude", model: "sonnet", now: T0, route: planLeg.stamp }),
      ).toThrow(words);
      expect(runs(), label).toBe(0);
    }
    restore();
    // THE INVOCATION: a planner admitted while the scope proved, whose
    // scope is corrupted before its spawn, invokes no provider — a
    // value-shaped refusal naming what moved, no start stamp.
    const took = acquire(store, ref, "r", { now: T0, token: "tok-r", newLeaseId: () => "lease-plan", ttlMs: 10 * 365 * 24 * 3600 * 1000 });
    if (!took.ok) throw new Error(`claim refused: ${took.reason}`);
    const planner = store.startRun({ taskRef: ref, leaseId: "lease-plan", runner: "r", role: "planner", branch: "b", worktree: "/w", provider: "claude", model: "sonnet", now: T0, route: planLeg.stamp });
    expect(store.runRoute(planner)).toMatchObject({ phase: "plan", chosen: "recommended" });
    raw.exec("UPDATE task_scope SET risk_level = 'high' WHERE task_id = 't-plan'");
    let spawned = false;
    const refused = await invokeAgent(store, planner, { provider: "claude", model: "sonnet" }, { phase: "plan", brief: "plan it", maxTurns: 10, permissionMode: "acceptEdits", skipPermissions: false, resumeSession: null }, {
      runner: async () => {
        spawned = true;
        return { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
      },
      keyHome: home,
      clock: () => T0,
    });
    expect(refused).toMatchObject({ kind: "refused", reason: "route-authority", diagnostic: expect.stringMatching(/route authority lapsed before spawn .* recommended for routine risk but the scope's risk level is high/) });
    expect(spawned).toBe(false);
    expect(store.getRun(planner)?.providerStartedAt ?? null).toBeNull();
    // Restored, the same run spawns.
    restore();
    const ran = await invokeAgent(store, planner, { provider: "claude", model: "sonnet" }, { phase: "plan", brief: "plan it", maxTurns: 10, permissionMode: "acceptEdits", skipPermissions: false, resumeSession: null }, {
      runner: async () => {
        spawned = true;
        return { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
      },
      keyHome: home,
      clock: () => T0,
    });
    expect(ran.kind).toBe("ran");
    expect(spawned).toBe(true);
    void scope;
  });

  test("a task with NO scope plans as the word legacy only (final authority closure): a live-recommendation stamp opens nothing, the bare word for the exact pair opens the planner", () => {
    store.createTask({ id: "t-bare", title: "t" }, T0);
    const ref = store.refFor("built-in", "t-bare").id;
    store.placeTask(ref, REPO);
    const live = routeOfTask(store, "t-bare", store.refForId(ref), T0);
    expect(live).toMatchObject({ kind: "route", source: "live" });
    if (live === null || live.kind !== "route") throw new Error("live route");
    expect(store.workingPlanRouteOf("t-bare")).toMatchObject({ ok: false, problem: expect.stringMatching(/has no scope — a planner on it presents the bare word legacy/) });
    expect(() =>
      store.startRun({ taskRef: ref, leaseId: "lease", runner: "r", role: "planner", branch: "b", worktree: "/w", provider: "claude", model: "sonnet", now: T0, route: { routeDigest: routeDigestOf(live.route), phase: "plan", provider: "claude", model: "sonnet", chosen: "recommended" } }),
    ).toThrow(/a task with no scope plans as the word legacy — nothing spends as a routed plan leg on it/);
    expect(() =>
      store.startRun({ taskRef: ref, leaseId: "lease", runner: "r", role: "planner", branch: "b", worktree: "/w", provider: "claude", model: "sonnet", now: T0, route: { routeDigest: "profile:" + "0".repeat(32), phase: "plan", provider: "claude", model: "sonnet", chosen: "legacy" } }),
    ).toThrow(/a task with no scope spends as the word legacy, not under a profile digest/);
    expect(runs()).toBe(0);
    const legacy = store.routeAuthorityFor(ref, "planner", null, { provider: "claude", model: "sonnet" });
    expect(legacy).toMatchObject({ ok: true, stamp: { routeDigest: "legacy", phase: "plan", provider: "claude", model: "sonnet", chosen: "legacy" } });
    if (legacy === null || !legacy.ok) throw new Error("legacy");
    const planner = store.startRun({ taskRef: ref, leaseId: "lease", runner: "r", role: "planner", branch: "b", worktree: "/w", provider: "claude", model: "sonnet", now: T0, route: legacy.stamp });
    expect(store.runRoute(planner)).toMatchObject({ routeDigest: "legacy", chosen: "legacy", phase: "plan" });
  });
});

describe("acceptance rubric on the command line", () => {
  test("a semicolon inside a statement does not split the criterion", async () => {
    const { splitAcceptanceRubric, acceptanceLinesToInput, parseAcceptanceCriteria } = await import("./scope.js");
    const parts = splitAcceptanceRubric("Timeouts yield a notice; assertion failures still repair|check,changed-path;The prompt forbids base comparisons|check");
    expect(parts).toEqual(["Timeouts yield a notice; assertion failures still repair|check,changed-path", "The prompt forbids base comparisons|check"]);
    const parsed = parseAcceptanceCriteria(acceptanceLinesToInput(parts));
    expect(parsed.problems).toEqual([]);
    expect(parsed.criteria.map(c => c.statement)).toEqual(["Timeouts yield a notice; assertion failures still repair", "The prompt forbids base comparisons"]);
  });
  test("`plan` expands to the placeholder rubric the planner replaces", async () => {
    const { splitAcceptanceRubric, acceptanceLinesToInput, parseAcceptanceCriteria, rubricIsPlaceholder, PLACEHOLDER_RUBRIC } = await import("./scope.js");
    const parsed = parseAcceptanceCriteria(acceptanceLinesToInput(splitAcceptanceRubric(" Plan ")));
    expect(parsed.problems).toEqual([]);
    expect(parsed.criteria).toEqual(PLACEHOLDER_RUBRIC);
    expect(rubricIsPlaceholder(parsed.criteria)).toBe(true);
    expect(rubricIsPlaceholder([{ statement: "Real outcome", evidence: ["check"] }])).toBe(false);
    expect(rubricIsPlaceholder([...PLACEHOLDER_RUBRIC, { id: "c2", statement: "Real outcome", how: null, evidence: ["check"] }])).toBe(false);
  });
  test("a statement may run to a thousand bytes", async () => {
    const { acceptanceLinesToInput, parseAcceptanceCriteria, ACCEPTANCE_LIMITS } = await import("./scope.js");
    expect(ACCEPTANCE_LIMITS.statement).toBe(1000);
    const long = "x".repeat(900);
    expect(parseAcceptanceCriteria(acceptanceLinesToInput([`${long}|check`])).problems).toEqual([]);
    expect(parseAcceptanceCriteria(acceptanceLinesToInput([`${"x".repeat(1001)}|check`])).problems.map(p => p.message)).toEqual(["acceptance[0].statement over 1,000 bytes"]);
  });
});

describe("a prepared candidate is signed into the scope (v69)", () => {
  test("the digest folds the commit only when present, so every earlier digest is untouched", async () => {
    const { digestOf } = await import("./scope.js");
    const base = { goal: "Install it", outOfScope: null, touches: ["src/a.ts"] };
    expect(digestOf({ ...base, candidate: null })).toBe(digestOf(base));
    expect(digestOf({ ...base, candidate: "a".repeat(40) })).not.toBe(digestOf(base));
    expect(digestOf({ ...base, candidate: "a".repeat(40) })).not.toBe(digestOf({ ...base, candidate: "b".repeat(40) }));
  });
  test("propose stores it and describeScope names it", async () => {
    const { propose, describeScope } = await import("./scope.js");
    const { openStore } = await import("./store.js");
    const store = openStore(":memory:");
    try {
      store.createTask({ id: "t-c", title: "candidate" }, new Date("2026-09-19T00:00:00.000Z"));
      const scope = propose(store, { taskId: "t-c", goal: "Install commit", candidate: "c".repeat(40), now: new Date("2026-09-19T00:00:00.000Z") });
      expect(scope.candidate).toBe("c".repeat(40));
      expect(store.getScope("t-c")?.candidate).toBe("c".repeat(40));
      expect(describeScope(store.getScope("t-c")!).some(line => line.includes("candidate    " + "c".repeat(40)))).toBe(true);
    } finally { store.close(); }
  });
});
