/**
 * The answers that need nothing but this file: `--version` and the top-level
 * usage. The bin asks here before importing the CLI, so neither loads the
 * store, the contracts or a single command family. main() asks here too, so
 * both roads print the same bytes.
 */

import { HELP } from "./cli-help.js";
import { PACKAGE_VERSION } from "./version.js";

/** Exactly the invocations whose whole answer is top-level usage — anything more goes through the CLI. */
const HELP_INVOCATIONS: ReadonlySet<string> = new Set(["--help", "-h", "help"]);

/** The line to print and exit 0 with, or null when the CLI has to run. */
export function quickAnswer(argv: readonly string[]): string | null {
  if (argv[0] === "--version" || argv[0] === "-v") return PACKAGE_VERSION;
  if (argv.length === 1 && HELP_INVOCATIONS.has(argv[0] as string)) return HELP;
  return null;
}
