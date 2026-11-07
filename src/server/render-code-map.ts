/**
 * The Code map page (docs/plans/code-map.md §6): read-only, from the shared reader. Every name on it came from the
 * repository: `html` escapes it, links carry it through encodeURIComponent, and the handler looks it up exactly.
 */
import { githubRepoOf } from "../pull-request-flow.js";
import { areaRows, areaView, fileView, searchMap, type AreaRow, type MapStatus } from "../code-map-read.js";
import type { CodeMap, MapFile, MapWarning } from "../code-map-shape.js";
import { html, joinHtml, postForm, type Html, type HtmlValue } from "../html.js";
import { type Chrome, relativeAge, screen, type Screen } from "./chrome.js";
import { btn, disclose, doc, docHeader, empty, facts, infoLine, input, note, notice, phoneHeader } from "./kit.js";

const WARNING_WORDS: Readonly<Record<MapWarning, string>> = {
  "symbols-truncated": "Some files have more exported names than the map keeps.",
  "edges-truncated": "This repository has more imports than the map keeps.",
  "read-limit": "Past the read limit, the remaining code files are listed by path only.",
  "areas-folded": "The smallest areas are folded into “other areas”.",
  "tsconfig-extends": "Settings inherited through tsconfig “extends” aren't read, so some imports aren't connected.",
  "tsconfig-unreadable": "tsconfig.json couldn't be read; relative imports still work.",
};
export const LIMITS_WORDS = { system: "Limits enforced by the system.", checked: "Limits checked by Toolroll every 250 ms." } as const;
const mono = (text: HtmlValue): Html => html`<code class="k-mono cm-path">${text}</code>`;
const short = (commit: string): string => commit.slice(0, 7);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export type CodeMapPage = {
  name: string; repo: string; base: string; selfHref: string; status: MapStatus; map: CodeMap | null; versionId: number | null; remoteUrl: string | null;
  q: string | null; area: string | null; file: string | null; canRefresh: boolean; said: string | null; problem: string | null; now: Date; report: Html | null;
};
const hrefOf = (data: CodeMapPage, extra: Record<string, string>): string => {
  const params = new URLSearchParams(data.versionId === null ? extra : { v: String(data.versionId), ...extra });
  return `${data.base}?${params.toString()}`;
};

function areaBlock(data: CodeMapPage, one: AreaRow, map: CodeMap): Html {
  const named = (id: string) => map.areas.find(area => area.id === id)?.name ?? id;
  const links = (list: AreaRow["uses"]) => joinHtml(list.slice(0, 6).map(use => html`<a class="k-link" href="${hrefOf(data, { area: use.id })}">${named(use.id)}</a>`), ", ");
  return html`<li class="cm-item"><a class="k-link cm-title" href="${hrefOf(data, { area: one.id })}">${one.name}</a>
    <span class="cm-meta">${plural(one.files, "file")}${one.languages.length === 0 ? "" : ` · ${one.languages.join(", ")}`}${one.tests === 0 ? "" : ` · ${plural(one.tests, "test")}`}</span>
    ${one.uses.length === 0 ? "" : html`<span class="cm-meta">Uses ${links(one.uses)}</span>`}
    ${one.usedBy.length === 0 ? "" : html`<span class="cm-meta">Used by ${links(one.usedBy)}</span>`}</li>`;
}
const fileBlock = (data: CodeMapPage, file: MapFile): Html => html`<li class="cm-item"><a class="k-link cm-title" href="${hrefOf(data, { file: file.path })}">${file.path}</a>
  <span class="cm-meta">${file.lang} · ${plural(file.bytes, "byte")}${file.test === null ? "" : html` · Tests: ${file.test}`}</span>
  ${file.symbols.length === 0 ? "" : html`<span class="cm-meta">Exported names: ${file.symbols.slice(0, 12).map(one => one.name).join(", ")}${file.symbols.length > 12 ? ` and ${file.symbols.length - 12} more` : ""}</span>`}</li>`;

function overview(data: CodeMapPage, map: CodeMap): Html {
  return html`<section class="k-sec" aria-labelledby="cm-areas"><h3 id="cm-areas">Areas</h3>
    ${map.areas.length === 0 ? note("This repository is empty.") : html`<ul class="cm-list">${areaRows(map).map(one => areaBlock(data, one, map))}</ul>`}</section>`;
}
function areaPage(data: CodeMapPage, map: CodeMap, id: string): Html {
  const view = areaView(map, id);
  if (view === null) return notice("That area isn't in this version of the map.");
  return html`<section class="k-sec" aria-labelledby="cm-area"><h3 id="cm-area">${view.area.name}</h3>
    ${facts([
      ["Files", String(view.area.files)], ["Tests", String(view.area.tests)],
      ...(view.entryPoints.length === 0 ? [] : [["Entry points", joinHtml(view.entryPoints.map(one => html`<a class="k-link" href="${hrefOf(data, { file: one })}">${one}</a>`), ", ")] as const]),
      ...(view.external.length === 0 ? [] : [["Packages", view.external.join(", ")] as const]),
      ...(view.area.uses.length === 0 ? [] : [["Uses", joinHtml(view.area.uses.map(one => html`<a class="k-link" href="${hrefOf(data, { area: one.id })}">${one.id}</a> (${String(one.count)})`), ", ")] as const]),
      ...(view.area.usedBy.length === 0 ? [] : [["Used by", joinHtml(view.area.usedBy.map(one => html`<a class="k-link" href="${hrefOf(data, { area: one.id })}">${one.id}</a> (${String(one.count)})`), ", ")] as const]),
    ])}</section>
    <section class="k-sec" aria-labelledby="cm-files"><h3 id="cm-files">Files</h3><ul class="cm-list">${view.files.slice(0, 500).map(one => fileBlock(data, one))}</ul>
    ${view.files.length > 500 ? note(`${view.files.length - 500} more. Search to find them.`) : ""}</section>`;
}
function filePage(data: CodeMapPage, map: CodeMap, path: string): Html {
  const view = fileView(map, path);
  if (view === null) return notice("That file isn't in this version of the map.");
  const github = data.remoteUrl === null ? null : githubRepoOf(data.remoteUrl);
  const list = (rows: FileRows) => rows.length === 0 ? note("None.") : html`<ul class="cm-list">${rows.slice(0, 200).map(one => html`<li class="cm-item"><a class="k-link cm-title" href="${hrefOf(data, { file: one.path })}">${one.path}</a><span class="cm-meta">line ${String(one.line)}</span></li>`)}</ul>`;
  return html`<section class="k-sec" aria-labelledby="cm-file"><h3 id="cm-file">${mono(view.file.path)}</h3>
    ${github === null ? "" : html`<p><a class="k-link" rel="noopener noreferrer" target="_blank" href="${`https://github.com/${github}/blob/${map.commit}/${view.file.path.split("/").map(encodeURIComponent).join("/")}`}">Open on GitHub at ${short(map.commit)}</a></p>`}
    ${facts([["Area", html`<a class="k-link" href="${hrefOf(data, { area: view.file.area })}">${view.file.area}</a>`], ["Language", view.file.lang], ...(view.file.test === null ? [] : [["Tests", html`<a class="k-link" href="${hrefOf(data, { file: view.file.test })}">${view.file.test}</a>`] as const])])}</section>
    <section class="k-sec" aria-labelledby="cm-names"><h3 id="cm-names">Exported names</h3>${view.file.symbols.length === 0 ? note(view.file.state === "read" ? "None." : "Names and imports aren't read for this file.") : html`<ul class="cm-list">${view.file.symbols.map(one => html`<li class="cm-item"><span class="cm-title">${one.name}</span><span class="cm-meta">${one.kind} · line ${String(one.line)}</span></li>`)}</ul>`}</section>
    <section class="k-sec" aria-labelledby="cm-imports"><h3 id="cm-imports">Imports</h3>${list(view.imports)}</section>
    <section class="k-sec" aria-labelledby="cm-by"><h3 id="cm-by">Imported by</h3>${list(view.importedBy)}</section>`;
}
type FileRows = readonly { path: string; line: number }[];
function searchPage(data: CodeMapPage, map: CodeMap, query: string): Html {
  const hits = searchMap(map, query, 200);
  return html`<section class="k-sec" aria-labelledby="cm-found"><h3 id="cm-found">${plural(hits.length, "match", "matches")}</h3>
    ${hits.length === 0 ? note("Nothing in this version matches.") : html`<ul class="cm-list">${hits.map(one => html`<li class="cm-item"><a class="k-link cm-title" href="${hrefOf(data, { file: one.path })}">${one.name ?? one.path}</a>${one.name === null ? "" : html`<span class="cm-meta">${one.path} · line ${String(one.line)}</span>`}</li>`)}</ul>`}</section>`;
}

function provenance(data: CodeMapPage, map: CodeMap): Html {
  const report = (() => { try { return JSON.parse(data.status.version?.report ?? "{}") as { enforced?: "system" | "checked"; proxy?: string | null }; } catch { return {}; } })();
  const c = map.counts;
  return disclose("Where this comes from", joinHtml([
    note(map.label),
    facts([
      ["Remote", data.remoteUrl === null ? "None" : mono(data.remoteUrl)],
      ["Files", `${c.files} (${c.read} read, ${c.pathOnly} by path only, ${c.tooLarge} too large to read)`],
      ...(c.parseErrors > 0 ? [["Unreadable", plural(c.parseErrors, "file")] as const] : []),
      ...(c.withheld > 0 ? [["Withheld", `${plural(c.withheld, "name")} Toolroll won't show`] as const] : []),
      ...(c.links + c.submodules > 0 ? [["Not followed", `${plural(c.links, "link")}, ${plural(c.submodules, "submodule")}`] as const] : []),
      ...(map.vendored.length === 0 ? [] : [["Left out", map.vendored.map(one => `${one.path} (${plural(one.files, "file")})`).join(", ")] as const]),
    ]),
    note("require() calls aren't counted. Other languages show paths and sizes only."),
    ...map.warnings.map(code => note(WARNING_WORDS[code])),
    ...(report.proxy ? [note(`Read through your proxy at ${report.proxy}.`)] : []),
    ...(report.enforced === undefined ? [] : [note(LIMITS_WORDS[report.enforced])]),
  ]));
}

export function codeMapPage(chrome: Chrome, data: CodeMapPage): Screen {
  const { status, map } = data;
  const age = status.version === null ? "" : ` · ${relativeAge(status.version.builtAt, data.now)}`;
  const meta = map === null ? status.words : `main at ${short(map.commit)}${age}`;
  const check = data.canRefresh && status.state !== "not-available" && status.state !== "off"
    ? postForm(`${data.base}/refresh`, btn("Check now", { sm: true, type: "submit" }), { returnTo: data.selfHref, hidden: { repo: data.repo } }) : "";
  const stated = data.problem !== null ? notice(data.problem) : data.said !== null ? infoLine(data.said) : "";
  const warn = status.state === "couldnt-check" || status.state === "too-large" || status.state === "remote-changed" ? notice(status.words) : status.state === "stale" ? infoLine(status.words) : "";
  let content: HtmlValue;
  if (map === null) {
    content = status.state === "making" ? empty({ title: "Making the first map.", text: "It appears here when it's ready." })
      : status.state === "off" ? empty({ title: "The code map is off.", text: "Turn it on in this project's settings." })
      : status.state === "not-available" ? empty({ title: "No code map.", text: status.words })
      : status.state === "no-main" ? empty({ title: "No main yet.", text: status.words })
      : "";
  } else {
    const search = html`<form class="cm-search" method="get" action="${data.base}" role="search">
      ${data.versionId === null ? "" : html`<input type="hidden" name="v" value="${String(data.versionId)}">`}
      ${input({ id: "cm-q", name: "q", type: "search", value: data.q ?? "", attrs: { "aria-label": "Search files and exported names", placeholder: "Search files and exported names" } })}
      ${btn("Search", { sm: true, type: "submit" })}</form>`;
    const view = data.q !== null && data.q.trim() !== "" ? searchPage(data, map, data.q) : data.file !== null ? filePage(data, map, data.file) : data.area !== null ? areaPage(data, map, data.area) : overview(data, map);
    const atTop = data.q === null && data.file === null && data.area === null;
    content = joinHtml([search, provenance(data, map), atTop ? "" : html`<p><a class="k-link" href="${hrefOf(data, {})}">All areas</a></p>`, view, atTop ? data.report ?? "" : ""]);
  }
  const body = joinHtml([
    phoneHeader("Code map", { back: data.selfHref.replace(/\/map(?:\?.*)?$/, "") }),
    doc(docHeader({ back: [data.base.replace(/\/map$/, ""), data.name], title: "Code map", meta, right: check || undefined, same: true } as Parameters<typeof docHeader>[0]), stated, warn, content),
  ]);
  return screen("Code map", body, { chrome });
}
