/**
 * Threads for everyday use, slice S7: Ship's laptop road (the owner's D1, "No password (laptop)"; Codex rounds 1–2). A
 * password-free solo laptop's local owner presses Ship with the exact act `ship-thread`, and the press keeps Ship's
 * whole contract (terms digest, summary key, quarantined import, seal, a merge only on the exact green commit). The
 * laptop predicate (flexible-laptop.ts) is read again at the consent, at the seal and at every armed step; when it fails
 * (another account gets a password, an identity provider is linked) the Ship ends for good and putting the settings back
 * never revives it. Off the laptop road only a password typed now ships: a session, a remembered login, the local owner
 * typing a password, an empty password and a machine never do. Real git and a scripted GitHub; never the network.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prepareFlexibleThread, type FlexibleThreadPaths, type FlexibleThreadRow } from "./flexible-thread.js";
import { flexibleShipTerms, mergeArmedFlexible, shipFlexible, type ShipProof } from "./flexible-ship.js";
import { enableFlexible, proposedFlexibleTerms } from "./flexible.js";
import { approvalOf, hashPassword } from "./scope.js";
import { asLocalOwner, type LocalPrincipal } from "./local-owner.js";
import { allowWhereUnfenced } from "./unfenced-test-support.js";
import { register } from "./runner.js";
import { savePublishing } from "./pull-request-flow.js";
import { initLocalMode, localModeOf, type Store } from "./store.js";
import { laptopShipProblem } from "./flexible-laptop.js";
import { tgit, threadWorld, type ThreadWorld } from "../test/flexible-thread-world.js";

const switched = vi.hoisted(() => ({ on: true }));
vi.mock("./flexible-available.js", async original => ({ ...await original<typeof import("./flexible-available.js")>(), flexibleAvailable: () => switched.on }));
// A hook run in the middle of the quarantined import (between the consent and the seal): an install changing under it.
const during = vi.hoisted(() => ({ import: null as (() => void) | null }));
vi.mock("./flexible-import.js", async original => {
  const real = await original<typeof import("./flexible-import.js")>();
  return { ...real, importFlexibleCandidate: async (...args: Parameters<typeof real.importFlexibleCandidate>) => {
    const done = await real.importFlexibleCandidate(...args);
    const hook = during.import; during.import = null; hook?.();
    return done;
  } };
});

const NOW = new Date("2026-11-18T12:00:00.000Z");
let world: ThreadWorld, store: Store, root: string, thread: FlexibleThreadRow, paths: FlexibleThreadPaths;

beforeEach(async () => {
  switched.on = true;
  during.import = null;
  world = threadWorld();
  store = allowWhereUnfenced(world.store);
  root = join(world.dir, "evidence");
  mkdirSync(root);
  // A laptop install: local mode on for alex, who has no password; a new install, so it is solo.
  const init = initLocalMode(store, { owner: "alex", fenceAvailable: true, now: NOW });
  if (!init.ok) throw new Error(init.reason);
  register(store, { name: "worker-1", host: "test", capacity: 4, repos: [world.project], now: NOW, newToken: () => "tok-worker-1" });
  for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "alex", NOW);
  store.setVerifyCommand({ repo: world.project, command: "test -f README.md", timeoutMs: 60_000, approvedBy: "alex" }, NOW);
  savePublishing(store, { repo: world.project, githubRepo: "alex/shop", remote: "origin", base: "main", account: "alex" }, "alex", { mergeMethod: "squash", mergeWhenGreen: true }, NOW);
  const proposed = proposedFlexibleTerms(store, world.project, "alex");
  if (!proposed.ok) throw new Error(proposed.message);
  const on = enableFlexible(store, { repo: world.project, by: "alex", proof: "password-now", shownDigest: proposed.digest, now: NOW });
  if (!on.ok) throw new Error(on.message);
  const made = await prepareFlexibleThread(store, { repo: world.project, base: "HEAD", by: "alex", now: NOW });
  if (!made.ok) throw new Error(made.message);
  ({ thread, paths } = made);
});
afterEach(() => { store.close(); rmSync(world.dir, { recursive: true, force: true }); });

function commit(files: Record<string, string>): string {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(paths.repo, name, ".."), { recursive: true });
    writeFileSync(join(paths.repo, name), text);
    tgit(paths.repo, "add", "-f", "--", name);
  }
  tgit(paths.repo, "commit", "-qm", "thread work");
  return tgit(paths.repo, "rev-parse", "HEAD");
}
/** The local owner acting in the workbench, as exactly `act`, bound to local mode and the account as they read now. */
const owner = (act: LocalPrincipal["act"] = "ship-thread"): LocalPrincipal => ({ account: "alex", localGeneration: localModeOf(store)!.generation,
  accountGeneration: store.accountOf("alex")!.generation, transport: "terminal", act, sessionHash: null, request: null });
async function press(proof: ShipProof, as: LocalPrincipal | null = owner()) {
  const shown = await flexibleShipTerms(store, { thread: thread.id, by: "alex" });
  if (!shown.ok) throw new Error(shown.message);
  const go = () => shipFlexible(store, { thread: thread.id, by: "alex", proof, shownDigest: shown.digest, shownKey: shown.summary.key, now: NOW });
  return as === null ? go() : asLocalOwner(as, go);
}
const laptop: ShipProof = { kind: "local-owner", held: () => true };
const ships = () => store.handle.prepare("SELECT seq, state, proof, task_id, detail FROM flexible_ship ORDER BY seq").all().map(row => ({ ...row }));
const anotherWithPassword = () => { store.saveApprover("bob", hashPassword("bob-password-333"), NOW); };
const linkSso = () => {
  store.handle.prepare("INSERT INTO sso_identity (issuer, subject, account, email, created_at, last_seen_at) VALUES ('https://id.example', 'alex-1', 'alex', NULL, ?, ?)").run(NOW.toISOString(), NOW.toISOString());
};

describe("the laptop road: one key, the whole contract", () => {
  test("the local owner's act on a password-free solo laptop ships: consent bound to its generations, sealed, armed", async () => {
    expect(laptopShipProblem(store, { owner: "alex" })).toBeNull();
    commit({ "src/feature.js": "export const feature = 1;\n" });
    const done = await press(laptop);
    expect(done).toMatchObject({ ok: true, seq: 1 });
    if (!done.ok) return;
    expect(ships()).toEqual([{ seq: 1, state: "armed", proof: "local-owner", task_id: done.taskId, detail: null }]);
    expect(store.handle.prepare("SELECT owner, local_generation, account_generation FROM flexible_ship_laptop WHERE ship = ?").get(done.ship))
      .toEqual({ owner: "alex", local_generation: localModeOf(store)!.generation, account_generation: store.accountOf("alex")!.generation });
    expect(approvalOf(store.getScope(done.taskId)!)).toMatchObject({ approved: true, by: "alex" });
  });

  test.each([
    ["another account has a password", anotherWithPassword, /has a password now/],
    ["an identity provider is linked", linkSso, /identity provider/],
  ])("not a laptop any more (%s): refused before anything is recorded", async (_name, change, why) => {
    commit({ "a.txt": "one\n" });
    change();
    expect(await press(laptop)).toMatchObject({ ok: false, reason: "laptop", message: expect.stringMatching(why) });
    expect(ships()).toEqual([]);
  });

  test("only the exact act, in the local owner's chain: another act, or none, never ships on the laptop road", async () => {
    commit({ "a.txt": "one\n" });
    expect(await press(laptop, owner("approve-plan"))).toMatchObject({ ok: false, reason: "proof-refused" });
    expect(await press(laptop, null)).toMatchObject({ ok: false, reason: "proof-refused" });
    expect(ships()).toEqual([]);
  });

  test.each([
    ["the install gets a password", anotherWithPassword],
    ["an identity provider is linked", linkSso],
  ])("changed during the import (%s): nothing is sealed, nothing is armed", async (_name, change) => {
    commit({ "a.txt": "one\n" });
    during.import = change;
    expect(await press(laptop)).toMatchObject({ ok: false, reason: "laptop" });
    expect(ships()).toEqual([expect.objectContaining({ seq: 1, state: "imported", proof: "local-owner", task_id: null })]);
  });

  test.each([
    // A second person, even removed again, leaves the install a team one: the road stays shut.
    ["the install gets a password", anotherWithPassword, () => { store.revokeAccount("bob", "alex", NOW); }, false],
    // Unlinked again, the laptop road stands for a new Ship; this one is still over.
    ["an identity provider is linked", linkSso, () => { store.handle.prepare("DELETE FROM sso_identity").run(); }, true],
  ] as const)("changed while armed (%s): the Ship ends for good, and putting it back revives nothing", async (_name, change, undo, standsAgain) => {
    commit({ "a.txt": "one\n" });
    const done = await press(laptop);
    if (!done.ok) throw new Error(done.message);
    change();
    expect(await mergeArmedFlexible(store, { taskId: done.taskId, root, clock: () => NOW })).toMatchObject({ ok: false, reason: "cancelled" });
    expect(ships()[0]).toMatchObject({ state: "cancelled", detail: expect.stringMatching(/without a password/) });
    undo();
    expect(laptopShipProblem(store, { owner: "alex" }) === null).toBe(standsAgain);
    expect(await mergeArmedFlexible(store, { taskId: done.taskId, root, clock: () => NOW })).toMatchObject({ ok: false, reason: "wrong-state" });
    expect(ships()[0]).toMatchObject({ state: "cancelled" });
  });
});

describe("the session goes with the laptop proof", () => {
  test("a session that ends while the press waits (lock, stop, reads) consents to nothing: asked again in the consent's transaction", async () => {
    commit({ "a.txt": "one\n" });
    let asked = 0;
    // Held when asked first (before the lock); gone by the time the consent is recorded.
    expect(await press({ kind: "local-owner", held: () => ++asked === 1 })).toMatchObject({ ok: false, reason: "proof-refused" });
    expect(asked).toBeGreaterThan(1);
    expect(ships()).toEqual([]);
  });
});

describe("off the laptop road: a password typed now, and nothing standing in for one", () => {
  test("the local owner typing a password, an empty password and a machine are refused; nothing is recorded", async () => {
    commit({ "a.txt": "one\n" });
    // Inside the local owner's chain a password is never checked as one for Ship (its act answers instead): refused.
    expect(await press({ kind: "password-now", password: "anything" })).toMatchObject({ ok: false, reason: "proof-refused" });
    expect(await press({ kind: "password-now", password: "" }, null)).toMatchObject({ ok: false, reason: "proof-refused" });
    expect(await press({ kind: "nonsense" } as unknown as ShipProof, null)).toMatchObject({ ok: false, reason: "proof-refused" });
    expect(ships()).toEqual([]);
  });
});
