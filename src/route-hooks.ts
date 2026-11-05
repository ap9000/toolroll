/**
 * Results routing's protection (docs/plans/results-routing.md, "Protection", items 2 and 4): what a release can't
 * change without a person, checked by the INSTALLED plane against a candidate (release-auto.ts changeProblem), so a
 * candidate can't edit the check that judges it. This file is itself a policy path.
 *
 * 1. Required calls and pinned bodies (eval-hooks.ts's machinery, its own manifest): the calls that feed the records
 *    (the raw execution class, every revision's origin, the re-evaluation pass, the project deletion's Models
 *    counter) and the functions whose bodies decide what a record says or what a route is — a pinned body can't gain
 *    an `if (false)` without changing. Each revision caller's arguments are pinned too, so the origin it passes can't
 *    change by itself.
 * 2. The SQL scan: a changed file whose string or template text writes a results-routing table, run.exec_class,
 *    task_ref.revision_origin or a Models (phase_*) table, from anywhere but route-store.ts or the named store.ts
 *    writers, needs a person — unless the base's copy of that file already had exactly that text. It reads text the
 *    candidate wrote, never runs it; SQL assembled from pieces (a table name in a variable) isn't seen, which the
 *    pinned writers and a person's review of these files cover.
 */
import type ts from "typescript-parser";
import { createRequire } from "node:module";
import { evalHookProblem, type EvalHook, type EvalPinned } from "./eval-hooks.js";

let compiler: typeof ts | undefined;
const typescript = (): typeof ts => compiler ??= createRequire(import.meta.url)("typescript-parser") as typeof ts;

/** Where a revision is created from: each caller's arguments (and so the origin it passes) are held as the base has them. */
const REVISION_CALLERS: readonly EvalHook[] = [
  { file: "src/flow-engine.ts", inside: "revisionWithNote", calls: "requestResultChanges", from: "./result-actions.js", args: true, why: "a flow's revision says it came from a flow" },
  { file: "src/build-review.ts", inside: "sendBack", calls: "requestResultChanges", from: "./result-actions.js", args: true, why: "the automatic review's revision is never a person's" },
  { file: "src/flow-pull-request.ts", inside: "pullRequestStep", calls: "requestResultChanges", from: "./result-actions.js", args: true, why: "a flow's CI revision says it came from a flow" },
  { file: "src/pull-request-flow.ts", inside: "followPullRequests", calls: "requestResultChanges", from: "./result-actions.js", args: true, why: "a CI revision says it came from a flow" },
  { file: "src/chat-decide.ts", inside: "applyDecideFeedback", calls: "requestResultChanges", from: "./result-actions.js", args: true, why: "a chat's verified person asks for changes in their own words" },
  { file: "src/chat-review.ts", inside: "applyChatReview", calls: "createResultRevision", from: "./result-actions.js", args: true, why: "a confirmed review card passes the origin it was given" },
  { file: "src/lead-doors.ts", inside: "executeProposal", calls: "applyChatReview", from: "./chat-review.js", args: true, why: "a review card a person confirms is the person's; under a lead chain or remote run, the lead's" },
  { file: "src/task-outcome-cli.ts", inside: "runTaskOutcomeCommand", calls: "requestResultChanges", from: "./result-actions.js", args: true, why: "the command line tells a person from a lead or a machine" },
  { file: "src/server/tasks.ts", inside: "createTasksHandlers", calls: "requestResultChanges", from: "../result-actions.js", args: true, why: "a browser session is a person; a bearer credential a machine" },
  { file: "src/server/tasks.ts", inside: "createTasksHandlers", calls: "createResultRevision", from: "../result-actions.js", args: true, why: "a browser session is a person; a bearer credential a machine" },
];

export const ROUTING_HOOKS: readonly EvalHook[] = Object.freeze([
  { file: "src/dispose.ts", inside: "disposeBuildOutcomeLocked", calls: "recordExecClass", from: "./route-store.js", args: true, why: "a failed run's class is kept from its raw reason" },
  { file: "src/result-actions.ts", inside: "createResultRevision", calls: "recordRevisionOrigin", from: "./route-store.js", args: true, why: "every revision says who it came from" },
  { file: "src/operate.ts", inside: "reconcileCommand", calls: "reevaluateResultRecords", from: "./route-results.js", why: "records are evaluated again as their inputs change" },
  { file: "src/project-delete.ts", inside: "deleteRows", calls: "forgetProjectModels", from: "./store.js", why: "a deleted project's Models rows go through the counter" },
  { file: "src/release-auto.ts", inside: "changeProblem", calls: "routingHookProblem", from: "./route-hooks.js", why: "this check itself" },
  // Slice 2: each live rule is checked against its sealed terms every pass, and a held task never starts.
  { file: "src/operate.ts", inside: "reconcileCommand", calls: "routeRulesPass", from: "./route-rules.js", why: "a rule switches itself off on its sealed terms" },
  { file: "src/operate.ts", inside: "tickCommand", calls: "ruleHoldOf", from: "./route-store.js", why: "a task approved under a rule that switched itself off never starts on it" },
  ...REVISION_CALLERS,
]);

export const ROUTING_PINNED: readonly EvalPinned[] = Object.freeze([
  // What a route is and how it's read.
  { file: "src/phase-routing.ts", fn: "recommendRoute", why: "which agent a task is routed to" },
  // Slice 2: the one precedence order (pin > override > trial > earned rule > configured > headroom) and who is eligible.
  { file: "src/phase-routing.ts", fn: "selectBuildLeg", why: "the build leg's one precedence order" },
  { file: "src/phase-routing.ts", fn: "earnedRuleFor", why: "which tasks an earned rule may build" },
  // Slice 3: which tasks a trial may build, and that only a person's own yes seals or dispatches one.
  { file: "src/phase-routing.ts", fn: "trialFor", why: "which tasks a trial may build" },
  { file: "src/approval-authority.ts", fn: "authorityStandsSql", why: "which approvals dispatch, a trial task's only on a person's yes" },
  { file: "src/approval-authority.ts", fn: "trialSealStandsSql", why: "a trial task stands only on a person's own approval" },
  { file: "src/phase-routing.ts", fn: "canonicalRouteJson", why: "a sealed route's bytes, and so its digest" },
  { file: "src/phase-routing.ts", fn: "routeFromJson", why: "how a sealed route reads back" },
  { file: "src/contracts/route.ts", fn: "readSealedRoute", why: "every route version's rules, the build leg's selection included" },
  { file: "src/store.ts", fn: "Store#sealedRouteOf", why: "the sealed route a run's cohort is decided from" },
  { file: "src/model-choices.ts", fn: "checkScope", why: "what a Models setting may say" },
  { file: "src/model-choices.ts", fn: "effectiveRoutes", why: "the routes the Models page previews" },
  // The evidence a record reads.
  { file: "src/assignment.ts", fn: "assignmentChecksForRun", why: "a result's effective check" },
  { file: "src/result-completion.ts", fn: "changedFilesOf", why: "what a result changed" },
  { file: "src/assignment.ts", fn: "acknowledgeCurrent", why: "a completion's person or machine mark" },
  // Its inputs.
  { file: "src/store.ts", fn: "Store#finishRun", why: "how a run ends" },
  { file: "src/store.ts", fn: "Store#recordRunCheck", why: "a run's own check" },
  { file: "src/store.ts", fn: "Store#writeRunRoute", why: "a run's route stamp" },
  { file: "src/result-actions.ts", fn: "createResultRevision", why: "every revision and its origin" },
  // Its consumers and the Models writers, which move the configuration generations.
  { file: "src/store.ts", fn: "Store#saveScope", why: "filing a task's route" },
  { file: "src/store.ts", fn: "Store#sealScopeApproval", why: "approving a task's route" },
  { file: "src/store.ts", fn: "Store#admitRun", why: "a run's admission, its cohort snapshot, and the switched-off rule's hold" },
  { file: "src/store.ts", fn: "Store#applyCancellationLocked", why: "a cancel closes a task's exposure to an earned rule" },
  { file: "src/store.ts", fn: "Store#setPhaseConfig", why: "a Models row write moves its generation" },
  { file: "src/store.ts", fn: "Store#clearPhaseConfig", why: "a Models row write moves its generation" },
  { file: "src/store.ts", fn: "Store#setPhaseTierConfig", why: "a Models row write moves its generation" },
  { file: "src/store.ts", fn: "Store#clearPhaseTierConfig", why: "a Models row write moves its generation" },
  { file: "src/store.ts", fn: "Store#setPhaseTierAlternate", why: "a Models row write moves its generation" },
  { file: "src/store.ts", fn: "Store#clearPhaseTierAlternates", why: "a Models row write moves its generation" },
  { file: "src/store.ts", fn: "forgetProjectModels", why: "a deleted project's Models rows move their generations" },
]);

/** Every file the manifest reads, for one verified read of each tree. */
export const ROUTING_HOOK_FILES: readonly string[] = Object.freeze([...new Set([...ROUTING_HOOKS.map(hook => hook.file), ...ROUTING_PINNED.map(pin => pin.file)])]);

/** The tables only route-store.ts writes, and the Models tables only the named store.ts writers write. */
export const ROUTING_TABLES = Object.freeze(["route_record", "route_rule", "route_exposure", "route_exposure_event", "route_trial_reservation", "run_cohort", "models_generation"] as const);
export const MODELS_TABLES = Object.freeze(["phase_config", "phase_tier_config", "phase_tier_alternate"] as const);
/** The one writer module, and the store.ts functions (`Class#method` or top-level) that may write the Models tables:
 * the six row writers, a deleted project's rows, and the migration that rebuilt one. */
export const ROUTING_WRITER = "src/route-store.ts";
export const MODELS_WRITERS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "src/store.ts": Object.freeze(["Store#setPhaseConfig", "Store#clearPhaseConfig", "Store#setPhaseTierConfig", "Store#clearPhaseTierConfig",
    "Store#setPhaseTierAlternate", "Store#clearPhaseTierAlternates", "forgetProjectModels", "widenPhaseTierSchema"]),
});

const VERB = String.raw`(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM|DROP\s+TABLE(?:\s+IF\s+EXISTS)?|ALTER\s+TABLE|DROP\s+INDEX(?:\s+IF\s+EXISTS)?)`;
const writes = (tables: readonly string[]): RegExp => new RegExp(String.raw`\b${VERB}\s+(?:main\s*\.\s*)?["\`\[]?(?:${tables.join("|")})["\`\]]?(?![\w])`, "i");
const ROUTING_WRITE = writes([...ROUTING_TABLES, "route_rule_one_winner"]);
const MODELS_WRITE = writes(MODELS_TABLES);
/** The two columns only route-store.ts writes: any write statement that names one. */
const COLUMN_WRITE = /\b(?:INSERT|REPLACE|UPDATE)\b[^]*\b(?:exec_class|revision_origin)\b/i;

/** Each string or template text in the file that writes a protected row, with the function it's in ("" at the top
 * level): `Class#method`, or the top-level function. */
export function protectedWrites(file: string, source: ts.SourceFile): { text: string; inside: string; models: boolean }[] {
  const compiler = typescript();
  const found: { text: string; inside: string; models: boolean }[] = [];
  const owner = (node: ts.Node): string => {
    let name = "";
    for (let at: ts.Node | undefined = node.parent; at !== undefined; at = at.parent) {
      if (compiler.isMethodDeclaration(at) && at.name !== undefined && compiler.isIdentifier(at.name) && compiler.isClassDeclaration(at.parent) && at.parent.name !== undefined) name = `${at.parent.name.text}#${at.name.text}`;
      else if (compiler.isFunctionDeclaration(at) && at.name !== undefined && compiler.isSourceFile(at.parent)) name = at.name.text;
    }
    return name;
  };
  const visit = (node: ts.Node): void => {
    let text: string | null = null;
    if (compiler.isStringLiteralLike(node)) text = node.text;
    else if (compiler.isTemplateExpression(node)) text = [node.head.text, ...node.templateSpans.map(span => span.literal.text)].join("${}");
    if (text !== null) {
      const models = MODELS_WRITE.test(text);
      if (models || ROUTING_WRITE.test(text) || COLUMN_WRITE.test(text)) found.push({ text: text.replace(/\s+/g, " ").trim(), inside: owner(node), models: models && !ROUTING_WRITE.test(text) && !COLUMN_WRITE.test(text) });
      if (compiler.isTemplateExpression(node)) { for (const span of node.templateSpans) visit(span.expression); return; }
    }
    compiler.forEachChild(node, visit);
  };
  visit(source);
  void file;
  return found;
}

/** Whether this write may stand where it is: route-store.ts writes anything; the named store.ts writers write the
 * Models tables only. */
function allowed(file: string, write: { inside: string; models: boolean }): boolean {
  if (file === ROUTING_WRITER) return true;
  return write.models && (MODELS_WRITERS[file] ?? []).includes(write.inside);
}

/** Why a changed file writes a protected row from a place that may not, or null. A construct the base's copy of the
 * file already had (the same text in the same function, counted) is kept; a file that can't be read or parsed needs a
 * person. Test files are not scanned: they never ship as the plane. */
export function sqlWriteProblem(paths: readonly string[], candidate: ((file: string) => Buffer | null) | null, base: ((file: string) => Buffer | null) | null): string | null {
  const scanned = paths.filter(path => /\.(?:[cm]?[jt]sx?)$/.test(path) && !/\.test\.[cm]?[jt]sx?$/.test(path) && !path.startsWith("test/")
    && !path.startsWith("node_modules/") && !path.includes("/node_modules/"));
  if (scanned.length === 0) return null;
  if (candidate === null || base === null) return "the changed files can't be read";
  const compiler = typescript();
  const parse = (path: string, bytes: Buffer): ts.SourceFile | null => {
    const source = compiler.createSourceFile(path, bytes.toString("utf8"), compiler.ScriptTarget.Latest, true, compiler.ScriptKind.TS);
    return ((source as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics ?? []).length === 0 ? source : null;
  };
  for (const path of scanned) {
    const bytes = candidate(path);
    if (bytes === null) return `${path} can't be read`;
    const now = parse(path, bytes);
    if (now === null) return `${path} doesn't parse`;
    const before = base(path);
    const was = before === null ? null : parse(path, before);
    const kept = new Map<string, number>();
    const key = (one: { text: string; inside: string }) => `${one.inside}\u0000${one.text}`;
    if (was !== null) for (const one of protectedWrites(path, was)) kept.set(key(one), (kept.get(key(one)) ?? 0) + 1);
    for (const one of protectedWrites(path, now)) {
      if (allowed(path, one)) continue;
      const left = kept.get(key(one)) ?? 0;
      if (left > 0) { kept.set(key(one), left - 1); continue; }
      return `${path} writes results-routing or Models rows outside their writers (\`${one.text.slice(0, 80)}\`)`;
    }
  }
  return null;
}

/**
 * Why a candidate needs a person for results routing, or null: a required call dropped, a pinned body changed (its
 * manifest files read through `manifest`), or a changed file that writes a protected row outside its writers
 * (`changed`). With `manifest.base` (the plane's own record of where the release started), only what the base holds
 * is required, as eval-hooks.ts does.
 */
export function routingHookProblem(
  manifest: { candidate: (file: string) => Buffer | null; base?: (file: string) => Buffer | null },
  changed: { paths: readonly string[]; candidate: ((file: string) => Buffer | null) | null; base: ((file: string) => Buffer | null) | null },
): string | null {
  return evalHookProblem(manifest.candidate, manifest.base, ROUTING_HOOKS, ROUTING_PINNED) ?? sqlWriteProblem(changed.paths, changed.candidate, changed.base);
}
