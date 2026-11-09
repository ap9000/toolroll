/**
 * v158: the lead's latency records and its quick-answer switch (docs/plans/responsive-chat.md, slice 5). Adds only:
 * a saved row reads as it did. Kept beside nothing else so the update road can read the lists without the store.
 *
 * - `chat_turn.tools`: the tool names one lead step asked for, as a JSON array of names (never arguments); saved rows
 *   read NULL (not recorded). So the next latency decision (a prefetched brief, §7.2) is made from data.
 * - `chat_turn.failure_detail` and `mate_turn.failure_detail`: why a step or reply failed, more exactly than
 *   failure_reason (LEAD_FAILURE_DETAILS); saved rows read NULL (unknown), and read the plain reason's words as before.
 * - `mate_turn.route`: which model answered (§8): `default`, `fast` (the quick model answered) or `escalated` (a quick
 *   step asked for more than reading, so the main model took the reply over); saved rows read NULL (before routing).
 * - `lead_quick_setting`: Settings → Lead's "Quick answers use a faster model", one row; absent reads off.
 */
export const LEAD_FAILURE_DETAILS = ["not-installed", "sign-in", "refused", "lost", "timeout-silent", "timeout-output"] as const;
export type LeadFailureDetail = typeof LEAD_FAILURE_DETAILS[number];
export const LEAD_ROUTES = ["default", "fast", "escalated"] as const;
export type LeadRoute = typeof LEAD_ROUTES[number];

const detailCheck = (column: string): string => `TEXT CHECK (${column} IS NULL OR ${column} IN (${LEAD_FAILURE_DETAILS.map(one => `'${one}'`).join(",")}))`;

export const V158_SCHEMA = `
CREATE TABLE IF NOT EXISTS lead_quick_setting (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  enabled    INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export const V158_ADDED_COLUMNS: Readonly<Record<string, Readonly<Record<string, { definition: string; saved: string }>>>> = Object.freeze({
  chat_turn: {
    tools: { definition: "TEXT", saved: "NULL" },
    failure_detail: { definition: detailCheck("failure_detail"), saved: "NULL" },
  },
  mate_turn: {
    route: { definition: `TEXT CHECK (route IS NULL OR route IN (${LEAD_ROUTES.map(one => `'${one}'`).join(",")}))`, saved: "NULL" },
    failure_detail: { definition: detailCheck("failure_detail"), saved: "NULL" },
  },
});

export const V158_TABLES = Object.freeze(["lead_quick_setting"] as const);
/** The v158 migration's steps, in order (a test seam may stop after each). */
export const V158_STEPS = Object.freeze(["lead-quick-setting", "lead-latency-columns"] as const);
