/**
 * Settings → Models' one write path (docs/plans/spend-dashboard.md slice 3): the actor re-proved inside the
 * transaction, stale forms refused, a preset all-or-nothing, every row and clear ledgered before → after, the result
 * validated with inheritance, and sealed work untouched.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, BUILT_IN, type Store } from "./store.js";
import { addApprover, approve, propose } from "./scope.js";
import { INSTALLATION_SCOPE, resolveAgentAuthority } from "./agentconfig.js";
import { applyModelChoices, changeDigest, HAIKU, OPUS, presetChange, presetInUse, rowAt, SONNET, stateDigest, switchChange, type ApplyInput, type ModelAuthority, type ModelChange } from "./model-choices.js";
import { runOperate } from "./operate.js";

const T0 = new Date("2026-10-31T12:00:00.000Z");
const REPO = "/repo/shop";
let store: Store;
let token: string;
let dir: string, file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "so-model-choices-"));
  file = join(dir, "orders.db");
  store = openStore(file);
  const alex = addApprover(store, "alex", T0);
  if (!alex.ok) throw new Error("alex");
  token = alex.token;
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const operator = (over: Partial<ModelAuthority> = {}): ModelAuthority => ({ actor: "alex", generation: store.accountOf("alex")!.generation, live: () => true, ...over });
const input = (change: readonly ModelChange[], over: Partial<ApplyInput> = {}, scope = INSTALLATION_SCOPE): ApplyInput =>
  ({ scope, change, expected: { state: stateDigest(store, scope), change: changeDigest(scope, change) }, strict: true, knownProject: repo => repo === REPO, ...over });
const policyEntries = () => store.actionLedger({ repos: null, instance: true, limit: 100 }).filter(one => one.source === "policy").map(one => `${one.action}: ${one.detail}`).sort();
/** Every table but the editor's own rows, the ledger and SQLite's and the live view's counters, as stored. */
const everythingElse = () => Object.fromEntries((store.raw().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('phase_config','phase_tier_config','service_cursor','sqlite_sequence') AND name NOT LIKE '%ledger%' ORDER BY name").all() as { name: string }[])
  .map(({ name }) => [name, JSON.stringify(store.raw().prepare(`SELECT * FROM "${name}"`).all())]));

describe("who may write", () => {
  test("only a live instance operator at the generation they proved; nothing is written otherwise", () => {
    const sam = addApprover(store, "sam", T0, { name: "alex", token });
    if (!sam.ok) throw new Error("sam");
    expect(store.setAccountProjects("sam", [REPO], "alex", T0)).toEqual({ ok: true });
    const change = presetChange("sized");
    const refused = [
      operator({ live: () => false }), // the session ended between the password and the write
      operator({ generation: store.accountOf("alex")!.generation - 1 }), // the credential rotated in between
      { actor: "sam", generation: store.accountOf("sam")!.generation, live: () => true }, // a project approver, not an operator
      { actor: "nobody", generation: 0, live: () => true },
    ];
    for (const authority of refused) expect(applyModelChoices(store, input(change), authority, T0)).toMatchObject({ ok: false, reason: "authority" });
    expect(store.listPhaseConfig(INSTALLATION_SCOPE)).toEqual([]);
    expect(policyEntries()).toEqual([]);
  });

  test("an unknown project is refused; a stale state or a different change than previewed writes nothing", () => {
    const change = presetChange("sized");
    expect(applyModelChoices(store, input(change, {}, "/elsewhere"), operator(), T0)).toMatchObject({ ok: false, reason: "unknown-project" });
    const seen = input(change);
    store.setPhaseConfig(INSTALLATION_SCOPE, "plan", "claude", "claude-opus-5-5", "alex", T0); // another tab saved first
    expect(applyModelChoices(store, seen, operator(), T0)).toMatchObject({ ok: false, reason: "stale" });
    expect(applyModelChoices(store, input(change, { expected: { state: stateDigest(store, INSTALLATION_SCOPE), change: changeDigest(INSTALLATION_SCOPE, presetChange("opus")) } }), operator(), T0)).toMatchObject({ ok: false, reason: "stale" });
    expect(store.listPhaseConfig(INSTALLATION_SCOPE).map(one => one.phase)).toEqual(["plan"]);
    // A project's form is stale when the installation rows it inherits move, even with its own rows unchanged.
    const projectForm = input(change, {}, REPO);
    store.setPhaseTierConfig(INSTALLATION_SCOPE, "build", "light", "claude", HAIKU, "alex", T0);
    expect(applyModelChoices(store, projectForm, operator(), T0)).toMatchObject({ ok: false, reason: "stale" });
    expect(store.listPhaseConfig(REPO)).toEqual([]);
  });
});

describe("a preset", () => {
  test("writes exactly its table as exact ids, ledgers every row and clear, and `config show --json` reads them back", async () => {
    store.setPhaseConfig(INSTALLATION_SCOPE, "repair", "claude", "sonnet", "alex", T0);
    const result = applyModelChoices(store, input(presetChange("sized")), operator(), T0);
    expect(result).toMatchObject({ ok: true, unresolved: null });
    expect(presetInUse(store, INSTALLATION_SCOPE)).toBe("sized");
    expect(Object.fromEntries(store.listPhaseConfig(INSTALLATION_SCOPE).map(one => [one.phase, `${one.provider}:${one.model}`]))).toEqual({ plan: `claude:${OPUS}`, build: `claude:${SONNET}`, review: `claude:${OPUS}` });
    expect(store.listPhaseTierConfig(INSTALLATION_SCOPE).map(one => `${one.phase}-${one.tier}:${one.model}`)).toEqual([`build-light:${HAIKU}`, `build-strong:${OPUS}`, `plan-strong:${OPUS}`]);
    expect(policyEntries()).toEqual([
      `agent for build changed: not set → claude · ${SONNET}`,
      `agent for plan changed: not set → claude · ${OPUS}`,
      "agent for repair changed: claude · sonnet → not set",
      "agent for repair changed: not set → claude · sonnet", // the setup above
      `agent for review changed: not set → claude · ${OPUS}`,
      `light agent for build changed: not set → claude · ${HAIKU}`,
      `strong agent for build changed: not set → claude · ${OPUS}`,
      `strong agent for plan changed: not set → claude · ${OPUS}`,
    ].sort());
    const lines: string[] = [];
    expect(await runOperate("config", ["show", "--json"], line => lines.push(line), { databaseFile: file, now: T0 })).toBe(0);
    const shown = JSON.parse(lines.join("\n")) as { resolved: { phase: string; model: string }[]; installationStrong: { phase: string; tier: string; model: string }[] };
    expect(shown.resolved.map(one => `${one.phase}:${one.model}`)).toEqual([`plan:${OPUS}`, `build:${SONNET}`, "repair:null", `review:${OPUS}`]);
    expect(shown.installationStrong.map(one => `${one.phase}-${one.tier}:${one.model}`)).toEqual([`build-light:${HAIKU}`, `build-strong:${OPUS}`, `plan-strong:${OPUS}`]);
    // Applied again, nothing moves and nothing more is ledgered.
    const again = applyModelChoices(store, input(presetChange("sized")), operator(), T0);
    expect(again).toMatchObject({ ok: true, diff: [] });
    expect(policyEntries()).toHaveLength(8);
  });

  test("is all or nothing: a bad last row writes none of the rows before it", () => {
    const change: ModelChange[] = [...presetChange("opus").slice(0, -1), { slot: { phase: "review", tier: "routine" }, to: { provider: "gemini", model: "gemini-2.5-pro" } }];
    expect(applyModelChoices(store, input(change), operator(), T0)).toMatchObject({ ok: false, reason: "invalid" });
    expect(store.listPhaseConfig(INSTALLATION_SCOPE)).toEqual([]);
    expect(store.listPhaseTierConfig(INSTALLATION_SCOPE)).toEqual([]);
    expect(policyEntries()).toEqual([]);
  });

  test("the result is checked with inheritance: an installation change can't break a project that inherits from it", () => {
    expect(applyModelChoices(store, input(presetChange("sized")), operator(), T0)).toMatchObject({ ok: true });
    // The project keeps Claude repairs of its own; moving the installation's builder to Codex would orphan them.
    store.setPhaseConfig(REPO, "repair", "claude", SONNET, "alex", T0);
    const codex: ModelChange[] = [{ slot: { phase: "build", tier: "routine" }, to: { provider: "codex", model: "gpt-5-codex" } }];
    expect(applyModelChoices(store, input(codex), operator(), T0)).toMatchObject({ ok: false, reason: "invalid", problem: expect.stringContaining(REPO) });
    expect(rowAt(store, INSTALLATION_SCOPE, { phase: "build", tier: "routine" })).toEqual({ provider: "claude", model: SONNET });
    // A project inherits the installation's light and strong builders until it sets its own.
    const resolved = resolveAgentAuthority(store, REPO, [], T0);
    expect(resolved.ok).toBe(true);
  });

  test("switch to a newer model rewrites only the rows that named the old one", () => {
    applyModelChoices(store, input(presetChange("sized")), operator(), T0);
    const change = switchChange(store, INSTALLATION_SCOPE, OPUS, "claude-opus-6");
    expect(change.map(one => `${one.slot.phase}-${one.slot.tier}`)).toEqual(["plan-routine", "plan-strong", "build-strong", "review-routine"]);
    expect(applyModelChoices(store, input(change), operator(), T0)).toMatchObject({ ok: true });
    expect(rowAt(store, INSTALLATION_SCOPE, { phase: "build", tier: "routine" })).toEqual({ provider: "claude", model: SONNET });
    expect(rowAt(store, INSTALLATION_SCOPE, { phase: "plan", tier: "routine" })).toEqual({ provider: "claude", model: "claude-opus-6" });
  });
});

describe("sealed work stays sealed", () => {
  test("a preset, a switch and a project override leave a filed and approved scope, its route and its next run's stamp byte-identical; a new filing gets the new choice", () => {
    for (const phase of ["plan", "build", "review"] as const) store.setPhaseConfig(INSTALLATION_SCOPE, phase, "claude", "sonnet", "alex", T0);
    store.setPhaseConfig(INSTALLATION_SCOPE, "repair", "claude", "haiku", "alex", T0);
    store.createTask({ id: "sealed", title: "sealed" }, T0);
    const ref = store.refFor(BUILT_IN, "sealed").id;
    store.placeTask(ref, REPO);
    propose(store, { taskId: "sealed", goal: "keep me", now: T0 });
    expect(approve(store, "sealed", "alex", T0, store.getScope("sealed")!.digest, token).ok).toBe(true);
    // A second task, filed and still waiting for approval: also untouched.
    store.createTask({ id: "waiting", title: "waiting" }, T0);
    store.placeTask(store.refFor(BUILT_IN, "waiting").id, REPO);
    propose(store, { taskId: "waiting", goal: "wait for me", now: T0 });
    const scope = store.getScope("sealed")!;
    const sealed = { profile: JSON.stringify(scope.approvedProfile), digest: scope.approvedDigest, repair: scope.approvedProfile?.repairModel, route: JSON.stringify(store.sealedRouteOf("sealed")),
      builder: JSON.stringify(store.routeAuthorityFor(ref, "builder")), repairStamp: JSON.stringify(store.routeAuthorityFor(ref, "repair")) };
    expect(sealed.repair).toBe("haiku");
    const before = everythingElse();

    expect(applyModelChoices(store, input(presetChange("opus")), operator(), T0)).toMatchObject({ ok: true });
    expect(applyModelChoices(store, input(switchChange(store, INSTALLATION_SCOPE, OPUS, "claude-opus-6")), operator(), T0)).toMatchObject({ ok: true });
    expect(applyModelChoices(store, input([{ slot: { phase: "build", tier: "routine" }, to: { provider: "claude", model: HAIKU } }], {}, REPO), operator(), T0)).toMatchObject({ ok: true });

    const after = store.getScope("sealed")!;
    expect({ profile: JSON.stringify(after.approvedProfile), digest: after.approvedDigest, repair: after.approvedProfile?.repairModel, route: JSON.stringify(store.sealedRouteOf("sealed")),
      builder: JSON.stringify(store.routeAuthorityFor(ref, "builder")), repairStamp: JSON.stringify(store.routeAuthorityFor(ref, "repair")) }).toEqual(sealed);
    expect(everythingElse()).toEqual(before);
    // New filings use the new choice.
    const fresh = resolveAgentAuthority(store, REPO, [], T0);
    if (!fresh.ok) throw new Error(fresh.problem);
    expect(fresh.profile).toMatchObject({ provider: "claude", model: HAIKU });
  });
});

describe("the command line", () => {
  test("goes through the same write path: tier rows and clears are ledgered, and a project approver is refused", async () => {
    const lines: string[] = [];
    const cli = (args: string[]) => runOperate("config", args, line => lines.push(line), { databaseFile: file, now: T0 });
    expect(await cli(["set", "build", "--tier", "light", "--provider", "claude", "--model", HAIKU, "--as", "alex", "--token", token, "--json"])).toBe(0);
    expect(await cli(["clear", "build", "--tier", "light", "--as", "alex", "--token", token, "--json"])).toBe(0);
    expect(policyEntries()).toEqual([`light agent for build changed: claude · ${HAIKU} → not set`, `light agent for build changed: not set → claude · ${HAIKU}`]);
    const sam = addApprover(store, "sam", T0, { name: "alex", token });
    if (!sam.ok) throw new Error("sam");
    expect(store.setAccountProjects("sam", [REPO], "alex", T0)).toEqual({ ok: true });
    expect(await cli(["set", "build", "--provider", "claude", "--model", SONNET, "--repo", REPO, "--as", "sam", "--token", sam.token, "--json"])).not.toBe(0);
    expect(store.listPhaseConfig(REPO)).toEqual([]);
  });
});
