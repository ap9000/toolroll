/**
 * v169: task sizing by a quick model call (task-sizing.ts). Adds, and changes no saved row:
 *
 * - `task_sizing_setting`: Settings → General's switch, one row once a person chose (no row reads off, so a new install
 *   and an upgraded one start with no model call before a yes), with the classifier they turned it on for: Claude Haiku
 *   on their plan (`claude`) or Jev through their OpenRouter key (`jev`).
 * - `task_ref.size_by`: which classifier answered a task's size, in Toolroll's own words ("Claude Haiku 5.5"); a saved
 *   size reads none (NULL), as a size the words alone gave does.
 *
 * Kept apart from the store so the update road can read the lists without it.
 */

export const V169_SCHEMA = `
CREATE TABLE IF NOT EXISTS task_sizing_setting (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  enabled    INTEGER NOT NULL CHECK (enabled IN (0,1)),
  sizer      TEXT CHECK (sizer IN ('claude','jev')),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export const V169_ADDED_COLUMNS: Readonly<Record<string, Readonly<Record<string, { definition: string; saved: string }>>>> = Object.freeze({
  task_ref: { size_by: { definition: "TEXT", saved: "NULL" } },
});

export const V169_TABLES = Object.freeze(["task_sizing_setting"] as const);
/** The v169 migration's steps, in order (a test seam may stop after each). */
export const V169_STEPS = Object.freeze(["task-sizing-setting", "task-sizing-columns"] as const);
