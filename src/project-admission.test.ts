/**
 * The one road for adding and removing projects (project-admission.ts):
 * proof before any write, idempotent ledger rows naming who and from where,
 * and the command line's authority — the owner, or the lead for an owner
 * who may manage every project, never anything else.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { addedWords, admitProject, commandLineActor, releaseProject } from "./project-admission.js";
import { loadProjectRegistry } from "./repos.js";

const NOW = new Date("2026-10-05T12:00:00.000Z");
let base: string, store: Store, registryFile: string, databaseFile: string, repo: string;
const owner = { label: "alex", origin: "cli" as const };
const ledger = (action: string) => store.actionLedger({ repos: null, instance: true }).filter(one => one.action === action);

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "so-admission-")));
  databaseFile = join(base, "orders.db");
  registryFile = join(base, "repos.json");
  store = openStore(databaseFile);
  repo = join(base, "a-project-with-a-rather-long-name-for-the-console");
  mkdirSync(join(repo, "src"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
});
afterEach(() => {
  store.close();
  rmSync(base, { recursive: true, force: true });
});

test("a folder inside a repository is admitted at its root, once, with who and from where", async () => {
  const first = await admitProject(store, { registryFile, path: join(repo, "src"), actor: owner, now: NOW });
  expect(first).toMatchObject({ ok: true, repo, added: true });
  const again = await admitProject(store, { registryFile, path: repo, actor: owner, now: NOW });
  expect(again).toMatchObject({ ok: true, repo, added: false });
  expect(await loadProjectRegistry(registryFile)).toEqual({ repos: [repo], roots: [] });
  expect(store.listProjects().map(one => one.path)).toEqual([repo]);
  expect(ledger("project added")).toEqual([expect.objectContaining({ actor: "alex", repo, source: "access", outcome: "added", detail: "from cli" })]);
  expect(addedWords("vamarketplacenew", true, true)).toBe("Added vamarketplacenew; it is in the console now.");
});

test("a plain folder is refused before anything is written", async () => {
  const plain = join(base, "plain");
  mkdirSync(plain);
  const refused = await admitProject(store, { registryFile, path: plain, actor: owner, now: NOW });
  expect(refused).toMatchObject({ ok: false, reason: "not-git", message: expect.stringContaining("isn't a Git repository") });
  expect((await admitProject(store, { registryFile, path: join(base, "missing"), actor: owner, now: NOW }))).toMatchObject({ ok: false, reason: "unavailable" });
  expect(existsSync(registryFile)).toBe(false);
  expect(store.listProjects()).toEqual([]);
  expect(ledger("project added")).toEqual([]);
});

test("removing keeps the saved work, and adding again brings it back", async () => {
  await admitProject(store, { registryFile, path: repo, actor: owner, now: NOW });
  store.createTask({ id: "t-kept", title: "kept work" }, NOW);
  store.placeTask(store.refFor("built-in", "t-kept").id, repo);
  const lead = { label: "lead for alex", origin: "lead" as const };
  expect(await releaseProject(store, { registryFile, path: repo, actor: lead, now: NOW })).toMatchObject({ ok: true, repo, removed: true });
  expect(await loadProjectRegistry(registryFile)).toEqual({ repos: [], roots: [] });
  expect(store.listProjects()).toEqual([]);
  expect(store.lookupRef("t-kept")?.repo).toBe(repo);
  expect(ledger("project removed")).toEqual([expect.objectContaining({ actor: "lead for alex", repo, detail: "from lead" })]);
  expect(await releaseProject(store, { registryFile, path: repo, actor: lead, now: NOW })).toMatchObject({ ok: true, removed: false });
  expect(ledger("project removed")).toHaveLength(1);
  expect(await admitProject(store, { registryFile, path: repo, actor: owner, now: NOW })).toMatchObject({ ok: true, added: true });
  expect(ledger("project added")).toHaveLength(2);
});

test("the command line acts as this computer's user, or as the lead for an owner who manages every project", () => {
  expect(commandLineActor(store, { databaseFile })).toEqual({ label: userInfo().username, origin: "cli" });
  const alex = addApprover(store, "alex", NOW);
  if (!alex.ok) throw new Error("bootstrap");
  const minted = store.mintLeadCredential("alex", "alex", NOW);
  expect(commandLineActor(store, { databaseFile, leadToken: minted.token })).toEqual({ label: "lead for alex", origin: "lead" });
  expect(commandLineActor(store, { databaseFile, leadToken: "lt_000000000000_not-a-real-token-at-all-not-a-real-token-xxxx" })).toMatchObject({ ok: false });
  // A lead for someone limited to listed projects adds nothing.
  const robin = addApprover(store, "robin", NOW, { name: "alex", token: alex.token });
  if (!robin.ok) throw new Error("robin");
  const robinLead = store.mintLeadCredential("robin", "robin", NOW);
  expect(store.setAccountProjects("robin", [repo], "alex", NOW)).toEqual({ ok: true });
  expect(commandLineActor(store, { databaseFile, leadToken: robinLead.token })).toMatchObject({ ok: false, message: expect.stringContaining("limited to listed projects") });
});
