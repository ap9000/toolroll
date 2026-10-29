import { presented } from "../test/route-fixture.js";
/** Existing feedback survives the additive image-target migration. Isolated databases only. */
import { test, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, SCHEMA_VERSION } from "./store.js";
import { historySnapshot, changedHistory } from "./toolroll-update.js";

test.each([136, -136])("v%s feedback retains its file, line, text and source key with no image", version => {
  const dir = mkdtempSync(join(tmpdir(), "toolroll-feedback-migration-"));
  const file = join(dir, "state.db"), now = new Date("2026-10-28T00:00:00Z");
  try {
    const first = openStore(file);
    first.createTask({ id: "sample", title: "A saved result" }, now);
    const ref = first.refFor("built-in", "sample").id;
    const run = first.startRun({ taskRef: ref, leaseId: "sample", runner: "sample", provider: "claude", ...presented(first, ref), branch: "sample", worktree: dir, now });
    const artifact = first.saveArtifact({ run, kind: "terminal-diff", key: "1/diff", bytesOriginal: 1, bytesStored: 1, truncated: false, sha256: "a".repeat(64), capture: "fixture" }, now);
    first.addDiffComment({ artifactId: artifact, runId: run, path: "src/nav.ts", line: 4, note: "Keep this spacing.", author: "reviewer", sourceKey: "saved-note" }, now);
    first.close();
    const old = new DatabaseSync(file);
    old.exec("ALTER TABLE diff_comment DROP COLUMN image_json");
    old.prepare("UPDATE schema_version SET version = ?").run(version);
    const before = historySnapshot(old);
    old.close();
    const migrated = openStore(file);
    expect(migrated.allDiffComments(run)[0]).toMatchObject({ path: "src/nav.ts", line: 4, note: "Keep this spacing.", sourceKey: "saved-note", image: null });
    expect(migrated.handle.prepare("SELECT version FROM schema_version").get()?.["version"]).toBe(SCHEMA_VERSION);
    expect(changedHistory(migrated.handle, before)).toEqual([]);
    expect(migrated.handle.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    migrated.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
