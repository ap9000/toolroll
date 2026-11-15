/**
 * The approval summary (the "terms diet"): one short, plain reading of an approval's sealed terms, used by every
 * surface that asks for a yes — the web Work panel and task page, the chat sheet, the chat apps' cards, the CLI and the
 * terminal workbench.
 *
 * It shows the decisions (what will change and when it is done, which agent and model, what it may touch, what it may
 * cost), every setting that differs from the project's usual settings, and every risk, always in the open. The rest of
 * what the yes binds is listed whole under "Your usual project settings" (a disclosure on the web, a line in text).
 *
 * Consent stays exact. The summary is derived only from the scope the digest binds plus the project's usual settings,
 * deterministically; every bound field is in a row (`fields`), and `key` is a hash of everything shown. The browser's
 * approval form folds `key` into the digest it posts (render-tasks.ts approvalFormDigest), the chat apps' cards fold it
 * into theirs, and the CLI takes it as `--terms`: when the usual settings (or anything else shown) change between
 * display and press, the existing stale-terms refusal fires.
 */
import { createHash } from "node:crypto";
import { resolveScopeProfile } from "./agentconfig.js";
import { isProtectedWork, type ApprovalRules } from "./approval-policy.js";
import { permissionPlainWords } from "./chat-terms.js";
import { checkAccessWords } from "./check-access.js";
import { networkWords } from "./egress.js";
import { agentModelName } from "./model-names.js";
import { makesNoPlan, NO_READINESS, projectRoute, routeFromJson, sizeWords, type PhaseRoute, type ReadinessLookup } from "./phase-routing.js";
import { sandboxTermsWords } from "./project-sandbox.js";
import { qualityModeTitle, type QualityMode } from "./quality.js";
import { approvalOf, chainTermsLines, describeApproval, releaseAsksAgainWords, releaseCheckSentence, releaseTermsSentence, type ExecutionProfile, type Scope } from "./scope.js";
import { writesWords } from "./writes-mode.js";
import type { RevisionLineage, Store } from "./store.js";

/** What a yes binds, field by field: the digest's own inputs, and each key of the sealed profile. */
export type BoundField =
  | "goal" | "outOfScope" | "touches" | "acceptance" | "budget" | "qualityMode" | "candidate" | "releaseTerms" | "releaseCheck"
  | "route" | `route.${string}` | "chain" | `profile.${string}`;

/** One row of the summary: a label, its words, any further lines, and the bound fields it states. */
export type SummaryRow = { label: string; words: string; lines?: string[]; fields: BoundField[] };
export type SummaryNote = { words: string; fields: BoundField[] };

export type ApprovalSummary = {
  /** One plain sentence for a revision ("This revises build #9. It keeps the same limits. …"), or null. */
  revision: string | null;
  /** The decisions, always shown. */
  decisions: SummaryRow[];
  /** Why an earned rule chose this model ("so far" counts: explanation, not a term, and so outside `key`), or null. */
  why: string | null;
  /** Settings that differ from the project's usual ones, always shown. */
  differs: SummaryRow[];
  /** Risks and rules a person must see before saying yes: never folded. */
  warnings: SummaryNote[];
  /** Everything else the yes binds, in plain words: folded under `usualLabel`. */
  usual: SummaryRow[];
  usualLabel: string;
  /** A hash of everything above and the scope's digest: what an approval form pins. */
  key: string;
};

/** The project's usual settings for this scope's agent, as a plain task filed now would be sealed with them. */
export type UsualSettings = { profile: ExecutionProfile | null; qualityMode: QualityMode };

/** What a revision's sentence says, read from the store (store.revisionLineageOf and the source's own scope). */
export type RevisionFacts = {
  sourceTask: string;
  sourceRun: number | null;
  hadPlan: boolean;
  /** Whether the limits match the source's: null when the source's terms can't be read. */
  sameLimits: boolean | null;
  problem: string | null;
  repair: { cap: number | null; remaining: number | null } | null;
};

export type SummaryContext = {
  usual: UsualSettings | null;
  revision: RevisionFacts | null;
  rules: ApprovalRules | null;
  /** Results routing: "Why this model: …" when an earned rule chose the builder. */
  evidence?: string | null;
};

export const NO_CONTEXT: SummaryContext = { usual: null, revision: null, rules: null };

export const USUAL_LABEL = "Your usual project settings";
const OTHER_LABEL = "Other settings";

/** How each requirement is shown to be met, in plain words. */
export const EVIDENCE_WORDS: Readonly<Record<string, string>> = { check: "runs automatically", screenshot: "shown in a screenshot", "changed-path": "seen in the changed files", "manual-review": "you review it" };

/** A machine-drafted repair appends its brief to the goal. Surfaces read it only to write a plain lead sentence above
 * the goal; the goal itself is always shown whole. */
export const REPAIR_BRIEF = / — (repair exactly the unmet criteria named below; a comment cannot widen the scope\. Unmet: ([^.]+)\.|Collect only the missing observations for ([^.]+)\. .*|Diagnose the saved failed project check and repair within the original scope\. .*)$/s;

const money = (micro: number): string => `$${(micro / 1_000_000).toFixed(2)}`;
const minutes = (seconds: number): string => `${Math.round(seconds / 60)} min`;
const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);
const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

const VERB: Readonly<Record<"plan" | "build" | "repair" | "review", string>> = { plan: "plans", build: "builds", repair: "fixes", review: "reviews" };
const ROLE: Readonly<Record<"plan" | "build" | "repair" | "review", string>> = { plan: "planner", build: "builder", repair: "fixer", review: "reviewer" };

/** The profile key that holds the agent's permissions, whichever agent it is. */
const PERMISSION_KEYS = ["permissionArgv", "approvalArgv", "sandboxMode", "permission"] as const;

/** Who does what, in one line: every leg the route binds, agents grouped by identical pair, in phase order. A small
 * change's recommended planner is said as what it is (it plans only when a plan is asked for), never left out. */
function agentWords(route: PhaseRoute | null, profile: ExecutionProfile | null | undefined): string | null {
  if (route === null) {
    if (profile == null) return null;
    return `${agentModelName(profile.provider, profile.model)} builds and fixes`;
  }
  const unplanned = makesNoPlan(route.size, route.risk);
  const groups: { name: string; verbs: string[] }[] = [];
  const asked: string[] = [];
  for (const leg of route.legs) {
    const name = agentModelName(leg.provider, leg.model);
    if (unplanned && leg.phase === "plan" && leg.chosen === "recommended") { asked.push(`${name} plans only if you ask for a plan`); continue; }
    const group = groups.find(one => one.name === name);
    if (group === undefined) groups.push({ name, verbs: [VERB[leg.phase]] });
    else group.verbs.push(VERB[leg.phase]);
  }
  const list = (verbs: string[]): string => verbs.length <= 1 ? verbs.join("") : `${verbs.slice(0, -1).join(", ")} and ${verbs.at(-1)}`;
  const who = [...groups.map(one => `${one.name} ${list(one.verbs)}`), ...asked].join("; ");
  const size = sizeWords(route);
  return size === null ? who : `${who} (${lowerFirst(size)})`;
}

/** The time a run may take, in plain words. */
function limitWords(profile: ExecutionProfile): string {
  if ("idleTimeoutSeconds" in profile) return `stops after ${minutes(profile.timeoutSeconds)}, or ${minutes(profile.idleTimeoutSeconds)} silent`;
  const time = `${minutes(profile.timeoutSeconds)} ${profile.timeoutKind === "idle" ? "without progress" : "per attempt"}`;
  return typeof profile.maxTurns === "number" ? `stops after ${profile.maxTurns} turns or ${time}` : `stops after ${time}`;
}

/** How a fix (a repair) runs, in plain words. */
function fixWords(profile: ExecutionProfile): string {
  const model = profile.repairModel === "inherit" ? "the same model" : profile.repairModel;
  if ("repairIdleTimeoutSeconds" in profile) return `on ${model}, up to ${minutes(profile.repairTimeoutSeconds)}, or ${minutes(profile.repairIdleTimeoutSeconds)} silent`;
  return typeof profile.repairMaxTurns === "number"
    ? `on ${model}, up to ${profile.repairMaxTurns} turns and ${minutes(profile.repairTimeoutSeconds)}`
    : `on ${model}, up to ${minutes(profile.repairTimeoutSeconds)}`;
}

/** The settings a person usually leaves alone, each with the profile keys it states and how to read them. */
type Setting = { label: string; fields: readonly string[]; words: (profile: ExecutionProfile) => string };
const SETTINGS: readonly Setting[] = [
  { label: "Writes", fields: ["writes"], words: profile => writesWords(profile.writes) },
  { label: "Reads", fields: ["fencePolicy", "readDeny"], words: profile => sandboxTermsWords(profile).reads },
  { label: "Time limit", fields: ["maxTurns", "timeoutSeconds", "timeoutKind", "idleTimeoutSeconds"], words: limitWords },
  { label: "Fixes", fields: ["repairModel", "repairMaxTurns", "repairTimeoutSeconds", "repairIdleTimeoutSeconds"], words: fixWords },
];

const valueOf = (profile: ExecutionProfile, keys: readonly string[]): string =>
  JSON.stringify(keys.map(key => (profile as Record<string, unknown>)[key] ?? null));

/** The revision's one sentence. */
export function revisionWords(facts: RevisionFacts): string {
  const parts = [facts.sourceRun === null ? `This revises ${facts.sourceTask}.` : `This revises build #${facts.sourceRun}.`];
  if (!facts.hadPlan) parts.push("The earlier version had no plan, so nothing was copied.");
  else if (facts.sameLimits === true) parts.push("It keeps the same limits.");
  else if (facts.sameLimits === false) parts.push("Its limits differ from that build's.");
  if (facts.repair !== null && facts.problem === null) {
    parts.push(facts.repair.cap !== null && (facts.repair.remaining ?? 0) > 0
      ? `${plural(facts.repair.remaining!, "more attempt")} can run without asking you.`
      : "Each extra attempt asks you first.");
  }
  return parts.join(" ");
}

/**
 * THE SUMMARY: the scope's sealed terms, short and plain. Pure and deterministic: the same scope and context give the
 * same summary, and so the same key.
 */
export function approvalSummaryOf(scope: Scope, context: SummaryContext = NO_CONTEXT): ApprovalSummary {
  const profile = scope.profile ?? null;
  const route = routeFromJson(scope.proposedRouteJson ?? null);
  const usualProfile = context.usual?.profile ?? null;
  const decisions: SummaryRow[] = [];
  const differs: SummaryRow[] = [];
  const warnings: SummaryNote[] = [];
  const usual: SummaryRow[] = [];

  // What will change: the goal whole, every word that is signed.
  decisions.push({ label: "Goal", words: scope.goal, fields: ["goal"] });
  if (scope.outOfScope !== null) decisions.push({ label: "Won’t touch", words: scope.outOfScope, fields: ["outOfScope"] });
  decisions.push(scope.acceptance.length === 0
    ? { label: "Done when", words: "You decide when you review the result.", fields: ["acceptance"] }
    : { label: "Done when", words: `${scope.acceptance[0]!.statement} (${scope.acceptance[0]!.evidence.map(kind => EVIDENCE_WORDS[kind] ?? kind).join(", ")})`,
      lines: scope.acceptance.slice(1).map(one => `${one.statement} (${one.evidence.map(kind => EVIDENCE_WORDS[kind] ?? kind).join(", ")})`), fields: ["acceptance"] });
  if (scope.candidate) decisions.push({ label: "Commit", words: `${scope.candidate}, checked out as it is; no agent runs`, fields: ["candidate"] });

  // Which agent and model.
  const agent = agentWords(route, profile);
  if (agent !== null) decisions.push({ label: "Agent", words: agent, fields: [...(route === null ? [] : ["route" as BoundField, ...route.legs.map(leg => `route.${leg.phase}` as BoundField)]), ...(profile === null ? [] : ["profile.provider", "profile.model"] as BoundField[])] });

  // What it may touch: files, network and tools, in one line.
  const permissionKey = profile === null ? null : PERMISSION_KEYS.find(key => key in profile) ?? null;
  const tools = permissionPlainWords(profile);
  const usualTools = usualProfile === null ? null : permissionPlainWords(usualProfile);
  const touch = [
    scope.touches.length === 0 ? "any file" : `only ${scope.touches.join(", ")}`,
    ...(profile === null ? [] : [`network: ${lowerFirst(networkWords(profile.network ?? null).replace(/^Network: /, ""))}`]),
    ...(tools === null ? [] : [`tools: ${tools}${usualTools !== null && usualTools !== tools ? " (not the project’s usual)" : ""}`]),
  ];
  decisions.push({ label: "May touch", words: touch.join(" · "), fields: ["touches", ...(profile === null ? [] : ["profile.network"] as BoundField[]), ...(permissionKey === null ? [] : [`profile.${permissionKey}` as BoundField])] });

  // What it may cost.
  decisions.push({ label: "May cost", words: scope.budgetMicrousd === null ? "no cap" : `up to ${money(scope.budgetMicrousd)} per attempt; the agent is stopped there`, fields: ["budget"] });

  // A release is said whole: what asks again is part of the yes.
  if (scope.releaseTerms != null) {
    decisions.push({ label: "Release", words: releaseTermsSentence(scope.releaseTerms), ...(scope.releaseTerms.policy.carry ? { lines: releaseAsksAgainWords(scope.releaseTerms) } : {}), fields: ["releaseTerms"] });
  }
  if (scope.releaseCheck != null) decisions.push({ label: "Release", words: releaseCheckSentence(scope.releaseCheck), fields: ["releaseCheck"] });

  // Agents a person picked by hand: not the usual pick, so said.
  const byHand = route === null ? [] : route.legs.filter(leg => leg.chosen !== "recommended");
  if (byHand.length > 0) differs.push({ label: "Your pick", words: `${byHand.map(leg => `${ROLE[leg.phase]} ${agentModelName(leg.provider, leg.model)}`).join("; ")}, not the project’s usual pick`, fields: ["route"] });

  // The checks level.
  const quality = scope.qualityMode ?? "default";
  const qualityRow: SummaryRow = { label: "Checks", words: qualityModeTitle(quality), fields: ["qualityMode"] };
  if (context.usual !== null && quality !== context.usual.qualityMode) differs.push({ ...qualityRow, words: `${qualityRow.words} (usually ${qualityModeTitle(context.usual.qualityMode)})` });
  else usual.push(qualityRow);

  if (profile !== null) {
    for (const setting of SETTINGS) {
      const row: SummaryRow = { label: setting.label, words: setting.words(profile), fields: setting.fields.filter(key => key in profile).map(key => `profile.${key}` as BoundField) };
      if (usualProfile !== null && valueOf(profile, setting.fields) !== valueOf(usualProfile, setting.fields)) differs.push({ ...row, words: `${row.words} (usually ${setting.words(usualProfile)})` });
      else usual.push(row);
    }
    // Checks past the sandbox and extra services are risks, said in the open (chat-terms.ts cardShowsScope reads these words).
    if (profile.checkAccess !== undefined) warnings.push({ words: `Project checks: ${checkAccessWords(profile.checkAccess)}.`, fields: ["profile.checkAccess"] });
    else usual.push({ label: "Project checks", words: checkAccessWords("sandboxed"), fields: [] });
    const mach = sandboxTermsWords(profile).mach;
    if (mach !== null) warnings.push({ words: `It ${mach}.`, fields: ["profile.machLookup"] });
  }

  // Fallback agents (an older approval's chain): said whole, never folded.
  const chain = chainTermsLines(scope);
  if (chain.length > 0) warnings.push({ words: chain.join(" "), fields: ["chain"] });

  // The project's own approval rules.
  const rules = context.rules;
  if (rules !== null && isProtectedWork(rules, [...scope.touches])) warnings.push({ words: "This project protects this work: two people must approve it.", fields: [] });
  if (rules?.notRequester === true) warnings.push({ words: "The person who asked for this can’t approve it.", fields: [] });

  // A revision.
  const revision = context.revision === null ? null : revisionWords(context.revision);
  if (context.revision?.problem != null) warnings.push({ words: `Toolroll can’t check what this revises (${context.revision.problem}), so no fix runs on its own.`, fields: [] });

  const usualLabel = context.usual === null ? OTHER_LABEL : USUAL_LABEL;
  const key = createHash("sha256").update(JSON.stringify({ v: 1, digest: scope.digest, revision, decisions, differs, warnings, usual, usualLabel }), "utf8").digest("hex").slice(0, 32);
  const why = context.evidence == null || context.evidence === "" ? null : context.evidence.replace(/^Why this model: /, "");
  return { revision, decisions, why, differs, warnings, usual, usualLabel, key };
}

/** Every bound field the summary states, in a row or a note. */
export function summaryFields(summary: ApprovalSummary): Set<BoundField> {
  return new Set([...summary.decisions, ...summary.differs, ...summary.usual, ...summary.warnings].flatMap(one => one.fields));
}

/** The fields a scope binds (the digest's inputs that are present, and each key of its profile). */
export function boundFieldsOf(scope: Scope): BoundField[] {
  const fields: BoundField[] = ["goal", "touches", "acceptance", "budget", "qualityMode"];
  if (scope.outOfScope !== null) fields.push("outOfScope");
  if (scope.candidate) fields.push("candidate");
  if (scope.releaseTerms != null) fields.push("releaseTerms");
  if (scope.releaseCheck != null) fields.push("releaseCheck");
  const route = routeFromJson(scope.proposedRouteJson ?? null);
  if (route !== null) fields.push("route", ...route.legs.map(leg => `route.${leg.phase}` as BoundField));
  if (chainTermsLines(scope).length > 0) fields.push("chain");
  for (const key of Object.keys(scope.profile ?? {})) fields.push(`profile.${key}`);
  return fields;
}

/** The summary as text, for the CLI, the terminal workbench and the chat apps: one labelled line per row. */
export function summaryLines(summary: ApprovalSummary): string[] {
  // Labels are at most 11 characters, so two spaces always follow one (fast-terms.ts reads the rows back by them).
  const pad = (label: string): string => `  ${label.padEnd(12)} `;
  const indent = " ".repeat(15);
  const row = (one: SummaryRow): string[] => [`${pad(one.label)}${one.words}`, ...(one.lines ?? []).map(line => `${indent}${line}`)];
  return [
    ...(summary.revision === null ? [] : [`${pad("Revision")}${summary.revision}`]),
    ...summary.decisions.flatMap(row),
    ...(summary.why === null ? [] : [`${pad("Why model")}${summary.why}`]),
    ...summary.differs.flatMap(row),
    ...summary.warnings.map(one => `${pad("Note")}${one.words}`),
    ...(summary.usual.length === 0 ? [] : [`${pad("Usual")}${summary.usualLabel}: ${summary.usual.map(one => `${lowerFirst(one.label)} ${one.words}`).join(" · ")}`]),
  ];
}

/** The summary as plain text with no padding (a chat app's card). `omit` leaves out decisions the card says elsewhere. */
export function summaryText(summary: ApprovalSummary, omit: (row: SummaryRow) => boolean = () => false): string {
  return [
    ...(summary.revision === null ? [] : [summary.revision, ""]),
    ...summary.warnings.map(one => one.words),
    ...(summary.warnings.length === 0 ? [] : [""]),
    ...[...summary.decisions.filter(one => !omit(one)), ...(summary.why === null ? [] : [{ label: "Why model", words: summary.why }]), ...summary.differs].flatMap((one: Pick<SummaryRow, "label" | "words" | "lines">) => [`${one.label}: ${one.words}`, ...(one.lines ?? []).map(line => `  ${line}`)]),
    ...(summary.usual.length === 0 ? [] : ["", `${summary.usualLabel}: ${summary.usual.map(one => `${lowerFirst(one.label)} ${one.words}`).join(" · ")}`]),
  ].join("\n");
}

/** The scope, in the words an operator has to be able to agree or disagree with: the approval summary, the same rows
 * every surface shows, then its version and whether it is approved. `context` is the project's usual settings, a
 * revision and the approval rules (summaryContextOf); without it the settings are listed as "Other settings". It lives
 * here, not in scope.ts, so the scope module never loads the agent configuration. */
export function describeScope(scope: Scope, readiness: ReadinessLookup = NO_READINESS,
  /** Results routing: the evidence line when an earned rule chose the builder (route-rules.ts taskEvidenceWords). */
  evidence: string | null = null, context: SummaryContext | null = null): string[] {
  const route = routeFromJson(scope.proposedRouteJson ?? null);
  // Readiness is volatile and never part of the yes: said beside the terms when an agent is reported unavailable.
  const halted = route !== null && projectRoute(route, readiness).halted;
  return [
    ...summaryLines(approvalSummaryOf(scope, { ...(context ?? NO_CONTEXT), evidence })),
    ...(halted ? ["  Note         An agent here is reported unavailable: nothing runs until it is back or you change the agent."] : []),
    `  version      ${scope.digest.slice(0, 8)} (the full plan version is in --json)`,
    `  approved     ${describeApproval(approvalOf(scope))}`,
  ];
}

// ---- reading the context from the store ----------------------------------------------------------------------------

/** The project's usual settings for this scope's agent: the profile a plain task filed now would be sealed with on that
 * same agent (so its built-in limits compare like for like), and the installation's checks level. Null when the
 * project's configuration can't say (the summary then calls the rest "Other settings"). */
export function usualSettingsOf(store: Store, repo: string | null, scope: Pick<Scope, "profile">, platform: NodeJS.Platform = process.platform): UsualSettings | null {
  const qualityMode = store.qualityDefault().mode;
  const profile = scope.profile ?? null;
  if (profile === null) return { profile: null, qualityMode };
  // The same reading filing uses, on this scope's own agent, without walking the checkout (the network is a decision
  // row, never compared).
  const resolved = resolveScopeProfile(store, repo, undefined, { provider: profile.provider, model: profile.model }, platform, { walk: false });
  return resolved.ok ? { profile: resolved.profile, qualityMode } : null;
}

/** A revision's facts from its lineage and the source's own scope. */
export function revisionFactsOf(store: Store, lineage: RevisionLineage | null, scope: Scope): RevisionFacts | null {
  if (lineage === null) return null;
  const source = lineage.sourceHadScope ? store.getScope(lineage.sourceTask) : null;
  const permission = (one: Scope): string => {
    const p = one.profile ?? null;
    if (p === null) return "";
    const key = PERMISSION_KEYS.find(name => name in p);
    return key === undefined ? "" : String((p as Record<string, unknown>)[key]);
  };
  const sameLimits = source === null ? null
    : (source.qualityMode ?? "default") === (scope.qualityMode ?? "default") && source.budgetMicrousd === scope.budgetMicrousd
      && (source.outOfScope ?? null) === (scope.outOfScope ?? null) && JSON.stringify([...source.touches].sort()) === JSON.stringify([...scope.touches].sort())
      && permission(source) === permission(scope);
  return {
    sourceTask: lineage.sourceTask,
    sourceRun: lineage.sourceRun,
    hadPlan: lineage.sourceHadScope,
    sameLimits,
    problem: lineage.problem ?? null,
    repair: lineage.repair === null ? null : { cap: lineage.repair.cap, remaining: lineage.repair.remaining },
  };
}

/** The whole context for a task's waiting approval, read from the store: one reading for every surface. */
export function summaryContextOf(store: Store, taskId: string, scope: Scope, now: Date, evidence: string | null = null): SummaryContext {
  const ref = store.lookupRef(taskId);
  const repo = ref?.repo ?? null;
  const lineage = ref !== null && ref.revisionBriefArtifact !== null ? store.revisionLineageOf(taskId, now) : null;
  return {
    usual: usualSettingsOf(store, repo, scope),
    revision: revisionFactsOf(store, lineage, scope),
    rules: repo === null ? null : store.approvalRules(repo),
    evidence,
  };
}

/** The summary of a task's scope as it stands, with its whole context: what every surface shows and pins. */
export function approvalSummaryFor(store: Store, taskId: string, now: Date, evidence: string | null = null): ApprovalSummary | null {
  const scope = store.getScope(taskId);
  return scope === null ? null : approvalSummaryOf(scope, summaryContextOf(store, taskId, scope, now, evidence));
}
