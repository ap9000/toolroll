/**
 * The oldest git Toolroll runs on (README, Requirements): the global `git --attr-source` option every hardened read
 * takes arrived in git 2.41 (others in use are older: `worktree list -z` 2.36, GIT_CONFIG_COUNT and `--path-format`
 * 2.31). On git older than 2.45, which lacks `--no-lazy-fetch`, partial clones are refused for protected reads
 * (teardown-git.ts lazyFetchSupported), every protected read runs through a frozen view and refuses every transport,
 * and nothing leans on GIT_NO_LAZY_FETCH, which 2.41.0 ignores. The CI git lanes test this floor's oldest release
 * exactly, 2.41.0, and 2.47 (.github/workflows/ci.yml, scripts/ci-git.sh).
 */
import { spawnSync } from "node:child_process";

export const GIT_FLOOR = { major: 2, minor: 41 } as const;
export const GIT_FLOOR_WORDS = `${GIT_FLOOR.major}.${GIT_FLOOR.minor}`;

/** The version `git --version` names ("git version 2.50.1 (Apple Git-155)" → 2.50.1), or null when it names none. */
export function parseGitVersion(text: string): { major: number; minor: number; words: string } | null {
  const found = /^git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(text.trim());
  return found === null ? null : { major: Number(found[1]), minor: Number(found[2]), words: `${found[1]}.${found[2]}${found[3] === undefined ? "" : `.${found[3]}`}` };
}

/** Where a newer git than this computer's comes from, as install.sh says it: on Linux the distribution's own is often the
 * old one (Ubuntu 22.04's is 2.34, Debian 12's 2.39), so it points past it. */
export function newerGitHow(platform: NodeJS.Platform = process.platform): string {
  if (platform === "linux") return "get one from https://git-scm.com/downloads/linux (Ubuntu: `sudo add-apt-repository ppa:git-core/ppa && sudo apt update && sudo apt install git`)";
  if (platform === "darwin") return "`brew install git`, or update Xcode's Command Line Tools in Software Update";
  return "get one from https://git-scm.com/downloads";
}

/** Why `version` (`git --version`'s answer) is below the floor, with how to get a newer one, or null when it isn't (or
 * can't be read). */
export function gitFloorWords(versionText: string, platform: NodeJS.Platform = process.platform): string | null {
  const version = parseGitVersion(versionText);
  if (version === null) return null;
  if (version.major > GIT_FLOOR.major || (version.major === GIT_FLOOR.major && version.minor >= GIT_FLOOR.minor)) return null;
  return `Toolroll needs git ${GIT_FLOOR_WORDS} or newer, and this machine's git is ${version.words}. Install a newer git (and put it first on PATH): ${newerGitHow(platform)}. Then start Toolroll again.`;
}

let probed: string | null | undefined;
/** The installed git's floor problem, asked once per process with no system or global config; null when git is new
 * enough, or when no version could be read (a missing git is reported where it is used). */
export function installedGitFloorProblem(): string | null {
  if (probed === undefined) {
    const answer = spawnSync("git", ["--version"], { cwd: "/", encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"],
      env: { PATH: process.env["PATH"] ?? "", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", HOME: "/nonexistent" } });
    probed = answer.status === 0 ? gitFloorWords(answer.stdout ?? "") : null;
  }
  return probed;
}
