/**
 * Operating modes (v29, the modes chain v1–v7): a per-repository,
 * password-signed, expiring envelope that pre-authorizes the SIGNER'S OWN
 * future acts. The absence of a mode is 'locked' — every act keeps its
 * own ceremony, today's world, the default forever.
 *
 * The doctrine (v4 ruling): RAISING authority is a password ceremony;
 * LOWERING it is one click for any approver; on revocation or expiry
 * every mode-derived flow falls back to the human ceremony at its next
 * gate, and running work is never fenced.
 *
 * This module owns the terms shape, the digest, and the words. The store
 * owns the transactions; the tick owns the rails; serve owns the
 * ceremony screens.
 */

import { createHash } from "node:crypto";
import { CHAT_PROVIDERS, isChatProvider, type ChatProvider } from "./contracts/chat-tables.js";

export type ModeName = "standard" | "hands-off";

export type ModeTerms = {
  name: ModeName;
  /** The filing default per provider (C7 matrix): "safe" = auto /
   * auto_edit; "escalated" = bypassPermissions / yolo. Codex-shaped
   * providers have one posture and the ceremony words say escalation
   * changes nothing for them. */
  permissionDefault: "safe" | "escalated";
  /** Auto-approve the SIGNER'S OWN credentialed filings (C1's predicate
   * and road table). */
  autoApproveFiling: boolean;
  /** Explicit opt-in: a verified planner may approve a plan that preserves
   * the signer's pre-authorized filed contract and execution terms exactly. */
  planAuto: boolean;
  /** Attended mint without the per-mint password — signer only (D8). */
  quickMint: boolean;
  /** Historical signed field; new modes leave it false and no worker consumes
   * it. Automatic review is the project's review switch (review-switch.ts),
   * on by default while a hands-off mode is active. */
  reviewAuto: boolean;
  /** Historical signed retry term, retained for digest and audit compatibility. */
  reviewRetryAuto: boolean;
  /** Stamped into filings that name no budget of their own. */
  perAttemptBudgetMicrousd: number | null;
  /** SOFT rail: new admissions stop once the day's MEASURED spend has
   * reached this; running work may finish past it (D4). */
  dailyMeasuredCapMicrousd: number | null;
  /** HARD rail: reservation-counted admissions per UTC day, covering
   * unmeasured providers too (D4). */
  dailyRunCap: number | null;
  /** "notify" = merges wait for a human even under a merge grant;
   * "automerge" = the mode's signature substitutes for the per-merge
   * human authorization, through the grant machinery only (D1/E1). */
  publication: "notify" | "automerge";
  /** Whether this mode AUTHORIZES automatic PAID fallback (a
   * subscription->api-key or api-key->api-key switch that spends). v30,
   * fallback chains R8: legacy modes default FALSE — a paid substitution
   * must be an explicit, freshly-signed grant. A subscription->subscription
   * fallback is not "paid" and needs no grant. */
  allowPaidFallback: boolean;
  /** Whether this mode AUTHORIZES the bounded repair loop to draft AND
   * auto-approve its own repair attempts (v40, evidence-review-v1) — the
   * allowPaidFallback precedent, verbatim: legacy modes default FALSE, a
   * new authority is never inherited, only freshly signed. Without it, a
   * short/refuted run with named unresolved criteria still gets exactly
   * one drafted repair — it simply waits unapproved. */
  repairAuto: boolean;
  /** The signed cap on repair attempts per chain (0..3), counted over the
   * chain rooted at the original task. Meaningless (read as 0) unless
   * `repairAuto` is also true — a mode may sign a cap without signing the
   * authority, but never the reverse. */
  repairMaxAttempts: number;
  /** Explicit opt-in: the signer's paired chat may approve this
   * repository's plans and merge its ready pull requests with two taps,
   * for the mode's lifetime. A plan that widens permissions, exceeds the
   * per-attempt budget or touches protected paths still opens Toolroll.
   * Legacy modes read FALSE — never inherited, only freshly signed. */
  chatApprove: boolean;
  /** The chat apps `chatApprove` names, signed with it. Absent on a mode signed before chat apps other than Telegram
   * could approve: its words said "your paired Telegram chat", so it stays Telegram only (chatApproveChatsOf). A wider
   * grant is only ever a fresh signature naming the apps. */
  chatApproveChats?: readonly ChatProvider[];
  absoluteExpiry: string;
};

export const MODE_MAX_DAYS = 7;

/** The presets are STARTING POINTS the ceremony renders in full — the
 * signature always covers the resolved terms, never a label. */
export function presetTerms(name: ModeName, absoluteExpiry: string): ModeTerms {
  return name === "standard"
    ? {
        name,
        permissionDefault: "safe",
        autoApproveFiling: false,
        planAuto: false,
        quickMint: true,
        reviewAuto: false,
        reviewRetryAuto: false,
        perAttemptBudgetMicrousd: null,
        dailyMeasuredCapMicrousd: null,
        dailyRunCap: null,
        publication: "notify",
        allowPaidFallback: false,
        repairAuto: false,
        repairMaxAttempts: 0,
        chatApprove: false,
        absoluteExpiry,
      }
    : {
        name,
        permissionDefault: "escalated",
        autoApproveFiling: true,
        planAuto: false,
        quickMint: true,
        reviewAuto: false,
        reviewRetryAuto: false,
        perAttemptBudgetMicrousd: null,
        dailyMeasuredCapMicrousd: null,
        dailyRunCap: null,
        publication: "notify",
        allowPaidFallback: false,
        repairAuto: false,
        repairMaxAttempts: 0,
        chatApprove: false,
        absoluteExpiry,
      };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function modeTermsJson(terms: ModeTerms): string {
  return canonicalJson(terms);
}

/** sha256 over a domain-separated canonical encoding, 32 hex like every
 * other safety digest here. */
export function modeDigestOf(terms: ModeTerms): string {
  return createHash("sha256")
    .update(`standing-orders:mode:${modeTermsJson(terms)}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

/** Strict rehydration — anything unexpected is null, never a guess. */
export function modeTermsFromJson(json: string | null): ModeTerms | null {
  if (json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const t = parsed as Record<string, unknown>;
  const optMoney = (v: unknown): number | null | undefined =>
    v === null ? null : typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
  const budget = optMoney(t["perAttemptBudgetMicrousd"]);
  const measured = optMoney(t["dailyMeasuredCapMicrousd"]);
  const runs = optMoney(t["dailyRunCap"]);
  if (
    (t["name"] === "standard" || t["name"] === "hands-off") &&
    (t["permissionDefault"] === "safe" || t["permissionDefault"] === "escalated") &&
    typeof t["autoApproveFiling"] === "boolean" &&
    (t["planAuto"] === undefined || typeof t["planAuto"] === "boolean") &&
    typeof t["quickMint"] === "boolean" &&
    typeof t["reviewAuto"] === "boolean" &&
    (t["reviewRetryAuto"] === undefined || typeof t["reviewRetryAuto"] === "boolean") &&
    budget !== undefined &&
    measured !== undefined &&
    runs !== undefined &&
    (t["publication"] === "notify" || t["publication"] === "automerge") &&
    // allowPaidFallback: a legacy mode has NO such field — that MUST read
    // as false (R8: a paid substitution is only ever an explicit,
    // freshly-signed grant). A present value must be a strict boolean;
    // anything else is a bad envelope, null.
    (t["allowPaidFallback"] === undefined || typeof t["allowPaidFallback"] === "boolean") &&
    // repairAuto/repairMaxAttempts: the SAME precedent, verbatim (v40). A
    // legacy mode has NO such fields — that MUST read as false/0, never
    // inherited. A present repairAuto must be a strict boolean; a present
    // repairMaxAttempts must be an integer 0..3. Anything else is a bad
    // envelope, null.
    (t["repairAuto"] === undefined || typeof t["repairAuto"] === "boolean") &&
    (t["repairMaxAttempts"] === undefined ||
      (typeof t["repairMaxAttempts"] === "number" && Number.isInteger(t["repairMaxAttempts"]) && t["repairMaxAttempts"] >= 0 && t["repairMaxAttempts"] <= 3)) &&
    (t["chatApprove"] === undefined || typeof t["chatApprove"] === "boolean") &&
    // chatApproveChats: absent (a Telegram-only grant, or none), or the apps a chatApprove term names, each once.
    (t["chatApproveChats"] === undefined ||
      (t["chatApprove"] === true && Array.isArray(t["chatApproveChats"]) && t["chatApproveChats"].length > 0 &&
        t["chatApproveChats"].every(isChatProvider) && new Set(t["chatApproveChats"]).size === t["chatApproveChats"].length)) &&
    typeof t["absoluteExpiry"] === "string" &&
    !Number.isNaN(Date.parse(t["absoluteExpiry"]))
  ) {
    return {
      name: t["name"],
      permissionDefault: t["permissionDefault"],
      autoApproveFiling: t["autoApproveFiling"],
      planAuto: t["planAuto"] === true,
      quickMint: t["quickMint"],
      reviewAuto: t["reviewAuto"],
      reviewRetryAuto: t["reviewRetryAuto"] === true,
      perAttemptBudgetMicrousd: budget,
      dailyMeasuredCapMicrousd: measured,
      dailyRunCap: runs,
      publication: t["publication"],
      allowPaidFallback: t["allowPaidFallback"] === true,
      repairAuto: t["repairAuto"] === true,
      repairMaxAttempts: typeof t["repairMaxAttempts"] === "number" ? t["repairMaxAttempts"] : 0,
      chatApprove: t["chatApprove"] === true,
      ...(Array.isArray(t["chatApproveChats"]) ? { chatApproveChats: [...(t["chatApproveChats"] as ChatProvider[])] } : {}),
      absoluteExpiry: t["absoluteExpiry"],
    };
  }
  return null;
}

/** The chat apps a mode lets its signer approve from: none without chatApprove; Telegram alone for a grant signed
 * before it named its apps (that is what its words said); otherwise exactly the apps it names. */
export function chatApproveChatsOf(terms: Pick<ModeTerms, "chatApprove" | "chatApproveChats">): readonly ChatProvider[] {
  return !terms.chatApprove ? [] : terms.chatApproveChats ?? ["telegram"];
}

/** What a new chatApprove signature names: every chat app, said in its words. */
export const CHAT_APPROVE_ALL: readonly ChatProvider[] = CHAT_PROVIDERS;

const CHAT_NAMES: Record<ChatProvider, string> = { telegram: "Telegram", slack: "Slack", discord: "Discord", teams: "Teams" };
/** "Telegram", "Telegram or Slack", "Telegram, Slack, Discord or Teams". */
export const chatNames = (chats: readonly ChatProvider[]): string =>
  chats.length <= 1 ? chats.map(one => CHAT_NAMES[one]).join("") : `${chats.slice(0, -1).map(one => CHAT_NAMES[one]).join(", ")} or ${CHAT_NAMES[chats[chats.length - 1]!]}`;

/** Every term in words — what the ceremony renders and the password
 * signs. The reversal sentence is verbatim from the chain (C1). */
export function modeWords(terms: ModeTerms): string[] {
  return [
    terms.permissionDefault === "escalated"
      ? "new filings default to FULL permissions: claude runs with --dangerously-skip-permissions, gemini with --approval-mode yolo (codex-shaped lanes have one posture; this changes nothing for them)"
      : "new filings use safe unattended permissions: routine project commands and edits proceed; risky acts stop for approval",
    terms.autoApproveFiling
      ? "every scope YOU file — signed-in console or credentialed CLI — is approved the moment you file it; while this mode is active, your signed-in browser session becomes a spend credential for this repository"
      : "filings still wait for their own approval ceremony",
    terms.quickMint
      ? "you start watched sessions without re-typing your password — the confirm screen still shows every term"
      : "watched sessions keep the per-session password",
    terms.planAuto
      ? "plans for your pre-authorized filings auto-approve only when the goal, exclusions, paths, acceptance criteria, risk, budget, and agent route remain exactly unchanged; provide a goal, paths and acceptance criteria upfront; amendments and unresolved questions still wait for you"
      : "planner-generated plans wait for your approval",
    terms.name === "hands-off"
      ? "automatic review is on for this project unless you turn it off (`toolroll review off --repo <path>`): each finished build whose check passes (or that finishes, with checks Off) gets one read-only review by the project's review agent; a HIGH finding sends it back once as a revision filed under this mode, a HIGH on that revision comes to you, MEDIUM and LOW findings come to you as suggested follow-ups, and a review that fails or times out never holds the work — it reaches you marked not reviewed"
      : "finished work and saved checks go to the lead or user; automatic review runs only where a project turns it on (`toolroll review on --repo <path>`)",
    ...(terms.reviewAuto || terms.reviewRetryAuto
      ? ["historical review grants are retained on record but no longer schedule work"] : []),
    terms.perAttemptBudgetMicrousd === null
      ? "filings carry no default dollar cap"
      : `filings that name no budget get a $${(terms.perAttemptBudgetMicrousd / 1_000_000).toFixed(2)} per-attempt cap`,
    terms.dailyMeasuredCapMicrousd === null
      ? "no daily dollar rail"
      : `new admissions stop once the day's MEASURED spend reaches $${(terms.dailyMeasuredCapMicrousd / 1_000_000).toFixed(2)} — running work may finish past it, and unmeasured providers ride outside this number`,
    terms.dailyRunCap === null
      ? "no daily run rail"
      : `at most ${terms.dailyRunCap} agent starts per UTC day, every provider counted, reserved at admission`,
    terms.publication === "automerge"
      ? "pull requests merge THEMSELVES when CI is seen green on the exact commit — you are told afterwards (requires a merge-capable publication grant)"
      : "merges wait for you — even where a grant could merge on its own, while this mode is active",
    terms.allowPaidFallback
      ? "when a subscription is exhausted mid-build, an approved fallback that spends (an API key) may run automatically — spend moves to that account"
      : "automatic fallback never switches to a paid API key on its own; a subscription that runs out stops and waits for you",
    ...(terms.repairAuto
      ? ["historical automatic repair grants are retained on record but no longer schedule work"] : []),
    ...(terms.chatApprove
      ? [`your paired ${chatNames(chatApproveChatsOf(terms))} chat may approve this repository's plans and merge its ready pull requests, two taps each, without your password; a plan that widens permissions, exceeds the per-attempt cap above or touches protected paths still opens Toolroll`] : []),
    `everything above ends at ${terms.absoluteExpiry.slice(0, 16).replace("T", " ")} — revoking it earlier is one click, and every act it covered falls back to its own ceremony`,
  ];
}
