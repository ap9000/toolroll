/**
 * Attack: reach another checkout under the plane's state folder: another project's worktree, a sibling task of the
 * same project, a project whose name starts with this one's (`app-extra` beside `app`), a sibling whose name starts
 * with this checkout's, or a project made after launch. Guard: fenceGrants denies every checkout pool whole and gives
 * back only this build's own checkout (Seatbelt: subpath deny then own allow; Codex: launch-time siblings denied one by
 * one, the folders between read-only; bubblewrap: tmpfs mask then a bind of the own checkout).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { codexFenceArgv, linuxFenced, macosFenced, macosFenceProfile } from "../../src/agent-fence.js";
import { poolRootOf } from "../../src/worktree.js";
import { codexSandbox, expectNoMarker, lines, marker, needs, ordinaryWork, plane, q, seatbelt, underCodex, useScratch, write, type Plane } from "./harness.js";

const filesystem = (argv: string[]): Map<string, string> => {
  const table = argv.find(arg => arg.startsWith("permissions.standing-orders.filesystem="))!;
  return new Map([...table.matchAll(/("(?:[^"\\]|\\.)*")=("(?:read|write|deny)")/g)].map(match => [JSON.parse(match[1]!) as string, JSON.parse(match[2]!) as string]));
};

describe("attack: another project's worktree under the state folder (incl. a same-project sibling and a prefix-named project)", () => {
  const scratch = useScratch("pool");
  const setup = () => {
    const secret = marker("pool");
    return { secret, at: plane(scratch(), secret) };
  };
  const others = (at: Plane) => [at.theirs, at.sibling, at.prefixSibling, at.prefixed];
  /** Made after the policy was built: no launch-time listing could name it. */
  const later = (at: Plane, secret: string) => write(join(at.pool, "late", "task-fedcba98", "secret.txt"), secret);
  const probe = (at: Plane, late: boolean) => [
    ...others(at).map((path, index) => `cat ${q(join(path, "secret.txt"))} 2>/dev/null || echo other-${index}-unreadable`),
    `(echo x > ${q(join(at.theirs, "planted.txt"))}) 2>/dev/null && echo other-written || echo other-unwritable`,
    `ls ${q(join(at.pool, "other"))} >/dev/null 2>&1 && echo pool-listed || echo pool-unlisted`,
    ...(late ? [`cat ${q(join(at.pool, "late", "task-fedcba98", "secret.txt"))} 2>/dev/null || echo later-unreadable`] : []),
  ].join("\n");
  const held = (late: boolean) => [0, 1, 2, 3].map(index => `other-${index}-unreadable`).concat(["other-unwritable", "pool-unlisted"], late ? ["later-unreadable"] : []);

  test("policy: the pool is denied whole and only the own checkout given back, whatever names start like it", () => {
    const { at } = setup();
    expect(poolRootOf(at.active, at.main)).toBe(at.pool);
    // A prefix-named project's checkout is not this project's, so it names no pool of its own for this build.
    expect(poolRootOf(at.prefixed, at.main)).toBeNull();
    const { fence, grants } = at.launch("claude");
    expect(grants.pool).toMatchObject({ deny: [at.pool], own: at.active, lookup: [at.pool, join(at.pool, "app")] });
    const profile = macosFenceProfile(fence, grants).split("\n");
    const first = profile.indexOf(`(deny file-read* file-write* (subpath ${q(at.pool)}))`);
    // After the baseline and the base read/write allows; before every other deny.
    expect(profile.slice(0, first).some(line => line.startsWith("(deny file"))).toBe(false);
    expect(profile.slice(first, first + 3)).toEqual([
      `(deny file-read* file-write* (subpath ${q(at.pool)}))`,
      `(allow file-read* file-write* (subpath ${q(at.active)}))`,
      `(deny file-write* (literal ${q(at.active)}))`,
    ]);
    // Seatbelt's subpath matches whole path components, so the prefix sibling stays under the pool deny.
    expect(profile.filter(line => line.startsWith("(allow") && line.includes(q(at.prefixSibling)) && !line.startsWith("(allow file-read-metadata"))).toEqual([]);
    const bwrap = linuxFenced("claude", [], fence, grants).args;
    expect(bwrap.slice(0, 8)).toEqual(["--dev-bind", "/", "/", "--tmpfs", at.pool, "--bind", at.active, at.active]);
    for (const fullAccess of [false, true]) {
      const codex = filesystem(codexFenceArgv(at.launch("codex").fence, fullAccess, at.launch("codex").grants));
      expect(codex.get(at.active)).toBe("write");
      expect(codex.get(at.pool)).toBe("read");
      expect(codex.get(join(at.pool, "app"))).toBe("read");
      for (const path of [join(at.pool, "other"), join(at.pool, "app-extra"), at.sibling, at.prefixSibling]) expect(codex.get(path), path).toBe("deny");
    }
  });

  test("native Seatbelt: every other checkout, and a project made after launch, is out of reach; the own checkout works", ctx => {
    needs(ctx, seatbelt());
    const { secret, at } = setup();
    const { fence, grants } = at.launch("claude");
    const work = ordinaryWork(at);
    const { file, args } = macosFenced("/bin/sh", ["-c", `${probe(at, true)}\n${work.script}`], fence, grants);
    later(at, secret);
    const result = spawnSync(file, args, { cwd: at.active, encoding: "utf8", env: { ...process.env, NODE_OPTIONS: undefined } });
    expectNoMarker(result, secret);
    expect(lines(result), result.stderr).toEqual([...held(true), ...work.expected]);
    expect(existsSync(join(at.theirs, "planted.txt"))).toBe(false);
  });

  test("native Codex (Auto and Full): every launch-time checkout is out of reach; the own checkout works", ctx => {
    needs(ctx, codexSandbox());
    const { secret, at } = setup();
    const work = ordinaryWork(at);
    for (const fullAccess of [false, true]) {
      const { fence, grants } = at.launch("codex");
      const result = underCodex(`${probe(at, false)}\n${work.script}`, fence, fullAccess, grants, { cwd: at.active, codexHome: join(at.dir, "codex-home") });
      expectNoMarker(result, secret);
      expect(lines(result), result.stderr).toEqual([...held(false), ...work.expected]);
    }
    expect(existsSync(join(at.theirs, "planted.txt"))).toBe(false);
  });
});
