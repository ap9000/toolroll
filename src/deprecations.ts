/**
 * D5 (schema v117): one AI concept, the lead. The central team service's CLI (the central `lead list|create|update|
 * member|transfer`, `conversation …`, and `chat`/`brief` with --lead, --conversation or a saved profile) and native
 * coding sessions (`session …`) were deprecated in 0.9.56 and are removed now: each answers with one line naming what
 * to use instead, changing nothing. `connect` stays — remote commands and `toolroll health` use the profile it saves.
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

const CENTRAL_LEAD_ACTIONS = ["list", "create", "update", "member", "transfer"];
const CENTRAL_CHAT_FLAGS = ["--profile", "--lead", "--conversation", "--authorize", "--terms-digest", "--request-id"];

/** The removed command an invocation names, as `{ named, kind }`; null when it is a live command. `chat`/`brief`
 * without --local went to the central service whenever a profile was saved (`savedProfile`, asked only then): that
 * invocation is removed too, never quietly run against this computer's lead instead. */
export function removedCommand(argv: readonly string[], savedProfile: () => boolean = () => false): { named: string; kind: Deprecated } | null {
  const [first, second] = argv;
  const verb = () => argv.slice(1).find(arg => !arg.startsWith("-")) ?? "";
  if (first === "session") return { named: `session ${verb()}`.trim(), kind: "session" };
  if (first === "conversation") return { named: `conversation ${verb()}`.trim(), kind: "team" };
  if (first === "lead" && second !== "token" && second !== "say" && argv.some(arg => arg === "--profile" || CENTRAL_LEAD_ACTIONS.includes(arg))) return { named: `lead ${verb()}`.trim(), kind: "team" };
  if ((first === "chat" || first === "brief") && argv.some(arg => CENTRAL_CHAT_FLAGS.includes(arg))) return { named: `${first} --conversation`, kind: "team" };
  if ((first === "chat" || first === "brief") && !argv.includes("--local") && savedProfile()) return { named: `${first} --conversation`, kind: "team" };
  return null;
}

/** The one line a removed command answers with. */
export function removedMessage(named: string, kind: Deprecated): string {
  return `\`toolroll ${named}\` was removed. ${NEXT_STEP[kind]}`;
}
