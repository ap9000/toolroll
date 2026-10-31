/**
 * The eval and nightly enforcement hooks a release can't drop without a person (docs/plans/evals-nightly.md, part C,
 * "Policy code needs a person", Codex round 2 #10).
 *
 * The policy modules themselves are person-only by path (release-auto.ts autoPathProblem: `evals/`, `src/evals*.ts`,
 * `src/eval-*.ts`, `src/reviewer-evals.ts`, `src/nightly-github.ts`, `src/contracts/evals*.ts`). The calls into them
 * live in large product files that ship without a person, so rather than protect those files whole, this manifest
 * lists each required call and the function it must be in. The INSTALLED plane checks a candidate's tree against it
 * (`evalHookProblem`, called from release-auto.ts changeProblem): a listed call missing, moved out of its function, or
 * its function gone needs a person. This file is itself a policy path, so editing the list needs a person too.
 *
 * The check reads code, not comments or strings: both are blanked before searching, so a call kept only in a comment
 * or a string doesn't count. It proves the call is present in its function, not that it is reached (a call placed
 * behind `if (false)` still reads as present); a person reviewing a change to these files remains the backstop.
 */

/** One required call: in this file, inside this function, a call to this name. */
export type EvalHook = { file: string; inside: string; calls: string; why: string };

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
  { file: "src/invoke.ts", inside: "invokeAgent", calls: "takeEvalDispatch", why: "every agent dispatch in an eval world is capped and counted" },
  { file: "src/subscription-chat.ts", inside: "performSubscriptionLeadRequest", calls: "takeEvalDispatch", why: "every subscription lead request in an eval world is capped and counted" },
  { file: "src/converse.ts", inside: "performLeadRequest", calls: "takeEvalDispatch", why: "every direct lead request in an eval world is counted" },
  { file: "src/lead.ts", inside: "runLeadTurn", calls: "evalLeadAllowanceMicrousd", why: "a direct lead turn's reservation is held to the eval allowance" },
  { file: "src/task-sizing.ts", inside: "claudeSizer", calls: "inEvalWorld", why: "task sizing makes no uncapped call in an eval world" },
  { file: "src/flow-draft.ts", inside: "claudeDraftRunner", calls: "inEvalWorld", why: "flow drafts make no uncapped call in an eval world" },
  { file: "src/subagents.ts", inside: "claudeTurnRunner", calls: "inEvalWorld", why: "subagent turns make no uncapped call in an eval world" },
]);

/** Source with comments, strings and template literals blanked (same length, newlines kept), so only code is searched.
 * Regular expression literals are left as they are: a call hidden in one still fails closed only by being absent. */
export function codeOnly(source: string): string {
  const out = source.split("");
  let i = 0;
  const blank = (from: number, to: number): void => { for (let j = from; j < to && j < out.length; j++) if (out[j] !== "\n") out[j] = " "; };
  while (i < source.length) {
    const c = source[i]!, next = source[i + 1];
    if (c === "/" && next === "/") { const end = source.indexOf("\n", i); const stop = end === -1 ? source.length : end; blank(i, stop); i = stop; continue; }
    if (c === "/" && next === "*") { const end = source.indexOf("*/", i + 2); const stop = end === -1 ? source.length : end + 2; blank(i, stop); i = stop; continue; }
    if (c === "\"" || c === "'" || c === "`") {
      let j = i + 1;
      while (j < source.length && source[j] !== c) { if (source[j] === "\\") j++; else if (c !== "`" && source[j] === "\n") break; j++; }
      blank(i, j + 1);
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join("");
}

/** The named top-level function (a declaration, `export`ed or not, async or not) in code-only source: from its
 * declaration, past its parameter list, to the first closing brace at the start of a line (this codebase's top-level
 * functions end there). Null when there isn't exactly one such declaration. A close brace moved to a line's start inside the function
 * only shortens what is searched (fail closed). */
export function functionBody(code: string, name: string): string | null {
  const declaration = new RegExp(`(^|\\n)(export[ \\t]+)?(async[ \\t]+)?function\\*?[ \\t]+${name}[ \\t]*[(<]`, "g");
  const found = [...code.matchAll(declaration)];
  if (found.length !== 1) return null;
  const from = found[0]!.index!;
  // Past the parameter list (its object types may close at a line's start), parentheses balanced.
  let at = from + found[0]![0].length - 1;
  while (at < code.length && code[at] !== "(") at++;
  for (let depth = 0; at < code.length; at++) {
    if (code[at] === "(") depth++;
    else if (code[at] === ")" && --depth === 0) break;
  }
  const end = code.indexOf("\n}", at);
  return at >= code.length || end === -1 ? null : code.slice(from, end + 2);
}

/** A reader that reads each file once. */
const once = (read: (file: string) => Buffer | null): ((file: string) => Buffer | null) => {
  const seen = new Map<string, Buffer | null>();
  return file => { if (!seen.has(file)) seen.set(file, read(file)); return seen.get(file)!; };
};

/** The first listed hook `read`'s tree doesn't hold, in words, or null: a file missing or unreadable, its function gone
 * (or not one function), or the call absent from it. */
function firstMissing(read: (file: string) => Buffer | null, hooks: readonly EvalHook[], cache = new Map<string, string | null>()): { hook: EvalHook; words: string } | null {
  for (const hook of hooks) {
    if (!cache.has(hook.file)) { const bytes = read(hook.file); cache.set(hook.file, bytes === null ? null : codeOnly(bytes.toString("utf8"))); }
    const code = cache.get(hook.file)!;
    if (code === null) return { hook, words: `${hook.file} can't be read, and it holds a required call (${hook.why})` };
    const body = functionBody(code, hook.inside);
    if (body === null) return { hook, words: `${hook.file} no longer has ${hook.inside} as one function, which must call ${hook.calls} (${hook.why})` };
    if (!new RegExp(`(^|[^\\w$.])${hook.calls}\\s*\\(`).test(body)) return { hook, words: `${hook.file}'s ${hook.inside} no longer calls ${hook.calls} (${hook.why})` };
  }
  return null;
}

/**
 * Why a candidate drops a required hook, or null. `candidate` gives a listed file's bytes at the candidate (null:
 * missing or unreadable, which needs a person too). With `base` (the plane's own record of where the release started,
 * which the candidate can't rewrite), only the hooks the base holds are required: a project that isn't Toolroll holds
 * none, and a hook not yet landed can't be dropped.
 */
export function evalHookProblem(candidate: (file: string) => Buffer | null, base?: (file: string) => Buffer | null, hooks: readonly EvalHook[] = EVAL_HOOKS): string | null {
  const read = base === undefined ? null : once(base);
  const baseCode = new Map<string, string | null>();
  const required = read === null ? hooks : hooks.filter(hook => firstMissing(read, [hook], baseCode) === null);
  return firstMissing(candidate, required)?.words ?? null;
}
