// The Store money seal against replaced built-ins (PR #263 follow-up). Its own file: the global swaps below stay in this
// file's forked, isolated worker (vitest.config.ts: pool "forks", isolate), and each test restores what it replaced.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { lockStoreMoneyMethods, openStore, sealStoreMoneyMethods, Store } from "./store.js";

const NAMES = ["recordUsage", "settleRunSpend", "fixRunBilling", "finalizeChatTurn"] as const;
let dir: string;
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "so-seal-"))); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test.each([
  ["defineProperty", (() => ({})) as unknown],
  ["getOwnPropertyDescriptor", ((_: object, name: string) => ({ value: () => name, writable: false, configurable: false })) as unknown],
  ["freeze", ((value: unknown) => value) as unknown],
] as const)("Object.%s replaced before a Store is made: the lock refuses without calling the stand-in", (name, standIn) => {
  const object = Object as unknown as Record<string, unknown>;
  const real = object[name];
  let called = 0;
  object[name] = (...args: unknown[]) => { called++; return (standIn as (...a: unknown[]) => unknown)(...args); };
  try {
    expect(() => openStore(join(dir, "plane.db"))).toThrow(/Object's built-ins were replaced/);
    called = 0;
    let thrown: unknown = null;
    try { lockStoreMoneyMethods({}); } catch (error) { thrown = error; }
    expect(called).toBe(0);
    expect(String(thrown)).toMatch(/Object's built-ins were replaced/);
  } finally {
    object[name] = real;
  }
  // Restored, a Store locks the recorded methods again.
  const store = openStore(join(dir, "plane.db"));
  try { expect(store.recordUsage).toBe(Store.prototype.recordUsage); } finally { store.close(); }
});

test("the lock installs only the references recorded at the seal, and a second seal refuses", () => {
  const sealed = (values: Record<string, unknown>): object => {
    const prototype = {};
    for (const name of NAMES) Object.defineProperty(prototype, name, { value: values[name], writable: false, configurable: false });
    return prototype;
  };
  const real = Object.fromEntries(NAMES.map(name => [name, Store.prototype[name]]));
  // A prototype holding a stand-in for one method, even sealed, isn't the class's: the lock refuses.
  expect(() => lockStoreMoneyMethods({}, sealed({ ...real, settleRunSpend: function settleRunSpend() { return 0; } }))).toThrow(/Store\.settleRunSpend isn't the sealed method/);
  // One that isn't sealed refuses too; the real references lock.
  expect(() => lockStoreMoneyMethods({}, { ...real })).toThrow(/Store\.recordUsage isn't sealed/);
  const target = {};
  lockStoreMoneyMethods(target, sealed(real));
  for (const name of NAMES) expect(Object.getOwnPropertyDescriptor(target, name)).toMatchObject({ value: Store.prototype[name], writable: false, configurable: false });
  // The record is made once: a fresh prototype of plain methods named right can't take its place.
  const fresh = { recordUsage() {}, settleRunSpend() {}, fixRunBilling() {}, finalizeChatTurn() {} };
  expect(() => sealStoreMoneyMethods(fresh)).toThrow(/already sealed/);
  expect(Object.getOwnPropertyDescriptor(fresh, "recordUsage")?.writable).toBe(true);
});
