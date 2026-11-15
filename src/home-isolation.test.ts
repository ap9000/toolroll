import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { resolveExecutable } from "./attest.js";
import { buildCacheFolder, claudeProjectFolder, signInGrants, writeAllowlist } from "./agent-fence.js";
import { openSignInPage } from "./sign-in-page.js";
import { openBrowser } from "./operate.js";

// A console started with a throwaway HOME and PATH keeps its agents, their transcripts and its build caches there, and
// hands pages only to the opener its PATH finds (2026-11-14: a journey's console ran the person's own Claude Code under
// their own home; the cause was the journey's environment, and these hold the product to HOME and PATH as given).

const inside = (child: string, parent: string): boolean => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
let dir: string, home: string, stand: string, person: string;
const saved = { PATH: process.env["PATH"], HOME: process.env["HOME"], TOOLROLL_BROWSER_COMMAND: process.env["TOOLROLL_BROWSER_COMMAND"] };

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-home-isolation-")));
  home = join(dir, "home"); stand = join(dir, "stand"); person = join(dir, "person");
  for (const one of [home, stand, join(person, ".local", "bin"), join(person, ".claude", "local")]) mkdirSync(one, { recursive: true });
  // The "person's" own agents, where Claude Code and npm put them: never found unless the PATH names their folder.
  for (const at of [join(person, ".local", "bin", "claude"), join(person, ".claude", "local", "claude"), join(person, ".local", "bin", "codex")]) {
    writeFileSync(at, "#!/bin/sh\necho REAL\n"); chmodSync(at, 0o755);
  }
  for (const name of ["claude", "codex", "open", "xdg-open", "browser"]) {
    writeFileSync(join(stand, name), `#!/bin/sh\nfor arg in "$@"; do printf '%s\\n' "$arg" >> '${join(dir, `${name}.log`)}'; done\nexit 0\n`);
    chmodSync(join(stand, name), 0o755);
  }
  process.env["HOME"] = home;
  process.env["PATH"] = `${stand}:/usr/bin:/bin`;
  delete process.env["TOOLROLL_BROWSER_COMMAND"];
});
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  rmSync(dir, { recursive: true, force: true });
});

const logged = async (name: string, timeoutMs = 5_000): Promise<string[]> => {
  const file = join(dir, `${name}.log`);
  for (const until = Date.now() + timeoutMs; Date.now() < until && !existsSync(file);) await new Promise(done => setTimeout(done, 25));
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
};

describe("a console's agents run from its own PATH", () => {
  it("resolves each agent CLI only through PATH: the stand-in, never one in the person's usual install folders", () => {
    expect(resolveExecutable("claude")).toBe(join(stand, "claude"));
    expect(resolveExecutable("codex")).toBe(join(stand, "codex"));
    process.env["PATH"] = "/usr/bin:/bin";
    // Not on PATH: not installed, wherever else a copy sits.
    expect(resolveExecutable("claude")).toBeNull();
    expect(resolveExecutable("codex")).toBeNull();
  });
});

describe("a console's agents and caches live under its own HOME", () => {
  it("takes HOME from the environment it was started with", () => {
    expect(homedir()).toBe(home);
  });

  it("keeps a project's build cache under that HOME", () => {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    const cache = buildCacheFolder(repo);
    expect(inside(cache, home)).toBe(true);
    expect(inside(cache, person)).toBe(false);
  });

  it("grants a Claude build its transcript folder, and only writes, under that HOME or its checkout", () => {
    const worktree = join(dir, "work");
    mkdirSync(worktree);
    const allowed = writeAllowlist({ provider: "claude", home: homedir(), worktree, binding: null, launchFolder: null, cache: buildCacheFolder(worktree) });
    for (const path of [...allowed.writes.subpaths, ...allowed.writes.prefixes.map(one => one.path), ...allowed.deny]) {
      expect(inside(path, home) || inside(path, realpathSync(worktree)), `${path} is outside the console's HOME and checkout`).toBe(true);
    }
    expect(allowed.writes.subpaths).toContain(claudeProjectFolder(home, realpathSync(worktree)).path);
    // Made where it was granted: in this HOME, never in the person's.
    expect(readdirSync(join(home, ".claude", "projects"))).toHaveLength(1);
    expect(existsSync(join(person, ".claude", "projects"))).toBe(false);
  });

  it("reads a sign-ins check's files from that HOME", () => {
    const checkout = join(dir, "checkout");
    mkdirSync(checkout);
    mkdirSync(join(home, ".claude"));
    const grants = signInGrants(homedir(), checkout, "darwin");
    for (const path of [...grants.read, ...grants.transcripts, ...grants.writes]) expect(inside(path, home), path).toBe(true);
  });
});

describe("a console hands pages only to the opener its own PATH finds", () => {
  it("opens a sign-in page with the platform opener on PATH (the stand-in), with the page's path alone", async () => {
    const page = join(dir, "page.html");
    writeFileSync(page, "<p>page</p>");
    for (const platform of ["darwin", "linux"] as const) {
      await expect(openSignInPage(page, undefined, platform, 2_000)).resolves.toBe(true);
      expect(await logged(platform === "darwin" ? "open" : "xdg-open")).toEqual([page]);
    }
  });

  it("refuses rather than opening a real browser when the PATH has no opener", async () => {
    process.env["PATH"] = join(dir, "empty");
    mkdirSync(join(dir, "empty"));
    const page = join(dir, "page.html");
    writeFileSync(page, "<p>page</p>");
    await expect(openSignInPage(page, undefined, process.platform === "darwin" ? "darwin" : "linux", 2_000)).resolves.toBe(false);
  });

  it("opens a plain address with TOOLROLL_BROWSER_COMMAND when it is set, else the opener on PATH", async () => {
    process.env["TOOLROLL_BROWSER_COMMAND"] = join(stand, "browser");
    openBrowser("http://127.0.0.1:4851/");
    expect(await logged("browser")).toEqual(["http://127.0.0.1:4851/"]);
    if (process.platform !== "darwin" && process.platform !== "linux") return;
    delete process.env["TOOLROLL_BROWSER_COMMAND"];
    openBrowser("http://127.0.0.1:4852/");
    expect(await logged(process.platform === "darwin" ? "open" : "xdg-open")).toEqual(["http://127.0.0.1:4852/"]);
  });
});

describe("nothing in the product finds the person's home behind HOME's back", () => {
  it("never reads the home folder from the password database or a fixed path", () => {
    const root = join(import.meta.dirname);
    const files: string[] = [];
    const walk = (at: string): void => {
      for (const entry of readdirSync(at, { withFileTypes: true })) {
        const path = join(at, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) files.push(path);
      }
    };
    walk(root);
    // The account's home from the password database, or an agent CLI by a fixed install path instead of PATH.
    const forbidden = [/userInfo\(\)\.homedir/, /\bgetpwuid\b/, /NFSHomeDirectory/, /\.local\/bin\/(claude|codex|gemini)\b/, /"\.local", "bin", "(claude|codex|gemini)"/, /\.claude\/local\/claude/];
    const found = files.flatMap(file => readFileSync(file, "utf8").split("\n").flatMap((line, index) =>
      forbidden.some(pattern => pattern.test(line)) ? [`${relative(root, file)}:${index + 1}: ${line.trim().slice(0, 120)}`] : []));
    expect(found).toEqual([]);
  });
});
