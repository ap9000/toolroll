/**
 * The one road for adding and removing projects (project-admission.ts):
 * proof before any write, idempotent ledger rows naming who and from where,
 * and the command line's authority — the owner, or the lead for an owner
 * who may manage every project, never anything else.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { admitProject, commandLineActor, releaseProject } from "./project-admission.js";
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

test("only first CLI admission discovers a network remote; all implicit re-adds preserve it", async () => {
  const trusted = "https://github.com/sam/shop.git";
  execFileSync("git", ["config", "remote.origin.url", trusted], { cwd: repo });
  expect(await admitProject(store, { registryFile, path: repo, actor: owner, now: NOW, captureOrigin: true })).toMatchObject({ remote: { url: trusted } });
  execFileSync("git", ["config", "remote.origin.url", "https://evil.example/shop.git"], { cwd: repo });
  for (const origin of ["cli", "console", "lead"] as const) {
    await admitProject(store, { registryFile, path: repo, actor: { label: "alex", origin }, now: NOW, captureOrigin: true });
    expect(store.projectRemote(repo)).toBe(trusted);
  }
  await releaseProject(store, { registryFile, path: repo, actor: owner, now: NOW });
  await admitProject(store, { registryFile, path: repo, actor: owner, now: NOW, captureOrigin: true });
  expect(store.projectRemote(repo)).toBeNull();
});

test("legacy projects, console openings and onboarding do not discover trust", async () => {
  execFileSync("git", ["config", "remote.origin.url", "https://evil.example/shop.git"], { cwd: repo });
  await admitProject(store, { registryFile, path: repo, actor: { label: "alex", origin: "console" }, now: NOW });
  expect(store.projectRemote(repo)).toBeNull();
  await admitProject(store, { registryFile, path: repo, actor: owner, now: NOW, captureOrigin: true });
  expect(store.projectRemote(repo)).toBeNull();
});

test("explicit owner remotes persist with full audit detail, and invalid or console changes do not mutate", async () => {
  store.upsertProject(repo, "shop", NOW);
  const trusted = "https://example.com/" + "long-path/".repeat(40) + "shop.git";
  expect(await admitProject(store, { registryFile, path: repo, actor: owner, now: NOW, remoteUrl: trusted })).toMatchObject({ ok: true, remote: { url: trusted } });
  expect(store.listProjects()[0]?.remoteUrl).toBe(trusted);
  expect(JSON.parse(ledger("project remote recorded")[0]!.detail!)).toEqual({ previousRemote: null, remoteUrl: trusted });
  for (const remoteUrl of ["/tmp/evil.git", "file:///tmp/evil.git", "https://token@example.com/shop.git", "ext::evil", "../shop.git", "https://localhost/shop.git", "ssh://git@127.0.0.1/shop.git", "git@127.1.2.3:shop.git", "https://[::1]/shop.git"]) {
    expect(await admitProject(store, { registryFile, path: repo, actor: owner, now: NOW, remoteUrl })).toMatchObject({ ok: false });
  }
  expect(await admitProject(store, { registryFile, path: repo, actor: { label: "alex", origin: "console" }, now: NOW, remoteUrl: "https://evil.example/shop.git" })).toMatchObject({ ok: false });
  expect(store.projectRemote(repo)).toBe(trusted);
  expect(ledger("project remote recorded")).toHaveLength(1);
  const replacement = "git@example.com:shop.git";
  await admitProject(store, { registryFile, path: repo, actor: owner, now: NOW, remoteUrl: replacement });
  expect(store.projectRemote(repo)).toBe(replacement);
  expect(JSON.parse(ledger("project remote recorded")[0]!.detail!)).toEqual({ previousRemote: trusted, remoteUrl: replacement });
});

test("admission Git reads discard all inherited GIT variables and disable config includes", async () => {
  const { run } = await import("./exec.js");
  const calls: string[][] = [];
  const previous = process.env["GIT_DIR"];
  process.env["GIT_DIR"] = join(base, "nonexistent-injected-git-dir");
  try {
  const admitted = await admitProject(store, { registryFile, path: repo, actor: owner, now: NOW, captureOrigin: true, exec: async (file, args, options) => {
    expect(options?.envAllowlist?.some(name => name.startsWith("GIT_"))).toBe(false);
    expect(options?.env).toMatchObject({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1" });
    calls.push([...args]);
    return run(file, args, options);
  } });
  expect(admitted.ok).toBe(true);
  expect(calls).toContainEqual(["config", "--local", "--no-includes", "--get", "remote.origin.url"]);
  } finally {
    if (previous === undefined) delete process.env["GIT_DIR"]; else process.env["GIT_DIR"] = previous;
  }
});

test("first admission refuses local remotes outside the checkout, file URLs and loopback hosts", async () => {
  for (const [name, remote] of [["local-project", join(base, "outside.git")], ["file-project", "file:///tmp/outside.git"], ["loopback-project", "ssh://git@localhost/outside.git"]] as const) {
    const project = join(base, name);
    execFileSync("git", ["init", "-q", project]);
    execFileSync("git", ["config", "remote.origin.url", remote], { cwd: project });
    const result = await admitProject(store, { registryFile, path: project, actor: owner, now: NOW, captureOrigin: true });
    expect(result).toMatchObject({ ok: true, remote: { url: null } });
    expect(store.projectRemote(project)).toBeNull();
  }
});

test("authority that moves while the git proof waits admits nothing: not in the registry, not in the store", async () => {
  // The proof is held until the test lets it go; meanwhile the caller's authority moves.
  let letGo!: () => void;
  const held = new Promise<void>(done => { letGo = done; });
  let proofs = 0;
  const exec = async (_file: string, args: readonly string[]) => {
    proofs++;
    await held;
    return { code: 0, stdout: args.includes("--show-toplevel") ? `${repo}\n` : "", stderr: "", timedOut: false, notFound: false };
  };
  let authority = true;
  const console = { label: "alex", origin: "console" as const };
  const admitting = admitProject(store, { registryFile, path: repo, actor: console, now: NOW, exec, stillAllowed: () => authority });
  await vi.waitFor(() => expect(proofs).toBe(1));
  authority = false;
  letGo();
  expect(await admitting).toMatchObject({ ok: false, reason: "moved" });
  expect(await loadProjectRegistry(registryFile)).toEqual({ repos: [], roots: [] });
  expect(store.listProjects()).toEqual([]);
  expect(ledger("project added")).toEqual([]);
});

test("authority that moves between the registry and the store takes back the registry line it added, and only that", async () => {
  const other = join(base, "already-saved");
  mkdirSync(other);
  execFileSync("git", ["init", "-q"], { cwd: other });
  await admitProject(store, { registryFile, path: other, actor: owner, now: NOW });
  // Allowed under the registry lock, refused in the transaction.
  const answers = [true, false];
  const moved = await admitProject(store, { registryFile, path: repo, actor: { label: "alex", origin: "console" }, now: NOW, stillAllowed: () => answers.shift() ?? false });
  expect(moved).toMatchObject({ ok: false, reason: "moved" });
  expect(await loadProjectRegistry(registryFile)).toEqual({ repos: [other], roots: [] });
  expect(store.listProjects().map(one => one.path)).toEqual([other]);
});
