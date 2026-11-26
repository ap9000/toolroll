/**
 * Attack: a launch is told about project skills Toolroll wrote under its evidence root (a build, planner or scout) or
 * its state folder's coding-context (a coding session). Before the fix the fence denied the whole folder, so an agent
 * was named files it could not read; and where the state folder has no Toolroll name, coding-context was not denied at
 * all. Guard: the skills folder is denied by path wherever it is (skills-manifest.ts skillsGrant, agent-fence.ts
 * RESERVED_STATE_FOLDERS), each file of the plane's manifest is granted alone, read-only, after a recheck of its path
 * and bytes, and an exact file that changed opens nothing (fenceFor refuses; every backend drops it). Run under the
 * real sandbox runtime (Seatbelt on a Mac, bubblewrap on Linux) and Codex's own sandbox (a coding session's profile).
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { codexFenceArgv, codexFenceConfig, ExactFileChanged, fenceFor, runFolders, sandboxedSpawn, taskBoundary, trustedWorktreeBinding, writeAllowlist, type LaunchFence } from "../../src/agent-fence.js";
import { codingSkillsManifest } from "../../src/coding-context.js";
import { codingSessionPermissions } from "../../src/coding-provider.js";
import { materializeProjectSkills, type SkillsManifest } from "../../src/project-skills.js";
import * as storage from "../../src/protected-storage.js";
import { checkSkillsManifest, skillsGrant } from "../../src/skills-manifest.js";
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

const LAYOUTS = [
  "evidence beside the database",
  "evidence in ~/.toolroll",
  // A state folder with no Toolroll name (`serve --db /srv/shared/orders.db`): only what is denied by path holds.
  "a shared state folder, evidence under another name",
] as const;
type Layout = typeof LAYOUTS[number];

type Plane = { root: string; worktree: string; manifest: SkillsManifest; canaries: Map<string, string>; others: Record<string, string>; skill: string; launch: LaunchFence;
  /** The grant again, as a launch would make it now (for the replacement attacks). */
  regrant: () => LaunchFence };

/** A plane whose skills are written where the launch road writes them, and around them what the agent must not reach:
 * another run's skills and the evidence root's other entries. The grant is made as runFence makes it (skillsGrant). */
function plane(where: Layout, workspace: boolean): Plane {
  const root = join(scratch(), workspace ? "workspace" : "anywhere");
  const shared = where === "a shared state folder, evidence under another name";
  const home = join(root, "home"), state = join(root, shared ? "projects-shared" : "toolroll"), pool = join(state, "worktrees");
  mkdirSync(pool, { recursive: true }); mkdirSync(home, { recursive: true });
  write(join(state, "orders.db"), "db");
  const evidence = where === "evidence beside the database" ? join(state, "evidence") : where === "evidence in ~/.toolroll" ? join(home, ".toolroll", "evidence") : join(state, "run-artifacts");
  const main = repository(join(root, "shop"));
  const worktree = join(pool, "shop", "task-1-0123abcd");
  git(main, "worktree", "add", "-q", "-b", "t1", worktree);
  const own = materializeProjectSkills(selection(marker("skill")), evidence, "7");
  const other = materializeProjectSkills(selection(marker("other-run")), evidence, "9");
  const report = write(join(evidence, "run-9", "report.json"), marker("evidence"));
  const manifest = own.manifest!;
  const binding = trustedWorktreeBinding(main, worktree, [pool]);
  const allowed = workspace ? writeAllowlist({ provider: "claude", home, worktree, binding, launchFolder: null, cache: null }) : null;
  const regrant = () => {
    const granted = skillsGrant({ root: evidence, manifest });
    return fenceFor("build", { databaseFile: join(state, "orders.db"), worktree, home, binding, runFolders: runFolders(null), poolRoots: [pool], policy: 2, evidenceRoot: evidence, exactFiles: granted.files, exactDigests: granted.digests, exactFolders: granted.folders,
      boundary: taskBoundary({ worktree, provider: "claude", home, binding, policy: 2 }), writes: allowed === null ? null : { writes: allowed.writes, readOnly: allowed.readOnly }, extra: [...allowed?.deny ?? [], ...granted.deny] });
  };
  const launch = regrant();
  const canaries = new Map(manifest.files.map(one => [one.path, readFileSync(one.path, "utf8")]));
  const skill = join(manifest.directory, "copy", "SKILL.md");
  return { root, worktree, manifest, canaries, skill, launch, regrant, others: { otherRun: other.manifest!.files[0]!.path, report, ...lateNames(skill) } };
}

const lateNames = (skill: string) => ({ late: join(dirname(skill), "late.md"), linkOther: join(dirname(skill), "link-other.md"), linkReport: join(dirname(skill), "link-report.md") });

/** What was planted after the grant was made: a sibling Toolroll never wrote, and links to what is denied. */
function plantLate(at: Pick<Plane, "others">): void {
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

/** Linux hides a denied folder under an in-memory filesystem and binds each granted file back: creating or listing in
 * there touches a throwaway stand-in. Those answers are accepted only there, and only with the disk untouched. */
const STUBBED = new Map([["listed", "list-denied"], ["create-done", "create-refused"], ["mkdir-done", "mkdir-refused"], ["rename-done", "rename-refused"]]);
const said = (out: string): string[] => out.trim().split("\n").map(line => process.platform === "linux" ? STUBBED.get(line) ?? line : line);

/** The real disk, read from outside the fence, decides. */
function held(at: Plane, out: string): void {
  const want = [...at.canaries.values(), ...Object.keys(at.others).map(name => `${name}-denied`), "list-denied", "create-refused", "mkdir-refused", "append-refused", "chmod-refused", "unlink-refused", "rename-refused"];
  expect(said(out)).toEqual(want);
  for (const [path, text] of at.canaries) expect(readFileSync(path, "utf8")).toBe(text);
  for (const path of [join(dirname(at.skill), "new.md"), join(at.manifest.directory, "planted"), `${dirname(at.skill)}-moved`]) expect(existsSync(path), path).toBe(false);
  expect(checkSkillsManifest(at.manifest).ok).toBe(true);
}

/** Ways a granted file can stop being the file Toolroll wrote. Each leads to `target`, which must never be read. */
const REPLACEMENTS = {
  "a granted file replaced by a link to another run's skill": (at: Plane) => {
    const target = at.others.otherRun!;
    renameSync(at.skill, `${at.skill}.gone`);
    symlinkSync(target, at.skill);
    return { read: at.skill, target, preBuiltCodexRace: true };
  },
  "a granted file replaced by a folder with files in it": (at: Plane) => {
    renameSync(at.skill, `${at.skill}.gone`);
    const target = write(join(at.skill, "inside.md"), marker("inside"));
    return { read: target, target, preBuiltCodexRace: true };
  },
  "an ancestor folder replaced by a link to another run's": (at: Plane) => {
    const folder = dirname(at.skill);
    renameSync(folder, `${folder}.gone`);
    symlinkSync(dirname(at.others.otherRun!), folder);
    return { read: at.skill, target: at.others.otherRun!, preBuiltCodexRace: true };
  },
  "a granted file rewritten in place with different bytes": (at: Plane) => {
    chmodSync(at.skill, 0o600);
    writeFileSync(at.skill, marker("rewritten-in-place"));
    return { read: at.skill, target: at.skill, preBuiltCodexRace: false };
  },
  "a granted file replaced by another run's regular file": (at: Plane) => {
    const copy = write(`${at.skill}.staged`, readFileSync(at.others.otherRun!, "utf8"));
    renameSync(copy, at.skill);
    return { read: at.skill, target: at.others.otherRun!, preBuiltCodexRace: false };
  },
} as const;

const fenced = (at: Plane, launch: LaunchFence, script: string): string => {
  const wrapped = sandboxedSpawn("/bin/sh", ["-c", script], launch.fence, launch.fenceGrants, at.worktree);
  return spawnSync(wrapped.file, wrapped.args, { cwd: at.worktree, encoding: "utf8", env: { ...process.env, ...wrapped.env }, timeout: 30_000 }).stdout;
};
const inCodexResult = (at: Plane, argv: string[], script: string) => {
  const home = join(at.root, `codex-home-${Math.random().toString(16).slice(2)}`); mkdirSync(home);
  return spawnSync("codex", ["sandbox", ...argv, "-P", "standing-orders", "--", "/bin/sh", "-c", script], { cwd: at.worktree, encoding: "utf8", env: { ...process.env, CODEX_HOME: home }, timeout: 60_000 });
};
const inCodex = (at: Plane, argv: string[], script: string): string => inCodexResult(at, argv, script).stdout;
const readOf = (path: string) => `cat ${q(path)} 2>/dev/null || echo read-denied`;

describe.each(LAYOUTS.map(one => [one]))("a build's skills, %s", where => {
  test("policy: each manifest file is read alone and never written; its folder and the evidence root stay denied", () => {
    const at = plane(where, false);
    const { fence, fenceGrants: grants } = at.launch;
    expect(grants.exactFiles).toEqual(at.manifest.files.map(one => one.path));
    expect(grants.exactRegular).toEqual(grants.exactFiles);
    expect(grants.readOnly).toEqual(expect.arrayContaining(at.manifest.files.map(one => one.path)));
    for (const folder of at.manifest.folders) expect(grants.readable).not.toContain(folder);
    expect(fence).toContain(dirname(at.manifest.directory));
    // Codex's profile: the files read by their own path, every folder around them still denied, none listed.
    const access = codexFenceConfig(fence, false, grants)["permissions.standing-orders.filesystem"] as Record<string, string>;
    for (const one of at.manifest.files) expect(access[one.path]).toBe("read");
    for (const [path, mode] of Object.entries(access)) if (at.manifest.folders.some(folder => path === folder || relative(path, folder).split("/")[0] !== "..")) expect(mode, path).toBe("deny");
  });

  test.each(Object.keys(REPLACEMENTS) as (keyof typeof REPLACEMENTS)[])("refused before launch: %s grants nothing", name => {
    const at = plane(where, false);
    REPLACEMENTS[name](at);
    // The recheck finds it, so nothing of this launch's skills is granted.
    expect(skillsGrant({ root: dirname(at.manifest.directory), manifest: at.manifest })).toMatchObject({ files: [], problem: expect.stringMatching(/changed after Toolroll prepared it/) });
    expect(at.regrant().fenceGrants.exactFiles ?? []).toEqual([]);
    // And fenceFor itself refuses the launch outright if handed it anyway (with its pinned digests & folders).
    expect(() => fenceFor("build", { databaseFile: null, worktree: null, boundary: null, binding: null, runFolders: runFolders(null), poolRoots: [], home: at.root, exactFiles: at.launch.fenceGrants.exactFiles!, exactDigests: at.launch.fenceGrants.exactDigests!, exactFolders: at.launch.fenceGrants.exactFolders! })).toThrow(ExactFileChanged);
  });

  test("custom evidence folder is denied by path for every launch kind, even with no skills", ctx => {
    needs(ctx, osFence());
    const at = plane(where, false);
    const customEvidence = dirname(at.manifest.directory);
    for (const kind of ["build", "command", "check", "flow", "tool-server"] as const) {
      const noSkills = fenceFor(kind, {
        databaseFile: join(at.root, where === "a shared state folder, evidence under another name" ? "projects-shared" : "toolroll", "orders.db"),
        worktree: kind === "tool-server" ? null : at.worktree,
        home: join(at.root, "home"),
        boundary: null,
        binding: null,
        runFolders: runFolders(null),
        poolRoots: [],
        policy: 2,
        evidenceRoot: customEvidence,
      });
      expect(noSkills.fence, kind).toContain(customEvidence);
      expect(fenced(at, noSkills, `${readOf(at.others.report!)}\n${readOf(at.skill)}`), kind).toBe("read-denied\nread-denied\n");
    }
  }, 60_000);

  describe.each([["a write allowlist", true], ["write anywhere", false]] as const)("under %s", (_name, workspace) => {
    test("attack: the sandbox runtime (a Claude build's launch)", ctx => {
      needs(ctx, osFence());
      const at = plane(where, workspace);
      const wrapped = sandboxedSpawn("/bin/sh", ["-c", probe(at)], at.launch.fence, at.launch.fenceGrants, at.worktree);
      plantLate(at);
      const ran = spawnSync(wrapped.file, wrapped.args, { cwd: at.worktree, encoding: "utf8", env: { ...process.env, ...wrapped.env }, timeout: 30_000 });
      held(at, ran.stdout);
    }, 60_000);

    test("attack: Codex's sandbox (a Codex build in its own profile)", ctx => {
      needs(ctx, codexSandbox());
      const at = plane(where, workspace);
      const argv = codexFenceArgv(at.launch.fence, false, at.launch.fenceGrants);
      plantLate(at);
      held(at, inCodex(at, argv, probe(at)));
    }, 90_000);
  });

  // The race after the recheck: replaced once the fence was made, re-checked at spawn (sandboxedSpawn + codexFenceArgv),
  // and even for an already-built Codex argv, nothing leaks and Codex's sandbox is proven to have run and denied it.
  test.for(Object.keys(REPLACEMENTS) as (keyof typeof REPLACEMENTS)[])("attack after the grant was made: %s opens nothing", (name, ctx) => {
    needs(ctx, osFence());
    const at = plane(where, false);
    const control = write(join(at.worktree, "control.txt"), marker("worktree-ok"));
    const controlText = readFileSync(control, "utf8");
    const preBuiltArgv = codexFenceArgv(at.launch.fence, false, at.launch.fenceGrants);
    const { read, target, preBuiltCodexRace } = REPLACEMENTS[name](at);
    const secret = readFileSync(target, "utf8");
    // The sandbox runtime re-checks path, ancestor folders and SHA-256 right at spawn: the changed entry is dropped.
    expect(fenced(at, at.launch, readOf(read))).toBe("read-denied\n");
    // Codex profile built at spawn also drops the tampered file by re-checking path, ancestor folders and SHA-256.
    const freshConfig = codexFenceConfig(at.launch.fence, false, at.launch.fenceGrants)["permissions.standing-orders.filesystem"] as Record<string, string>;
    expect(freshConfig[at.skill]).not.toBe("read");
    if (codexSandbox().available) {
      const freshArgv = codexFenceArgv(at.launch.fence, false, at.launch.fenceGrants);
      const probeScript = `cat ${q(control)}; echo; ${readOf(read)}`;
      const freshRun = inCodexResult(at, freshArgv, probeScript);
      expect(freshRun.status, freshRun.stderr).toBe(0);
      expect(freshRun.stdout).toBe(`${controlText}\nread-denied\n`);
      if (preBuiltCodexRace) {
        const raced = inCodexResult(at, preBuiltArgv, probeScript);
        expect(raced.status, raced.stderr).toBe(0);
        expect(raced.stdout).toBe(`${controlText}\nread-denied\n`);
        expect(raced.stdout).not.toContain(secret);
      }
    }
  }, 90_000);
});

const toml = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
/** A thread's config overrides as `codex sandbox` takes them (as coding-session-fence.test.ts does). */
function configArgv(config: Record<string, unknown>): string[] {
  return Object.entries(config).flatMap(([key, value]) => ["-c", `${key}=${typeof value === "string" ? toml(value) : typeof value === "boolean" ? String(value)
    : `{${Object.entries(value as Record<string, string>).map(([path, mode]) => `${toml(path)}=${toml(mode)}`).join(",")}}`}`]);
}

describe.each([["toolroll"], ["projects-shared"]] as const)("a coding session's skills, state folder %s", stateName => {
  /** A session as serve.ts makes one: its skills in the state folder's coding-context, its worktree in coding-worktrees,
   * and the manifest read back from the saved capture as coding-workspace.ts does. */
  function session() {
    const root = scratch();
    const repo = repository(join(root, "shop"));
    const state = join(root, stateName), sessions = join(state, "coding-worktrees");
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
  const inProcessStorage = () => vi.mocked(storage.prepareProtectedStorage).mockImplementation(async home => {
    // The storage check runs in its own child on a Mac, which this suite (no build step) doesn't have: run in-process.
    const here = storage.protectedStorageHere(home);
    return { names: here.names, denies: here.denies };
  });

  test("its manifest is the one materialize wrote", () => {
    const at = session();
    try {
      const written = materializeProjectSkills(selection("same"), join(at.root, "again"), "coding").manifest!;
      const back = codingSkillsManifest({ metadata: { directory: written.directory, files: written.files.map(one => ({ path: relative(written.directory, one.path), sha256: one.sha256 })) } } as never);
      expect(back).toEqual(written);
    } finally { at.store.close(); }
  });

  test("attack: its profile reads each skill file alone, nothing else in coding-context, and writes none of them", async ctx => {
    needs(ctx, codexSandbox());
    inProcessStorage();
    const at = session();
    try {
      const made = await codingSessionPermissions(at.store, at.sessions)({ repo: at.repo, worktree: at.own, skills: at.manifest });
      if (!("config" in made)) throw new Error(JSON.stringify(made));
      const skill = join(at.manifest.directory, "copy", "SKILL.md");
      const plane: Plane = { root: at.root, worktree: at.own, manifest: at.manifest, skill, launch: null as never, regrant: null as never,
        canaries: new Map(at.manifest.files.map(one => [one.path, readFileSync(one.path, "utf8")])),
        others: { otherRun: at.other.files[0]!.path, report: at.report, ...lateNames(skill) } };
      plantLate(plane);
      const home = join(at.root, "codex-home"); mkdirSync(home);
      const env = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: join(at.root, "home"), CODEX_HOME: home };
      const ran = spawnSync("codex", ["sandbox", ...configArgv(made.config), "-P", "standing-orders", "--", "/bin/sh", "-c", probe(plane)], { cwd: at.own, encoding: "utf8", env, timeout: 60_000 });
      held(plane, ran.stdout);
    } finally { at.store.close(); }
  }, 90_000);

  test("a session with no skills still can't read another session's", async ctx => {
    needs(ctx, codexSandbox());
    inProcessStorage();
    const at = session();
    try {
      const made = await codingSessionPermissions(at.store, at.sessions)({ repo: at.repo, worktree: at.own });
      if (!("config" in made)) throw new Error(JSON.stringify(made));
      const home = join(at.root, "codex-home"); mkdirSync(home);
      const ran = spawnSync("codex", ["sandbox", ...configArgv(made.config), "-P", "standing-orders", "--", "/bin/sh", "-c", `${readOf(at.other.files[0]!.path)}\n${readOf(at.manifest.files[0]!.path)}`],
        { cwd: at.own, encoding: "utf8", env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: join(at.root, "home"), CODEX_HOME: home }, timeout: 60_000 });
      expect(ran.stdout).toBe("read-denied\nread-denied\n");
    } finally { at.store.close(); }
  }, 90_000);

  test.each([
    ["rewritten in place", (path: string, other: string) => { chmodSync(path, 0o600); writeFileSync(path, readFileSync(other)); }],
    ["replaced by another session's file", (path: string, other: string) => { renameSync(other, path); }],
    ["replaced by a link", (path: string, other: string) => { renameSync(path, `${path}.gone`); symlinkSync(other, path); }],
    ["replaced by a folder", (path: string) => { renameSync(path, `${path}.gone`); write(join(path, "inside.md"), "inside"); }],
  ] as const)("a skill file %s refuses the session", async (_name, replace) => {
    inProcessStorage();
    const at = session();
    try {
      replace(at.manifest.files[0]!.path, at.other.files[0]!.path);
      expect(await codingSessionPermissions(at.store, at.sessions)({ repo: at.repo, worktree: at.own, skills: at.manifest })).toEqual({ problem: "A skill file changed after Toolroll prepared it, so the session was not started." });
    } finally { at.store.close(); }
  });
});
