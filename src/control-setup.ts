import { createHash } from "node:crypto";
import { hasDisguisedText } from "./decision.js";
import type { Store } from "./store.js";
import { authenticateApprover } from "./scope.js";
import { isProviderId, validateSpec } from "./provider.js";
import { INSTALLATION_SCOPE } from "./agentconfig.js";
import { ALL_SLOTS, applyModelChoices, DEFAULT_PRESET, presetChange, previewModelChange, rowAt } from "./model-choices.js";


export type SetupInputs = { provider: string; model: string; command: string; seconds: string };
export function previewSetup(store: Store, repo: string, inputs: SetupInputs) {
  if (!isProviderId(inputs.provider)) return { ok: false as const, message: "Choose an installed provider." };
  if (inputs.model.trim() === "__custom__") return { ok: false as const, message: "Choose an exact model before reviewing setup." };
  const spec = validateSpec({ provider: inputs.provider, model: inputs.model.trim() });
  if (!spec.ok) return { ok: false as const, message: spec.problem };
  const command = inputs.command.trim();
  if (command.length > 2000 || hasDisguisedText(command)) return { ok: false as const, message: "Use a setup command under 2000 characters without control characters." };
  if (/([A-Za-z0-9_-]*(?:token|secret|password|passwd|apikey|api_key|authorization|bearer|credential)[A-Za-z0-9_-]*\s*[=:]\s*)(?![$"']?\$)\S+/i.test(command) || /\/\/[^\s/@]+:[^\s/@]+@/.test(command)) return { ok: false as const, message: "Remove literal credentials from the setup command." };
  const seconds = Number(inputs.seconds);
  if (!/^[1-9][0-9]*$/.test(inputs.seconds) || !Number.isInteger(seconds) || seconds < 1 || seconds > 3600) return { ok: false as const, message: "Setup timeout must be 1–3600 seconds." };
  const models = installationModels(store);
  const fingerprint = createHash("sha256").update(JSON.stringify({ repo, inputs, beforeSetup: store.liveWorktreeSetup(repo), beforeConfig: store.phaseConfig(repo, "build"),
    ...(models === null ? {} : { models: [models.state, models.change] }) })).digest("hex");
  return { ok: true as const, fingerprint, command, seconds, provider: inputs.provider, model: inputs.model.trim(), models };
}

export function approveSetup(store: Store, repo: string, inputs: SetupInputs, fingerprint: string, by: string, token: string, now: Date) {
  return store.transact(() => {
    const proved = authenticateApprover(store, by, token, repo);
    if (!proved.ok) return { ok: false as const, message: "Your operator credential is required." };
    const preview = previewSetup(store, repo, inputs);
    if (!preview.ok) return preview;
    if (preview.fingerprint !== fingerprint) return { ok: false as const, message: "Setup changed. Review it again." };
    if (preview.models !== null) {
      // The installation's models, through Settings → Models' one write path (an instance operator's act). The proof
      // above ran in this same transaction, so the generation read here is the one it was checked against.
      if (!store.isInstanceOperator(by)) return { ok: false as const, message: "Models for this installation aren't chosen yet. An instance operator sets them up first." };
      const applied = applyModelChoices(store, { scope: INSTALLATION_SCOPE, change: presetChange(DEFAULT_PRESET), expected: { state: preview.models.state, change: preview.models.change }, strict: true, knownProject: () => false },
        { actor: by, generation: store.accountOf(by)?.generation ?? -1, method: proved.method, live: () => true }, now);
      if (!applied.ok) return { ok: false as const, message: applied.problem };
    }
    // The project's own builder only when it differs from what it inherits: a project left on the installation's
    // routine builder keeps following the installation's sizes and presets.
    const inherited = store.phaseConfig(INSTALLATION_SCOPE, "build");
    const same = inherited !== null && inherited.provider === preview.provider && inherited.model === preview.model;
    if (!same || store.phaseConfig(repo, "build") !== null) store.setPhaseConfig(repo, "build", preview.provider, preview.model, by, now);
    if (preview.command === "") store.clearWorktreeSetup(repo, by, now);
    else store.setWorktreeSetup({ repo, command: preview.command, timeoutMs: preview.seconds * 1000, approvedBy: by }, now);
    return { ok: true as const };
  });
}

// Last in the file, so the password tripwire's function positions (password-freshness.test.ts) stay as reviewed.
/** A new installation, nothing chosen yet: setup applies the default preset ("Sized by job") with the project's
 * builder, previewed here row by row, so the first task files on exact models for every size. */
function installationModels(store: Store) {
  if (!ALL_SLOTS.every(slot => rowAt(store, INSTALLATION_SCOPE, slot) === null)) return null;
  return previewModelChange(store, INSTALLATION_SCOPE, presetChange(DEFAULT_PRESET));
}
