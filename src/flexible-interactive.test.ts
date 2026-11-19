import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, resetAccountPassword, type Store } from "./store.js";
import { flexibleDigestOf, flexibleTermsJson, flexibleRuntime, recordFlexibleRuntime, type FlexibleTerms } from "./flexible.js";
import { admitFlexibleTurn } from "./flexible-turns.js";
import { flexibleStartCard } from "./flexible-start.js";
import { activateInteractiveSession, endInteractiveSession, interactiveSession, prepareInteractiveSession } from "./flexible-interactive.js";
import { requireFlexibleStop } from "./flexible-authority-end.js";
import { removeFlexibleSignIn, resetFlexibleSignInsForRestore, signInEpochOf } from "./flexible-sign-in.js";
import { standInSignIn } from "../test/flexible-sign-in-kit.js";

const NOW = new Date("2026-11-18T10:00:00Z"), T = "a".repeat(32), L = "b".repeat(32), F = "f".repeat(32);
let store: Store, dir: string, repo: string;
const by = () => ({ name: "pat", generation: store.accountOf("pat")!.generation });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "attach-authority-")); repo = join(dir, "repo"); mkdirSync(repo);
  store = openStore(join(dir, "orders.db"));
  store.saveApprover("alex", "hash-a", NOW); store.saveApprover("pat", "hash-p", NOW);
  store.upsertProject(repo, "test", NOW);
  store.handle.prepare("INSERT INTO flexible_setting VALUES (1, 1, 'alex', ?)").run(NOW.toISOString());
  const terms: FlexibleTerms = { version: 1, repo, signer: "alex", signerGeneration: store.accountOf("alex")!.generation, starters: "approvers-with-access", passwordFreeUpTo: "full", max: "full", default: "full", network: "confined",
    caps: { liveThreads: 3, turnsPerDayProject: 1, turnsPerDayPerson: 1, measuredMicrousdPerDay: 1 } };
  const json = flexibleTermsJson(terms), digest = flexibleDigestOf(terms);
  store.handle.prepare(`INSERT INTO flexible_terms (repo, terms_json, digest, signed_terms_json, signed_digest, signed_by, signed_at, proof, changed_by, changed_at)
    VALUES (?, ?, ?, ?, ?, 'alex', ?, 'password-now', 'alex', ?)`)
    .run(repo, json, digest, json, digest, NOW.toISOString(), NOW.toISOString());
  standInSignIn(store, dir, "pat");
  store.handle.prepare(`INSERT INTO flexible_thread (id, repo, base_sha, keep_ref, folder, created_by, created_at, state) VALUES (?, ?, ?, ?, ?, 'pat', ?, 'preparing')`)
    .run(T, repo, "1".repeat(40), `refs/toolroll/threads/${T}/base`, join(dir, "thread"), NOW.toISOString());
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
function prepare(): string {
  recordFlexibleRuntime(store, T, "interactive");
  store.handle.prepare("UPDATE flexible_thread SET state = 'ready' WHERE id = ?").run(T);
  store.handle.prepare(`INSERT INTO flexible_thread_launch (id, thread, provider, level, fence_digest, holder, host, marker, state, started_at)
    VALUES (?, ?, 'claude', 'full', ?, 'engine', 'test', ?, 'spawning', ?)`)
    .run(L, T, F, "c".repeat(32), NOW.toISOString());
  const made = flexibleStartCard(store, { repo, by: by(), model: null, message: "Inspect the parser", runtime: "interactive", helperModels: [] });
  if (!made.ok) throw new Error(made.message);
  const id = prepareInteractiveSession(store, { thread: T, launch: L, holder: "engine", by: by(), startKey: made.card.summary.key,
    model: made.card.model, helperModels: [], message: "Inspect the parser", now: NOW });
  if (id === null) throw new Error("preparation refused");
  return id;
}
function register(): void {
  store.handle.prepare("UPDATE flexible_thread_launch SET state = 'live', leader_pid = 999999, leader_start = 't1' WHERE id = ?").run(L);
  store.handle.prepare("UPDATE flexible_thread SET live_pid = 999999, live_since = ? WHERE id = ?").run(NOW.toISOString(), T);
}
const activate = (id: string, holder = "engine", authorizeLaunch = (): string | null => null) => activateInteractiveSession(store, { session: id, holder, now: NOW, authorizeLaunch });
test("default stream-json; runtime is chosen only at creation and is immutable", () => {
  expect(flexibleRuntime(store, T)).toBe("stream-json");
  recordFlexibleRuntime(store, T, "stream-json");
  expect(() => store.handle.prepare("UPDATE flexible_thread_runtime SET runtime = 'interactive'").run()).toThrow(/immutable/);
  expect(() => store.handle.prepare("DELETE FROM flexible_thread_runtime").run()).toThrow(/kept/);
});
test("custody and final authorization required, one session per exact launch, no turns or counters", () => {
  const id = prepare();
  expect(activate(id)).toBe(false);
  const columns = store.handle.prepare("PRAGMA table_info(flexible_interactive_session)").all().map(row => String(row["name"]));
  expect(() => store.handle.prepare(`INSERT INTO flexible_interactive_session (${columns.join(",")}) SELECT ${columns.map(column => column === "id" ? "'" + "d".repeat(32) + "'" : column).join(",")} FROM flexible_interactive_session`).run()).toThrow(/UNIQUE/);
  register(); expect(activate(id, "other")).toBe(false);
  expect(activate(id, "engine", () => "denied")).toBe(false);
  expect(activate(id)).toBe(true); expect(activate(id)).toBe(false);
  expect(interactiveSession(store, id)?.["state"]).toBe("active");
  for (const table of ["thread_turn", "mode_rail", "flexible_turn_dispatch"]) expect(store.handle.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.["n"]).toBe(0);
  expect(() => store.handle.prepare("UPDATE flexible_interactive_session SET model = 'other'").run()).toThrow(/written once/);
  expect(endInteractiveSession(store, { session: id, reason: "owner-ended", now: NOW })).toBe(true);
  expect(endInteractiveSession(store, { session: id, reason: "other", now: NOW })).toBe(false);
  expect(activate(id)).toBe(false);
  expect(() => store.handle.prepare("UPDATE flexible_interactive_session SET state = 'active', ended_at = NULL, end_reason = NULL").run()).toThrow(/ends once/);
});
const activationAttacks: [string, () => void][] = [
  ["generation", () => { store.saveApprover("pat", "new-hash", NOW); }],
  ["owner", () => { store.revokeAccount("pat", "alex", NOW); }],
  ["ceiling", () => { store.setOrgPolicy({ ...store.orgPolicy(), ceiling: "standard" }, "alex", NOW); }],
  ["level", () => { store.handle.prepare("INSERT INTO flexible_thread_level VALUES (?, 'auto', 'pat', ?)").run(T, NOW.toISOString()); }],
  ["sign-in", () => { removeFlexibleSignIn(store, { person: "pat", by: "pat", now: NOW }); }],
  ["refused credential", () => {
    const generation = store.handle.prepare("SELECT generation FROM flexible_sign_in WHERE person = 'pat' AND state = 'active'").get()!["generation"];
    store.handle.prepare(`INSERT INTO thread_relay_call (thread, launch, upstream, at, ended_at, route, streamed, status, turn, cost_basis, sign_in_person, sign_in_generation, sign_in_refused)
      VALUES (?, ?, 'claude', ?, ?, 'messages', 0, 'upstream-error', 'dddddddddddddddddddddddddddddddd', 'unknown', 'pat', ?, 1)`)
      .run(T, L, NOW.toISOString(), NOW.toISOString(), generation);
  }],
  ["epoch", () => { store.handle.prepare("INSERT INTO flexible_sign_in_epoch VALUES ('pat', 1)").run(); }],
  ["network", () => { store.setProjectNetwork(repo, { mode: "allowlist", hosts: ["example.invalid"], loopback: "proxy-only" }, "alex", NOW); }],
];
test.each(activationAttacks)("activation refuses changed %s", (_name, change) => { const id = prepare(); register(); change(); expect(activate(id)).toBe(false); });
const endings: [string, () => void][] = [
  ["password", () => { store.saveApprover("pat", "new-hash", NOW); }],
  ["reset", () => { resetAccountPassword(store, "pat", "reset-hash", by().generation, false, NOW); }],
  ["access", () => { store.setAccountProjects("pat", [repo], "alex", NOW); }],
  ["revocation", () => { store.revokeAccount("pat", "alex", NOW); }],
  ["remove", () => { removeFlexibleSignIn(store, { person: "pat", by: "pat", now: NOW }); }],
  ["operator remove", () => { removeFlexibleSignIn(store, { person: "pat", by: "alex", now: NOW }); }],
  ["restore", () => { resetFlexibleSignInsForRestore(store, { now: NOW, carried: [] }); }],
  ["End", () => { requireFlexibleStop(store, { launch: L, thread: T, reason: "owner-ended", at: NOW.toISOString() }); }],
  ["Stop", () => { requireFlexibleStop(store, { launch: L, thread: T, reason: "owner-stopped", at: NOW.toISOString() }); }],
  ["ceiling lowered", () => { store.setOrgPolicy({ ...store.orgPolicy(), ceiling: "standard" }, "alex", NOW); }],
  ["network hosts changed within confined posture", () => { store.setProjectNetwork(repo, { mode: "allowlist", hosts: ["example.invalid"], loopback: "proxy-only" }, "alex", NOW); }],
  ["network posture changed", () => { store.setProjectNetwork(repo, { mode: "open", hosts: [], loopback: "proxy-only" }, "alex", NOW); }],
  ["threads off", () => { store.handle.prepare("UPDATE flexible_setting SET enabled = 0").run(); }],
  ["level lowering", () => { store.handle.prepare("INSERT INTO flexible_thread_level VALUES (?, 'auto', 'pat', ?)").run(T, NOW.toISOString()); }],
  ["launch exit", () => { store.handle.prepare("UPDATE flexible_thread_launch SET state = 'exited', ended_at = ? WHERE id = ?").run(NOW.toISOString(), L); }],
];
test.each(endings)("%s ends authority in the writer's transaction; rollback preserves it", (_name, end) => {
  const id = prepare(); register(); expect(activate(id)).toBe(true);
  expect(() => store.transact(() => { end(); expect(interactiveSession(store, id)?.["state"]).toBe("ended"); throw new Error("rollback"); })).toThrow("rollback");
  expect(interactiveSession(store, id)?.["state"]).toBe("active");
  store.transact(end); expect(interactiveSession(store, id)?.["state"]).toBe("ended"); expect(activate(id)).toBe(false);
});
test("ordinary replacement preserves authority; remove and resave advances epoch and never revives it", () => {
  const id = prepare(); register();
  const epoch = signInEpochOf(store, "pat");
  standInSignIn(store, dir, "pat"); expect(activate(id)).toBe(true);
  removeFlexibleSignIn(store, { person: "pat", by: "pat", now: NOW }); standInSignIn(store, dir, "pat");
  expect(signInEpochOf(store, "pat")).toBeGreaterThan(epoch); expect(activate(id)).toBe(false);
});

test("concurrent-launch safeguards remain; daily turn and spend caps do not admit or reserve interactive turns", () => {
  const id = prepare(); register();
  store.handle.prepare("INSERT INTO flexible_installation_caps (id, live_threads, turns_per_day, measured_microusd_per_day, updated_by, updated_at) VALUES (1, 1, 1, 1, 'alex', ?)").run(NOW.toISOString());
  const otherThread = "e".repeat(32), otherLaunch = "f".repeat(32);
  store.handle.prepare(`INSERT INTO flexible_thread (id, repo, base_sha, keep_ref, folder, created_by, created_at, state)
    VALUES (?, ?, ?, ?, ?, 'pat', ?, 'ready')`)
    .run(otherThread, repo, "1".repeat(40), `refs/toolroll/threads/${otherThread}/base`, join(dir, "other"), NOW.toISOString());
  store.handle.prepare(`INSERT INTO flexible_thread_launch (id, thread, provider, level, fence_digest, holder, host, marker, state, started_at)
    VALUES (?, ?, 'claude', 'full', ?, 'other-engine', 'test', ?, 'spawning', ?)`)
    .run(otherLaunch, otherThread, F, "c".repeat(32), NOW.toISOString());
  expect(activate(id)).toBe(false);
  store.handle.prepare("UPDATE flexible_thread_launch SET state = 'exited', ended_at = ? WHERE id = ?").run(NOW.toISOString(), otherLaunch);
  expect(activate(id)).toBe(true);
  expect(store.handle.prepare("SELECT count(*) AS n FROM thread_turn").get()?.["n"]).toBe(0);
  expect(store.handle.prepare("SELECT count(*) AS n FROM mode_rail").get()?.["n"]).toBe(0);
});

test("an interactive runtime cannot admit a structured turn, even through the structured admission function", () => {
  const id = prepare(); register();
  const session = interactiveSession(store, id)!;
  expect(() => admitFlexibleTurn(store, { thread: T, starter: by(), digest: String(session["terms_digest"]), level: "full", freshProof: false,
    provider: "claude", model: String(session["model"]), billing: "subscription", requestKey: "wrong-runtime", holder: "engine", clock: () => NOW })).toThrow(/do not admit structured turns/);
  expect(store.handle.prepare("SELECT count(*) AS n FROM thread_turn").get()?.["n"]).toBe(0);
  expect(store.handle.prepare("SELECT count(*) AS n FROM mode_rail").get()?.["n"]).toBe(0);
});
