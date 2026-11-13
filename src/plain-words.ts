/** One vocabulary for the words Toolroll writes (docs/plans/plain-toolroll.md, "The words"): each row is a word or
 * phrase product copy never says, and what it says instead. Matching is by whole word and ignores case.
 *
 * Product copy is the text Toolroll writes. Preserved content (goals, requirements, notes, agent reports, issue text,
 * commit messages and the exact terms a consent shows) is never rewritten to satisfy this table. Code, the database,
 * `--json`, the agent contract and the audit page's hash detail keep their own words. */

export type PlainWord = { never: string; pattern: RegExp; say: string };

const row = (never: string, pattern: string, say: string): PlainWord => ({ never, pattern: new RegExp(`(?<![\\w-])(?:${pattern})(?![\\w-])`, "i"), say });

export const PLAIN_WORDS: readonly PlainWord[] = [
  row("scope", "scopes?|scoped", "plan"),
  row("contract", "contracts?", "plan"),
  // "Sign in", "signed in" and "signed out" are a person signing in, not an approval.
  row("signs", "signs|signed(?!\\s+(?:in|out|into)\\b)", "Approved by …"),
  row("sealed", "seal|seals|sealed|sealing", "approved"),
  row("binds", "binds?", "approved"),
  row("digest", "digests?", "(the plan version, in Details)"),
  row("worker", "workers?", "builder"),
  row("runner", "runners?", "builder"),
  row("daemon", "daemons?", "builder"),
  row("background service", "background service", "builder"),
  row("operator", "operators?|instance operator", "approver, or owner"),
  row("coordinator", "coordinators?", "your lead"),
  row("mate", "mate", "your lead"),
  row("scout", "scouts?|scouting|scouted", "research"),
  row("criterion", "criterion|criteria", "requirement"),
  row("evidence", "evidence", "requirement, or the saved files"),
  row("proof", "proofs?", "requirement"),
  row("verdict", "verdicts?", "requirement"),
  row("caveat", "caveats?", "requirement"),
  row("mark complete", "mark(?:ed|s|ing)?\\s+(?:it\\s+|this\\s+|that\\s+|them\\s+|the\\s+result\\s+)?complete", "Accept"),
  row("Accept and finish", "accept\\s+and\\s+finish", "Accept"),
  row("Revise", "revise", "Send back, or Request changes"),
  row("re-file", "re-?file[ds]?|re-?filing", "Send back, or Request changes"),
  row("Draft a repair task", "draft\\s+a\\s+repair\\s+task", "Send back"),
  row("put away", "put(?:s|ting)?\\s+(?:it\\s+|them\\s+|tasks\\s+|old\\s+tasks\\s+)?away", "Archive"),
  row("tidy", "tidy|tidied|tidying", "Archive"),
  row("run #N", "(?:run|attempt|result)\\s+#?\\d+", "build #N"),
  row("reconcile", "reconcile[ds]?|reconciling|reconciliation", "Waiting: Toolroll is …"),
  row("requeue", "requeue[ds]?|requeuing", "Waiting: Toolroll is …"),
  row("claim", "claim|claimed", "Waiting: Toolroll is …"),
  row("lease", "leases?|leased", "Waiting: Toolroll is …"),
  row("custody", "custody", "Waiting: Toolroll is …"),
  row("incident", "incidents?", "Waiting: Toolroll is …"),
  row("plane", "plane", "Toolroll"),
  row("fence", "fences?|fenced", "Waiting: Toolroll is …"),
  row("attested", "attest|attested|attestation", "Waiting: Toolroll is …"),
  row("receipt", "receipts?", "Waiting: Toolroll is …"),
  row("regate", "regate[ds]?", "Run checks"),
  row("carried", "carried|carry|carries", "Waiting: Toolroll is …"),
  row("incarnation", "incarnations?", "Waiting: Toolroll is …"),
  row("admission", "admission", "Waiting: Toolroll is …"),
  row("quiescence", "quiescen(?:ce|t)", "Waiting: Toolroll is …"),
  row("witness", "witness(?:es|ed)?", "Waiting: Toolroll is …"),
  row("unproven", "unproven", "Waiting: Toolroll is …"),
  // A plan version or digest written out: twelve or more hex characters. A short commit (seven) is fine.
  row("version hex", "(?=[0-9a-f]*\\d)(?=[0-9a-f]*[a-f])[0-9a-f]{12,64}", "(the plan version, in Details)"),
];

/** The words, for messages and tests. */
export const BANNED_WORDS: readonly string[] = PLAIN_WORDS.map(one => one.never);

/** Every banned word in `text`, as the table names it. */
export function bannedWordsIn(text: string): string[] {
  return PLAIN_WORDS.filter(one => one.pattern.test(text)).map(one => one.never);
}

/** Whether `text` says any word product copy never says. */
export const hasInternalWords = (text: string): boolean => PLAIN_WORDS.some(one => one.pattern.test(text));

/** A plan's version as Details shows it: a short handle, never the whole digest. */
export const planVersionWords = (digest: string): string => `Plan version ${digest.slice(0, 8)}`;

/** The first hour (docs: "four words in the first hour": task, approve, Ready, Complete or send back). Words a newcomer
 * never meets on the first-run surfaces (help, the welcome steps, the terminal UI's keys, how it works, the first-run
 * steps and the demo chat): they stay out of sight until sought. Not a global rule: the pages that own these features
 * say them, and so does any approval's terms, a password asked for where one is needed, or a reason something waits. */
export const FIRST_HOUR_WORDS: readonly PlainWord[] = [
  row("lead", "lead", "Toolroll, or Chat"),
  row("crew", "crew", "Toolroll"),
  row("scope", "scopes?|scoped", "plan"),
  row("mode", "modes?", "(Settings)"),
  row("flow", "flows?", "(Settings)"),
  row("fleet", "fleet", "(Settings)"),
  row("fallback", "fallbacks?", "(Settings)"),
  row("routing", "routing|routed", "(Settings)"),
  row("spend", "spend|spends|spending|spent", "cost"),
  row("MCP", "mcp", "(Settings)"),
  row("password", "passwords?|passwordless", "(only where one is asked for)"),
  row("token", "tokens?", "(Settings)"),
  row("builder", "builders?", "taking work"),
];

/** Every first-hour word in `text`, as the list names it. */
export function firstHourWordsIn(text: string): string[] {
  return FIRST_HOUR_WORDS.filter(one => one.pattern.test(text)).map(one => one.never);
}
