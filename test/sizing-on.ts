/** Task sizing by a quick model call turned on (it is off by default, task-sizing.ts taskSizingSetting), for a test that
 * exercises the classifier road. Written as the setting's own row, without the ledger row a person's act adds. */
import type { Store } from "../src/store.js";

export function sizingOn(store: Store): void {
  store.handle.prepare(`INSERT INTO task_sizing_setting (id, enabled, updated_by, updated_at) VALUES (1, 1, 'test', '2026-01-01T00:00:00.000Z')
    ON CONFLICT(id) DO UPDATE SET enabled = 1`).run();
}
