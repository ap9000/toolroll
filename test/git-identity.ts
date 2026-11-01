import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The identity a test's commits carry. */
export const TEST_GIT_NAME = "t";
export const TEST_GIT_EMAIL = "t@t";

/**
 * Git never guesses an identity from the host name (user.useConfigOnly): on macOS it would, on a Linux runner or
 * container it can't, so a test that forgot to set one passed on the Mac and failed in CI (0.9.76). Every test file's
 * fresh home starts with this alone (test/setup-state.ts); a test that commits asks for withGitIdentity.
 */
export const NO_GUESSED_IDENTITY = "[user]\n\tuseConfigOnly = true\n";

/**
 * Give a home (this test file's own, by default) a ~/.gitconfig with the test identity, where a real operator keeps
 * theirs: the plane's git carries it (carriedSettings). Hostname guessing stays off. Replaces any ~/.gitconfig there.
 */
export function withGitIdentity(home: string = homedir()): string {
  const path = join(home, ".gitconfig");
  writeFileSync(path, `[user]\n\tname = ${TEST_GIT_NAME}\n\temail = ${TEST_GIT_EMAIL}\n\tuseConfigOnly = true\n`);
  return path;
}
