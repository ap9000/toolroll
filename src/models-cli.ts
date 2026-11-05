/** `toolroll models …`: what each CLI can run, whether the CLIs are
 * current, and the automatic check. The same saved catalog as Settings → Models. */
import { envelopeJson } from "./envelope.js";
import { checkModels, isNewModel, modelOptions, priceWords, RUNTIME_TOOLS, runtimeStates, seenModels, setWatch, updateRuntime, watchState, type CatalogSeams, type RuntimeTool } from "./model-catalog.js";
import { isProviderId } from "./provider.js";
import { canonicalProject } from "./project.js";
import { resultRecords } from "./route-results.js";
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
export const MODELS_DESCRIPTORS = [
  { action: "status", synopsis: "installed CLI versions, available updates, new models and the automatic check", mutation: "none", takesQuery: false, flags },
  { action: "list", synopsis: "models a provider can run, newest first, with prices (--provider claude|codex|gemini|openrouter)", mutation: "none", takesQuery: false, flags },
  { action: "check", synopsis: "fetch the public model lists and check CLI versions now", mutation: "unkeyed", takesQuery: false, flags },
  { action: "update", synopsis: "update one CLI while no work is running: models update claude|codex|gemini", mutation: "unkeyed", takesQuery: true, flags },
  { action: "watch", synopsis: "turn the 6-hourly check and its messages on or off: models watch on|off", mutation: "unkeyed", takesQuery: true, flags },
  { action: "results", synopsis: "each finished task's result record: which model built it, and whether it counts", mutation: "none", takesQuery: false, flags: resultFlags },
] as const;
export type ModelsCliContext = { store: Store; write: (line: string) => void; json: boolean; now: Date; actor: string | null; seams?: CatalogSeams };

export async function runModelsCommand(positional: readonly string[], options: Map<string, string | true>, context: ModelsCliContext): Promise<number> {
  const action = positional[0] ?? "status";
  const command = `models ${action}`;
  const fail = (reason: "usage" | "unauthenticated" | "refused", message: string) => { context.write(context.json ? envelopeJson({ ok: false, command, reason, message }) : message); return reason === "usage" ? 2 : 1; };
  const ok = (result: Record<string, unknown>, lines: string[]) => { context.write(context.json ? envelopeJson({ ok: true, command, ...result }) : lines.join("\n")); return 0; };
  if (!MODELS_DESCRIPTORS.some(one => one.action === action)) return fail("usage", "Use models status | list --provider <p> | check | update <claude|codex|gemini> | watch on|off | results [--repo <p>].");
  if (context.actor === null) return fail("unauthenticated", "Sign in first: the remembered local login drives models commands.");
  const { store, now } = context;
  if (action === "results") return modelsResults(options, context, ok, fail);
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
    const updated = await updateRuntime(store, tool as RuntimeTool, context.actor, now, context.seams);
    return updated.ok ? ok({ tool, message: updated.message }, [updated.message]) : fail("refused", updated.message);
  }
  const wanted = positional[1];
  if (wanted !== "on" && wanted !== "off") return fail("usage", "Use models watch on or models watch off.");
  setWatch(store, wanted === "on", context.actor, now);
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
