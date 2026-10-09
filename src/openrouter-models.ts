/** Live discovery for the UI. Prices are USD, separate from rounded budget pins. */
import { createHash } from "node:crypto";
import { html, type Html } from "./html.js";
import { readCappedBody } from "./converse.js";
import { validModelId } from "./provider.js";

export type OpenRouterModel = {
  id: string; name: string; context: number | null; tools: boolean;
  input: number | null; output: number | null; cachedInput: number | null;
  extraCharges: boolean; conditionalPricing: boolean;
  /** Unix seconds when OpenRouter listed it — the closest thing to a release date. */
  created: number | null;
};
export type OpenRouterModels =
  | { ok: true; models: OpenRouterModel[]; source: "public" | "account"; checkedAt: string }
  | { ok: false; problem: string };

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
function price(value: unknown, units = 1_000_000): number | null {
  if ((typeof value !== "string" || !/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value)) && typeof value !== "number") return null;
  const amount = Number(value) * units;
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}
export function parseOpenRouterModels(data: unknown): OpenRouterModel[] | null {
  if (!Array.isArray(data) || data.length > 5_000) return null;
  const models = new Map<string, OpenRouterModel>();
  for (const value of data) {
    const row = record(value), pricing = record(row.pricing), architecture = record(row.architecture);
    if (typeof row.id !== "string" || !validModelId(row.id) || row.id.length > 128) continue;
    if (Array.isArray(architecture.output_modalities) && !architecture.output_modalities.includes("text")) continue;
    models.set(row.id, {
      id: row.id, name: typeof row.name === "string" ? row.name.slice(0, 150) : row.id,
      context: typeof row.context_length === "number" && Number.isSafeInteger(row.context_length) && row.context_length > 0 ? row.context_length : null,
      tools: Array.isArray(row.supported_parameters) && row.supported_parameters.includes("tools"),
      input: price(pricing.prompt), output: price(pricing.completion), cachedInput: price(pricing.input_cache_read),
      extraCharges: ["request", "image", "web_search", "internal_reasoning", "input_cache_write"].some(key => (price(pricing[key], 1) ?? 0) > 0),
      conditionalPricing: Array.isArray(pricing.overrides) && pricing.overrides.length > 0,
      created: typeof row.created === "number" && Number.isSafeInteger(row.created) && row.created > 0 ? row.created : null,
    });
  }
  return [...models.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function fetchOpenRouterModels(key: string | null, fetcher: typeof fetch = fetch): Promise<OpenRouterModels> {
  try {
    const response = await fetcher(`https://openrouter.ai/api/v1/models${key === null ? "" : "/user"}`, {
      headers: key === null ? { accept: "application/json" } : { accept: "application/json", authorization: `Bearer ${key}` },
      redirect: "error", signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { ok: false, problem: response.status === 401 || response.status === 403
        ? "OpenRouter rejected this key. Update your connection and try again."
        : "OpenRouter’s model list is unavailable. Try again shortly." };
    }
    const body = await readCappedBody(response, 8_388_608);
    if (body === null) return { ok: false, problem: "OpenRouter’s model list was too large to load. Try again shortly." };
    const models = parseOpenRouterModels(record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body))).data);
    if (models === null) return { ok: false, problem: "OpenRouter returned an unreadable model list. Try again shortly." };
    return { ok: true, models, source: key === null ? "public" : "account", checkedAt: new Date().toISOString() };
  } catch {
    return { ok: false, problem: "Couldn’t load models from OpenRouter. Check your connection and try again." };
  }
}

/** One bounded cache per console. A changed/removed key cannot reuse another account's list. */
export function openRouterModelsCache(fetcher: typeof fetch = fetch) {
  let cache: { fingerprint: string; expires: number; result: OpenRouterModels } | null = null;
  let pending: { fingerprint: string; result: Promise<OpenRouterModels> } | null = null;
  return async (key: string | null, refresh = false): Promise<OpenRouterModels> => {
    const fingerprint = createHash("sha256").update(key ?? "public").digest("hex");
    if (!refresh && cache?.fingerprint === fingerprint && cache.expires > Date.now()) return cache.result;
    if (pending?.fingerprint === fingerprint) return pending.result;
    const result = fetchOpenRouterModels(key, fetcher);
    pending = { fingerprint, result };
    const value = await result;
    // An older request finishing late must not overwrite a newer key's cache.
    if (pending?.result === result) {
      cache = { fingerprint, expires: Date.now() + (value.ok ? 600_000 : 30_000), result: value };
      pending = null;
    }
    return value;
  };
}

export function modelDollars(amount: number | null): string {
  if (amount === null) return "Not reported";
  if (amount === 0) return "$0";
  if (amount < 0.00000001) return "<$0.00000001";
  return "$" + amount.toLocaleString("en-US", { maximumFractionDigits: 8 });
}
function details(model: OpenRouterModel): string {
  return `Input ${modelDollars(model.input)} · Output ${modelDollars(model.output)}${model.cachedInput === null ? "" : ` · Cached input ${modelDollars(model.cachedInput)}`} per 1M tokens. ` +
    (model.context === null ? "" : `${model.context.toLocaleString("en-US")} token context. `) +
    (model.tools ? "Tool calling supported. " : "Tool calling not listed. ") +
    (model.conditionalPricing ? "Rates change with context length or other conditions. " : "") +
    (model.extraCharges ? "Additional usage charges may apply. " : "") + "Actual charges depend on routing and usage.";
}
export function openRouterPicker(catalog: OpenRouterModels, selected: string | null, refreshUrl: string): Html {
  const rows = catalog.ok ? catalog.models : [];
  const current = rows.find(row => row.id === selected);
  const manual = selected && !current ? html`<option selected value="${selected}" data-detail="This saved model is not in the loaded catalog. Availability and pricing are unverified.">${selected} · Saved choice</option>` : "";
  return html`<div data-openrouter-picker><p class="meta">${catalog.ok
    ? `${rows.length} text models · ${catalog.source === "account" ? "Filtered for your OpenRouter account" : "Public catalog · Connect a key to check your account"} · Updated ${catalog.checkedAt.slice(11, 16)} UTC`
    : catalog.problem} <a href="${refreshUrl}">Refresh models</a></p><label data-model-search hidden>Search models<input type="search" placeholder="Search by name or provider" autocomplete="off"></label><label>Model<select name="model" aria-describedby="openrouter-price"><option value="__custom__"${selected === null ? html` selected` : ""}>Choose a model</option>${manual}${rows.map(row => html`<option value="${row.id}" data-detail="${details(row)}"${row.id === selected ? html` selected` : ""}>${row.name} · ${modelDollars(row.input)} in / ${modelDollars(row.output)} out per 1M</option>`)}</select></label><p id="openrouter-price" class="meta" aria-live="polite">${current ? details(current) : selected ? "This saved model is not in the loaded catalog. Availability and pricing are unverified." : "Choose a model to see its token prices and context size."}</p><p data-model-count class="meta" aria-live="polite"></p><p class="meta"><a href="https://openrouter.ai/models" target="_blank" rel="noreferrer">Compare models on OpenRouter ↗</a> · Prices in USD; catalog browsing uses no model tokens.</p></div>`;
}

/** Only filters already-rendered options; credentials never enter this script. */
export function openRouterPickerScript(): string {
  return `(function(){document.querySelectorAll('[data-openrouter-picker]').forEach(function(root){
    var search=root.querySelector('input[type=search]'),select=root.querySelector('select'),price=root.querySelector('#openrouter-price'),count=root.querySelector('[data-model-count]');
    if(!search||!select)return;root.querySelector('[data-model-search]').hidden=false;
    var options=Array.from(select.options),chosen=select.value;
    function filter(){var q=search.value.trim().toLowerCase(),matches=options.filter(function(o){return o.value!=='__custom__'&&(o.textContent+' '+o.value).toLowerCase().includes(q)});
      select.replaceChildren();options.forEach(function(o){if(o.value==='__custom__'||o.value===chosen||matches.includes(o))select.appendChild(o)});select.value=chosen;
      count.textContent=q?matches.length+' matches'+(chosen!=='__custom__'&&!matches.some(function(o){return o.value===chosen})?' · your selection is kept':''):'';
    }
    select.addEventListener('change',function(){chosen=select.value;price.textContent=select.selectedOptions[0].dataset.detail||'Choose a model to see its token prices and context size.';filter()});search.addEventListener('input',filter);
  })})();`;
}
