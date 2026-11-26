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
import { execFileSync, spawn } from "node:child_process";
import { consoleSignInLink, easyStartInitLocalMode, runOperate, parseOperateArgs, upLinkRequest, upNarrowDeferred } from "./operate.js";
import { run as execRun } from "./exec.js";
import { type Runner as CommandRunner } from "./builder.js";
import { sweepServiceRunning } from "./storage-sweep-schedule.js";
import { enrollOwnerPassword, laptopPortOf, openStore, reportLifecycle } from "./store.js";
import { backgroundShow } from "./laptop-background.js";
import { register } from "./runner.js";
import { addApprover, authenticateApprover, hashPassword } from "./scope.js";
import { addRepos, loadProjectRegistry, registryRemovals, updateRepos } from "./repos.js";
import { instanceRunDir, proveLiveConsole, readInstance } from "./console-instance.js";
import { packageVersion } from "./monitoring.js";
import { underAgent } from "./prompt.js";
import { shortTempDir } from "../test/short-temp.js";
import { SOCKETS_TOO_DEEP } from "../test/inside-fence.js";
import type { SignInOpener } from "./sign-in-page.js";
import { termsArgs } from "../test/approval-terms.js";
import { freePort, freePorts, listenedPort } from "../test/free-port.js";

/** This test's own port, chosen at run time (test/free-port.ts); a test needing more asks freePorts for its own. */
let PORT: number;

let base: string;
let repo: string;
let db: string;
let lines: string[];

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (args: string[], cwd: string) =>
  execFileSync("git", args, { cwd, env: { ...gitEnv, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

beforeEach(async () => {
  PORT = await freePort();
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

/**
 * The opener `up` hands its sign-in page to (eight k1), standing in for the platform's own: what it was started with is
 * kept, checked to carry nothing but the page's path, and the link that page carries is read from it, as a browser would.
 */
function signInOpener(opened: string[], onLink: (link: string) => void = () => {}): SignInOpener {
  return (command, args) => {
    expect(command).toBe(process.platform === "darwin" ? "open" : "xdg-open");
    expect(args).toHaveLength(1);
    expect(args[0]).toMatch(/\/\.toolroll-run\/sign-in-[A-Za-z0-9]{6}\/open\.html$/);
    expect(args.join(" ")).not.toMatch(/login|once|[A-Za-z0-9_-]{43}/);
    expect(statSync(args[0]!).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(args[0]!)).mode & 0o777).toBe(0o700);
    const link = /location\.replace\("([^"]+)"\)/.exec(readFileSync(args[0]!, "utf8"))![1]!;
    opened.push(link);
    onLink(link);
    // A real program that exits at once, successfully: the opener's channel waits on its exit.
    return spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  };
}

const envelope = (): Record<string, unknown> => JSON.parse(lines.join("\n")) as Record<string, unknown>;

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
      upSeams: { terminal: true, env: {}, home: seams.home ?? join(base, "home"), fenceAvailable: () => true, signInOpener: signInOpener(opened, url => { spent.push(fetch(url, { redirect: "manual" })); }) },
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

  test("a computer with no opener Toolroll can hand a page to (Windows): no link is minted or opened, and the greeting says what to do instead", async () => {
    const [p90] = await freePorts(1);
    const started: string[] = [];
    lines = [];
    const code = await runOperate("up", ["--laptop", "--repo", repo, "--port", String(p90), "--for", "1500"], line => lines.push(line), {
      databaseFile: db, inferProjectFromCwd: false,
      upSeams: { terminal: true, env: {}, home: join(base, "home"), fenceAvailable: () => true, signInPlatform: "win32",
        signInOpener: (command, args) => { started.push([command, ...args].join(" ")); return spawn(process.execPath, ["-e", ""], { stdio: "ignore" }); } },
    });
    expect(code, lines.join("\n")).toBe(0);
    expect(started).toEqual([]);
    const text = lines.join("\n");
    expect(text).toContain("This computer can't open a browser for Toolroll safely. To use the browser, run `toolroll password set` and sign in with that password.");
    expect(text).not.toContain("Opening it in your browser");
    expect(text).not.toContain("/login/once/");
    expect(existsSync(join(instanceRunDir(db))) ? readdirSync(instanceRunDir(db)).filter(name => name.startsWith("sign-in-")) : []).toEqual([]);
  });

  test("a new laptop install opens signed in as its owner with no password, before and after a password is set", async () => {
    const [p40, p41, p42, p43] = await freePorts(4);
    const first = await interactive(["--laptop", "--repo", repo], p40);
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
    const second = await interactive(["--laptop", "--repo", repo], p41);
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
    const third = await interactive(["--repo", repo], p42);
    expect(third.code).toBe(0);
    expect(third.opened).toHaveLength(1);
    expect(third.sessions).toEqual([{ authority: "local-owner", localGeneration: 1 }]);
    expect(existsSync(loginFile())).toBe(false);

    // --no-open: no link at all.
    const quiet = await interactive(["--laptop", "--repo", repo, "--no-open"], p43);
    expect(quiet.code).toBe(0);
    expect(quiet.opened).toEqual([]);
  });

  test("an existing install with a saved login keeps the full link; --laptop changes nothing there", async () => {
    const [p44, p45] = await freePorts(2);
    expect(await up([], p44)).toBe(0);
    expect(existsSync(loginFile())).toBe(true);
    const again = await interactive(["--laptop", "--repo", repo], p45);
    expect(again.code).toBe(0);
    expect(again.opened).toHaveLength(1);
    expect(again.sessions).toEqual([{ authority: "full", localGeneration: null }]);
    const store = openStore(db);
    try { expect(store.handle.prepare("SELECT count(*) AS n FROM local_mode").get()!["n"]).toBe(0); } finally { store.close(); }
  });

  test("a laptop start with no projects folder uses ~/Projects; it serves this computer only", async () => {
    const [p46, p47] = await freePorts(2);
    const home = join(base, "home");
    mkdirSync(home);
    const started = await interactive(["--laptop", "--no-open"], p46, { home });
    expect(started.code, lines.join("\n")).toBe(0);
    expect(statSync(join(home, "Projects")).isDirectory()).toBe(true);
    expect((await loadProjectRegistry(join(base, "repos.json")) as { roots: string[] }).roots).toEqual([realpathSync(join(home, "Projects"))]);
    lines = [];
    expect(await runOperate("up", ["--laptop", "--host", "0.0.0.0", "--port", String(p47), "--json"], line => lines.push(line), { databaseFile: db })).not.toBe(0);
    expect(envelope()).toMatchObject({ ok: false, reason: "usage" });
  });

  test("a NEW laptop install steps past a port another program holds, saves it, and keeps it; other installs never move", async () => {
    const [p49, p50] = await freePorts(2);
    // Something that isn't this database's console holds the first port (another Toolroll, the desktop app's).
    const foreign = createServer();
    const p48 = await listenedPort(foreign);
    try {
      const ports = [p48, p49, p50];
      const start = async (extra: string[] = []): Promise<number> => {
        lines = [];
        return runOperate("up", ["--laptop", "--no-open", "--repo", repo, "--for", "1500", "--json", ...extra], line => lines.push(line), {
          databaseFile: db, inferProjectFromCwd: false,
          upSeams: { terminal: false, env: {}, home: join(base, "home"), fenceAvailable: () => true, laptopPorts: ports },
        });
      };
      expect(await start(), lines.join("\n")).toBe(0);
      expect(String(envelope()["url"])).toContain(`:${p49}`);
      const saved = openStore(db);
      try {
        expect(laptopPortOf(saved)).toBe(p49);
        // The background service's unit (and its show) name the saved port when nothing is running.
        const shown = await backgroundShow(saved, db, null, { platform: "linux", home: join(base, "home"), node: process.execPath, dist: base, proveConsole: async () => ({ ok: false, state: "none", message: "no console is running" }), supervisor: async () => ({ code: 1, stdout: "", stderr: "" }) as never });
        expect(shown.ok && shown.show.port).toBe(p49);
      } finally { saved.close(); }
      // The next start keeps the saved port, even with the first one free again.
      foreign.close();
      expect(await start(), lines.join("\n")).toBe(0);
      expect(String(envelope()["url"])).toContain(`:${p49}`);
      // --port still wins, and saves nothing new.
      expect(await start(["--port", String(p50)]), lines.join("\n")).toBe(0);
      expect(String(envelope()["url"])).toContain(`:${p50}`);
      const after = openStore(db);
      try { expect(laptopPortOf(after)).toBe(p49); } finally { after.close(); }
    } finally { foreign.close(); }
  });

  test("an install not made by `up --laptop` keeps up's default port: a held port refuses, as before", async () => {
    const [p51, p53] = await freePorts(2);
    expect(await up([], p51)).toBe(0);
    const foreign = createServer();
    const p52 = await listenedPort(foreign);
    try {
      lines = [];
      const code = await runOperate("up", ["--laptop", "--no-open", "--repo", repo, "--for", "1500", "--json"], line => lines.push(line), {
        databaseFile: db, inferProjectFromCwd: false,
        upSeams: { terminal: false, env: {}, home: join(base, "home"), fenceAvailable: () => true, laptopPorts: [p52, p53] },
      });
      expect(code).not.toBe(0);
      expect(envelope()).toMatchObject({ ok: false, reason: "port-busy" });
      const store = openStore(db);
      try { expect(laptopPortOf(store)).toBeNull(); } finally { store.close(); }
    } finally { foreign.close(); }
  });

  test("eight W2: a database made first by `status` becomes password-free under a direct `up --laptop` only for a person at its terminal", async () => {
    const [p64, p60, p63, p61, p62] = await freePorts(5);
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
    expect(await laptopUp(fresh, p64, { terminal: false, env: {}, json: true }), lines.join("\n")).toBe(0);
    expect(localRows(fresh)).toBe(0);
    for (const [index, seams] of notPeople.entries()) {
      const file = join(base, `not-person-${index}.db`);
      await madeByStatus(file);
      expect(await laptopUp(file, [p60, p61, p62][index]!, seams), lines.join("\n")).toBe(0);
      expect(localRows(file), JSON.stringify(seams)).toBe(0);
    }
    // A person at its terminal: password-free, provenance untouched, no login minted.
    const file = join(base, "person.db");
    await madeByStatus(file);
    expect(await laptopUp(file, p63, { terminal: true, env: {} }), lines.join("\n")).toBe(0);
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
    const [p71] = await freePorts(1);
    const foreign = createServer();
    const p70 = await listenedPort(foreign);
    const person = { terminal: true, env: {}, home: join(base, "home"), fenceAvailable: () => true };
    try {
      // A database `status` made first, started by a person at its terminal with no --port: the next free port.
      const first = join(base, "first.db");
      expect(await runOperate("status", ["--json"], () => {}, { databaseFile: first })).toBe(0);
      lines = [];
      const code = await runOperate("up", ["--laptop", "--no-open", "--repo", repo, "--for", "1200"], line => lines.push(line), {
        databaseFile: first, inferProjectFromCwd: false, upSeams: { ...person, laptopPorts: [p70, p71] },
      });
      expect(code, lines.join("\n")).toBe(0);
      expect(lines.join("\n")).toContain(`port ${p70} is in use by another program, so Toolroll uses ${p71}`);
      const saved = openStore(first);
      try { expect(laptopPortOf(saved)).toBe(p71); } finally { saved.close(); }
    } finally { foreign.close(); }
  });

  test.skipIf(SOCKETS_TOO_DEEP)("eight W2: a laptop start never steps past a busy port while this database's own console runs", async () => {
    const [p72, p73] = await freePorts(2);
    const foreign = createServer();
    const p70 = await listenedPort(foreign);
    const person = { terminal: true, env: {}, home: join(base, "home"), fenceAvailable: () => true };
    // The console's socket sits beside its database: a short folder keeps it within the OS limit.
    const short = shortTempDir("so-w2-");
    try {
      // This database's own console running (on a port it was given): a second start never steps past the busy first
      // port to start another console beside it. It says where Toolroll runs, and nothing else is bound or written.
      const second = join(short, "second.db");
      const ownLines: string[] = [];
      const running = runOperate("up", ["--laptop", "--no-open", "--repo", repo, "--port", String(p72), "--for", "10000"], line => ownLines.push(line), {
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
        databaseFile: second, inferProjectFromCwd: false, upSeams: { terminal: false, env: {}, home: join(base, "home"), fenceAvailable: () => true, laptopPorts: [p70, p73] },
      });
      expect(again).not.toBe(0);
      expect(envelope()).toMatchObject({ ok: false, reason: "already-running", message: `Toolroll is already running at http://127.0.0.1:${p72}` });
      const probe = createServer();
      await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(p73, "127.0.0.1", () => resolve()); });
      probe.close();
      const store = openStore(second);
      try { expect(laptopPortOf(store)).toBeNull(); } finally { store.close(); }
      // The first start ends on its own (--for): `stop` would signal this very process, which runs it.
      expect(await running, ownLines.join("\n")).toBe(0);
    } finally { foreign.close(); rmSync(short, { recursive: true, force: true }); }
  });

  test("eight W2 (Codex #377 finding 2): a standalone `serve` running on an accountless database is never stepped past or made password-free", async () => {
    const [p74, p75, p77] = await freePorts(3);
    const file = join(base, "served.db");
    expect(await runOperate("status", ["--json"], () => {}, { databaseFile: file })).toBe(0);
    const home = join(base, "home");
    mkdirSync(home, { recursive: true });
    // `serve` as a person runs it: its own process (it stops on a signal), from source.
    const served = spawn(process.execPath, ["--import", "tsx", "src/bin.ts", "serve", "--db", file, "--port", String(p74), "--json"], {
      cwd: process.cwd(), env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config") }, stdio: ["ignore", "pipe", "pipe"],
    });
    let said = "";
    served.stdout!.on("data", chunk => { said += String(chunk); });
    served.stderr!.on("data", chunk => { said += String(chunk); });
    const exited = new Promise<void>(resolve => served.once("exit", () => resolve()));
    try {
      for (const deadline = Date.now() + 60_000; !said.includes('"port"');) {
        if (served.exitCode !== null || Date.now() > deadline) throw Error(`serve never started:\n${said}`);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const localRows = (): number => { const store = openStore(file); try { return Number(store.handle.prepare("SELECT count(*) AS n FROM local_mode").get()!["n"]); } finally { store.close(); } };
      // A person's laptop start with no --port, the served port first in line: refused, nothing bound or made.
      lines = [];
      const code = await runOperate("up", ["--laptop", "--no-open", "--repo", repo, "--for", "1200"], line => lines.push(line), {
        databaseFile: file, inferProjectFromCwd: false, upSeams: { terminal: true, env: {}, home, fenceAvailable: () => true, laptopPorts: [p74, p75] },
      });
      expect(code, lines.join("\n")).not.toBe(0);
      // The served port carries this database's console lifecycle row: never stepped past (the ordinary port-taken words).
      expect(lines.join("\n")).toContain(`port ${p74} is taken`);
      expect(localRows()).toBe(0);
      const probe = createServer();
      await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(p75, "127.0.0.1", () => resolve()); });
      probe.close();
      // `serve` on a port not in line, another program holding the first one: still never stepped past to a second console.
      const foreign = createServer();
      const p76 = await listenedPort(foreign);
      try {
        lines = [];
        const beside = await runOperate("up", ["--laptop", "--no-open", "--repo", repo, "--for", "1200"], line => lines.push(line), {
          databaseFile: file, inferProjectFromCwd: false, upSeams: { terminal: true, env: {}, home, fenceAvailable: () => true, laptopPorts: [p76, p77] },
        });
        expect(beside, lines.join("\n")).not.toBe(0);
        expect(lines.join("\n")).toContain(`Toolroll is already running at http://127.0.0.1:${p74}`);
        expect(localRows()).toBe(0);
      } finally { foreign.close(); }
      // Bare `toolroll`'s initialisation at the terminal refuses too, while `serve` runs.
      const person = { stdin: true, stdout: true, agent: false, json: false, remote: false };
      expect(await easyStartInitLocalMode(file, person, { fence: () => true, owner: "sam" })).toBe(false);
      expect(localRows()).toBe(0);
      // Once `serve` has stopped, the same database may become password-free.
      served.kill("SIGTERM");
      await exited;
      expect(await easyStartInitLocalMode(file, person, { fence: () => true, owner: "sam" })).toBe(true);
    } finally {
      if (served.exitCode === null && served.signalCode === null) served.kill("SIGKILL");
    }
  });

  test("eight W2 (Codex #377 round 2, finding A): a stale console row blocks stepping while its port still listens, not once nothing does", async () => {
    const [p82, p83] = await freePorts(2);
    const foreign = createServer();
    const p80 = await listenedPort(foreign);
    // A console of this database that is paused: its row is old (no heartbeat), its port still answers.
    const paused = createServer();
    const p81 = await listenedPort(paused);
    const home = join(base, "home");
    const start = async (file: string): Promise<number> => {
      lines = [];
      return runOperate("up", ["--laptop", "--no-open", "--repo", repo, "--for", "1200"], line => lines.push(line), {
        databaseFile: file, inferProjectFromCwd: false, upSeams: { terminal: true, env: {}, home, fenceAvailable: () => true, laptopPorts: [p80, p82] },
      });
    };
    const staleRow = (file: string, port: number): void => {
      const store = openStore(file);
      try { reportLifecycle(store, `console:127.0.0.1:${port}`, "started", "serve:1:old", new Date(Date.now() - 10 * 60_000), { pid: 1 }); } finally { store.close(); }
    };
    try {
      const pausedDb = join(base, "paused.db");
      expect(await runOperate("status", ["--json"], () => {}, { databaseFile: pausedDb })).toBe(0);
      staleRow(pausedDb, p81);
      expect(await start(pausedDb), lines.join("\n")).not.toBe(0);
      expect(lines.join("\n")).toContain(`Toolroll is already running at http://127.0.0.1:${p81}`);
      // A row left by a console that crashed (nothing listens on its port any more): the start steps past the busy port.
      const crashedDb = join(base, "crashed.db");
      expect(await runOperate("status", ["--json"], () => {}, { databaseFile: crashedDb })).toBe(0);
      staleRow(crashedDb, p83);
      expect(await start(crashedDb), lines.join("\n")).toBe(0);
      expect(lines.join("\n")).toContain(`port ${p80} is in use by another program, so Toolroll uses ${p82}`);
    } finally { foreign.close(); paused.close(); }
  });

  test("eight W2 (Codex #377 round 2, finding A): `serve` that can't record its console's lifecycle refuses to serve", async () => {
    const [p84] = await freePorts(1);
    const file = join(base, "unrecordable.db");
    expect(await runOperate("status", ["--json"], () => {}, { databaseFile: file })).toBe(0);
    const store = openStore(file);
    try { store.handle.exec("CREATE TRIGGER no_console_rows BEFORE INSERT ON service_lifecycle WHEN NEW.component LIKE 'console:%' BEGIN SELECT RAISE(ABORT, 'refused'); END"); } finally { store.close(); }
    lines = [];
    let settled = false;
    const serving = runOperate("serve", ["--port", String(p84), "--json"], line => lines.push(line), { databaseFile: file }).finally(() => { settled = true; });
    for (const deadline = Date.now() + 10_000; !settled && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 50));
    // Before the fix it serves on (until a signal): stop it so the test can say so.
    if (!settled) process.emit("SIGINT");
    expect(settled).toBe(true);
    expect(await serving).not.toBe(0);
    expect(envelope()).toMatchObject({ ok: false, command: "serve", reason: "lifecycle" });
    const probe = createServer();
    await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(p84, "127.0.0.1", () => resolve()); });
    probe.close();
  });

  test("eight W2 (Codex #377 round 2, finding B): two consoles of one database on one port at different addresses keep their own rows", async () => {
    const [p85] = await freePorts(1);
    const file = join(base, "two.db");
    expect(await runOperate("status", ["--json"], () => {}, { databaseFile: file })).toBe(0);
    const home = join(base, "home");
    mkdirSync(home, { recursive: true });
    const children: ReturnType<typeof spawn>[] = [];
    const serveOn = async (host: string): Promise<void> => {
      const child = spawn(process.execPath, ["--import", "tsx", "src/bin.ts", "serve", "--db", file, "--host", host, "--port", String(p85), "--json"], {
        cwd: process.cwd(), env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config") }, stdio: ["ignore", "pipe", "pipe"],
      });
      children.push(child);
      let said = "";
      child.stdout!.on("data", chunk => { said += String(chunk); });
      child.stderr!.on("data", chunk => { said += String(chunk); });
      for (const deadline = Date.now() + 60_000; !said.includes('"port"');) {
        if (child.exitCode !== null || Date.now() > deadline) throw Error(`serve on ${host} never started:\n${said}`);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    };
    try {
      await serveOn("127.0.0.1");
      await serveOn("::1");
      const store = openStore(file);
      try {
        const rows = store.handle.prepare("SELECT component, state FROM service_lifecycle WHERE component LIKE 'console:%' ORDER BY component").all().map(row => ({ ...row }));
        expect(rows).toEqual([{ component: `console:127.0.0.1:${p85}`, state: "started" }, { component: `console:::1:${p85}`, state: "started" }].sort((a, b) => a.component < b.component ? -1 : 1));
      } finally { store.close(); }
    } finally {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(resolve => child.once("exit", resolve))));
    }
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
