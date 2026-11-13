/**
 * `toolroll up` — one command to a working cockpit, proven over the
 * real machinery: real git, a real bind, real watch loops bounded by --for.
 * The ordering guarantees (nothing mints before the port), the credential
 * file's discipline, and the runner lifecycle are each their own proof.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, existsSync, statSync, readFileSync, writeFileSync, realpathSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "node:net";
import { execFileSync } from "node:child_process";
import { consoleSignInLink, runOperate, parseOperateArgs, upLinkRequest, upNarrowDeferred } from "./operate.js";
import { run as execRun } from "./exec.js";
import { type Runner as CommandRunner } from "./builder.js";
import { sweepServiceRunning } from "./storage-sweep-schedule.js";
import { enrollOwnerPassword, laptopPortOf, openStore } from "./store.js";
import { backgroundShow } from "./laptop-background.js";
import { register } from "./runner.js";
import { addApprover, authenticateApprover, hashPassword } from "./scope.js";
import { addRepos, loadProjectRegistry, registryRemovals, updateRepos } from "./repos.js";
import { instanceRunDir, proveLiveConsole, readInstance } from "./console-instance.js";
import { packageVersion } from "./monitoring.js";
import { underAgent } from "./prompt.js";
import { shortTempDir } from "../test/short-temp.js";
import { SOCKETS_TOO_DEEP } from "../test/inside-fence.js";

const PORT = 41000 + (process.pid % 2000);

let base: string;
let repo: string;
let db: string;
let lines: string[];

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (args: string[], cwd: string) =>
  execFileSync("git", args, { cwd, env: { ...gitEnv, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "so-up-"));
  repo = join(base, "project");
  db = join(base, "orders.db");
  execFileSync("mkdir", ["-p", repo]);
  git(["init", "-q"], repo);
  writeFileSync(join(repo, "README.md"), "hello\n");
  git(["add", "."], repo);
  git(["commit", "-qm", "first"], repo);
  lines = [];
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const up = (extra: string[] = [], port = PORT, onOutput?: (line: string) => void) =>
  runOperate("up", ["--repo", repo, "--port", String(port), "--for", "1200", "--json", ...extra], line => { lines.push(line); onOutput?.(line); }, {
    databaseFile: db,
  });

const envelope = (): Record<string, unknown> => JSON.parse(lines.join("\n")) as Record<string, unknown>;

describe("toolroll up", () => {
  test("cold start: mints the login durably, registers a worker, watches, retires cleanly", async () => {
    // While `up` runs, the database is looked at every 20 ms: some moment must show a live watch lease, and no moment
    // may show a sweep service. Checking only when the envelope line came out raced the worker's own --for 1200: on a
    // loaded runner the envelope can reach this process after the bounded watch has already given its lease back.
    // (runOperate opens and migrates the database before its first await, so the poller never sees a half-made one.)
    const running = up();
    const watcher = openStore(db);
    const leases: { owner: string; runner: string; repo: string }[] = [];
    const sweeps: string[] = [];
    const look = (): void => {
      const now = new Date();
      leases.push(...watcher.handle.prepare("SELECT owner, runner, repo FROM watch_lease WHERE expires_at > ?").all(now.toISOString()) as { owner: string; runner: string; repo: string }[]);
      if (sweepServiceRunning(watcher, now)) sweeps.push(now.toISOString());
    };
    const poller = setInterval(look, 20);
    let code: number;
    try { code = await running; } finally { clearInterval(poller); watcher.close(); }
    expect(code).toBe(0);
    expect(sweeps).toEqual([]);
    const answer = envelope();
    // The lease seen live was this start's own worker watching this project, as a bounded watch (never a service's).
    expect(leases.length).toBeGreaterThan(0);
    expect(leases[0]).toMatchObject({ runner: String(answer["runner"]), repo: (answer["repos"] as string[])[0] });
    expect(leases[0]!.owner.startsWith("toolroll-service:")).toBe(false);
    // And the watch gave it back on the way out: no lease is live once `up` has returned.
    const after = openStore(db);
    try { expect(after.handle.prepare("SELECT 1 FROM watch_lease WHERE expires_at > ?").get(new Date().toISOString())).toBeUndefined(); } finally { after.close(); }
    expect(answer).toMatchObject({ ok: true, command: "up" });
    expect(String(answer["url"])).toContain(`:${PORT}`);
    expect((answer["repos"] as string[])[0]).toBeTruthy();

    // The login: minted, durable, 0600, and it authenticates.
    const loginFile = String(answer["passwordFile"]);
    expect(loginFile.endsWith("up-login.txt")).toBe(true);
    expect(statSync(loginFile).mode & 0o777).toBe(0o600);
    const [name = "", password = ""] = readFileSync(loginFile, "utf8").trim().split(" ");
    expect(answer["approver"]).toBe(name);
    const store = openStore(db);
    try {
      expect(authenticateApprover(store, name, password).ok).toBe(true);
      // The worker retired on the way out — the next `up` reuses the name.
      const runner = store.getRunner(String(answer["runner"]));
      expect(runner?.runner.retiredAt).not.toBeNull();
    } finally {
      store.close();
    }
  });

  // Inside an older plane's macOS check fence every folder a check may write was too deep for this test's unix socket path (about 104 bytes); CI (Linux, and the tag's macOS jobs) runs it unfenced.
  test.skipIf(SOCKETS_TOO_DEEP)("a running up proves itself live to this installation's CLI (cockpit B1); stopping forgets the record and the socket", async () => {
    // A short state folder: a Unix socket path has to fit the platform's limit (~104 bytes on macOS).
    const short = shortTempDir("so-ui-");
    db = join(short, "orders.db");
    try {
    let proof: Promise<unknown> | null = null;
    const code = await up([], PORT + 21, () => {
      const store = openStore(db);
      proof = proveLiveConsole(db, store, packageVersion()).finally(() => store.close());
    });
    expect(code).toBe(0);
    // The console is its own process (isolated-checks.md, stage 1): the record names it, not the `up` that started it.
    expect(await proof).toEqual({ ok: true, url: `http://127.0.0.1:${PORT + 21}`, port: PORT + 21, pid: expect.any(Number), build: packageVersion() });
    expect((await proof as { pid: number }).pid).not.toBe(process.pid);
    const store = openStore(db);
    try { expect(readInstance(store)).toBeNull(); } finally { store.close(); }
    // Its own socket went with it.
    expect(readdirSync(instanceRunDir(db))).toEqual([]);
    } finally { rmSync(short, { recursive: true, force: true }); }
  });

  test("second start: adopts the existing login and reuses the retired worker name", async () => {
    await up();
    const firstRunner = String(envelope()["runner"]);
    lines = [];
    const code = await up();
    expect(code).toBe(0);
    const again = envelope();
    expect(again).toMatchObject({ ok: true, approverVerified: true });
    expect(again["runner"]).toBe(firstRunner);
    expect(String(again["passwordFile"]).endsWith("up-login.txt")).toBe(true);
  });

  test("an older install's login beside the database moves into the reserved folder on the next start", async () => {
    await up();
    const moved = join(base, ".toolroll-secrets", "up-login.txt");
    const legacy = join(base, "up-login.txt");
    // As an older version left it: the login beside the database, nothing in the reserved folder.
    const saved = readFileSync(moved, "utf8");
    rmSync(join(base, ".toolroll-secrets"), { recursive: true });
    writeFileSync(legacy, saved, { mode: 0o600 });
    lines = [];
    expect(await up()).toBe(0);
    expect(envelope()).toMatchObject({ ok: true, approverVerified: true, passwordFile: moved });
    expect(existsSync(legacy)).toBe(false);
    expect(readFileSync(moved, "utf8")).toBe(saved);
    expect(statSync(moved).mode & 0o777).toBe(0o600);
    expect(statSync(join(base, ".toolroll-secrets")).mode & 0o777).toBe(0o700);
  });

  test.each([0, 3])("--capacity is recorded and a built-in worker restart keeps saved capacity %s", async savedCapacity => {
    expect(await up(["--capacity", "3"], PORT + 11, line => {
      if (savedCapacity !== 0) return;
      // Drain while the worker is alive; shutdown retires it before up() returns.
      const started = JSON.parse(line);
      const store = openStore(db);
      try {
        expect(store.setRunnerCapacity(String(started.runner), 0, String(started.approver), new Date())).toMatchObject({ ok: true, before: 3, after: 0 });
      } finally { store.close(); }
    })).toBe(0);
    const answer = envelope();
    const runner = String(answer["runner"]);
    let store = openStore(db);
    try {
      expect(store.getRunner(runner)?.runner.capacity).toBe(savedCapacity);
      const entry = store.handle.prepare("SELECT actor, action, detail FROM action_ledger WHERE action = ?").get(`worker capacity: ${runner}`);
      expect(entry).toMatchObject({ actor: String(answer["approver"]), detail: "1 → 3" });
    } finally {
      store.close();
    }
    lines = [];
    expect(await up([], PORT + 12)).toBe(0);
    store = openStore(db);
    try {
      expect(store.getRunner(runner)?.runner.capacity).toBe(savedCapacity);
    } finally {
      store.close();
    }
  });

  test("--capacity must be a whole number from 1 to 64, refused before anything starts", async () => {
    for (const bad of ["0", "65", "1.5", "two"]) {
      lines = [];
      expect(await up(["--capacity", bad], PORT + 13)).toBe(2);
      expect(envelope()).toMatchObject({ ok: false, reason: "usage" });
    }
    expect(existsSync(join(base, ".toolroll-secrets", "up-login.txt"))).toBe(false);
  });

  test("the saved projects folder reconnects projects when started outside a repository", async () => {
    expect(await up(["--project-root", base], PORT + 7)).toBe(0);
    lines = [];
    const previous = process.cwd();
    let code: number;
    try {
      process.chdir(base);
      code = await runOperate(
        "up",
        ["--port", String(PORT + 8), "--for", "900", "--json"],
        line => lines.push(line),
        { databaseFile: db },
      );
    } finally {
      process.chdir(previous);
    }

    expect(code!).toBe(0);
    expect(envelope()).toMatchObject({ ok: true, repos: [realpathSync(repo)] });
    expect(await loadProjectRegistry(join(base, "repos.json"))).toMatchObject({ roots: [realpathSync(base)] });
  });

  test("a busy port refuses BEFORE anything mints — the world stays untouched", async () => {
    const squatter = createServer();
    await new Promise<void>(ready => squatter.listen(PORT + 1, "127.0.0.1", ready));
    try {
      const code = await up([], PORT + 1);
      expect(code).toBe(3);
      expect(envelope()).toMatchObject({ ok: false, reason: "port-busy" });
      const store = openStore(db);
      try {
        expect(store.listApprovers()).toEqual([]);
        expect(store.listRunners()).toEqual([]);
      } finally {
        store.close();
      }
      expect(existsSync(join(base, ".toolroll-secrets", "up-login.txt"))).toBe(false);
    } finally {
      await new Promise<void>(done => squatter.close(() => done()));
    }
  });

  test("a directory outside git refuses with both roads", async () => {
    const code = await runOperate("up", ["--repo", base, "--port", String(PORT + 2), "--json"], line => lines.push(line), {
      databaseFile: db,
    });
    expect(code).toBe(3);
    const answer = envelope();
    expect(answer).toMatchObject({ ok: false, reason: "not-a-repository" });
    expect(String(answer["message"])).toContain("demo");
  });

  test("an explicitly named live worker refuses instead of taking its work", async () => {
    const store = openStore(db);
    try {
      register(store, { name: "busy-worker", host: "elsewhere", now: new Date() });
    } finally {
      store.close();
    }
    const code = await up(["--runner", "busy-worker"], PORT + 3);
    expect(code).toBe(3);
    expect(envelope()).toMatchObject({ ok: false, reason: "runner-alive" });
  });

  test("without a terminal it prints the handoff, points at onboard, and opens no browser", async () => {
    const opened: string[] = [];
    const code = await runOperate("up", ["--repo", repo, "--port", String(PORT + 14), "--for", "1200"], line => lines.push(line), {
      databaseFile: db,
      upSeams: { terminal: false, openBrowser: url => opened.push(url) },
    });
    expect(code).toBe(0);
    const text = lines.join("\n");
    const [, password = ""] = readFileSync(join(base, ".toolroll-secrets", "up-login.txt"), "utf8").trim().split(" ");
    expect(text).not.toContain(password);
    expect(opened).toEqual([]);
    // A log (no terminal) keeps the exact containment status.
    expect(text).toContain("watch: containment: ");

    lines = [];
    expect(await runOperate("up", ["--repo", repo, "--port", String(PORT + 15), "--for", "1200"], line => lines.push(line), {
      databaseFile: db,
      upSeams: { terminal: true, env: {}, openBrowser: url => opened.push(url) },
    })).toBe(0);
    // Three lines (onboarding): where it is, that it opens signed in, and what to do if it doesn't. The browser gets a
    // one-time sign-in link that is never printed; neither is the password.
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${PORT + 15}/login/once/[A-Za-z0-9_-]{43}$`));
    const greeting = lines.join("\n");
    const [, secret = ""] = readFileSync(join(base, ".toolroll-secrets", "up-login.txt"), "utf8").trim().split(" ");
    expect(greeting).not.toContain(secret);
    expect(greeting).not.toContain("/login/once/");
    // Every start says where the password is saved and the exact command that shows it, whether or not the browser
    // opened, and never the password itself.
    const showsPassword = (said: string, file = join(base, ".toolroll-secrets", "up-login.txt")): void => {
      expect(said).toContain(`Your password: run \`cat -- '${file}'\``);
    };
    showsPassword(greeting);
    // A person at a terminal reads at most one plain sentence about containment; --verbose adds the exact status.
    expect(lines.join("\n")).not.toContain("watch: containment: ");
    expect(lines.filter(line => line.startsWith("Agents run without Linux process containment")).length).toBeLessThanOrEqual(1);
    // onboard names the console where up last served it.
    expect(JSON.parse(readFileSync(join(base, "up-console.json"), "utf8"))).toMatchObject({ url: `http://127.0.0.1:${PORT + 15}/` });
    lines = [];
    expect(await runOperate("up", ["--repo", repo, "--port", String(PORT + 18), "--for", "1200", "--no-open"], line => lines.push(line), {
      databaseFile: db,
      upSeams: { terminal: true, env: {}, openBrowser: url => opened.push(url) },
    })).toBe(0);
    expect(opened).toHaveLength(1);
    showsPassword(lines.join("\n"));
    expect(lines.join("\n")).not.toContain(secret);
    // A relative --db that starts with a dash or a tilde still prints one absolute, quoted path, never an option or
    // another user's home.
    const cwd = process.cwd();
    try {
      process.chdir(base);
      for (const [index, relative] of (["-state/orders.db", "~root/state/orders.db"] as const).entries()) {
        mkdirSync(join(base, dirname(relative)), { recursive: true });
        lines = [];
        expect(await runOperate("up", [`--db=${relative}`, "--repo", repo, "--port", String(PORT + 19 + index), "--for", "1200", "--no-open"], line => lines.push(line), {
          upSeams: { terminal: true, env: {} },
        })).toBe(0);
        const file = join(realpathSync(base), dirname(relative), ".toolroll-secrets", "up-login.txt");
        const [, own = ""] = readFileSync(file, "utf8").trim().split(" ");
        showsPassword(lines.join("\n"), file);
        expect(own).not.toBe("");
        expect(lines.join("\n")).not.toContain(own);
      }
    } finally { process.chdir(cwd); }
    lines = [];
    expect(await runOperate("up", ["--repo", repo, "--port", String(PORT + 17), "--for", "1200", "--verbose"], line => lines.push(line), {
      databaseFile: db,
      upSeams: { terminal: true, env: {}, openBrowser: () => undefined },
    })).toBe(0);
    expect(lines.join("\n")).toContain("watch: containment: ");
  });

  test("a coding agent is known by its variables; a person's own CODEX_HOME is not one", () => {
    for (const env of [{ CLAUDECODE: "1" }, { CLAUDE_CODE_ENTRYPOINT: "cli" }, { CODEX_SANDBOX: "seatbelt" }, { CODEX_THREAD_ID: "t-1" }]) expect(underAgent(env)).toBe(true);
    for (const env of [{}, { CODEX_HOME: "/Users/alex/.codex" }, { CODEX_API_KEY: "sk-x" }, { CODEX_PROFILE: "work" }, { CODEX_MODEL: "gpt-5" }, { CLAUDECODE: "" }]) expect(underAgent(env)).toBe(false);
  });

  test("an agent that sets no variable is known by the program running the command", () => {
    for (const programs of [["zsh", "aider"], ["bash", "node", "copilot"], ["zsh", "node", "amp"], ["bash", "goose"], ["zsh", "codex"], ["sh", "python3.12", "aider"]]) {
      expect(underAgent({}, () => programs)).toBe(true);
    }
    for (const programs of [[], ["zsh", "login", "Terminal"], ["bash", "tmux"], ["zsh", "node", "vite"]]) expect(underAgent({}, () => programs)).toBe(false);
    // A person's own CODEX_ setting in a plain terminal leaves the prompts on.
    expect(underAgent({ CODEX_PROFILE: "work" }, () => ["zsh", "login"])).toBe(false);
  });

  test("under a coding agent, even at a terminal, it prints the handoff and never the password", async () => {
    for (const env of [{ CLAUDECODE: "1" }, { CODEX_SANDBOX: "seatbelt" }]) {
      rmSync(join(base, ".toolroll-secrets", "up-login.txt"), { force: true });
      for (const file of [db, `${db}-wal`, `${db}-shm`]) rmSync(file, { force: true });
      lines = [];
      const opened: string[] = [];
      expect(await runOperate("up", ["--repo", repo, "--port", String(PORT + 16), "--for", "1200"], line => lines.push(line), {
        databaseFile: db,
        upSeams: { terminal: true, env, openBrowser: url => opened.push(url) },
      })).toBe(0);
      const text = lines.join("\n");
      const [account = "", password = ""] = readFileSync(join(base, ".toolroll-secrets", "up-login.txt"), "utf8").trim().split(" ");
      expect(text).toContain(`  login     ${account} — the password is in ${join(base, ".toolroll-secrets", "up-login.txt")}`);
      expect(text).not.toContain(password);
      expect(text).not.toContain("Ctrl-C stops Toolroll");
      expect(opened).toEqual([]);
    }
  });



  test("a project added while up is running connects without a restart", async ({ onTestFinished }) => {
    const secondPath = join(base, "second-project");
    execFileSync("mkdir", ["-p", secondPath]);
    const second = realpathSync(secondPath);
    git(["init", "-q"], second);
    writeFileSync(join(second, "README.md"), "second\n");
    git(["add", "."], second);
    git(["commit", "-qm", "first"], second);

    let ready: () => void = () => {};
    let connected: () => void = () => {};
    const startup = new Promise<void>(resolve => { ready = resolve; });
    const connection = new Promise<void>(resolve => { connected = resolve; });
    let finished = false;
    const running = runOperate(
      "up",
      ["--repo", repo, "--project-root", base, "--port", String(PORT + 6), "--json"],
      line => { lines.push(line); ready(); },
      {
        databaseFile: db,
        openDatabase: file => {
          const store = openStore(file);
          const startEpisode = store.startWatchEpisode.bind(store);
          store.startWatchEpisode = (episode, now) => {
            const result = startEpisode(episode, now);
            // Observe the real durable connection; retain every production write.
            if (episode.repo === second) connected();
            return result;
          };
          return store;
        },
      },
    ).finally(() => { finished = true; });
    // This journey owns shutdown. A short --for trial could expire before
    // the async registry write/refresh under parallel load, testing shutdown
    // timing instead of hot project enrollment. The suite deadline is unchanged.
    onTestFinished(async () => {
      if (!finished) process.emit("SIGINT");
      await running;
    });
    try {
      const stoppedEarly = running.then(code => { throw new Error(`up stopped before the connection was observed (exit ${code})`); });
      await Promise.race([startup, stoppedEarly]);
      expect(envelope()).toMatchObject({ ok: true, repos: [realpathSync(repo)] });
      const runnerName = String(envelope()["runner"]);

      const registry = join(base, "repos.json");
      const added = await updateRepos(registry, current => addRepos(current, [second]));
      expect(added).toMatchObject({ ok: true });
      await Promise.race([connection, stoppedEarly]);

      const store = openStore(db);
      try {
        expect(finished).toBe(false);
        expect(store.getRunner(runnerName)?.runner).toMatchObject({ repos: expect.arrayContaining([second]), retiredAt: null });
        expect(store.latestWatchEpisode(second)).toMatchObject({ repo: second, runner: runnerName });
      } finally {
        store.close();
      }
      expect(await loadProjectRegistry(registry)).toMatchObject({ roots: [realpathSync(base)], repos: expect.arrayContaining([realpathSync(repo), second]) });
    } finally {
      if (!finished) process.emit("SIGINT");
      await running;
    }
    expect(await running).toBe(0);
  });

  // A saved project away at start (a drive not connected, an iCloud folder macOS is holding), saved before this start,
  // outside every projects folder and with no recorded admission: only the start's own saved-list authority can
  // connect it, as a restart would — and only as the very folder that was saved, and only while it is still saved.
  describe("saved projects away at start", () => {
    let elsewhere: string;
    let later: string;
    const registry = () => join(base, "repos.json");
    beforeEach(async () => {
      elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "so-up-later-")));
      later = join(elsewhere, "later-project");
      expect(await updateRepos(registry(), current => addRepos(current, [later]))).toMatchObject({ ok: true });
    });
    afterEach(() => rmSync(elsewhere, { recursive: true, force: true }));
    const makeRepo = (path: string) => {
      execFileSync("mkdir", ["-p", path]);
      git(["init", "-q"], path);
      writeFileSync(join(path, "README.md"), "later\n");
      git(["add", "."], path);
      git(["commit", "-qm", "first"], path);
    };
    /** `up` with only saved projects (no --repo, nothing inferred from where it runs), its lines and episodes watched. */
    const startUp = (port: number, seams: { gitRunner?: CommandRunner } = {}) => {
      const episodes: string[] = [];
      const heard: string[] = [];
      const waiters: { match: (line: string) => boolean; done: () => void }[] = [];
      const said = (match: (line: string) => boolean) => new Promise<void>(done => {
        if (heard.some(match)) done(); else waiters.push({ match, done });
      });
      const hear = (line: string) => { heard.push(line); for (const one of [...waiters]) if (one.match(line)) { waiters.splice(waiters.indexOf(one), 1); one.done(); } };
      const onLine = (line: string) => { lines.push(line); hear(line); };
      const stderr = process.stderr.write.bind(process.stderr);
      // --json sends progress lines to stderr: read them there too.
      process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => { for (const line of String(chunk).split("\n")) if (line !== "") hear(line); return (stderr as (...args: unknown[]) => boolean)(chunk, ...rest); }) as typeof process.stderr.write;
      let finished = false;
      const running = runOperate("up", ["--port", String(port), "--json"], onLine, {
        databaseFile: db,
        inferProjectFromCwd: false,
        ...seams,
        openDatabase: file => {
          const store = openStore(file);
          const startEpisode = store.startWatchEpisode.bind(store);
          store.startWatchEpisode = (episode, now) => { episodes.push(episode.repo); return startEpisode(episode, now); };
          return store;
        },
      }).finally(() => { finished = true; process.stderr.write = stderr; });
      const stop = async () => { if (!finished) process.emit("SIGINT"); return running; };
      return { running, episodes, said, stop };
    };
    const runnerRepos = (name: string) => { const store = openStore(db); try { return store.getRunner(name)?.runner.repos ?? []; } finally { store.close(); } };

    test("with nothing else to serve it still starts, then connects the project once it's back", async ({ onTestFinished }) => {
      const up = startUp(PORT + 9);
      onTestFinished(async () => { await up.stop(); });
      await up.said(line => line.startsWith("{"));
      expect(envelope()).toMatchObject({ ok: true, repos: [] });
      makeRepo(later);
      await up.said(line => line.includes(`saved project is back — connecting ${later}`));
      await vi.waitFor(() => expect(up.episodes).toContain(later), { timeout: 10_000 });
      expect(runnerRepos(String(envelope()["runner"]))).toEqual([later]);
      expect(await up.stop()).toBe(0);
    });

    test("a saved folder that comes back inside another checkout never connects that checkout", async ({ onTestFinished }) => {
      // Saved: outer/inner. It comes back as a plain folder, so git finds the checkout around it.
      const outer = join(elsewhere, "outer"), inner = join(outer, "inner");
      expect(await updateRepos(registry(), current => addRepos(current, [inner]))).toMatchObject({ ok: true });
      const up = startUp(PORT + 10);
      onTestFinished(async () => { await up.stop(); });
      await up.said(line => line.startsWith("{"));
      makeRepo(outer);
      execFileSync("mkdir", ["-p", inner]);
      await up.said(line => line.includes(`saved project not connected — ${inner} came back as part of ${outer}`));
      expect(runnerRepos(String(envelope()["runner"]))).not.toContain(outer);
      expect(up.episodes).not.toContain(outer);
      expect(await up.stop()).toBe(0);
    });

    test("removed and saved again while its proof is under way, it never connects on the start's authority", async ({ onTestFinished }) => {
      let release: () => void = () => {};
      const held = new Promise<void>(done => { release = done; });
      let proving: () => void = () => {};
      const asked = new Promise<void>(done => { proving = done; });
      let armed = false;
      const gitRunner: CommandRunner = async (file, args, options) => {
        if (armed && options?.cwd === later) { proving(); await held; }
        return execRun(file, [...args], { ...(options?.cwd === undefined ? {} : { cwd: options.cwd }), timeoutMs: 10_000 });
      };
      const up = startUp(PORT + 11, { gitRunner });
      onTestFinished(async () => { release(); await up.stop(); });
      await up.said(line => line.startsWith("{"));
      makeRepo(later);
      armed = true;
      await asked;
      // While the proof waits, the person removes it and saves it again; then the proof answers.
      expect(await updateRepos(registry(), current => current.filter(one => one !== later))).toMatchObject({ ok: true });
      expect(await updateRepos(registry(), current => addRepos(current, [later]))).toMatchObject({ ok: true });
      release();
      await up.said(line => line.includes(`saved project not connected — ${later} was removed while it was away`));
      // Saved again, it is an ordinary addition: without an admission it isn't connected.
      await up.said(line => line.includes(`project not connected — ${later}`));
      expect(runnerRepos(String(envelope()["runner"]))).not.toContain(later);
      expect(up.episodes).not.toContain(later);
      expect(await up.stop()).toBe(0);
    });

    test("a saved folder that comes back leading somewhere else never connects where it leads", async ({ onTestFinished }) => {
      const other = join(elsewhere, "other");
      const up = startUp(PORT + 12);
      onTestFinished(async () => { await up.stop(); });
      await up.said(line => line.startsWith("{"));
      makeRepo(other);
      symlinkSync(other, later);
      await up.said(line => line.includes(`saved project not connected — ${later} now leads to ${other}`));
      expect(runnerRepos(String(envelope()["runner"]))).not.toContain(other);
      expect(up.episodes).not.toContain(other);
      expect(await up.stop()).toBe(0);
    });

    test("a removed project is let go while another saved project is away", async ({ onTestFinished }) => {
      const kept = join(elsewhere, "kept");
      makeRepo(kept);
      expect(await updateRepos(registry(), current => addRepos(current, [kept]))).toMatchObject({ ok: true });
      const up = startUp(PORT + 13);
      onTestFinished(async () => { await up.stop(); });
      await up.said(line => line.startsWith("{"));
      expect(envelope()).toMatchObject({ ok: true, repos: [kept] });
      // `later` is still away; removing `kept` lets it go regardless.
      expect(await updateRepos(registry(), current => current.filter(one => one !== kept))).toMatchObject({ ok: true });
      await up.said(line => line.includes("project removed — kept is no longer built here"));
      expect(runnerRepos(String(envelope()["runner"]))).not.toContain(kept);
      expect(await up.stop()).toBe(0);
    });

    test("every removal from the saved list is counted under its lock, before the list changes", async () => {
      expect(registryRemovals(registry())).toEqual({});
      await updateRepos(registry(), current => current.filter(one => one !== later));
      await updateRepos(registry(), current => addRepos(current, [later]));
      await updateRepos(registry(), current => current.filter(one => one !== later));
      expect(registryRemovals(registry())).toEqual({ [later]: 2 });
      writeFileSync(`${registry()}.removals.json`, "not json");
      expect(registryRemovals(registry())).toBeNull();
    });

    test("a worker's report only narrows what the next worker gets", () => {
      expect(upNarrowDeferred(["/a", "/b"], ["/b", "/c"])).toEqual(["/b"]);
      expect(upNarrowDeferred(["/a"], [])).toEqual([]);
    });
  });

  test("a project added from the command line or by the lead is in every console list at once, and removing it hides it", async ({ onTestFinished }) => {
    const made = (name: string): string => {
      const path = join(base, name);
      execFileSync("mkdir", ["-p", path]);
      git(["init", "-q"], path);
      return realpathSync(path);
    };
    // Taskless, outside the folders this `up` was started with.
    const market = made("vamarketplacenew"), leadAdded = made("lead-added"), plain = join(base, "plain-folder");
    execFileSync("mkdir", ["-p", plain]);

    let ready: () => void = () => {};
    const startup = new Promise<void>(resolve => { ready = resolve; });
    const adopted = new Map<string, () => void>(), released = new Map<string, () => void>();
    const when = (map: Map<string, () => void>, path: string) => new Promise<void>(resolve => map.set(path, resolve));
    const marketAdopted = when(adopted, market), leadAdopted = when(adopted, leadAdded), marketReleased = when(released, market);
    let finished = false;
    const running = runOperate("up", ["--repo", repo, "--port", String(PORT + 7), "--json"], line => { lines.push(line); ready(); }, {
      databaseFile: db,
      openDatabase: file => {
        const store = openStore(file);
        // The durable events themselves: a watch starting on the project, and its lease let go.
        const startEpisode = store.startWatchEpisode.bind(store), releaseLease = store.releaseWatchLease.bind(store);
        store.startWatchEpisode = (episode, now) => { const result = startEpisode(episode, now); adopted.get(episode.repo)?.(); return result; };
        store.releaseWatchLease = (...args: Parameters<typeof releaseLease>) => { const result = releaseLease(...args); released.get(args[1])?.(); return result; };
        return store;
      },
    }).finally(() => { finished = true; });
    onTestFinished(async () => { if (!finished) process.emit("SIGINT"); await running; });
    const { main } = await import("./cli.js");
    const saved = { db: process.env["TOOLROLL_DB"], lead: process.env["TOOLROLL_LEAD_TOKEN"] };
    process.env["TOOLROLL_DB"] = db;
    try {
      const stoppedEarly = running.then(code => { throw new Error(`up stopped early (exit ${code})`); });
      await Promise.race([startup, stoppedEarly]);
      const url = String(envelope()["url"]), runnerName = String(envelope()["runner"]);
      const [owner = "", password = ""] = readFileSync(String(envelope()["passwordFile"]), "utf8").trim().split(" ");
      const signIn = async (name: string, secret: string) =>
        ((await fetch(new URL("/login", url), { method: "POST", body: new URLSearchParams({ name, token: secret }), redirect: "manual" })).headers.get("set-cookie") ?? "").split(";")[0]!;
      const cookie = await signIn(owner, password);
      const read = async (path: string, who = cookie) => { const answer = await fetch(new URL(path, url), { headers: { cookie: who } }); return { status: answer.status, html: await answer.text() }; };
      // Before: the console refuses it, as on Oct 5.
      expect((await read(`/settings/tools?repo=${encodeURIComponent(market)}`)).status).toBe(403);

      // A plain folder is refused with words, and nothing is written.
      const said: string[] = [];
      expect(await main(["repos", "add", plain], line => said.push(line))).toBe(2);

      // The owner adds from the command line; the running console has it within the adoption.
      said.length = 0;
      expect(await main(["repos", "add", market], line => said.push(line))).toBe(0);
      await Promise.race([marketAdopted, stoppedEarly]);
      const tools = await read(`/settings/tools?repo=${encodeURIComponent(market)}`);
      expect(tools.status).toBe(200);
      expect(tools.html).toContain("vamarketplacenew");
      for (const page of ["/projects", "/settings/project", "/flows"]) expect((await read(page)).html, page).toContain("vamarketplacenew");
      expect((await read(`/settings/project?repo=${encodeURIComponent(market)}`)).status).toBe(200);

      // The lead adds with its token alone.
      const check = openStore(db);
      try {
        process.env["TOOLROLL_LEAD_TOKEN"] = check.mintLeadCredential(owner, owner, new Date()).token;
        // Accounts limited to listed projects keep their own list.
        const robin = addApprover(check, "robin", new Date(), { name: owner, token: password });
        if (!robin.ok) throw new Error(`robin: ${robin.reason}`);
        expect(check.setAccountProjects("robin", [realpathSync(repo)], owner, new Date())).toEqual({ ok: true });
        said.length = 0;
        expect(await main(["repos", "add", leadAdded], line => said.push(line))).toBe(0);
        delete process.env["TOOLROLL_LEAD_TOKEN"];
        await Promise.race([leadAdopted, stoppedEarly]);
        expect((await read(`/settings/tools?repo=${encodeURIComponent(leadAdded)}`)).status).toBe(200);
        expect(check.getRunner(runnerName)?.runner.repos).toEqual(expect.arrayContaining([market, leadAdded]));
        const added = check.actionLedger({ repos: null, instance: true }).filter(one => one.action === "project added");
        expect(added).toEqual(expect.arrayContaining([
          expect.objectContaining({ repo: market, actor: userInfo().username, detail: "from cli", source: "access" }),
          expect.objectContaining({ repo: leadAdded, actor: `lead for ${owner}`, detail: "from lead", source: "access" }),
        ]));
        const robinCookie = await signIn("robin", robin.token);
        expect((await read(`/settings/tools?repo=${encodeURIComponent(market)}`, robinCookie)).status).toBe(403);
        expect((await read("/projects", robinCookie)).html).not.toContain("vamarketplacenew");

        // Remove: gone from the lists and the builder, without a restart; its record stays in the ledger.
        said.length = 0;
        expect(await main(["repos", "remove", market], line => said.push(line))).toBe(0);
        await Promise.race([marketReleased, stoppedEarly]);
        expect((await read(`/settings/tools?repo=${encodeURIComponent(market)}`)).status).toBe(403);
        for (const page of ["/projects", "/settings/project", "/flows"]) expect((await read(page)).html, page).not.toContain("vamarketplacenew");
        expect(check.actionLedger({ repos: null, instance: true }).some(one => one.action === "project removed" && one.repo === market && one.detail === "from cli")).toBe(true);
      } finally {
        check.close();
      }
      expect(finished).toBe(false);
    } finally {
      process.env["TOOLROLL_DB"] = saved.db;
      if (saved.lead === undefined) delete process.env["TOOLROLL_LEAD_TOKEN"];
      else process.env["TOOLROLL_LEAD_TOKEN"] = saved.lead;
      if (!finished) process.emit("SIGINT");
      await running;
    }
    expect(await running).toBe(0);
  });

  test("the remembered login answers for every operator verb: after one up, register and approve ask for nothing", async () => {
    expect(await up()).toBe(0);
    const tokenFile = join(base, "w2-token");
    lines = [];
    const registered = await runOperate("runner", ["register", "w2", "--repo", repo, "--token-file", tokenFile, "--json"], line => lines.push(line), { databaseFile: db });
    expect(registered).toBe(0);
    expect(envelope()).toMatchObject({ ok: true, command: "runner register" });
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    // The scripted approval (--yes --digest) is answered by the file too.
    lines = [];
    expect(await runOperate("task", ["add", "remembered work", "--id", "t-remembered", "--repo", repo, "--json"], line => lines.push(line), { databaseFile: db }), lines.join("\n")).toBe(0);
    const configured = openStore(db);
    configured.setPhaseConfig("installation", "build", "claude", "sonnet", "test", new Date());
    configured.setPhaseConfig("installation", "plan", "claude", "sonnet", "test", new Date()); // v47: every phase names an exact model
    configured.setPhaseConfig("installation", "review", "claude", "sonnet", "test", new Date());
    configured.close();
    lines = [];
    expect(await runOperate("task", ["scope", "t-remembered", "--goal", "a goal", "--acceptance", "It is fixed and verified.|manual-review", "--json"], line => lines.push(line), { databaseFile: db }), lines.join("\n")).toBe(0);
    const digest = String((envelope()["scope"] as Record<string, unknown>)["digest"]);
    lines = [];
    expect(await runOperate("task", ["approve", "t-remembered", "--yes", "--digest", digest, "--json"], line => lines.push(line), { databaseFile: db }), lines.join("\n")).toBe(0);
    expect(envelope()).toMatchObject({ ok: true, command: "task approve" });
    // Under a signed hands-off mode, the remembered login is the mode's
    // signer for the CLI's scope filing too: the scope seals escalated
    // permissions and auto-approves, exactly as the console's form does.
    lines = [];
    expect(await runOperate("mode", ["set", "--repo", repo, "--name", "hands-off", "--days", "1", "--json"], line => lines.push(line), { databaseFile: db }), lines.join("\n")).toBe(0);
    lines = [];
    expect(await runOperate("task", ["add", "hands-off work", "--id", "t-hands-off", "--repo", repo, "--json"], line => lines.push(line), { databaseFile: db }), lines.join("\n")).toBe(0);
    lines = [];
    expect(await runOperate("task", ["scope", "t-hands-off", "--goal", "a goal", "--acceptance", "It is fixed and verified.|manual-review", "--json"], line => lines.push(line), { databaseFile: db }), lines.join("\n")).toBe(0);
    const sealed = envelope()["scope"] as Record<string, unknown>;
    expect((sealed["profile"] as Record<string, unknown>)["permissionArgv"]).toBe("bypassPermissions");
    expect(envelope()["approvedUnderMode"]).toBe(true);
    // A different --as than the remembered name is not answered by the file.
    lines = [];
    const other = await runOperate("runner", ["register", "w3", "--repo", repo, "--as", "somebody-else", "--json"], line => lines.push(line), { databaseFile: db });
    expect(other).not.toBe(0);
    expect(envelope()).toMatchObject({ ok: false });
  });
});

describe("parser compatibility (finding 22)", () => {
  test("minted tokens beginning with -- remain credentials without swallowing flags", () => {
    const token = "--" + "a".repeat(41);
    const parsed = parseOperateArgs(["--token", token, "--json"]);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.flags.get("token")).toBe(token);
    expect(parsed.flags.get("json")).toBe(true);
    expect(parseOperateArgs(["--token", "--json"])).toEqual({ error: "--token needs a value" });
  });

  test("explicit value syntax preserves literals, repeated repos and safe errors", () => {
    const parsed = parseOperateArgs(["--token=--literal=password", "--repo=/a", "--repo=/b,/c"]);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.flags.get("token")).toBe("--literal=password");
    expect(parsed.flags.get("repo")).toBe("/b,/c");
    expect(parsed.repoList).toEqual(["/a", "/b", "/c"]);
    expect(parseOperateArgs(["--json=secret"])).toEqual({ error: "--json does not take a value" });
    expect(parseOperateArgs(["--unknown=secret"])).toEqual({ error: "unknown option --unknown — add --help to any queue command for the whole surface" });
  });




});

describe("start authority (easy-start C4): a laptop start, local mode's link, and the full road unchanged", () => {
  /** One interactive `up`: the link it opens is spent at once (as the browser would), and the session it made is read. */
  async function interactive(extra: string[], port: number, seams: { home?: string } = {}): Promise<{ code: number; opened: string[]; sessions: { authority: string; localGeneration: number | null }[] }> {
    const opened: string[] = [];
    const spent: Promise<unknown>[] = [];
    lines = [];
    const code = await runOperate("up", ["--port", String(port), "--for", "3000", ...extra], line => lines.push(line), {
      databaseFile: db, inferProjectFromCwd: false,
      upSeams: { terminal: true, env: {}, home: seams.home ?? join(base, "home"), fenceAvailable: () => true, openBrowser: url => { opened.push(url); spent.push(fetch(url, { redirect: "manual" })); } },
    });
    const answers = await Promise.all(spent) as Response[];
    // Signed in either way: a redirect to Chat, or, on a protected loopback install (no tailnet names: CI), the
    // mutation key's one-time delivery page that moves on to Chat (easy-start C2). Both set the session cookie.
    for (const answer of answers) {
      expect(answer.headers.get("set-cookie") ?? "").toMatch(/HttpOnly/);
      if (answer.status === 303) expect(answer.headers.get("location")).toBe("/chat");
      else {
        expect(answer.status).toBe(200);
        expect(await answer.text()).toContain('"to":"/chat"');
      }
    }
    const store = openStore(db);
    try {
      return { code, opened, sessions: store.webSessions(null).map(one => ({ authority: one.authority, localGeneration: one.localGeneration })) };
    } finally { store.close(); }
  }
  const loginFile = () => join(base, ".toolroll-secrets", "up-login.txt");

  test("a new laptop install opens signed in as its owner with no password, before and after a password is set", async () => {
    const first = await interactive(["--laptop", "--repo", repo], PORT + 40);
    expect(first.code, lines.join("\n")).toBe(0);
    expect(first.opened).toHaveLength(1);
    expect(first.sessions).toEqual([{ authority: "local-owner", localGeneration: 1 }]);
    // No login is minted, saved or shown: there is no password.
    expect(existsSync(loginFile())).toBe(false);
    expect(lines.join("\n")).not.toContain("Your password");
    const store = openStore(db);
    try {
      expect(store.listApprovers().map(one => one.name)).toHaveLength(1);
      expect(store.accountOf(store.listApprovers()[0]!.name)?.passwordSet).toBe(false);
    } finally { store.close(); }

    // The next start: local again, nothing asked or written.
    const second = await interactive(["--laptop", "--repo", repo], PORT + 41);
    expect(second.code).toBe(0);
    expect(second.sessions.filter(one => one.authority === "local-owner")).toHaveLength(2);
    expect(existsSync(loginFile())).toBe(false);

    // After the owner sets a password, local mode stays on: `up` still asks nothing and opens a local link, never a
    // full one (a full session comes only from typing the password in the browser).
    const enrolled = openStore(db);
    try {
      const owner = enrolled.listApprovers()[0]!.name;
      expect(enrollOwnerPassword(enrolled, owner, hashPassword("set-later"), 1, new Date()).ok).toBe(true);
    } finally { enrolled.close(); }
    const third = await interactive(["--repo", repo], PORT + 42);
    expect(third.code).toBe(0);
    expect(third.opened).toHaveLength(1);
    expect(third.sessions).toEqual([{ authority: "local-owner", localGeneration: 1 }]);
    expect(existsSync(loginFile())).toBe(false);

    // --no-open: no link at all.
    const quiet = await interactive(["--laptop", "--repo", repo, "--no-open"], PORT + 43);
    expect(quiet.code).toBe(0);
    expect(quiet.opened).toEqual([]);
  });

  test("an existing install with a saved login keeps the full link; --laptop changes nothing there", async () => {
    expect(await up([], PORT + 44)).toBe(0);
    expect(existsSync(loginFile())).toBe(true);
    const again = await interactive(["--laptop", "--repo", repo], PORT + 45);
    expect(again.code).toBe(0);
    expect(again.opened).toHaveLength(1);
    expect(again.sessions).toEqual([{ authority: "full", localGeneration: null }]);
    const store = openStore(db);
    try { expect(store.handle.prepare("SELECT count(*) AS n FROM local_mode").get()!["n"]).toBe(0); } finally { store.close(); }
  });

  test("a laptop start with no projects folder uses ~/Projects; it serves this computer only", async () => {
    const home = join(base, "home");
    mkdirSync(home);
    const started = await interactive(["--laptop", "--no-open"], PORT + 46, { home });
    expect(started.code, lines.join("\n")).toBe(0);
    expect(statSync(join(home, "Projects")).isDirectory()).toBe(true);
    expect((await loadProjectRegistry(join(base, "repos.json")) as { roots: string[] }).roots).toEqual([realpathSync(join(home, "Projects"))]);
    lines = [];
    expect(await runOperate("up", ["--laptop", "--host", "0.0.0.0", "--port", String(PORT + 47), "--json"], line => lines.push(line), { databaseFile: db })).not.toBe(0);
    expect(envelope()).toMatchObject({ ok: false, reason: "usage" });
  });

  test("a NEW laptop install steps past a port another program holds, saves it, and keeps it; other installs never move", async () => {
    // Something that isn't this database's console holds the first port (another Toolroll, the desktop app's).
    const foreign = createServer();
    await new Promise<void>(resolve => foreign.listen(PORT + 48, "127.0.0.1", () => resolve()));
    try {
      const ports = [PORT + 48, PORT + 49, PORT + 50];
      const start = async (extra: string[] = []): Promise<number> => {
        lines = [];
        return runOperate("up", ["--laptop", "--no-open", "--repo", repo, "--for", "1500", "--json", ...extra], line => lines.push(line), {
          databaseFile: db, inferProjectFromCwd: false,
          upSeams: { terminal: false, env: {}, home: join(base, "home"), fenceAvailable: () => true, laptopPorts: ports },
        });
      };
      expect(await start(), lines.join("\n")).toBe(0);
      expect(String(envelope()["url"])).toContain(`:${PORT + 49}`);
      const saved = openStore(db);
      try {
        expect(laptopPortOf(saved)).toBe(PORT + 49);
        // The background service's unit (and its show) name the saved port when nothing is running.
        const shown = await backgroundShow(saved, db, null, { platform: "linux", home: join(base, "home"), node: process.execPath, dist: base, proveConsole: async () => ({ ok: false, state: "none", message: "no console is running" }), supervisor: async () => ({ code: 1, stdout: "", stderr: "" }) as never });
        expect(shown.ok && shown.show.port).toBe(PORT + 49);
      } finally { saved.close(); }
      // The next start keeps the saved port, even with the first one free again.
      foreign.close();
      expect(await start(), lines.join("\n")).toBe(0);
      expect(String(envelope()["url"])).toContain(`:${PORT + 49}`);
      // --port still wins, and saves nothing new.
      expect(await start(["--port", String(PORT + 50)]), lines.join("\n")).toBe(0);
      expect(String(envelope()["url"])).toContain(`:${PORT + 50}`);
      const after = openStore(db);
      try { expect(laptopPortOf(after)).toBe(PORT + 49); } finally { after.close(); }
    } finally { foreign.close(); }
  });

  test("an install not made by `up --laptop` keeps up's default port: a held port refuses, as before", async () => {
    expect(await up([], PORT + 51)).toBe(0);
    const foreign = createServer();
    await new Promise<void>(resolve => foreign.listen(PORT + 52, "127.0.0.1", () => resolve()));
    try {
      lines = [];
      const code = await runOperate("up", ["--laptop", "--no-open", "--repo", repo, "--for", "1500", "--json"], line => lines.push(line), {
        databaseFile: db, inferProjectFromCwd: false,
        upSeams: { terminal: false, env: {}, home: join(base, "home"), fenceAvailable: () => true, laptopPorts: [PORT + 52, PORT + 53] },
      });
      expect(code).not.toBe(0);
      expect(envelope()).toMatchObject({ ok: false, reason: "port-busy" });
      const store = openStore(db);
      try { expect(laptopPortOf(store)).toBeNull(); } finally { store.close(); }
    } finally { foreign.close(); }
  });

  test("eight W2: a database made first by `status` becomes password-free under a direct `up --laptop` only for a person at its terminal", async () => {
    /** A fresh database as `status` makes it before any start: no creator fact, no account. */
    const madeByStatus = async (file: string): Promise<void> => {
      expect(await runOperate("status", ["--json"], () => {}, { databaseFile: file })).toBe(0);
      const made = openStore(file);
      try {
        expect(made.listApprovers()).toEqual([]);
        expect(made.handle.prepare("SELECT value FROM installation_fact WHERE key = 'created-by'").get()).toBeUndefined();
      } finally { made.close(); }
    };
    const laptopUp = async (file: string, port: number, seams: { terminal: boolean; env: Record<string, string>; json?: boolean }): Promise<number> => {
      lines = [];
      return runOperate("up", ["--laptop", "--no-open", "--repo", repo, "--port", String(port), "--for", "1200", ...(seams.json === true ? ["--json"] : [])], line => lines.push(line), {
        databaseFile: file, inferProjectFromCwd: false,
        upSeams: { terminal: seams.terminal, env: seams.env, home: join(base, "home"), fenceAvailable: () => true },
      });
    };
    const localRows = (file: string): number => { const store = openStore(file); try { return Number(store.handle.prepare("SELECT count(*) AS n FROM local_mode").get()!["n"]); } finally { store.close(); } };
    // Not a person: no terminal; a coding agent at a terminal; --json at a terminal. Each takes today's password road.
    const notPeople: { terminal: boolean; env: Record<string, string>; json?: boolean }[] = [
      { terminal: false, env: {} }, { terminal: true, env: { CLAUDECODE: "1" } }, { terminal: true, env: {}, json: true },
    ];
    // And a brand-new database `up --laptop` makes itself, started with no terminal: never password-free either.
    lines = [];
    const fresh = join(base, "fresh-not-person.db");
    expect(await laptopUp(fresh, PORT + 64, { terminal: false, env: {}, json: true }), lines.join("\n")).toBe(0);
    expect(localRows(fresh)).toBe(0);
    for (const [index, seams] of notPeople.entries()) {
      const file = join(base, `not-person-${index}.db`);
      await madeByStatus(file);
      expect(await laptopUp(file, PORT + 60 + index, seams), lines.join("\n")).toBe(0);
      expect(localRows(file), JSON.stringify(seams)).toBe(0);
    }
    // A person at its terminal: password-free, provenance untouched, no login minted.
    const file = join(base, "person.db");
    await madeByStatus(file);
    expect(await laptopUp(file, PORT + 63, { terminal: true, env: {} }), lines.join("\n")).toBe(0);
    expect(lines.join("\n")).toContain("local mode is on");
    const store = openStore(file);
    try {
      expect(store.handle.prepare("SELECT owner, enabled FROM local_mode").all().map(row => ({ ...row }))).toEqual([{ owner: expect.any(String), enabled: 1 }]);
      expect(store.listApprovers()).toHaveLength(1);
      expect(store.accountOf(store.listApprovers()[0]!.name)?.passwordSet).toBe(false);
      expect(store.handle.prepare("SELECT value FROM installation_fact WHERE key = 'created-by'").get()).toBeUndefined();
    } finally { store.close(); }
  });

  test("eight W2: a password-free install not made by `up --laptop` steps past a port another program holds, never past its own running console", async () => {
    const foreign = createServer();
    await new Promise<void>(resolve => foreign.listen(PORT + 70, "127.0.0.1", () => resolve()));
    const person = { terminal: true, env: {}, home: join(base, "home"), fenceAvailable: () => true };
    try {
      // A database `status` made first, started by a person at its terminal with no --port: the next free port.
      const first = join(base, "first.db");
      expect(await runOperate("status", ["--json"], () => {}, { databaseFile: first })).toBe(0);
      lines = [];
      const code = await runOperate("up", ["--laptop", "--no-open", "--repo", repo, "--for", "1200"], line => lines.push(line), {
        databaseFile: first, inferProjectFromCwd: false, upSeams: { ...person, laptopPorts: [PORT + 70, PORT + 71] },
      });
      expect(code, lines.join("\n")).toBe(0);
      expect(lines.join("\n")).toContain(`port ${PORT + 70} is in use by another program, so Toolroll uses ${PORT + 71}`);
      const saved = openStore(first);
      try { expect(laptopPortOf(saved)).toBe(PORT + 71); } finally { saved.close(); }
    } finally { foreign.close(); }
  });

  test.skipIf(SOCKETS_TOO_DEEP)("eight W2: a laptop start never steps past a busy port while this database's own console runs", async () => {
    const foreign = createServer();
    await new Promise<void>(resolve => foreign.listen(PORT + 70, "127.0.0.1", () => resolve()));
    const person = { terminal: true, env: {}, home: join(base, "home"), fenceAvailable: () => true };
    // The console's socket sits beside its database: a short folder keeps it within the OS limit.
    const short = shortTempDir("so-w2-");
    try {
      // This database's own console running (on a port it was given): a second start never steps past the busy first
      // port to start another console beside it. It says where Toolroll runs, and nothing else is bound or written.
      const second = join(short, "second.db");
      const ownLines: string[] = [];
      const running = runOperate("up", ["--laptop", "--no-open", "--repo", repo, "--port", String(PORT + 72), "--for", "10000"], line => ownLines.push(line), {
        databaseFile: second, inferProjectFromCwd: false, upSeams: person,
      });
      for (const deadline = Date.now() + 60_000; ;) {
        if (existsSync(second)) {
          const store = openStore(second);
          try { if ((await proveLiveConsole(second, store, packageVersion())).ok) break; } finally { store.close(); }
        }
        if (Date.now() > deadline) throw Error(`the first console never proved live:\n${ownLines.join("\n")}`);
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      lines = [];
      const again = await runOperate("up", ["--laptop", "--no-open", "--repo", repo, "--for", "1200", "--json"], line => lines.push(line), {
        databaseFile: second, inferProjectFromCwd: false, upSeams: { terminal: false, env: {}, home: join(base, "home"), fenceAvailable: () => true, laptopPorts: [PORT + 70, PORT + 73] },
      });
      expect(again).not.toBe(0);
      expect(envelope()).toMatchObject({ ok: false, reason: "already-running", message: `Toolroll is already running at http://127.0.0.1:${PORT + 72}` });
      const probe = createServer();
      await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(PORT + 73, "127.0.0.1", () => resolve()); });
      probe.close();
      const store = openStore(second);
      try { expect(laptopPortOf(store)).toBeNull(); } finally { store.close(); }
      // The first start ends on its own (--for): `stop` would signal this very process, which runs it.
      expect(await running, ownLines.join("\n")).toBe(0);
    } finally { foreign.close(); rmSync(short, { recursive: true, force: true }); }
  });

  test("the console mints only the kind of link its own start was authorised for; a request of another kind gets none", () => {
    const minted: string[] = [];
    const server = { mintSignInLink: (account: string) => { minted.push(`full:${account}`); return "/login/once/full"; }, mintLocalLink: () => { minted.push("local"); return "/login/once/local"; } };
    expect(consoleSignInLink(server, "local", { type: "sign-in-link", id: 1, kind: "local" })).toBe("/login/once/local");
    expect(consoleSignInLink(server, "full", { type: "sign-in-link", id: 2, kind: "full", account: "alex" })).toBe("/login/once/full");
    // Forged: a local start asked for a full link, a full start asked for a local one, or a start with no authority.
    expect(consoleSignInLink(server, "local", { type: "sign-in-link", id: 3, kind: "full", account: "alex" })).toBeNull();
    expect(consoleSignInLink(server, "full", { type: "sign-in-link", id: 4, kind: "local" })).toBeNull();
    expect(consoleSignInLink(server, "none", { type: "sign-in-link", id: 5, kind: "full", account: "alex" })).toBeNull();
    expect(consoleSignInLink(server, "none", { type: "sign-in-link", id: 6, kind: "local" })).toBeNull();
    expect(minted).toEqual(["local", "full:alex"]);
    expect(upLinkRequest("local", "alex")).toEqual({ kind: "local" });
    expect(upLinkRequest("full", "alex")).toEqual({ kind: "full", account: "alex" });
    expect(upLinkRequest("full", null)).toBeNull();
    expect(upLinkRequest("none", "alex")).toBeNull();
  });
});
