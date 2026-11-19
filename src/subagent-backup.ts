/** Claude stays primary. Only an explicitly enabled, counted, plan-backed Codex attempt may follow a proven refusal. */
import { Buffer } from "node:buffer";
import type { Store, SubagentRow, FlowCardRow } from "./store.js";
import { claudeTurnRunner, type TurnReply, type TurnRequest } from "./subagents.js";
import { TURN_MODEL_SCHEMA } from "./contracts/subagent-turn.js";
import { strictJsonParse } from "./converse.js";
import { performSubscriptionLeadRequest } from "./subscription-chat.js";
import { run } from "./exec.js";
import type { CommandRunner } from "./claude-print.js";
import { ALL_CREDENTIAL_ENV } from "./provider.js";
import { claudeMachineBilling } from "./spend.js";
import { inEvalWorld } from "./eval-gate.js";

export type SubagentAttempt = { reply: TurnReply; provider: "claude" | "codex"; model: string; backup: boolean; authorize: () => string | null };

export async function subagentAttemptWithBackup(store: Store, mate: SubagentRow, card: FlowCardRow, request: TurnRequest & { flowRevision?: number },
  runner: CommandRunner = run, clock: () => Date = () => new Date(), elapsedNow: () => number = () => performance.now()): Promise<SubagentAttempt> {
  const started = elapsedNow();
  const remaining = () => Math.max(0, Math.min(request.timeoutMs, request.timeoutMs - (elapsedNow() - started)));
  const failure = (said: string, provider: "claude" | "codex" = "claude", model = request.model): SubagentAttempt => ({ reply: { ok: false, said }, provider, model, backup: provider === "codex", authorize: () => said });
  if (inEvalWorld()) return failure("Subagents don't run in an eval world.");
  if (remaining() <= 0) return failure("The original turn deadline elapsed.");
  const originalFlow = store.getFlow(card.flow);
  const flowRevision = request.flowRevision ?? originalFlow?.revision;
  if (flowRevision === undefined) return failure("The flow is no longer available.");
  const freshnessProblem = (provider: "claude" | "codex", model: string): string | null => {
    if (remaining() <= 0) return "The original turn deadline elapsed before the answer could be used.";
    const liveMate = store.getSubagent(mate.id), liveCard = store.getFlowCard(card.id), liveFlow = store.getFlow(card.flow);
    if (liveMate?.state !== "active" || liveMate.authorityGeneration !== mate.authorityGeneration || liveCard?.state !== "active" || liveCard.entry !== card.entry || liveCard.stage !== card.stage || liveFlow?.revision !== flowRevision || liveFlow?.state !== "active") return "The attempt's permission or card changed before its answer could be used.";
    if (provider === "codex" && liveMate.codexBackupModel !== model) return "The Codex backup's permission changed before its answer could be used.";
    return store.agentPolicyRefusal(provider, model);
  };
  const primary = store.reserveSubagentAttempt({ subagent: mate.id, card: card.id, cardEntry: card.entry, stage: card.stage, authorityGeneration: mate.authorityGeneration, flowRevision, provider: "claude", model: request.model, billing: claudeMachineBilling(store.handle) }, clock());
  if (!primary.ok) return failure(primary.why);
  let first: TurnReply;
  try { first = await claudeTurnRunner(runner)({ ...request, timeoutMs: remaining() }); }
  catch { first = { ok: false, said: "Claude's attempt stopped without a decision." }; }
  const primaryProblem = freshnessProblem("claude", request.model);
  if (first.ok && primaryProblem !== null) first = { ...first, ok: false, said: primaryProblem };
  store.settleSubagentAttempt(primary.id, { ...first, ms: elapsedNow() - started, ...(!first.ok && first.backupReason !== undefined ? { failureKind: first.backupReason } : {}) });
  if (!first.ok && primaryProblem !== null) return failure(primaryProblem);
  if (first.ok || first.backupReason === undefined || remaining() <= 0) return { reply: first, provider: "claude", model: request.model, backup: false, authorize: () => freshnessProblem("claude", request.model) };

  // A live plan proof, using the same credential-free environment as the model call. Unknown/key billing refuses.
  let signedIn = false;
  try {
    const status = await runner("codex", ["login", "status"], { timeoutMs: Math.min(15_000, remaining()), maxBuffer: 65_536, omitEnv: ALL_CREDENTIAL_ENV, processGroup: true });
    const said = `${status.stdout}\n${status.stderr}`;
    signedIn = status.code === 0 && !status.timedOut && !status.notFound && /^Logged in using ChatGPT\s*$/m.test(said) && !/api key|bedrock/i.test(said);
  } catch { /* no proof: no backup */ }
  if (!signedIn || remaining() <= 0) return failure(`${first.said} Codex backup needs a current ChatGPT sign-in.`);
  const current = store.getSubagent(mate.id);
  const model = current?.codexBackupModel;
  if (model === null || model === undefined) return failure(`${first.said} Codex backup is no longer enabled.`);
  const backup = store.reserveSubagentAttempt({ subagent: mate.id, card: card.id, cardEntry: card.entry, stage: card.stage, authorityGeneration: mate.authorityGeneration, flowRevision, provider: "codex", model, billing: "subscription", backupOf: primary.id }, clock());
  if (!backup.ok) return failure(`${first.said} ${backup.why}`);
  const began = elapsedNow();
  let reply: TurnReply;
  let modelReported: string | null = null;
  try {
    if (remaining() <= 0) throw new Error("The original turn deadline elapsed.");
    const answered = await performSubscriptionLeadRequest({ provider: "codex-subscription", model, system: "You decide one flow-card turn. Return exactly the supplied subagent decision schema. You have no native tools, repository or MCP access. The host validates any requested project-tool action separately.", dataDocument: request.prompt, history: [], tools: [], outputSchema: TURN_MODEL_SCHEMA, timeoutMs: remaining() }, runner);
    if (!answered.ok) reply = { ok: false, said: `Codex backup couldn't decide (${answered.problem}).` };
    else {
      modelReported = answered.answer.modelReported ?? null;
      const parsed = strictJsonParse(Buffer.from(answered.answer.text, "utf8"), 65_536, 12);
      const usage = { tokensIn: answered.answer.tokensIn, tokensOut: answered.answer.tokensOut,
        ...(answered.answer.reportedCostUsd == null ? {} : { costUsd: answered.answer.reportedCostUsd }) };
      reply = parsed.ok ? { ok: true, value: parsed.value, ms: elapsedNow() - began, ...usage }
        : { ok: false, said: "Codex backup's answer wasn't a decision.", ...usage };
    }
  } catch { reply = { ok: false, said: "Codex backup stopped without a decision." }; }
  const backupProblem = freshnessProblem("codex", model);
  if (backupProblem !== null) reply = { ...reply, ok: false, said: backupProblem };
  store.settleSubagentAttempt(backup.id, { ...reply, ms: elapsedNow() - began, modelReported });
  return { reply, provider: "codex", model: modelReported ?? model, backup: true, authorize: () => freshnessProblem("codex", model) };
}
