/**
 * Attack: a fenced launch reading the operator's keychain (sandbox-runtime.ts SEATBELT_NO_KEYCHAIN). The sandbox
 * runtime's baseline lets every sandboxed process ask securityd (com.apple.SecurityServer, com.apple.securityd.xpc), so
 * it reads every keychain item whose access list lets any program read it, the login keychain's included
 * (anthropics/sandbox-runtime#755). Only a build's agent keeps it (Claude Code signs in from the keychain); a check (one
 * with sign-ins too: those come in its environment, read outside, invoke.ts keychainSignIns), a build's own commands, a
 * flow and a tool server (one made from a build's grants too) are denied both services, last in the profile.
 *
 * The canary is a synthetic item in a throwaway keychain this test makes and deletes, outside the sandbox; the
 * operator's own keychains are never read or written. Positive control: a build's launch reads the canary.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { fenceFor, runFolders, serverGrantsOf, signInGrants, srtTermsOf, taskBoundary, trustedWorktreeBinding, type FenceGrants, type FenceKind } from "../../src/agent-fence.js";
import { SEATBELT_NO_KEYCHAIN, SEATBELT_QUIET_MACH_DENY, srtMacosCommand } from "../../src/sandbox-runtime.js";
import { git, needs, repository, seatbelt, underSandbox, useScratch } from "./harness.js";

const scratch = useScratch("keychain");

function launches() {
  const root = scratch();
  const state = join(root, "toolroll");
  const pool = join(state, "worktrees");
  const main = repository(join(root, "shop"));
  const worktree = join(pool, "shop", "task-1-0123abcd");
  git(main, "worktree", "add", "-q", "-b", "t1", worktree);
  const home = join(root, "home");
  const binding = trustedWorktreeBinding(main, worktree, [pool]);
  return { root, home, worktree, launch: (kind: FenceKind, machLookup?: string[]) => fenceFor(kind, { databaseFile: join(state, "orders.db"), worktree, home, binding, runFolders: runFolders(null), poolRoots: [pool], policy: 2,
    boundary: taskBoundary({ worktree, provider: "command", home, binding, policy: 2 }), ...(machLookup === undefined ? {} : { machLookup }) }) };
}

describe("attack: the keychain from inside the fence", () => {
  test("policy: only a build's agent reaches securityd; every other launch, a tool server made from a build's grants too, is denied it last", () => {
    const { root, home, worktree, launch } = launches();
    const profile = (grants: FenceGrants, fence: string[]) => srtMacosCommand("/usr/bin/true", [], srtTermsOf(fence, grants), root);
    const build = launch("build");
    expect(build.fenceGrants.keychain).toBe(true);
    expect(profile(build.fenceGrants, build.fence)).not.toContain(SEATBELT_NO_KEYCHAIN);
    // A check with sign-ins, as invoke.ts launches one: its sign-in files and network added, never the keychain.
    const check = launch("check");
    const signIns = { ...check, fenceGrants: { ...check.fenceGrants, signIns: signInGrants(home, worktree), network: { mode: "open" as const } } };
    const others = [...(["command", "check", "flow", "tool-server"] as const).map(kind => [kind, launch(kind)] as const), ["server from a build", { ...build, fenceGrants: serverGrantsOf(build.fenceGrants) }] as const,
      ["check with sign-ins", signIns] as const];
    // Nothing in the launch code hands a check the keychain (invoke.ts composes a sign-ins check's grants).
    expect(readFileSync(join(import.meta.dirname, "../../src/invoke.ts"), "utf8")).not.toMatch(/keychain:\s*true/);
    for (const [name, fence] of others) {
      expect(fence.fenceGrants.keychain, name).toBeUndefined();
      const command = profile(fence.fenceGrants, fence.fence);
      expect(command.split(SEATBELT_NO_KEYCHAIN), name).toHaveLength(2);
      expect(/^\n' \/\S+ -c /.test(command.slice(command.indexOf(SEATBELT_NO_KEYCHAIN) + SEATBELT_NO_KEYCHAIN.length)), name).toBe(true);
    }
  });

  test("native: a synthetic keychain item is read by a build's launch, and by no other", ctx => {
    needs(ctx, seatbelt());
    const { root, launch } = launches();
    const keychain = join(root, "canary.keychain-db");
    const canary = `synthetic-keychain-canary-${randomBytes(6).toString("hex")}`;
    const security = (...args: string[]) => spawnSync("/usr/bin/security", args, { encoding: "utf8", timeout: 30_000 });
    expect(security("create-keychain", "-p", "throwaway", keychain).status).toBe(0);
    try {
      expect(security("unlock-keychain", "-p", "throwaway", keychain).status).toBe(0);
      // Any program may read it (-A): the shape of item the runtime's baseline leaves within reach.
      expect(security("add-generic-password", "-a", "toolroll-attack", "-s", "toolroll-attack", "-w", canary, "-A", keychain).status).toBe(0);
      const read = `/usr/bin/security find-generic-password -a toolroll-attack -s toolroll-attack -w ${JSON.stringify(keychain)}; echo "exit:$?"`;
      const build = launch("build");
      const allowed = underSandbox(read, build.fence, build.fenceGrants, { cwd: root });
      expect(allowed.stdout, allowed.stderr).toContain(canary);
      for (const kind of ["command", "check", "flow", "tool-server"] as const) {
        const fence = launch(kind);
        const denied = underSandbox(read, fence.fence, fence.fenceGrants, { cwd: root });
        expect(denied.stdout, kind).not.toContain(canary);
        expect(denied.stderr).not.toContain(canary);
        expect(denied.stdout).not.toContain("exit:0");
      }
      const server = underSandbox(read, build.fence, serverGrantsOf(build.fenceGrants), { cwd: root });
      expect(server.stdout).not.toContain(canary);
    } finally { security("delete-keychain", keychain); }
  });
  // macOS 26.5: a reported mach-lookup denial now and then never answers (npm hung in Node's DNS setup), so a lookup the
  // profile doesn't allow is denied unreported, first after the default deny. Still denied; every allow after it wins.
  test("policy: an unallowed mach service is denied unreported, before every allow; the keychain deny is unreported too", () => {
    const { root, launch } = launches();
    for (const kind of ["build", "check", "flow"] as const) {
      const fence = launch(kind);
      const command = srtMacosCommand("/usr/bin/true", [], srtTermsOf(fence.fence, fence.fenceGrants), root);
      expect(command.split(SEATBELT_QUIET_MACH_DENY), kind).toHaveLength(2);
      const quiet = command.indexOf(SEATBELT_QUIET_MACH_DENY);
      expect(command.lastIndexOf("(deny default", quiet), kind).toBe(command.indexOf("(deny default"));
      expect(command.indexOf("(allow "), kind).toBeGreaterThan(quiet);
    }
    expect(SEATBELT_NO_KEYCHAIN).toContain("(deny mach-lookup (with no-report) ");
  });

  test("native: a check still can't reach a mach service it isn't allowed (DNS configuration); a project's grant still reaches it", ctx => {
    needs(ctx, seatbelt());
    const { root, launch } = launches();
    const dns = "/usr/sbin/scutil --dns; echo \"exit:$?\"";
    const denied = underSandbox(dns, launch("check").fence, launch("check").fenceGrants, { cwd: root });
    expect(denied.stdout, denied.stderr).toContain("No DNS configuration available");
    const granted = launch("check", ["com.apple.SystemConfiguration.DNSConfiguration"]);
    const allowed = underSandbox(dns, granted.fence, granted.fenceGrants, { cwd: root });
    expect(allowed.stdout, allowed.stderr).toContain("resolver #");
  });
});
