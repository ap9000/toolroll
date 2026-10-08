/**
 * Sized routing (route v2): small changes build on the light tier with no
 * plan, large or risky ones plan and build on the strong tier, a phase with
 * candidates on both providers moves off a provider past its plan limits,
 * and every one of those choices is sealed with its reason. v1 routes still
 * read back exactly.
 */
import { describe, expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalRouteJson,
  headroomFrom,
  legOf,
  NO_READINESS,
  projectRoute,
  recommendRoute,
  routeDigestOf,
  routeFromJson,
  routeWords,
  makesNoPlan,
  ROUTE_VERSION,
  type RouteCandidates,
  type RouteInput,
  type TaskSizing,
} from "./phase-routing.js";
import { openStore } from "./store.js";
import { agentChoicesFor, resolveRouteCandidates } from "./agentconfig.js";

const T0 = new Date("2026-10-04T12:00:00.000Z");
const c = (provider: "claude" | "codex", model: string, source = "installation") => ({ provider, model, source });

function candidates(options: { light?: boolean; strong?: boolean; strongPlanCodex?: boolean } = {}): RouteCandidates {
  const strong = options.strong === false ? null : c("claude", "opus", "installation (strong)");
  return {
    plan: { routine: c("claude", "sonnet"), strong: options.strongPlanCodex === true ? c("codex", "gpt-5", "installation (strong)") : strong },
    build: { routine: c("claude", "sonnet"), strong, ...(options.light === false ? {} : { light: c("claude", "haiku", "installation (light)") }) },
    repair: { routine: null, strong: null },
    review: { routine: c("claude", "sonnet"), strong: null },
  };
}

const sized = (size: TaskSizing["size"], risky = false): TaskSizing => ({ size, risky, source: "classifier", reason: "copy change in one file" });

function input(over: Partial<RouteInput> = {}): RouteInput {
  return { risk: "routine", qualityMode: "default", evidence: ["check"], publication: "none", candidates: candidates(), overrides: [], ...over };
}

describe("tiers by size", () => {
  test("a small change builds on the light tier, makes no plan, and the card says so with the reason", () => {
    const route = recommendRoute(input({ size: sized("small") }));
    expect(route.version).toBe(ROUTE_VERSION);
    const build = legOf(route, "build");
    expect([build.provider, build.model, build.tier]).toEqual(["claude", "haiku", "light"]);
    expect(build.reasons[0]).toBe("small change — a fast model builds it and no plan is made");
    expect(legOf(route, "plan").reasons[0]).toBe("small change — no plan is made");
    // Repairs resume the light builder's session on its own model.
    expect(legOf(route, "repair").model).toBe("haiku");
    const projection = projectRoute(route, NO_READINESS);
    expect(projection.sizeWords).toBe("Small change: fast model, no plan");
    expect(projection.sizeReason).toBe("copy change in one file · sized automatically");
    expect(projection.postureWords).toBe("a fast configured agent");
    // No planner works on it, so the summary names only the builder.
    expect(projection.summary).toBe("claude · haiku builds and repairs");
    expect(routeWords(projection)).toContain("  size         Small change: fast model, no plan — copy change in one file · sized automatically");
  });

  test("a small change with no light agent configured keeps the everyday builder and says why", () => {
    const route = recommendRoute(input({ size: sized("small"), candidates: candidates({ light: false }) }));
    expect(legOf(route, "build")).toMatchObject({ model: "sonnet", tier: "routine" });
    expect(legOf(route, "build").reasons[0]).toContain("no light builder is configured");
    expect(projectRoute(route, NO_READINESS).sizeWords).toBe("Small change: everyday model, no plan");
  });

  test("medium keeps the everyday agents; large and risky plan and build on the strong tier", () => {
    const medium = recommendRoute(input({ size: sized("medium") }));
    expect(["plan", "build"].map(phase => legOf(medium, phase as "plan").tier)).toEqual(["routine", "routine"]);
    expect(projectRoute(medium, NO_READINESS).sizeWords).toBe("Medium change: everyday agents");
    for (const one of [sized("large"), sized("medium", true), sized("small", true)]) {
      const route = recommendRoute(input({ size: one }));
      expect(legOf(route, "plan")).toMatchObject({ model: "opus", tier: "strong" });
      expect(legOf(route, "build")).toMatchObject({ model: "opus", tier: "strong" });
      expect(route.posture).toBe("strong");
    }
    expect(projectRoute(recommendRoute(input({ size: sized("large") })), NO_READINESS).sizeWords).toBe("Large change: strongest agents plan and build");
    expect(recommendRoute(input({ size: sized("medium", true) })).demands).toContain("a risky change — planning and building use the strongest configured agent");
  });

  test("elevated risk also lifts planning and building", () => {
    const route = recommendRoute(input({ risk: "elevated" }));
    expect(legOf(route, "plan").tier).toBe("strong");
    expect(legOf(route, "build").tier).toBe("strong");
    expect(route.demands[0]).toBe("risk is elevated — planning and building use the strongest configured agent");
  });

  test("route headers name risky sizing without changing the declared risk or sealed route", () => {
    for (const size of ["small", "medium", "large"] as const) {
      const route = recommendRoute(input({ size: sized(size, true) }));
      const sealed = canonicalRouteJson(route);
      const projection = projectRoute(route, NO_READINESS);
      expect(projection).toMatchObject({ risk: "routine", riskTitle: "Risky", digest: routeDigestOf(route) });
      expect(routeWords(projection)[0]).toContain("route        risky · stronger configured agents");
      expect(canonicalRouteJson(route)).toBe(sealed);
    }
    expect(projectRoute(recommendRoute(input({ size: sized("large") })), NO_READINESS).riskTitle).toBe("Routine");
    expect(projectRoute(recommendRoute(input()), NO_READINESS).riskTitle).toBe("Routine");
    for (const risk of ["elevated", "high"] as const) {
      expect(projectRoute(recommendRoute(input({ risk, size: sized("small", true) })), NO_READINESS).riskTitle)
        .toBe(risk === "high" ? "High risk" : "Elevated risk");
    }
  });

  test("a demanding fact outranks a small size, and a person's override outranks the tier", () => {
    const strict = recommendRoute(input({ size: sized("small"), qualityMode: "strict" }));
    expect(legOf(strict, "build").tier).toBe("strong");
    // The card names what actually runs.
    expect(projectRoute(strict, NO_READINESS).sizeWords).toBe("Small change: strongest model, no plan");
    const overridden = recommendRoute(input({ size: sized("small"), overrides: [{ phase: "build", provider: "claude", model: "sonnet", by: "alex", at: T0.toISOString() }] }));
    expect(legOf(overridden, "build")).toMatchObject({ model: "sonnet", chosen: "override", recommended: { model: "haiku", tier: "light" } });
  });

  test("elevated or high risk plans a small change too, and the card says so", () => {
    for (const risk of ["elevated", "high"] as const) {
      const route = recommendRoute(input({ risk, size: sized("small") }));
      expect(legOf(route, "plan")).toMatchObject({ model: "opus", tier: "strong" });
      expect(legOf(route, "plan").reasons[0]).not.toContain("no plan");
      const projection = projectRoute(route, NO_READINESS);
      expect(projection.sizeWords).toBe("Small change: strongest agents plan and build");
      // The planner works on it, so the summary names it.
      expect(projection.summary).toBe("claude · opus plans, builds, and repairs");
    }
    expect(makesNoPlan(sized("small"), "routine")).toBe(true);
    expect(makesNoPlan(sized("small"), "elevated")).toBe(false);
    expect(makesNoPlan(sized("small", true), "routine")).toBe(false);
    expect(makesNoPlan(null, "routine")).toBe(false);
  });

  test("an unsized task routes exactly as before", () => {
    const route = recommendRoute(input());
    expect(route.size).toBeNull();
    expect(legOf(route, "build")).toMatchObject({ model: "sonnet", tier: "routine" });
    expect(projectRoute(route, NO_READINESS).sizeWords).toBeNull();
  });
});

describe("plan headroom", () => {
  const room = (claude: [number | null, number | null], codex: [number | null, number | null]) => [
    { provider: "claude" as const, fiveHour: claude[0], weekly: claude[1] },
    { provider: "codex" as const, fiveHour: codex[0], weekly: codex[1] },
  ];
  const both = (): RouteCandidates => ({
    plan: { routine: c("claude", "sonnet"), strong: c("codex", "gpt-5", "installation (strong)") },
    build: { routine: c("claude", "sonnet"), strong: c("codex", "gpt-5-codex", "installation (strong)") },
    repair: { routine: c("claude", "sonnet"), strong: null },
    review: { routine: c("claude", "sonnet"), strong: null },
  });

  test("a provider past 80% of its 5-hour window gives the phase to the other provider, sealed with the reason", () => {
    const route = recommendRoute(input({ candidates: both(), headroom: room([86, 40], [3, 1]) }));
    const build = legOf(route, "build");
    expect([build.provider, build.model]).toEqual(["codex", "gpt-5-codex"]);
    expect(build.reasons.at(-1)).toBe("plan headroom: claude has used 86% of its 5-hour window — codex has more room (3% used), so its strong builder from installation (strong) runs it");
    expect(legOf(route, "plan").provider).toBe("codex");
    // Repairs follow the build to its provider, never cross it.
    expect(legOf(route, "repair")).toMatchObject({ provider: "codex", model: "gpt-5-codex", problem: null });
    // The choice is part of the sealed bytes.
    expect(routeFromJson(canonicalRouteJson(route))).toEqual(route);
  });

  test("90% of a weekly window counts too; within limits, missing readings, or both tight keep the choice", () => {
    expect(legOf(recommendRoute(input({ candidates: both(), headroom: room([10, 95], [3, 1]) })), "build").provider).toBe("codex");
    expect(legOf(recommendRoute(input({ candidates: both(), headroom: room([70, 85], [3, 1]) })), "build").provider).toBe("claude");
    expect(legOf(recommendRoute(input({ candidates: both(), headroom: [] })), "build").provider).toBe("claude");
    expect(legOf(recommendRoute(input({ candidates: both(), headroom: room([90, 10], [null, null]) })), "build").provider).toBe("claude");
    const tight = recommendRoute(input({ candidates: both(), headroom: room([90, 10], [85, 10]) }));
    expect(legOf(tight, "build").provider).toBe("claude");
    expect(legOf(tight, "build").reasons.at(-1)).toContain("no other configured builder has room — kept");
  });

  test("headroom never moves a phase to a weaker tier, or past one tier stronger", () => {
    const strongOnly = recommendRoute(input({ risk: "high", candidates: { ...both(), build: { routine: c("codex", "gpt-5-mini"), strong: c("claude", "opus", "installation (strong)") } }, headroom: room([95, 10], [1, 1]) }));
    expect(legOf(strongOnly, "build")).toMatchObject({ provider: "claude", model: "opus" });
  });

  // A tier with a candidate on each provider (`config set build --also …`).
  const pair = (): RouteCandidates => ({
    plan: { routine: c("claude", "sonnet"), strong: null, alternates: { routine: [c("codex", "gpt-5.6", "installation (routine, also)")] } },
    build: { routine: c("claude", "sonnet"), strong: c("claude", "opus", "installation (strong)"), alternates: { routine: [c("codex", "gpt-5.6", "installation (routine, also)")], strong: [c("codex", "gpt-5.6-pro", "installation (strong, also)")] } },
    repair: { routine: null, strong: null },
    review: { routine: c("claude", "sonnet"), strong: null },
  });

  test("a tier with a candidate on each provider runs on the one with more room, well under the limits", () => {
    const route = recommendRoute(input({ candidates: pair(), headroom: room([30, 40], [5, 1]) }));
    expect(legOf(route, "build")).toMatchObject({ provider: "codex", model: "gpt-5.6", tier: "routine" });
    expect(legOf(route, "build").reasons.at(-1)).toBe("plan headroom: claude has used 40% of its plan — codex has more room (5% used), so its routine builder from installation (routine, also) runs it");
    expect(legOf(route, "plan")).toMatchObject({ provider: "codex", model: "gpt-5.6" });
    // Repairs follow the build to codex on its own model.
    expect(legOf(route, "repair")).toMatchObject({ provider: "codex", model: "gpt-5.6", problem: null });
    expect(routeFromJson(canonicalRouteJson(route))).toEqual(route);
    // The strong tier spreads the same way.
    expect(legOf(recommendRoute(input({ risk: "high", candidates: pair(), headroom: room([30, 40], [5, 1]) })), "build")).toMatchObject({ provider: "codex", model: "gpt-5.6-pro", tier: "strong" });
  });

  test("more room means lower use: the tier's own candidate stays when it has as much or more, or the other is unknown", () => {
    expect(legOf(recommendRoute(input({ candidates: pair(), headroom: room([5, 1], [30, 40]) })), "build").provider).toBe("claude");
    expect(legOf(recommendRoute(input({ candidates: pair(), headroom: room([20, 20], [20, 10]) })), "build").provider).toBe("claude");
    expect(legOf(recommendRoute(input({ candidates: pair(), headroom: room([50, 50], [null, null]) })), "build").provider).toBe("claude");
    expect(legOf(recommendRoute(input({ candidates: pair(), headroom: room([null, null], [1, 1]) })), "build").provider).toBe("claude");
    // A provider past its limits never takes the work, however the other compares.
    expect(legOf(recommendRoute(input({ candidates: pair(), headroom: room([95, 95], [85, 1]) })), "build").provider).toBe("claude");
    // Within limits, nothing moves to a stronger tier for room alone.
    const sameTierOnly = recommendRoute(input({ candidates: both(), headroom: room([60, 60], [1, 1]) }));
    expect(legOf(sameTierOnly, "build").provider).toBe("claude");
  });

  test("readings become headroom: a passed reset is empty, a stale reading is unknown, a plan-wide week wins", () => {
    const limits = [
      { provider: "claude", window: "five_hour", usedPercent: 92, windowMinutes: 300, resetsAt: "2026-10-04T11:00:00.000Z", observedAt: "2026-10-04T10:00:00.000Z" },
      { provider: "claude", window: "seven_day_opus", usedPercent: 99, windowMinutes: 10_080, resetsAt: null, observedAt: "2026-10-04T10:00:00.000Z" },
      { provider: "claude", window: "seven_day", usedPercent: 40, windowMinutes: 10_080, resetsAt: null, observedAt: "2026-10-04T10:00:00.000Z" },
      { provider: "codex", window: "five_hour", usedPercent: 50, windowMinutes: 300, resetsAt: null, observedAt: "2026-10-03T00:00:00.000Z" },
      { provider: "codex", window: "seven_day", usedPercent: 1, windowMinutes: 10_080, resetsAt: null, observedAt: "2026-10-04T11:00:00.000Z" },
    ];
    expect(headroomFrom(limits, T0)).toEqual([
      { provider: "claude", fiveHour: 0, weekly: 40 },
      { provider: "codex", fiveHour: null, weekly: 1 },
    ]);
  });
});

describe("route versions", () => {
  test("a v1 route sealed before sizing still reads back with its own bytes and digest", () => {
    const v1 = '{"demands":[],"evidence":["check"],"legs":[{"chosen":"recommended","model":"sonnet","phase":"plan","problem":null,"provider":"claude","reasons":["a"],"recommended":{"model":"sonnet","provider":"claude","tier":"routine"},"tier":"routine"},{"chosen":"recommended","model":"sonnet","phase":"build","problem":null,"provider":"claude","reasons":["b"],"recommended":{"model":"sonnet","provider":"claude","tier":"routine"},"tier":"routine"},{"chosen":"recommended","model":"sonnet","phase":"repair","problem":null,"provider":"claude","reasons":["c"],"recommended":{"model":"sonnet","provider":"claude","tier":"routine"},"tier":"routine"},{"chosen":"recommended","model":"opus","phase":"review","problem":null,"provider":"claude","reasons":["d"],"recommended":{"model":"opus","provider":"claude","tier":"routine"},"tier":"routine"}],"overrides":[],"posture":"economy","publication":"none","qualityMode":"default","risk":"routine","version":1}';
    const route = routeFromJson(v1);
    expect(route).not.toBeNull();
    expect(route!.version).toBe(1);
    expect(route!.size).toBeNull();
    expect(canonicalRouteJson(route!)).toBe(v1);
    // The digest the v47 fixture recorded for exactly these terms.
    expect(routeDigestOf(routeFromJson(v1.replace('["a"]', '["risk is routine, quality is default — the configured planner is economical enough","configured planner from installation"]'))!)).toMatch(/^[0-9a-f]{32}$/);
    // A v1 snapshot cannot claim the light tier or carry a size.
    expect(routeFromJson(v1.replace('"tier":"routine"},"tier":"routine"},{"chosen":"recommended","model":"sonnet","phase":"repair"', '"tier":"routine"},"tier":"light"},{"chosen":"recommended","model":"sonnet","phase":"repair"'))).toBeNull();
    expect(routeFromJson(v1.replace('"version":1', '"size":null,"version":1'))).toBeNull();
  });

  test("a v2 route round-trips with its size; a malformed size fails closed", () => {
    const route = recommendRoute(input({ size: sized("small") }));
    const json = canonicalRouteJson(route);
    expect(routeFromJson(json)).toEqual(route);
    expect(routeDigestOf(routeFromJson(json)!)).toBe(routeDigestOf(route));
    expect(routeFromJson(json.replace('"size":"small"', '"size":"tiny"'))).toBeNull();
    expect(routeFromJson(json.replace(',"version":2', ""))).toBeNull();
    // Size is a term: the same task sized differently digests differently.
    expect(routeDigestOf(recommendRoute(input({ size: sized("medium") })))).not.toBe(routeDigestOf(route));
  });
});

describe("the store", () => {
  test("an older file's strong-only tier table widens to take the light tier, keeping its rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "so-tier-"));
    try {
      const file = join(dir, "orders.db");
      openStore(file).close();
      const raw = new DatabaseSync(file);
      raw.exec("DROP TABLE phase_tier_config");
      raw.exec(`CREATE TABLE phase_tier_config (scope TEXT NOT NULL, phase TEXT NOT NULL CHECK (phase IN ('plan','build','repair','review')), tier TEXT NOT NULL CHECK (tier IN ('strong')),
        provider TEXT NOT NULL CHECK (provider IN ('claude','codex','openrouter','gemini')), model TEXT, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL, PRIMARY KEY (scope, phase, tier))`);
      raw.prepare("INSERT INTO phase_tier_config VALUES ('installation', 'build', 'strong', 'claude', 'opus', ?, 'alex')").run(T0.toISOString());
      raw.exec("UPDATE schema_version SET version = 113"); // an older build's file reads older (v114)
      raw.close();
      const store = openStore(file);
      try {
        expect(store.phaseTierConfig("installation", "build", "strong")).toMatchObject({ provider: "claude", model: "opus" });
        store.setPhaseTierConfig("installation", "build", "light", "claude", "haiku", "alex", T0);
        expect(store.listPhaseTierConfig("installation").map(one => [one.tier, one.model])).toEqual([["light", "haiku"], ["strong", "opus"]]);
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a filed scope seals the size and its route; the task records its tier; a person's size re-files and plans", () => {
    const store = openStore(":memory:");
    try {
      store.setPhaseConfig("installation", "plan", "claude", "sonnet", "ops", T0);
      store.setPhaseConfig("installation", "build", "claude", "sonnet", "ops", T0);
      store.setPhaseTierConfig("installation", "build", "light", "claude", "haiku", "ops", T0);
      store.setPhaseTierConfig("installation", "build", "strong", "claude", "opus", "ops", T0);
      store.setPhaseTierConfig("installation", "plan", "strong", "claude", "opus", "ops", T0);
      const made = store.createConsoleTask({ id: "copy", title: "Fix the button label", repo: "/repo/shop", goal: "Say Save, not Submit", acceptance: [{ id: "c1", statement: "It says Save", evidence: ["check"] }], sizing: sized("small") }, T0);
      expect(made.ok).toBe(true);
      const scope = store.getScope("copy")!;
      const route = routeFromJson(scope.proposedRouteJson ?? null)!;
      expect(route.size).toEqual(sized("small"));
      expect(legOf(route, "build").model).toBe("haiku");
      const ref = store.refFor("built-in", "copy");
      expect(ref.routeTier).toBe("light");
      expect(ref.sizing).toEqual(sized("small"));
      const edited = store.editTaskRoute(ref.id, { by: "alex", authenticate: () => ({ ok: true }), size: { size: "large", risky: false } }, T0);
      expect(edited.ok).toBe(true);
      const after = routeFromJson(store.getScope("copy")!.proposedRouteJson ?? null)!;
      expect(after.size).toEqual({ size: "large", risky: false, source: "person", reason: "set by alex" });
      expect(legOf(after, "build").model).toBe("opus");
      expect(store.getScope("copy")!.digest).not.toBe(scope.digest);
      expect(store.refFor("built-in", "copy")).toMatchObject({ routeTier: "strong", plan: "requested" });
      // The classifier never overrides a person.
      expect(store.applySizing("copy", sized("small"), { followPlanning: true }, T0)).toEqual({ ok: false, reason: "person" });
    } finally {
      store.close();
    }
  });

  test("a tier holds one agent per provider: filing picks the one with more plan room and seals why; a light planner is refused", () => {
    const store = openStore(":memory:");
    try {
      store.setPhaseConfig("installation", "plan", "claude", "sonnet", "ops", T0);
      store.setPhaseConfig("installation", "build", "claude", "sonnet", "ops", T0);
      store.setPhaseTierAlternate("installation", "build", "routine", "codex", "gpt-5.6", "ops", T0);
      // The same provider as the tier's own agent is shadowed, not doubled.
      store.setPhaseTierAlternate("installation", "build", "routine", "claude", "sonnet-alt", "ops", T0);
      const resolved = resolveRouteCandidates(store, "/repo/shop");
      expect(resolved.ok && resolved.candidates.build.alternates).toEqual({ routine: [{ provider: "codex", model: "gpt-5.6", source: "installation (routine, also)" }] });
      // Both are offered as configured builders.
      expect(agentChoicesFor(store, "/repo/shop", null).build.map(one => `${one.provider} · ${one.model}`)).toEqual(["claude · sonnet", "codex · gpt-5.6"]);
      const window = (usedPercent: number) => [{ window: "five_hour", usedPercent, windowMinutes: 300, resetsAt: null, reached: false }];
      store.recordProviderLimits({ provider: "claude", plan: null, windows: window(45) }, T0);
      store.recordProviderLimits({ provider: "codex", plan: null, windows: window(2) }, T0);
      expect(store.createConsoleTask({ id: "feat", title: "Add a filter", repo: "/repo/shop", goal: "Filter orders by date", acceptance: [{ id: "c1", statement: "It filters", evidence: ["check"] }], sizing: sized("medium") }, T0).ok).toBe(true);
      const route = routeFromJson(store.getScope("feat")!.proposedRouteJson ?? null)!;
      expect(legOf(route, "build")).toMatchObject({ provider: "codex", model: "gpt-5.6" });
      expect(legOf(route, "build").reasons.at(-1)).toContain("codex has more room (2% used)");
      expect(store.clearPhaseTierAlternates("installation", "build", "routine", "codex")).toBe(1);
      expect(() => store.setPhaseTierConfig("installation", "plan", "light", "claude", "haiku", "ops", T0)).toThrow(/build phase only/);
      expect(() => store.setPhaseTierAlternate("installation", "plan", "light", "codex", "gpt-5.6-mini", "ops", T0)).toThrow(/build phase only/);
    } finally {
      store.close();
    }
  });

  test("elevated or high risk asks for a plan whatever the size; a size edit keeps planning at that risk", () => {
    const store = openStore(":memory:");
    try {
      store.setPhaseConfig("installation", "plan", "claude", "sonnet", "ops", T0);
      store.setPhaseConfig("installation", "build", "claude", "sonnet", "ops", T0);
      store.setPhaseTierConfig("installation", "build", "light", "claude", "haiku", "ops", T0);
      expect(store.createConsoleTask({ id: "copy", title: "Fix the button label", repo: "/repo/shop", goal: "Say Save", acceptance: [{ id: "c1", statement: "It says Save", evidence: ["check"] }], sizing: sized("small") }, T0).ok).toBe(true);
      const ref = store.refFor("built-in", "copy");
      expect(ref.plan).toBeNull();
      const person = { by: "alex", authenticate: () => ({ ok: true }) as const };
      expect(store.editTaskRoute(ref.id, { ...person, risk: "elevated" }, T0).ok).toBe(true);
      expect(store.refFor("built-in", "copy").plan).toBe("requested");
      // Saying it is small again does not drop the plan while risk is elevated.
      expect(store.editTaskRoute(ref.id, { ...person, size: { size: "small", risky: false } }, T0).ok).toBe(true);
      expect(store.refFor("built-in", "copy").plan).toBe("requested");
      // Neither does the classifier.
      expect(store.applySizing("copy", sized("small"), { followPlanning: true }, T0)).toEqual({ ok: false, reason: "person" });
      // Back at routine risk, a small size drops the requested plan.
      expect(store.editTaskRoute(ref.id, { ...person, risk: "routine", size: { size: "small", risky: false } }, T0).ok).toBe(true);
      expect(store.refFor("built-in", "copy").plan).toBeNull();
    } finally {
      store.close();
    }
  });
});
