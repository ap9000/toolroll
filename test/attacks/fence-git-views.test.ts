/**
 * Attack: rewrite the plane's frozen view of a repository (Codex review of e48e9d8d). The plane's git on an
 * agent-written checkout runs against a private copy of the repository's config and info (teardown-git.ts gitView);
 * made in the system temp folder, a build that writes anywhere and outlived its turn could find it and plant a filter
 * in it between the inspection and the run. Guard: views are made under `~/.toolroll/git-views` (git-views.ts), which
 * every fence denies by name, made before any build launches; a view made after the fence was fixed is denied too.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { agentFence, codexFenceArgv, NO_GRANTS } from "../../src/agent-fence.js";
import { gitViewsRoot } from "../../src/git-views.js";
import { codexSandbox, lines, needs, osFence, q, underCodex, underSandbox, useScratch } from "./harness.js";

describe("attack: writing the plane's frozen git views from a build that writes anywhere", () => {
  const scratch = useScratch("gitviews");
  const setup = () => {
    const dir = scratch();
    const home = join(dir, "home");
    const worktree = join(dir, "app");
    mkdirSync(home, { recursive: true });
    mkdirSync(worktree, { recursive: true });
    const fence = agentFence({ databaseFile: null, worktree, home });
    // A view made after the fence was fixed, as the plane makes one while a build's process may still run.
    const view = join(gitViewsRoot(home), "write-later");
    mkdirSync(view, { recursive: true });
    writeFileSync(join(view, "config"), "[core]\n\tbare = false\n");
    return { dir, home, worktree, fence, view };
  };
  const script = (view: string) => [
    `printf '[filter "x"]\\n\\tclean = touch /tmp/ran\\n' >> ${q(join(view, "config"))} 2>/dev/null && echo config-written || echo config-denied`,
    `mkdir -p ${q(join(view, "info"))} 2>/dev/null; echo '* filter=x' > ${q(join(view, "info", "attributes"))} 2>/dev/null && echo attributes-written || echo attributes-denied`,
    `mkdir ${q(join(view, "..", "planted"))} 2>/dev/null && echo planted || echo plant-denied`,
    "echo mine > mine.txt && cat mine.txt",
  ].join("\n");

  test("policy: the views folder is made before any launch and fenced by name", () => {
    const { home, fence } = setup();
    expect(fence).toContain(gitViewsRoot(home));
    expect(existsSync(gitViewsRoot(home))).toBe(true);
    const table = codexFenceArgv(fence, false, NO_GRANTS).find(arg => arg.startsWith("permissions.standing-orders.filesystem="))!;
    expect(table).toContain(q(gitViewsRoot(home)));
  });

  test("native OS fence (writes anywhere): a view's config and info can't be written, nor a view planted", ctx => {
    needs(ctx, osFence());
    const { worktree, fence, view } = setup();
    const result = underSandbox(script(view), fence, NO_GRANTS, { cwd: worktree });
    expect(lines(result), result.stderr).toEqual(["config-denied", "attributes-denied", "plant-denied", "mine"]);
    expect(readFileSync(join(view, "config"), "utf8")).not.toContain("filter");
  });

  test("native Codex (full access and not): the same", ctx => {
    needs(ctx, codexSandbox());
    const { dir, worktree, fence, view } = setup();
    for (const fullAccess of [false, true]) {
      const result = underCodex(script(view), fence, fullAccess, NO_GRANTS, { cwd: worktree, codexHome: join(dir, "codex-home") });
      expect(lines(result), result.stderr).toEqual(["config-denied", "attributes-denied", "plant-denied", "mine"]);
    }
    expect(readFileSync(join(view, "config"), "utf8")).not.toContain("filter");
  });
});
