/** A published code map, straight into the store: for pages and tools that only read one. */
import { buildCodeMap, type FileFacts, type TreeEntry } from "../src/code-map-shape.js";
import { digestOfUrl, encodeMap, publishVersion, releaseLease, takeLease } from "../src/code-map-store.js";
import { trustedRemoteIdentity, type Store } from "../src/store.js";

export function seedMap(store: Store, repo: string, files: Record<string, { names?: string[]; imports?: string[] }>, now: Date, commit = "a".repeat(40)): number {
  const identity = trustedRemoteIdentity(store, repo);
  if (identity === null) throw new Error("the project needs a recorded remote");
  const entries: TreeEntry[] = Object.keys(files).map(path => ({ path, mode: "100644", bytes: 100 }));
  const facts = new Map<string, FileFacts>(Object.entries(files).map(([path, one]) => [path, { exports: (one.names ?? []).map((name, at) => ({ name, kind: "function", line: at + 1 })), imports: (one.imports ?? []).map(to => ({ to, kind: "imports" as const, line: 1 })), external: [], parseFailed: false }]));
  const map = buildCodeMap({ repo, commit, remote: { urlDigest: digestOfUrl(identity.url), record: identity.record }, builtAt: now.toISOString(), extractor: "typescript-parser@6.0.3/map-v1", entries, entryCount: entries.length, withheld: 0, facts, unread: new Map(), manifests: new Map(), warnings: [] });
  const pointer = store.handle.prepare("SELECT version FROM code_map_current WHERE repo = ?").get(repo);
  const lease = takeLease(store, repo, "seed", now);
  if (lease === null) throw new Error("held");
  const outcome = publishVersion(store, lease, { map, encoded: encodeMap(map), identity, startedFrom: pointer === undefined ? null : Number(pointer["version"]), report: JSON.stringify({ enforced: "checked", proxy: null }) }, now);
  releaseLease(store, lease);
  if (outcome === null || !outcome.current) throw new Error("not published");
  return outcome.version;
}
