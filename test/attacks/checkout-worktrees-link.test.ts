/**
 * Attack: plant an entry among the repository's worktree metadata (`.git/worktrees/`, which the build can write) so the
 * fence grants it: a symlink to ~/.toolroll that a read-only grant would follow, or a folder whose `gitdir` names a
 * fenced path so the checkout lookup lifts it. Guard: taskBoundary takes only plain folders by the names Git gave them,
 * and looks a checkout up only when that checkout's own `.git` names the entry back.
 */
import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { codexFenceArgv, linuxFenced } from "../../src/agent-fence.js";
import { codexSandbox, expectNoMarker, lines, marker, needs, plane, q, seatbelt, underCodex, underSeatbelt, useScratch, write } from "./harness.js";

describe("attack: a .git/worktrees symlink or planted entry becoming a grant", () => {
  const scratch = useScratch("wtlink");
  const setup = () => {
    const secret = marker("wtlink");
    const at = plane(scratch(), secret);
    const secrets = join(at.home, ".toolroll", "tool-secrets");
    const registry = join(at.main, ".git", "worktrees");
    symlinkSync(secrets, join(registry, "x"), "dir");
    write(join(registry, "y", "gitdir"), `${join(secrets, "t.json", ".git")}\n`);
    mkdirSync(join(registry, "z"));
    write(join(registry, "z", "gitdir"), `${join(at.home, ".ssh", ".git")}\n`);
    const genuine = ["sibling-4567cdef", "task-0123abcd-4567cdef"].map(name => join(registry, name));
    return { secret, at, secrets, registry, genuine };
  };
  // `stat` too under Seatbelt, which denies metadata with the read; Codex's policy is checked on the read alone.
  const probe = (secrets: string, genuine: string, stat: boolean) => [
    `cat ${q(join(secrets, "t.json"))} 2>/dev/null || echo secret-denied`,
    ...(stat ? [`stat ${q(join(secrets, "t.json"))} >/dev/null 2>&1 && echo stat-allowed || echo stat-denied`] : []),
    // Legitimate: a genuine sibling's metadata is still read, and the build's own Git works.
    `cat ${q(join(genuine, "HEAD"))} >/dev/null && echo sibling-metadata-read`,
    `(echo x >> ${q(join(genuine, "HEAD"))}) 2>/dev/null && echo sibling-metadata-written || echo sibling-metadata-readonly`,
    "git --no-optional-locks status --porcelain >/dev/null && echo status-ok",
  ].join("\n");
  const HELD = ["secret-denied", "stat-denied", "sibling-metadata-read", "sibling-metadata-readonly", "status-ok"];

  test("policy: planted entries grant nothing; only genuine siblings are read-only and looked up", () => {
    const { at, registry, genuine } = setup();
    for (const provider of ["claude", "codex"] as const) {
      const { boundary, fence, grants } = at.launch(provider);
      // Plain folders under the registry are only made read-only (they are the build's own .git); the link is never
      // followed, and nothing outside the registry is granted.
      // Beside them, the repository's own config and hooks, read-only for every build.
      expect(boundary.readOnly).toEqual([join(registry, "..", "config"), join(registry, "..", "hooks"), ...genuine, join(registry, "y"), join(registry, "z")].map(path => resolve(path)).sort());
      expect(boundary.readOnly.every(path => realpathSync(path) === path)).toBe(true);
      expect(boundary.lookup).toEqual([at.sibling, join(at.sibling, ".git"), at.prefixSibling, join(at.prefixSibling, ".git")].sort());
      expect(JSON.stringify(grants)).not.toContain(join(registry, "x"));
      expect(JSON.stringify(grants)).not.toContain("tool-secrets");
      expect(fence).toEqual(expect.arrayContaining([join(at.home, ".toolroll"), join(at.home, ".ssh")]));
    }
    const { fence, grants } = at.launch("codex");
    const table = codexFenceArgv(fence, false, grants).find(arg => arg.startsWith("permissions.standing-orders.filesystem="))!;
    expect(table).toContain(`${q(join(at.home, ".toolroll"))}="deny"`);
    expect(table).not.toContain("tool-secrets");
    const bwrap = linuxFenced("claude", [], fence, grants).args;
    expect(bwrap[bwrap.indexOf(join(at.home, ".toolroll")) - 1]).toBe("--tmpfs");
    expect(bwrap.join(" ")).not.toContain("tool-secrets");
  });

  test("native Seatbelt: the planted link's target stays unreadable; genuine sibling metadata is read but not written", ctx => {
    needs(ctx, seatbelt());
    const { secret, at, secrets, genuine } = setup();
    const { fence, grants } = at.launch("claude");
    const result = underSeatbelt(probe(secrets, genuine[0]!, true), fence, grants, { cwd: at.active });
    expectNoMarker(result, secret);
    expect(lines(result), result.stderr).toEqual(HELD);
  });

  test("native Codex: the planted link's target stays unreadable; genuine sibling metadata is read but not written", ctx => {
    needs(ctx, codexSandbox());
    const { secret, at, secrets, genuine } = setup();
    const { fence, grants } = at.launch("codex");
    const result = underCodex(probe(secrets, genuine[0]!, false), fence, false, grants, { cwd: at.active, codexHome: join(at.dir, "codex-home") });
    expectNoMarker(result, secret);
    expect(lines(result), result.stderr).toEqual(HELD.filter(line => line !== "stat-denied"));
  });
});
