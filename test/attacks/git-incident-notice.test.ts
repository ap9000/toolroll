/**
 * A git incident (teardown-git.ts: a folder of the repository changed while the plane's git ran) reaches a person: the
 * console and the background worker register their store's outbox as they start (operate.ts), and every incident
 * raises one attention notification there, scoped to the project, naming what changed.
 */
import { afterEach, describe, expect, test } from "vitest";
import { gitIncident, noticeGitIncidents } from "../../src/git-incident.js";
import { openStore, type Store } from "../../src/store.js";

let store: Store | null = null;
afterEach(() => { store?.close(); store = null; });

describe("git incidents in the console's outbox", () => {
  test("one attention notification per incident, once per store however often it is registered", () => {
    store = openStore(":memory:");
    const stop = noticeGitIncidents(store);
    noticeGitIncidents(store);
    try {
      gitIncident({ checkout: "/p/worktrees/t1", repository: "/p/project/.git", swapped: [{ path: "/p/project/.git/refs", leadsTo: "/elsewhere/refs" }], record: "/dev/null" });
      const rows = store.listNotifications("pending").filter(row => row.kind === "git-incident");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ pushClass: "attention", subject: "Git incident in project: a folder of its repository changed while Toolroll's git ran" });
      expect(rows[0]!.body).toContain("/p/project/.git/refs → /elsewhere/refs");
    } finally { stop(); }
  });
});
