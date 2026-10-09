/** Shared setup views over the existing project configuration and approval doors. */
import { html, joinHtml, postForm, type Html } from "./html.js";
import type { ProviderId } from "./provider.js";
import type { ProviderConnection } from "./provider-connection.js";
import { ASSISTANTS, type ModelChoice } from "./setup-guide.js";
import type { SetupInputs } from "./control-setup.js";
import { openRouterPicker, type OpenRouterModels } from "./openrouter-models.js";

export function connectionWords(connection: ProviderConnection): string {
  return {
    connected: "Connected", "signed-out": "Not signed in", "not-installed": "CLI not installed",
    unverified: "Not verified", "key-present": "API key saved · not verified", "key-works": "API key works", "key-refused": "API key refused", "missing-key": "API key needed",
  }[connection.state];
}
export function connectionHtml(provider: ProviderId, connection: ProviderConnection, task = ""): Html {
  const query = new URLSearchParams({ provider, ...(task ? { task } : {}) });
  return html`<div class="card assistant-account"><p><strong>${ASSISTANTS[provider].name} · ${connectionWords(connection)}</strong></p><p class="meta">${[connection.email, connection.plan, connection.method].filter(Boolean).join(" · ")}</p><p class="meta">Checked ${new Date(connection.checkedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short" })} on the computer running this console. Sign-in does not prove model access or remaining quota.</p><a class="button-link" href="/control/connection?${query.toString()}">${connection.state === "connected" ? "Manage connection" : "Connect account"}</a> · <a href="/control?${query.toString()}&amp;check-connection=1">Check again</a></div>`;
}
export function controlSetupHtml(data: {
  repo: string; csrf: string; provider: ProviderId; inputs: SetupInputs; models: ModelChoice[];
  connection: ProviderConnection; catalog: OpenRouterModels | null; task?: string;
  preparation: { command: string; label: string; evidence: string } | null;
  instructions: { installed: boolean; message?: string };
}): Html {
  const { provider, inputs, task = "" } = data;
  const query = new URLSearchParams({ provider, ...(task ? { task } : {}) });
  const model = data.catalog !== null
    ? openRouterPicker(data.catalog, inputs.model || null, `/control?${query}&refresh-models=1`)
    : html`<label>Model<input type="text" name="model" value="${inputs.model}" list="setup-models" required autocomplete="off" placeholder="Exact model id or supported alias"></label><datalist id="setup-models">${data.models.map(one => html`<option value="${one.value}">${one.label}</option>`)}</datalist>`;
  return html`<h1>Project setup</h1><p>${data.repo}</p><p class="meta">Choose the default builder for new tasks and the preparation command for this project.</p><nav class="assistant-picker row" aria-label="Choose provider">${joinHtml((Object.keys(ASSISTANTS) as ProviderId[]).map(id => html`<a class="button-link" href="/control?${new URLSearchParams({ provider: id, ...(task ? { task } : {}) }).toString()}"${id === provider ? html` aria-current="page"` : ""}>${ASSISTANTS[id].name}</a>`), " ")}</nav>${
    connectionHtml(provider, data.connection, task)}${
    postForm("/control/setup-preview", html`${model}<details class="setup-advanced"><summary>Project preparation</summary>${
      data.preparation === null ? "" : html`<p class="meta">Suggested from ${data.preparation.evidence}: ${data.preparation.label} — <code>${data.preparation.command}</code>. Review before approving.</p>`}<label>Preparation command<textarea name="command" rows="2" maxlength="2000">${inputs.command}</textarea></label><label>Preparation timeout in seconds<input name="seconds" type="number" min="1" max="3600" value="${inputs.seconds}" required></label><p class="meta">Preparation applies to subsequent runs, including already approved tasks. Saving setup does not execute it.</p></details><button type="submit">Review project setup</button>`,
      { attrs: { class: "card" }, hidden: { repo: data.repo, provider, task } })}<section class="card"><h2>Agent instructions</h2>${
    data.instructions.message ? html`<p>${data.instructions.message}</p>` : data.instructions.installed ? html`<p>Toolroll instructions are installed.</p>` :
      html`<p>Give the agent the project's Toolroll handoff instructions.</p>${postForm("/control/instructions-preview", html`<button>Review instructions</button>`, { hidden: { repo: data.repo } })}`}</section><p><a href="/fleet">Configure planning, repair, and review agents</a> · <a href="/tasks/new">Describe a task</a></p>`;
}

/** `fields` may still carry the session's csrf (a caller's habit): postForm writes the one CSRF field. */
export function setupPreviewHtml(inputs: SetupInputs, fields: Record<string, string>): Html {
  const { csrf: _csrf, ...rest } = fields;
  return html`<h1>Approve project setup</h1><div class="card"><p>${fields.repo ?? ""}</p><p><strong>Builder:</strong> ${inputs.provider} · ${inputs.model}</p><p><strong>Preparation:</strong></p><pre class="recap">${inputs.command || "No preparation command"}</pre><p>Preparation timeout: ${inputs.seconds} seconds.</p><p>The builder default applies to new tasks. Preparation applies to subsequent runs, including already approved tasks. Existing signed task settings and verification rules remain in force.</p>${
    postForm("/control/setup-approve", html`<label>Your password<input type="password" name="token" autocomplete="current-password" required></label><button>Approve project setup</button>`, { hidden: { ...rest, ...inputs } })}</div>`;
}
