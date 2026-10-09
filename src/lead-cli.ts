import { configureLeadFollow, leadFollowStatus } from './lead-follow.js';
/**
 * `toolroll chat` (mate arc §6): the same thread the console shows,
 * driven from a terminal. The password is typed once — it mints the lead
 * session, the one ceremony a conversation gets — and every later turn
 * debits that session without asking again. Confirming a card runs the
 * same doors the console runs; password-class acts (approving a scope,
 * cancelling) print where to do them instead of doing them here.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LEAD_ASK_OTHER, type ChatConfig, type DirectChatProviderId, type LeadProposal, type Store, type SubscriptionChatProviderId } from "./store.js";
import { CHAT_KEY_ENV, credentialKeyOf, isDirectChatProvider, priceForConfig, subscriptionCredentialKey } from "./converse.js";
import { verifyApproverByPassword, type VerifiedApprover } from "./principal.js";
import { runLeadTurn, type LeadTurnOutcome } from "./lead.js";
import { voiceReply, type ShapeOptions } from "./reply-shape.js";
import { confirmLeadProposal, dismissLeadProposal } from "./lead-doors.js";
import { projectName } from "./project.js";
import type { SubscriptionLeadRunner } from "./subscription-chat.js";
import { CHAT_CONTROLS, chatControlHref, isChatControl } from "./chat-controls.js";
import { CHAT_TASK_ACTIONS, isChatTaskAction } from "./chat-task-actions.js";

export type LeadCliSeams = {
  fetcher?: typeof fetch;
  env?: Record<string, string | undefined>;
  /** Lines the REPL reads instead of stdin (tests). */
  lines?: AsyncIterable<string> | Iterable<string>;
  clock?: () => Date;
  /** Subscription harness seam; tests never consume a real membership turn. */
  subscriptionRunner?: SubscriptionLeadRunner;
};

export type LeadCliInput = {
  store: Store;
  databaseFile: string;
  write: (line: string) => void;
  json: boolean;
  credentials: { name: string; token: string };
  /** The ceiling: explicit `--repo` paths, or the enrolled projects when none are named. */
  repos: readonly string[];
  say: string | undefined;
  end: boolean;
  follow?: boolean;
  ceilingUsd: number | undefined;
  seams?: LeadCliSeams;
  /** Where evidence lives — a scout's report reads from here. */
  evidenceRoot?: string;
  /** The console's address(es): a reply's links there are named as its pages ("the task"), not by host. */
  appOrigin?: ShapeOptions["appOrigin"];
};

export type LeadCliResult = { code: number; reason?: string; message?: string };

export const LEAD_CLI_EXIT = { ok: 0, failed: 1, usage: 2, refused: 3 } as const;

function money(microusd: number): string {
  return `$${(microusd / 1_000_000).toFixed(2)}`;
}

function keyFor(config: ChatConfig & { provider: DirectChatProviderId }, databaseFile: string, env: Record<string, string | undefined>): string | null {
  const fromEnv = env[CHAT_KEY_ENV[config.provider]];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  try {
    const read = readFileSync(join(dirname(databaseFile), `chat-key-${config.provider}`), "utf8").trim();
    return read === "" ? null : read;
  } catch {
    return null;
  }
}

/**
 * What a terminal must show before an answer is confirmed (v3 review,
 * finding 4): the question, every option with its consequence, which one
 * the builder recommends, which one is proposed — the card's content.
 */
export function answerContextLines(store: Store, payload: Record<string, unknown>): string[] {
  const id = typeof payload["decision"] === "number" ? payload["decision"] : null;
  const decision = id === null ? null : store.getDecision(id);
  if (decision === null) return ["     (the decision is gone)"];
  const pick = typeof payload["option"] === "string" ? payload["option"] : "";
  return [
    `     ${decision.question}${decision.state !== "open" ? ` [${decision.state}]` : ""}`,
    ...decision.options.map(
      one =>
        `     ${one.id === pick ? "→" : " "} ${one.label}${one.reversible ? "" : " (irreversible)"}${one.id === decision.recommendation ? " — the builder recommends this" : ""}: ${one.consequence}`,
    ),
  ];
}

/** One line per proposal, numbered in thread order, for the operator to name. */
export function proposalLines(proposals: readonly LeadProposal[], repos: readonly string[], ordinal: (proposal: LeadProposal) => number = (_p) => 0): string[] {
  return proposals.map((one, index) => {
    const number = ordinal(one) || index + 1;
    const payload = one.payload;
    const t = (key: string): string => (typeof payload[key] === "string" ? (payload[key] as string) : "");
    const repoLabel = (() => {
      const id = t("repoId");
      const path = /^r[0-9]+$/.test(id) ? repos[Number(id.slice(1)) - 1] : undefined;
      return path === undefined ? id : `${id} ${projectName(path)}`;
    })();
    const what = one.kind === "task_action"
      ? `${isChatTaskAction(payload["operation"]) ? CHAT_TASK_ACTIONS[payload["operation"]].label : "Unavailable"}: ${t("taskTitle") || t("task")}${t("dependencyTitle") ? ` · ${t("dependencyTitle")}` : ""}`
      : one.kind === "review"
      ? `${t("operation") === "revise" ? "request a revision" : "save feedback"} for ${t("taskTitle") || t("task")}: ${t("note")}${Array.isArray(payload["notes"]) && payload["notes"].length > 0 ? ` (saved notes: ${payload["notes"].join(", ")})` : ""}`
      : one.kind === "control"
      ? (isChatControl(payload["control"]) ? `${CHAT_CONTROLS[payload["control"]].label}: ${chatControlHref(payload["control"], t("task"), payload["run"], payload["project"])} (open in the console)` : "control unavailable")
      : one.kind === "steer" ? `guide ${t("task")}'s next attempt: ${t("note")}`
      : one.kind === "agents" ? `change agents for ${t("task")}: ${t("role")} ${t("provider")} ${t("model")} ${t("risk")}`
      : one.kind === "repair" ? `${t("operation")} dependency ${t("blocker")} for ${t("task")}`
      :
      one.kind === "task"
        ? `file "${t("title")}" in ${repoLabel}${payload["report"] === true ? " (a scout task — it delivers a report, never a branch)" : ""}`
        : one.kind === "next"
          ? `move ${t("task")} to the front (was ${String(payload["position"] ?? "?")} of ${String(payload["of"] ?? "?")})`
          : one.kind === "reserve"
            ? `${payload["worker"] === null ? `release ${t("task")} to the shared queue` : `reserve ${t("task")} for ${t("worker")}`}`
            : one.kind === "hold"
              ? `hold ${t("task")}: ${t("reason")}`
              : one.kind === "unhold"
                ? `release ${t("task")} from its hold`
                : one.kind === "answer"
                  ? `answer decision #${String(payload["decision"])} on ${t("task")} with "${t("optionLabel")}"${payload["reversible"] === false ? " (irreversible — confirm N yes)" : ""}: ${t("rationale")}`
                  : one.kind === "scope"
                  ? `rewrite the scope of ${t("task")} (then approve it: toolroll task approve ${t("task")})`
                  : `cancel ${t("task")}: ${t("reason")} (arm it yourself: toolroll task cancel ${t("task")})`;
    const state = one.state === "pending" ? "" : ` [${one.state}${one.outcome !== null && typeof (one.outcome as { said?: unknown }).said === "string" ? `: ${(one.outcome as { said: string }).said}` : ""}]`;
    return `  ${number}. ${what}${state}`;
  });
}

/** The lines for one proposal, its answer context included when it is an answer. */
export function proposalBlock(store: Store, proposal: LeadProposal, repos: readonly string[], number: number): string[] {
  const [line] = proposalLines([proposal], repos, () => number);
  if (proposal.kind === "review") {
    const snapshot = proposal.payload["snapshot"] as import("./chat-review.js").ReviewSnapshot | undefined;
    const selected = Array.isArray(proposal.payload["notes"]) ? proposal.payload["notes"] as number[] : [];
    const notes = snapshot?.notes.filter(one => selected.includes(one.id)) ?? [];
    return [line as string, ...notes.map(one => `     ${one.path === null ? "" : `${one.path}${one.line === null ? "" : `:${one.line}`}: `}${one.note}`),
      proposal.payload["operation"] === "revise" ? "     Creates a revision of the same task; approval is separate." : "     Saves feedback; no work starts."];
  }
  return proposal.kind === "answer" ? [line as string, ...answerContextLines(store, proposal.payload)] : [line as string];
}

async function* linesOf(seams: LeadCliSeams | undefined): AsyncGenerator<string> {
  if (seams?.lines !== undefined) {
    for await (const line of seams.lines) yield line;
    return;
  }
  const { createInterface } = await import("node:readline");
  const reader = createInterface({ input: process.stdin, terminal: false });
  try {
    for await (const line of reader) yield line;
  } finally {
    reader.close();
  }
}

export async function runLeadCli(input: LeadCliInput): Promise<LeadCliResult> {
  const { store, write, json } = input;
  const seams = input.seams ?? {};
  const clock = seams.clock ?? (() => new Date());
  const env = seams.env ?? process.env;
  const say = (line: string): void => {
    if (!json) write(line);
  };
  const emit = (envelope: Record<string, unknown>): void => {
    if (json) write(JSON.stringify({ command: "chat", ...envelope }));
  };
  const refuse = (reason: string, message: string, code: number = LEAD_CLI_EXIT.refused): LeadCliResult => {
    if (json) write(JSON.stringify({ ok: false, command: "chat", reason, message }));
    else write(message);
    return { code, reason, message };
  };

  if (store.isDemo()) return refuse("demo", "this is a demo database — chat cannot contact an external model");
  const config = store.getChatConfig();
  if (config === null) return refuse("unconfigured", "chat is not configured — choose a membership or direct API provider with toolroll config set chat");
  const directProvider = isDirectChatProvider(config.provider) ? config.provider : null;
  const subscriptionProvider = directProvider === null ? config.provider as SubscriptionChatProviderId : null;
  const direct = directProvider !== null;
  if (direct && priceForConfig(config) === null) return refuse("unpriced", `no pinned price for ${config.model} — re-save the chat configuration`);
  const key = direct ? keyFor(config as ChatConfig & { provider: DirectChatProviderId }, input.databaseFile, env) : null;
  if (direct && key === null) return refuse("no-key", `no ${directProvider} key — export ${CHAT_KEY_ENV[directProvider]}, or paste one on the console's chat page`);
  const repos = [...input.repos];
  if (repos.length === 0) return refuse("empty-ceiling", "The lead has no projects to look at. Name some with --repo, or add projects in the console.", LEAD_CLI_EXIT.usage);

  const verified = verifyApproverByPassword(store, input.credentials.name, input.credentials.token, repos);
  if (!verified.ok) return refuse("unauthenticated", "that is not an approver, or the password does not match");
  const who: VerifiedApprover = verified.who;
  let now = clock();

  if (input.end) {
    const turns = store.failLiveLeadTurnsFor(who.name, "ended", now);
    const sessions = store.endLeadSessionsFor(who.name, who.name, now);
    const threads = store.closeLeadThreadsFor(who.name, now);
    emit({ ok: true, ended: { sessions, threads, turns } });
    say(sessions === 0 ? "No conversation was open, so there was nothing to end." : "The conversation has ended and its history is forgotten.");
    return { code: LEAD_CLI_EXIT.ok };
  }

  store.sweepStaleLeadTurns(now);
  let session = store.activeLeadSession(who.name);
  const credentialKey = direct ? credentialKeyOf(directProvider, key as string) : subscriptionCredentialKey(subscriptionProvider as SubscriptionChatProviderId);
  if (session !== null && session.credentialKey !== credentialKey) {
    // A session minted under another provider key cannot be spent by this
    // one (slice-2 review, finding 9): say so, never loop on `not-yours`.
    return refuse("key-mismatch", "The open conversation was started with a different provider key. Use that key, or end it with --end and start a new one.");
  }
  if (session !== null && session.ceilingDigest !== who.ceilingDigest) {
    store.endLeadSession(session.id, who.name, now);
    store.closeLeadThreadsFor(who.name, now);
    say("The projects you named differ from the open conversation's, so it ended. Starting a new one.");
    session = null;
  }
  if (session === null) {
    const ceilingUsd = direct ? (input.ceilingUsd ?? 5) : 0;
    if (direct && (!Number.isFinite(ceilingUsd) || ceilingUsd <= 0 || ceilingUsd > 1_000)) return refuse("usage", "--ceiling-usd is a dollar amount between 0 and 1000", LEAD_CLI_EXIT.usage);
    const ceilingMicrousd = Math.round(ceilingUsd * 1_000_000);
    const termsDigest = createHash("sha256").update(`${ceilingMicrousd}\n${who.ceilingDigest}`).digest("hex");
    const id = store.mintLeadSession(
      { approver: who.name, approverGeneration: who.generation, credentialKey, ceilingMicrousd, ceilingDigest: who.ceilingDigest, termsDigest },
      now,
    );
    session = store.getLeadSession(id);
    if (session === null) return refuse("failed", "A new conversation couldn't be started. Try again.", LEAD_CLI_EXIT.failed);
    if (!direct && input.ceilingUsd !== undefined) say("the supplied --ceiling-usd value is ignored for membership usage");
    say(`lead conversation started: ${direct ? `up to ${money(ceilingMicrousd)}` : "subscription usage (no dollar limit)"} over ${repos.map(one => projectName(one)).join(", ")} — live until you end it`);
    if (direct) say(`(the weekly chat limit, ${money(config.weeklyCeilingMicrousd)}, still applies)`);
  } else {
    say(`lead conversation live: ${direct ? `${money(session.spentMicrousd)} of ${money(session.ceilingMicrousd)} spent` : "subscription usage (no dollar limit)"} — live until you end it`);
  }
  const thread = store.openLeadThread(who.name, who.ceilingDigest, now).thread;
  if (input.follow !== undefined) {
    if (!configureLeadFollow(store, who, session, thread, input.follow, now)) return refuse("standing", "Conversation access changed.");
    say(leadFollowStatus(store, who.name).detail);
    emit({ ok: true, follow: leadFollowStatus(store, who.name) });
  }

  const pendingProposals = (): LeadProposal[] => store.listLeadProposals(thread.id, ["pending"]);
  // Ordinals are assigned once per proposal and never reused within this
  // run (slice-2 review, finding 4): `confirm 2` means the card printed as
  // 2, whatever the console did to its neighbours meanwhile.
  const ordinals = new Map<number, number>();
  const ordinalOf = (proposal: LeadProposal): number => {
    const known = ordinals.get(proposal.id);
    if (known !== undefined) return known;
    const next = ordinals.size + 1;
    ordinals.set(proposal.id, next);
    return next;
  };
  const byOrdinal = (ordinal: number): LeadProposal | null => {
    for (const [id, n] of ordinals) if (n === ordinal) return store.getLeadProposal(id);
    return null;
  };
  const printProposals = (): void => {
    const rows = pendingProposals();
    if (rows.length === 0) return;
    say("proposals — `confirm N`, `dismiss N`, `open N`:");
    for (const row of rows) ordinalOf(row);
    for (const row of rows) for (const line of proposalBlock(store, row, repos, ordinalOf(row))) say(line);
  };

  const turn = async (message: string): Promise<LeadTurnOutcome> => {
    const live = store.activeLeadSession(who.name);
    if (live === null) {
      const outcome: LeadTurnOutcome = { ok: false, refused: "session-ended", message: "This conversation has ended. Run chat again to start a new one." };
      return outcome;
    }
    return runLeadTurn({ store, who, session: live, thread, config, key, message, channel: "terminal", ...(seams.fetcher === undefined ? {} : { fetcher: seams.fetcher }), ...(seams.subscriptionRunner === undefined ? {} : { subscriptionRunner: seams.subscriptionRunner }), ...(input.evidenceRoot === undefined ? {} : { evidenceRoot: input.evidenceRoot }), clock });
  };
  const report = (outcome: LeadTurnOutcome, message?: string): void => {
    if (outcome.ok && outcome.replayed) {
      emit(outcome);
      say(`Message already received as turn #${outcome.turn}.`);
      return;
    }
    if (outcome.ok) {
      const ask = store.leadAsk(outcome.turn);
      emit({ ok: true, turn: outcome.turn, reply: outcome.reply, activity: outcome.activity, steps: outcome.steps, settledMicrousd: outcome.settledMicrousd, proposals: pendingProposals().map(one => ({ id: one.id, ordinal: ordinalOf(one), kind: one.kind, payload: one.payload })),
        ...(ask === null ? {} : { ask: { question: ask.question, options: [...ask.options, LEAD_ASK_OTHER] } }) });
      say(`  ${outcome.activity}`);
      say(voiceReply(outcome.reply, "terminal", { appOrigin: input.appOrigin ?? null, ...(message === undefined ? {} : { asked: message }) }));
      // The lead's question: the terminal has no buttons, so the options are listed to type back.
      if (ask !== null) say(`${ask.question}\n${ask.options.map(one => `  · ${one}`).join("\n")}\n  · ${LEAD_ASK_OTHER} (type your answer)`);
      printProposals();
      return;
    }
    emit({ ok: false, ...("refused" in outcome ? { reason: outcome.refused } : { turn: outcome.turn, reason: outcome.failed, unknownSpend: outcome.unknownSpend }), message: outcome.message });
    say(outcome.message);
  };

  if (input.say !== undefined) {
    const outcome = await turn(input.say);
    report(outcome, input.say);
    return { code: outcome.ok ? LEAD_CLI_EXIT.ok : LEAD_CLI_EXIT.refused };
  }

  // The REPL. Text is a turn; a few words are acts on the cards.
  say("say something, or: proposals · confirm N · dismiss N · open N · end · quit");
  const openTask = (proposal: LeadProposal): void => {
    if (proposal.kind === "control" && isChatControl(proposal.payload["control"])) {
      say(`Open in the console: ${chatControlHref(proposal.payload["control"], String(proposal.payload["task"] ?? ""), proposal.payload["run"], proposal.payload["project"])}`);
      return;
    }
    const taskId = typeof proposal.payload["task"] === "string" ? (proposal.payload["task"] as string) : null;
    if (taskId === null) {
      say("that proposal names no task yet");
      return;
    }
    const task = store.getTask(taskId);
    const scope = store.getScope(taskId);
    say(task === null ? `no task ${taskId}` : `${taskId} · ${task.title} · ${task.state}${scope === null ? "" : `\n  goal: ${scope.goal}${scope.outOfScope === null ? "" : `\n  not: ${scope.outOfScope}`}${scope.touches.length === 0 ? "" : `\n  touches: ${scope.touches.join(", ")}`}`}`);
  };
  for await (const raw of linesOf(seams)) {
    const line = raw.trim();
    if (line === "") continue;
    now = clock();
    const act = /^(confirm|dismiss|open)\s+([0-9]{1,3})(\s+yes)?$/i.exec(line);
    if (act !== null) {
      for (const row of pendingProposals()) ordinalOf(row);
      const proposal = byOrdinal(Number(act[2]));
      if (proposal === null) {
        say(`no proposal ${act[2]}`);
        continue;
      }
      if (proposal.state !== "pending" && (act[1] as string).toLowerCase() !== "open") {
        say(`proposal ${act[2]} is ${proposal.state}${proposal.outcome !== null && typeof (proposal.outcome as { said?: unknown }).said === "string" ? `: ${(proposal.outcome as { said: string }).said}` : ""}`);
        continue;
      }
      const verb = (act[1] as string).toLowerCase();
      if (verb === "open") {
        openTask(proposal);
      } else if (verb === "dismiss") {
        const done = dismissLeadProposal(store, who, proposal.id, now);
        emit({ ok: done, act: "dismiss", proposal: proposal.id });
        say(done ? `dismissed ${act[2]}` : "that proposal was already acted on");
      } else {
        const outcome = confirmLeadProposal(store, who, proposal.id, now, { confirm: act[3] !== undefined, via: "cli", chatProvider: () => {
          const current = store.getChatConfig();
          return current === null ? null : { config: current, key: isDirectChatProvider(current.provider) ? keyFor(current as ChatConfig & { provider: DirectChatProviderId }, input.databaseFile, env) : null };
        }, ...(input.evidenceRoot === undefined ? {} : { evidenceRoot: input.evidenceRoot }) });
        emit({ ok: outcome.ok, act: "confirm", proposal: proposal.id, ...(outcome.ok ? { said: outcome.said, taskId: outcome.taskId } : { reason: outcome.reason, said: outcome.said }) });
        say(outcome.ok ? outcome.said : outcome.reason === "needs-confirm" ? `${outcome.said}: confirm ${act[2]} yes` : `refused: ${outcome.said}`);
        if (outcome.ok && outcome.kind === "scope" && outcome.taskId !== null) say(`approve it with your password: toolroll task approve ${outcome.taskId}`);
      }
      continue;
    }
    const word = line.toLowerCase();
    if (word === "proposals") {
      if (pendingProposals().length === 0) say("no proposals are pending");
      else printProposals();
      continue;
    }
    if (word === "quit" || word === "exit") break;
    if (word === "end") {
      store.failLiveLeadTurnsFor(who.name, "ended", now);
      store.endLeadSessionsFor(who.name, who.name, now);
      store.closeLeadThreadsFor(who.name, now);
      say("The conversation has ended and its history is forgotten.");
      emit({ ok: true, ended: true });
      return { code: LEAD_CLI_EXIT.ok };
    }
    if (word === "help" || word === "?") {
      say("say something, or: proposals · confirm N · dismiss N · open N · end · quit");
      continue;
    }
    report(await turn(line), line);
  }
  return { code: LEAD_CLI_EXIT.ok };
}
