/**
 * A thread start's terms card (flexible-start.ts), with the constant mocked on (tests only): what it binds and when no
 * card can be made. The key moves with everything a person says yes to (the project's terms, the network, the person,
 * the model, the message) and with nothing else; an open network's risks are never folded; no card is made for a
 * project that isn't Flexible, whose terms lapsed, or whose terms don't let this person start threads.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { rmSync } from "node:fs";
import { flexibleDigestOf, flexibleTermsJson, OPEN_NETWORK_WORDS, type FlexibleTerms } from "./flexible.js";
import { flexibleStartCard, FLEXIBLE_DEFAULT_MODEL } from "./flexible-start.js";
import { summaryLines } from "./approval-summary.js";
import { threadWorld, type ThreadWorld } from "../test/flexible-thread-world.js";

vi.mock("./flexible-available.js", () => ({ FLEXIBLE_AVAILABLE: true }));

const NOW = new Date("2026-11-15T10:00:00.000Z");
let world: ThreadWorld;
const gen = (name: string) => world.store.accountOf(name)!.generation;
beforeEach(() => {
  world = threadWorld();
  world.store.saveApprover("alex", "hash-a", NOW);
  world.store.saveApprover("pat", "hash-p", NOW);
  expect(world.store.setAccountProjects("pat", [world.project], "alex", NOW)).toEqual({ ok: true });
});
afterEach(() => { world.store.close(); rmSync(world.dir, { recursive: true, force: true }); });

function plant(over: Partial<FlexibleTerms> = {}): string {
  world.store.handle.prepare("UPDATE flexible_terms SET ended_at = ?, ended_by = 'alex', end_reason = 'replaced' WHERE ended_at IS NULL").run(NOW.toISOString());
  const terms: FlexibleTerms = { version: 1, repo: world.project, signer: "alex", signerGeneration: gen("alex"), starters: "approvers-with-access", passwordFreeUpTo: "full", max: "full", default: "full",
    network: world.store.projectNetwork(world.project).mode === "open" ? "open" : "confined", caps: { liveThreads: 3, turnsPerDayProject: 300, turnsPerDayPerson: 150, measuredMicrousdPerDay: null }, ...over };
  const digest = flexibleDigestOf(terms);
  world.store.handle.prepare(`INSERT INTO flexible_terms (repo, terms_json, digest, signed_terms_json, signed_digest, signed_by, signed_at, proof, changed_by, changed_at)
    VALUES (?, ?, ?, ?, ?, 'alex', ?, 'password-now', 'alex', ?)`).run(world.project, flexibleTermsJson(terms), digest, flexibleTermsJson(terms), digest, NOW.toISOString(), NOW.toISOString());
  return digest;
}
const card = (over: Partial<Parameters<typeof flexibleStartCard>[1]> = {}) => {
  const made = flexibleStartCard(world.store, { repo: world.project, by: { name: "pat", generation: gen("pat") }, model: null, message: "Fix the README", ...over });
  if (!made.ok) throw new Error(made.message);
  return made.card;
};

describe("the start's terms card", () => {
  test("its key moves with each thing a person says yes to, and only with those", () => {
    const digest = plant();
    const first = card();
    expect(first).toMatchObject({ digest, model: FLEXIBLE_DEFAULT_MODEL, level: "full" });
    expect(card().summary.key).toBe(first.summary.key);
    expect(card({ model: "claude-opus-5-5" }).summary.key).not.toBe(first.summary.key);
    expect(card({ message: "Something else" }).summary.key).not.toBe(first.summary.key);
    expect(card({ by: { name: "alex", generation: gen("alex") } }).summary.key).not.toBe(first.summary.key);
    // Other terms (a dollar limit added): another digest, another key, and the limit said.
    plant({ caps: { liveThreads: 3, turnsPerDayProject: 300, turnsPerDayPerson: 150, measuredMicrousdPerDay: 5_000_000 } });
    const limited = card();
    expect(limited.summary.key).not.toBe(first.summary.key);
    expect(summaryLines(limited.summary).join("\n")).toContain("$5.00");
    // Another host on the project's list: another network digest, another key.
    world.store.setProjectNetwork(world.project, { mode: "allowlist", hosts: ["api.example.com"], loopback: "proxy-only" }, "alex", NOW);
    const hosted = card();
    expect(hosted.network).not.toBe(limited.network);
    expect(hosted.summary.key).not.toBe(limited.summary.key);
  });

  test("an open network is said in the open: the network row is a risk, and every open-network disclosure is a note", () => {
    world.store.setProjectNetwork(world.project, { mode: "open", hosts: [], loopback: "proxy-only" }, "alex", NOW);
    plant();
    const open = card();
    expect(open.summary.decisions.find(row => row.label === "Network")).toMatchObject({ risky: true });
    for (const words of OPEN_NETWORK_WORDS) expect(open.summary.warnings.map(note => note.words)).toContain(words);
    expect(open.summary.decisions.find(row => row.label === "Level")).toMatchObject({ risky: true });
  });

  test("no card where no thread may start: not Flexible, lapsed terms, terms that let only the signer start, a model the relay doesn't forward", () => {
    const by = { name: "pat", generation: gen("pat") };
    expect(flexibleStartCard(world.store, { repo: world.project, by, model: null, message: "x" })).toMatchObject({ ok: false, reason: "not-flexible" });
    plant({ starters: "signer" });
    expect(flexibleStartCard(world.store, { repo: world.project, by, model: null, message: "x" })).toMatchObject({ ok: false, reason: "not-a-starter" });
    plant();
    expect(flexibleStartCard(world.store, { repo: world.project, by, model: "gpt-5", message: "x" })).toMatchObject({ ok: false, reason: "invalid-request" });
    // The project's network posture moved since the terms were signed: they lapsed.
    world.store.handle.prepare("INSERT INTO project_network (repo, network_json, updated_at, updated_by) VALUES (?, ?, ?, 'alex') ON CONFLICT (repo) DO UPDATE SET network_json = excluded.network_json")
      .run(world.project, JSON.stringify({ mode: "open", hosts: [], loopback: "proxy-only" }), NOW.toISOString());
    expect(flexibleStartCard(world.store, { repo: world.project, by, model: null, message: "x" })).toMatchObject({ ok: false, reason: "terms-lapsed" });
  });
});
