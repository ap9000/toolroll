/**
 * The eval and nightly enforcement hooks a release can't drop without a person (docs/plans/evals-nightly.md, part C,
 * "Policy code needs a person", Codex round 2 #10 and C1 round 1 #5, #6).
 *
 * The policy modules themselves are person-only by path (release-auto.ts autoPathProblem: `evals/`, `src/evals*.ts`,
 * `src/eval-*.ts`, `src/reviewer-evals.ts`, `src/nightly-github.ts`, `src/contracts/evals*.ts`, and the accounting
 * readings `src/reported-usage.ts` and `src/run-efficiency.ts`). The calls into them, and the store's accounting reads,
 * live in large product files that ship without a person, so rather than protect those files whole this manifest
 * lists each required call and the function it must be in (EVAL_HOOKS), and each function whose body a release may not
 * change by itself (EVAL_PINNED). The INSTALLED plane checks a candidate's tree against it (`evalHookProblem`, called
 * from release-auto.ts changeProblem): a listed call missing or moved out of its function, its function gone, a pinned
 * body changed, or a listed file that doesn't parse, needs a person. This file is itself a policy path.
 *
 * The check reads the syntax tree (TypeScript's own parser, the runtime dependency `typescript-parser`): only a real
 * call expression of that name inside that top-level function counts, never a comment, a string or a regular
 * expression. It proves the call is in its function, not that it is reached (a call behind `if (false)` still reads as
 * present); a person reviewing a change to these files remains the backstop.
 */
import { createRequire } from "node:module";
import type ts from "typescript-parser";

let compiler: typeof ts | undefined;
const typescript = (): typeof ts => compiler ??= createRequire(import.meta.url)("typescript-parser") as typeof ts;

/** One required call: in this file, inside this top-level function, a call to this name. */
export type EvalHook = { file: string; inside: string; calls: string; why: string };
/** One function whose body (its text, as the candidate has it) must stay as the base has it. */
export type EvalPinned = { file: string; fn: string; why: string };

export const EVAL_HOOKS: readonly EvalHook[] = Object.freeze([
  { file: "src/deploy-gate.ts", inside: "deploymentGate", calls: "nightlyDebtHold", why: "GitHub's nightly holds every deploy" },
  { file: "src/store.ts", inside: "reserveRelease", calls: "releaseNightlyProblem", why: "GitHub's nightly holds the merge reservation" },
  { file: "src/store.ts", inside: "runReleaseOperation", calls: "releaseNightlyProblem", why: "GitHub's nightly holds a reserved operation's start" },
  { file: "src/store.ts", inside: "releaseNightlyProblem", calls: "nightlyDebtHold", why: "the store's nightly check reads the debt" },
  { file: "src/release.ts", inside: "runRelease", calls: "nightlyHolds", why: "GitHub's nightly holds deploy, merge and the tag" },
  { file: "src/release-adapters.ts", inside: "storeReleaseAdapter", calls: "nightlyBoundary", why: "the release's boundary read of GitHub's nightly" },
  { file: "src/release-auto.ts", inside: "sealAutoGreen", calls: "nightlyDebtHold", why: "GitHub's nightly holds automatic approval" },
  { file: "src/release-auto.ts", inside: "changeProblem", calls: "evalHookProblem", why: "this check itself" },
  { file: "src/release-auto.ts", inside: "changeProblem", calls: "autoPathProblem", why: "policy paths need a person" },
  // The invocation gateway (invoke.ts): every agent run an eval world spawns takes a dispatch slot.
  { file: "src/invoke.ts", inside: "invokeAgent", calls: "takeEvalDispatch", why: "every agent dispatch in an eval world takes a slot" },
  { file: "src/invoke.ts", inside: "invokeAgent", calls: "recordRunBillingBasis", why: "a run's billing says whether it was known or guessed" },
  { file: "src/subscription-chat.ts", inside: "performSubscriptionLeadRequest", calls: "takeEvalDispatch", why: "every subscription lead request in an eval world takes a slot" },
  { file: "src/converse.ts", inside: "performLeadRequest", calls: "takeEvalDispatch", why: "every direct lead request in an eval world takes a slot" },
  { file: "src/converse.ts", inside: "performChatRequest", calls: "takeEvalDispatch", why: "every fleet chat request in an eval world takes a slot" },
  { file: "src/memory-pass.ts", inside: "defaultAnalyzer", calls: "inEvalWorld", why: "the memory pass makes no unrecorded call in an eval world" },
  { file: "src/task-sizing.ts", inside: "claudeSizer", calls: "inEvalWorld", why: "task sizing makes no unrecorded call in an eval world" },
  { file: "src/flow-draft.ts", inside: "claudeDraftRunner", calls: "inEvalWorld", why: "flow drafts make no unrecorded call in an eval world" },
  { file: "src/subagents.ts", inside: "claudeTurnRunner", calls: "inEvalWorld", why: "subagent turns make no unrecorded call in an eval world" },
]);

export const EVAL_PINNED: readonly EvalPinned[] = Object.freeze([
  { file: "src/store.ts", fn: "runAccounting", why: "how a run's spending reads as API dollars, subscription usage or unknown" },
  { file: "src/store.ts", fn: "chatTurnAccounting", why: "how a chat request's spending reads" },
  { file: "src/store.ts", fn: "recordRunModelReported", why: "the exact model a run is held to its pin by" },
  { file: "src/store.ts", fn: "recordRunBillingBasis", why: "whether a run's billing was known" },
]);

type Parsed = { source: ts.SourceFile } | { problem: string };

/** A file's syntax tree, or why it can't be read (missing, or not valid TypeScript: a person decides). */
function parse(file: string, bytes: Buffer | null): Parsed {
  if (bytes === null) return { problem: `${file} can't be read` };
  const compiler = typescript();
  const source = compiler.createSourceFile(file, bytes.toString("utf8"), compiler.ScriptTarget.Latest, true, compiler.ScriptKind.TS);
  const diagnostics = (source as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics ?? [];
  return diagnostics.length === 0 ? { source } : { problem: `${file} doesn't parse` };
}

/** The one top-level function declaration with this name, or null when there is none or more than one. */
function topFunction(source: ts.SourceFile, name: string): ts.FunctionDeclaration | null {
  const compiler = typescript();
  const found = source.statements.filter((one): one is ts.FunctionDeclaration => compiler.isFunctionDeclaration(one) && one.name?.text === name);
  return found.length === 1 ? found[0]! : null;
}

/** Whether `node` holds a call expression whose callee is the plain identifier `name`. */
function calls(node: ts.Node, name: string): boolean {
  const compiler = typescript();
  let hit = false;
  const visit = (one: ts.Node): void => {
    if (hit) return;
    if (compiler.isCallExpression(one) && compiler.isIdentifier(one.expression) && one.expression.text === name) { hit = true; return; }
    compiler.forEachChild(one, visit);
  };
  visit(node);
  return hit;
}

/** A reader that parses each file once. */
function parser(read: (file: string) => Buffer | null): (file: string) => Parsed {
  const seen = new Map<string, Parsed>();
  return file => { if (!seen.has(file)) seen.set(file, parse(file, read(file))); return seen.get(file)!; };
}

/** Why `tree` doesn't hold this hook, or null. */
function hookMissing(tree: (file: string) => Parsed, hook: EvalHook): string | null {
  const parsed = tree(hook.file);
  if ("problem" in parsed) return `${parsed.problem}, and it holds a required call (${hook.why})`;
  const fn = topFunction(parsed.source, hook.inside);
  if (fn === null || fn.body === undefined) return `${hook.file} no longer has ${hook.inside} as one function, which must call ${hook.calls} (${hook.why})`;
  return calls(fn.body, hook.calls) ? null : `${hook.file}'s ${hook.inside} no longer calls ${hook.calls} (${hook.why})`;
}

/** A pinned function's text in `tree`, or null when it can't be found once. */
function pinnedText(tree: (file: string) => Parsed, pin: EvalPinned): string | null {
  const parsed = tree(pin.file);
  if ("problem" in parsed) return null;
  const fn = topFunction(parsed.source, pin.fn);
  return fn === null ? null : fn.getText(parsed.source);
}

/**
 * Why a candidate drops a required hook or changes a pinned body, or null. `candidate` gives a listed file's bytes at
 * the candidate (null: missing or unreadable, which needs a person too). With `base` (the plane's own record of where
 * the release started, which the candidate can't rewrite), only what the base holds is required: a project that isn't
 * Toolroll holds none, and a hook not yet landed can't be dropped.
 */
export function evalHookProblem(candidate: (file: string) => Buffer | null, base?: (file: string) => Buffer | null,
  hooks: readonly EvalHook[] = EVAL_HOOKS, pinned: readonly EvalPinned[] = EVAL_PINNED): string | null {
  const now = parser(candidate);
  const was = base === undefined ? null : parser(base);
  for (const hook of hooks) {
    if (was !== null && hookMissing(was, hook) !== null) continue;
    const missing = hookMissing(now, hook);
    if (missing !== null) return missing;
  }
  for (const pin of pinned) {
    const before = was === null ? null : pinnedText(was, pin);
    if (was !== null && before === null) continue;
    const after = pinnedText(now, pin);
    if (after === null) return `${pin.file} no longer has ${pin.fn} as one function (${pin.why})`;
    if (before !== null && after !== before) return `${pin.file}'s ${pin.fn} changed (${pin.why})`;
  }
  return null;
}

/** Every file the manifest reads, for one verified read of each tree. */
export const EVAL_HOOK_FILES: readonly string[] = Object.freeze([...new Set([...EVAL_HOOKS.map(hook => hook.file), ...EVAL_PINNED.map(pin => pin.file)])]);
