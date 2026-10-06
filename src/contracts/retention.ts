/**
 * Retention settings (retention.ts): which kinds of data have a period, and how long each is kept — a whole number of
 * days from 1 to 3650, or null for forever. One schema for the kind, the period and the full set of periods; the
 * types retention.ts exports are derived from them.
 *
 * `retention_setting` rows are read by the store (`retentionChosen`, item 18's to move onto `retentionRowSchema`): a
 * row's kind and days as SQLite's CHECK constraint keeps them, unknown columns ignored. Text a person types ("90d",
 * "1y", "forever") is turned into days in plain code (retention.ts `parsePeriod`) and then checked by this schema.
 */

import { z } from "zod";

export const RETENTION_KIND_VALUES = ["evidence", "checkouts", "chat", "notifications"] as const;
export const retentionKindSchema = z.enum(RETENTION_KIND_VALUES);

export const RETENTION_DAYS = { min: 1, max: 3650 } as const;

/** A period: whole days from 1 to 3650, or null for forever. */
export const retentionDaysSchema = z.int().min(RETENTION_DAYS.min).max(RETENTION_DAYS.max).nullable();

/** Every kind's period, as the sweep and the settings page read them. */
export const retentionPeriodsSchema = z.object({
  evidence: retentionDaysSchema,
  checkouts: retentionDaysSchema,
  chat: retentionDaysSchema,
  notifications: retentionDaysSchema,
});

/** A saved `retention_setting` row: only a kind someone chose has one. */
export const retentionRowSchema = z.object({ kind: retentionKindSchema, days: retentionDaysSchema });

export type RetentionKind = z.infer<typeof retentionKindSchema>;
export type RetentionPeriods = z.infer<typeof retentionPeriodsSchema>;
