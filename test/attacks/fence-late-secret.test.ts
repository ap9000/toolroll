/**
 * Attack: read the saved login that was written AFTER this build launched. A fresh installation has no saved login
 * yet; the first one is saved while a build may already be running, and a fence built from a listing of the state
 * folder (or bubblewrap, which can't deny a path that isn't there) never named it, so the running build could read it
 * and approve its own work (Codex easy-start review, finding 2).
 * Guard: saved credentials live in a reserved owner-only folder beside the database (login-secrets.ts), made before
 * any launch and denied whole (agent-fence.ts), so whatever is written into it later is behind the launch's fence on
 * every backend. An older install's `up-login.txt` beside the database stays denied when it is there at launch, and on
 * macOS (Seatbelt; Codex's profile too) by name even when it appears later.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { codexFenceArgv, fenceFor, runFolders, sandboxedSpawn, taskBoundary, trustedWorktreeBinding } from "../../src/agent-fence.js";
import { legacyLoginFileOf, loginFileOf, secretsDirOf, writableLoginFile } from "../../src/login-secrets.js";
import { writeLoginFileDurably } from "../../src/operate.js";
import { codexSandbox, git, marker, needs, osFence, q, repository, useChildren, useScratch, write } from "./harness.js";

const scratch = useScratch("late-secret");
const track = useChildren();

/** One plane as Toolroll lays it out: the database in `stateName` (Toolroll's own folder, or a shared one), a build's
 * checkout in its pool, and the launch's fence exactly as a build gets it. */
function plane(stateName: string, label = "plane") {
  const root = join(scratch(), label);
  const home = join(root, "home");
  const state = join(root, stateName);
  const pool = join(state, "worktrees");
  mkdirSync(pool, { recursive: true });
  write(join(state, "orders.db"), "db");
  const main = repository(join(root, "shop"));
  const worktree = join(pool, "shop", "task-1-0123abcd");
  git(main, "worktree", "add", "-q", "-b", "t1", worktree);
  const binding = trustedWorktreeBinding(main, worktree, [pool]);
  const launch = () => fenceFor("build", { databaseFile: join(state, "orders.db"), worktree, home, binding, runFolders: runFolders(null), poolRoots: [pool], policy: 2,
    boundary: taskBoundary({ worktree, provider: "command", home, binding, policy: 2 }), writes: null });
  return { root, home, state, worktree, launch };
}

/** The fenced probe: says it started, waits for the test's go-ahead (a file in its own checkout), then tries. */
const probe = (reads: Record<string, string>): string => [
  "echo started",
  "i=0; while [ ! -f go ] && [ $i -lt 600 ]; do sleep 0.05; i=$((i+1)); done",
  ...Object.entries(reads).map(([label, path]) => `cat ${q(path)} 2>/dev/null || echo ${label}-denied`),
  "echo mine > mine.txt && cat mine.txt",
].join("\n");

/** Launch first; once it runs, `plant` writes the secrets, then the probe is let go. Resolves with what it printed. */
async function launchThenPlant(file: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd: string, plant: () => void): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child: ChildProcess = track(spawn(file, [...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] }));
  let stdout = "", stderr = "";
  child.stderr!.on("data", chunk => { stderr += chunk; });
  const closed = new Promise<number | null>(done => child.on("close", done));
  await new Promise<void>((started, failed) => {
    child.stdout!.on("data", chunk => { stdout += chunk; if (stdout.includes("started\n")) started(); });
    void closed.then(() => failed(new Error(`the probe ended before it started: ${stdout}${stderr}`)));
  });
  plant();
  writeFileSync(join(cwd, "go"), "");
  return { status: await closed, stdout, stderr };
}

const printed = (result: { stdout: string }): string[] => result.stdout.trim().split("\n").filter(line => line !== "" && line !== "started");

describe.each([["Toolroll's own state folder", "toolroll"], ["a shared folder", "shared-place"]])("attack: a saved login written after launch (%s)", (_, stateName) => {
  test("policy: the reserved folder is made owner-only before the launch and denied whole", () => {
    const at = plane(stateName);
    const { fence, fenceGrants } = at.launch();
    expect(statSync(secretsDirOf(at.state)).mode & 0o777).toBe(0o700);
    expect(fence).toContain(secretsDirOf(at.state));
    const table = codexFenceArgv(fence, false, fenceGrants).find(arg => arg.startsWith("permissions.standing-orders.filesystem="))!;
    expect(table).toContain(`${q(secretsDirOf(at.state))}="deny"`);
    if (process.platform === "darwin") expect(fence).toContain(legacyLoginFileOf(at.state));
  });

  test("native OS fence: the login saved into the reserved folder after launch is unreadable from that launch", async ctx => {
    needs(ctx, osFence());
    const at = plane(stateName);
    const { fence, fenceGrants } = at.launch();
    const secret = marker("late-login");
    const legacySecret = marker("late-legacy");
    const reads: Record<string, string> = { saved: loginFileOf(at.state), ...(process.platform === "darwin" ? { legacy: legacyLoginFileOf(at.state) } : {}) };
    const wrapped = sandboxedSpawn("/bin/sh", ["-c", probe(reads)], fence, fenceGrants, at.worktree);
    const result = await launchThenPlant(wrapped.file, wrapped.args, { ...process.env, NODE_OPTIONS: undefined, ...wrapped.env }, at.worktree, () => {
      // The production writer, as `up` saves the first login.
      writeLoginFileDurably(writableLoginFile(at.state), "alex", secret);
      // Seatbelt denies the old name too, there or not.
      if (process.platform === "darwin") writeFileSync(legacyLoginFileOf(at.state), `alex ${legacySecret}\n`, { mode: 0o600 });
    });
    expect(result.stdout + result.stderr).not.toContain(secret);
    expect(result.stdout + result.stderr).not.toContain(legacySecret);
    expect(printed(result), result.stderr).toEqual([...Object.keys(reads).map(label => `${label}-denied`), "mine"]);
    // Positive control: the file really is there, and readable outside the fence.
    expect(readFileSync(loginFileOf(at.state), "utf8")).toBe(`alex ${secret}\n`);
  });

  test("native OS fence: an older install's login beside the database, there at launch, stays unreadable", async ctx => {
    needs(ctx, osFence());
    const at = plane(stateName);
    const secret = marker("legacy-login");
    writeFileSync(legacyLoginFileOf(at.state), `alex ${secret}\n`, { mode: 0o600 });
    const { fence, fenceGrants } = at.launch();
    const wrapped = sandboxedSpawn("/bin/sh", ["-c", probe({ legacy: legacyLoginFileOf(at.state) })], fence, fenceGrants, at.worktree);
    const result = await launchThenPlant(wrapped.file, wrapped.args, { ...process.env, NODE_OPTIONS: undefined, ...wrapped.env }, at.worktree, () => undefined);
    expect(result.stdout + result.stderr).not.toContain(secret);
    expect(printed(result), result.stderr).toEqual(["legacy-denied", "mine"]);
  });

  test("native Codex: the login saved after launch is unreadable from that launch, in either mode; an older one there at launch too", async ctx => {
    needs(ctx, codexSandbox());
    for (const fullAccess of [false, true]) {
      const at = plane(stateName, fullAccess ? "full" : "workspace");
      const legacySecret = marker("codex-legacy");
      writeFileSync(legacyLoginFileOf(at.state), `alex ${legacySecret}\n`, { mode: 0o600 });
      const { fence, fenceGrants } = at.launch();
      const secret = marker("codex-late-login");
      const codexHome = join(at.root, "codex-home");
      mkdirSync(codexHome, { recursive: true });
      const argv = ["sandbox", ...codexFenceArgv(fence, fullAccess, fenceGrants), "-P", "standing-orders", "--", "/bin/sh", "-c", probe({ saved: loginFileOf(at.state), legacy: legacyLoginFileOf(at.state) })];
      const result = await launchThenPlant("codex", argv, { ...process.env, NODE_OPTIONS: undefined, CODEX_HOME: codexHome }, at.worktree, () => {
        writeLoginFileDurably(writableLoginFile(at.state), "alex", secret);
      });
      expect(result.stdout + result.stderr).not.toContain(secret);
      expect(result.stdout + result.stderr).not.toContain(legacySecret);
      expect(printed(result), `${fullAccess ? "full access" : "workspace"}: ${result.stderr}`).toEqual(["saved-denied", "legacy-denied", "mine"]);
    }
  });
});
