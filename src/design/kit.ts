/**
 * The revamp kit's words and rules, shared by the server's HTML kit (src/server/kit.ts) and the React kit
 * (src/browser/kit/), so both draw the same thing from the same facts. No DOM, no server state: the rules
 * are in src/design/KIT.md, the look in src/design/kit.css.
 *
 * The approval helpers here decide only what a page SHOWS (a password field, one click, or no button). The server
 * still proves every act at the moment it happens (scope.ts freshness, passwordless.ts, people-tokens.ts); a page
 * that shows one click for an act the server then refuses says so in place.
 */
import { HEADLINE_TONE, type Headline } from "../task-status.js";

// ---- status: five words, one tone each -------------------------------------------------------------------------

/** The five status words. */
export type StatusKey = "needs" | "running" | "queued" | "finished" | "failed";
/** A chip's tone: "" is neutral; "ask" names a specific ask inside a Needs-you group (ink words, amber dot). */
export type ChipTone = "" | "needs" | "ask" | "live" | "done" | "failed";

export const STATUS: Readonly<Record<StatusKey, { word: string; tone: ChipTone }>> = {
  needs: { word: "Needs you", tone: "needs" },
  running: { word: "Running", tone: "live" },
  queued: { word: "Queued", tone: "" },
  finished: { word: "Finished", tone: "done" },
  failed: { word: "Failed", tone: "failed" },
};

/** A task's headline (task-status.ts) as the kit's chip: its own word, in the tone of the status it belongs to. A
 * row that waits on a person never shows a failure tone; something that waits on someone else is never amber. */
export function chipOfHeadline(headline: Headline): { word: string; tone: ChipTone; status: StatusKey } {
  const status = statusOfHeadline(headline);
  return { word: headline === "Needs you" ? STATUS.needs.word : headline, tone: STATUS[status].tone, status };
}

/** Which of the five a headline is. */
export function statusOfHeadline(headline: Headline): StatusKey {
  switch (HEADLINE_TONE[headline]) {
    case "attention": case "ready": return "needs";
    case "live": return "running";
    case "success": return "finished";
    case "danger": return "failed";
    case "neutral": return "queued";
  }
}

/** Resource states (a computer that builds, not work): never amber. */
export const RESOURCE: Readonly<Record<"idle" | "building" | "offline", { word: string; tone: ChipTone }>> = {
  idle: { word: "Idle", tone: "" },
  building: { word: "Building", tone: "live" },
  offline: { word: "Offline", tone: "failed" },
};

// ---- approval: what a page shows for an act ----------------------------------------------------------------------

/**
 * none = one click (answer, accept, retry, merge, remove a hold);
 * standard = a password unless Passwordless is on or a password was typed in the last 15 minutes here;
 * step-up = a password unless Passwordless is on;
 * way-in = anything that creates or widens a way in (invites, tokens, sign-in methods, widening access):
 *          always the password typed now.
 */
export type ApprovalKind = "none" | "standard" | "step-up" | "way-in";
export const APPROVAL_KINDS: readonly ApprovalKind[] = ["none", "standard", "step-up", "way-in"];

/** The facts a page has about this person and act, as the server read them for this page. */
export type ApprovalFacts = {
  /** Passwordless is on for this signed-in browser (html.ts passwordlessRendering). */
  passwordless: boolean;
  /** A recently typed password would stand in for this act now (scope.ts freshnessFor preview): the act is allowlisted and
   * the password was typed on this session within the window. Only a standard act honours it. */
  remembered: boolean;
  /** When the remembered password stops counting, as words ("10:47"), for the terms line. */
  rememberedUntil?: string | null;
  /** An automatic-approval rule covers this act: the page shows no button at all. Never for way-in. */
  automatic?: boolean;
};

/** What the page shows: a password field, one click, or no button (approved automatically). */
export type ApprovalAsk = "password" | "click" | "automatic";

export function approvalAsk(kind: ApprovalKind, facts: ApprovalFacts): ApprovalAsk {
  if (kind === "way-in") return "password";
  if (facts.automatic === true) return "automatic";
  if (kind === "none") return "click";
  if (facts.passwordless) return "click";
  if (kind === "standard" && facts.remembered) return "click";
  return "password";
}

/** How a click without a password is justified, for the record line after an approval. */
export function approvalHow(kind: ApprovalKind, facts: ApprovalFacts): "password" | "remembered" | "passwordless" | "none" | "automatic" {
  const ask = approvalAsk(kind, facts);
  if (ask === "password") return "password";
  if (ask === "automatic") return "automatic";
  if (kind === "none") return "none";
  return facts.passwordless ? "passwordless" : "remembered";
}

/** The terms line under an approval: which rule applies, in words. Empty for a one-click act. */
export function termsOf(kind: ApprovalKind, facts: ApprovalFacts): string {
  if (kind === "way-in") {
    if (facts.passwordless) return "Passwordless is on, but this creates a new way in, so it still asks for your password.";
    if (facts.remembered) return "A remembered password doesn’t count here: this creates a new way in.";
    return "This creates a new way in, so it always asks for your password.";
  }
  if (facts.automatic === true) return "Approved automatically by your rule.";
  if (kind === "none") return "";
  if (facts.passwordless) return "No password needed: Passwordless is on for your account.";
  if (kind === "standard" && facts.remembered) return facts.rememberedUntil ? `No password needed: remembered on this computer until ${facts.rememberedUntil}.` : "No password needed: remembered on this computer.";
  return "Asks for your password.";
}

// ---- time and counts --------------------------------------------------------------------------------------------

/** A duration in seconds as the timing rows say it: "38s", "6m 12s", "1h 25m". */
export function dur(seconds: number): string {
  const n = Math.max(0, Math.round(seconds));
  if (n < 60) return `${n}s`;
  if (n < 3600) return `${Math.floor(n / 60)}m ${String(n % 60).padStart(2, "0")}s`;
  return `${Math.floor(n / 3600)}h ${String(Math.floor((n % 3600) / 60)).padStart(2, "0")}m`;
}

/** "3 flows", "1 flow". */
export const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

// ---- timing rows ------------------------------------------------------------------------------------------------

/** A step's state on the timing axis. */
export type TimingState = "ok" | "run" | "q" | "bad" | "wait";
export const TIMING_WORDS: Readonly<Record<TimingState, string>> = { ok: "Done", run: "Now", q: "Queued", bad: "Failed", wait: "Needs you" };
export type TimingRow = { name: string; sub?: string; st: TimingState; start: number; dur: number };
/** Each row's bar as percentages of one shared axis; a queued row has no bar until it starts. */
export function timingBars(rows: readonly TimingRow[], scale?: number): Array<{ left: number; width: number } | null> {
  const sc = scale ?? Math.max(1, ...rows.map(row => row.start + (row.st === "q" ? 0 : row.dur))) * 1.02;
  return rows.map(row => row.st === "q" ? null : { left: (Math.max(0, row.start) / sc) * 100, width: (Math.max(row.dur, sc / 400) / sc) * 100 });
}

// ---- progress line -----------------------------------------------------------------------------------------------

/** One step on a progress line: done (a check), now (waits on you: amber), live (running: blue), failed, or to do. */
export type StepState = "done" | "now" | "live" | "failed" | "todo";
export type StepItem = { label: string; state: StepState; sub?: string };
/** The words a screen reader hears for a step's state. */
export const STEP_WORDS: Readonly<Record<StepState, string>> = { done: "done", now: "waiting on you", live: "in progress", failed: "failed", todo: "not started" };
/** How far the line is filled, 0–1: up to the current step (the first that isn't done), or all of it. */
export function stepsFill(steps: readonly StepItem[]): number {
  if (steps.length < 2) return steps.length === 1 && steps[0]!.state === "done" ? 1 : 0;
  const at = steps.findIndex(step => step.state !== "done");
  return at === -1 ? 1 : at / (steps.length - 1);
}

// ---- icons ------------------------------------------------------------------------------------------------------

/** One shape of a 24×24 stroke icon: its element and attributes (data, so each side draws it with its own escaping). */
export type IconShape = readonly ["path", { readonly d: string }] | readonly ["circle", { readonly cx: number; readonly cy: number; readonly r: number }] | readonly ["rect", { readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly rx: number }];
const path = (d: string): IconShape => ["path", { d }];
const circle = (cx: number, cy: number, r: number): IconShape => ["circle", { cx, cy, r }];
/** The icons the kit draws (lucide shapes). */
export const KIT_ICONS = {
  plus: [path("M12 5v14"), path("M5 12h14")],
  send: [path("M12 19V5"), path("m5 12 7-7 7 7")],
  stop: [["rect", { x: 6, y: 6, width: 12, height: 12, rx: 2 }]],
  x: [path("M18 6 6 18"), path("m6 6 12 12")],
  back: [path("m15 18-6-6 6-6")],
  menu: [path("M4 6h16"), path("M4 12h16"), path("M4 18h16")],
  search: [circle(11, 11, 7), path("m20 20-3.5-3.5")],
  chevron: [path("m6 9 6 6 6-6")],
  check: [path("M20 6 9 17l-5-5")],
  alert: [circle(12, 12, 9), path("M12 8v4"), path("M12 16h.01")],
  more: [circle(5, 12, 1), circle(12, 12, 1), circle(19, 12, 1)],
  file: [path("M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"), path("M14 3v5h5")],
  // The Settings groups' icons (wave D; SETTINGS_GROUP_ICONS).
  sun: [circle(12, 12, 4), path("M12 2v2"), path("M12 20v2"), path("m4.93 4.93 1.41 1.41"), path("m17.66 17.66 1.41 1.41"), path("M2 12h2"), path("M20 12h2"), path("m6.34 17.66-1.41 1.41"), path("m19.07 4.93-1.41 1.41")],
  cpu: [["rect", { x: 4, y: 4, width: 16, height: 16, rx: 2 }], ["rect", { x: 9, y: 9, width: 6, height: 6, rx: 1 }], path("M15 2v2"), path("M15 20v2"), path("M2 15h2"), path("M2 9h2"), path("M20 15h2"), path("M20 9h2"), path("M9 2v2"), path("M9 20v2")],
  bell: [path("M10.27 21a2 2 0 0 0 3.46 0"), path("M3.26 15.33A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.67C19.41 13.96 18 12.5 18 8A6 6 0 0 0 6 8c0 4.5-1.41 5.96-2.74 7.33")],
  shield: [path("M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z")],
  folder: [path("M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z")],
  people: [path("M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"), circle(9, 7, 4), path("M22 21v-2a4 4 0 0 0-3-3.87"), path("M16 3.13a4 4 0 0 1 0 7.75")],
  coin: [circle(12, 12, 10), path("M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"), path("M12 18V6")],
  monitor: [["rect", { x: 2, y: 3, width: 20, height: 14, rx: 2 }], path("M8 21h8"), path("M12 17v4")],
  list: [path("M8 6h13"), path("M8 12h13"), path("M8 18h13"), path("M3 6h.01"), path("M3 12h.01"), path("M3 18h.01")],
  board: [["rect", { x: 3, y: 3, width: 18, height: 18, rx: 2 }], path("M9 3v18"), path("M15 3v18")],
  panel: [["rect", { x: 3, y: 3, width: 18, height: 18, rx: 2 }], path("M15 3v18")],
} as const satisfies Record<string, readonly IconShape[]>;
export type KitIcon = keyof typeof KIT_ICONS;

// ---- settings frame ---------------------------------------------------------------------------------------------

/** The eight Settings groups, in order: [label, slug, href]. */
export const SETTINGS_GROUPS: ReadonlyArray<readonly [label: string, slug: string, href: string]> = [
  ["General", "general", "/settings/general"],
  ["Agents and models", "agents", "/settings/agents"],
  ["Chat apps and alerts", "alerts", "/settings/alerts"],
  ["Approvals and safety", "approval", "/settings/approval"],
  ["Projects", "projects", "/settings/projects"],
  ["People and sign-in", "access", "/settings/access"],
  ["Spend", "spend", "/spend"],
  ["System", "system", "/settings/system"],
];

/** Each group's icon on the Settings overview (wave D). */
export const SETTINGS_GROUP_ICONS: Readonly<Record<string, KitIcon>> = {
  general: "sun", agents: "cpu", alerts: "bell", approval: "shield", projects: "folder", access: "people", spend: "coin", system: "monitor",
};

/** How a Settings row says what waits on this person: "1 item needs you", "2 items need you". */
export const needsWords = (n: number): string => n === 1 ? "1 item needs you" : `${n} items need you`;

/** The not-found page's default words. */
export const NOT_FOUND = {
  title: (path: string): string => `There’s no page at ${path}.`,
  text: "It may have moved. Home has what needs you; Tasks has every task.",
};
