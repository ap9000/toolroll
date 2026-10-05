/**
 * `toolroll up` — one command to a working cockpit, proven over the
 * real machinery: real git, a real bind, real watch loops bounded by --for.
 * The ordering guarantees (nothing mints before the port), the credential
 * file's discipline, and the runner lifecycle are each their own proof.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir, userInfo, hostname } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { execFileSync } from "node:child_process";
import { runOperate, parseOperateArgs } from "./operate.js";
import { openStore } from "./store.js";
import { register, normalizeRunnerName } from "./runner.js";
import { addApprover, authenticateApprover } from "./scope.js";
import { addRepos, loadProjectRegistry, updateRepos } from "./repos.js";
import { underAgent } from "./prompt.js";

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

const up = (extra: string[] = [], port = PORT) =>
  runOperate("up", ["--repo", repo, "--port", String(port), "--for", "1200", "--json", ...extra], line => lines.push(line), {
    databaseFile: db,
  });

const envelope = (): Record<string, unknown> => JSON.parse(lines.join("\n")) as Record<string, unknown>;

describe("toolroll up", () => {
  test("cold start: mints the login durably, registers a worker, watches, retires cleanly", async () => {
    const code = await up();
    expect(code).toBe(0);
    const answer = envelope();
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

  test("--capacity sets the built-in worker's capacity, in the ledger, and a restart keeps it", async () => {
    expect(await up(["--capacity", "3"], PORT + 11)).toBe(0);
    const answer = envelope();
    const runner = String(answer["runner"]);
    let store = openStore(db);
    try {
      expect(store.getRunner(runner)?.runner.capacity).toBe(3);
      const entry = store.handle.prepare("SELECT actor, action, detail FROM action_ledger WHERE action = ?").get(`worker capacity: ${runner}`);
      expect(entry).toMatchObject({ actor: String(answer["approver"]), detail: "1 → 3" });
    } finally {
      store.close();
    }
    lines = [];
    expect(await up([], PORT + 12)).toBe(0);
    store = openStore(db);
    try {
      expect(store.getRunner(runner)?.runner.capacity).toBe(3);
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
    expect(existsSync(join(base, "up-login.txt"))).toBe(false);
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
      expect(existsSync(join(base, "up-login.txt"))).toBe(false);
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
    const [account = "", password = ""] = readFileSync(join(base, "up-login.txt"), "utf8").trim().split(" ");
    expect(text).toContain(`Toolroll is ready.\n  console   http://127.0.0.1:${PORT + 14}`);
    expect(text).toContain(`  login     ${account} — the password is in ${join(base, "up-login.txt")}`);
    expect(text).toContain('  say next  "queue these bugs overnight" · "what needs me?" · "open the result"');
    expect(text).toContain("Run `toolroll onboard` inside a repository");
    expect(text).not.toContain(password);
    expect(text).not.toContain("Ctrl-C stops Toolroll");
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
    const [who = "", secret = ""] = readFileSync(join(base, "up-login.txt"), "utf8").trim().split(" ");
    expect(greeting).not.toContain(secret);
    expect(greeting).toContain([
      `Toolroll is on http://127.0.0.1:${PORT + 15}/`,
      "Opening it in your browser now, already signed in.",
      `If it doesn't open, go to that address and sign in as ${who}: the password is in ${join(base, "up-login.txt")}.`,
    ].join("\n"));
    expect(greeting).not.toContain("/login/once/");
    expect(greeting).not.toContain(`repository  ${repo}`);
    // A person at a terminal reads at most one plain sentence about containment; --verbose adds the exact status.
    expect(lines.join("\n")).not.toContain("watch: containment: ");
    expect(lines.filter(line => line.startsWith("Agents run without Linux process containment")).length).toBeLessThanOrEqual(1);
    expect(lines.join("\n")).toContain("Toolroll stopped. Run `toolroll up` anywhere on this machine");
    // onboard names the console where up last served it.
    expect(JSON.parse(readFileSync(join(base, "up-console.json"), "utf8"))).toMatchObject({ url: `http://127.0.0.1:${PORT + 15}/` });
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
      rmSync(join(base, "up-login.txt"), { force: true });
      for (const file of [db, `${db}-wal`, `${db}-shm`]) rmSync(file, { force: true });
      lines = [];
      const opened: string[] = [];
      expect(await runOperate("up", ["--repo", repo, "--port", String(PORT + 16), "--for", "1200"], line => lines.push(line), {
        databaseFile: db,
        upSeams: { terminal: true, env, openBrowser: url => opened.push(url) },
      })).toBe(0);
      const text = lines.join("\n");
      const [account = "", password = ""] = readFileSync(join(base, "up-login.txt"), "utf8").trim().split(" ");
      expect(text).toContain(`  login     ${account} — the password is in ${join(base, "up-login.txt")}`);
      expect(text).not.toContain(password);
      expect(text).not.toContain("Ctrl-C stops Toolroll");
      expect(opened).toEqual([]);
    }
  });

  test("the generated worker name comes from this machine's hostname, normalized", async () => {
    await up([], PORT + 4);
    const named = String(envelope()["runner"]);
    expect(named.startsWith(normalizeRunnerName(hostname()).slice(0, 8))).toBe(true);
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
      expect(said.join("\n")).toContain("isn't a Git repository");

      // The owner adds from the command line; the running console has it within the adoption.
      said.length = 0;
      expect(await main(["repos", "add", market], line => said.push(line))).toBe(0);
      expect(said).toEqual(["Added vamarketplacenew; it is in the console now."]);
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
        expect(said.join("\n")).toContain("Removed vamarketplacenew");
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

  test("the minted approver defaults to the operating-system user", async () => {
    await up([], PORT + 5);
    const expected = process.env["USER"] ?? process.env["USERNAME"] ?? "operator";
    expect(envelope()["approver"]).toBe(expected === "" ? "operator" : expected);
    expect(String(envelope()["approver"]).length).toBeGreaterThan(0);
    expect(userInfo().username.length).toBeGreaterThan(0);
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

  test("repeated --repo: the Map keeps last-wins for existing verbs; the list keeps every one", () => {
    const parsed = parseOperateArgs(["--repo", "/a", "--repo", "/b,/c"]);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.flags.get("repo")).toBe("/b,/c");
    expect(parsed.repoList).toEqual(["/a", "/b", "/c"]);
  });

  test("--no-open is a recognized boolean", () => {
    const parsed = parseOperateArgs(["--no-open"]);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.flags.get("no-open")).toBe(true);
  });
});
