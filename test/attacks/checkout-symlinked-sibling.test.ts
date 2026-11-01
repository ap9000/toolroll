/**
 * Attack: a symlink beside the project. An alias of the build's own repository (~/Developer/app -> the real one) once
 * fenced the build out of its own Git; an alias of ANOTHER repository must not hide that repository from the fence.
 * Guard: taskBoundary resolves every sibling with realpath before comparing: an alias of the build's own repository is
 * skipped, any other repository is fenced by its real path, whatever name reaches it.
 */
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { taskBoundary, trustedWorktreeBinding } from "../../src/agent-fence.js";
import { expectNoMarker, lines, marker, needs, ordinaryWork, plane, q, seatbelt, underSandbox, useScratch, write } from "./harness.js";

describe("attack: a symlinked sibling of main", () => {
  const scratch = useScratch("alias");
  const setup = () => {
    const secret = marker("alias");
    const at = plane(scratch(), secret);
    const projects = join(at.dir, "projects");
    write(join(projects, "other", "secret.txt"), secret);
    symlinkSync(at.main, join(projects, "app-alias"), "dir");
    symlinkSync(join(projects, "other"), join(projects, "zz-other-alias"), "dir");
    return { secret, at, projects };
  };

  test("policy: the alias of main is not fenced (its Git stays usable); another repository is fenced by its real path", () => {
    const { at, projects } = setup();
    for (const provider of ["claude", "codex"] as const) {
      const { fence } = at.launch(provider);
      expect(fence).toContain(join(projects, "other"));
      expect(fence).toContain(join(projects, "app-extra"));
      for (const own of [at.main, join(at.main, ".git"), join(projects, "app-alias"), join(projects, "zz-other-alias")]) expect(fence).not.toContain(own);
      // The primary checkout's work tree is fenced, all but its .git.
      expect(fence).toContain(join(at.main, "README.md"));
    }
    // The plane recorded the repository through an alias: the binding resolves it, and the fence is the same.
    const viaAlias = trustedWorktreeBinding(join(projects, "app-alias"), at.active, [at.pool]);
    expect(viaAlias.main).toBe(at.main);
    expect(taskBoundary({ worktree: at.active, provider: "claude", home: at.home, binding: viaAlias }).shell).toEqual(at.launch("claude").boundary.shell);
  });

  test("native Seatbelt: reading another repository through its alias is denied; the build's own Git works", ctx => {
    needs(ctx, seatbelt());
    const { secret, at, projects } = setup();
    const { fence, grants } = at.launch("claude");
    const work = ordinaryWork(at);
    const result = underSandbox([
      `cat ${q(join(projects, "zz-other-alias", "secret.txt"))} 2>/dev/null || echo alias-denied`,
      `cat ${q(join(projects, "other", "secret.txt"))} 2>/dev/null || echo other-denied`,
      work.script,
    ].join("\n"), fence, grants, { cwd: at.active });
    expectNoMarker(result, secret);
    expect(lines(result), result.stderr).toEqual(["alias-denied", "other-denied", ...work.expected]);
  });
});
