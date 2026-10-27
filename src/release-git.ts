/**
 * The release coordinator's Git, as one hardened runner's pieces (docs/plans/chat-management.md §0a.2): the recorded
 * repository's shape, the programs by absolute path, the allowlisted environment, the fixed settings and the checkout
 * config allowlist. Kept apart from release-adapters.ts so the release card (release-card.ts) reads Git the same way
 * without loading the coordinator.
 */
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { HARDENED_GIT_ARGS } from "./agent-fence.js";
import { TEARDOWN_FLAGS } from "./teardown-git.js";

/**
 * The release's repository as Toolroll records it (docs/plans/chat-management.md §0a.2), never as the gate checkout
 * says: the checkout is one of the plane's recorded projects (by real path), its Git directory is that project's own
 * plain `.git` folder, and its GitHub `owner/name` and the URL fetched from come from the recorded remote
 * (`project.remote_url`), not the checkout's `origin`. The checkout is where the release check ran the build's own code,
 * so its `.git/config` is treated as build-written.
 */
export type ReleaseRepo = { checkout: string; gitDir: string; remote: string; slug: string; ssh: boolean };
/** The programs the coordinator runs, by absolute path, found once when it starts. */
export type ReleaseTools = { git: string; gh: string; ssh: string };

/** owner/name and transport of a recorded GitHub remote, read strictly (https or ssh to github.com, nothing else). */
export function releaseRemote(url: string): { slug: string; ssh: boolean } | null {
  const part = "([A-Za-z0-9_.-]+)";
  const https = new RegExp(`^https://github\\.com/${part}/${part}?(?:\\.git)?/?$`).exec(url);
  const ssh = new RegExp(`^(?:ssh://)?git@github\\.com[:/]${part}/${part}?(?:\\.git)?/?$`).exec(url);
  const match = https ?? ssh;
  if (match === null || match[2] === undefined || match[1]!.startsWith(".") || match[2].startsWith(".")) return null;
  return { slug: `${match[1]}/${match[2].replace(/\.git$/, "")}`, ssh: https === null };
}

const executable = (path: string): boolean => { try { accessSync(path, fsConstants.X_OK); return statSync(path).isFile(); } catch { return false; } };
/** Fixed system folders: the only PATH the coordinator's Git and gh run with. */
export const RELEASE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/** Git, gh and ssh by absolute path: the system's Git (or the first in the fixed system folders), the installed gh as
 * this process's PATH finds it now, and the system ssh. Resolved once; never looked up again. */
export function releaseTools(path: string = process.env["PATH"] ?? ""): ReleaseTools {
  const find = (name: string, dirs: readonly string[]): string | null => {
    for (const dir of dirs) { if (!isAbsolute(dir)) continue; const candidate = join(dir, name); if (executable(candidate)) return candidate; }
    return null;
  };
  const system = ["/usr/bin", "/bin", "/usr/local/bin", "/opt/homebrew/bin"];
  return {
    git: find("git", system) ?? "/usr/bin/git",
    gh: find("gh", [...path.split(delimiter), ...system]) ?? "/usr/bin/gh",
    ssh: find("ssh", ["/usr/bin", "/bin"]) ?? "/usr/bin/ssh",
  };
}

/** The coordinator's Git and gh environment: an allowlist, a fixed PATH, no system or global Git config, no prompts. */
export function releaseGitEnv(base: Readonly<NodeJS.ProcessEnv> = process.env): NodeJS.ProcessEnv {
  const kept = ["HOME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "USER", "LOGNAME", "SSH_AUTH_SOCK", "GH_CONFIG_DIR", "XDG_CONFIG_HOME", "GH_TOKEN", "GITHUB_TOKEN", "GH_HOST"];
  return {
    ...Object.fromEntries(kept.flatMap(name => base[name] === undefined ? [] : [[name, base[name]!]])),
    PATH: RELEASE_PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", GIT_ASKPASS: "", SSH_ASKPASS: "",
  };
}

/** Every coordinator Git command's fixed settings, ahead of its own arguments: the recorded Git directory and checkout,
 * no hooks, fsmonitor, replacement objects, pager or submodule recursion, only https (and ssh for an ssh remote), the
 * system ssh, and gh as the only credential helper. */
export function releaseGitArgs(repo: ReleaseRepo, tools: ReleaseTools): string[] {
  return [`--git-dir=${repo.gitDir}`, `--work-tree=${repo.checkout}`, "--no-replace-objects", "--no-pager", ...HARDENED_GIT_ARGS, ...TEARDOWN_FLAGS,
    "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", ...(repo.ssh ? ["-c", "protocol.ssh.allow=always"] : []),
    "-c", `core.sshCommand=${tools.ssh}`, "-c", "core.askPass=", "-c", "fetch.recurseSubmodules=false", "-c", "core.pager=cat",
    // Where it connects and what it sends: verified TLS, no proxy, no extra header or cookie file. (An empty CA file
    // or path can't be given here, Git then trusts nothing; a checkout setting either stops the release instead.)
    "-c", "http.sslVerify=true", "-c", "http.proxy=", "-c", "http.extraHeader=", "-c", "http.cookieFile=",
    // The recorded URL, as a remote that exists only here.
    "-c", `remote.${RELEASE_REMOTE}.url=${repo.remote}`, "-c", `remote.${RELEASE_REMOTE}.pushurl=${repo.remote}`, "-c", `remote.${RELEASE_REMOTE}.proxy=`,
    ...(repo.ssh ? [] : ["-c", `credential.helper=!'${tools.gh.replace(/'/g, "'\\''")}' auth git-credential`])];
}

/** The named remote the coordinator fetches, looks and pushes through: defined only on its own command line (`-c`), so
 * no checkout setting names or rewrites it. */
export const RELEASE_REMOTE = "toolroll-release";

/** The local and worktree settings a gate checkout may hold for a release (an allowlist): plain values Git writes
 * itself and that never decide where it connects, what it sends or what it runs. Anything else stops the release. */
const RELEASE_KEYS: readonly RegExp[] = [
  /^core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks|autocrlf|eol|safecrlf|quotepath|longpaths|checkstat|trustctime)$/,
  /^extensions\.(worktreeconfig|objectformat|refstorage)$/,
  /^remote\.[^/:\\]+\.(url|fetch|pushurl|tagopt|prune)$/,
  /^branch\..+\.(remote|merge|rebase|pushremote|description|vscode-merge-base)$/,
  /^(user\.(name|email)|pull\.(rebase|ff)|init\.defaultbranch|lfs\.repositoryformatversion)$/,
];

/** The first local or worktree setting a gate checkout's config holds that a release won't run with, or null: one
 * outside the allowlist (an include, a command, a proxy, TLS or header setting, a credential helper, a URL rewrite, a
 * hooks folder), a remote named like a URL or after the coordinator's own, or a remote over a transport helper. */
export function releaseConfigProblem(listing: string): string | null {
  const fields = listing.split("\0");
  for (let at = 0; at + 1 < fields.length; at += 2) {
    if (fields[at] !== "local" && fields[at] !== "worktree") continue;
    const entry = fields[at + 1]!;
    const newline = entry.indexOf("\n");
    const key = (newline < 0 ? entry : entry.slice(0, newline)).toLowerCase();
    const value = (newline < 0 ? "" : entry.slice(newline + 1)).trim();
    if (key.includes(RELEASE_REMOTE)) return key;
    if (key === "core.fsmonitor" && /^(false|no|off|0)$/i.test(value)) continue;
    if (!RELEASE_KEYS.some(pattern => pattern.test(key))) return key;
    if (/^remote\./.test(key) && /^[A-Za-z][A-Za-z0-9+.-]*::/.test(value)) return key;
  }
  return null;
}

