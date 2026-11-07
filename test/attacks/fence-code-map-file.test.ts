/**
 * Attack (docs/plans/code-map.md §4): a build is given its code map as one exact file inside Toolroll's denied state
 * folder. It tries to change the file, replace it, move a folder above it, and read what sits beside it, under the real
 * fence, for the sandbox runtime (Claude) and for Codex. Guard: `exactFile` grants that path alone, read-only; the file
 * and its folders are outside every write, and nothing around it is read back.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { codexFenceArgv, fenceFor, flattened, runFolders, sandboxedSpawn, srtTermsOf, taskBoundary, trustedWorktreeBinding, writeAllowlist } from "../../src/agent-fence.js";
import { codexSandbox, git, needs, osFence, q, repository, useScratch, write } from "./harness.js";

const scratch = useScratch("code-map-file");

function plane(workspace: boolean) {
  const root = join(scratch(), workspace ? "workspace" : "anywhere");
  const home = join(root, "home"), state = join(root, "toolroll"), pool = join(state, "worktrees");
  mkdirSync(pool, { recursive: true }); mkdirSync(home, { recursive: true });
  write(join(state, "orders.db"), "db");
  const main = repository(join(root, "shop"));
  const worktree = join(pool, "shop", "task-1-0123abcd");
  git(main, "worktree", "add", "-q", "-b", "t1", worktree);
  const delivery = join(state, "code-map-delivery");
  const file = join(delivery, "7-1", "code-map.json"), sibling = join(delivery, "7-1", "sibling.txt"), other = join(delivery, "9-1", "code-map.json");
  for (const [path, text] of [[file, "MAP-BODY"], [sibling, "SIBLING-BODY"], [other, "OTHER-BODY"]] as const) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
  chmodSync(file, 0o444);
  const binding = trustedWorktreeBinding(main, worktree, [pool]);
  const allowed = workspace ? writeAllowlist({ provider: "command", home, worktree, binding, launchFolder: null, cache: null }) : null;
  const launch = fenceFor("build", { databaseFile: join(state, "orders.db"), worktree, home, binding, runFolders: runFolders(null), poolRoots: [pool], policy: 2, exactFile: file,
    boundary: taskBoundary({ worktree, provider: "command", home, binding, policy: 2 }), writes: allowed === null ? null : { writes: allowed.writes, readOnly: allowed.readOnly }, extra: allowed?.deny ?? [] });
  return { root, state, delivery, worktree, file, sibling, other, launch };
}

const probe = (at: ReturnType<typeof plane>): string => [
  `cat ${q(at.file)}; echo`,
  `cat ${q(at.sibling)} 2>/dev/null || echo sibling-denied`,
  `cat ${q(at.other)} 2>/dev/null || echo other-denied`,
  `chmod 644 ${q(at.file)} 2>/dev/null && echo chmod-done || echo chmod-refused`,
  `(echo x > ${q(at.file)}) 2>/dev/null && echo overwrite-done || echo overwrite-refused`,
  `rm -f ${q(at.file)} 2>/dev/null && echo unlink-done || echo unlink-refused`,
  `mv ${q(at.file)} ${q(`${at.file}.moved`)} 2>/dev/null && echo rename-done || echo rename-refused`,
  `mv ${q(dirname(at.file))} ${q(`${dirname(at.file)}-moved`)} 2>/dev/null && echo folder-done || echo folder-refused`,
  `mv ${q(at.delivery)} ${q(`${at.delivery}-moved`)} 2>/dev/null && echo ancestor-done || echo ancestor-refused`,
].join("\n");
const WANT = ["MAP-BODY", "sibling-denied", "other-denied", "chmod-refused", "overwrite-refused", "unlink-refused", "rename-refused", "folder-refused", "ancestor-refused"];

test("policy: exactly that file is read back, with no listing of its folder, and it is never written", () => {
  const at = plane(false);
  const { fence, fenceGrants: grants } = at.launch;
  const terms = srtTermsOf(fence, grants) as unknown as { allowRead?: string[]; denyRead?: string[] };
  expect(JSON.stringify(terms)).toContain(at.file);
  expect(JSON.stringify(terms)).not.toContain(`${JSON.stringify(dirname(at.file))}`);
  expect(grants.readOnly).toContain(at.file);
  const flat = flattened(fence, grants);
  expect(flat.readOnly).toContain(at.file);
  expect(flat.deny).toContain(at.sibling);
  expect(flat.deny).toContain(dirname(at.other));
});

describe.each([["a write allowlist", true], ["write anywhere", false]])("under %s", (_name, workspace) => {
  test("attack: the sandbox runtime (Claude's launch)", ctx => {
    needs(ctx, osFence());
    const at = plane(workspace);
    const fenced = sandboxedSpawn("/bin/sh", ["-c", probe(at)], at.launch.fence, at.launch.fenceGrants, at.worktree);
    const ran = spawnSync(fenced.file, fenced.args, { cwd: at.worktree, encoding: "utf8", env: { ...process.env, ...fenced.env }, timeout: 30_000 });
    expect(ran.stdout.trim().split("\n"), ran.stderr).toEqual(WANT);
  }, 60_000);
  test("attack: Codex's sandbox", ctx => {
    needs(ctx, codexSandbox());
    const at = plane(workspace);
    const home = join(at.root, "codex-home"); mkdirSync(home);
    const ran = spawnSync("codex", ["sandbox", ...codexFenceArgv(at.launch.fence, false, at.launch.fenceGrants), "-P", "standing-orders", "--", "/bin/sh", "-c", probe(at)],
      { cwd: at.worktree, encoding: "utf8", env: { ...process.env, CODEX_HOME: home }, timeout: 60_000 });
    expect(ran.stdout.trim().split("\n"), ran.stderr).toEqual(WANT);
  }, 90_000);
});
