/**
 * The update notice, step 1: latestRelease asks at most once a day, caches
 * beside the database, stays silent offline and when switched off, reads a
 * security release; status says one line only when newer; a security release
 * tells each operator once. Scripted fetch only — nothing reaches npm or GitHub.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cachedRelease, CHECK_EVERY_MS, isNewer, isSecurityRelease, latestRelease, notifySecurityRelease, RELEASE_CACHE_FILE, recordRunnerVersion,
  runnerVersions, setUpdateChecks, updateChecksOff, updateLine, type Release,
} from "./releases.js";
import { openStore, type Store } from "./store.js";
import { addApprover } from "./scope.js";
import { runOperate } from "./operate.js";
import { PACKAGE_VERSION } from "./version.js";

const T0 = new Date("2026-09-29T09:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const ON = {};

/** A scripted registry and GitHub: every request is recorded; `offline` throws like a dropped network. */
function scripted(version: string | null, notes = "Faster starts.", options: { offline?: boolean; notesStatus?: number } = {}) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (options.offline) throw new TypeError("fetch failed");
    if (url === "https://registry.npmjs.org/toolroll/latest") return version === null ? new Response("{}", { status: 404 }) : Response.json({ name: "toolroll", version });
    if (url.startsWith("https://api.github.com/repos/ap9000/toolroll/releases/tags/v")) {
      return options.notesStatus !== undefined ? new Response("", { status: options.notesStatus }) : Response.json({ tag_name: `v${version}`, body: notes, author: { login: "someone" } });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { fetcher, calls };
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "toolroll-releases-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("c1: latestRelease", () => {
  test("asks npm, then that version's GitHub notes, anonymously, and caches the answer beside the database", async () => {
    const { fetcher, calls } = scripted("0.7.0", "## 0.7.0\nFaster starts.\r\nQuieter logs.");
    const release = await latestRelease(dir, { fetch: fetcher, now: () => T0, env: ON });
    expect(release).toEqual({ version: "0.7.0", notes: "## 0.7.0\nFaster starts.\nQuieter logs.", url: "https://github.com/ap9000/toolroll/releases/tag/v0.7.0", security: false });
    expect(calls.map(one => one.url)).toEqual(["https://registry.npmjs.org/toolroll/latest", "https://api.github.com/repos/ap9000/toolroll/releases/tags/v0.7.0"]);
    // Anonymous: no query string, no identifying header, a timeout on each.
    for (const call of calls) {
      expect(call.url).not.toContain("?");
      const headers = new Headers(call.init?.headers);
      expect([...headers.keys()]).toEqual(["accept"]);
      expect(call.init?.signal).toBeInstanceOf(AbortSignal);
    }
    const cache = JSON.parse(readFileSync(join(dir, RELEASE_CACHE_FILE), "utf8"));
    expect(cache).toEqual({ checkedAt: T0.toISOString(), release });
    expect(cachedRelease(dir)).toEqual(release);
  });

  test("checks at most once a day: within the day the cache answers without a request", async () => {
    const first = scripted("0.7.0");
    await latestRelease(dir, { fetch: first.fetcher, now: () => T0, env: ON });
    const later = scripted("0.8.0");
    expect((await latestRelease(dir, { fetch: later.fetcher, now: () => at(CHECK_EVERY_MS - 1), env: ON }))?.version).toBe("0.7.0");
    expect(later.calls).toHaveLength(0);
    // A day on, it asks again and sees the newer one.
    expect((await latestRelease(dir, { fetch: later.fetcher, now: () => at(CHECK_EVERY_MS), env: ON }))?.version).toBe("0.8.0");
    expect(later.calls).toHaveLength(2);
  });

  test("offline or any failure says nothing, never throws, and does not ask again that day", async () => {
    const offline = scripted("0.7.0", "", { offline: true });
    await expect(latestRelease(dir, { fetch: offline.fetcher, now: () => T0, env: ON })).resolves.toBeNull();
    expect(offline.calls).toHaveLength(1);
    await expect(latestRelease(dir, { fetch: offline.fetcher, now: () => at(60_000), env: ON })).resolves.toBeNull();
    expect(offline.calls).toHaveLength(1);
    // A refusing registry and a garbled answer are the same silence.
    rmSync(join(dir, RELEASE_CACHE_FILE));
    await expect(latestRelease(dir, { fetch: scripted(null).fetcher, now: () => T0, env: ON })).resolves.toBeNull();
    rmSync(join(dir, RELEASE_CACHE_FILE));
    await expect(latestRelease(dir, { fetch: scripted("not a version").fetcher, now: () => T0, env: ON })).resolves.toBeNull();
    // A damaged cache file is ignored, not trusted.
    writeFileSync(join(dir, RELEASE_CACHE_FILE), "{ not json");
    expect(cachedRelease(dir)).toBeNull();
    // Missing notes still name the release; a failure after a good check keeps what it knew.
    rmSync(join(dir, RELEASE_CACHE_FILE));
    expect(await latestRelease(dir, { fetch: scripted("0.7.0", "", { notesStatus: 500 }).fetcher, now: () => T0, env: ON })).toMatchObject({ version: "0.7.0", notes: "" });
    expect((await latestRelease(dir, { fetch: offline.fetcher, now: () => at(CHECK_EVERY_MS), env: ON }))?.version).toBe("0.7.0");
  });

  test("switched off by TOOLROLL_NO_UPDATE_CHECK=1 or the Settings switch: no request at all", async () => {
    const { fetcher, calls } = scripted("0.7.0");
    await expect(latestRelease(dir, { fetch: fetcher, now: () => T0, env: { TOOLROLL_NO_UPDATE_CHECK: "1" } })).resolves.toBeNull();
    expect(updateChecksOff({ TOOLROLL_NO_UPDATE_CHECK: "1" }, dir)).toEqual({ off: true, byEnv: true });
    setUpdateChecks(dir, false);
    expect(updateChecksOff({}, dir)).toEqual({ off: true, byEnv: false });
    await expect(latestRelease(dir, { fetch: fetcher, now: () => T0, env: ON })).resolves.toBeNull();
    expect(calls).toHaveLength(0);
    expect(existsSync(join(dir, RELEASE_CACHE_FILE))).toBe(false);
    setUpdateChecks(dir, true);
    expect((await latestRelease(dir, { fetch: fetcher, now: () => T0, env: ON }))?.version).toBe("0.7.0");
  });

  test("mentioning security is not a security release; a Security line or heading is", () => {
    expect(isSecurityRelease("## 0.7.0\nNo security changes in this release.")).toBe(false);
    expect(isSecurityRelease("Faster starts; security review next month.")).toBe(false);
    expect(isSecurityRelease("## Security\nFixes a path check.")).toBe(true);
    expect(isSecurityRelease("- **Security fix.** A crafted link could open another project.")).toBe(true);
    expect(isSecurityRelease("Security: tokens are no longer logged.")).toBe(true);
  });

  test("versions compare numerically, and a pre-release comes before its release", () => {
    expect(isNewer("0.10.0", "0.9.9")).toBe(true);
    expect(isNewer("0.6.0", "0.6.0")).toBe(false);
    expect(isNewer("0.7.0", "0.7.0-beta.1")).toBe(true);
    expect(isNewer("0.7.0-beta.1", "0.6.0")).toBe(true);
    expect(isNewer("0.5.9", "0.6.0")).toBe(false);
  });

  test("each runner's reported version is kept beside the database", () => {
    recordRunnerVersion(dir, "laptop", "0.6.0", T0);
    recordRunnerVersion(dir, "builder-2", "0.5.0", T0);
    recordRunnerVersion(dir, "laptop", "0.7.0", at(1_000));
    expect(runnerVersions(dir)).toEqual([
      { runner: "builder-2", version: "0.5.0", at: T0.toISOString() },
      { runner: "laptop", version: "0.7.0", at: at(1_000).toISOString() },
    ]);
  });
});

describe("c3: status and the security notification", () => {
  const release = (version: string, security = false): Release => ({ version, notes: security ? "Security fix" : "", url: `https://github.com/ap9000/toolroll/releases/tag/v${version}`, security });

  test("toolroll status prints the one line when newer, and nothing when current or offline", async () => {
    const db = join(dir, "orders.db");
    const status = async (version: string | null, options: { offline?: boolean; json?: boolean } = {}) => {
      rmSync(join(dir, RELEASE_CACHE_FILE), { force: true });
      const lines: string[] = [];
      const code = await runOperate("status", options.json ? ["--json"] : [], line => lines.push(line), {
        databaseFile: db, now: T0, installBin: "/usr/local/lib/node_modules/toolroll/dist/bin.js",
        releaseIo: { fetch: scripted(version, "Faster starts.", { offline: options.offline ?? false }).fetcher, env: ON },
      });
      expect(code).toBe(0);
      return lines.join("\n");
    };
    const newer = "99.0.0";
    const text = await status(newer);
    const lines = text.split("\n").filter(line => line.includes("is available"));
    expect(lines).toEqual([`${newer} is available — npm install -g toolroll@latest · https://github.com/ap9000/toolroll/releases/tag/v${newer}`]);
    expect(JSON.parse(await status(newer, { json: true }))).toMatchObject({ ok: true, update: { current: PACKAGE_VERSION, latest: newer, security: false, updateCommand: "npm install -g toolroll@latest" } });
    expect(await status(PACKAGE_VERSION)).not.toContain("is available");
    expect(JSON.parse(await status(PACKAGE_VERSION, { json: true }))).not.toHaveProperty("update");
    expect(await status(newer, { offline: true })).not.toContain("is available");
  });

  describe("operators", () => {
    let store: Store;
    beforeEach(() => {
      store = openStore(":memory:");
      expect(addApprover(store, "alex", T0, undefined, () => "tok-alex-000000000000").ok).toBe(true);
      expect(addApprover(store, "sam", T0, { name: "alex", token: "tok-alex-000000000000" }).ok).toBe(true);
    });
    afterEach(() => store.close());
    const sent = () => store.handle.prepare("SELECT dedupe_key, kind, recipient, subject, link, push_class FROM notification WHERE kind = 'security-release' ORDER BY id").all();

    test("a security release notifies each instance operator once per version, addressed to them", () => {
      const operators = store.accountFacts().map(one => one.name).filter(name => store.isInstanceOperator(name));
      expect(operators).toEqual(["alex", "sam"]);
      expect(notifySecurityRelease(store, release("0.7.1", true), "0.6.0", "brew upgrade ap9000/toolroll/toolroll", T0)).toBe(operators.length);
      // Asked again (the next hourly pass, the next status): nothing more.
      expect(notifySecurityRelease(store, release("0.7.1", true), "0.6.0", "brew upgrade ap9000/toolroll/toolroll", at(3_600_000))).toBe(0);
      expect(sent()).toEqual(operators.map(recipient => ({
        dedupe_key: `release:security:0.7.1:${recipient}`, kind: "security-release", recipient,
        subject: "Toolroll 0.7.1 is a security release", link: "/settings#updates", push_class: "attention",
      })));
      // A later security release is a new message; an ordinary or an older one sends none.
      expect(notifySecurityRelease(store, release("0.7.2", true), "0.6.0", "npm install -g toolroll@latest", at(1))).toBe(operators.length);
      expect(notifySecurityRelease(store, release("0.8.0"), "0.6.0", "npm install -g toolroll@latest", at(2))).toBe(0);
      expect(notifySecurityRelease(store, release("0.5.0", true), "0.6.0", "npm install -g toolroll@latest", at(3))).toBe(0);
      expect(sent()).toHaveLength(operators.length * 2);
    });
  });
});

describe("c4 (behaviour): Settings → Updates and the console notice", () => {
  let store: Store;
  let server: import("node:http").Server;
  let base: string;
  let token: string;
  let saved: string | undefined;
  const newer = "99.0.0";

  beforeEach(async () => {
    saved = process.env["TOOLROLL_NO_UPDATE_CHECK"];
    delete process.env["TOOLROLL_NO_UPDATE_CHECK"];
    store = openStore(":memory:");
    const added = addApprover(store, "alex", T0);
    if (!added.ok) throw new Error("bootstrap failed");
    token = added.token;
    // The console never asks the network itself: it reads what the daily check cached.
    writeFileSync(join(dir, RELEASE_CACHE_FILE), JSON.stringify({ checkedAt: T0.toISOString(), release: { version: newer, notes: "## Security\nA path check.", url: "", security: true } }));
    recordRunnerVersion(dir, "laptop", "0.0.1", T0);
    const { createDecisionServer } = await import("./serve.js");
    const { register } = await import("./runner.js");
    register(store, { name: "laptop", host: "test", capacity: 1, repos: ["/repo/main"], now: T0, newToken: () => "tok-laptop" });
    server = createDecisionServer({ store, evidenceRoot: dir, clock: () => T0, repo: "/repo/main", configDir: dir, telegramTokenFile: join(dir, "telegram-token"), installBin: "/opt/homebrew/Cellar/toolroll/0.6.0/libexec/lib/node_modules/toolroll/dist/bin.js" });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    if (saved === undefined) delete process.env["TOOLROLL_NO_UPDATE_CHECK"];
    else process.env["TOOLROLL_NO_UPDATE_CHECK"] = saved;
  });

  const login = async () => {
    const response = await fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ name: "alex", token }), redirect: "manual" });
    return (response.headers.get("set-cookie") ?? "").split(";")[0]!;
  };

  test("Settings shows this version, the latest, the command, the switch and each worker's version; the notice is neutral and dismissible per version", async () => {
    const cookie = await login();
    const data = await (await fetch(`${base}/settings?format=workspace`, { headers: { cookie } })).json() as import("./browser-workspace.js").BrowserWorkspace;
    expect(data.view).toMatchObject({ kind: "settings", updates: {
      current: PACKAGE_VERSION,
      latest: { version: newer, newer: true, security: true, notes: "## Security\nA path check.", url: `https://github.com/ap9000/toolroll/releases/tag/v${newer}` },
      updateCommand: "brew upgrade ap9000/toolroll/toolroll",
      check: { on: true, byEnv: false, canManage: true },
      workers: [{ name: "laptop", version: "0.0.1", older: true }],
    } });
    expect(data.update).toEqual({ version: newer, security: true, href: "/settings#updates", dismissHref: "/settings/updates/dismiss" });

    const page = await (await fetch(`${base}/settings`, { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(page)?.[1] ?? "";
    // Dismissed for this version: a cookie, and the notice is gone while the version is the same.
    const dismissed = await fetch(`${base}/settings/updates/dismiss`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf, version: newer, quiet: "1" }), redirect: "manual" });
    expect(dismissed.status).toBe(204);
    expect(dismissed.headers.get("set-cookie")).toBe(`so-update-seen=${newer}; SameSite=Lax; Path=/; Max-Age=31536000`);
    const after = await (await fetch(`${base}/settings?format=workspace`, { headers: { cookie: `${cookie}; so-update-seen=${newer}` } })).json() as import("./browser-workspace.js").BrowserWorkspace;
    expect(after.update).toBeUndefined();
    const older = await (await fetch(`${base}/settings?format=workspace`, { headers: { cookie: `${cookie}; so-update-seen=98.0.0` } })).json() as import("./browser-workspace.js").BrowserWorkspace;
    expect(older.update?.version).toBe(newer);

    // The switch turns the daily check off: the file beside the database says so, and nothing is shown.
    const off = await fetch(`${base}/settings/updates/checks`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf }), redirect: "manual" });
    expect(off.status).toBe(303);
    expect(updateChecksOff({}, dir)).toEqual({ off: true, byEnv: false });
    const quiet = await (await fetch(`${base}/settings?format=workspace`, { headers: { cookie } })).json() as import("./browser-workspace.js").BrowserWorkspace;
    expect(quiet.update).toBeUndefined();
    expect(quiet.view).toMatchObject({ updates: { latest: null, check: { on: false } } });
    await fetch(`${base}/settings/updates/checks`, { method: "POST", headers: { cookie, origin: base }, body: new URLSearchParams({ csrf, check: "on" }), redirect: "manual" });
    expect(updateChecksOff({}, dir).off).toBe(false);
  });
});
