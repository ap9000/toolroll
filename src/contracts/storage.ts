/**
 * The checkout cleanup setting (storage.ts, Settings → Storage): when a finished task's clean checkout is removed.
 * One schema for the four values `checkout_cleanup_setting.cleanup` may hold, and `CheckoutCleanup` derived from it.
 * The words a person types ("week", "off", "2 days") become a value in plain code (storage.ts `parseCleanup`) and
 * are then checked by this schema. The saved row is read by the store (item 18's to move onto `checkoutCleanupRowSchema`).
 */

import { z } from "zod";

export const checkoutCleanupSchema = z.enum(["finished", "2d", "7d", "never"]);

/** A saved `checkout_cleanup_setting` row (at most one; none means the default), unknown columns ignored. */
export const checkoutCleanupRowSchema = z.object({ cleanup: checkoutCleanupSchema });

export type CheckoutCleanup = z.infer<typeof checkoutCleanupSchema>;
