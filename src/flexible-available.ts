/**
 * Flexible projects (docs: the Flexible plan v2, slice F1): whether this build offers them at all.
 *
 * A compile-time constant, never a setting: no environment variable, config key, database row, flag or token reads or
 * changes it, and nothing here exports a way to. While it is false every Flexible writer refuses (enable, lower, off,
 * the delegation check a thread start makes), the CLI says it isn't available, and no page offers it. It is turned on
 * by changing this line in the release whose thread engine, chat and ship slices have passed their attack rows.
 *
 * Tests reach the enabled behaviour only by replacing this module with vi.mock; src/flexible-disabled.test.ts keeps
 * this file exactly one literal, imported only by name, so that seam can't become a runtime override.
 */
export const FLEXIBLE_AVAILABLE: boolean = false;
