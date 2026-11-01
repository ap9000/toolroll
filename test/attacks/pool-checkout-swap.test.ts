/**
 * Attack: before a resume, the build replaces its own checkout with a symlink to a sibling task's checkout, so the
 * next launch of this task adopts (and is fenced around) the sibling's work. Guard: the sandbox runtime refuses removing
 * or moving the checkout's root (it holds names the runtime protects, so it is an ancestor of a deny); Codex leaves the folders above it read-only; and
 * trustedWorktreeBinding refuses a checkout whose recorded name resolves anywhere else, or that sits under a link.
 */
import { lstatSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { CheckoutBindingError, trustedWorktreeBinding } from "../../src/agent-fence.js";
import { codexSandbox, marker, needs, osFence, plane, q, underCodex, underSandbox, useScratch } from "./harness.js";

describe("attack: a build swapping its own checkout for a symlink to a sibling checkout before a resume", () => {
  const scratch = useScratch("swap");
  const setup = () => plane(scratch(), marker("swap"));
  const swap = (at: ReturnType<typeof plane>) => `cd / && rm -rf ${q(at.active)}; ln -s ${q(at.sibling)} ${q(at.active)}`;

  test("policy: the resume refuses a swapped checkout, and a project folder redirected to another, and binds the genuine one", () => {
    const at = setup();
    expect(trustedWorktreeBinding(at.main, at.active, [at.pool]).main).toBe(at.main);
    // A redirected project folder can't adopt the real registered checkout under another recorded name.
    symlinkSync(join(at.pool, "app"), join(at.pool, "redirect"));
    expect(() => trustedWorktreeBinding(at.main, join(at.pool, "redirect", "task-0123abcd"), [at.pool])).toThrow(CheckoutBindingError);
    rmSync(at.active, { recursive: true, force: true });
    symlinkSync(at.sibling, at.active);
    expect(() => trustedWorktreeBinding(at.main, at.active, [at.pool])).toThrow(CheckoutBindingError);
    expect(() => trustedWorktreeBinding(at.main, at.active)).toThrow(CheckoutBindingError);
    // The sibling itself is untouched and still binds as itself.
    expect(trustedWorktreeBinding(at.main, at.sibling, [at.pool]).gitdir).toBe(join(at.main, ".git", "worktrees", "sibling-4567cdef"));
  });

  test("native: the checkout root can't be replaced; the resume still refuses what is left", ctx => {
    needs(ctx, osFence());
    const at = setup();
    const { fence, grants } = at.launch("claude");
    underSandbox(swap(at), fence, grants, { cwd: at.active });
    expect(lstatSync(at.active).isDirectory()).toBe(true);
    // What deleting the contents left: the resumed launch binds the genuine checkout or refuses, never the sibling.
    let bound: string | null = null;
    try { bound = trustedWorktreeBinding(at.main, at.active, [at.pool]).gitdir; } catch (error) { expect(error).toBeInstanceOf(CheckoutBindingError); }
    if (bound !== null) expect(bound).toBe(join(at.main, ".git", "worktrees", "task-0123abcd"));
    // Legitimate: inside the checkout everything is still writable, as the deletion just showed.
    const work = underSandbox("mkdir -p a/b && echo ok > a/b/c && cat a/b/c", fence, grants, { cwd: at.active });
    expect(work.stdout.trim(), work.stderr).toBe("ok");
  });

  test("native Codex (Auto and Full): the checkout can't be replaced by a link, and the resume binds the genuine one", ctx => {
    needs(ctx, codexSandbox());
    for (const fullAccess of [false, true]) {
      const at = setup();
      const { fence, grants } = at.launch("codex");
      underCodex(swap(at), fence, fullAccess, grants, { cwd: at.active, codexHome: join(at.dir, "codex-home") });
      expect(lstatSync(at.active).isSymbolicLink()).toBe(false);
      // Codex keeps .git read-only, so the swap fails whole: the checkout is still the genuine one and binds as itself.
      expect(trustedWorktreeBinding(at.main, at.active, [at.pool]).gitdir).toBe(join(at.main, ".git", "worktrees", "task-0123abcd"));
      rmSync(at.dir, { recursive: true, force: true });
    }
  });
});
