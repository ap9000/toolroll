/**
 * Live terminals and the updater (review round 2, finding 7): a running terminal is active work an update waits for,
 * no terminal starts while an update owns admission, and a gone console's rows are stale.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openStore, type Store } from "./store.js";
import { activeUpdateWork, freezeUpdateGate, installUpdateGate, removeUpdateGate } from "./desktop-update-gate.js";
import { activeTerminalUpdateWork, openTerminalLedger } from "./terminal-catalog.js";

let dir: string, store: Store;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-term-catalog-")));
  store = openStore(join(dir, "orders.db"));
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

test("a running terminal is active work; the update's gate refuses a new start until it is lifted", () => {
  const ledger = openTerminalLedger(store.raw())!;
  expect(activeUpdateWork(store.raw())).toMatchObject({ terminals: 0 });
  ledger.reserve("a".repeat(32));
  ledger.running("a".repeat(32));
  expect(activeUpdateWork(store.raw())).toMatchObject({ terminals: 1 });
  const update = randomUUID();
  installUpdateGate(store.raw(), update);
  expect(() => ledger.reserve("b".repeat(32))).toThrow(/Toolroll is updating/);
  // Not idle while it runs: the freeze waits.
  expect(freezeUpdateGate(store.raw(), update)).toBe(false);
  ledger.release("a".repeat(32), "clean");
  expect(activeUpdateWork(store.raw())).toMatchObject({ terminals: 0 });
  removeUpdateGate(store.raw(), update);
  expect(() => ledger.reserve("b".repeat(32))).not.toThrow();
});

test("rows of a console that is gone are stale: not counted, and dropped when the next console opens the catalog", () => {
  const ledger = openTerminalLedger(store.raw())!;
  ledger.reserve("c".repeat(32));
  expect(activeTerminalUpdateWork(store.raw(), () => false)).toEqual({ terminals: 0 });
  expect(activeTerminalUpdateWork(store.raw(), () => true)).toEqual({ terminals: 1 });
  // A console with another pid finds this one's row and keeps it while this process lives.
  openTerminalLedger(store.raw(), () => true);
  expect(activeTerminalUpdateWork(store.raw(), () => true)).toEqual({ terminals: 1 });
});

test("an installation without a catalog reads as no terminals and gets no catalog from the updater", () => {
  expect(activeTerminalUpdateWork(store.raw())).toEqual({ terminals: 0 });
  const update = randomUUID();
  installUpdateGate(store.raw(), update);
  removeUpdateGate(store.raw(), update);
  expect(activeTerminalUpdateWork(store.raw())).toEqual({ terminals: 0 });
});
