/**
 * Home reads at parity with Anthropic's sandbox runtime, and the project's read-deny list (docs/plans/sandbox-parity.md
 * C9). Under fence policy v2 a build reads the home folder (as the sandbox runtime does) except what its approval's
 * `readDeny` lists; an approval sealed before 0.9.70 keeps v1, which denies the home configuration by name; Toolroll's
 * own state stays out of reach under both. Flows: one made before 0.9.70 is v1; one made now is v2, and the project's
 * read denies apply to it as to builds. Positive control: unsandboxed, every canary is a readable file.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { fenceFor, linuxFenced, macosFenced, runFolders, taskBoundary, trustedWorktreeBinding, type FencePolicy } from "../../src/agent-fence.js";
import { run as exec } from "../../src/exec.js";
import { saveScript } from "../../src/flow-scripts.js";
import { runFlowSteps, type StepIo } from "../../src/flow-steps.js";
import { flowFromSteps } from "../../src/flows.js";
import { checkoutSandboxOf } from "../../src/invoke.js";
import { readDenyPath } from "../../src/project-sandbox.js";
import { addApprover } from "../../src/scope.js";
import { openStore } from "../../src/store.js";
import { nativeSeccomp } from "../seccomp-fixture.js";
import { git, marker, needs, osFence, repository, useScratch, write } from "./harness.js";

const scratch = useScratch("home-reads");
const T0 = new Date("2026-10-24T09:00:00.000Z");

function plane() {
  const root = scratch();
  const state = join(root, "toolroll");
  const pool = join(state, "worktrees");
  mkdirSync(pool, { recursive: true });
  const main = repository(join(root, "shop"));
  const worktree = join(pool, "shop", "task-1-0123abcd");
  git(main, "worktree", "add", "-q", "-b", "t1", worktree);
  const home = join(root, "home");
  const canary = { ssh: write(join(home, ".ssh", "id_ed25519"), marker("ssh")), aws: write(join(home, ".aws", "credentials"), marker("aws")),
    state: write(join(state, "up-login.txt"), marker("state")) };
  const binding = trustedWorktreeBinding(main, worktree, [pool]);
  const fence = (policy: FencePolicy, readDeny: string[] = []) => fenceFor("build", { databaseFile: join(state, "orders.db"), worktree, home, binding, runFolders: runFolders(null), poolRoots: [pool],
    boundary: taskBoundary({ worktree, provider: "command", home, binding, policy }), readDeny: readDeny.map(one => readDenyPath(one, home)) });
  return { root, state, main, worktree, home, canary, fence };
}

/** `read`/`denied` per path, in the OS fence. */
function reads(paths: string[], launch: ReturnType<ReturnType<typeof plane>["fence"]>, cwd: string): Promise<string[]> {
  const script = paths.map(path => `if cat ${JSON.stringify(path)} >/dev/null 2>&1; then echo read; else echo denied; fi`).join("\n");
  const wrapped = process.platform === "darwin" ? macosFenced("/bin/sh", ["-c", script], launch.fence, launch.fenceGrants)
    : linuxFenced("/bin/sh", ["-c", script], launch.fence, { ...launch.fenceGrants, seccomp: nativeSeccomp()! });
  return new Promise(done => {
    const child = spawn(wrapped.file, wrapped.args, { cwd, stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", chunk => { out += chunk; });
    child.on("close", () => done(out.trim().split("\n")));
  });
}

describe("home reads under v2, the read-deny list, and v1 kept for older approvals", () => {
  test("native: v2 reads ~/.ssh, a listed path is denied, v1 denies it by name; Toolroll's state is denied under every policy", async ctx => {
    needs(ctx, osFence());
    const { canary, worktree, fence } = plane();
    for (const path of Object.values(canary)) expect(execFileSync("cat", [path], { encoding: "utf8" })).toMatch(/^synthetic-attack-/);
    const order = [canary.ssh, canary.aws, canary.state];
    expect(await reads(order, fence(2), worktree)).toEqual(["read", "read", "denied"]);
    expect(await reads(order, fence(2, ["~/.ssh"]), worktree)).toEqual(["denied", "read", "denied"]);
    expect(await reads(order, fence(1), worktree)).toEqual(["denied", "denied", "denied"]);
  });

  test("native: a read deny that names nothing yet is never dropped: denied by name on a Mac, its nearest folder masked on Linux", async ctx => {
    const { home, worktree, fence } = plane();
    mkdirSync(join(home, ".config", "other"), { recursive: true });
    write(join(home, ".config", "other", "settings"), "visible\n");
    const launch = fence(2, ["~/.config/tool/token"]);
    const target = join(home, ".config", "tool", "token");
    if (process.platform === "linux") expect(launch.fenceGrants.readDenyAbove).toEqual([join(home, ".config")]);
    else expect(launch.fenceGrants.homeNames).toContain(target);
    needs(ctx, osFence());
    // Whatever the launch makes there, it never lands in the real folder; on a Mac it can't even be made.
    const script = `mkdir -p ${JSON.stringify(join(home, ".config", "tool"))} 2>/dev/null; echo planted > ${JSON.stringify(target)} 2>/dev/null; echo done`;
    const wrapped = process.platform === "darwin" ? macosFenced("/bin/sh", ["-c", script], launch.fence, launch.fenceGrants)
      : linuxFenced("/bin/sh", ["-c", script], launch.fence, { ...launch.fenceGrants, seccomp: nativeSeccomp()! });
    execFileSync(wrapped.file, wrapped.args, { cwd: worktree });
    const { existsSync } = await import("node:fs");
    expect(existsSync(target)).toBe(false);
  });

  test("a saved result's checks are never wider than its approvals or the project now", () => {
    const { root } = plane();
    const store = openStore(join(root, "toolroll", "orders.db"));
    try {
      if (!addApprover(store, "alex", T0).ok) throw new Error("bootstrap");
      // No readable approval behind a run: v1, nothing listed, plus the project's read denies now.
      store.raw().prepare("INSERT INTO project_sandbox (repo, read_deny_json, mach_lookup_json, write_unlock_json, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)")
        .run("/repo", JSON.stringify(["~/.aws"]), JSON.stringify(["com.apple.trustd.agent"]), "[]", T0.toISOString(), "alex");
      expect(checkoutSandboxOf(store, "/repo", [])).toEqual({ policy: 1, readDeny: ["~/.aws"], machLookup: [], unlock: [] });
    } finally { store.close(); }
  });

  test("native: a flow made now is v2 and the project's read denies apply to it; one made before 0.9.70 keeps v1", async ctx => {
    const { root, state, main, home, canary } = plane();
    const store = openStore(join(state, "orders.db"));
    try {
      if (!addApprover(store, "alex", T0).ok) throw new Error("bootstrap");
      for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "fixture", T0);
      const saved = saveScript(store, main, { name: "peek", about: "Reads", body: [canary.ssh, canary.aws].map(path => `if cat ${JSON.stringify(path)} >/dev/null 2>&1; then echo read; else echo denied; fi`).join("\n"), timeoutMinutes: 1 }, "alex", T0);
      if (!saved.ok) throw new Error(saved.message);
      const io: StepIo = { gh: vi.fn(), git: exec, shell: exec, fetch: vi.fn() as unknown as typeof fetch, dir: state, scratch: join(state, "worktrees", "flow-checks"), base: "main", home };
      const flowOf = () => store.createFlow({ repo: main, name: "Peek", by: "alex", definitionJson: JSON.stringify(flowFromSteps([{ title: "Inbox", kind: "inbox" }, { id: "peek", title: "Peek", kind: "check", script: "peek", runIn: "folder" }], null)) }, T0);
      const now = flowOf();
      const before = flowOf();
      // A flow saved before 0.9.70 has no policy (the migration leaves its row NULL).
      store.raw().prepare("UPDATE flow SET fence_policy = NULL WHERE id = ?").run(before);
      expect([store.flowFencePolicy(now), store.flowFencePolicy(before)]).toEqual([2, 1]);
      store.setProjectSandbox(main, { readDeny: ["~/.ssh"], machLookup: [], writeUnlock: [] }, "alex", T0);
      needs(ctx, osFence());
      const card = (flow: number) => store.addFlowCard({ flow, title: "Probe", description: null, stage: "peek", by: "alex", byKind: "person" }, T0);
      const [first, second] = [card(now), card(before)];
      await runFlowSteps(store, main, new Date(T0.getTime() + 60_000), io);
      // v2 with ~/.ssh listed: .ssh denied, .aws read. v1: both denied by name.
      expect(store.getFlowCard(first)!.outputs["peek"]).toBe("denied\nread");
      expect(store.getFlowCard(second)!.outputs["peek"]).toBe("denied\ndenied");
      void root;
    } finally { store.close(); }
  });
});
