/** The shared reader: labels, the 6 KB bound, version-pinned paging and identity on every read (docs/plans/code-map.md §4). */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildCodeMap, type FileFacts, type TreeEntry } from "./code-map-shape.js";
import { answerMap, ANSWER_BYTES, codeMapStatus, fileView, openMap, searchMap } from "./code-map-read.js";
import { encodeMap, publishVersion, releaseLease, requestRefresh, takeLease, recordFailure } from "./code-map-store.js";
import { digestOfUrl } from "./code-map-store.js";
import { openStore, type Store } from "./store.js";

const NOW = new Date("2026-11-06T12:00:00.000Z");
const REPO = "/repo/shop", URL = "https://git.example/shop.git";
let store: Store;
beforeEach(() => { store = openStore(":memory:"); store.upsertProject(REPO, "shop", NOW, { remoteUrl: URL }); });
afterEach(() => { store.close(); });

function publish(files: number, commit = "a".repeat(40), startedFrom: number | null = null): number {
  const entries: TreeEntry[] = Array.from({ length: files }, (_x, at) => ({ path: `src/lib/file-${String(at).padStart(4, "0")}.ts`, mode: "100644", bytes: 100 + at }));
  const facts = new Map<string, FileFacts>(entries.map(one => [one.path, { exports: [{ name: `name${one.path.slice(-7, -3)}`, kind: "function", line: 1 }], imports: [{ to: entries[0]!.path, kind: "imports", line: 2 }], external: [], parseFailed: false }]));
  const map = buildCodeMap({ repo: REPO, commit, remote: { urlDigest: digestOfUrl(URL), record: 0 }, builtAt: NOW.toISOString(), extractor: "e", entries, entryCount: files, withheld: 0, facts, unread: new Map(), manifests: new Map(), warnings: [] });
  const lease = takeLease(store, REPO, "w", NOW)!;
  const outcome = publishVersion(store, lease, { map, encoded: encodeMap(map), identity: { url: URL, record: 0 }, startedFrom, report: "{}" }, NOW)!;
  releaseLease(store, lease);
  expect(outcome.current).toBe(true);
  return outcome.version;
}

describe("one answer", () => {
  test("every view is labelled and at most 6 KB", () => {
    publish(300);
    for (const question of [{ view: "overview" }, { view: "area", id: "src/lib#file" }, { view: "file", id: "src/lib/file-0000.ts" }, { view: "search", query: "file" }] as const) {
      const answer = answerMap(store, { repo: REPO, ...question });
      if (!answer.ok) throw new Error(answer.message);
      expect(Buffer.byteLength(JSON.stringify(answer))).toBeLessThanOrEqual(ANSWER_BYTES);
      expect(answer.label).toContain("untrusted data");
      expect(answer.items.length).toBeGreaterThan(0);
    }
  });
  test("a refresh between pages never skips or repeats: pages read the pinned version", () => {
    const first = publish(300);
    const seen: string[] = [];
    let cursor: string | undefined, version: number | undefined, pages = 0;
    do {
      const answer = answerMap(store, { repo: REPO, view: "area", id: "src/lib#file", ...(cursor === undefined ? {} : { cursor }), ...(version === undefined ? {} : { version }) });
      if (!answer.ok) throw new Error(answer.message);
      expect(answer.version).toBe(first);
      version = answer.version;
      seen.push(...(answer.items as { path: string }[]).map(one => one.path));
      cursor = answer.cursor ?? undefined;
      if (pages++ === 0) publish(5, "b".repeat(40), first); // a new version lands after the first page
    } while (cursor !== undefined);
    expect(pages).toBeGreaterThan(1);
    expect(seen).toHaveLength(300);
    expect(new Set(seen).size).toBe(300);
  });
  test("a pinned version that is gone says so; a cursor from another version is refused", () => {
    const first = publish(3);
    expect(answerMap(store, { repo: REPO, view: "overview", cursor: "999.0" })).toMatchObject({ ok: false, message: "the map changed; start again" });
    expect(answerMap(store, { repo: REPO, view: "overview", version: first, cursor: `${first + 1}.0` })).toMatchObject({ ok: false, message: "the map changed; start again" });
    expect(answerMap(store, { repo: REPO, view: "overview", cursor: "junk" })).toMatchObject({ ok: false, message: "the map changed; start again" });
  });
  test("with the switch off there is no map at all", () => {
    publish(3);
    store.handle.prepare("UPDATE project SET code_map = 0").run();
    expect(answerMap(store, { repo: REPO, view: "overview" })).toEqual({ v: 1, ok: false, state: "off", message: "the code map is off for this project" });
    expect(codeMapStatus(store, REPO, NOW).state).toBe("off");
  });
  test("a version of another project is never read", () => {
    const first = publish(3);
    store.upsertProject("/repo/other", "other", NOW, { remoteUrl: URL });
    expect(answerMap(store, { repo: "/repo/other", view: "overview", version: first })).toMatchObject({ ok: false, state: "gone" });
  });
  test("a stored map whose bytes changed doesn't verify", () => {
    publish(3);
    store.handle.exec("DROP TRIGGER code_map_version_no_update");
    store.handle.prepare("UPDATE code_map_version SET manifest_sha = 'x'").run();
    expect(openMap(store, REPO)).toMatchObject({ ok: false, state: "unavailable" });
  });
});

describe("identity on every read", () => {
  test("a current version from an older remote reads as remote-changed, not as the map", () => {
    publish(3);
    store.handle.prepare("UPDATE project SET remote_url = ?").run("https://other.example/x.git");
    expect(answerMap(store, { repo: REPO, view: "overview" })).toEqual({ v: 1, ok: false, state: "remote-changed", message: "the project's remote changed" });
    expect(codeMapStatus(store, REPO, NOW).state).toBe("remote-changed");
  });
  test("after a recorded change the pointer is gone and the page says so", () => {
    publish(3);
    store.transact(() => { store.upsertProject(REPO, "shop", NOW, { remoteUrl: "https://other.example/x.git" }); store.recordProjectRemote("alex", REPO, URL, "https://other.example/x.git", NOW); });
    expect(codeMapStatus(store, REPO, NOW).state).toBe("remote-changed");
    expect(answerMap(store, { repo: REPO, view: "overview" })).toMatchObject({ ok: false, state: "none" });
  });
});

describe("status", () => {
  test.each([
    ["no remote", (s: Store) => s.handle.prepare("UPDATE project SET remote_url = NULL").run(), "not-available"],
    ["a URL Toolroll won't read", (s: Store) => s.handle.prepare("UPDATE project SET remote_url = 'file:///x'").run(), "not-available"],
    ["nothing yet", () => undefined, "making"],
  ])("%s", (_name, arrange, state) => { arrange(store); expect(codeMapStatus(store, REPO, NOW).state).toBe(state); });
  test("a failure keeps the last map and names the next try", () => {
    publish(3);
    const lease = takeLease(store, REPO, "w", NOW)!;
    recordFailure(store, lease, "couldn't read main: its host name couldn't be resolved", "failed", NOW);
    releaseLease(store, lease);
    const status = codeMapStatus(store, REPO, NOW, iso => iso.slice(11, 16));
    expect(status).toMatchObject({ state: "couldnt-check", words: "Couldn't check main: its host name couldn't be resolved. Next try at 12:30." });
    expect(status.version).not.toBeNull();
  });
  test("a request is queued once", () => {
    expect(requestRefresh(store, REPO, "alex", NOW)).toBe("queued");
    expect(requestRefresh(store, REPO, "alex", NOW)).toBe("already-queued");
  });
});

test("search and exact lookup: names are never normalized", () => {
  publish(3);
  const opened = openMap(store, REPO);
  if (!opened.ok) throw new Error(opened.words);
  expect(searchMap(opened.map, "name0001").map(one => one.name)).toEqual(["name0001"]);
  expect(fileView(opened.map, "src/lib/file-0000.ts")?.importedBy).toHaveLength(3);
  expect(fileView(opened.map, "./src/lib/file-0000.ts")).toBeNull();
  expect(fileView(opened.map, "src/lib/../lib/file-0000.ts")).toBeNull();
});
