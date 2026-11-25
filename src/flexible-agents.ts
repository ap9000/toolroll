/**
 * Flexible threads, slice F2c (the Flexible plan v2 §4 and §5, Codex round 2 items 3 and 10, enable gate 1): starting a
 * thread's agent for an admitted turn, each relay-tier agent wired to its Full-access level, lowering a thread's level
 * at runtime. The agent signs in only through its thread's sign-in relay (flexible-relay.ts, F2b).
 *
 * The rules this module keeps:
 * - Starting a turn checks the interactive agent threads' switch (flexible-available.ts flexibleAvailable: off unless a
 *   person turned them on) first; lowering a level and recovering a holder's launches never do (they only narrow or
 *   stop).
 * - A turn starts only under exactly its admission (flexible-turns.ts beginFlexibleTurn re-checks the terms row, the
 *   day and every spend limit and withdraws the turn when any fails), at a level proven for its agent under the
 *   organisation's ceiling (flexible-levels.ts threadLevelAllowed), inside the thread fence (flexible-thread.ts). A
 *   refusal before the spawn leaves nothing running and custody untouched, and says why in one line.
 * - Full access removes the agent's own permission prompts inside the fence only (Codex round 2 item 3): the fence,
 *   the proxy-only network and the credential split are the same at every level. The agent signs in only through
 *   Toolroll's relay: its base URL and a per-launch relay token, never a key or the person's own sign-in.
 * - The relay's port is the thread fence's second relay (the only loopback port it admits beside the run proxy), so the
 *   agent reaches the relay and nothing else on this computer.
 * - Every turn starts its own agent. An earlier turn's agent is never reused: its run proxy (port and credential) and its
 *   relay grant are fixed in its environment, so taking it over would let a turn use another turn's network grant. The
 *   earlier one is stopped and its whole tree's exit proved first (flexible-launch.ts). Lowering stops a running agent
 *   above the new level at once; while any of its processes survive, the thread stays pending and no new turn starts.
 * - Whatever an agent's own exit sets off stops that launch only (by its launch id and holder), never the thread's agent
 *   of the moment: an earlier agent exiting after its replacement started never touches the replacement.
 */
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { flexibleAvailable } from "./flexible-available.js";
import { flexibleDelegationAtUse, FLEXIBLE_LEVEL_WORDS, FLEXIBLE_LEVELS, FLEXIBLE_UNAVAILABLE, isFlexibleLevel, type FlexibleLevel } from "./flexible.js";
import { threadLevelAllowed, FLEXIBLE_PROVEN, type FlexibleProvenMatrix } from "./flexible-levels.js";
import { flexibleLaunch, freshProviderFolder, onLaunchStopped, unsettledLaunch, watchLaunch, type FlexibleAgentProvider, type SettleResult } from "./flexible-launch.js";
import { relayUrlInside, type FlexibleRelay, type FlexibleRelayEndpoint } from "./flexible-relay.js";
import { flexibleThread, flexibleThreadFence, flexibleThreadSpawn, stopFlexibleThreadAgent, withFlexibleThreadLock, type FlexibleThreadRefusal, type FlexibleThreadSpawnSeams } from "./flexible-thread.js";
import { beginFlexibleTurn, finishFlexibleTurn, flexibleTurn, interruptFlexibleTurnsOf, withdrawFlexibleTurn, withdrawFlexibleTurnsAbove, type FlexibleClock, type FlexibleTurnRefusal } from "./flexible-turns.js";
import { CLAUDE_BUILD_ISOLATION_ARGV, HEADLESS_DISALLOWED_TOOLS } from "./provider.js";
import type { ProtectedStorage } from "./protected-storage.js";
import type { Store } from "./store.js";

export type FlexibleAgentRefusal = { ok: false; reason: "not-available" | "codex-unsupported" | "invalid-request" | "level-pending" | "not-owner" | "not-lower" | "thread-unknown" | "stale-generation"; message: string };
const WORDS = Object.freeze({
  "not-available": FLEXIBLE_UNAVAILABLE,
  "codex-unsupported": "Codex's own sandbox can't keep a Flexible thread away from threads and files made after it starts, so Codex and OpenRouter threads can't run yet. Nothing was started.",
  "invalid-request": "That request isn't one Toolroll can read. Nothing was started.",
  "level-pending": "This thread's agent is still running with other settings. Stop it, and the next turn starts with the new ones.",
  "not-owner": "Only the person who started this thread can change its level. Nothing changed.",
  "not-lower": "Lowering can't raise a thread's level. Send the next message at the higher level with your password instead. Nothing changed.",
  "thread-unknown": "There's no such thread.",
  "stale-generation": "Your account changed since this started. Sign in again and retry. Nothing changed.",
} as const);
const refuse = (reason: keyof typeof WORDS, message: string = WORDS[reason]): FlexibleAgentRefusal => ({ ok: false, reason, message });

// ---- each agent at its level ---------------------------------------------------------------------------------------------

const MODEL = /^[A-Za-z0-9._:/@+-]{1,200}$/;
const EMPTY_MCP = '{"mcpServers":{}}';

/** How one agent starts in a thread at a level: its program, arguments and the variables its adapter adds (the relay,
 * its own configuration folder). Each is that agent's Full access (plan §4) and nothing wider; Supervised and Auto have
 * no proven permission channel yet and are never built. */
export type FlexibleAgentSpec = { file: string; args: string[]; env: Record<string, string> };
export function flexibleAgentLaunch(provider: FlexibleAgentProvider, level: FlexibleLevel, input: { model: string; relay: Pick<FlexibleRelayEndpoint, "url" | "token">; configHome: string }):
  { ok: true; spec: FlexibleAgentSpec } | FlexibleAgentRefusal {
  if (typeof input.model !== "string" || !MODEL.test(input.model) || !isFlexibleLevel(level)) return refuse("invalid-request");
  if (provider === "codex" || provider === "openrouter") return refuse("codex-unsupported");
  if (level !== "full") return refuse("invalid-request", `${FLEXIBLE_LEVEL_WORDS[level]} isn't offered for any agent yet. Nothing was started.`);
  if (provider === "claude") {
    return { ok: true, spec: { file: "claude", args: [
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      // Full access: no permission prompts, inside the thread's fence only.
      "--permission-mode", "bypassPermissions",
      "--model", input.model,
      // No settings, hooks, plugins or MCP servers of the person's, the repository's or anyone's: the thread's own only.
      ...CLAUDE_BUILD_ISOLATION_ARGV, "--mcp-config", EMPTY_MCP,
      "--disallowedTools", HEADLESS_DISALLOWED_TOOLS.join(","),
      "--settings", JSON.stringify({ autoMemoryEnabled: false }),
    ], env: {
      // Signed in only through Toolroll's relay, never a key or the keychain (which the fence denies anyway).
      ANTHROPIC_BASE_URL: input.relay.url, ANTHROPIC_AUTH_TOKEN: input.relay.token,
      CLAUDE_CONFIG_DIR: input.configHome, DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    } } };
  }
  // Gemini: built to its Full access (yolo inside the fence, through a relay), not offered (flexible-levels.ts).
  return { ok: true, spec: { file: "gemini", args: ["--output-format", "stream-json", "--approval-mode", "yolo", "-m", input.model],
    env: { GOOGLE_GEMINI_BASE_URL: input.relay.url, GEMINI_API_KEY: input.relay.token, GEMINI_CLI_HOME: input.configHome } } };
}

// ---- starting an admitted turn --------------------------------------------------------------------------------------------

export type FlexibleTurnStartInput = {
  turn: string; holder: string;
  /** Where the time comes from (default: the system clock); each write reads it once, inside its own transaction. */
  clock?: FlexibleClock;
  /** The launch's own run proxy: its port, credentials and environment, and how to close it (at once, when the agent is
   * stopped, or now, when the turn doesn't start a new launch). */
  network: { proxyPort: number; token: string; proxyEnv: Record<string, string>; close: () => void | Promise<void> };
  /** The thread's sign-in relay (flexible-relay.ts startFlexibleRelay): its port is the fence's second relay, and a grant
   * is issued for this launch only if it launches. */
  relay: FlexibleRelay;
  storage: ProtectedStorage;
  proven?: FlexibleProvenMatrix; platform?: NodeJS.Platform; seams?: FlexibleTurnSeams;
};
/** Test seams (parameters, never settings): the spawn's own, and `exitSettled`, told when the stop a launch's own exit
 * set off has answered (so a test waits on that fact, never on time). */
export type FlexibleTurnSeams = FlexibleThreadSpawnSeams & { exitSettled?: (launch: string, settled: SettleResult | FlexibleThreadRefusal | null) => void };
export type FlexibleTurnStarted = { ok: true; launched: "started"; launchId: string; pid: number; child: ChildProcess; stopWatching: () => void };

/** Why a begun turn may no longer open its agent's start gate, or null: re-checked under the lock at the last moment. */
function stillMayStart(store: Store, turnId: string, holder: string): string | null {
  const turn = flexibleTurn(store, turnId);
  if (turn === null || turn.status !== "running" || turn.holder !== holder) return "the turn is no longer running";
  const chosen = store.handle.prepare("SELECT level FROM flexible_thread_level WHERE thread = ?").get(turn.thread);
  if (chosen !== undefined && isFlexibleLevel(chosen["level"]) && FLEXIBLE_LEVELS.indexOf(turn.level) > FLEXIBLE_LEVELS.indexOf(chosen["level"])) {
    return `the thread was lowered to ${FLEXIBLE_LEVEL_WORDS[chosen["level"]]}`;
  }
  const delegation = flexibleDelegationAtUse(store, { repo: turn.repo, starter: { name: turn.owner, generation: turn.ownerGeneration }, digest: turn.termsDigest, level: turn.level, freshProof: true });
  if (!delegation.ok) return delegation.message;
  if (delegation.termsId !== turn.termsId) return "the project's Flexible terms changed";
  const allowed = threadLevelAllowed(store.orgPolicy(), turn.provider, turn.level);
  return allowed.ok ? null : allowed.message;
}

/**
 * Start an admitted turn, wholly under the thread's lock (a level change, a stop or a removal is wholly before or after
 * it): check its agent and level are offered; an earlier turn's agent still running is stopped and its exit verified
 * first (or the turn doesn't start), never reused. Then the turn begins (its admission re-checked)
 * and its agent launches inside the thread fence behind the start gate, which opens only if the turn, its level and
 * its authority still hold at that moment. The launch's proxy and relay grant close the moment it is stopped, and the
 * holder watches its descendants while it runs. Handles the caller passed but the turn didn't use are closed.
 */
export async function startFlexibleTurn(store: Store, input: FlexibleTurnStartInput): Promise<FlexibleTurnStarted | FlexibleAgentRefusal | FlexibleTurnRefusal | FlexibleThreadRefusal> {
  if (!flexibleAvailable(store)) return refuse("not-available");
  const first = flexibleTurn(store, input.turn);
  if (first === null) return { ok: false, reason: "turn-unknown", message: "There's no such turn." };
  const unused = async () => { try { await input.network.close(); } catch { /* the caller's own proxy: its closer keeps it for a retry */ } };
  // The proxy is the caller's until a launch owns it (onLaunchStopped, in startLocked). Anything that ends this start
  // without that, a refusal or a throw at any point, closes it here before the start answers.
  let started: Awaited<ReturnType<typeof startLocked>> | FlexibleThreadRefusal;
  try {
    started = await withFlexibleThreadLock(first.thread, () => startLocked(store, input));
  } catch (error) {
    await unused();
    throw error;
  }
  if (!started.ok) await unused();
  return started;
}

async function startLocked(store: Store, input: FlexibleTurnStartInput): Promise<FlexibleTurnStarted | FlexibleAgentRefusal | FlexibleTurnRefusal | FlexibleThreadRefusal> {
  const turn = flexibleTurn(store, input.turn);
  if (turn === null) return { ok: false, reason: "turn-unknown", message: "There's no such turn." };
  if (turn.status !== "admitted") return { ok: false, reason: "turn-not-admitted", message: "This turn isn't waiting to start, so it wasn't started again." };
  const clocked = input.clock === undefined ? {} : { clock: input.clock };
  if (turn.holder !== input.holder) return { ok: false, reason: "held-elsewhere", message: "Another Toolroll process holds this turn, so this one didn't touch it." };
  // Before anything starts: a turn this build won't run is withdrawn (it counts toward nothing).
  const withdraw = <R extends { message: string }>(refusal: R): R => { withdrawFlexibleTurn(store, { turn: turn.id, holder: input.holder, detail: refusal.message, ...clocked }); return refusal; };
  const allowed = threadLevelAllowed(store.orgPolicy(), turn.provider, turn.level, input.proven ?? FLEXIBLE_PROVEN);
  if (!allowed.ok) return withdraw(allowed);
  const network = { proxyPort: input.network.proxyPort, token: input.network.token, relayPort: input.relay.port };
  const fenced = flexibleThreadFence(store, { id: turn.thread, network, storage: input.storage });
  if (!fenced.ok) return withdraw(fenced);
  // An earlier turn's agent never takes this turn: its proxy and relay grant were made for the turn that launched it (a
  // new turn's own proxy differs by port and credential every time). It is stopped, that launch exactly, and its exit
  // verified before a new one starts; this turn is kept.
  const running = unsettledLaunch(store, turn.thread);
  if (running !== null) {
    const stopped = await stopFlexibleThreadAgent(store, { id: turn.thread, reason: "its agent was replaced", ...clocked, ...(input.seams?.io === undefined ? {} : { io: input.seams.io }), keepTurn: turn.id,
      expect: { launch: running.id, holder: running.holder } });
    if ("reason" in stopped) return withdraw(stopped);
    if (!stopped.ok) return withdraw(refuse("level-pending", `This thread's earlier agent couldn't be stopped (${stopped.why}), so no new one started.`));
  }
  const configHome = join(fenced.paths.cache, "provider", turn.id);
  const platform = input.platform ?? process.platform;
  // Inside the fence the relay is reached at its second-relay address (this computer's own port on a Mac, the runtime's
  // relayed one on Linux), never the address it listens on out here.
  const relayInside = relayUrlInside(input.relay.port, platform);
  const agent = flexibleAgentLaunch(turn.provider, turn.level, { model: turn.model, relay: { url: relayInside, token: "0".repeat(57) }, configHome });
  if (!agent.ok) return withdraw(agent);
  // The turn's admission, checked again (terms row, day, every spend limit, its level): a refusal withdraws it and
  // nothing starts.
  const begun = beginFlexibleTurn(store, { turn: turn.id, holder: input.holder, ...clocked });
  if (!begun.ok) return begun;
  const endTurn = (detail: string) => finishFlexibleTurn(store, { turn: turn.id, holder: input.holder, outcome: "unknown", usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 }, detail, ...clocked });
  // A fresh configuration folder for every launch, made by Toolroll: nothing an earlier launch wrote there loads again.
  // The thread's cache is the agent's to write: everything on the way to it is proved Toolroll's real folders first, and
  // nothing is deleted through a link. A folder that isn't what Toolroll made refuses the turn; it is never repaired.
  const providerProblem = freshProviderFolder(store, turn.thread, fenced.paths, configHome);
  if (providerProblem !== null) {
    endTurn(`the agent's configuration folder couldn't be made: ${providerProblem}`);
    store.recordAction({ at: (input.clock ?? (() => new Date()))().toISOString(), actor: "toolroll", repo: null, taskId: null, runId: null, source: "policy", action: "flexible turn refused",
      outcome: "refused", detail: `thread ${turn.thread} · turn ${turn.id} · ${providerProblem}` });
    return { ok: false, reason: "setup-failed", message: "The agent's configuration folder isn't the one Toolroll made, so it didn't start. Nothing was removed." };
  }
  // The relay grant is issued for exactly the launch once it has its id (its variables come with it); everything else
  // of the agent's environment is known now.
  let endpoint: FlexibleRelayEndpoint | null = null;
  const agentEnvFor = (launchId: string): Record<string, string> => {
    endpoint = input.relay.issue({ thread: turn.thread, turn: turn.id, launch: launchId });
    const spec = flexibleAgentLaunch(turn.provider, turn.level, { model: turn.model, relay: { url: relayInside, token: endpoint.token }, configHome });
    if (!spec.ok) throw new Error(spec.message);
    return spec.spec.env;
  };
  const spawned = await flexibleThreadSpawn(store, { id: turn.thread, network, storage: input.storage,
    proxyEnv: input.network.proxyEnv, agentEnvFor, launch: { provider: turn.provider, level: turn.level, turn: turn.id, holder: input.holder },
    beforeOpen: () => stillMayStart(store, turn.id, input.holder) },
    agent.spec.file, agent.spec.args, platform, input.seams ?? {});
  const issued = endpoint as FlexibleRelayEndpoint | null;
  if (!spawned.ok) {
    // Nothing of the agent ran: its grant ends and the turn ends at no cost.
    issued?.revoke();
    endTurn(`the agent didn't start: ${spawned.message}`);
    return spawned;
  }
  onLaunchStopped(spawned.launchId, input.network.close);
  if (issued !== null) onLaunchStopped(spawned.launchId, issued.revoke);
  const stopWatching = watchLaunch(store, spawned.launchId, fenced.paths.folder, input.seams?.io);
  // When the agent's own process ends (its exit, not its output closing: a survivor may hold that open), what it left
  // behind is stopped and the exit proved (its network closes first): this launch only, by its id and holder. By then a
  // later turn may have replaced it; that launch is left alone ("replaced").
  const launchId = spawned.launchId;
  spawned.child.once("exit", () => {
    void stopFlexibleThreadAgent(store, { id: turn.thread, reason: "its agent exited", expect: { launch: launchId, holder: input.holder }, ...(input.seams?.io === undefined ? {} : { io: input.seams.io }) })
      .then(settled => { input.seams?.exitSettled?.(launchId, settled); }, () => { input.seams?.exitSettled?.(launchId, null); /* a later stop or recovery settles it */ });
  });
  return { ok: true, launched: "started", launchId: spawned.launchId, pid: spawned.pid, child: spawned.child, stopWatching };
}

// ---- lowering a thread's level -----------------------------------------------------------------------------------------------

/**
 * Lower a thread's level (its owner, at the generation they proved; no password: narrowing only), under the thread's
 * lock, so a turn start is wholly before it (and its agent is stopped here) or wholly after it (and begins at the new
 * level or not at all). In one transaction: the level recorded, and every turn admitted above it withdrawn. Then a
 * running agent above the new level is stopped at once (never waited for) and the exit of its whole tree verified. The
 * next turn starts at the new level. While any of the old agent's processes survive, the thread is pending.
 */
export async function lowerFlexibleThreadLevel(store: Store, input: { thread: string; by: { name: string; generation: number }; level: FlexibleLevel; clock?: FlexibleClock; io?: import("./flexible-custody.js").CustodyIO }):
  Promise<{ ok: true; level: FlexibleLevel; stopped: "none" | "stopped" | "pending"; message: string } | FlexibleAgentRefusal | FlexibleThreadRefusal> {
  if (!isFlexibleLevel(input.level) || typeof input.by?.name !== "string" || !Number.isSafeInteger(input.by.generation)) return refuse("invalid-request");
  return withFlexibleThreadLock(input.thread, () => lowerLocked(store, input)).then(result => result);
}

async function lowerLocked(store: Store, input: { thread: string; by: { name: string; generation: number }; level: FlexibleLevel; clock?: FlexibleClock; io?: import("./flexible-custody.js").CustodyIO }):
  Promise<{ ok: true; level: FlexibleLevel; stopped: "none" | "stopped" | "pending"; message: string } | FlexibleAgentRefusal | FlexibleThreadRefusal> {
  const rank = (level: FlexibleLevel) => FLEXIBLE_LEVELS.indexOf(level);
  const words = FLEXIBLE_LEVEL_WORDS[input.level];
  const written = store.transact((): FlexibleAgentRefusal | null => {
    const thread = flexibleThread(store, input.thread);
    if (thread === null || thread.state !== "ready") return refuse("thread-unknown");
    if (thread.createdBy !== input.by.name) return refuse("not-owner");
    const account = store.accountOf(input.by.name);
    if (account === null || account.revokedAt !== null) return refuse("not-owner");
    if (account.generation !== input.by.generation) return refuse("stale-generation");
    const chosen = store.handle.prepare("SELECT level FROM flexible_thread_level WHERE thread = ?").get(input.thread);
    const running = unsettledLaunch(store, input.thread);
    const last = store.handle.prepare("SELECT level FROM thread_turn WHERE thread = ? AND status <> 'withdrawn' ORDER BY seq DESC LIMIT 1").get(input.thread);
    const current = [chosen?.["level"], running?.level, last?.["level"]].find(isFlexibleLevel) ?? null;
    if (current !== null && rank(input.level) > rank(current)) return refuse("not-lower");
    const at = (input.clock ?? (() => new Date()))().toISOString();
    store.handle.prepare(`INSERT INTO flexible_thread_level (thread, level, set_by, set_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (thread) DO UPDATE SET level = excluded.level, set_by = excluded.set_by, set_at = excluded.set_at`).run(input.thread, input.level, input.by.name, at);
    // A turn admitted at a higher level before this (even one not started yet) never starts.
    withdrawFlexibleTurnsAbove(store, { thread: input.thread, level: input.level, detail: `the thread was lowered to ${words}`, clock: () => new Date(at) });
    store.recordAction({ at, actor: input.by.name, repo: thread.repo, taskId: null, runId: null, source: "policy", action: "flexible thread lowered", outcome: "lowered",
      detail: `thread ${input.thread} · ${current ?? "unset"} → ${input.level}` });
    return null;
  });
  if (written !== null) return written;
  const running = unsettledLaunch(store, input.thread);
  if (running === null || rank(running.level) <= rank(input.level)) return { ok: true, level: input.level, stopped: "none", message: `Lowered to ${words}. The next turn starts at ${words}.` };
  const stopped = await stopFlexibleThreadAgent(store, { id: input.thread, reason: `lowered to ${words}`, ...(input.clock === undefined ? {} : { clock: input.clock }), ...(input.io === undefined ? {} : { io: input.io }) });
  if ("reason" in stopped) return stopped;
  return stopped.ok
    ? { ok: true, level: input.level, stopped: "stopped", message: `Lowered to ${words}; the current step was stopped.` }
    : { ok: true, level: input.level, stopped: "pending", message: `Lowered to ${words}. Some of the agent's processes are still running, so no new turn starts until they stop (${stopped.why}).` };
}

// ---- after a restart --------------------------------------------------------------------------------------------------------

/**
 * A holder process is gone (the caller proved it, as for interruptFlexibleTurnsOf): every launch it left unsettled has
 * its processes found and stopped and its exit verified. Only when every one of them is verified are the holder's turns
 * ended (interruptFlexibleTurnsOf, with the proof it trusts its caller for); otherwise they stay as they are and the
 * launches unresolved, and the same call later tries again.
 */
export async function recoverFlexibleLaunchesOf(store: Store, input: { holder: string; clock?: FlexibleClock; io?: import("./flexible-custody.js").CustodyIO }):
  Promise<{ ok: true; settled: number; unresolved: number; withdrawn: number; interrupted: number } | FlexibleAgentRefusal> {
  if (typeof input.holder !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.holder)) return refuse("invalid-request");
  const launches = store.handle.prepare("SELECT thread, id FROM flexible_thread_launch WHERE holder = ? AND state <> 'exited' ORDER BY started_at, id").all(input.holder)
    .map(row => ({ thread: String(row["thread"]), launch: String(row["id"]) }));
  let settled = 0, unresolved = 0;
  for (const one of launches) {
    // The caller proved the holder gone: its proxy and relay handles died with it. Only that holder's very launch is
    // settled: rechecked under the thread's lock, so a replacement another console started meanwhile is left alone.
    const result = await stopFlexibleThreadAgent(store, { id: one.thread, reason: "Toolroll restarted", holderGone: true, expect: { launch: one.launch, holder: input.holder },
      ...(input.clock === undefined ? {} : { clock: input.clock }), ...(input.io === undefined ? {} : { io: input.io }) });
    if ("reason" in result || !result.ok) unresolved++;
    // Replaced: settled only if this holder's launch itself has ended (by whoever replaced it); otherwise unresolved.
    else if (result.how === "replaced" && flexibleLaunch(store, one.launch)?.state !== "exited") unresolved++;
    else settled++;
  }
  if (unresolved > 0) return { ok: true, settled, unresolved, withdrawn: 0, interrupted: 0 };
  const ended = interruptFlexibleTurnsOf(store, { holder: input.holder, ...(input.clock === undefined ? {} : { clock: input.clock }) });
  return { ok: true, settled, unresolved, withdrawn: ended.ok ? ended.withdrawn : 0, interrupted: ended.ok ? ended.interrupted : 0 };
}
