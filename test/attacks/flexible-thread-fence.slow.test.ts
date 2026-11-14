/**
 * Attack: a Flexible thread getting out of its fence (flexible-thread.ts; the Flexible plan v2 §1, §2 and §12, Codex
 * round 2 item 3), against the real sandbox: the launch is exactly what flexibleThreadSpawn hands back (its containment
 * probe included), on Seatbelt on a Mac and bubblewrap on Linux. Every row needs the OS fence (needs(ctx, osFence()):
 * on a lane that requires native attacks, an unavailable fence fails the row instead of skipping it); the keychain row is
 * the Mac's. Codex's own sandbox isn't a backend for threads: it can't deny what is made after it starts, so a Codex
 * thread is refused (flexible-thread.test.ts).
 *
 * Rows: ordinary work in the thread's own repository still works and leaves the project's objects as they were; every
 * write to the project's repository (objects, alternates, refs, packed-refs, config, hooks, worktrees, its files) and
 * to the thread's own config, hooks, alternates and protected names is refused; another thread's folder is unreadable
 * and unwritable; credential files, the keychain (a synthetic item in a throwaway keychain, never the person's), a
 * stored Git credential and an SSH-agent socket are out of reach, from the agent and from a detached descendant; no
 * connection but the run's proxy; Toolroll's state, its install and the person's launch configuration are unwritable;
 * the shared /tmp/claude is unwritable; the threads' folder is out of reach of every other launch too; protected names
 * can't be made, replaced or removed, and still hold at the next launch; a thread or state file made after a launch
 * started stays out of its reach; no direct TCP or UDP leaves; and a removal can't slip between a launch's checks and its
 * spawn.
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:net";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fenceFor, runFolders, taskBoundary, trustedWorktreeBinding } from "../../src/agent-fence.js";
import { flexibleThread, flexibleThreadFence, flexibleThreadSpawn, prepareFlexibleThread, removeFlexibleThread, type FlexibleThreadPaths } from "../../src/flexible-thread.js";
import { objectsInventory, tgit, threadWorld, type ThreadWorld } from "../flexible-thread-world.js";
import { marker, needs, osFence, q, seatbelt, underSandbox, underSandboxAsync, write } from "./harness.js";

vi.mock("../../src/flexible-available.js", () => ({ FLEXIBLE_AVAILABLE: true }));

const NOW = new Date("2026-11-14T12:00:00.000Z");
const STORAGE = { names: [], denies: [] };
let world: ThreadWorld;
let servers: Server[] = [];
beforeEach(() => { world = threadWorld(); servers = []; });
afterEach(async () => {
  for (const server of servers) await new Promise<void>(done => server.close(() => done()));
  world.store.close();
  rmSync(world.dir, { recursive: true, force: true });
});

async function listen(at: number | string): Promise<{ server: Server; port: number }> {
  const server = createServer(socket => socket.end("hello\n"));
  servers.push(server);
  await new Promise<void>((done, failed) => { server.once("error", failed); server.listen(typeof at === "number" ? { port: at, host: "127.0.0.1" } : at, () => done()); });
  const address = server.address();
  return { server, port: typeof address === "object" && address !== null ? address.port : 0 };
}

async function thread(): Promise<{ id: string; paths: FlexibleThreadPaths }> {
  const made = await prepareFlexibleThread(world.store, { repo: world.project, base: "HEAD", by: "alex", now: NOW });
  if (!made.ok) throw new Error(made.message);
  return { id: made.thread.id, paths: made.paths };
}

type Ran = { status: number | null; stdout: string; stderr: string };
/** `script` in /bin/sh as a thread's agent, started by flexibleThreadSpawn exactly as a caller starts one (its own
 * process group), with `done` settling when it ends. */
async function startInThread(id: string, script: string, proxyPort = 1): Promise<{ pid: number; done: Promise<Ran> }> {
  let done: Promise<Ran> | null = null;
  const launch = await flexibleThreadSpawn(world.store, { id, network: { proxyPort, token: "run-token" }, storage: STORAGE, proxyEnv: {} }, "/bin/sh", ["-c", script], spec => {
    const child = spawn(spec.file, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    done = new Promise(settle => {
      let stdout = "", stderr = "";
      child.stdout!.on("data", chunk => { stdout += chunk; });
      child.stderr!.on("data", chunk => { stderr += chunk; });
      child.on("close", status => settle({ status, stdout, stderr }));
    });
    return child.pid ?? 0;
  });
  if (!launch.ok) throw new Error(launch.message);
  return { pid: launch.pid, done: done! };
}
const inThread = async (id: string, script: string, proxyPort = 1): Promise<Ran> => (await startInThread(id, script, proxyPort)).done;
/** Until `test` holds, a tenth of a second at a time (at most ten seconds). */
async function until(test: () => boolean): Promise<void> {
  for (let waited = 0; waited < 100 && !test(); waited++) await new Promise(done => setTimeout(done, 100));
  expect(test()).toBe(true);
}

/** Each attack as `name: command`; the probe prints `ALLOWED <name>` for any that worked. */
const attempts = (rows: readonly [string, string][]): string => rows.map(([name, command]) => `if (${command}) >/dev/null 2>&1; then echo "ALLOWED ${name}"; fi`).join("\n");
const allowed = (out: { stdout: string }): string[] => out.stdout.split("\n").filter(line => line.startsWith("ALLOWED "));

describe("attack: a Flexible thread leaving its fence", () => {
  test("native: ordinary work in the thread's repository works, and every commit, gc and repack lands in its own objects", async ctx => {
    needs(ctx, osFence());
    const { id, paths } = await thread();
    const before = objectsInventory(world.objects);
    const g = "git -c user.name=t -c user.email=t@example.invalid";
    const out = await inThread(id, [
      `${g} status --porcelain >/dev/null && echo status-ok`,
      `${g} log --format=%s | head -1`,
      `echo work > work.txt && ${g} add work.txt && ${g} commit -qm work && echo commit-ok`,
      `${g} blame README.md >/dev/null && echo blame-ok`,
      `${g} gc -q && ${g} repack -a -d -q && ${g} prune && echo gc-ok`,
      `echo t > "$TMPDIR/t" && echo tmp-ok`,
      `${q(process.execPath)} -e 'console.log("node-ok")'`,
    ].join("\n"));
    expect(out.stdout.trim().split("\n"), out.stderr).toEqual(["status-ok", "second", "commit-ok", "blame-ok", "gc-ok", "tmp-ok", "node-ok"]);
    expect(tgit(paths.repo, "log", "--format=%s", "-1")).toBe("work");
    expect(objectsInventory(world.objects)).toEqual(before);
  }, 60_000);

  test("native: the project's repository and the thread's own config, hooks, alternates and protected names are never written", async ctx => {
    needs(ctx, osFence());
    const { id, paths } = await thread();
    const git = join(world.project, ".git");
    const pack = readdirSync(join(world.objects, "pack")).find(name => name.endsWith(".pack"))!;
    const loose = readdirSync(world.objects).filter(name => /^[0-9a-f]{2}$/.test(name)).flatMap(dir => readdirSync(join(world.objects, dir)).map(file => join(world.objects, dir, file)))[0]!;
    const refs = tgit(world.project, "for-each-ref", "--format=%(refname) %(objectname)");
    const config = readFileSync(join(git, "config"), "utf8");
    const before = objectsInventory(world.objects);
    const out = await inThread(id, attempts([
      ["delete a pack", `rm -f ${q(join(world.objects, "pack", pack))}`],
      ["overwrite a pack", `: > ${q(join(world.objects, "pack", pack))}`],
      ["delete a loose object", `rm -f ${q(loose)}`],
      ["write the project's alternates", `echo /tmp > ${q(join(world.objects, "info", "alternates"))}`],
      ["add an object", `echo x > ${q(join(world.objects, "ab", "cdef"))} || mkdir ${q(join(world.objects, "zz"))}`],
      ["write a ref", `echo ${world.first} > ${q(join(git, "refs", "heads", "evil"))}`],
      ["git update-ref there", `git -C ${q(world.project)} update-ref refs/heads/evil HEAD`],
      ["write packed-refs", `echo x >> ${q(join(git, "packed-refs"))}`],
      ["write its config", `echo '[core]' >> ${q(join(git, "config"))}`],
      ["write a hook", `mkdir -p ${q(join(git, "hooks"))} && echo x > ${q(join(git, "hooks", "pre-commit"))}`],
      ["add a worktree pointer", `mkdir -p ${q(join(git, "worktrees", "evil"))}`],
      ["write its files", `echo x >> ${q(join(world.project, "README.md"))}`],
      ["read its files", `cat ${q(join(world.project, "README.md"))}`],
      ["read its config", `cat ${q(join(git, "config"))}`],
      ["write the thread's config", "echo '[core]' >> .git/config"],
      ["write the thread's hooks", "echo x > .git/hooks/post-checkout"],
      ["write the thread's alternates", "echo /tmp > .git/objects/info/alternates"],
      ["move the thread's alternates aside", "mv .git/objects/info .git/objects/info2 && mkdir .git/objects/info && echo /tmp > .git/objects/info/alternates"],
      ["link the thread's objects to the project's", `mv .git/objects .git/objects2 && ln -s ${q(world.objects)} .git/objects`],
      ["plant Claude settings", "mkdir -p .claude && echo '{}' > .claude/settings.json"],
      ["plant an MCP server", "echo '{}' > .mcp.json"],
      ["plant a config home setting", `echo '{}' > ${q(join(paths.home, "settings.json"))}`],
    ]));
    expect(allowed(out), out.stderr).toEqual([]);
    expect(objectsInventory(world.objects)).toEqual(before);
    expect(tgit(world.project, "for-each-ref", "--format=%(refname) %(objectname)")).toBe(refs);
    expect(readFileSync(join(git, "config"), "utf8")).toBe(config);
    expect(readFileSync(join(paths.repo, ".git", "objects", "info", "alternates"), "utf8")).toBe(`${world.objects}\n`);
    // The reserved placeholders as Toolroll made them.
    expect(readFileSync(join(paths.repo, ".mcp.json"), "utf8")).toBe("{}\n");
    expect(readFileSync(join(paths.repo, ".claude", "settings.json"), "utf8")).toBe("{}\n");
    // Still a working thread: its own objects and its project's base, read through the alternates.
    expect(tgit(paths.repo, "cat-file", "-t", world.first)).toBe("commit");
  }, 60_000);

  test("native: another thread's folder is neither read nor written", async ctx => {
    needs(ctx, osFence());
    const mine = await thread();
    const theirs = await thread();
    const secret = marker("other-thread");
    write(join(theirs.paths.repo, "secret.txt"), secret);
    const out = await inThread(mine.id, [`cat ${q(join(theirs.paths.repo, "secret.txt"))} 2>/dev/null; ls ${q(theirs.paths.folder)} 2>/dev/null`,
      attempts([["write there", `echo x > ${q(join(theirs.paths.repo, "planted.txt"))}`], ["write the threads folder", `echo x > ${q(join(dirname(theirs.paths.folder), "planted"))}`]])].join("\n"));
    expect(out.stdout).not.toContain(secret);
    expect(out.stdout).not.toContain("secret.txt");
    expect(allowed(out)).toEqual([]);
    expect(existsSync(join(theirs.paths.repo, "planted.txt"))).toBe(false);
  }, 60_000);

  test("native: credential files, other projects and a stored Git credential are unreadable, from the agent and from a detached descendant", async ctx => {
    needs(ctx, osFence());
    const { id, paths } = await thread();
    const secret = marker("credential");
    const home = realpathSync(homedir());
    const files = [".ssh/id_ed25519", ".aws/credentials", ".config/gh/hosts.yml", ".netrc", ".docker/config.json", ".npmrc", ".pypirc", ".kube/config", ".gnupg/private.key",
      ".claude.json", ".claude/.credentials.json", ".codex/auth.json", ".gemini/oauth_creds.json", ".config/gcloud/credentials.db"].map(name => write(join(home, name), `${secret}\n`));
    write(join(home, ".git-credentials"), `https://someone:${secret}@example.com\n`);
    write(join(world.other, "secret.txt"), `${secret}\n`);
    const reads = [...files, join(home, ".git-credentials"), join(world.other, "secret.txt")].map(file => `cat ${q(file)} 2>/dev/null`).join("; ");
    const fill = "printf 'protocol=https\\nhost=example.com\\n\\n' | git -c credential.helper=store credential fill 2>/dev/null";
    // The control: outside the fence, the same reads and the same fill print the secret.
    expect(spawnSync("/bin/sh", ["-c", `${reads}; ${fill}`], { encoding: "utf8", env: { ...process.env, HOME: home, GIT_TERMINAL_PROMPT: "0" } }).stdout).toContain(secret);
    const descendant = `perl -MPOSIX -e 'exit if fork; POSIX::setsid(); exit if fork; sleep 1; exec "/bin/sh", "-c", shift' ${q(`(${reads}; ${fill}; echo done) > "$TMPDIR/descendant.out" 2>&1`)}`;
    const out = await inThread(id, `${reads}; ${fill}; sh -c ${q(reads)}; ${descendant}; echo started`);
    expect(out.stdout, out.stderr).toContain("started");
    expect(out.stdout).not.toContain(secret);
    const result = join(paths.tmp, "descendant.out");
    for (let waited = 0; waited < 100 && !(existsSync(result) && readFileSync(result, "utf8").includes("done")); waited++) await new Promise(done => setTimeout(done, 100));
    expect(readFileSync(result, "utf8")).toContain("done");
    expect(readFileSync(result, "utf8")).not.toContain(secret);
  }, 60_000);

  test("native: a synthetic keychain item is out of reach, from the agent and from a descendant (a throwaway keychain, never the person's)", async ctx => {
    needs(ctx, seatbelt());
    const { id } = await thread();
    // The test file's own HOME (test/setup-state.ts): the keychain search list of the person's account is never touched.
    const keychain = join(world.dir, "probe.keychain-db");
    const secret = marker("keychain");
    const security = (...args: string[]) => spawnSync("/usr/bin/security", args, { encoding: "utf8", timeout: 30_000, env: { ...process.env, HOME: homedir() } });
    expect(security("create-keychain", "-p", "throwaway", keychain).status).toBe(0);
    try {
      expect(security("unlock-keychain", "-p", "throwaway", keychain).status).toBe(0);
      expect(security("add-generic-password", "-a", "toolroll-thread", "-s", "toolroll-thread-probe", "-w", secret, "-A", keychain).status).toBe(0);
      const read = `/usr/bin/security find-generic-password -s toolroll-thread-probe -w ${q(keychain)} 2>&1; echo "exit:$?"`;
      expect(spawnSync("/bin/sh", ["-c", read], { encoding: "utf8" }).stdout).toContain(secret);
      const out = await inThread(id, `${read}; sh -c ${q(read.replace(/\$/g, "\\$"))}`);
      expect(out.stdout, out.stderr).not.toContain(secret);
      expect(out.stdout).not.toContain("exit:0");
      // The control inside the same sandbox: the thread's own terms with the keychain given back read it, so the keychain
      // denial is what holds it out.
      const fenced = flexibleThreadFence(world.store, { id, network: { proxyPort: 1, token: "run-token" }, storage: STORAGE });
      if (!fenced.ok) throw new Error(fenced.message);
      expect(underSandbox(read, fenced.launch.fence, { ...fenced.launch.fenceGrants, keychain: true }, { cwd: fenced.paths.repo }).stdout).toContain(secret);
    } finally { security("delete-keychain", keychain); }
  }, 60_000);

  test("native: no SSH agent socket, no local service and no direct connection: only the run's proxy answers", async ctx => {
    needs(ctx, osFence());
    const { id } = await thread();
    const agent = join(world.dir, "agent.sock");
    await listen(agent);
    const other = await listen(0);
    const proxy = await listen(0);
    const connect = (target: string) => `${q(process.execPath)} -e ${q(`const s = require("net").connect(${target}); s.on("data", () => { console.log("CONNECTED ${target.replace(/"/g, "")}"); process.exit(0); }); s.on("error", () => { console.log("refused"); process.exit(0); }); setTimeout(() => { console.log("no answer"); process.exit(0); }, 5000);`)}`;
    const control = await new Promise<string>(done => {
      const child = spawn("/bin/sh", ["-c", connect(JSON.stringify(agent))], { stdio: ["ignore", "pipe", "ignore"] });
      let stdout = "";
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.on("close", () => done(stdout));
    });
    expect(control).toContain("CONNECTED");
    const out = await inThread(id, [connect(JSON.stringify(agent)), connect(`${other.port}, "127.0.0.1"`), connect(`${proxy.port}, "127.0.0.1"`)].join("\n"), proxy.port);
    const lines = out.stdout.trim().split("\n");
    expect(lines.slice(0, 2), out.stderr).toEqual(["refused", "refused"]);
    // On a Mac the proxy is reached at its own port; on Linux the runtime bridges it into the launch's network at a port
    // of its own, so only the refusals are asserted there.
    if (process.platform === "darwin") expect(lines[2]).toContain(`CONNECTED ${proxy.port}`);
  }, 60_000);

  test("native: Toolroll's state and install, the person's launch configuration and the shared /tmp/claude are never written", async ctx => {
    needs(ctx, osFence());
    const { id } = await thread();
    const home = realpathSync(homedir());
    const secret = marker("state");
    write(join(world.state, "up-login.txt"), secret);
    write(join(home, ".toolroll", "tool-secrets", "t.json"), JSON.stringify({ token: secret }));
    // The sandbox runtime's shared write folder (sandbox-utils SANDBOX_OWN_WRITE_PATHS), made as the runtime makes it.
    const shared = process.platform === "darwin" ? "/private/tmp/claude" : "/tmp/claude";
    if (!existsSync(shared)) mkdirSync(shared, { mode: 0o700 });
    const runtime = dirname(dirname(createRequire(import.meta.url).resolve("@anthropic-ai/sandbox-runtime")));
    const planted = marker("tmp");
    const out = await inThread(id, [`cat ${q(join(world.state, "up-login.txt"))} ${q(join(home, ".toolroll", "tool-secrets", "t.json"))} ${q(world.databaseFile)} 2>/dev/null | head -c 100000`, attempts([
      ["write the state folder", `echo x > ${q(join(world.state, "planted"))}`],
      ["write the database", `echo x >> ${q(world.databaseFile)}`],
      ["write a launch agent", `mkdir -p ${q(join(home, "Library", "LaunchAgents"))} && echo x > ${q(join(home, "Library", "LaunchAgents", "evil.plist"))}`],
      ["write a shell profile", `echo x >> ${q(join(home, ".zshrc"))}`],
      ["write the git config", `echo x >> ${q(join(home, ".gitconfig"))}`],
      ["write a home file", `echo x > ${q(join(home, "planted.txt"))}`],
      ["write the sandbox runtime", `echo x > ${q(join(runtime, "planted.js"))}`],
      ["write the shared temp", `echo x > ${shared}/${planted}`],
    ])].join("\n"));
    expect(out.stdout).not.toContain(secret);
    expect(allowed(out), out.stderr).toEqual([]);
    expect(existsSync(join(shared, planted))).toBe(false);
  }, 60_000);

  test("native: a thread's folder is out of reach of every other launch, where the database is kept in a shared folder too", async ctx => {
    needs(ctx, osFence());
    world.store.close();
    rmSync(world.dir, { recursive: true, force: true });
    world = threadWorld({ stateName: "shared" });
    const { paths } = await thread();
    const secret = marker("thread-files");
    write(join(paths.repo, "secret.txt"), secret);
    // An ordinary build of the same project, as invoke.ts fences one.
    const pool = join(world.state, "worktrees");
    const worktree = join(pool, "shop", "task-1-0123abcd");
    mkdirSync(dirname(worktree), { recursive: true });
    tgit(world.project, "worktree", "add", "-q", "-b", "t1", worktree);
    const binding = trustedWorktreeBinding(world.project, worktree, [pool]);
    const build = fenceFor("build", { storage: STORAGE, databaseFile: world.databaseFile, worktree, home: homedir(), binding, runFolders: runFolders(null), poolRoots: [pool], policy: 2,
      boundary: taskBoundary({ worktree, provider: "claude", home: homedir(), binding, policy: 2, storage: STORAGE }) });
    const out = underSandbox([`cat ${q(join(paths.repo, "secret.txt"))} 2>/dev/null`, attempts([["write a thread's repository", `echo x > ${q(join(paths.repo, "planted.txt"))}`], ["write the threads folder", `echo x > ${q(join(paths.root, "planted"))}`]])].join("\n"),
      build.fence, build.fenceGrants, { cwd: worktree });
    expect(out.stdout, out.stderr).not.toContain(secret);
    expect(allowed(out)).toEqual([]);
  }, 60_000);

  test("native: protected names can't be made, replaced or removed, from the agent or a descendant, and still hold at the next launch", async ctx => {
    needs(ctx, osFence());
    const { id, paths } = await thread();
    const names = [".envrc", ".npmrc", ".yarnrc", ".yarnrc.yml", ".mcp.json", ".gitmodules", ".ripgreprc", ".claude/settings.json", ".claude/settings.local.json"];
    const before = Object.fromEntries(names.map(name => [name, readFileSync(join(paths.repo, name), "utf8")]));
    const rows: [string, string][] = names.flatMap(name => [
      [`write ${name}`, `echo planted >> ${q(name)}`],
      [`replace ${name}`, `echo planted > planted.tmp && mv -f planted.tmp ${q(name)}`],
      [`remove ${name}`, `rm -f ${q(name)} && ! test -e ${q(name)}`],
      [`link ${name}`, `ln -sfn /tmp ${q(name)}`],
    ]);
    const dirs = [".vscode", ".idea", ".claude/commands", ".claude/agents"].flatMap(dir => [[`fill ${dir}`, `echo x > ${q(`${dir}/planted`)}`], [`remove ${dir}`, `rm -rf ${q(dir)} && ! test -e ${q(dir)}`]] as [string, string][]);
    const moves: [string, string][] = [["move .claude aside", "mv .claude .claude-old && mkdir -p .claude && echo planted > .claude/settings.json"]];
    const descendant = `perl -MPOSIX -e 'exit if fork; POSIX::setsid(); exec "/bin/sh", "-c", shift' ${q(`(${attempts([[".envrc from a descendant", "echo planted >> .envrc"]])}; echo done) > "$TMPDIR/descendant.out" 2>&1`)}`;
    const out = await inThread(id, [attempts([...rows, ...dirs, ...moves]), descendant].join("\n"));
    expect(allowed(out), out.stderr).toEqual([]);
    await until(() => existsSync(join(paths.tmp, "descendant.out")) && readFileSync(join(paths.tmp, "descendant.out"), "utf8").includes("done"));
    expect(readFileSync(join(paths.tmp, "descendant.out"), "utf8")).not.toContain("ALLOWED");
    for (const name of names) expect(readFileSync(join(paths.repo, name), "utf8"), name).toBe(before[name]);
    // The next launch: the same names, the same contents, still read-only.
    const next = await inThread(id, [`cat .envrc .npmrc .yarnrc.yml; echo next-launch`, attempts([["write .envrc at the next launch", "echo planted >> .envrc"]])].join("\n"));
    expect(next.stdout.trim(), next.stderr).toBe("next-launch");
    expect(readFileSync(join(paths.repo, ".envrc"), "utf8")).toBe("");
  }, 60_000);

  test("native: a thread, and a file in Toolroll's state, made after a thread's launch started stay out of its reach", async ctx => {
    needs(ctx, osFence());
    const mine = await thread();
    const secret = marker("late");
    const go = join(mine.paths.tmp, "go");
    const running = await startInThread(mine.id, `while [ ! -f ${q(go)} ]; do sleep 0.1; done; cat "$(cat ${q(go)})"/repo/secret.txt ${q(join(world.state, "late-secret.txt"))} 2>/dev/null; ls "$(cat ${q(go)})" 2>/dev/null; echo checked`);
    // After the sandbox started: a new thread, and a new file beside the database.
    const late = await thread();
    write(join(late.paths.repo, "secret.txt"), secret);
    write(join(world.state, "late-secret.txt"), secret);
    writeFileSync(go, late.paths.folder);
    const out = await running.done;
    expect(out.stdout.trim(), out.stderr).toBe("checked");
  }, 60_000);

  test("native: a thread made after an ordinary build's launch started stays out of its reach (the database in a shared folder)", async ctx => {
    needs(ctx, osFence());
    world.store.close();
    rmSync(world.dir, { recursive: true, force: true });
    world = threadWorld({ stateName: "shared" });
    const pool = join(world.state, "worktrees");
    const worktree = join(pool, "shop", "task-1-0123abcd");
    mkdirSync(dirname(worktree), { recursive: true });
    tgit(world.project, "worktree", "add", "-q", "-b", "t1", worktree);
    const binding = trustedWorktreeBinding(world.project, worktree, [pool]);
    // The threads folder isn't there before this launch: the fence makes it, so a thread made later is inside a denied folder.
    rmSync(join(world.state, "threads"), { recursive: true, force: true });
    const build = fenceFor("build", { storage: STORAGE, databaseFile: world.databaseFile, worktree, home: homedir(), binding, runFolders: runFolders(null), poolRoots: [pool], policy: 2,
      boundary: taskBoundary({ worktree, provider: "claude", home: homedir(), binding, policy: 2, storage: STORAGE }) });
    const go = join(worktree, "go");
    const running = underSandboxAsync(`while [ ! -f ${q(go)} ]; do sleep 0.1; done; cat "$(cat ${q(go)})"/repo/secret.txt 2>/dev/null; echo checked`, build.fence, build.fenceGrants, { cwd: worktree });
    await new Promise(done => setTimeout(done, 300));
    const secret = marker("late-thread");
    const late = await thread();
    write(join(late.paths.repo, "secret.txt"), secret);
    writeFileSync(go, late.paths.folder);
    const out = await running;
    expect(out.stdout.trim(), out.stderr).toBe("checked");
  }, 60_000);

  test("native: no direct TCP or UDP connection leaves the thread, to an outside address or an IPv6 one", async ctx => {
    needs(ctx, osFence());
    const { id } = await thread();
    // A refused connect is the proof; nothing is sent when the fence holds.
    const probe = `${q(process.execPath)} -e ${q(`
      const net = require("net"), dgram = require("dgram");
      const tcp = (host, port) => new Promise(done => { const s = net.connect({ host, port }); s.on("connect", () => { s.destroy(); done("connected"); }); s.on("error", e => done(e.code || "error")); setTimeout(() => { s.destroy(); done("timeout"); }, 4000).unref(); });
      const udp = () => new Promise(done => { const s = dgram.createSocket("udp4"); s.on("error", e => { s.close(); done(e.code || "error"); }); s.send(Buffer.from([0]), 53, "8.8.8.8", e => { try { s.close(); } catch {} done(e ? (e.code || "error") : "sent"); }); });
      (async () => { console.log("tcp " + await tcp("1.1.1.1", 443)); console.log("tcp6 " + await tcp("2606:4700:4700::1111", 443)); console.log("udp " + await udp()); })();
    `.replace(/\s*\n\s*/g, " "))}`;
    const out = await inThread(id, probe);
    const results = Object.fromEntries(out.stdout.trim().split("\n").map(line => line.split(" ") as [string, string]));
    expect(Object.keys(results), out.stderr).toEqual(["tcp", "tcp6", "udp"]);
    for (const [kind, result] of Object.entries(results)) {
      expect(["connected", "sent", "timeout"], `${kind}: ${result}`).not.toContain(result);
      // Seatbelt refuses the socket operation itself.
      if (process.platform === "darwin") expect(result, kind).toBe("EPERM");
    }
  }, 60_000);

  test("native: a removal waits for a launch under way and then refuses while its agent runs; a launch after a removal never starts", async ctx => {
    needs(ctx, osFence());
    const { id, paths } = await thread();
    // The launch takes the thread's lock as it is called (before its probe), so the removal called right after waits.
    const launching = startInThread(id, "sleep 30");
    const removing = removeFlexibleThread(world.store, { id, by: "alex", now: NOW });
    const { pid, done } = await launching;
    expect(await removing).toMatchObject({ ok: false, reason: "thread-running" });
    expect(flexibleThread(world.store, id)).toMatchObject({ state: "ready", livePid: pid });
    expect(existsSync(paths.repo)).toBe(true);
    process.kill(-pid, "SIGKILL");
    // Ended and reaped (a leader not yet reaped still answers as a process).
    await done;
    // Called first, the removal holds the lock: the launch after it finds the thread gone and starts nothing.
    const removed = removeFlexibleThread(world.store, { id, by: "alex", now: NOW });
    let started = false;
    const late = flexibleThreadSpawn(world.store, { id, network: { proxyPort: 1, token: "run-token" }, storage: STORAGE, proxyEnv: {} }, "/bin/sh", ["-c", "echo ran"], () => { started = true; return 1; });
    expect(await removed).toEqual({ ok: true, keepRef: "removed" });
    expect(await late).toMatchObject({ ok: false, reason: "thread-not-ready" });
    expect(started).toBe(false);
    expect(existsSync(paths.folder)).toBe(false);
  }, 60_000);
});
