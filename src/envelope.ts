/**
 * The machine envelope — the one shape every `--json` answer takes.
 *
 * Agents branch on this output ten thousand times a night, so the contract
 * is versioned and deliberately dull: `envelopeVersion` first, then `ok`,
 * then `command`, then whatever the command has to say. Failures add a
 * stable `reason` token and a human `message`. Nothing else about the
 * shape is promised, and consumers are told to ignore keys they do not
 * recognize — that is what lets the envelope grow without breaking anyone.
 *
 * Every emission in the CLI routes through `envelopeJson` (a source-level
 * test enforces it), which is also what makes `-o <file>` possible: the
 * entry point asks this module for the last envelope written and copies it
 * to the file, so an agent never has to scrape a terminal.
 */

export const ENVELOPE_VERSION = 1;

/**
 * Feature detection for agent consumers, Claude-`system/init` style:
 * a bounded list of protocol behaviors this build honors. Consumers must
 * ignore values they do not recognize. Behaviors, not versions — an agent
 * should ask "can I rely on stable reasons", never "is this 0.1.2".
 */
export const CAPABILITIES: readonly string[] = [
  "envelope/1", //          every --json answer is one versioned envelope on stdout
  "stable-reasons", //      failure `reason` is a token that survives rewording
  "idempotency-keys", //    every mutation takes --key; retries return the first answer
  "exit-codes/0-1-2-3", //  0 ok · 1 broke · 2 usage · 3 ran fine, answer is no
  "output-file", //         -o <file> writes the same envelope to a file
  "command-schema/1", //    contract --commands dumps the declared command guide
  "skill-guides/1", //      skills list / skills get serve version-matched guides
  "session-client/1", //    typed operator transport; query the service for actual availability
];

/**
 * DOCUMENTED reasons — the curated vocabulary the command guide's
 * `notableReasons` may cite. Deliberately named for what it is: a list of
 * tokens that are DOCUMENTED, not a proof of runtime exhaustiveness (the
 * runtime `reason` field remains the truth; consumers branch on tokens
 * and ignore ones they do not recognize). A test ties every entry to a
 * literal in the source so a typo cannot ship.
 */
export const DOCUMENTED_REASONS: readonly string[] = [
  "usage", //             the invocation itself was malformed
  "database-busy", //     another writer held the selected database for the full wait
  "unknown-task", //      the named task does not exist
  "timeout", //           task wait reached its caller-supplied deadline
  "failed", //            the watched attempt or task failed
  "needs-person", //      the task reached a decision or approval only a person can provide
  "unknown-skill", //     the named guide does not exist (skills get)
  "unconfirmed", //       a preview answered; add --yes to apply
  "foreign-file", //      an installer target exists but is not managed by it
  "not-an-approver", //   the credential offered does not authenticate
  "held", //              somebody else holds it
  "fenced", //            a newer lease superseded yours — stop
  "claimed", //           already being worked
  "unapproved", //        no person has agreed to the scope yet
  "reserved", //          the task belongs to another worker's queue
  "external", //          a tracker mirror is not dispatchable (see detail)
  "provider-unattested", // the provider binary is outside its attested range
  "daily-runs", //        the active mode's daily run cap is spent
  "daily-dollars", //     the active mode's daily measured-spend rail is reached
  "not-ready", //         blocked, held, or otherwise not dispatchable
  "not-leased", //        the lease does not exist or already ended
  "not-yours", //         held or reserved by someone else
  "no-op", //             nothing to do — an answer, not an error
  "duplicate", //         the identity already exists
  "empty", //             nothing matched
  "quota", //             a budget or cap refused the act
  "not-a-repo", //        the path has no .git
  "stale-approval", //    what would run no longer matches what was approved
  "profile-unresolved", // the scope cannot say exactly what would run — restate it
  "repair-attempts-spent", // the chain's signed attempt cap is spent
  "repair-no-progress", // two consecutive repair attempts failed to shrink the unresolved set
  "repair-refused-integrity", // a refutation named an altered term, not a gap — no automatic repair
];

export type EnvelopePayload = {
  ok: boolean;
  command: string;
  [key: string]: unknown;
};

let captured: string | null = null;
let captureHook: ((body: string) => void) | null = null;

/** The entry point's early-flush hook (arc 2): for long-running commands,
 * `-o` lands the startup envelope the moment it exists. The hook must not
 * throw — the entry point's own hook catches internally. */
export function onEnvelopeCaptured(hook: ((body: string) => void) | null): void {
  captureHook = hook;
}

/** Serialize one envelope, remembering it for `-o` teeing at the entry point. */
export function envelopeJson(payload: EnvelopePayload): string {
  const body = JSON.stringify({ envelopeVersion: ENVELOPE_VERSION, ...payload }, null, 2);
  captured = body;
  try {
    captureHook?.(body);
  } catch {
    // A hook that throws must never reach the command's envelope path.
  }
  return body;
}

/** The last envelope this process serialized, or null if none has been. */
export function capturedEnvelope(): string | null {
  return captured;
}

/** Forget the captured envelope — the entry point calls this before dispatch. */
export function resetCapturedEnvelope(): void {
  captured = null;
}
