/** `toolroll models …`: what each CLI can run, whether the CLIs are
 * current, and the automatic check. The same saved catalog as Settings → Models. */
import { envelopeJson } from "./envelope.js";
import { checkModels, isNewModel, modelOptions, priceWords, RUNTIME_TOOLS, runtimeStates, seenModels, setWatch, updateRuntime, watchState, type CatalogSeams, type RuntimeTool } from "./model-catalog.js";
import { isProviderId } from "./provider.js";
import { canonicalProject } from "./project.js";
import { resultRecords } from "./route-results.js";
import { acceptSuggestion, dismissSuggestion, grantWords, keepRule, ruleById, ruleWords, rulesOf, suggestionsFor, suggestionWords, turnOffRule, type RuleRefusal } from "./route-rules.js";
import type { RuleDoor } from "./route-store.js";
import { currentLocalOwner } from "./local-owner.js";
import { REASON_WORDS } from "./contracts/route-results.js";
import type { Store } from "./store.js";
import { resolve } from "node:path";

const flags = [
  { name: "provider", takesValue: true, meaning: "claude, codex, gemini or openrouter, for models list" },
  { name: "json", takesValue: false, meaning: "versioned structured response" },
  { name: "db", takesValue: true, meaning: "local Toolroll database" },
] as const;
const resultFlags = [
  { name: "repo", takesValue: true, meaning: "one project's records (default: every project you can open)" },
  { name: "json", takesValue: false, meaning: "versioned structured response" },
  { name: "db", takesValue: true, meaning: "local Toolroll database" },
] as const;
const ruleFlags = [
  { name: "repo", takesValue: true, meaning: "the project (default: the one project you can open)" },
  { name: "as", takesValue: true, meaning: "your approver name" },
  { name: "token", takesValue: true, meaning: "your password (accepting and keeping take one typed now)" },
  { name: "json", takesValue: false, meaning: "versioned structured response" },
  { name: "db", takesValue: true, meaning: "local Toolroll database" },
] as const;
export const MODELS_DESCRIPTORS = [
  { action: "status", synopsis: "installed CLI versions, available updates, new models and the automatic check", mutation: "none", takesQuery: false, flags },
  { action: "list", synopsis: "models a provider can run, newest first, with prices (--provider claude|codex|gemini|openrouter)", mutation: "none", takesQuery: false, flags },
  { action: "check", synopsis: "fetch the public model lists and check CLI versions now", mutation: "unkeyed", takesQuery: false, flags },
  { action: "update", synopsis: "update one CLI while no work is running: models update claude|codex|gemini", mutation: "unkeyed", takesQuery: true, flags },
  { action: "watch", synopsis: "turn the 6-hourly check and its messages on or off: models watch on|off", mutation: "unkeyed", takesQuery: true, flags },
  { action: "results", synopsis: "each finished task's result record: which model built it, and whether it counts", mutation: "none", takesQuery: false, flags: resultFlags },
  { action: "suggestions", synopsis: "cheaper models a project's own results suggest, and its earned rules", mutation: "none", takesQuery: false, flags: resultFlags },
  { action: "accept", synopsis: "accept a suggestion as an earned rule, with its switch-back terms: models accept <id> --repo <p>", mutation: "unkeyed", takesQuery: true, positional: "the suggestion's id, as models suggestions lists it", flags: ruleFlags },
  { action: "dismiss", synopsis: "Not now: keep a suggestion quiet for 30 days: models dismiss <id> --repo <p>", mutation: "unkeyed", takesQuery: true, positional: "the suggestion's id, as models suggestions lists it", flags: ruleFlags },
  { action: "turn-off", synopsis: "turn an earned rule off, or drop a paused one: models turn-off <rule>", mutation: "unkeyed", takesQuery: true, positional: "the rule's number, as models suggestions lists it", flags: ruleFlags },
  { action: "keep", synopsis: "keep a paused earned rule: models keep <rule>", mutation: "unkeyed", takesQuery: true, positional: "the rule's number, as models suggestions lists it", flags: ruleFlags },
] as const;
/** `proof`: the person who proved themselves for this command — at the credential generation read before the proof,
 * and how — or null. The rule doors re-prove it inside their own transaction. */
export type ModelsCliContext = { store: Store; write: (line: string) => void; json: boolean; now: Date; actor: string | null; seams?: CatalogSeams;
  proof?: { actor: string; generation: number; method: string } | null };

export async function runModelsCommand(positional: readonly string[], options: Map<string, string | true>, context: ModelsCliContext): Promise<number> {
  const action = positional[0] ?? "status";
  const command = `models ${action}`;
  const fail = (reason: "usage" | "unauthenticated" | "refused", message: string) => { context.write(context.json ? envelopeJson({ ok: false, command, reason, message }) : message); return reason === "usage" ? 2 : 1; };
  const ok = (result: Record<string, unknown>, lines: string[]) => { context.write(context.json ? envelopeJson({ ok: true, command, ...result }) : lines.join("\n")); return 0; };
  if (!MODELS_DESCRIPTORS.some(one => one.action === action)) return fail("usage", "Use models status | list --provider <p> | check | update <claude|codex|gemini> | watch on|off | results | suggestions | accept <id> | dismiss <id> | turn-off <rule> | keep <rule>.");
  // This computer's local owner (local mode, through the terminal UI) may turn a rule off and say Not now: the door
  // re-checks that its in-flight act is exactly that one.
  const local = currentLocalOwner();
  if (context.actor === null && !(local !== null && (action === "turn-off" || action === "dismiss" || action === "suggestions"))) return fail("unauthenticated", "Sign in first: the remembered local login drives models commands.");
  const { store, now } = context;
  if (action === "results") return modelsResults(options, context, ok, fail);
  if (action === "suggestions" || action === "accept" || action === "dismiss" || action === "turn-off" || action === "keep") return modelsRules(action, positional, options, { ...context, actor: context.actor ?? local!.account }, ok, fail, local !== null && context.proof == null);
  const actor = context.actor;
  if (actor === null) return fail("unauthenticated", "Sign in first: the remembered local login drives models commands.");
  if (action === "status") {
    const runtimes = runtimeStates(store), watch = watchState(store);
    const fresh = (["claude", "codex", "gemini"] as const).flatMap(source => seenModels(store, source)).filter(model => isNewModel(model, now));
    return ok({ runtimes, watch, newModels: fresh }, [
      ...(runtimes.length === 0 ? ["No CLI versions checked yet. Run: toolroll models check"] : runtimes.map(one => `${one.name} ${one.installed ?? "?"}${one.behind ? ` · ${one.latest} available${one.updateCommand === null ? "" : ` (toolroll models update ${one.tool})`}` : " · up to date"}`)),
      ...fresh.map(model => `New: ${model.name} · ${priceWords(model)}`),
      `Automatic checks: ${watch.enabled ? "on" : "off"} · last checked ${watch.checkedAt ?? "never"}`,
    ]);
  }
  if (action === "list") {
    const provider = options.get("provider");
    if (typeof provider !== "string" || !isProviderId(provider)) return fail("usage", "Use --provider claude, codex, gemini or openrouter.");
    const models = modelOptions(store, provider, now);
    return ok({ provider, models }, models.length === 0 ? ["No models saved yet. Run: toolroll models check"] : models.map(one => `${one.value}  ${one.label}`));
  }
  if (action === "check") {
    const checked = await checkModels(store, now, context.seams);
    const notable = checked.added.filter(one => one.source !== "openrouter");
    if (!checked.ok) return fail("refused", checked.problem ?? "The model lists could not be fetched.");
    return ok({ added: notable, runtimes: checked.runtimes }, [
      notable.length === 0 ? "No new models." : `New: ${notable.map(one => one.name).join(", ")}`,
      ...checked.runtimes.filter(one => one.behind).map(one => `${one.name} ${one.latest} is available (you have ${one.installed}).`),
    ]);
  }
  if (action === "update") {
    const tool = positional[1] ?? "";
    if (!(tool in RUNTIME_TOOLS)) return fail("usage", "Name one CLI: models update claude|codex|gemini.");
    const updated = await updateRuntime(store, tool as RuntimeTool, actor, now, context.seams);
    return updated.ok ? ok({ tool, message: updated.message }, [updated.message]) : fail("refused", updated.message);
  }
  const wanted = positional[1];
  if (wanted !== "on" && wanted !== "off") return fail("usage", "Use models watch on or models watch off.");
  setWatch(store, wanted === "on", actor, now);
  return ok({ enabled: wanted === "on" }, [wanted === "on" ? "Automatic checks are on: every 6 hours, with a message for each new model or CLI update." : "Automatic checks are off."]);
}

/** `models results [--repo <p>]`: the saved result records of the projects this person can open, newest first — the
 * same records the task page's "Result record" line reads. Read-only. */
function modelsResults(options: Map<string, string | true>, context: ModelsCliContext,
  ok: (result: Record<string, unknown>, lines: string[]) => number, fail: (reason: "usage" | "unauthenticated" | "refused", message: string) => number): number {
  const { store } = context;
  for (const key of options.keys()) if (!["repo", "json", "db", "as", "token", "token-file", "token-env"].includes(key)) return fail("usage", `--${key} is not a models results option.`);
  const open = store.knownRepos().filter(repo => store.accountCanAccess(context.actor!, repo));
  const asked = options.get("repo");
  if (asked === true) return fail("usage", "--repo takes a project path.");
  const wanted = asked === undefined ? null : canonicalProject(asked) ?? resolve(asked);
  if (wanted !== null && !open.includes(wanted)) return fail("refused", "That project isn't one you can open here.");
  const records = resultRecords(store, wanted === null ? open : [wanted]);
  const counted = (state: string) => records.filter(one => one.state === state).length;
  const summary = `${records.length} record${records.length === 1 ? "" : "s"}: ${counted("mature")} counted, ${counted("rejected")} counted against, ${counted("provisional")} accepted and waiting, ${counted("pending")} pending, ${counted("not-counted")} not counted`;
  return ok({ records, reasons: REASON_WORDS }, records.length === 0
    ? ["No result records yet. A record starts when a task's first build runs."]
    : [summary, ...records.map(one => `${one.task} · ${one.model ?? "unknown model"}${one.size === null ? "" : ` · ${one.size}`} · ${one.words}`)]);
}

type Ok = (result: Record<string, unknown>, lines: string[]) => number;
type Fail = (reason: "usage" | "unauthenticated" | "refused", message: string) => number;

/**
 * Earned rules on the command line (docs/plans/results-routing.md, slice 2), the same doors Settings → Models uses:
 * `suggestions` reads; `accept` and `keep` take the person's own proof, re-proved inside the write (a lead token or a
 * remote token is refused there); `turn-off` and `dismiss` take the person, or this computer's local owner inside
 * exactly that act.
 */
function modelsRules(action: "suggestions" | "accept" | "dismiss" | "turn-off" | "keep", positional: readonly string[], options: Map<string, string | true>,
  context: ModelsCliContext & { actor: string }, ok: Ok, fail: Fail, asLocal: boolean): number {
  const { store, now } = context;
  const allowed = action === "suggestions" ? ["repo", "json", "db", "as", "token", "token-file", "token-env"] : ["repo", "json", "db", "as", "token", "token-file", "token-env"];
  for (const key of options.keys()) if (!allowed.includes(key)) return fail("usage", `--${key} is not a models ${action} option.`);
  const open = store.knownRepos().filter(repo => store.accountCanAccess(context.actor, repo));
  const asked = options.get("repo");
  if (asked === true) return fail("usage", "--repo takes a project path.");
  const wanted = asked === undefined ? null : canonicalProject(asked) ?? resolve(asked);
  if (wanted !== null && !open.includes(wanted)) return fail("refused", "That project isn't one you can open here.");
  if (action === "suggestions") {
    const repos = wanted === null ? open : [wanted];
    const suggestions = repos.flatMap(repo => suggestionsFor(store, repo, now));
    const rules = repos.flatMap(repo => rulesOf(store, repo, now));
    return ok({
      suggestions: suggestions.map(one => ({ id: one.id, repo: one.repo, size: one.cohortSize, model: one.model, name: one.name, configured: one.configured,
        evidence: one.evidence, configuredEvidence: one.configuredEvidence, prices: one.prices, terms: grantWords(one.grant), words: suggestionWords(one) })),
      rules: rules.map(one => ({ id: one.id, repo: one.repo, size: one.cohortSize, model: one.model, configured: one.configured, state: one.state, acceptedAt: one.acceptedAt,
        acceptedBy: one.acceptedBy, expires: one.grant?.expires ?? null, endedAt: one.endedAt, endReason: one.endReason, words: ruleWords(store, one) })),
    }, suggestions.length === 0 && rules.length === 0 ? ["No suggestions yet. A cheaper model is suggested once its results here match the configured one's."] : [
      ...suggestions.flatMap(one => [`Suggested · ${one.repo} · ${suggestionWords(one)}`, `  accept: toolroll models accept ${one.id} --repo ${one.repo}`, `  not now: toolroll models dismiss ${one.id} --repo ${one.repo}`]),
      ...rules.map(one => `Rule ${one.id} · ${one.repo} · ${ruleWords(store, one)}`),
    ]);
  }
  const target = positional[1];
  if (target === undefined || positional.length !== 2) return fail("usage", action === "accept" || action === "dismiss" ? `Name one suggestion: models ${action} <id> --repo <p>.` : `Name one rule: models ${action} <rule>.`);
  const proof = context.proof ?? null;
  const door: RuleDoor | null = proof !== null ? { kind: "person", person: { ...proof, live: () => true } } : asLocal ? { kind: "local-owner", actor: context.actor } : null;
  if (door === null) return fail("unauthenticated", "This takes your own sign-in: --as <you> --token <password>.");
  const said = (result: { ok: true } | RuleRefusal, payload: Record<string, unknown>, line: string) => result.ok ? ok(payload, [line]) : fail("refused", result.problem);
  if (action === "accept" || action === "dismiss") {
    const repo = wanted ?? (open.length === 1 ? open[0]! : null);
    if (repo === null) return fail("usage", "Name the project: --repo <p>.");
    if (action === "accept") {
      const accepted = acceptSuggestion(store, { repo, id: target }, door, now);
      return accepted.ok ? ok({ rule: accepted.rule, repo, model: accepted.suggestion.model, size: accepted.suggestion.cohortSize, terms: grantWords(accepted.suggestion.grant) },
        [`Rule ${accepted.rule}: ${suggestionWords(accepted.suggestion)}`, ...grantWords(accepted.suggestion.grant).map(line => `  ${line}`)]) : fail("refused", accepted.problem);
    }
    return said(dismissSuggestion(store, { repo, id: target }, door, now), { repo, id: target }, "Not now: this suggestion stays quiet for 30 days.");
  }
  const id = /^[1-9][0-9]{0,9}$/.test(target) ? Number(target) : null;
  const rule = id === null ? null : ruleById(store, id);
  if (rule === null || !open.includes(rule.repo)) return fail("refused", "That rule isn't one you can see here.");
  if (action === "turn-off") {
    const turned = turnOffRule(store, rule.id, door, now);
    return turned.ok ? ok({ rule: turned.rule.id, state: turned.rule.state }, [`Rule ${turned.rule.id} is off. Tasks already approved keep the model they were approved with.`]) : fail("refused", turned.problem);
  }
  const kept = keepRule(store, rule.id, door, now);
  return kept.ok ? ok({ rule: kept.rule.id, state: kept.rule.state }, [`Rule ${kept.rule.id} is on again: ${ruleWords(store, kept.rule)}`]) : fail("refused", kept.problem);
}
