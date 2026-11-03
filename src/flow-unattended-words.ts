/** The words a "runs on its own" grant signs (flow-unattended.ts), kept free of server imports so the flow page's
 * signing form says each limit exactly as the signature will. */

export const dollarWords = (micro: number) => `$${(micro / 1_000_000).toFixed(2)}`;

/** The most runs a day a grant may allow. */
export const UNATTENDED_MAX_RUNS = 50;
/** The largest per-attempt budget a grant may name: $100. */
export const UNATTENDED_MAX_BUDGET_MICROUSD = 100_000_000;

/** A per-attempt budget as typed ("5", "$7.50", "" for no cap), the one way the server and the flow page read it. */
export function unattendedBudgetOf(typed: string): { ok: true; value: number | null } | { ok: false; message: string } {
  const text = typed.trim().replace(/^\$/, "");
  if (text === "") return { ok: true, value: null };
  const value = Number(text);
  if (!/^\d+(\.\d{1,2})?$/.test(text) || value <= 0 || Math.round(value * 1_000_000) > UNATTENDED_MAX_BUDGET_MICROUSD) return { ok: false, message: `Give the budget in dollars, up to ${dollarWords(UNATTENDED_MAX_BUDGET_MICROUSD)}, or leave it empty.` };
  return { ok: true, value: Math.round(value * 1_000_000) };
}

/** Runs a day as typed ("3", "" for no limit), the one way the server and the flow page read it. */
export function unattendedRunsOf(typed: string): { ok: true; value: number | null } | { ok: false; message: string } {
  const text = typed.trim();
  if (text === "") return { ok: true, value: null };
  const value = Number(text);
  if (!/^\d+$/.test(text) || !Number.isInteger(value) || value < 1 || value > UNATTENDED_MAX_RUNS) return { ok: false, message: `Give runs a day as 1 to ${UNATTENDED_MAX_RUNS}, or leave it empty.` };
  return { ok: true, value };
}

/** "Oct 19": the end's day, where space is short (the exact time goes beside it, on hover). */
export const untilDayWords = (iso: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(iso));

/** "Oct 19, 14:05 UTC": the expiry as every surface says it. */
export const untilWords = (iso: string) => `${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(iso))}, ${iso.slice(11, 16)} UTC`;

/** Who approves, with what permissions and against which criteria. */
export function unattendedHeadWords(owner: string, acceptance: { task: readonly { statement: string }[]; report: readonly { statement: string }[] }): string[] {
  return [
    `Cards this flow's own schedule adds file their work approved by ${owner}, without waiting in Needs you.`,
    "Builds use safe permissions: routine project commands and edits proceed; risky acts stop for approval.",
    `Builds are checked against: “${acceptance.task.map(one => one.statement).join("”; “")}”.`,
    `Research is checked against: “${acceptance.report.map(one => one.statement).join("”; “")}”.`,
  ];
}

/** "daily at 09:00" from a stored schedule ("daily:09:00@Europe/London"), kept here so every surface says it alike. */
export function scheduleWords(stored: string): string {
  const days = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
  const [when, zone] = stored.split("@");
  const parts = (when ?? "").split(":");
  const tz = zone === undefined ? "" : ` ${zone}`;
  if (parts[0] === "every") {
    const n = Number(parts[1]);
    return n % 1440 === 0 ? `every ${n / 1440} day${n === 1440 ? "" : "s"}` : n % 60 === 0 ? `every ${n / 60} hour${n === 60 ? "" : "s"}` : `every ${n} minutes`;
  }
  if (parts[0] === "daily" || parts[0] === "weekdays") return `${parts[0]} at ${parts[1]}:${parts[2]}${tz}`;
  if (parts[0] === "weekly") return `${days[Number(parts[1])] ?? "weekly"} at ${parts[2]}:${parts[3]}${tz}`;
  return stored;
}

/** Which schedules the grant covers, by name and time. */
export const unattendedCoverWords = (triggers: readonly { words: string }[]) =>
  `It covers ${triggers.length === 1 ? "this schedule" : "these schedules"} when ${triggers.length === 1 ? "it fires" : "they fire"} on time: ${triggers.map(one => one.words).join("; ")}. Run now, and schedules added or changed later, wait for you.`;

/** The optional limits. */
export function unattendedLimitWords(budgetMicrousd: number | null, dailyRunCap: number | null): string[] {
  return [
    budgetMicrousd === null ? "No dollar cap per attempt." : `Each attempt may spend up to ${dollarWords(budgetMicrousd)}.`,
    dailyRunCap === null ? "No daily limit on runs." : `At most ${dailyRunCap} run${dailyRunCap === 1 ? "" : "s"} a day (UTC); after that, cards wait for you.`,
  ];
}

/** What it never covers, and what ends it. */
export const UNATTENDED_RULE_WORDS: readonly string[] = [
  "Plans are approved only when they keep the filed request exactly. Questions and plan changes still wait for you.",
  "Never covered: Person decides steps, pull request merges, publish or deploy scripts, and anything it sends. Cards people add and other triggers wait as usual.",
  "Editing the flow, its schedules, a script they run or a project file it imports, changing its owner, the owner losing access, or protecting the project ends this.",
  "Signing again replaces it: work it approved that hasn't started goes back to waiting for you.",
];

export const unattendedEndWords = (expiry: string) => `Ends ${untilWords(expiry)}. Revoking it earlier is one click.`;
export const unattendedEndAfterWords = (days: number) => `Ends ${days} day${days === 1 ? "" : "s"} after you sign. Revoking it earlier is one click.`;
