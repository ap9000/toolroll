/**
 * The identity an agent's own commits carry in a thread's or a Direct Chat's copy of a project: the project's
 * `user.name` and `user.email` as git would pick them there (the repository's own config, then the person's global
 * file), read as those two values only, else a neutral Toolroll identity, each half on its own. Never derived from the
 * account name, the host name, $EMAIL or any other environment: git's own fallback for a repository with no identity
 * is `<account>@<host>.local`, which put the computer's name in every commit a thread's agent made.
 *
 * - The repository's values come through the shared hardened runner (a view of its config, refused when it includes a
 *   file or names a command), as `config --local --list`: one file, so no include is followed. A refusal or a failed
 *   read is the caller's refusal, never a quiet neutral identity.
 * - The global values come from the person's own global files (git's XDG file, then ~/.gitconfig, which wins), read as
 *   plain files with includes off, no system config and nothing run. A file that can't be read gives nothing.
 * - A value holding a character no copied command may (local-landing.ts unsafeInCommand: C0/C1 controls, line and
 *   paragraph separators, bidi marks and invisible formatting characters), `<` or `>`, or over 200 characters, counts
 *   as unset: checked on the value as read, before trimming.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { run } from "./exec.js";
import type { Runner } from "./worktree.js";
import { hardenedGit, refusal } from "./teardown-git.js";
import { unsafeInCommand } from "./local-landing.js";

export type GitIdentity = { name: string; email: string };
type Values = { name: string | null; email: string | null };

/** A thread's agent's commits when the project names no identity. */
export const THREAD_IDENTITY: GitIdentity = Object.freeze({ name: "Toolroll thread", email: "thread@toolroll.local" });
/** A Direct Chat's commits when the project names no identity (its own Save/Ship snapshot always uses it). */
export const DIRECT_CHAT_IDENTITY: GitIdentity = Object.freeze({ name: "Toolroll Direct Chat", email: "direct-chat@toolroll.local" });

const plain = (value: string | undefined): string | null => {
  if (value === undefined || unsafeInCommand(value) || /[<>]/.test(value)) return null;
  const trimmed = value.trim();
  return trimmed !== "" && trimmed.length <= 200 ? trimmed : null;
};

/** The last `user.name` and `user.email` of a `git config --list -z` listing (no scopes), each only when plain. */
export function identityValues(listing: string): Values {
  let name: string | undefined, email: string | undefined;
  for (const entry of listing.split("\0")) {
    const newline = entry.indexOf("\n");
    if (newline < 0) continue;
    const key = entry.slice(0, newline).toLowerCase();
    if (key === "user.name") name = entry.slice(newline + 1);
    else if (key === "user.email") email = entry.slice(newline + 1);
  }
  return { name: plain(name), email: plain(email) };
}

/** The person's global identity values: git's XDG file, then ~/.gitconfig (which wins), each read on its own. */
function globalValues(home: string, env: Readonly<Record<string, string | undefined>>): Values {
  const xdg = env["XDG_CONFIG_HOME"];
  const files = [join(xdg !== undefined && isAbsolute(xdg) ? xdg : join(home, ".config"), "git", "config"), join(home, ".gitconfig")];
  const found: Values = { name: null, email: null };
  for (const file of files) {
    if (!existsSync(file)) continue;
    const ran = spawnSync("git", ["config", "--file", file, "--no-includes", "--list", "-z"], {
      cwd: "/", encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1_048_576,
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LANG: "C" },
    });
    if (ran.status !== 0) continue;
    const values = identityValues(ran.stdout);
    found.name = values.name ?? found.name;
    found.email = values.email ?? found.email;
  }
  return found;
}

/** The identity from the repository's own listing (`config --local --list -z`), then the global files, then `neutral`. */
export function identityFrom(localListing: string, neutral: GitIdentity, home: string = homedir(), env: Readonly<Record<string, string | undefined>> = process.env): GitIdentity {
  const local = identityValues(localListing);
  const global = local.name !== null && local.email !== null ? { name: null, email: null } : globalValues(home, env);
  return { name: local.name ?? global.name ?? neutral.name, email: local.email ?? global.email ?? neutral.email };
}

/** The project's identity for an agent's commits in its copy, or why its repository couldn't be read. */
export async function projectGitIdentity(repo: string, neutral: GitIdentity, inner: Runner = run): Promise<{ ok: true; identity: GitIdentity } | { ok: false; why: string }> {
  const ran = await hardenedGit(inner, "read", { repo })("git", ["config", "--local", "--list", "-z"], { cwd: repo, timeoutMs: 60_000 });
  const refused = refusal(ran);
  if (refused !== null) return { ok: false, why: refused };
  if (ran.code !== 0) return { ok: false, why: "its git config couldn't be read" };
  return { ok: true, identity: identityFrom(ran.stdout, neutral) };
}

/** The environment that fixes both the author and the committer, over any config or $EMAIL. */
export function identityEnv(identity: GitIdentity): Record<string, string> {
  return { GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email, GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email };
}
