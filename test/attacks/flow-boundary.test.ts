/**
 * Attack: a flow's setup, script or trigger reaching what the agents' fence keeps from a build (docs/plans/sandbox-
 * parity.md C1). Flows used to get only the state-folder deny, with no checkout-pool, launch-folder or boundary rules,
 * and ran bare where no OS fence applied. Now each flow launch takes its fence from fenceFor ("flow"), marked
 * required: Toolroll's state, another run's launch folder and another checkout in the pool stay unreadable from all
 * three; where nothing can confine it, nothing runs and the card says so; a flow nothing sealed at v2 keeps the v1
 * home-configuration denies. The legitimate path beside it: the script reads its input and writes its own folder.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { checkLaunchRoot, codexFenceArgv, fenceFor, linuxFenced, macosFenced, macosFenceProfile, runFolders, sealedScratch, taskBoundary, trustedWorktreeBinding } from "../../src/agent-fence.js";
import { nativeSeccomp } from "../seccomp-fixture.js";
import { CONTAINMENT_REFUSED_CODE, run as exec } from "../../src/exec.js";
import { flowLaunch } from "../../src/flow-code.js";
import { saveScript } from "../../src/flow-scripts.js";
import { runFlowSteps, type StepIo } from "../../src/flow-steps.js";
import { addFlowTriggerTo, checkFlowTriggerNow, type TriggerIo } from "../../src/flow-triggers.js";
import { flowFromSteps } from "../../src/flows.js";
import { addApprover } from "../../src/scope.js";
import { openStore, type Store } from "../../src/store.js";
import { git, marker, needs, repository, osFence, useScratch, write } from "./harness.js";

const T0 = new Date("2026-10-24T09:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const scratch = useScratch("flow-boundary");

let root: string, state: string, repo: string, pool: string, store: Store, otherRun: string;
const canary: Record<"state" | "run" | "pool" | "scratch", { path: string; secret: string }> = {} as never;
beforeEach(() => {
  root = scratch();
  // Toolroll's own state folder (a dedicated name, fenced whole), its checkout pool inside it, and a project beside.
  state = join(root, "toolroll");
  pool = join(state, "worktrees");
  mkdirSync(pool, { recursive: true });
  repo = repository(join(root, "shop"), { "README.md": "Shop\n" });
  store = openStore(join(state, "orders.db"));
  for (const phase of ["build", "plan", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "fixture", T0);
  if (!addApprover(store, "alex", T0).ok) throw new Error("bootstrap");
  const plant = (label: string, path: string) => ({ path: write(path, marker(label)), secret: "" });
  canary.state = plant("flow-state", join(state, "up-login.txt"));
  canary.pool = plant("flow-pool", join(pool, "other-project", "task-1-0123abcd", "secret.txt"));
  // Another flow's scratch folder in the pool (its inputs and outputs): never readable, whatever the policy.
  canary.scratch = plant("flow-scratch", join(pool, "flow-checks", "flow-check-99-1", "output.txt"));
  // Another launch's private folder, where the run folders live (a check's on a Mac is /private/tmp).
  otherRun = realpathSync(mkdtempSync(join(checkLaunchRoot(), "so-cmd-")));
  canary.run = plant("flow-run", join(otherRun, "broker-token"));
  for (const one of Object.values(canary)) one.secret = execFileSync("cat", [one.path], { encoding: "utf8" });
});
afterEach(() => { store.close(); rmSync(otherRun, { recursive: true, force: true }); });

/** A probe that reports, per canary, whether it could be read: `<name>:read` or `<name>:denied`; and whether the other
 * pool checkout could be written (`pool-write:written` or `pool-write:denied`). */
const probe = () => [...Object.entries(canary).map(([name, one]) => `if cat ${JSON.stringify(one.path)} >/dev/null 2>&1; then echo ${name}:read; else echo ${name}:denied; fi`),
  `if echo planted >> ${JSON.stringify(canary.pool.path)} 2>/dev/null; then echo pool-write:written; else echo pool-write:denied; fi`].join("\n");
/** A flow made now runs under fence policy v2: another task's checkout is read (agents can work together), never
 * written; Toolroll's state and other runs' folders stay unreadable. */
const EXPECTED: Record<string, "read" | "denied"> = { state: "denied", run: "denied", pool: "read", scratch: "denied" };
const stepIo = (extra: Partial<StepIo> = {}): StepIo => ({ gh: vi.fn(), git: exec, shell: exec, fetch: vi.fn() as unknown as typeof fetch, dir: state, scratch: join(pool, "flow-checks"), base: "main", home: join(root, "home"), ...extra });
const flowOf = (steps: Parameters<typeof flowFromSteps>[0]) => store.createFlow({ repo, name: "Upkeep", definitionJson: JSON.stringify(flowFromSteps(steps, null)), by: "alex" }, T0);
const save = (name: string, body: string) => { const saved = saveScript(store, repo, { name, about: "Probes", body, timeoutMinutes: 1 }, "alex", T0); if (!saved.ok) throw new Error(saved.message); };

describe("attack: a flow reaching past the agents' fence", () => {
  test("setup and a script in a copy of the card's work can't read the state or another run's folder, nor write another pool checkout; the script still reads its input and writes its folder", async ctx => {
    needs(ctx, osFence());
    // The approved setup records what it could read, inside the copy (its own folder, which it may write).
    store.setWorktreeSetup({ repo, command: `{ ${probe().replace(/\n/g, "; ")}; } > setup-result.txt`, timeoutMs: 60_000, approvedBy: "alex" }, T0);
    save("peek", ['sed "s/^/setup-/" setup-result.txt', probe(), 'grep -q Probe "$FLOW_INPUT" && echo input:read', "echo made > own-file && echo folder:written"].join("\n"));
    const flow = flowOf([{ title: "Inbox", kind: "inbox" }, { id: "peek", title: "Peek", kind: "check", script: "peek", runIn: "copy" }]);
    const card = store.addFlowCard({ flow, title: "Probe", description: null, stage: "peek", by: "alex", byKind: "person" }, T0);
    await runFlowSteps(store, repo, at(1), stepIo());
    const output = store.getFlowCard(card)!.outputs["peek"] ?? store.getFlowCard(card)!.note ?? "";
    for (const name of Object.keys(canary)) {
      expect(output, output).toContain(`setup-${name}:${EXPECTED[name]}`);
      expect(output).toContain(`\n${name}:${EXPECTED[name]}`);
    }
    expect(output).toContain("setup-pool-write:denied");
    expect(output).toContain("\npool-write:denied");
    expect(output).toContain("input:read");
    expect(output).toContain("folder:written");
    for (const one of [canary.state, canary.run, canary.scratch]) expect(output).not.toContain(one.secret);
    // Positive control: unsandboxed, the same reads succeed (the canaries are real, readable files).
    for (const one of Object.values(canary)) expect(execFileSync("cat", [one.path], { encoding: "utf8" })).toBe(one.secret);
  });

  test("a schedule's script (no checkout) can't read them either", async ctx => {
    needs(ctx, osFence());
    save("issues", [probe(), 'grep -q trigger "$FLOW_INPUT" && echo input:read'].join("\n").replace(/echo ([\w:-]+)/g, 'echo "{\\"title\\": \\"$1\\", \\"key\\": \\"$1\\"}"'));
    const flow = flowOf([{ title: "Inbox", kind: "inbox" }]);
    const made = addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "schedule", schedule: "every 2 hours", script: "issues" }, "alex", T0, state);
    if (!made.ok) throw new Error(made.message);
    const tio: TriggerIo = { gh: exec, fetch, dir: state, shell: exec, scratch: join(state, "flow-scratch"), home: join(root, "home") };
    const checked = await checkFlowTriggerNow(store, store.flowTriggers(flow)[0]!, at(3), tio);
    expect(checked, checked.said).toMatchObject({ ok: true });
    const titles = store.flowCards(flow, true).map(one => one.title).sort();
    // Its folder isn't in the pool: the pool stays inside the fenced state folder for it, unreadable.
    expect(titles).toEqual(["input:read", "pool-write:denied", "pool:denied", "run:denied", "scratch:denied", "state:denied"]);
  });

  test("native: a build under v2 reads a sibling task's checkout, never a flow's scratch folder in the pool", async ctx => {
    needs(ctx, osFence());
    const worktree = join(pool, "shop", "task-2-89abcdef");
    git(repo, "worktree", "add", "-q", "-b", "t2", worktree);
    const binding = trustedWorktreeBinding(repo, worktree, [pool]);
    const home = join(root, "home");
    const launch = fenceFor("build", { databaseFile: join(state, "orders.db"), worktree, home, binding, runFolders: runFolders(null), poolRoots: [pool], policy: 2,
      boundary: taskBoundary({ worktree, provider: "command", home, binding, policy: 2 }) });
    const script = [canary.pool.path, canary.scratch.path].map(path => `if cat ${JSON.stringify(path)} >/dev/null 2>&1; then echo read; else echo denied; fi`).join("\n");
    const wrapped = process.platform === "darwin" ? macosFenced("/bin/sh", ["-c", script], launch.fence, launch.fenceGrants)
      : linuxFenced("/bin/sh", ["-c", script], launch.fence, { ...launch.fenceGrants, seccomp: nativeSeccomp()! });
    expect(execFileSync(wrapped.file, wrapped.args, { cwd: worktree, encoding: "utf8" }).trim().split("\n")).toEqual(["read", "denied"]);
  });

  test("a scratch folder made after the launch, or planted as a link, is denied too (never only when it was there at launch)", async ctx => {
    rmSync(join(pool, "flow-checks"), { recursive: true, force: true });
    const worktree = join(pool, "shop", "task-2-89abcdef");
    git(repo, "worktree", "add", "-q", "-b", "t2", worktree);
    const binding = trustedWorktreeBinding(repo, worktree, [pool]);
    const home = join(root, "home");
    const launch = fenceFor("build", { databaseFile: join(state, "orders.db"), worktree, home, binding, runFolders: runFolders(null), poolRoots: [pool], policy: 2,
      boundary: taskBoundary({ worktree, provider: "command", home, binding, policy: 2 }) });
    // Named whether there or not (on Linux, where only what exists can be masked, made first, owner-only).
    expect(launch.fenceGrants.pool?.sealed).toContain(join(realpathSync(pool), "flow-checks"));
    expect(macosFenceProfile(launch.fence, launch.fenceGrants)).toContain(`(deny file-read* file-write* (subpath "${join(realpathSync(pool), "flow-checks")}"))`);
    expect(codexFenceArgv(launch.fence, false, launch.fenceGrants).join(" ")).toContain(`"${join(realpathSync(pool), "flow-checks")}"="deny"`);
    if (process.platform === "linux") expect(statSync(join(pool, "flow-checks")).mode & 0o777).toBe(0o700);
    // A link at the name: denied by name and where it leads.
    const elsewhere = join(root, "elsewhere-scratch");
    mkdirSync(elsewhere);
    const linkedPool = join(root, "pool-2");
    mkdirSync(linkedPool);
    symlinkSync(elsewhere, join(linkedPool, "flow-checks"));
    expect(sealedScratch([linkedPool], [])).toEqual([join(realpathSync(linkedPool), "flow-checks"), realpathSync(elsewhere)].sort());
    needs(ctx, osFence());
    const late = join(pool, "flow-checks", "flow-check-7-1", "output.txt");
    const script = `sleep 1; if cat ${JSON.stringify(late)} >/dev/null 2>&1; then echo read; else echo denied; fi`;
    const wrapped = process.platform === "darwin" ? macosFenced("/bin/sh", ["-c", script], launch.fence, launch.fenceGrants)
      : linuxFenced("/bin/sh", ["-c", script], launch.fence, { ...launch.fenceGrants, seccomp: nativeSeccomp()! });
    const child = spawn(wrapped.file, wrapped.args, { cwd: worktree, stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", chunk => { out += chunk; });
    // Made after the launch started.
    write(late, marker("late-scratch"));
    await new Promise(done => child.on("close", done));
    expect(out.trim()).toBe("denied");
    expect(execFileSync("cat", [late], { encoding: "utf8" })).toMatch(/^synthetic-attack-/);
  });

  test("where nothing can confine it, neither setup nor script runs, and the card and the trigger say why", async () => {
    const shell = vi.fn(exec);
    store.setWorktreeSetup({ repo, command: "true", timeoutMs: 60_000, approvedBy: "alex" }, T0);
    save("peek", "echo ran");
    const flow = flowOf([{ title: "Inbox", kind: "inbox" }, { id: "peek", title: "Peek", kind: "check", script: "peek", runIn: "folder", ifFails: "Inbox" }]);
    const card = store.addFlowCard({ flow, title: "Probe", description: null, stage: "peek", by: "alex", byKind: "person" }, T0);
    await runFlowSteps(store, repo, at(1), stepIo({ shell, fenceAvailable: () => false }));
    expect(shell).not.toHaveBeenCalled();
    expect(store.getFlowCard(card)!.note).toMatch(/can't confine the flow's script/);
    const made = addFlowTriggerTo(store, store.getFlow(flow)!, { kind: "schedule", schedule: "every 2 hours", script: "peek" }, "alex", T0, state);
    if (!made.ok) throw new Error(made.message);
    const checked = await checkFlowTriggerNow(store, store.flowTriggers(flow)[0]!, at(3), { gh: exec, fetch, dir: state, shell, scratch: join(state, "flow-scratch"), home: join(root, "home"), fenceAvailable: () => false });
    expect(checked).toMatchObject({ ok: false });
    expect(checked.said).toMatch(/can't confine the flow's script/);
    expect(shell).not.toHaveBeenCalled();
  });

  test("a flow nothing sealed at v2 keeps v1's home-configuration denies (never widened implicitly)", async ctx => {
    const home = join(root, "home");
    const key = write(join(home, ".ssh", "id_ed25519"), marker("flow-home"));
    const folder = join(pool, "flow-checks", "run-1");
    mkdirSync(folder, { recursive: true });
    const launch = flowLaunch(store, { repo, folder, scratch: join(pool, "flow-checks"), copy: false, home, available: () => true });
    if (launch === null || "problem" in launch) throw new Error("no launch");
    try {
      expect(launch.fence!.fence).toContain(realpathSync(join(home, ".ssh")));
      needs(ctx, osFence());
      const read = await exec("/bin/cat", [key], { cwd: folder, ...launch.fence! });
      expect(read.code).not.toBe(0);
      // Positive control: unsandboxed, the key is a readable file.
      expect((await exec("/bin/cat", [key])).code).toBe(0);
    } finally { launch.dispose(); }
  });

  test("a fence not made by fenceFor (no required mark) runs nothing, on either spawn road", async () => {
    const plain = await exec("/bin/cat", [canary.state.path], { fence: [state] });
    expect(plain).toMatchObject({ code: CONTAINMENT_REFUSED_CODE, stdout: "" });
    const grouped = await exec("/bin/cat", [canary.state.path], { fence: [state], processGroup: true });
    expect(grouped.code).not.toBe(0);
    expect(grouped.stdout).not.toContain(canary.state.secret);
  });
});
