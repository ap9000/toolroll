/**
 * Flexible threads' own repositories and the thread fence's terms (flexible-thread.ts, the Flexible plan v2 §1/§2,
 * slice F2a), with the build's constant replaced (vi.mock): the repository a thread gets, the keep-ref that holds its
 * base, removal, the refusals for repositories and folders that can't be trusted, and what the fence denies. The
 * native attacks (the real sandbox) are test/attacks/flexible-thread-fence.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { flexibleKeepRef, flexibleThread, flexibleThreadEnv, flexibleThreadFence, flexibleThreadPaths, flexibleThreadSpawn, prepareFlexibleThread, removeFlexibleThread, threadCredentialPaths } from "./flexible-thread.js";
import { srtTermsOf } from "./agent-fence.js";
import { run, type ExecResult } from "./exec.js";
import { objectsInventory, tgit, threadWorld, type ThreadWorld } from "../test/flexible-thread-world.js";

vi.mock("./flexible-available.js", () => ({ FLEXIBLE_AVAILABLE: true }));
// Whether this machine can sandbox, as exec.ts asks it (agent-fence.ts): a test turns it off to see a thread refuse.
const fenceHere = vi.hoisted(() => ({ off: false }));
vi.mock("./agent-fence.js", async importOriginal => {
  const real = await importOriginal<typeof import("./agent-fence.js")>();
  return { ...real, macosFenceAvailable: (...args: Parameters<typeof real.macosFenceAvailable>) => !fenceHere.off && real.macosFenceAvailable(...args),
    linuxFenceAvailable: (...args: Parameters<typeof real.linuxFenceAvailable>) => !fenceHere.off && real.linuxFenceAvailable(...args) };
});

const NOW = new Date("2026-11-14T12:00:00.000Z");
const STORAGE = { names: [], denies: [] };
const NETWORK = { proxyPort: 41_000, token: "run-token" };
let world: ThreadWorld;
beforeEach(() => { world = threadWorld(); fenceHere.off = false; });
afterEach(() => { world.store.close(); rmSync(world.dir, { recursive: true, force: true }); });

async function made(base = "HEAD") {
  const thread = await prepareFlexibleThread(world.store, { repo: world.project, base, by: "alex", now: NOW });
  if (!thread.ok) throw new Error(thread.message);
  return thread;
}

describe("a thread's own repository", () => {
  test("a fresh repository on its own branch at the base, borrowing the project's objects, with no remotes; the project gets only the keep-ref", async () => {
    const refsBefore = tgit(world.project, "for-each-ref", "--format=%(refname) %(objectname)");
    const { thread, paths } = await made("release");
    expect(thread).toMatchObject({ repo: world.project, baseSha: world.first, keepRef: flexibleKeepRef(thread.id), folder: paths.folder, state: "ready", createdBy: "alex" });
    expect(paths.folder).toBe(join(world.state, "threads", thread.id));
    expect(readFileSync(join(paths.repo, ".git", "objects", "info", "alternates"), "utf8")).toBe(`${world.objects}\n`);
    expect(existsSync(join(paths.repo, ".git", "commondir"))).toBe(false);
    expect(tgit(paths.repo, "symbolic-ref", "HEAD")).toBe(`refs/heads/toolroll/code-${thread.id}`);
    expect(tgit(paths.repo, "rev-parse", "HEAD")).toBe(world.first);
    expect(tgit(paths.repo, "status", "--porcelain")).toBe("");
    expect(existsSync(join(paths.repo, "README.md")) && !existsSync(join(paths.repo, "app.js"))).toBe(true);
    expect(tgit(paths.repo, "remote")).toBe("");
    expect(readFileSync(join(paths.repo, ".git", "config"), "utf8")).not.toMatch(/\[remote|url\s*=|insteadOf|hooksPath|fsmonitor/i);
    expect(existsSync(join(paths.repo, ".git", "hooks")) && tgit(paths.repo, "rev-parse", "--git-path", "hooks").endsWith("hooks")).toBe(true);
    // The project's refs: exactly what they were, plus the keep-ref at the base.
    expect(tgit(world.project, "for-each-ref", "--format=%(refname) %(objectname)")).toBe([refsBefore, `${flexibleKeepRef(thread.id)} ${world.first}`].sort().join("\n"));
    expect(world.store.handle.prepare("SELECT action, outcome FROM action_ledger WHERE action LIKE 'flexible thread%'").all().map(row => ({ ...row }))).toEqual([{ action: "flexible thread repository made", outcome: "ready" }]);
  });

  test("the thread's commits, gc and repack land in its own objects; the project's objects stay exactly as they were", async () => {
    const { paths } = await made();
    const before = objectsInventory(world.objects);
    writeFileSync(join(paths.repo, "new.txt"), "thread work\n");
    tgit(paths.repo, "add", "new.txt");
    tgit(paths.repo, "commit", "-qm", "thread work");
    tgit(paths.repo, "gc", "-q", "--prune=now");
    tgit(paths.repo, "repack", "-a", "-d", "-q");
    expect(tgit(paths.repo, "log", "--format=%s")).toBe("thread work\nsecond\nfirst");
    expect(objectsInventory(world.objects)).toEqual(before);
    expect(() => tgit(world.project, "cat-file", "-e", tgit(paths.repo, "rev-parse", "HEAD"))).toThrow();
  });

  test("the keep-ref holds the base when the person deletes its branch and prunes (E4); without it the base goes", async () => {
    const feature = (name: string) => {
      tgit(world.project, "checkout", "-q", "-b", name);
      writeFileSync(join(world.project, `${name}.txt`), `${name}\n`);
      tgit(world.project, "add", `${name}.txt`);
      tgit(world.project, "commit", "-qm", name);
      const sha = tgit(world.project, "rev-parse", "HEAD");
      tgit(world.project, "checkout", "-q", "main");
      return sha;
    };
    const kept = feature("kept"), lost = feature("lost");
    const one = await made("kept"), two = await made("lost");
    // The control: the second thread's keep-ref taken away, as if there were none.
    tgit(world.project, "update-ref", "-d", flexibleKeepRef(two.thread.id));
    tgit(world.project, "branch", "-D", "kept", "lost");
    tgit(world.project, "reflog", "expire", "--expire=now", "--all");
    tgit(world.project, "gc", "-q", "--prune=now");
    expect(tgit(world.project, "cat-file", "-t", kept)).toBe("commit");
    expect(tgit(one.paths.repo, "rev-parse", "HEAD^{tree}")).toMatch(/^[0-9a-f]{40}$/);
    expect(() => tgit(world.project, "cat-file", "-e", lost)).toThrow();
    expect(() => tgit(two.paths.repo, "cat-file", "-e", "HEAD^{tree}")).toThrow();
  }, 30_000);

  test.each([
    ["a folder that isn't a project", (w: ThreadWorld) => ({ repo: join(w.dir, "projects", "unknown"), base: "HEAD" }), "not-a-project"],
    ["a base that names an option", (w: ThreadWorld) => ({ repo: w.project, base: "--output=/tmp/x" }), "base-unknown"],
    ["a base that isn't there", (w: ThreadWorld) => ({ repo: w.project, base: "no-such-branch" }), "base-unknown"],
    ["a range for a base", (w: ThreadWorld) => ({ repo: w.project, base: "main..release" }), "base-unknown"],
  ])("refused: %s", async (_name, input, reason) => {
    const refused = await prepareFlexibleThread(world.store, { ...input(world), by: "alex", now: NOW });
    expect(refused).toMatchObject({ ok: false, reason });
    expect(world.store.handle.prepare("SELECT COUNT(*) AS n FROM flexible_thread").get()!["n"]).toBe(0);
  });

  test.each([
    ["a partial clone", (w: ThreadWorld) => tgit(w.project, "config", "extensions.partialClone", "origin")],
    ["a promisor remote", (w: ThreadWorld) => { tgit(w.project, "config", "remote.origin.url", "https://example.invalid/x.git"); tgit(w.project, "config", "remote.origin.promisor", "true"); }],
    ["a repository that borrows objects itself", (w: ThreadWorld) => writeFileSync(join(w.objects, "info", "alternates"), `${join(w.dir, "elsewhere")}\n`)],
    ["a linked .git", (w: ThreadWorld) => { renameSync(join(w.project, ".git"), join(w.dir, "moved.git")); symlinkSync(join(w.dir, "moved.git"), join(w.project, ".git")); }],
    ["a repository whose config can run a command", (w: ThreadWorld) => tgit(w.project, "config", "core.sshCommand", "touch /tmp/pwned")],
  ])("refused, and nothing made: %s", async (_name, spoil) => {
    spoil(world);
    const refused = await prepareFlexibleThread(world.store, { repo: world.project, base: "HEAD", by: "alex", now: NOW });
    expect(refused).toMatchObject({ ok: false, reason: expect.stringMatching(/^(repository-unusable|base-unknown)$/) });
    expect(existsSync(join(world.state, "threads")) ? readdirSync(join(world.state, "threads")) : []).toEqual([]);
    expect(world.store.handle.prepare("SELECT COUNT(*) AS n FROM flexible_thread WHERE state IN ('preparing', 'ready')").get()!["n"]).toBe(0);
  });

  test("a setup that fails part way leaves nothing: no folder, no keep-ref, the record failed", async () => {
    const failing = async (file: string, args: readonly string[], options?: Parameters<typeof run>[2]): Promise<ExecResult> =>
      args.includes("reset") ? { code: 1, stdout: "", stderr: "simulated", timedOut: false, notFound: false } : run(file, args, options);
    const refused = await prepareFlexibleThread(world.store, { repo: world.project, base: "HEAD", by: "alex", now: NOW, runner: failing });
    expect(refused).toMatchObject({ ok: false, reason: "setup-failed" });
    const row = world.store.handle.prepare("SELECT * FROM flexible_thread").get()!;
    expect(row["state"]).toBe("failed");
    expect(existsSync(String(row["folder"]))).toBe(false);
    expect(tgit(world.project, "for-each-ref", "refs/toolroll")).toBe("");
  });

  test("removal takes the keep-ref by compare-and-swap and the folder; a keep-ref someone moved is left and said", async () => {
    const one = await made();
    expect(await removeFlexibleThread(world.store, { id: one.thread.id, by: "alex", now: NOW })).toEqual({ ok: true, keepRef: "removed" });
    expect(existsSync(one.paths.folder)).toBe(false);
    expect(tgit(world.project, "for-each-ref", "refs/toolroll")).toBe("");
    expect(flexibleThread(world.store, one.thread.id)).toMatchObject({ state: "removed", endedAt: NOW.toISOString() });
    expect(await removeFlexibleThread(world.store, { id: one.thread.id, by: "alex", now: NOW })).toMatchObject({ ok: false, reason: "thread-not-ready" });
    const two = await made();
    tgit(world.project, "update-ref", flexibleKeepRef(two.thread.id), world.first);
    expect(await removeFlexibleThread(world.store, { id: two.thread.id, by: "alex", now: NOW })).toEqual({ ok: true, keepRef: "moved" });
    expect(tgit(world.project, "rev-parse", flexibleKeepRef(two.thread.id))).toBe(world.first);
  });

  test("the record is written once and only moves forward", async () => {
    const { thread } = await made();
    for (const sql of ["UPDATE flexible_thread SET repo = '/elsewhere' WHERE id = ?", "UPDATE flexible_thread SET folder = '/elsewhere' WHERE id = ?",
      "UPDATE flexible_thread SET base_sha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' WHERE id = ?", "UPDATE flexible_thread SET state = 'preparing' WHERE id = ?"]) {
      expect(() => world.store.handle.prepare(sql).run(thread.id), sql).toThrow(/written once/);
    }
    expect(() => world.store.handle.prepare("INSERT INTO flexible_thread (id, repo, base_sha, keep_ref, folder, created_by, created_at, state) VALUES ('x', 'r', 'aa', 'k', 'f', 'a', 'b', 'ready')").run()).toThrow();
  });
});

describe("the thread fence's terms", () => {
  test("no keychain, only the proxy, no shared temp; credentials, Toolroll's state, the project's repository (but its objects) and other projects denied; writes only the thread's own folders", async () => {
    const { thread, paths } = await made();
    const fenced = flexibleThreadFence(world.store, { id: thread.id, network: NETWORK, storage: STORAGE });
    if (!fenced.ok) throw new Error(fenced.message);
    const grants = fenced.launch.fenceGrants;
    expect(grants.keychain).toBeUndefined();
    expect(fenced.launch.confinement).toBe("required");
    const terms = srtTermsOf(fenced.launch.fence, grants);
    expect(terms.keychain).toBeUndefined();
    expect(terms.network).toEqual({ kind: "proxy", httpPort: NETWORK.proxyPort, token: NETWORK.token, localServices: false, unixSockets: [] });
    expect(terms.writeConfig.allowOnly).not.toContain("/tmp/claude");
    expect(terms.writeConfig.allowOnly).not.toContain("/private/tmp/claude");
    for (const path of [paths.repo, paths.tmp, paths.cache]) expect(terms.writeConfig.allowOnly).toContain(path);
    expect(terms.writeConfig.allowOnly.some(path => path === "/" || path === paths.folder || path === paths.home || path.startsWith(world.project))).toBe(false);
    for (const path of [join(paths.repo, ".git", "config"), join(paths.repo, ".git", "hooks"), join(paths.repo, ".git", "objects", "info", "alternates"), paths.home]) expect(terms.writeConfig.denyWithinAllow).toContain(path);
    const home = realpathSync(homedir());
    for (const name of [".ssh", ".aws", ".config/gh", ".git-credentials", ".netrc", ".docker/config.json", ".npmrc", ".kube", ".gnupg", ".claude", ".claude.json", ".codex", ".gemini"]) {
      expect(terms.readConfig.denyOnly, name).toContain(join(home, name));
    }
    expect(threadCredentialPaths(home)).toContain(join(home, ".pypirc"));
    for (const path of [world.project, world.other, world.databaseFile, join(world.state, "threads")]) expect(terms.readConfig.denyOnly, path).toContain(path);
    expect(terms.readConfig.allowWithinDeny).toContain(world.objects);
    expect(terms.readConfig.allowWithinDeny).not.toContain(join(world.project, ".git"));
    expect(terms.readConfig.allowWithinDeny).toContain(paths.folder);
  });

  test("no provider's own sign-in is exempt: each is denied to read and never written", async () => {
    const { thread } = await made();
    const home = realpathSync(homedir());
    for (const [name, text] of [[".claude.json", "{}"], [join(".claude", ".credentials.json"), "{}"], [join(".codex", "auth.json"), "{}"]] as const) {
      mkdirSync(join(home, name, ".."), { recursive: true });
      writeFileSync(join(home, name), text);
    }
    const fenced = flexibleThreadFence(world.store, { id: thread.id, network: NETWORK, storage: STORAGE });
    if (!fenced.ok) throw new Error(fenced.message);
    const terms = srtTermsOf(fenced.launch.fence, fenced.launch.fenceGrants);
    for (const name of [".claude", ".claude.json", ".codex", ".gemini"]) expect(terms.readConfig.denyOnly, name).toContain(join(home, name));
    for (const name of [".claude.json", join(".claude", ".credentials.json"), ".codex"]) expect(fenced.launch.fenceGrants.writeDenies, name).toContain(join(home, name));
    expect(terms.writeConfig.allowOnly.some(path => path.startsWith(join(home, ".claude")))).toBe(false);
  });

  test.each([
    ["no proxy port", { proxyPort: 0, token: "t" }],
    ["no proxy token", { proxyPort: 41_000, token: "" }],
  ])("refused without its own proxy: %s", async (_name, network) => {
    const { thread } = await made();
    expect(flexibleThreadFence(world.store, { id: thread.id, network, storage: STORAGE })).toMatchObject({ ok: false, reason: "network-required" });
  });

  test.each([
    ["its folder replaced by a link", (p: ReturnType<typeof flexibleThreadPaths>, w: ThreadWorld) => { renameSync(p.folder, `${p.folder}.moved`); symlinkSync(`${p.folder}.moved`, p.folder); void w; }],
    ["its repository replaced by a link", (p: ReturnType<typeof flexibleThreadPaths>, w: ThreadWorld) => { rmSync(p.repo, { recursive: true }); symlinkSync(w.project, p.repo); }],
    ["its alternates pointed elsewhere", (p: ReturnType<typeof flexibleThreadPaths>, w: ThreadWorld) => writeFileSync(join(p.repo, ".git", "objects", "info", "alternates"), `${join(w.other, ".git", "objects")}\n`)],
    ["its .git made a pointer", (p: ReturnType<typeof flexibleThreadPaths>, w: ThreadWorld) => { rmSync(join(p.repo, ".git"), { recursive: true }); writeFileSync(join(p.repo, ".git"), `gitdir: ${join(w.project, ".git")}\n`); }],
    ["its temp made a link", (p: ReturnType<typeof flexibleThreadPaths>, w: ThreadWorld) => { rmSync(p.tmp, { recursive: true }); symlinkSync(w.state, p.tmp); }],
  ])("refused when the thread's folder isn't the one Toolroll made: %s", async (_name, spoil) => {
    const { thread, paths } = await made();
    spoil(paths, world);
    expect(flexibleThreadFence(world.store, { id: thread.id, network: NETWORK, storage: STORAGE })).toMatchObject({ ok: false, reason: "thread-folder-changed" });
  });

  test("refused for a thread that isn't ready, isn't known, or whose project is gone", async () => {
    const { thread } = await made();
    expect(flexibleThreadFence(world.store, { id: "0".repeat(32), network: NETWORK, storage: STORAGE })).toMatchObject({ ok: false, reason: "thread-unknown" });
    expect(flexibleThreadFence(world.store, { id: "../../etc", network: NETWORK, storage: STORAGE })).toMatchObject({ ok: false, reason: "thread-unknown" });
    world.store.handle.prepare("DELETE FROM project WHERE path = ?").run(world.project);
    expect(flexibleThreadFence(world.store, { id: thread.id, network: NETWORK, storage: STORAGE })).toMatchObject({ ok: false, reason: "not-a-project" });
    world.store.upsertProject(world.project, "shop", NOW);
    expect(await removeFlexibleThread(world.store, { id: thread.id, by: "alex", now: NOW })).toMatchObject({ ok: true });
    expect(flexibleThreadFence(world.store, { id: thread.id, network: NETWORK, storage: STORAGE })).toMatchObject({ ok: false, reason: "thread-not-ready" });
  });

  test("the agent's environment is exactly the thread's: no SSH agent, token or provider key of Toolroll's", async () => {
    const { paths } = await made();
    const env = flexibleThreadEnv(paths, { HTTPS_PROXY: "http://x:t@127.0.0.1:41000" }, { PATH: "/usr/bin", SSH_AUTH_SOCK: "/tmp/agent.sock", GH_TOKEN: "t", ANTHROPIC_API_KEY: "k", AWS_SECRET_ACCESS_KEY: "s", OPENAI_API_KEY: "o", GIT_ASKPASS: "/x", LANG: "C" });
    expect(Object.keys(env).filter(name => /SSH_AUTH|TOKEN|API_KEY|SECRET|ASKPASS/.test(name))).toEqual([]);
    expect(env).toMatchObject({ PATH: "/usr/bin", LANG: "C", TMPDIR: paths.tmp, GIT_TERMINAL_PROMPT: "0", HTTPS_PROXY: "http://x:t@127.0.0.1:41000" });
  });

  test("no sandbox here: the thread refuses to start, even where an operator allowed unconfined agents (D7)", async () => {
    const { thread } = await made();
    world.store.setUnfencedAgentsAllowed(true, "alex", NOW);
    fenceHere.off = true;
    const refused = await flexibleThreadSpawn(world.store, { id: thread.id, network: NETWORK, storage: STORAGE, proxyEnv: {} }, "/bin/sh", ["-c", "echo ran"]);
    expect(refused).toMatchObject({ ok: false, reason: "containment" });
  });

  test("a launch whose sandbox can't be read as the platform's refuses", async () => {
    const { thread } = await made();
    const other = process.platform === "darwin" ? "linux" : "darwin";
    const refused = await flexibleThreadSpawn(world.store, { id: thread.id, network: NETWORK, storage: STORAGE, proxyEnv: {} }, "/bin/sh", ["-c", "echo ran"], other);
    expect(refused).toMatchObject({ ok: false, reason: "containment" });
  });
});

