/**
 * Attack: a launch is told about project skills Toolroll wrote under its denied evidence root (a build, planner or
 * scout) or its state folder (a coding session). Before the fix the fence denied the whole folder, so an agent was
 * named files it could not read. Guard: each skill file in the plane's manifest is granted alone, read-only, after a
 * recheck of its path and bytes (skills-manifest.ts checkSkillsManifest, agent-fence.ts exactFiles); nothing beside it
 * is read, and nothing there is written. Run under the real sandbox runtime (Seatbelt on a Mac, bubblewrap on Linux)
 * and Codex's own sandbox (the profile a coding session gets).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { codexFenceArgv, codexFenceConfig, fenceFor, runFolders, sandboxedSpawn, taskBoundary, trustedWorktreeBinding, writeAllowlist, type LaunchFence } from "../../src/agent-fence.js";
import { codingSkillsManifest } from "../../src/coding-context.js";
import { codingSessionPermissions } from "../../src/coding-provider.js";
import { checkSkillsManifest, materializeProjectSkills, type SkillsManifest } from "../../src/project-skills.js";
import * as storage from "../../src/protected-storage.js";
import { openStore } from "../../src/store.js";
import { codexSandbox, git, marker, needs, osFence, q, repository, useScratch, write } from "./harness.js";

vi.mock("../../src/protected-storage.js", { spy: true });

const scratch = useScratch("skills");

/** A frozen selection of two packages, one with a resource, each file a canary of its own. */
function selection(tag: string) {
  const file = (path: string, text: string) => ({ path, base64: Buffer.from(text).toString("base64") });
  return { version: 1, revision: 1, identity: "fixture", inheritedFrom: null, test: false, packages: [
    { name: "copy", description: "Copy rules", sha: "a".repeat(64), requirements: [], warnings: [], files: [file("SKILL.md", `${tag}-copy-skill`), file("references/style.md", `${tag}-copy-style`)] },
    { name: "deploy", description: "Deploy steps", sha: "b".repeat(64), requirements: [], warnings: [], files: [file("SKILL.md", `${tag}-deploy-skill`)] },
  ] } as never;
}

type Plane = { root: string; worktree: string; manifest: SkillsManifest; canaries: Map<string, string>; others: Record<string, string>; skill: string; launch: LaunchFence };

/** A plane whose state folder is Toolroll's own, its skills written where the launch road writes them, and around them
 * what the agent must not reach: another run's skills and the evidence root's other entries. */
function plane(where: "evidence beside the database" | "evidence in ~/.toolroll", workspace: boolean): Plane {
  const root = join(scratch(), workspace ? "workspace" : "anywhere");
  const home = join(root, "home"), state = join(root, "toolroll"), pool = join(state, "worktrees");
  mkdirSync(pool, { recursive: true }); mkdirSync(home, { recursive: true });
  write(join(state, "orders.db"), "db");
  const evidence = where === "evidence beside the database" ? join(state, "evidence") : join(home, ".toolroll", "evidence");
  const main = repository(join(root, "shop"));
  const worktree = join(pool, "shop", "task-1-0123abcd");
  git(main, "worktree", "add", "-q", "-b", "t1", worktree);
  const tag = marker("skill");
  const own = materializeProjectSkills(selection(tag), evidence, "7");
  const other = materializeProjectSkills(selection(marker("other-run")), evidence, "9");
  const report = write(join(evidence, "run-9", "report.json"), marker("evidence"));
  const manifest = own.manifest!;
  const checked = checkSkillsManifest(manifest);
  if (!checked.ok) throw new Error(checked.problem);
  const binding = trustedWorktreeBinding(main, worktree, [pool]);
  const allowed = workspace ? writeAllowlist({ provider: "claude", home, worktree, binding, launchFolder: null, cache: null }) : null;
  const launch = fenceFor("build", { databaseFile: join(state, "orders.db"), worktree, home, binding, runFolders: runFolders(null), poolRoots: [pool], policy: 2, exactFiles: checked.files,
    boundary: taskBoundary({ worktree, provider: "claude", home, binding, policy: 2 }), writes: allowed === null ? null : { writes: allowed.writes, readOnly: allowed.readOnly }, extra: allowed?.deny ?? [] });
  const canaries = new Map(manifest.files.map(one => [one.path, readFileSync(one.path, "utf8")]));
  const skill = join(manifest.directory, "copy", "SKILL.md");
  return { root, worktree, manifest, canaries, skill, launch, others: { otherRun: other.manifest!.files[0]!.path, report, late: join(dirname(skill), "late.md"), linkOther: join(dirname(skill), "link-other.md"), linkReport: join(dirname(skill), "link-report.md") } };
}

/** What was planted after the grant was made: a sibling Toolroll never wrote, and links to what is denied. */
function plantLate(at: Plane): void {
  write(at.others.late!, marker("late"));
  symlinkSync(at.others.otherRun!, at.others.linkOther!);
  symlinkSync(at.others.report!, at.others.linkReport!);
}

const probe = (at: Plane): string => [
  ...at.manifest.files.map(one => `cat ${q(one.path)}; echo`),
  ...Object.entries(at.others).map(([name, path]) => `cat ${q(path)} 2>/dev/null && echo ${name}-read || echo ${name}-denied`),
  `ls ${q(dirname(at.skill))} >/dev/null 2>&1 && echo listed || echo list-denied`,
  `(echo x > ${q(join(dirname(at.skill), "new.md"))}) 2>/dev/null && echo create-done || echo create-refused`,
  `mkdir ${q(join(at.manifest.directory, "planted"))} 2>/dev/null && echo mkdir-done || echo mkdir-refused`,
  `(echo x >> ${q(at.skill)}) 2>/dev/null && echo append-done || echo append-refused`,
  `chmod 644 ${q(at.skill)} 2>/dev/null && echo chmod-done || echo chmod-refused`,
  `rm -f ${q(at.skill)} 2>/dev/null && echo unlink-done || echo unlink-refused`,
  `mv ${q(dirname(at.skill))} ${q(`${dirname(at.skill)}-moved`)} 2>/dev/null && echo rename-done || echo rename-refused`,
].join("\n");

/**
 * The real disk, read from outside the fence, decides. On Linux the sandbox hides a denied folder under an in-memory
 * filesystem and binds each granted file back, so creating or listing in there touches a throwaway stand-in: those
 * answers are accepted only on Linux, and only with the disk untouched.
 */
function held(at: Plane, said: string[]): void {
  const stub = process.platform === "linux";
  const want = [...at.canaries.values(), ...Object.keys(at.others).map(name => `${name}-denied`), "list-denied", "create-refused", "mkdir-refused", "append-refused", "chmod-refused", "unlink-refused", "rename-refused"];
  const stubbed = new Map([["listed", "list-denied"], ["create-done", "create-refused"], ["mkdir-done", "mkdir-refused"], ["rename-done", "rename-refused"]]);
  expect(said.map(line => stub ? stubbed.get(line) ?? line : line)).toEqual(want);
  for (const [path, text] of at.canaries) expect(readFileSync(path, "utf8")).toBe(text);
  for (const path of [join(dirname(at.skill), "new.md"), join(at.manifest.directory, "planted"), `${dirname(at.skill)}-moved`]) expect(existsSync(path), path).toBe(false);
  expect(checkSkillsManifest(at.manifest).ok).toBe(true);
}

describe.each([["evidence beside the database"], ["evidence in ~/.toolroll"]] as const)("a build's skills, %s", where => {
  test("policy: each manifest file is read alone and never written; its folder and the evidence root stay denied", () => {
    const at = plane(where, false);
    const { fence, fenceGrants: grants } = at.launch;
    expect(grants.exactFiles).toEqual(at.manifest.files.map(one => one.path));
    expect(grants.readOnly).toEqual(expect.arrayContaining(at.manifest.files.map(one => one.path)));
    for (const folder of at.manifest.folders) expect(grants.readable).not.toContain(folder);
    // Codex's profile: the files read by their own path, every folder around them still denied, none listed.
    const access = codexFenceConfig(fence, false, grants)["permissions.standing-orders.filesystem"] as Record<string, string>;
    for (const one of at.manifest.files) expect(access[one.path]).toBe("read");
    for (const [path, mode] of Object.entries(access)) if (at.manifest.folders.some(folder => path === folder || relative(path, folder).split("/")[0] !== "..")) expect(mode, path).toBe("deny");
  });

  describe.each([["a write allowlist", true], ["write anywhere", false]] as const)("under %s", (_name, workspace) => {
    test("attack: the sandbox runtime (a Claude build's launch)", ctx => {
      needs(ctx, osFence());
      const at = plane(where, workspace);
      const fenced = sandboxedSpawn("/bin/sh", ["-c", probe(at)], at.launch.fence, at.launch.fenceGrants, at.worktree);
      plantLate(at);
      const ran = spawnSync(fenced.file, fenced.args, { cwd: at.worktree, encoding: "utf8", env: { ...process.env, ...fenced.env }, timeout: 30_000 });
      held(at, ran.stdout.trim().split("\n"));
    }, 60_000);

    test("attack: Codex's sandbox (a Codex build in its own profile)", ctx => {
      needs(ctx, codexSandbox());
      const at = plane(where, workspace);
      const argv = codexFenceArgv(at.launch.fence, false, at.launch.fenceGrants);
      plantLate(at);
      const home = join(at.root, "codex-home"); mkdirSync(home);
      const ran = spawnSync("codex", ["sandbox", ...argv, "-P", "standing-orders", "--", "/bin/sh", "-c", probe(at)], { cwd: at.worktree, encoding: "utf8", env: { ...process.env, CODEX_HOME: home }, timeout: 60_000 });
      held(at, ran.stdout.trim().split("\n"));
    }, 90_000);
  });
});

const toml = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
/** A thread's config overrides as `codex sandbox` takes them (as coding-session-fence.test.ts does). */
function configArgv(config: Record<string, unknown>): string[] {
  return Object.entries(config).flatMap(([key, value]) => ["-c", `${key}=${typeof value === "string" ? toml(value) : typeof value === "boolean" ? String(value)
    : `{${Object.entries(value as Record<string, string>).map(([path, mode]) => `${toml(path)}=${toml(mode)}`).join(",")}}`}`]);
}

describe("a coding session's skills", () => {
  /** A session as serve.ts makes one: its skills in the state folder's coding-context, its worktree in coding-worktrees,
   * and the manifest read back from the saved capture as coding-workspace.ts does. */
  function session() {
    const root = scratch();
    const repo = repository(join(root, "shop"));
    const state = join(root, "toolroll"), sessions = join(state, "coding-worktrees");
    mkdirSync(sessions, { recursive: true });
    const store = openStore(join(state, "orders.db"));
    const own = join(sessions, "own");
    git(repo, "worktree", "add", "-q", "-b", "code-own", own);
    const context = join(state, "coding-context");
    const made = materializeProjectSkills(selection(marker("coding")), context, "coding");
    const other = materializeProjectSkills(selection(marker("other-session")), context, "coding");
    const report = write(join(state, "evidence", "report.json"), marker("evidence"));
    // The capture as prepareCodingContext saves it: its folder and each file relative to it, with its digest.
    const saved = { metadata: { directory: made.directory, files: made.manifest!.files.map(one => ({ path: relative(made.directory!, one.path), sha256: one.sha256 })) } } as never;
    const manifest = codingSkillsManifest(saved)!;
    return { root, repo, store, sessions, own, manifest, other: other.manifest!, report };
  }

  test("its manifest is the one materialize wrote", () => {
    const at = session();
    try {
      const written = materializeProjectSkills(selection("same"), join(at.root, "again"), "coding").manifest!;
      const back = codingSkillsManifest({ metadata: { directory: written.directory, files: written.files.map(one => ({ path: relative(written.directory, one.path), sha256: one.sha256 })) } } as never);
      expect(back).toEqual(written);
    } finally { at.store.close(); }
  });

  test("attack: its profile reads each skill file alone and writes none of them; a changed file refuses the session", async ctx => {
    needs(ctx, codexSandbox());
    // The storage check runs in its own child on a Mac, which this suite (no build step) doesn't have: run in-process.
    vi.mocked(storage.prepareProtectedStorage).mockImplementation(async home => {
      const here = storage.protectedStorageHere(home);
      return { names: here.names, denies: here.denies };
    });
    const at = session();
    try {
      const made = await codingSessionPermissions(at.store, at.sessions)({ repo: at.repo, worktree: at.own, skills: at.manifest });
      if (!("config" in made)) throw new Error(JSON.stringify(made));
      const skill = join(at.manifest.directory, "copy", "SKILL.md");
      const plane: Plane = { root: at.root, worktree: at.own, manifest: at.manifest, skill, launch: null as never,
        canaries: new Map(at.manifest.files.map(one => [one.path, readFileSync(one.path, "utf8")])),
        others: { otherRun: at.other.files[0]!.path, report: at.report, late: join(dirname(skill), "late.md"), linkOther: join(dirname(skill), "link-other.md"), linkReport: join(dirname(skill), "link-report.md") } };
      plantLate(plane);
      const home = join(at.root, "codex-home"); mkdirSync(home);
      const env = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: join(at.root, "home"), CODEX_HOME: home };
      const ran = spawnSync("codex", ["sandbox", ...configArgv(made.config), "-P", "standing-orders", "--", "/bin/sh", "-c", probe(plane)], { cwd: at.own, encoding: "utf8", env, timeout: 60_000 });
      held(plane, ran.stdout.trim().split("\n"));

      // A skill file swapped since it was written (here: for the other session's bytes) is never granted.
      const swapped: SkillsManifest = { ...at.manifest, files: at.manifest.files.map((one, index) => index === 0 ? { ...one, sha256: at.other.files[0]!.sha256 } : one) };
      expect(await codingSessionPermissions(at.store, at.sessions)({ repo: at.repo, worktree: at.own, skills: swapped })).toEqual({ problem: "A skill file changed after Toolroll prepared it, so the session was not started." });
    } finally { at.store.close(); }
  }, 90_000);
});
