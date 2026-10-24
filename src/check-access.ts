/**
 * Check access (v132, docs/plans/check-access.md): how far a project's setup and check commands reach beyond the
 * plane's check fence. `sandboxed` (the default) is the fence as it is; `sign-ins` also reads the exact sign-in files
 * of Claude, Codex and gh, under the project's network fence; `unsandboxed` runs them with no OS fence, trusted by the
 * whole instance, for a project whose checks must create sandboxes themselves (Toolroll's own). Widening is an instance
 * operator's act with a password typed now; any approver for the project may narrow it back.
 */

export const CHECK_ACCESS_LEVELS = ["sandboxed", "sign-ins", "unsandboxed"] as const;
export type CheckAccess = typeof CHECK_ACCESS_LEVELS[number];
export const CHECK_ACCESS_DEFAULT: CheckAccess = "sandboxed";

export const isCheckAccess = (value: unknown): value is CheckAccess => typeof value === "string" && (CHECK_ACCESS_LEVELS as readonly string[]).includes(value);

/** A stored or sealed value as a level: anything missing or unreadable is the narrowest, never a wider one. */
export const checkAccessOf = (value: unknown): CheckAccess => isCheckAccess(value) ? value : CHECK_ACCESS_DEFAULT;

const RANK: Readonly<Record<CheckAccess, number>> = { sandboxed: 0, "sign-ins": 1, unsandboxed: 2 };
export const widerThan = (a: CheckAccess, b: CheckAccess): boolean => RANK[a] > RANK[b];
/** The narrowest of several levels (none given: the default). */
export const narrowestAccess = (levels: readonly CheckAccess[]): CheckAccess =>
  levels.reduce<CheckAccess>((low, one) => RANK[one] < RANK[low] ? one : low, levels.length === 0 ? CHECK_ACCESS_DEFAULT : "unsandboxed");

/** The level as a person reads it, in a sentence's middle ("Checks: …"). */
export function checkAccessWords(level: CheckAccess): string {
  return level === "sandboxed" ? "sandboxed" : level === "sign-ins" ? "sandboxed, with model and GitHub sign-ins" : "not sandboxed";
}

/** What each wider level means, said before anyone chooses it. */
export const CHECK_ACCESS_WARNINGS: Readonly<Record<Exclude<CheckAccess, "sandboxed">, string>> = {
  "sign-ins": "This project's checks can read your Claude, Codex and GitHub sign-ins. Its tests could use or send those credentials anywhere its network setting allows. Only choose this for projects you trust.",
  unsandboxed: "This project's checks get your full access to this machine and to Toolroll itself, including its database and every sign-in. Only for a project whose checks must create sandboxes themselves, such as Toolroll's own.",
};
