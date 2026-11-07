/**
 * The one reader of the code map (docs/plans/code-map.md §4, §6): the lead tools, MCP, chat, the page and the CLI all come
 * through here, so they can't drift. It checks the project's switch and the remote's identity on every read. A first
 * answer pins the current version; later pages name that version and a cursor, so a refresh between pages never skips
 * or repeats entries. Everything it returns came from the repository and is labelled untrusted.
 */
import { codeMapOn, currentVersion, digestOfUrl, readRefresh, readVersionMap, versionRow, type Refresh, type VersionRow } from "./code-map-store.js";
import { codeMapLabel, type CodeMap, type MapArea, type MapFile } from "./code-map-shape.js";
import { REFRESH_EVERY_MS } from "./code-map-build.js";
import { remoteUrlProblem } from "./remote-main.js";
import { trustedRemoteIdentity, type Store } from "./store.js";

export const ANSWER_BYTES = 6 * 1024;
export type MapStateName = "not-available" | "off" | "making" | "current" | "stale" | "couldnt-check" | "too-large" | "remote-changed" | "empty" | "no-main";
export type MapStatus = { state: MapStateName; words: string; version: VersionRow | null; nextTry: string | null; movedTo: string | null; refresh: Refresh | null };

const short = (commit: string): string => commit.slice(0, 7);

/** The project's map state, as every surface states it. `at` renders a time; tests and the CLI use the plain ISO. */
export function codeMapStatus(store: Store, repo: string, now: Date, at: (iso: string) => string = iso => iso): MapStatus {
  const identity = trustedRemoteIdentity(store, repo);
  const refresh = readRefresh(store, repo);
  const base = { version: null as VersionRow | null, nextTry: null as string | null, movedTo: null as string | null, refresh };
  if (identity === null || remoteUrlProblem(identity.url) !== null) return { ...base, state: "not-available", words: "This project has no remote Toolroll can read, so it has no code map." };
  if (!codeMapOn(store, repo)) return { ...base, state: "off", words: "The code map is off for this project." };
  const nextTry = refresh === null ? null : refresh.retryAfter ?? (refresh.lastCheckedAt === null ? null : new Date(Date.parse(refresh.lastCheckedAt) + REFRESH_EVERY_MS).toISOString());
  const version = currentVersion(store, repo);
  const when = nextTry === null ? "" : ` Next try at ${at(nextTry)}.`;
  if (version !== null && (version.remoteDigest !== digestOfUrl(identity.url) || version.remoteRecord !== identity.record)) return { ...base, nextTry, state: "remote-changed", words: "The project's remote changed. A new map is on its way." };
  if (version === null) {
    if (refresh?.seen.state === "no-main") return { ...base, nextTry, state: "no-main", words: `The remote has no main branch yet.${when}` };
    if (refresh?.seen.state === "too-large") return { ...base, nextTry, state: "too-large", words: `${refresh.lastError ?? "This repository is too large"}.${when}` };
    if (refresh?.lastError != null) return { ...base, nextTry, state: "couldnt-check", words: `Couldn't check main: ${withoutPrefix(refresh.lastError)}${when}` };
    const earlier = store.handle.prepare("SELECT 1 FROM code_map_version WHERE repo = ? LIMIT 1").get(repo);
    if (earlier !== undefined) return { ...base, nextTry, state: "remote-changed", words: "The project's remote changed. A new map is on its way." };
    return { ...base, nextTry, state: "making", words: "Making the first map." };
  }
  const held = { ...base, version, nextTry };
  if (refresh?.seen.state === "too-large") return { ...held, state: "too-large", words: `${refresh.lastError ?? "Main is too large to map"}. Showing the last map.${when}` };
  if (refresh?.lastError != null) return { ...held, state: "couldnt-check", words: `Couldn't check main: ${withoutPrefix(refresh.lastError)}${when}` };
  if (refresh?.seen.commit != null && refresh.seen.commit !== version.commit) return { ...held, state: "stale", movedTo: refresh.seen.commit, words: `Main has moved to ${short(refresh.seen.commit)}.${nextTry === null ? "" : ` The next check is at ${at(nextTry)}.`}` };
  if (refresh?.seen.state === "empty") return { ...held, state: "empty", words: "This repository is empty." };
  return { ...held, state: "current", words: `Main at ${short(version.commit)}.` };
}
const withoutPrefix = (why: string): string => { const clean = why.replace(/^couldn't read main: /, ""); return /[.!]$/.test(clean) ? clean : `${clean}.`; };

/** The verified map at a version of this project, or why not. Identity is checked on every read. */
export function openMap(store: Store, repo: string, version?: number): { ok: true; map: CodeMap; version: VersionRow } | { ok: false; state: "off" | "remote-changed" | "none" | "gone" | "unavailable"; words: string } {
  if (!codeMapOn(store, repo)) return { ok: false, state: "off", words: "the code map is off for this project" };
  const identity = trustedRemoteIdentity(store, repo);
  const row = version === undefined ? currentVersion(store, repo) : versionRow(store, version);
  if (row === null) return version === undefined ? { ok: false, state: "none", words: "there is no code map for this project yet" } : { ok: false, state: "gone", words: "the map changed; start again" };
  if (row.repo !== repo) return { ok: false, state: "gone", words: "the map changed; start again" };
  if (identity === null || row.remoteDigest !== digestOfUrl(identity.url) || row.remoteRecord !== identity.record) return { ok: false, state: "remote-changed", words: "the project's remote changed" };
  const map = readVersionMap(store, row.id);
  if (map === null) return { ok: false, state: "unavailable", words: "the saved map couldn't be verified" };
  return { ok: true, map, version: row };
}

// ---- views: one shape for every surface ---------------------------------------------------------------------------

export type AreaRow = { id: string; name: string; files: number; languages: string[]; tests: number; uses: { id: string; count: number }[]; usedBy: { id: string; count: number }[] };
const mainLanguages = (area: MapArea): string[] => Object.entries(area.languages).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0)).slice(0, 3).map(([name]) => name);
const connections = (map: CodeMap, id: string): Pick<AreaRow, "uses" | "usedBy"> => ({
  uses: map.areaEdges.filter(one => one.from === id).sort((a, b) => b.count - a.count).map(one => ({ id: one.to, count: one.count })),
  usedBy: map.areaEdges.filter(one => one.to === id).sort((a, b) => b.count - a.count).map(one => ({ id: one.from, count: one.count })),
});
export const areaRow = (map: CodeMap, area: MapArea): AreaRow => ({ id: area.id, name: area.name, files: area.files, languages: mainLanguages(area), tests: area.tests, ...connections(map, area.id) });
export const areaRows = (map: CodeMap): AreaRow[] => map.areas.map(area => areaRow(map, area));

export type AreaView = { area: AreaRow; entryPoints: string[]; external: string[]; files: MapFile[] };
export function areaView(map: CodeMap, id: string): AreaView | null {
  const area = map.areas.find(one => one.id === id);
  if (area === undefined) return null;
  return { area: areaRow(map, area), entryPoints: area.entryPoints, external: map.external.find(one => one.area === id)?.packages ?? [], files: map.files.filter(one => one.area === id) };
}
export type FileView = { file: MapFile; imports: { path: string; kind: string; line: number }[]; importedBy: { path: string; kind: string; line: number }[] };
/** Exact lookup in the stored version: a path is never resolved, joined or normalized. */
export function fileView(map: CodeMap, path: string): FileView | null {
  const file = map.files.find(one => one.path === path);
  if (file === undefined) return null;
  return { file, imports: map.edges.filter(one => one.from === path).map(one => ({ path: one.to, kind: one.kind, line: one.line })), importedBy: map.edges.filter(one => one.to === path).map(one => ({ path: one.from, kind: one.kind, line: one.line })) };
}
export type SearchHit = { kind: "file" | "name"; path: string; name: string | null; line: number | null };
const wordsOf = (query: string): string[] => query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
export function searchMap(map: CodeMap, query: string, limit = 500): SearchHit[] {
  const words = wordsOf(query);
  if (words.length === 0) return [];
  const hits: SearchHit[] = [];
  for (const file of map.files) {
    const lower = file.path.toLowerCase();
    if (words.every(word => lower.includes(word))) hits.push({ kind: "file", path: file.path, name: null, line: null });
    for (const symbol of file.symbols) {
      const name = symbol.name.toLowerCase();
      if (words.every(word => name.includes(word) || lower.includes(word)) && words.some(word => name.includes(word))) hits.push({ kind: "name", path: file.path, name: symbol.name, line: symbol.line });
    }
    if (hits.length >= limit) break;
  }
  return hits.slice(0, limit);
}

// ---- one bounded answer -------------------------------------------------------------------------------------------

export type MapView = "overview" | "area" | "file" | "search";
export type MapQuestion = { repo: string; version?: number; view: MapView; id?: string; query?: string; cursor?: string };
export type MapAnswer = { v: 1; ok: true; label: string; repo: string; version: number; commit: string; view: MapView; header: Record<string, unknown>; items: unknown[]; omitted: number; cursor: string | null } | { v: 1; ok: false; state: string; message: string };

const refused = (state: string, message: string): MapAnswer => ({ v: 1, ok: false, state, message });
const thinFile = (file: MapFile) => ({ path: file.path, bytes: file.bytes, lang: file.lang, test: file.test, names: file.symbols.slice(0, 40).map(one => one.name), more: Math.max(0, file.symbols.length - 40) });

/** The labelled answer to one question, at most `maxBytes`. The first page pins the version it read. */
export function answerMap(store: Store, question: MapQuestion, maxBytes = ANSWER_BYTES): MapAnswer {
  let offset = 0, pinned = question.version;
  if (question.cursor !== undefined) {
    const read = /^(\d+)\.(\d+)$/.exec(question.cursor);
    if (read === null || (pinned !== undefined && Number(read[1]) !== pinned)) return refused("gone", "the map changed; start again");
    pinned = Number(read[1]); offset = Number(read[2]);
  }
  const opened = openMap(store, question.repo, pinned);
  if (!opened.ok) return refused(opened.state, opened.words);
  const { map, version } = opened;
  let header: Record<string, unknown>;
  let items: unknown[];
  if (question.view === "overview") {
    header = { counts: map.counts, packages: map.packages.map(one => ({ root: one.root, name: one.name, entryPoints: one.entryPoints.slice(0, 8) })).slice(0, 8), warnings: map.warnings };
    items = areaRows(map).map(one => ({ ...one, uses: one.uses.slice(0, 8), usedBy: one.usedBy.slice(0, 8) }));
  } else if (question.view === "area") {
    const view = question.id === undefined ? null : areaView(map, question.id);
    if (view === null) return refused("not-found", "no area with that id in this version");
    header = { area: { ...view.area, uses: view.area.uses.slice(0, 12), usedBy: view.area.usedBy.slice(0, 12) }, entryPoints: view.entryPoints.slice(0, 12), external: view.external.slice(0, 30) };
    items = view.files.map(thinFile);
  } else if (question.view === "file") {
    const view = question.id === undefined ? null : fileView(map, question.id);
    if (view === null) return refused("not-found", "no file with that path in this version");
    header = { path: view.file.path, area: view.file.area, bytes: view.file.bytes, lang: view.file.lang, state: view.file.state, test: view.file.test };
    items = [...view.file.symbols.map(one => ({ exported: one.name, kind: one.kind, line: one.line })), ...view.imports.map(one => ({ imports: one.path, kind: one.kind, line: one.line })), ...view.importedBy.map(one => ({ importedBy: one.path, kind: one.kind, line: one.line }))];
  } else {
    if (question.query === undefined || wordsOf(question.query).length === 0) return refused("usage", "say what to search for");
    header = { query: question.query.slice(0, 200) };
    items = searchMap(map, question.query);
  }
  const answer: Extract<MapAnswer, { ok: true }> = { v: 1, ok: true, label: codeMapLabel(version.commit), repo: question.repo, version: version.id, commit: version.commit, view: question.view, header, items: [], omitted: 0, cursor: null };
  const size = () => Buffer.byteLength(JSON.stringify(answer));
  // Room for the cursor it may need, and never more than the limit.
  const budget = maxBytes - 48;
  let at = offset;
  for (; at < items.length; at++) {
    answer.items.push(items[at]);
    if (size() > budget) {
      answer.items.pop();
      // One item wider than a whole answer is skipped and counted, so paging always moves on.
      if (answer.items.length === 0) { answer.omitted++; continue; }
      break;
    }
  }
  if (at < items.length) answer.cursor = `${version.id}.${at}`;
  return answer;
}
