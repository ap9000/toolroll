/**
 * Easy start: a new laptop install's first routing (model-choices.ts fillDefaultRouting). Choosing the agent fills
 * that agent's default preset only while nothing is set, never overwrites, and is the local owner's one door into
 * models: only its `choose-default-agent` act (or the install's own first start) may use it.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initLocalMode, openStore, type Store } from "./store.js";
import { INSTALLATION_SCOPE } from "./agentconfig.js";
import { asLocalOwner, type LocalOwnerAct, type LocalPrincipal } from "./local-owner.js";
import { agentPresetChange, ALL_SLOTS, applyModelChoices, checkScope, CODEX_FRONTIER, CODEX_SMALL, CODEX_WORKHORSE, fillDefaultRouting, HAIKU, OPUS, presetChange, presetInUse, rowAt, slotKey, SONNET } from "./model-choices.js";
import { addApprover } from "./scope.js";

const T0 = new Date("2026-11-04T12:00:00.000Z");
let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "so-default-routing-"));
  store = openStore(join(dir, "laptop.db"), { createdBy: "laptop" });
  if (!initLocalMode(store, { owner: "alex", fenceAvailable: true, now: T0 }).ok) throw new Error("local mode");
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const owner = (act: LocalOwnerAct, over: Partial<LocalPrincipal> = {}): LocalPrincipal => ({
  account: "alex", localGeneration: 1, accountGeneration: store.accountOf("alex")!.generation, transport: "terminal", act, sessionHash: null, request: null, ...over,
});
const rows = () => Object.fromEntries(ALL_SLOTS.map(slot => [slotKey(slot), rowAt(store, INSTALLATION_SCOPE, slot)]));
const nothingSet = () => ALL_SLOTS.every(slot => rowAt(store, INSTALLATION_SCOPE, slot) === null);

describe("choosing the agent fills its default preset", () => {
  test("Claude Code: Sized by job, every row exact, the result files tasks, each row ledgered", () => {
    expect(nothingSet()).toBe(true);
    const filled = asLocalOwner(owner("choose-default-agent"), () => fillDefaultRouting(store, "claude", "alex", { kind: "local-owner" }, T0));
    expect(filled).toEqual({ filled: true, rows: 7 });
    expect(presetInUse(store, INSTALLATION_SCOPE)).toBe("sized");
    expect(rows()).toMatchObject({ plan: { provider: "claude", model: OPUS }, "build-light": { provider: "claude", model: HAIKU }, build: { provider: "claude", model: SONNET }, "build-strong": { provider: "claude", model: OPUS }, review: { provider: "claude", model: OPUS }, repair: null });
    expect(checkScope(store, null)).toEqual({ kind: "ok" });
    const ledger = store.actionLedger({ repos: null, instance: true, limit: 100 }).filter(one => /agent for .* changed/.test(one.action) && one.outcome === "changed" && one.actor === "alex");
    expect(ledger.length).toBeGreaterThanOrEqual(7);
  });

  test("Codex has a default preset too: sized by job on Codex's own exact ids, and it files tasks", () => {
    expect(agentPresetChange("codex").every(one => one.to === null || one.to.provider === "codex")).toBe(true);
    const filled = asLocalOwner(owner("choose-default-agent"), () => fillDefaultRouting(store, "codex", "alex", { kind: "local-owner" }, T0));
    expect(filled).toEqual({ filled: true, rows: 7 });
    expect(rows()).toMatchObject({ plan: { provider: "codex", model: CODEX_FRONTIER }, "build-light": { provider: "codex", model: CODEX_SMALL }, build: { provider: "codex", model: CODEX_WORKHORSE },
      "build-strong": { provider: "codex", model: CODEX_FRONTIER }, review: { provider: "codex", model: CODEX_FRONTIER }, "review-strong": { provider: "codex", model: CODEX_FRONTIER }, repair: null });
    expect(checkScope(store, null)).toEqual({ kind: "ok" });
  });

  test("a laptop install's first start fills it too (no person's chain), while local mode is on", () => {
    expect(fillDefaultRouting(store, "claude", "toolroll", { kind: "first-start" }, T0)).toEqual({ filled: true, rows: 7 });
    expect(presetInUse(store, INSTALLATION_SCOPE)).toBe("sized");
  });
});

describe("never overwrites", () => {
  test("a role already chosen: nothing changes, whichever agent is chosen", () => {
    store.setPhaseConfig(INSTALLATION_SCOPE, "build", "codex", CODEX_WORKHORSE, "alex", T0);
    const before = rows();
    for (const agent of ["claude", "codex"] as const) {
      expect(asLocalOwner(owner("choose-default-agent"), () => fillDefaultRouting(store, agent, "alex", { kind: "local-owner" }, T0))).toMatchObject({ filled: false, reason: "already-set" });
      expect(fillDefaultRouting(store, agent, "toolroll", { kind: "first-start" }, T0)).toMatchObject({ filled: false, reason: "already-set" });
    }
    expect(rows()).toEqual(before);
  });

  test("a project's own row, or an other-provider candidate, counts as set too", () => {
    store.setPhaseConfig("/repo/shop", "build", "claude", SONNET, "alex", T0);
    expect(fillDefaultRouting(store, "claude", "toolroll", { kind: "first-start" }, T0)).toMatchObject({ filled: false, reason: "already-set" });
    expect(nothingSet()).toBe(true);
    store.clearPhaseConfig("/repo/shop", "build");
    store.setPhaseTierAlternate(INSTALLATION_SCOPE, "build", "strong", "codex", CODEX_FRONTIER, "alex", T0);
    expect(fillDefaultRouting(store, "claude", "toolroll", { kind: "first-start" }, T0)).toMatchObject({ filled: false, reason: "already-set" });
    expect(nothingSet()).toBe(true);
  });

  test("filled once, a second choice of the other agent leaves the first preset as it is", () => {
    expect(fillDefaultRouting(store, "claude", "toolroll", { kind: "first-start" }, T0)).toMatchObject({ filled: true });
    const before = rows();
    expect(asLocalOwner(owner("choose-default-agent"), () => fillDefaultRouting(store, "codex", "alex", { kind: "local-owner" }, T0))).toMatchObject({ filled: false, reason: "already-set" });
    expect(rows()).toEqual(before);
  });
});

describe("the local owner may only make this narrow fill", () => {
  test("any other act, another account, a stale generation or a chain outside a principal is refused, and writes nothing", () => {
    for (const act of ["file-task", "approve-plan", "add-project", "read", "lead-send"] as const) {
      expect(asLocalOwner(owner(act), () => fillDefaultRouting(store, "claude", "alex", { kind: "local-owner" }, T0)), act).toMatchObject({ filled: false, reason: "authority" });
    }
    expect(asLocalOwner(owner("choose-default-agent"), () => fillDefaultRouting(store, "claude", "robin", { kind: "local-owner" }, T0))).toMatchObject({ filled: false, reason: "authority" });
    expect(asLocalOwner(owner("choose-default-agent", { request: { ended: true } }), () => fillDefaultRouting(store, "claude", "alex", { kind: "local-owner" }, T0))).toMatchObject({ filled: false, reason: "authority" });
    expect(() => asLocalOwner(owner("choose-default-agent", { localGeneration: 2 }), () => fillDefaultRouting(store, "claude", "alex", { kind: "local-owner" }, T0))).toThrow();
    expect(fillDefaultRouting(store, "claude", "alex", { kind: "local-owner" }, T0)).toMatchObject({ filled: false, reason: "authority" });
    expect(nothingSet()).toBe(true);
  });

  test("the first-start door needs local mode on", () => {
    const plain = openStore(join(dir, "plain.db"));
    try {
      expect(fillDefaultRouting(plain, "claude", "toolroll", { kind: "first-start" }, T0)).toMatchObject({ filled: false, reason: "authority" });
      expect(ALL_SLOTS.every(slot => rowAt(plain, INSTALLATION_SCOPE, slot) === null)).toBe(true);
    } finally { plain.close(); }
  });

  test("Settings → Models' own write still refuses the local owner (no password-now proof), even for the same preset", () => {
    const refused = asLocalOwner(owner("choose-default-agent"), () => applyModelChoices(store, { scope: INSTALLATION_SCOPE, change: presetChange("sized"), expected: null, strict: true, knownProject: () => false },
      { actor: "alex", generation: store.accountOf("alex")!.generation, method: "local-owner", live: () => true }, T0));
    expect(refused).toMatchObject({ ok: false, reason: "authority" });
    expect(nothingSet()).toBe(true);
  });

  test("a full installation (no local mode) is unchanged: nothing fills, the first start included", () => {
    const full = openStore(join(dir, "full.db"));
    try {
      if (!addApprover(full, "sam", T0).ok) throw new Error("sam");
      expect(fillDefaultRouting(full, "claude", "toolroll", { kind: "first-start" }, T0)).toMatchObject({ filled: false, reason: "authority" });
      expect(fillDefaultRouting(full, "claude", "sam", { kind: "local-owner" }, T0)).toMatchObject({ filled: false, reason: "authority" });
    } finally { full.close(); }
  });
});
