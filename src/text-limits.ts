/**
 * Text limits, in one place, and the one way a limit is met: a model is told the exact limit before it writes, an
 * answer still over it is asked once to shorten (one repair turn), and an answer still over after that is kept whole
 * in the record and linked, never chopped. Chat platforms' own message limits are met by splitting across messages.
 *
 * Limits apply when text is written. Reading never re-validates length, so a runtime with lower limits (0.9.23 to
 * 0.9.26) still opens a store holding longer text (scripts/upgrade-path.mjs, the rollback leg).
 */

/** UTF-16 code units, the JavaScript and HTML maxlength measure, unless a name says bytes. */
export const TEXT_LIMITS = {
  /** A task's goal and its out-of-scope text. */
  goal: 8_000,
  goalBytes: 32_000,
  /** Revise feedback, steering and decision notes. */
  note: 4_000,
  noteBytes: 16_000,
  /** A flow work zone's instructions; nothing is held back for the card's details (they are attached when long). */
  flowInstructions: 8_000,
  /** A flow's zones and steps (src/contracts/flow.ts): a zone's name, a step's id as written, and a reference to another step. */
  flowTitle: 60,
  flowStepId: 32,
  flowRef: 60,
  /** A Message zone's message, or the comment an Update zone leaves. */
  flowMessage: 1_000,
  /** Who decides a "Person decides" zone (a sign-in name), and the AI teammate who works a zone, as written. */
  flowDecider: 64,
  flowTeammate: 40,
  /** A Build zone's other project: its path. */
  flowRepo: 1_000,
  /** A script's or teammate's answer, a choice's button, a Sort zone's answer and what it means, its question, and a score's level. */
  flowAnswer: 40,
  flowChoice: 40,
  flowSortMeans: 200,
  flowSortQuestion: 300,
  flowSortLevel: 120,
  /** A Web request zone's address, one header's value and the body it sends (an email's body too). */
  flowUrl: 2_000,
  flowHeader: 500,
  flowBody: 8_000,
  /** An email's recipients and subject. */
  flowEmailTo: 500,
  flowEmailSubject: 200,
  /** A tool zone's tool (MCP server), its function, and the arguments as JSON. */
  flowToolServer: 64,
  flowToolName: 100,
  flowToolArgs: 4_000,
  /** A wait or reminder said in words ("3 days"), and a time zone's name. */
  flowDuration: 40,
  flowTimeZone: 60,
  /** A flow's name, and a flow file's about line, needs, parameter questions and answers, and scripts. */
  flowName: 80,
  flowFileAbout: 600,
  flowFileNeed: 80,
  flowParameter: 200,
  flowScriptAbout: 160,
  flowScriptBody: 20_000,
  flowScriptFile: 200,
  /** A trigger's settings: a button's label and questions, a schedule and the card it makes, GitHub, Linear, webhook and email terms. */
  triggerButton: 40,
  triggerQuestion: 80,
  triggerSchedule: 80,
  triggerTitle: 200,
  triggerDescription: 2_000,
  triggerGithubRepo: 140,
  triggerLabel: 50,
  triggerBranch: 100,
  triggerTeam: 12,
  triggerState: 40,
  triggerWebhookTitle: 120,
  triggerWebhookField: 80,
  triggerFolder: 100,
  triggerSender: 300,
  triggerSubject: 100,
  /** A schedule's secrets written as one line ("API_KEY, CRM_TOKEN"). */
  triggerSecrets: 500,
  /** A card the lead adds to a flow: its title and description; a script it saves inline. */
  flowCardTitle: 200,
  flowCardDescription: 4_000,
  flowScriptInline: 1_600,
  /** A research report's summary, in UTF-8 bytes. */
  reportSummary: 2_500,
  /** What one flow step passes on to the steps after it. */
  stageOutput: 12_000,
  /** The planner's whole handoff file, in UTF-8 bytes. */
  planPayloadBytes: 64 * 1024,
  /** The plan document (markdown), in UTF-8 bytes. */
  planDocumentBytes: 16 * 1024,
  /** The plan document's Approach section. */
  planApproach: 2_000,
  /** One Milestones, Dependencies, Risks or Proof item in the plan document. */
  planItem: 600,
  /** One path a plan expects to touch. */
  planTouch: 200,
  /** A planner's amendment note: why the filed contract must change. */
  planAmendment: 1_000,
  /** An acceptance criterion's id, statement and advisory how, in UTF-8 bytes. */
  acceptanceIdBytes: 40,
  acceptanceStatementBytes: 1_000,
  acceptanceHowBytes: 500,
  /** A builder's whole proof file, in UTF-8 bytes. */
  proofPayloadBytes: 64 * 1024,
  /** A proof criterion's id, in UTF-8 bytes. */
  proofCriterionIdBytes: 40,
  /** How a proof criterion was met, in UTF-8 bytes. */
  proofHowBytes: 500,
  /** One proof line — a criterion statement, evidence ref, check command or summary, changed path, caveat, or
   * screenshot path or caption — in UTF-8 bytes. */
  proofLineBytes: 300,
  /** The lead's catch-up bundle (src/contracts/lead-context.ts), in UTF-8 bytes, and the lines it clips: an open promise,
   * a confirmed correction, the end of changed instructions a correction shows, and what an open proposal is about. */
  leadContextBytes: 8_000,
  leadPromise: 160,
  leadCorrection: 300,
  leadCorrectionInstructions: 240,
  leadProposalAbout: 120,
  /** Project knowledge (src/contracts/project-knowledge.ts), in UTF-8 bytes: the instructions (also the memory pass's
   * budget for them), a reference's title, path and text, the context a run gets, the decision lines in it, and the
   * repository excerpts added when at least the minimum is left. */
  knowledgeInstructionsBytes: 4_000,
  knowledgeTitleBytes: 120,
  knowledgePathBytes: 300,
  knowledgeReferenceBytes: 12_000,
  knowledgeContextBytes: 24_000,
  knowledgeDecisionsBytes: 1_500,
  knowledgeRepositoryBytes: 6_000,
  knowledgeRepositoryMinBytes: 3_000,
  /** A project decision (src/contracts/project-memory.ts), in UTF-8 bytes: the choice, why, who decided, where it came
   * from, and why it was retired. */
  decisionClaimBytes: 240,
  decisionWhyBytes: 2_000,
  decisionByBytes: 80,
  decisionSourceBytes: 200,
  decisionRetireBytes: 500,
  /** A skill package (src/contracts/project-skills.ts): its name, description, requirements and source in UTF-8 bytes,
   * a file's path, SKILL.md, one file, the package and the enabled selection in bytes; a test's sample request and
   * feedback in characters and bytes. */
  skillNameBytes: 64,
  skillDescriptionBytes: 1_024,
  skillRequirementsBytes: 500,
  skillSourceBytes: 500,
  skillPath: 240,
  skillBodyBytes: 24 * 1024,
  skillFileBytes: 256 * 1024,
  skillPackageBytes: 1024 * 1024,
  skillSelectionBytes: 2 * 1024 * 1024,
  skillSample: 800,
  skillSampleBytes: 4_000,
  skillFeedback: 500,
  skillFeedbackBytes: 2_000,
  /** The memory pass (src/contracts/memory-pass.ts): one session's trace, and in its verdict an effect, a mistake and
   * the instruction it proposes. */
  memoryTrace: 40_000,
  memoryEffect: 300,
  memoryMistake: 300,
  memoryInstruction: 240,
} as const;

export type TextLimitKey = keyof typeof TEXT_LIMITS;

/** One chat message on each platform. Longer text is split across messages, never cut. Teams: the text one Adaptive Card
 * holds, well inside its 28 KB message. */
export const PLATFORM_LIMITS = { telegram: 4_096, discord: 2_000, slack: 4_000, teams: 6_000 } as const;
export type Platform = keyof typeof PLATFORM_LIMITS;

const count = (n: number) => n.toLocaleString("en-US");

/** The line a model reads before it writes a field with a limit. */
export function limitRule(what: string, limit: number, unit: "characters" | "bytes" = "characters"): string {
  return `${what}: at most ${count(limit)} ${unit}. Put the most important part first. Longer text is not cut: you will be asked to shorten it.`;
}

/** One field over its limit: what it is, its limit, and how long it came back. */
export type Overrun = { field: string; limit: number; length: number; unit?: "characters" | "bytes" };

/** How long a text is in a limit's unit. */
export const lengthIn = (text: string, unit: "characters" | "bytes" = "characters") => unit === "bytes" ? Buffer.byteLength(text, "utf8") : text.length;

/** The fields of `values` over their limits. */
export function overruns(values: Record<string, string>, limits: Record<string, number>, unit: "characters" | "bytes" = "characters"): Overrun[] {
  return Object.entries(limits).flatMap(([field, limit]) => {
    const value = values[field];
    if (value === undefined) return [];
    const length = lengthIn(value, unit);
    return length > limit ? [{ field, limit, length, ...(unit === "bytes" ? { unit } : {}) }] : [];
  });
}

/** The repair turn's ask: each field over its limit, by how much, and the same answer again within it. */
export function shortenAsk(over: readonly Overrun[]): string {
  return [
    "Your answer is over a limit:",
    ...over.map(one => `- ${one.field} is ${count(one.length)} ${one.unit ?? "characters"}; the limit is ${count(one.limit)}.`),
    "Answer again with the same decision and meaning, each field within its limit. Shorten by dropping repetition and detail, not facts that matter.",
  ].join("\n");
}

/**
 * Ask, check, and ask once more to shorten. `write` gets null the first time and the shorten ask the second.
 * The second answer is returned whatever its length: the caller keeps it whole (and links it when it must).
 */
export async function writeWithin<T>(write: (shorten: string | null) => Promise<T>, check: (answer: T) => Overrun[]): Promise<{ answer: T; over: Overrun[]; repaired: boolean }> {
  const first = await write(null);
  const over = check(first);
  if (over.length === 0) return { answer: first, over, repaired: false };
  const second = await write(shortenAsk(over));
  return { answer: second, over: check(second), repaired: true };
}

/**
 * Text passed on under a limit: whole when it fits; otherwise kept whole in the record named by `where` and passed on
 * as a pointer to it. Never a cut.
 */
export function passOn(text: string, limit: number, where: { label: string; href: string | null }, holds = "a step passes on"): { text: string; kept: boolean } {
  if (text.length <= limit) return { text, kept: false };
  const at = where.href === null ? where.label : `${where.label}: ${where.href}`;
  return { text: `This is ${count(text.length)} characters, more than the ${count(limit)} ${holds}, so it is kept whole on ${at}.`, kept: true };
}
