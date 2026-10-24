/**
 * Attack: a second name for a fenced file. A hard link made from inside the fence to Toolroll's database, the
 * approver's login or another run's token would be read (or granted, at a sign-in name) by its new name. The OS
 * refuses it: Seatbelt checks a link's source against the fence (measured on macOS 26: `ln` of a fenced file fails
 * under every write mode), and bubblewrap masks the fenced paths, so the source isn't there to link. Positive control:
 * unsandboxed, the same link is made and read.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { fenceFor, linuxFenced, macosFenced, runFolders, taskBoundary, trustedWorktreeBinding, writeAllowlist } from "../../src/agent-fence.js";
import { nativeSeccomp } from "../seccomp-fixture.js";
import { git, marker, needs, osFence, repository, useScratch, write } from "./harness.js";

const scratch = useScratch("hardlink");

describe("attack: a hard link to a fenced file", () => {
  test("native: refused for the database, the login and another run's token, in either write mode; made unsandboxed", async ctx => {
    needs(ctx, osFence());
    const root = scratch();
    const state = join(root, "toolroll");
    const pool = join(state, "worktrees");
    mkdirSync(pool, { recursive: true });
    const secrets = [write(join(state, "orders.db"), marker("db")), write(join(state, "up-login.txt"), marker("login"))];
    const other = realpathSync(mkdtempSync(join(tmpdir(), "so-tools-")));
    try {
      secrets.push(write(join(other, "token"), marker("token")));
      const main = repository(join(root, "shop"));
      const worktree = join(pool, "shop", "task-1-0123abcd");
      git(main, "worktree", "add", "-q", "-b", "t1", worktree);
      const home = join(root, "home");
      const binding = trustedWorktreeBinding(main, worktree, [pool]);
      const script = secrets.map((source, index) => `if ln ${JSON.stringify(source)} l${index} 2>/dev/null; then cat l${index}; echo made; else echo refused; fi`).join("\n");
      for (const workspace of [true, false]) {
        const allowed = workspace ? writeAllowlist({ provider: "command", home, worktree, binding, launchFolder: null, cache: null }) : null;
        const launch = fenceFor("build", { databaseFile: join(state, "orders.db"), worktree, home, binding, runFolders: runFolders(null), poolRoots: [pool], policy: 2,
          boundary: taskBoundary({ worktree, provider: "command", home, binding, policy: 2 }), writes: allowed === null ? null : { writes: allowed.writes, readOnly: allowed.readOnly } });
        const wrapped = process.platform === "darwin" ? macosFenced("/bin/sh", ["-c", script], launch.fence, launch.fenceGrants)
          : linuxFenced("/bin/sh", ["-c", script], launch.fence, { ...launch.fenceGrants, seccomp: nativeSeccomp()! });
        const out = await new Promise<string>(done => {
          const child = spawn(wrapped.file, wrapped.args, { cwd: worktree, stdio: ["ignore", "pipe", "ignore"] });
          let text = "";
          child.stdout.on("data", chunk => { text += chunk; });
          child.on("close", () => done(text));
        });
        expect(out.trim().split("\n"), workspace ? "workspace" : "anywhere").toEqual(["refused", "refused", "refused"]);
      }
      // Positive control: unsandboxed, the link is made and reads the secret.
      expect(execFileSync("/bin/sh", ["-c", `ln ${JSON.stringify(secrets[0]!)} control && cat control`], { cwd: worktree, encoding: "utf8" })).toMatch(/^synthetic-attack-db-/);
    } finally { rmSync(other, { recursive: true, force: true }); }
  });
});
