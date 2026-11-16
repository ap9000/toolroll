/**
 * Flexible threads: the terms card a person says yes to when they start a thread (pre-enable; the Flexible plan v2 §2,
 * §3, §7 and owner decisions round 2, Codex round 2 items 3 and 4). Built with the approval summary's own machinery
 * (approval-summary.ts): labelled rows, the risks never folded, and a `key` that is a hash of everything shown, which
 * the start must name. The thread start (engine-api.ts threadStart) computes the card again at the moment of use and
 * starts nothing unless the key it was posted is exactly the key of the card as it stands now: a project, network,
 * level, agent, limit, signer or wording that moved in between is a stale card, refused.
 *
 * What the card says, every time: the project; the level (Full access, inside the sandbox only); the agent and how it
 * signs in (the relay tier: the login stays with Toolroll); where it works (its own copy of the repository); the network
 * (the thread's own, read from Toolroll's records); the limits (turns hard, a dollar limit soft, and what an unmeasured
 * cost holds); what Ship will do (one press, a merge only on a passing required check of that exact commit); and the
 * disclosures (history beyond the base, secrets in what it writes, the open network's risks when the network is open).
 *
 * Nothing here works while FLEXIBLE_AVAILABLE is false: the one entry point refuses first.
 */
import { createHash } from "node:crypto";
import { FLEXIBLE_AVAILABLE } from "./flexible-available.js";
import { FLEXIBLE_LAPSE_WORDS, FLEXIBLE_LEVEL_WORDS, FLEXIBLE_UNAVAILABLE, flexibleStanding, FULL_ACCESS_WORDS, OPEN_NETWORK_WORDS, type FlexibleTerms } from "./flexible.js";
import { flexibleNetworkDigest, flexibleThreadNetwork } from "./flexible-launcher.js";
import { flexibleRelayBilling } from "./flexible-relay.js";
import { networkWords } from "./egress.js";
import { agentModelName } from "./model-names.js";
import { CLAUDE_EXACT } from "./model-catalog.js";
import type { ApprovalSummary, SummaryNote, SummaryRow } from "./approval-summary.js";
import type { Store } from "./store.js";

/** The model a thread starts with when none is named: the current Sonnet. */
export const FLEXIBLE_DEFAULT_MODEL: string = CLAUDE_EXACT.find(one => one.value.startsWith("claude-sonnet-"))?.value ?? "claude-sonnet-5-5";
/** A model the sign-in relay forwards for Claude (flexible-relay-upstreams.ts): anything else is refused here. */
const RELAY_MODEL = /^claude-(?:opus|sonnet|haiku|fable)-\d{1,2}(?:-\d{1,2})?(?:-\d{8})?$/;

export type FlexibleStartRefusal = { ok: false; reason: "not-available" | "invalid-request" | "not-flexible" | "terms-lapsed" | "terms-unreadable" | "not-a-starter" | "no-sign-in"; message: string };
const WORDS = Object.freeze({
  "not-available": FLEXIBLE_UNAVAILABLE,
  "invalid-request": "That isn't a thread Toolroll can start: name a project and a Claude model. Nothing was started.",
  "not-flexible": "This project isn't Flexible, so threads can't start in it. Nothing was started.",
  "terms-unreadable": "This project's Flexible terms can't be read, so they allow nothing. Nothing was started.",
  "not-a-starter": "These terms don't let you start threads in this project. Nothing was started.",
  "no-sign-in": "Toolroll holds no Claude sign-in for Flexible threads yet, so no thread can start. Nothing was started.",
} as const);
const refuse = (reason: Exclude<FlexibleStartRefusal["reason"], "terms-lapsed">): FlexibleStartRefusal => ({ ok: false, reason, message: WORDS[reason] });

/** The card, and what it binds: the project's live terms digest (what the turn's admission names), the thread's
 * network and its digest (what the first launch is held to), the model, the level, and `summary.key`. */
export type FlexibleStartCard = { summary: ApprovalSummary; digest: string; network: string; model: string; level: "full"; billing: "subscription" | "api-key"; terms: FlexibleTerms };

const money = (micro: number): string => `$${(micro / 1_000_000).toFixed(2)}`;
const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;
const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);

/** What one press of Ship does (owner decision D3', round 2). */
export const FLEXIBLE_SHIP_WORDS = "One press. Toolroll merges only when the project's required check passes on that exact commit. A failed or missing check never merges, there is no merge anyway, and any change to the commit cancels it.";
/** What an unmeasured cost holds (F2e; enable gate 8). */
export const FLEXIBLE_UNKNOWN_COST_WORDS = "If Toolroll can't measure what a turn on an API key cost, that turn holds the monthly budgets it counts toward until the month ends, and a daily dollar limit until the next day (UTC).";

/**
 * The card a person reads before starting a thread in `repo`, built from Toolroll's records only (the project's live
 * Flexible terms, its network, the person's account), or why no thread can start there. Pure apart from those reads:
 * the same records, person, model and message give the same card, and so the same key.
 */
export function flexibleStartCard(store: Store, input: { repo: string; by: { name: string; generation: number }; model: string | null; message: string }): { ok: true; card: FlexibleStartCard } | FlexibleStartRefusal {
  if (!FLEXIBLE_AVAILABLE) return refuse("not-available");
  const model = input.model === null || input.model === "" ? FLEXIBLE_DEFAULT_MODEL : input.model;
  if (typeof input.repo !== "string" || input.repo === "" || typeof model !== "string" || !RELAY_MODEL.test(model) || typeof input.message !== "string"
    || typeof input.by?.name !== "string" || !Number.isSafeInteger(input.by.generation)) return refuse("invalid-request");
  const standing = flexibleStanding(store, input.repo);
  if (standing.state === "secure") return refuse("not-flexible");
  if (standing.state === "unreadable") return refuse("terms-unreadable");
  if (standing.state === "lapsed") return { ok: false, reason: "terms-lapsed", message: `This project's Flexible terms no longer count. ${FLEXIBLE_LAPSE_WORDS[standing.reason]} Nothing was started.` };
  const terms = standing.terms;
  if (terms.starters === "signer" && input.by.name !== terms.signer) return refuse("not-a-starter");
  const network = flexibleThreadNetwork(store, input.repo);
  if ("ok" in network) return refuse("not-available");
  // How its turns are billed: the kind of the relay's own credential, as the relay reads it (never a request's word).
  const credential = flexibleRelayBilling(store);
  if (!credential.ok) return refuse("no-sign-in");
  const billing = credential.billing;
  const open = network.mode === "open";
  const project = store.handle.prepare("SELECT name FROM project WHERE path = ?").get(input.repo)?.["name"];
  const caps = terms.caps;

  const decisions: SummaryRow[] = [
    { label: "Project", words: typeof project === "string" ? project : input.repo, lines: typeof project === "string" ? [input.repo] : [], fields: ["flexible.repo"] },
    { label: "Level", words: `${FLEXIBLE_LEVEL_WORDS.full}: no permission prompts inside the sandbox`, lines: [FULL_ACCESS_WORDS], fields: ["flexible.level"], risky: true },
    { label: "Agent", words: `${agentModelName("claude", model)}, signed in through Toolroll's relay`, lines: ["Your Claude login stays with Toolroll and never enters the agent; each call is checked and counted.",
      billing === "subscription" ? "Billed to your Claude plan (Toolroll's setup-token sign-in)." : "Billed per call to Toolroll's Claude API key."], fields: ["flexible.agent", "flexible.billing"] },
    { label: "Works in", words: "its own copy of this repository, on its own branch", lines: ["Your repository changes only when you Ship."], fields: ["flexible.repository"] },
    { label: "Network", words: open ? "open: any website, through the thread's own proxy" : lowerFirst(networkWords(network, "claude").replace(/^Network: /, "")),
      lines: ["Nothing on this computer is reachable (no local services, keychain, SSH agent or saved sign-ins)."], fields: ["flexible.network"], ...(open ? { risky: true } : {}) },
    { label: "Limits", words: `${plural(caps.turnsPerDayPerson, "turn")} a day for you, ${plural(caps.turnsPerDayProject, "turn")} a day in this project, ${plural(caps.liveThreads, "thread")} at once`,
      lines: [
        "Turn limits are hard. A limit on turns doesn't limit what one turn costs.",
        caps.measuredMicrousdPerDay === null ? "No dollar limit: a turn runs until it finishes." : `New turns stop once today's measured spend reaches ${money(caps.measuredMicrousdPerDay)}; a turn already running may go past it.`,
        FLEXIBLE_UNKNOWN_COST_WORDS,
      ], fields: ["flexible.caps"], ...(caps.measuredMicrousdPerDay === null ? { risky: true } : {}) },
    { label: "Ship", words: FLEXIBLE_SHIP_WORDS, fields: ["flexible.ship"] },
    { label: "Terms", words: `this project's Flexible terms, turned on by ${terms.signer}`, lines: [`They last until someone turns them off or lowers them, or ${terms.signer}'s account or access changes.`], fields: ["flexible.terms"] },
  ];
  const warnings: SummaryNote[] = [
    { words: "The agent can read this repository's whole history, not just the commit it starts from.", fields: ["flexible.repository"] },
    { words: "Anything it reads can end up in what it writes: its messages and its commits. Toolroll checks for secrets before Ship, but that isn't a guarantee.", fields: ["flexible.network"] },
    ...(open ? OPEN_NETWORK_WORDS.map(words => ({ words, fields: ["flexible.network" as const] })) : []),
  ];
  // Everything shown, and what it binds that isn't a row's words (the terms digest, the network exactly, the person and
  // generation, the model, the message), under its own kind: a key minted here means nothing to any other approval.
  const digestOfMessage = createHash("sha256").update(input.message, "utf8").digest("hex");
  const networkDigest = flexibleNetworkDigest(network);
  const key = createHash("sha256").update(JSON.stringify({ v: 1, kind: "standing-orders:flexible-start", digest: standing.digest, repo: input.repo, by: input.by, model, level: "full", billing,
    network: networkDigest, message: digestOfMessage, decisions, warnings }), "utf8").digest("hex").slice(0, 32);
  const summary: ApprovalSummary = { revision: null, revisionNotes: [], revisionChanges: [], decisions, why: null, differs: [], warnings, usual: [], usualLabel: "Other settings", usualSummary: "", key };
  return { ok: true, card: { summary, digest: standing.digest, network: networkDigest, model, level: "full", billing, terms } };
}
