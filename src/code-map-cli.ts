/**
 * `toolroll map` (docs/plans/code-map.md §5-7): the same reader and acts as the page. A read needs project access;
 * `refresh` any approver, the lead included; `on`/`off` and `holdout end` a person, re-proved inside the write.
 */
import { resolve } from "node:path";
import { answerMap, areaRows, codeMapStatus, openMap, type MapAnswer, type MapView } from "./code-map-read.js";
import { requestRefresh } from "./code-map-store.js";
import { canonicalProject } from "./project.js";
import { envelopeJson } from "./envelope.js";
import type { CommandFlag } from "./contracts/cli.js";
import type { Store } from "./store.js";

const jsonFlag: CommandFlag = { name: "json", takesValue: false, meaning: "answer with one machine envelope on stdout" };
const repoFlag: CommandFlag = { name: "repo", takesValue: true, meaning: "which project" };
const pageFlags: readonly CommandFlag[] = [jsonFlag, repoFlag, { name: "cursor", takesValue: true, meaning: "the next page, from the answer before it" }];
export const MAP_DESCRIPTORS = [
  { action: "", synopsis: "a project's code map: its areas, and how they use each other", mutation: "none", positional: null, flags: [jsonFlag, repoFlag, pageFlags[2]!] },
  { action: "area", synopsis: "one area's files, exported names, tests and connections: map area <id>", mutation: "none", positional: "the area's id", flags: pageFlags },
  { action: "file", synopsis: "one file's exported names, imports and who imports it: map file <path>", mutation: "none", positional: "the file's exact path", flags: pageFlags },
  { action: "search", synopsis: "search files and exported names: map search <words>", mutation: "none", positional: "words to search for", flags: pageFlags },
  { action: "refresh", synopsis: "ask for a check of main now; it runs on the next pass", mutation: "unkeyed", positional: null, flags: [jsonFlag, repoFlag] },
] as const;

export type MapCliContext = { store: Store; write: (line: string) => void; json: boolean; now: Date; actor: string | null; repos: readonly string[];
  /** Whether the caller stands as an approver of this project, proved now (a lead token does; a local owner doesn't). */
  approver: (repo: string) => boolean };
const printable = (text: string): string => [...text].map(char => (/[\p{C}]/u.test(char) ? `\\u{${char.codePointAt(0)!.toString(16)}}` : char)).join("");

function linesOf(answer: Extract<MapAnswer, { ok: true }>): string[] {
  const lines = [`Code map · main at ${answer.commit.slice(0, 7)}`, answer.label, ""];
  for (const item of answer.items as Record<string, unknown>[]) lines.push(printable(JSON.stringify(item)));
  if (answer.omitted > 0) lines.push(`${answer.omitted} too long to show.`);
  if (answer.cursor !== null) lines.push(`More: --cursor ${answer.cursor}`);
  return lines;
}

export async function runMapCommand(positional: readonly string[], options: Map<string, string | true>, context: MapCliContext): Promise<number> {
  const { store, now } = context;
  const first = positional[0];
  const action = first === undefined || first.startsWith("/") || first.startsWith(".") ? "" : first;
  const named = action === "" ? first : undefined;
  const command = action === "" ? "map" : `map ${action}`;
  const fail = (reason: "usage" | "unauthenticated" | "refused" | "not-found", message: string) => { context.write(context.json ? envelopeJson({ ok: false, command, reason, message }) : printable(message)); return reason === "usage" ? 2 : 1; };
  const ok = (result: Record<string, unknown>, lines: readonly string[]) => { context.write(context.json ? envelopeJson({ ok: true, command, ...result }) : lines.join("\n")); return 0; };
  if (!["", "area", "file", "search", "refresh", "report", "on", "off", "holdout"].includes(action)) return fail("usage", "Use map [<project>] | area <id> | file <path> | search <words> | refresh | report | on | off | holdout end.");
  const open = context.repos;
  const asked = options.get("repo") ?? named;
  if (asked === true) return fail("usage", "--repo takes a project path.");
  const wanted = asked === undefined ? (open.length === 1 ? open[0]! : null) : canonicalProject(asked) ?? resolve(asked);
  if (wanted === null) return fail("usage", "Name the project: --repo <path>.");
  if (!open.includes(wanted)) return fail("refused", "That project isn't one you can open here.");
  if (action === "refresh") {
    if (context.actor === null) return fail("unauthenticated", "Sign in first: an approver asks for a check.");
    if (!context.approver(wanted)) return fail("refused", "Only an approver asks for a check.");
    const said = requestRefresh(store, wanted, context.actor, now);
    return ok({ repo: wanted, request: said }, [said === "queued" ? "Queued: main is checked on the next pass." : "Already queued."]);
  }
  const cursor = options.get("cursor");
  if (cursor === true) return fail("usage", "--cursor takes the value the last answer gave.");
  if (action === "") {
    const status = codeMapStatus(store, wanted, now);
    if (status.version === null) return ok({ map: { v: 1, ok: false, state: status.state, message: status.words }, state: status.state }, [status.words]);
    const answer = answerMap(store, { repo: wanted, view: "overview", ...(cursor === undefined ? {} : { cursor }) });
    if (!answer.ok) return ok({ map: answer, state: status.state }, [answer.message]);
    if (context.json) return ok({ map: answer, state: status.state }, []);
    const opened = openMap(store, wanted, answer.version);
    const rows = opened.ok ? areaRows(opened.map) : [];
    return ok({}, [`Code map · main at ${answer.commit.slice(0, 7)} · ${status.words}`, answer.label, "", ...rows.slice(0, 60).map(one => printable(`${one.id} · ${one.files} files · ${one.languages.join(", ") || "no code"}${one.uses.length === 0 ? "" : ` · uses ${one.uses.slice(0, 3).map(use => use.id).join(", ")}`}`)), ...(rows.length > 60 ? [`${rows.length - 60} more: use --json with --cursor.`] : [])]);
  }
  const view = action as MapView;
  const query = positional.slice(1).join(" ");
  if (query === "") return fail("usage", action === "search" ? "Say what to search for." : `Name it: map ${action} <${action === "area" ? "id" : "path"}>.`);
  const answer = answerMap(store, { repo: wanted, view, ...(view === "search" ? { query } : { id: positional[1]! }), ...(cursor === undefined ? {} : { cursor }) });
  if (!answer.ok) return answer.state === "not-found" || answer.state === "usage" ? fail(answer.state === "usage" ? "usage" : "not-found", answer.message) : ok({ map: answer }, [answer.message]);
  return ok({ map: answer }, linesOf(answer));
}
