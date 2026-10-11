import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILT_IN, openStore, verifiedAuthor, type Store } from "./store.js";
import { openSteerMailbox, pulseSteerMailbox } from "./steer-mailbox.js";
import { steerFolderName } from "./evidence.js";

/** What the agent does in the instant after the pulse renames a note into place. */
const afterRename = vi.hoisted(() => ({ current: null as ((target: string) => void) | null }));
vi.mock("node:fs", async importOriginal => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    renameSync: (from: string, to: string) => {
      real.renameSync(from, to);
      const swap = afterRename.current;
      afterRename.current = null;
      swap?.(to);
    },
  };
});

const T0 = new Date("2026-10-11T12:00:00.000Z");
const T1 = new Date(T0.getTime() + 60_000);
const KEY = "0123456789abcdef";
const legacy = { route: { routeDigest: "legacy", phase: "build" as const, provider: "claude", model: null, chosen: "legacy" as const } };

let store: Store, worktree: string, outside: string, taskRef: number, runId: number, folder: string;
beforeEach(() => {
  store = openStore(":memory:");
  store.createTask({ id: "t-1", title: "the work" }, T0);
  taskRef = store.refFor(BUILT_IN, "t-1").id;
  worktree = mkdtempSync(join(tmpdir(), "so-steer-links-"));
  outside = mkdtempSync(join(tmpdir(), "so-steer-outside-"));
  runId = store.startRun({ taskRef, leaseId: "lease", runner: "builder-1", branch: "feat/a", worktree, now: T0, ...legacy });
  folder = steerFolderName();
});
afterEach(() => {
  afterRename.current = null;
  store.close();
  rmSync(worktree, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const file = (note: string) => {
  const filed = store.fileSteerNote("t-1", verifiedAuthor("alex"), note, T0);
  if (!filed.ok) throw new Error(filed.reason);
  return filed.id;
};
const note = (id: number) => store.listSteerNotes(taskRef).find(one => one.id === id)!;

describe("the steering pulse never deletes through a link the agent planted", () => {
  test("a note file replaced by a symlink to an outside file leaves that file in place", () => {
    const precious = join(outside, "state.db");
    writeFileSync(precious, "keep me");
    const box = openSteerMailbox(worktree, folder, runId, taskRef, KEY)!;
    file("prefer the smaller diff");
    afterRename.current = target => { rmSync(target); symlinkSync(precious, target); };

    pulseSteerMailbox(store, box, T1, true);

    expect(readFileSync(precious, "utf8")).toBe("keep me");
  });

  test("a folder swapped for a link right after the write deletes nothing and leaves the note unrecorded", () => {
    const box = openSteerMailbox(worktree, folder, runId, taskRef, KEY)!;
    const id = file("prefer the smaller diff");
    afterRename.current = () => {
      rmSync(join(worktree, folder), { recursive: true });
      writeFileSync(join(outside, "001.json"), "keep me");
      symlinkSync(outside, join(worktree, folder));
    };

    pulseSteerMailbox(store, box, T1, true);

    expect(readFileSync(join(outside, "001.json"), "utf8")).toBe("keep me");
    expect(note(id).mailedRun).toBeNull();
  });
});
