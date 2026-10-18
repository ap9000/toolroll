import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { scryptSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { openStore, type Store } from "./store.js";
import { addApprover, authenticateAccount, hashPassword, hashToken } from "./scope.js";
import { createDecisionServer } from "./serve.js";
import { runOperate, EXIT } from "./operate.js";
import { register } from "./runner.js";
import { SourceAdmission } from "./request-budget.js";
import {
  ACCOUNT_PASSWORD_TRIES, ACCOUNT_PASSWORD_WINDOW_MS, CLI_PASSWORD_SOURCE, DEFAULT_GUARD_POLICY,
  PasswordGuard, passwordGuardOf, withPasswordSource,
} from "./sign-in-guard.js";

// Count actual KDF calls instead of comparing noisy wall-clock durations. The original crypto still verifies.
vi.mock("node:crypto", async importOriginal => {
  const original = await importOriginal<typeof import("node:crypto")>();
  return { ...original, scryptSync: vi.fn(original.scryptSync) };
});

const source = (n: number) => `fwd:2001:db8:${n.toString(16)}:1::1`;

test("more than 10,000 rotating /64 sources share one admission budget even after source-table eviction", () => {
  const guard = new PasswordGuard();
  for (let i = 0; i < 5; i++) guard.failed("alex", 0, source(i), true);
  let checks = 0;
  for (let i = 5; i < 20_010; i++) {
    if (guard.preflight("alex", 1, source(i)) === 0) {
      checks++;
      guard.failed("alex", 1, source(i), true);
    }
  }
  expect(checks).toBe(ACCOUNT_PASSWORD_TRIES);
  // Force eviction of alex's source records. Its shared admissions are stored separately.
  for (let i = 0; i < 10_001; i++) guard.failed("another-real-account", 1, source(i), true);
  expect(guard.size).toBe(10_000);
  expect(guard.preflight("alex", 2, source(0))).toBeGreaterThan(0);
  expect(guard.preflight("alex", 2, source(30_000), true)).toBe(0);
  // A new rolling minute gives only another small allowance, regardless of how many sources arrive.
  checks = 0;
  for (let i = 0; i < 10_001; i++) {
    if (guard.preflight("alex", ACCOUNT_PASSWORD_WINDOW_MS + 1, source(i)) === 0) {
      checks++;
      guard.failed("alex", ACCOUNT_PASSWORD_WINDOW_MS + 1, source(i), true);
    }
  }
  expect(checks).toBe(ACCOUNT_PASSWORD_TRIES);
});

test("source and fabricated-name records expire by time below capacity without dropping a live lock", () => {
  const guard = new PasswordGuard();
  for (const exists of [false, true]) {
    for (let i = 0; i < 5; i++) guard.failed(exists ? "alex" : "fabricated", 0, source(1), exists);
  }
  expect(guard.preflight("fabricated", DEFAULT_GUARD_POLICY.firstLockMs - 1, source(1))).toBe(1);
  guard.failed("recent", DEFAULT_GUARD_POLICY.maxLockMs - 1, source(2), true);
  expect(guard.size).toBe(3);
  expect(guard.preflight("alex", DEFAULT_GUARD_POLICY.maxLockMs, source(1))).toBe(0);
  expect(guard.size).toBe(1);
  expect(guard.preflight("fabricated", DEFAULT_GUARD_POLICY.maxLockMs, source(1))).toBe(0);
});

test("a proved account bypasses only shared admissions, never its source lock", () => {
  const guard = new PasswordGuard();
  for (let i = 0; i < 5; i++) guard.failed("alex", 0, source(1), true);
  expect(guard.preflight("alex", 1, source(1), true)).toBe(DEFAULT_GUARD_POLICY.firstLockMs - 1);
  for (let i = 0; i < ACCOUNT_PASSWORD_TRIES; i++) expect(guard.preflight("alex", 1, source(i + 2))).toBe(0);
  expect(guard.preflight("alex", 1, source(20))).toBeGreaterThan(0);
  expect(guard.preflight("alex", 1, source(20), true)).toBe(0);
  expect(guard.preflight("alex", 1, source(21))).toBeGreaterThan(0);
});

test("verified identity budgets preserve exact IPv6-shaped names while source budgets group /64s", () => {
  const accounts = new SourceAdmission({ perMinute: 1, keyMode: "exact", clock: () => 0 });
  const sources = new SourceAdmission({ perMinute: 1, clock: () => 0 });
  for (const name of ["2001:db8:1:2::1", "2001:db8:1:2::2", "2001:0DB8:1:2::1"]) {
    expect(accounts.admit(name)).toEqual({ ok: true });
    expect(accounts.admit(name)).toMatchObject({ ok: false, status: 429 });
  }
  expect(sources.admit("2001:db8:1:2::1")).toEqual({ ok: true });
  expect(sources.admit("2001:db8:1:2::2")).toMatchObject({ ok: false, status: 429 });
});

describe("HTTP password admission", () => {
  let dir: string, store: Store, server: Server, base: string, password: string;
  beforeEach(async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    dir = mkdtempSync(join(tmpdir(), "so-signin-revision-"));
    store = openStore(join(dir, "orders.db"));
    const added = addApprover(store, "alex", new Date());
    if (!added.ok) throw Error("bootstrap");
    password = added.token;
    server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repo: "/repo/main", configDir: dir });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address !== "object") throw Error("listen");
    base = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const signIn = (name: string, token: string, from?: number, cookie?: string) => fetch(`${base}/login`, {
    method: "POST", redirect: "manual", body: new URLSearchParams({ name, token }),
    headers: { ...(from === undefined ? {} : { "x-forwarded-for": source(from).slice(4), "x-forwarded-proto": "https" }), ...(cookie === undefined ? {} : { cookie }) },
  });
  const cookieOf = (response: Response) => response.headers.get("set-cookie")!.split(";")[0]!;
  const exhaust = async (name = "alex", offset = 0) => {
    for (let i = 0; i < 5 + ACCOUNT_PASSWORD_TRIES; i++) expect((await signIn(name, "wrong", i + offset)).status).toBe(403);
  };

  test("a valid same-account browser session signs in during a flood; other, stale and forged cookies cannot", async () => {
    store.saveApprover("sam", hashToken("sam-password"), new Date());
    const cookie = cookieOf(await signIn("alex", password, 30));
    const other = cookieOf(await signIn("sam", "sam-password", 31));
    const stale = cookieOf(await signIn("alex", password, 32));
    await exhaust();
    for (const candidate of [undefined, other, `standing-orders_session=${"f".repeat(64)}`]) {
      vi.mocked(scryptSync).mockClear();
      expect((await signIn("alex", password, 40, candidate)).status).toBe(429);
      expect(scryptSync).not.toHaveBeenCalled();
    }
    // Proof never overrides the attacker's own failed-source lock/slowdown.
    expect((await signIn("alex", password, 0, cookie)).status).toBe(429);
    vi.mocked(scryptSync).mockClear();
    expect((await signIn("alex", password, 40, cookie)).status).toBe(303);
    expect(scryptSync).toHaveBeenCalledTimes(1);
    await exhaust("alex", 1000);
    store.handle.prepare("UPDATE approver SET generation = generation + 1 WHERE name = 'alex'").run();
    vi.mocked(scryptSync).mockClear();
    expect((await signIn("alex", password, 40, stale)).status).toBe(429);
    expect(scryptSync).not.toHaveBeenCalled();
  });

  test("a valid same-account session also bypasses the shared budget at a browser password step-up", async () => {
    const cookie = cookieOf(await signIn("alex", password, 30));
    await exhaust();
    const settings = await (await fetch(`${base}/settings/sessions`, { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(settings)?.[1];
    expect(csrf).toBeDefined();
    vi.mocked(scryptSync).mockClear();
    const changed = await fetch(`${base}/settings/request-limits`, {
      method: "POST", redirect: "manual", headers: { cookie, origin: base, "x-forwarded-for": source(40).slice(4), "x-forwarded-proto": "https" },
      body: new URLSearchParams({ csrf: csrf!, action: "save", target: "*", "act-per-minute": "5", password }),
    });
    expect(changed.status).toBe(303);
    expect(store.handle.prepare("SELECT act_per_minute FROM request_budget_limit WHERE target = '*'").get()?.["act_per_minute"]).toBe(5);
    expect(scryptSync).toHaveBeenCalledTimes(1);
  });

  test.each(["minted", "password", "sso"] as const)("real %s and fabricated names have identical responses and KDF classes after equivalent histories", async kind => {
    const hash = kind === "password" ? hashPassword("chosen-password") : kind === "sso" ? "sso-only$identity" : hashToken(password);
    store.handle.prepare("UPDATE approver SET credential_hash = ? WHERE name = 'alex'").run(hash);
    const results: { status: number; body: string; kdfs: number }[][] = [];
    for (const name of ["alex", "fabricated"]) {
      const history: { status: number; body: string; kdfs: number }[] = [];
      for (const from of [...Array.from({ length: 5 + ACCOUNT_PASSWORD_TRIES }, (_, i) => i), 0, 100]) {
        vi.mocked(scryptSync).mockClear();
        const response = await signIn(name, "wrong", from);
        history.push({ status: response.status, body: await response.text(), kdfs: vi.mocked(scryptSync).mock.calls.length });
      }
      results.push(history);
    }
    expect(results[0]).toEqual(results[1]);
    expect(results[0]!.map(({ status, kdfs }) => [status, kdfs])).toEqual([
      ...Array(5 + ACCOUNT_PASSWORD_TRIES).fill([403, 1]), [429, 0], [429, 0],
    ]);
  });

  test("all password authentication roads refuse before KDF work when the account budget is spent", async () => {
    await exhaust();
    vi.mocked(scryptSync).mockClear();
    let refused = 0;
    for (let i = 100; i < 10_101; i++) {
      const answer = withPasswordSource(source(i), () => authenticateAccount(store, "alex", password));
      if (!answer.ok && answer.reason === "locked") refused++;
    }
    expect(refused).toBe(10_001);
    const bearer = await fetch(`${base}/work`, { redirect: "manual", headers: { authorization: `Bearer alex:${password}`, "x-forwarded-for": source(101).slice(4), "x-forwarded-proto": "https" } });
    expect(bearer.status).toBe(401);
    expect(await bearer.text()).toContain("toolroll tokens create");
    expect(scryptSync).not.toHaveBeenCalled();
  });

  test("the server uses exact account keys when two verified names are in the same IPv6 /64", async () => {
    const first = "2001:db8:1:2::1", second = "2001:db8:1:2::2";
    for (const name of [first, second]) store.saveApprover(name, hashToken(password), new Date());
    const request = (name: string, from: number) => fetch(`${base}/login`, { headers: {
      authorization: `Bearer ${name}:${password}`, "x-forwarded-for": source(from).slice(4), "x-forwarded-proto": "https",
    } });
    for (let i = 0; i < 120; i++) expect((await request(first, i)).status).toBe(200);
    expect((await request(first, 120)).status).toBe(429);
    expect((await request(second, 121)).status).toBe(200);
  });

  test("loopback HTTP failures without forwarded headers cannot consume the native CLI's source", async () => {
    register(store, { name: "worker", host: "test", capacity: 1, repos: ["/repo/main"], now: new Date() });
    for (let i = 0; i < 5; i++) expect((await signIn("alex", "wrong")).status).toBe(403);
    expect((await signIn("alex", password)).status).toBe(429);
    const guard = passwordGuardOf(store), admissions = vi.spyOn(guard, "preflight");
    expect(guard.lockedFor("alex", Date.now(), CLI_PASSWORD_SOURCE)).toBe(0);
    // Use this exact store/guard: reopening a database would accidentally hide the shared-source bug.
    const close = vi.spyOn(store, "close").mockImplementation(() => {});
    const output: string[] = [];
    try {
      const code = await withPasswordSource("127.0.0.1", () => runOperate("runner", ["capacity", "worker", "2", "--as", "alex", "--token", password, "--json"], line => output.push(line), { openDatabase: () => store, databaseFile: join(dir, "orders.db") }));
      expect(code).toBe(EXIT.ok);
      expect(store.getRunner("worker")?.runner.capacity).toBe(2);
      expect(admissions.mock.calls.some(args => args[2] === CLI_PASSWORD_SOURCE)).toBe(true);
    } finally { close.mockRestore(); }
    expect((await signIn("alex", password)).status).toBe(429);
  });
});

test("real and fabricated names keep identical HTTP and KDF histories after a 10,001-name flood", async () => {
  const now = Date.parse("2026-10-07T12:00:00Z");
  vi.spyOn(Date, "now").mockReturnValue(now);
  const dir = mkdtempSync(join(tmpdir(), "so-signin-flood-")), store = openStore(join(dir, "orders.db"));
  // Deterministic guard-private HMAC key; leave token and session randomness alone.
  store.saveApprover("alex", hashPassword("chosen-password"), new Date(now));
  const entropy = vi.spyOn(await import("node:crypto"), "randomBytes").mockReturnValueOnce(Buffer.alloc(32, 7));
  const guard = passwordGuardOf(store);
  entropy.mockRestore();
  const server = createDecisionServer({ store, evidenceRoot: join(dir, "evidence"), repo: "/repo/main", configDir: dir, clock: () => new Date(now) });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address !== "object") throw Error("listen");
    const base = `http://127.0.0.1:${address.port}`;
    // Seed equivalent histories without thousands of password derivations. Each target has five failures at S
    // and five more across fresh /64s, producing the same source lock and 32-minute shared slowdown.
    for (const name of ["alex", "fabricated"]) {
      for (const from of [0, 0, 0, 0, 0, 1, 2, 3, 4, 5]) guard.failed(name, now, source(from), name === "alex");
    }
    vi.mocked(scryptSync).mockClear();
    for (let i = 0; i < 10_001; i++) guard.failed(`junk-${i}`, now, source(i + 100), false);
    expect(scryptSync).not.toHaveBeenCalled();
    expect(guard.size).toBe(10_000);

    const histories: { status: number; body: string; kdfs: number; retryAfter: string | null }[][] = [];
    for (const name of ["alex", "fabricated"]) {
      const history: (typeof histories)[number] = [];
      for (const from of [0, 20_000, 20_001, 20_002, 20_003]) {
        vi.mocked(scryptSync).mockClear();
        const response = await fetch(`${base}/login`, {
          method: "POST", redirect: "manual", body: new URLSearchParams({ name, token: "wrong" }),
          headers: { "x-forwarded-for": source(from).slice(4), "x-forwarded-proto": "https" },
        });
        history.push({ status: response.status, body: await response.text(), kdfs: vi.mocked(scryptSync).mock.calls.length, retryAfter: response.headers.get("retry-after") });
      }
      histories.push(history);
    }
    expect(histories[0]).toEqual(histories[1]);
    expect(histories[0]!.map(({ status, kdfs }) => [status, kdfs])).toEqual([
      [429, 0], ...Array(ACCOUNT_PASSWORD_TRIES).fill([403, 1]), [429, 0],
    ]);
    expect(histories[0]![0]!.retryAfter).toBe("1920");
    expect(histories[0]!.at(-1)!.retryAfter).toBe("60");
  } finally {
    vi.restoreAllMocks();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saturated guard budgets survive successes and freed exact slots, then expire by time", async () => {
  const entropy = vi.spyOn(await import("node:crypto"), "randomBytes").mockReturnValueOnce(Buffer.alloc(32, 7));
  const guard = new PasswordGuard();
  entropy.mockRestore();
  for (let i = 0; i < 10_000; i++) guard.failed(`fill-${i}`, 0, source(i), false);
  expect(guard.size).toBe(10_000);
  for (const [name, exists] of [["overflow-real", true], ["overflow-fabricated", false]] as const) {
    for (let i = 0; i < 5; i++) guard.failed(name, 1, source(20_000), exists);
    for (let i = 0; i < ACCOUNT_PASSWORD_TRIES; i++) expect(guard.preflight(name, 2, source(20_001 + i))).toBe(0);
    expect(guard.preflight(name, 2, source(20_010))).toBe(ACCOUNT_PASSWORD_WINDOW_MS);
    expect(guard.preflight(name, 2, source(20_010), true)).toBe(0);
    // A verified sign-in cannot clear a shared overflow bucket and erase another name's budget.
    guard.succeeded(name, source(20_010));
    expect(guard.preflight(name, 2, source(20_010))).toBe(ACCOUNT_PASSWORD_WINDOW_MS);
  }
  guard.succeeded("fill-0", source(0));
  expect(guard.size).toBe(9_999);
  for (const name of ["overflow-real", "overflow-fabricated"]) {
    // Reusing the freed slot would silently discard this name's admission history.
    expect(guard.preflight(name, 2, source(20_010))).toBe(ACCOUNT_PASSWORD_WINDOW_MS);
    guard.failed(name, 3, source(20_020), name === "overflow-real");
    expect(guard.preflight(name, 3, source(20_010))).toBe(ACCOUNT_PASSWORD_WINDOW_MS - 1);
    expect(guard.preflight(name, 3, source(20_000), true)).toBeGreaterThan(0);
  }
  const day = DEFAULT_GUARD_POLICY.maxLockMs;
  for (const name of ["overflow-real", "overflow-fabricated"]) guard.failed(name, day - 1, source(20_000), name === "overflow-real");
  for (const name of ["overflow-real", "overflow-fabricated"]) expect(guard.preflight(name, day, source(20_000))).toBeGreaterThan(0);
  // All original exact entries expired, while both recent overflow records still enforce their slowdown.
  expect(guard.size).toBe(0);
  for (const name of ["overflow-real", "overflow-fabricated"]) expect(guard.preflight(name, 2 * day - 1, source(20_000))).toBe(0);
  guard.failed("after-expiry", 2 * day - 1, source(0), false);
  expect(guard.size).toBe(1);
});
