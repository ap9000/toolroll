/**
 * Schema v47 adds the phase route beside every other digest-bound field —
 * additively. A scope approved under v46 keeps its exact digest, reads back
 * as routine risk with no route, and its sealed profile remains the whole
 * authority for its build; the three new tables arrive by IF NOT EXISTS.
 */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, SCHEMA_VERSION, type Store } from "./store.js";
import { addApprover, approve, approvalOf, digestOf, propose } from "./scope.js";
import { proveApprovedProfile } from "./builder.js";
import { register } from "./runner.js";
import { routeFromJson } from "./phase-routing.js";

const T0 = new Date("2026-09-10T12:00:00.000Z");

function file(store: Store, taskId: string, size?: "small" | "medium" | "large"): void {
  store.createTask({ id: taskId, title: taskId }, T0);
  const ref = store.refFor("built-in", taskId);
  store.placeTask(ref.id, "/repo/app");
  if (size !== undefined) store.writeSizing(ref.id, { size, risky: false, source: "person", reason: "" });
  propose(store, {
    taskId,
    goal: "ship it",
    acceptance: [{ id: "c1", statement: "it ships", how: null, evidence: ["check"] }],
    now: T0,
  });
}

describe("schema v47: explainable phase routing is additive", () => {
  let dir: string | undefined;
  let store: Store | null = null;

  afterEach(() => {
    store?.close();
    store = null;
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test("a v46 database migrates: legacy approvals keep their digest, read as routine with no route, and still prove for dispatch", () => {
    dir = mkdtempSync(join(tmpdir(), "standing-orders-v47-"));
    const db = join(dir, "orders.db");
    store = openStore(db);
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", T0); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", T0);
    const added = addApprover(store, "alex", T0, undefined, () => "tok-alex");
    expect(added.ok).toBe(true);
    file(store, "legacy");
    const filed = store.getScope("legacy")!;
    const sealed = approve(store, "legacy", "alex", T0, filed.digest, "tok-alex");
    expect(sealed.ok).toBe(true);

    // Wind the file back to the v46 shape: drop every v47 column and table,
    // and store the digest a v46 filing would have bound — fields plus the
    // profile, no route (v47 folds the route into every fresh digest, so
    // the seeded one must be rewritten to look like a real v46 row).
    const raw = store.raw();
    const legacyScope = store.getScope("legacy")!;
    const digestBefore = digestOf({ goal: legacyScope.goal, outOfScope: legacyScope.outOfScope, touches: legacyScope.touches, budgetMicrousd: legacyScope.budgetMicrousd, acceptance: legacyScope.acceptance }, legacyScope.approvedProfile ?? null);
    raw.prepare("UPDATE task_scope SET digest = ?, approved_digest = ? WHERE task_id = 'legacy'").run(digestBefore, digestBefore);
    raw.exec("ALTER TABLE task_scope DROP COLUMN risk_level");
    raw.exec("ALTER TABLE task_scope DROP COLUMN proposed_route_json");
    raw.exec("ALTER TABLE task_scope DROP COLUMN approved_route_json");
    raw.exec("ALTER TABLE task_scope DROP COLUMN route_era");
    raw.exec("ALTER TABLE task_ref DROP COLUMN risk_level");
    raw.exec("ALTER TABLE task_ref DROP COLUMN route_overrides_json");
    raw.exec("ALTER TABLE review_request DROP COLUMN route_digest");
    raw.exec("DROP TABLE phase_tier_config");
    raw.exec("DROP TABLE provider_readiness");
    raw.exec("DROP TABLE run_route");
    raw.exec("DROP TABLE service_cursor");
    raw.prepare("UPDATE schema_version SET version = 46").run();
    store.close();
    store = null;

    store = openStore(db);
    expect(store.raw().prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(SCHEMA_VERSION);
    for (const table of ["phase_tier_config", "provider_readiness", "run_route"]) {
      expect(store.raw().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)).toBeDefined();
    }
    const scope = store.getScope("legacy")!;
    expect(scope.digest).toBe(digestBefore);
    expect(scope.riskLevel).toBe("routine");
    expect(scope.proposedRouteJson).toBeNull();
    expect(scope.approvedRouteJson).toBeNull();
    // The durable era marker is NULL: this row is PROVEN to predate routing.
    expect(scope.routeEra).toBeNull();
    expect(approvalOf(scope).approved).toBe(true);
    expect(store.sealedRouteOf("legacy")).toMatchObject({ ok: false, reason: "legacy" });
    expect(store.refFor("built-in", "legacy")).toMatchObject({ routeOverrides: [] });
    // The sealed profile alone governs a legacy build — exactly as before.
    const proof = proveApprovedProfile(scope, { provider: "claude", model: "sonnet", maxTurns: undefined, timeoutMs: undefined, skipPermissions: false });
    expect(proof.ok).toBe(true);
    // Once re-filed, the row joins the routed era: the digest now binds the
    // exact route, and the approval must be given again.
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", T0);
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", T0);
    const refiled = store.refileScope("legacy", T0)!;
    expect(refiled.routeEra).toBe(1);
    expect(refiled.digest).not.toBe(digestBefore);
    expect(approvalOf(refiled).approved).toBe(false);
  });

  test("a routed row that loses its route data fails closed — never a downgrade to the legacy road", () => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", T0);
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", T0);
    const added = addApprover(store, "alex", T0, undefined, () => "tok-alex");
    expect(added.ok).toBe(true);
    file(store, "routed");
    const filed = store.getScope("routed")!;
    expect(approve(store, "routed", "alex", T0, filed.digest, "tok-alex").ok).toBe(true);
    expect(store.sealedRouteOf("routed").ok).toBe(true);
    const sealedProfile = { provider: "claude" as const, model: "sonnet", maxTurns: undefined, timeoutMs: undefined, skipPermissions: false };
    expect(proveApprovedProfile(store.getScope("routed"), sealedProfile).ok).toBe(true);
    // Removed route data: the approval no longer proves anything.
    store.raw().prepare("UPDATE task_scope SET approved_route_json = NULL WHERE task_id = 'routed'").run();
    expect(store.sealedRouteOf("routed")).toMatchObject({ ok: false, reason: "unreadable" });
    const removed = proveApprovedProfile(store.getScope("routed"), sealedProfile);
    expect(removed.ok).toBe(false);
    if (!removed.ok) expect(removed.message).toContain("stale-approval");
    // Malformed route data: the same closed door.
    store.raw().prepare("UPDATE task_scope SET approved_route_json = '{\"version\":1,\"legs\":[]}' WHERE task_id = 'routed'").run();
    expect(store.sealedRouteOf("routed")).toMatchObject({ ok: false, reason: "unreadable" });
    expect(proveApprovedProfile(store.getScope("routed"), sealedProfile).ok).toBe(false);
    // A sealed route whose build leg disagrees with the sealed profile.
    store.raw().prepare("UPDATE task_scope SET approved_route_json = proposed_route_json, approved_profile_json = REPLACE(approved_profile_json, '\"model\":\"sonnet\"', '\"model\":\"haiku\"') WHERE task_id = 'routed'").run();
    expect(store.sealedRouteOf("routed")).toMatchObject({ ok: false, reason: "unreadable" });
  });

  test("a fresh v47 scope files a canonical, exact route with the era marker; the same terms digest the same; size moves the digest", () => {
    store = openStore(":memory:");
    store.setPhaseConfig("installation", "build", "claude", "sonnet", "test", T0);
    store.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", T0); // v47: every phase names an exact model
    store.setPhaseConfig("installation", "review", "claude", "sonnet", "test", T0);
    file(store, "plain");
    const plain = store.getScope("plain")!;
    const route = routeFromJson(plain.proposedRouteJson ?? null);
    expect(route).not.toBeNull();
    expect(plain.routeEra).toBe(1);
    expect(route!.legs.map(leg => [leg.phase, leg.provider, leg.model])).toEqual([
      ["plan", "claude", "sonnet"],
      ["build", "claude", "sonnet"],
      ["repair", "claude", "sonnet"],
      ["review", "claude", "sonnet"],
    ]);
    // Same terms, same route, same digest — deterministic.
    file(store, "twin");
    expect(store.getScope("twin")!.digest).toBe(plain.digest);
    // The size rides the route, a signed term: the digest moves. Every route files at routine risk.
    file(store, "large", "large");
    const large = store.getScope("large")!;
    expect(large.riskLevel).toBe("routine");
    expect(large.digest).not.toBe(plain.digest);
  });

  test("runner readiness rows are per runner and survive reopen; a cascade removes a retired runner's rows", () => {
    dir = mkdtempSync(join(tmpdir(), "standing-orders-v47-readiness-"));
    const db = join(dir, "orders.db");
    store = openStore(db);
    register(store, { name: "mac-mini", host: "h", repos: ["/repo/app"], now: T0 });
    store.recordProviderReadiness(
      "mac-mini",
      [
        { provider: "codex", state: "unavailable", reason: "not logged in", probe: "identity" },
        { provider: "claude", state: "unknown", reason: "no non-spending login check exists", probe: "version" },
      ],
      T0,
    );
    store.close();
    store = openStore(db);
    expect(store.runnerReadinessOf("mac-mini", "codex")).toMatchObject({ state: "unavailable", reason: "not logged in", observedAt: T0.toISOString() });
    expect(store.runnerReadinessOf("mac-mini", "gemini")).toBeNull();
    const lookup = store.readinessLookupFor("/repo/app", null, T0);
    expect(lookup("claude")?.state).toBe("unknown");
    expect(lookup("codex")?.runner).toBe("mac-mini");
    expect(lookup("openrouter")).toBeNull();
    // A newer observation replaces the older one for the same runner.
    store.recordProviderReadiness("mac-mini", [{ provider: "codex", state: "ready", reason: "logged in as ops", probe: "identity" }], new Date(T0.getTime() + 60_000));
    expect(store.runnerReadinessOf("mac-mini", "codex")?.state).toBe("ready");
    expect(store.providerReadiness("mac-mini")).toHaveLength(2);
  });
});
