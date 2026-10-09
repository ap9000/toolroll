/**
 * D5 (schema v117): one AI concept, the lead. The central team service (`connect`, the central `lead list|create|update|
 * member|transfer`, `conversation …`, and `chat`/`brief` with --lead, --conversation or a saved profile) and native
 * coding sessions (`session …`) are deprecated. For this release they still work exactly as before, but they are
 * hidden from help, the command contract and the console, and each run says so once on stderr — never on stdout, so a
 * `--json` answer stays one envelope. Their code goes in the next minor release.
 */

export type Deprecated = "team" | "session";

const NEXT_STEP: Record<Deprecated, string> = {
  team: "Talk to your lead with `toolroll chat`.",
  session: "Queue work with `toolroll task add`.",
};

/** The one line a deprecated command prints on stderr: what it is, when it goes, and what to use instead. */
export function deprecationWarning(command: string, kind: Deprecated): string {
  return `Warning: \`toolroll ${command}\` is deprecated and will be removed in the next minor release. ${NEXT_STEP[kind]}`;
}

/** What a deprecated console page or API says about itself. */
export const DEPRECATED_PAGE: Record<Deprecated, string> = {
  team: "Team chat is deprecated and will be removed in the next minor release. Your lead in Chat does the same work.",
  session: "Coding sessions are deprecated and will be removed in the next minor release. Queue work as a task instead.",
};
