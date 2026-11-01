/**
 * youiyoux change and options requests become tasks (docs/guide/getting-started.md, "Change requests from youiyoux").
 *
 * youiyoux is a design-system tool: in its hub a person points at a component on a screenshot of their app and asks
 * for a change, and it saves the request as `<project>/.youi/requests/<id>.json` (`youi.request/v1`). A project that
 * uses youiyoux (a `youi.project.json` at its root, or a `.youi/requests` folder) has this intake on with no step of
 * its own, unless a person turned it off in Settings → Integrations.
 *
 * On the worker's flow pass this reads the project's main checkout — the path from Toolroll's own records, resolved
 * with realpath — and files each open change request with a task exactly once, keyed by the project and the request
 * id in `youiyoux_request`: never again, whatever the file says later. Everything in the folder is outside text,
 * written by whoever can write the project's folder:
 *
 * - the folders and files must be real (never a link), a file a single link to itself, at most 64 KB, read without
 *   following a link or waiting on a pipe, and at most 200 are read in one pass;
 * - a file whose name, schema or id is wrong is counted (the integration says so) and never filed;
 * - text that looks like a key or password is left out (recorded once, never filed), as flow triggers do;
 * - a path the task may touch is kept only when youiyoux knew them all and every one is a plain relative path;
 * - the task is filed through the one filing door (proposal.ts) by the "youiyoux" automation, unplanned, and waits
 *   for a person: its provenance (`filed_via = 'youiyoux'`) keeps every seal no person looked at off it (store.ts,
 *   the outside-request quarantine), so no operating mode, grant, schedule or automatic seal approves it. A person
 *   approves it in Toolroll, or with their own two taps in their paired chat where they turned approving from chat
 *   on (chat-decide.ts), bound to the exact scope the card showed.
 *
 * Beside each request it writes `<id>.task.json` (`youi.request-task/v1`): the task and its status, and, when the
 * console has an address (the one the installation names, else this machine's own console where `up` serves it, on
 * loopback), the task's link and `home`, where a person approves all waiting work. It is written when filed, whenever
 * the status changes, and once more when that address changes. Beside an options request's options file (below), it is
 * the only file it writes in the checkout: written whole (a temporary file in the same folder, then renamed over),
 * refused when the folder or the target is a link, never the request itself. The status is also kept in the store;
 * nothing Toolroll decides reads the file back.
 *
 * Status words (task-status.ts headline → youiyoux): Queued → queued; Planning, Building and Waiting (work going on
 * by itself) → building; Needs you → needs-you; Ready for review → ready; Complete → done; Failed → failed;
 * Stopped → stopped.
 *
 * An options request (`kind: "options"`) asks an agent for two to four options for one component, which youiyoux shows
 * on its Screens canvas. It is filed the same way, once, waiting for a person, and only as youiyoux's contract has it:
 * its offer names `p-<its own hex>`, that proposal's file `.youi/proposals/p-<hex>.json`, and the task may touch that
 * one file (anything else is counted as a file that couldn't be read, and never filed). The proposal it names is kept
 * when filed; the request is never read for it again. Then (runYouiyoux, the worker's pass):
 *
 * - When the task is Ready for review (or Complete), its result is read: the file at the result's commit, the commit
 *   Toolroll recorded for the build (never the checkout the agent had, which it controls and the pool hands on), read
 *   with the hardened git (teardown-git.ts). It must be a plain file in that commit (never a link), at most 64 KB, a
 *   `youi.proposal/v1` file whose id is the proposal, which answers this request, still open (an agent proposes; only a
 *   person decides), by an agent, with no key-like text. Then it is copied, byte for byte, into the project's main
 *   checkout as `.youi/proposals/<id>.json` the way the status file is written (folders real, never through a link;
 *   a temporary file, then linked into place, which never replaces a file already there: a person may have decided on
 *   it). A file missing from the result, or one that isn't safe, is said in the status file and never copied; a newer
 *   result is read again.
 * - Only a file Toolroll copied is read for a decision: one already at that name is left as it was (a person may
 *   have decided on it) and never read for one, unless it is byte for byte the result's (an earlier pass's copy).
 * - When that copy says a person chose an option or dismissed them all (youiyoux's hub writes that), and it is still
 *   the proposal copied (only its status, choice, decidedBy, decidedAt, request and updatedAt may differ), decided by
 *   a person, at a time, the task is marked complete by Toolroll, as landed work is (result-completion.ts LANDED_ACTOR), without
 *   merging or publishing its branch: its deliverable was the options, and youiyoux has used them. Only the exact
 *   result whose file was copied, and only through every guard a person's completion passes (landed-cleanup.ts
 *   completionProblem): otherwise it stays Ready for review and the ledger says why. The ledger keeps who decided
 *   what, as youiyoux wrote it (outside text, cleaned). A decision never approves, publishes or merges anything.
 */

import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, renameSync, unlinkSync, writeSync, type Stats } from "node:fs";
import { join } from "node:path";
import type { Store } from "./store.js";
import { fileTaskProposal } from "./proposal.js";
import { canonicalProject } from "./project.js";
import { scanForSecrets } from "./evidence.js";
import { hasDisguisedText } from "./decision.js";
import { storedTaskStatus } from "./flow-card-task.js";
import { loadConsoleUrl, localConsoleUrl } from "./webhooks.js";
import type { Headline } from "./task-status.js";
import { assignmentOf } from "./assignment.js";
import { canonicalJson } from "./canonical-json.js";
import { noteAssignmentStatus } from "./assignment-status.js";
import { completionProblem, type Git } from "./landed-cleanup.js";
import { COMPLETION_ACTION, LANDED_ACTOR } from "./result-completion.js";
import { optionsProblem, PROPOSAL_ID, proposalFileOf, proposalIdOf, readYouiyouxProposal, readYouiyouxRequest, readYouiyouxRequestTask, YOUIYOUX_CARD_KIND, YOUIYOUX_FILED_VIA, YOUIYOUX_HOME_PATH,
  type YouiyouxRequest, type YouiyouxRequestTask, type YouiyouxTaskStatus } from "./contracts/youiyoux-request.js";

export { YOUIYOUX_FILED_VIA };
/** Who files the tasks: an automation, like a flow trigger. */
export const YOUIYOUX_ACTOR = "youiyoux";
export const REQUEST_BYTES = 64 * 1024;
export const REQUESTS_PER_PASS = 200;
export const FILED_PER_PASS = 10;
const STATUS_PER_PASS = 50;
/** Options requests whose result is read, or whose copy in the hub is read for a decision, in one pass (each). */
const OPTIONS_PER_PASS = 20;
/** The ledger's word for a decision youiyoux's hub made on a task's options. */
export const OPTIONS_DECIDED_ACTION = "youiyoux options decided";
export const OPTIONS_COPIED_ACTION = "youiyoux options copied";
/** The flow pass runs every 15 seconds; the folder is read at most this often. */
export const INTAKE_EVERY_MS = 30_000;
const REQUEST_FILE = /^(r-[0-9a-f]{10})\.json$/;

export const STATUS_OF_HEADLINE: Readonly<Record<Headline, YouiyouxTaskStatus>> = {
  Queued: "queued", Planning: "building", "Needs you": "needs-you", Waiting: "building", Building: "building",
  "Ready for review": "ready", Complete: "done", Failed: "failed", Stopped: "stopped",
};

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code === "ENOENT";

// ------------------------------------------------------------ the project

/** Whether a project uses youiyoux: a `youi.project.json` at its root, or a `.youi` folder. Only their presence is
 * read here (a link counts, so the integration can say it is Broken); requestsFolder decides what may be read. */
export function usesYouiyoux(repo: string): boolean {
  const there = (path: string) => { try { lstatSync(path); return true; } catch { return false; } };
  return there(join(repo, "youi.project.json")) || there(join(repo, ".youi"));
}

type Folder = { ok: true; dir: string } | { ok: false; problem: string } | null;

/** `.youi/<part>` of a recorded project, checked now: null when there is none. Links are refused, never followed.
 * `create`: a missing `<part>` (never `.youi` itself) is made, as a real folder, and checked again. */
function youiFolder(repo: string, part: "requests" | "proposals", create = false): Folder {
  const what = part === "requests" ? "its requests aren't read" : "nothing is written in it";
  let root: string;
  try { root = realpathSync(repo); } catch { return { ok: false, problem: "The project folder can't be read." }; }
  if (root !== repo) return { ok: false, problem: `The project folder moved or is a link, so ${what}.` };
  let dir = root;
  for (const name of [".youi", part]) {
    dir = join(dir, name);
    let stats: Stats;
    try { stats = lstatSync(dir); } catch (error) {
      if (!isMissing(error)) return { ok: false, problem: `${name} can't be read.` };
      if (!create || name === ".youi") return null;
      try { mkdirSync(dir, 0o755); stats = lstatSync(dir); } catch { return { ok: false, problem: `.youi/${part} couldn't be made.` }; }
    }
    if (stats.isSymbolicLink()) return { ok: false, problem: `${dir.slice(root.length + 1)} is a link, so ${what}. Make it a real folder.` };
    if (!stats.isDirectory()) return { ok: false, problem: `${dir.slice(root.length + 1)} isn't a folder.` };
  }
  try { if (realpathSync(dir) !== dir) return { ok: false, problem: `.youi/${part} resolves outside the project.` }; } catch { return { ok: false, problem: `.youi/${part} can't be read.` }; }
  return { ok: true, dir };
}
const requestsFolder = (repo: string): Folder => youiFolder(repo, "requests");

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0;

/** One request file's text: a real file with one link, at most REQUEST_BYTES, read without following a link. */
function readRequestFile(dir: string, name: string): { ok: true; text: string } | { ok: false; why: string } {
  const path = join(dir, name);
  let stats: Stats;
  try { stats = lstatSync(path); } catch { return { ok: false, why: "it can't be read" }; }
  if (stats.isSymbolicLink() || !stats.isFile()) return { ok: false, why: "it isn't a plain file" };
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | NOFOLLOW | NONBLOCK); } catch { return { ok: false, why: "it can't be read" }; }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== stats.ino || opened.dev !== stats.dev) return { ok: false, why: "it isn't a plain file" };
    if (opened.size > REQUEST_BYTES) return { ok: false, why: "it is over 64 KB" };
    const buffer = Buffer.alloc(REQUEST_BYTES + 1);
    let length = 0;
    for (let read = -1; read !== 0 && length < buffer.length;) { read = readSync(fd, buffer, length, buffer.length - length, null); length += read; }
    if (length > REQUEST_BYTES) return { ok: false, why: "it is over 64 KB" };
    return { ok: true, text: buffer.subarray(0, length).toString("utf8") };
  } catch { return { ok: false, why: "it can't be read" }; } finally { closeSync(fd); }
}

type Read = { requests: YouiyouxRequest[]; invalid: string[]; more: boolean };

/** The open change and options requests in the folder not yet taken, and the files that couldn't be read as requests
 * (an options request that doesn't hold to youiyoux's contract among them). */
function readRequests(dir: string, taken: ReadonlySet<string>): Read {
  const names = readdirSync(dir).filter(name => REQUEST_FILE.test(name) && !taken.has(name.slice(0, 12))).sort();
  const out: Read = { requests: [], invalid: [], more: names.length > REQUESTS_PER_PASS };
  for (const name of names.slice(0, REQUESTS_PER_PASS)) {
    const id = name.slice(0, 12);
    const file = readRequestFile(dir, name);
    if (!file.ok) { out.invalid.push(`${name}: ${file.why}`); continue; }
    let raw: unknown;
    try { raw = JSON.parse(file.text); } catch { out.invalid.push(`${name}: it isn't JSON`); continue; }
    const parsed = readYouiyouxRequest(raw);
    if (!parsed.ok) { out.invalid.push(`${name}: it isn't a youi.request/v1 request (${parsed.issues[0]?.line ?? "unreadable"})`); continue; }
    if (parsed.value.id !== id) { out.invalid.push(`${name}: its id is ${parsed.value.id}`); continue; }
    // Comments, requests already addressed or closed, and changes with no task are someone else's to act on.
    if (parsed.value.kind === "comment" || parsed.value.status !== "open") continue;
    const options = optionsProblem(parsed.value);
    if (options !== null) { out.invalid.push(`${name}: ${options}`); continue; }
    if (parsed.value.task === undefined) continue;
    out.requests.push(parsed.value);
  }
  return out;
}

// ------------------------------------------------------------ the task

/** One line of outside text: control and hidden characters out, runs of space as one, at most `max` characters. */
function line(text: string, max: number): string {
  const clean = text.replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/** Outside paragraphs: control characters out (newlines and tabs kept), hidden characters out. */
function paragraphs(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\p{Cf}\u2028\u2029]/gu, "").trim();
}

/** The paths a request may touch: every one a plain relative path inside the project, or none at all. */
export function safeTouches(touches: readonly string[]): string[] | null {
  const ok = (path: string) => path !== "" && path.length <= 200 && !path.includes("\u0000") && !/[\p{Cc}\p{Cf}]/u.test(path)
    && !path.startsWith("/") && !path.startsWith("\\") && !/^[A-Za-z]:/.test(path) && !path.startsWith("~")
    && !path.split(/[\\/]/).some(part => part === ".." || part === "") && path.trim() === path;
  return touches.every(ok) ? [...new Set(touches)] : null;
}

/** A criterion statement in a rubric's own terms: one line, and no `|` (the rubric's field separator). */
function statement(text: string): string {
  return line(text.replace(/\|/g, "/"), 300);
}

export type RequestTask = { title: string; goal: string; outOfScope: string | null; touches: string[]; acceptance: { id: string; statement: string; how: null; evidence: string[] }[];
  /** Where the person pointed, for the task page: the route, the component, and `file:line` when youiyoux knew a plain one. */
  pointed: { route: string; component: string; at: string | null } };

/** The task a request asks for, in Toolroll's terms. Text is cleaned here; whether it may be filed is decided by the caller. */
export function requestTask(request: YouiyouxRequest): RequestTask {
  const task = request.task!;
  const touches = task.touchesKnown ? safeTouches(task.touches) ?? [] : [];
  const not = task.not.map(one => line(one, 300)).filter(one => one !== "");
  return {
    title: line(task.title, 120) || `youiyoux request ${request.id}`,
    goal: `From youiyoux request ${request.id} on ${line(request.target.route, 300)}.\n\n${paragraphs(task.goal)}`,
    outOfScope: not.length === 0 ? null : not.map(one => `- ${one}`).join("\n"),
    touches,
    acceptance: task.acceptance.map((one, index) => ({ id: `c${index + 1}`, statement: statement(one.statement), how: null, evidence: [...new Set(one.evidence)] }))
      .filter(one => one.statement !== ""),
    pointed: { route: line(request.target.route, 300), component: line(request.target.name, 200), at: pointedAt(request.target) },
  };
}

/** `file:line` (or the file alone) where youiyoux knew a plain relative path; null otherwise. */
function pointedAt(target: YouiyouxRequest["target"]): string | null {
  const file = target.file === undefined ? null : safeTouches([target.file])?.[0] ?? null;
  return file === null ? null : target.line === undefined ? file : `${file}:${target.line}`;
}

/** Why a request's task can't be filed as it stands, or null. */
function refusalOf(request: YouiyouxRequest, task: RequestTask): string | null {
  const given = request.task!;
  // Read as written and as cleaned: cleaning must never be what lets a key through.
  const raw = [given.title, given.goal, request.target.route, request.target.name, request.target.file ?? "", ...given.not, ...given.touches, ...given.acceptance.map(one => one.statement)];
  const all = [task.title, task.goal, task.outOfScope ?? "", ...task.touches, ...task.acceptance.map(one => one.statement), task.pointed.route, task.pointed.component, task.pointed.at ?? ""];
  if ([...raw, ...all].some(one => scanForSecrets(one).length > 0)) return "it looked like it held a key or password";
  if (all.some(one => hasDisguisedText(one))) return "it carried hidden characters";
  if (task.acceptance.length === 0) return "it had no requirement to check";
  return null;
}

// ------------------------------------------------------------ the store

type IntakeRow = { enabled: boolean | null; uses: boolean; checkedAt: string | null; invalid: number; problem: string | null; changedBy: string | null };

function intakeRow(store: Store, repo: string): IntakeRow {
  const row = store.handle.prepare("SELECT * FROM youiyoux_intake WHERE repo = ?").get(repo);
  if (row === undefined) return { enabled: null, uses: false, checkedAt: null, invalid: 0, problem: null, changedBy: null };
  return { enabled: row["enabled"] === null ? null : Number(row["enabled"]) === 1, uses: Number(row["uses"]) === 1, checkedAt: row["checked_at"] === null ? null : String(row["checked_at"]),
    invalid: Number(row["invalid"] ?? 0), problem: row["problem"] === null ? null : String(row["problem"]), changedBy: row["changed_by"] === null ? null : String(row["changed_by"]) };
}

function recordPass(store: Store, repo: string, now: Date, uses: boolean, invalid: number, problem: string | null): void {
  store.handle.prepare(`INSERT INTO youiyoux_intake (repo, uses, checked_at, invalid, problem) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (repo) DO UPDATE SET uses = excluded.uses, checked_at = excluded.checked_at, invalid = excluded.invalid, problem = excluded.problem`).run(repo, uses ? 1 : 0, now.toISOString(), invalid, problem);
}

/** A person turns the intake off or back on for a project; the ledger keeps who. */
export function setYouiyouxIntake(store: Store, repo: string, on: boolean, by: string, now: Date): void {
  store.transact(() => {
    store.handle.prepare(`INSERT INTO youiyoux_intake (repo, enabled, changed_by, changed_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (repo) DO UPDATE SET enabled = excluded.enabled, changed_by = excluded.changed_by, changed_at = excluded.changed_at`).run(repo, on ? 1 : 0, by, now.toISOString());
    store.recordAction({ at: now.toISOString(), actor: by, repo, taskId: null, runId: null, action: on ? "youiyoux requests on" : "youiyoux requests off", outcome: "changed", source: "access" });
  });
}

export type YouiyouxState = {
  /** The project uses youiyoux, as the worker's last pass found. */
  uses: boolean;
  /** Requests become tasks: it uses youiyoux and nobody turned it off. */
  on: boolean;
  /** A person turned it off. */
  off: boolean;
  /** Filed tasks not yet done, failed or stopped. */
  queued: number;
  filed: number;
  invalid: number;
  problem: string | null;
  checkedAt: string | null;
};

/** How the intake stands for one project, from the store alone: a page reads it on every render, so it never reads the
 * project's folder (one that doesn't answer must not hold the console). Whether it uses youiyoux is the last pass's. */
export function youiyouxState(store: Store, repo: string): YouiyouxState {
  const row = intakeRow(store, repo);
  const uses = row.uses;
  const counts = store.handle.prepare(`SELECT count(task_id) AS filed, sum(CASE WHEN task_id IS NOT NULL AND (status IS NULL OR status NOT IN ('done','failed','stopped')) THEN 1 ELSE 0 END) AS queued
    FROM youiyoux_request WHERE repo = ?`).get(repo);
  return { uses, on: uses && row.enabled !== false, off: row.enabled === false, queued: Number(counts?.["queued"] ?? 0), filed: Number(counts?.["filed"] ?? 0),
    invalid: row.invalid, problem: row.problem, checkedAt: row.checkedAt };
}

/** The one line `toolroll onboard` says for a project that uses youiyoux; null when it doesn't. */
export function youiyouxOnboardLine(store: Store, repo: string): string | null {
  if (!usesYouiyoux(repo)) return null;
  return intakeRow(store, repo).enabled === false ? "change requests: off (turn on in Settings → Integrations)" : "change requests become tasks that wait for your approval";
}

// ------------------------------------------------------------ the status file

/** The console the links name: the address the installation names (CONSOLE_URL or the console-url file), else, with
 * none named, this machine's own console where `up` serves it (loopback http only, never a guessed host); null without
 * either. Either way http(s) with no credentials, query or fragment. */
export function consoleBase(env: Record<string, string | undefined>, dir: string | null): string | null {
  if (dir === null) return null;
  const given = loadConsoleUrl(env, dir) ?? localConsoleUrl(dir);
  if (given === null) return null;
  let url: URL;
  try { url = new URL(given); } catch { return null; }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** The task's page in that console; null without one. */
export function taskLink(env: Record<string, string | undefined>, dir: string | null, taskId: string): string | null {
  const base = consoleBase(env, dir);
  return base === null ? null : `${base}/t/${encodeURIComponent(taskId)}`;
}

/**
 * Write `<id>.task.json` beside its request, whole. The folders are checked again now (a link is refused), the request
 * must still be a plain file, the target must be a plain file or absent, and the content goes to a fresh temporary file
 * in the same folder (created exclusively, never through a link) that is then renamed over the target.
 */
export function writeStatusFile(repo: string, body: YouiyouxRequestTask): { ok: true } | { ok: false; problem: string } {
  const folder = requestsFolder(repo);
  if (folder === null) return { ok: false, problem: "The requests folder is gone." };
  if (!folder.ok) return folder;
  const plain = (path: string): boolean | null => { try { const stats = lstatSync(path); return !stats.isSymbolicLink() && stats.isFile(); } catch (error) { return isMissing(error) ? null : false; } };
  if (plain(join(folder.dir, `${body.request}.json`)) !== true) return { ok: false, problem: "The request file is gone." };
  if (!readYouiyouxRequestTask(body).ok) return { ok: false, problem: "The status didn't meet its own contract, so it wasn't written." };
  const target = join(folder.dir, `${body.request}.task.json`);
  if (plain(target) === false) return { ok: false, problem: `${body.request}.task.json isn't a plain file, so it wasn't replaced.` };
  const temporary = join(folder.dir, `.${body.request}.task.json.${randomBytes(6).toString("hex")}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o644);
    writeSync(fd, `${JSON.stringify(body, null, 2)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    // At the moment of use: the folder and the target are still what was checked.
    const again = requestsFolder(repo);
    if (again === null || !again.ok || again.dir !== folder.dir || plain(target) === false) throw new Error("The requests folder changed while the status was written.");
    renameSync(temporary, target);
    return { ok: true };
  } catch (error) {
    if (fd !== null) try { closeSync(fd); } catch { /* already closed */ }
    try { unlinkSync(temporary); } catch { /* never made, or already renamed */ }
    return { ok: false, problem: error instanceof Error && error.message.startsWith("The requests folder") ? error.message : "The status couldn't be written beside the request." };
  }
}

/**
 * Put an options file into the project's main checkout as `.youi/proposals/<id>.json`, whole, and never over a file
 * already there (a person may have decided on it). The folders are checked as the status file's are (`.youi/proposals`
 * is made, as a real folder, when missing), the content goes to a fresh temporary file in the same folder (created
 * exclusively, never through a link), the folders are checked again, and the temporary file is linked into place, which
 * fails rather than replace anything at that name, a link included. `same`: that exact content was already there;
 * `taken`: something else was, and is left as it was.
 */
export function writeProposalFile(repo: string, id: string, text: string): { ok: true; made: "written" | "same" | "taken" } | { ok: false; problem: string } {
  if (!PROPOSAL_ID.test(id)) return { ok: false, problem: "The options file's name isn't youiyoux's." };
  const folder = youiFolder(repo, "proposals", true);
  if (folder === null) return { ok: false, problem: "The project has no .youi folder." };
  if (!folder.ok) return folder;
  const name = `${id}.json`;
  const target = join(folder.dir, name);
  const already = (): { ok: true; made: "same" | "taken" } | { ok: false; problem: string } => {
    const there = readRequestFile(folder.dir, name);
    if (!there.ok) return { ok: false, problem: `.youi/proposals/${name} is already there and ${there.why}, so it was left alone.` };
    return { ok: true, made: there.text === text ? "same" : "taken" };
  };
  try { lstatSync(target); return already(); } catch (error) { if (!isMissing(error)) return { ok: false, problem: `.youi/proposals/${name} can't be read.` }; }
  const temporary = join(folder.dir, `.${name}.${randomBytes(6).toString("hex")}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o644);
    writeSync(fd, text);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    // At the moment of use: the folder is still what was checked.
    const again = youiFolder(repo, "proposals");
    if (again === null || !again.ok || again.dir !== folder.dir) throw new Error("The proposals folder changed while the options were written.");
    try { linkSync(temporary, target); } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === "EEXIST") return already();
      throw error;
    }
    return { ok: true, made: "written" };
  } catch (error) {
    return { ok: false, problem: error instanceof Error && error.message.startsWith("The proposals folder") ? error.message : "The options couldn't be written into .youi/proposals." };
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* already closed */ }
    try { unlinkSync(temporary); } catch { /* never made */ }
  }
}

function statusOf(store: Store, taskId: string, repo: string, now: Date, root: string | null): { status: YouiyouxTaskStatus; detail: string } | null {
  // With the saved evidence, so a completed task reads Complete (its completion is bound to the receipt read with it).
  const read = storedTaskStatus(store, taskId, repo, now, root ?? undefined);
  return read === null ? null : { status: STATUS_OF_HEADLINE[read.status.headline], detail: read.status.headline };
}

const clip = (text: string): string => text.length > 200 ? `${text.slice(0, 199).trimEnd()}…` : text;

/** The status file's words for an options request, where its options stand (else the headline): what a person decided
 * in the hub, and while the result is Ready (or Complete), whether its options went to the hub, and why not. */
function optionsDetail(row: Record<string, unknown> | undefined, status: YouiyouxTaskStatus, headline: string): string {
  if (row?.["kind"] !== "options") return headline;
  if (row["decided"] != null && typeof row["decided_note"] === "string") return clip(row["decided_note"]);
  if (status !== "ready" && status !== "done") return headline;
  const note = typeof row["proposal_note"] === "string" ? row["proposal_note"] : "";
  switch (row["proposal_state"]) {
    case "copied": return "Options are ready in the hub.";
    case "taken": return "An options file was already in the hub, so Toolroll left it; the task waits for its review.";
    case "missing": return "The agent didn't write the options file, so nothing went to the hub.";
    case "unsafe": return clip(`The options file wasn't copied to the hub: ${note}.`);
    case "retry": return clip(`The options aren't in the hub yet: ${note}.`);
    default: return headline;
  }
}

/** Write a filed task's status where it changed, where its last write failed, or where the console its links name
 * changed since (`written_base`: '' for none), so a file written before a console address existed gets its links. */
function writeStatus(store: Store, repo: string, request: string, taskId: string, now: Date, io: YouiyouxIo, force: boolean): boolean {
  const known = store.handle.prepare(`SELECT status, detail, written_at, written_base, kind, proposal_state, proposal_note, decided, decided_note
    FROM youiyoux_request WHERE repo = ? AND request = ?`).get(repo, request);
  const read = statusOf(store, taskId, repo, now, io.evidenceRoot ?? null);
  if (read === null) return false;
  const status = { status: read.status, detail: optionsDetail(known, read.status, read.detail) };
  const base = consoleBase(io.env, io.dir);
  if (!force && known?.["status"] === status.status && known?.["written_at"] !== null && known?.["written_base"] === (base ?? "")) return false;
  const body: YouiyouxRequestTask = { schema: "youi.request-task/v1", request, runner: "Toolroll", task: { id: taskId, url: base === null ? null : `${base}/t/${encodeURIComponent(taskId)}` },
    ...(base === null ? {} : { home: `${base}${YOUIYOUX_HOME_PATH}` }), status: status.status, detail: status.detail, updatedAt: now.toISOString() };
  const wrote = writeStatusFile(repo, body);
  store.handle.prepare(`UPDATE youiyoux_request SET status = ?, detail = ?, status_at = ?, written_at = CASE WHEN ? THEN ? ELSE written_at END,
    written_base = CASE WHEN ? THEN ? ELSE written_base END, write_problem = ? WHERE repo = ? AND request = ?`)
    .run(status.status, status.detail, now.toISOString(), wrote.ok ? 1 : 0, now.toISOString(), wrote.ok ? 1 : 0, base ?? "", wrote.ok ? null : wrote.problem, repo, request);
  return wrote.ok;
}

// ------------------------------------------------------------ the pass

/** `git`: the hardened git an options request's result is read with (landed-cleanup.ts gitOf), and `evidenceRoot`, where
 * results' saved evidence is (a completion is bound to the receipt read with it). Without either, options wait. */
export type YouiyouxIo = { dir: string | null; env: Record<string, string | undefined>; git?: Git; evidenceRoot?: string | null };
/** `copied`: options files that went to the hub; `decided`: decisions in the hub Toolroll acted on. */
export type YouiyouxPass = { filed: number; skipped: number; invalid: number; updated: number; copied: number; decided: number; problems: string[] };
export const NO_YOUIYOUX_PASS: Readonly<YouiyouxPass> = Object.freeze({ filed: 0, skipped: 0, invalid: 0, updated: 0, copied: 0, decided: 0, problems: [] });
const NOTHING = (): YouiyouxPass => ({ ...NO_YOUIYOUX_PASS, problems: [] });

/** File one request's task, exactly once: the claim and the filing are one transaction (two passes, in two processes
 * or one, make one task). */
export function fileYouiyouxRequest(store: Store, repo: string, request: YouiyouxRequest, now: Date): { made: "filed"; taskId: string } | { made: "seen" } | { made: "skipped"; note: string } {
  const task = requestTask(request);
  return store.transact(() => {
    if (store.handle.prepare("SELECT 1 FROM youiyoux_request WHERE repo = ? AND request = ?").get(repo, request.id) !== undefined) return { made: "seen" as const };
    const kind = request.kind === "options" ? "options" : "change";
    const proposal = kind === "options" ? proposalIdOf(request.id) : null;
    const leaveOut = (note: string) => {
      store.handle.prepare("INSERT INTO youiyoux_request (repo, request, task_id, note, filed_at, kind, proposal) VALUES (?, ?, NULL, ?, ?, ?, ?)").run(repo, request.id, note, now.toISOString(), kind, proposal);
      return { made: "skipped" as const, note };
    };
    const refused = refusalOf(request, task);
    if (refused !== null) return leaveOut(refused);
    const filed = fileTaskProposal(store, {
      title: task.title, repo, goal: task.goal, outOfScope: task.outOfScope, touches: task.touches, acceptance: task.acceptance,
      filedVia: YOUIYOUX_FILED_VIA, filedBy: { name: YOUIYOUX_ACTOR, kind: "automation" }, planning: "skip", admittedRepos: [repo],
    }, now);
    if (!filed.ok) return leaveOut(`Toolroll refused it: ${filed.message}`);
    store.handle.prepare("INSERT INTO youiyoux_request (repo, request, task_id, filed_at, route, component, source_at, kind, proposal) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(repo, request.id, filed.id, now.toISOString(), task.pointed.route, task.pointed.component, task.pointed.at, kind, proposal);
    store.recordAction({ at: now.toISOString(), actor: YOUIYOUX_ACTOR, repo, taskId: filed.id, runId: null, action: "filed from a youiyoux request", outcome: "waits for approval", source: "work",
      detail: proposal === null ? request.id : `${request.id} (options: ${proposal})` });
    return { made: "filed" as const, taskId: filed.id };
  });
}

/**
 * One message for what a pass filed, however many: the person's paired chats draw it as one card (chat-decide.ts) that
 * lists each new task, with Approve all and each one's own Approve and Open, and a phone push links to what needs
 * them. Keyed by the pass's first task, so a pass says it once; the tasks are the ones filed with it (one project, one
 * moment: requestPassOf). Titles are cleaned outside text, as filed.
 */
export function noteYouiyouxFiled(store: Store, taskIds: readonly string[], now: Date): void {
  const first = store.lookupRef(taskIds[0]!);
  if (first === null) return;
  const titles = taskIds.map(id => store.getTask(id)?.title ?? id);
  const what = requestKindWord(store, taskIds);
  store.enqueueNotification({
    dedupeKey: `${YOUIYOUX_CARD_KIND}:${first.id}`, kind: YOUIYOUX_CARD_KIND, pushClass: "attention", link: YOUIYOUX_HOME_PATH, source: { taskRef: first.id },
    subject: taskIds.length === 1 ? `A youiyoux ${what} waits for your approval` : `${taskIds.length} youiyoux ${what}s wait for your approval`,
    body: titles.map(title => `• ${title}`).join("\n"),
  }, now);
}

/** What a pass's tasks were asked for, in a word: "change request", "options request", or "request" for both. */
export function requestKindWord(store: Store, taskIds: readonly string[]): string {
  const kinds = new Set(taskIds.map(id => store.youiyouxOriginOf(id)?.kind ?? "change"));
  return kinds.size > 1 ? "request" : kinds.has("options") ? "options request" : "change request";
}

/** The tasks one pass filed beside this one (one project, one moment), in request order; empty for any other task. */
export function requestPassOf(store: Store, taskId: string): string[] {
  return store.handle.prepare(`SELECT r.task_id FROM youiyoux_request me JOIN youiyoux_request r ON r.repo = me.repo AND r.filed_at = me.filed_at
    WHERE me.task_id = ? AND r.task_id IS NOT NULL ORDER BY r.request LIMIT ?`).all(taskId, FILED_PER_PASS).map(row => String(row["task_id"]));
}

/**
 * One project's pass: read new requests and file them, then write each filed task's status where it changed (no
 * options moved: runYouiyoux does that too). The folder read is the project in Toolroll's records that `given`
 * resolves to; anything else is left alone.
 */
export function runYouiyouxIntake(store: Store, given: string, now: Date, io: YouiyouxIo, options: { force?: boolean } = {}): YouiyouxPass {
  return intake(store, given, now, io, options).pass;
}

/** The worker's pass for one project (flow-cadence.ts): the intake, then each options request's options, both ways. */
export async function runYouiyoux(store: Store, given: string, now: Date, io: YouiyouxIo, options: { force?: boolean } = {}): Promise<YouiyouxPass> {
  const { pass, repo } = intake(store, given, now, io, options);
  if (repo !== null) await optionsPass(store, repo, now, io, pass);
  return pass;
}

/** The intake's pass; `repo` is the project when its requests folder was read whole (and options may move). */
function intake(store: Store, given: string, now: Date, io: YouiyouxIo, options: { force?: boolean }): { pass: YouiyouxPass; repo: string | null } {
  const pass = NOTHING();
  const none = { pass, repo: null };
  // The project as Toolroll recorded it, resolved: a folder that isn't one of its projects is never read.
  const repo = canonicalProject(given);
  if (repo === null || !store.listProjects().some(one => one.path === repo)) return none;
  const row = intakeRow(store, repo);
  if (row.enabled === false) return none;
  if (options.force !== true && row.checkedAt !== null && now.getTime() - Date.parse(row.checkedAt) < INTAKE_EVERY_MS) return none;
  if (!usesYouiyoux(repo)) { if (row.uses) recordPass(store, repo, now, false, 0, null); return none; }
  const folder = requestsFolder(repo);
  if (folder === null) { recordPass(store, repo, now, true, 0, null); return none; }
  if (!folder.ok) { recordPass(store, repo, now, true, 0, folder.problem); pass.problems.push(`youiyoux: ${folder.problem}`); return none; }

  const taken = new Set(store.handle.prepare("SELECT request FROM youiyoux_request WHERE repo = ?").all(repo).map(one => String(one["request"])));
  let read: Read;
  try { read = readRequests(folder.dir, taken); } catch {
    recordPass(store, repo, now, true, 0, ".youi/requests can't be read.");
    pass.problems.push("youiyoux: .youi/requests can't be read.");
    return none;
  }
  pass.invalid = read.invalid.length;
  const filedNow: string[] = [];
  for (const request of read.requests.slice(0, FILED_PER_PASS)) {
    const made = fileYouiyouxRequest(store, repo, request, now);
    if (made.made === "filed") {
      pass.filed++;
      filedNow.push(made.taskId);
      if (writeStatus(store, repo, request.id, made.taskId, now, io, true)) pass.updated++;
    } else if (made.made === "skipped") pass.skipped++;
  }
  if (filedNow.length > 0) noteYouiyouxFiled(store, filedNow, now);
  // Each filed task's status, where it changed, its last write failed, or the console its links name changed.
  const filed = store.handle.prepare(`SELECT request, task_id FROM youiyoux_request WHERE repo = ? AND task_id IS NOT NULL
    AND (status IS NULL OR status <> 'done' OR written_at IS NULL OR written_base IS NOT ?) ORDER BY status_at LIMIT ?`).all(repo, consoleBase(io.env, io.dir) ?? "", STATUS_PER_PASS);
  for (const one of filed) {
    try { if (writeStatus(store, repo, String(one["request"]), String(one["task_id"]), now, io, false)) pass.updated++; }
    catch (error) { pass.problems.push(`youiyoux ${String(one["request"])}: ${error instanceof Error ? error.message : "status unreadable"}`); }
  }
  const problem = read.invalid.length === 0 ? null
    : `${plural(read.invalid.length, "request file")} couldn't be read: ${read.invalid[0]}${read.invalid.length > 1 ? ", and others" : ""}.`;
  recordPass(store, repo, now, true, read.invalid.length, problem);
  return { pass, repo };
}

// ------------------------------------------------------------ options, both ways

export type OptionsRow = { request: string; taskId: string; proposal: string; state: string | null; run: number | null; digest: string | null };
const optionsRow = (row: Record<string, unknown>): OptionsRow => ({ request: String(row["request"]), taskId: String(row["task_id"]), proposal: String(row["proposal"]),
  state: row["proposal_state"] == null ? null : String(row["proposal_state"]), run: row["proposal_run"] == null ? null : Number(row["proposal_run"]),
  digest: row["proposal_digest"] == null ? null : String(row["proposal_digest"]) });

/** What a person's decision in the hub may change in an options file (youiyoux seals it, with a key only the person
 * holds: `seal`); everything else must stay as Toolroll copied it. */
const DECISION_FIELDS = new Set(["status", "choice", "decidedBy", "decidedAt", "request", "seal", "updatedAt"]);
/** The digest of an options file apart from what a decision changes: the proposal itself, every other key included. */
export function proposalIdentity(raw: unknown): string | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const kept = Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([key]) => !DECISION_FIELDS.has(key)));
  return createHash("sha256").update(canonicalJson(kept)).digest("hex");
}
const SHA = /^[0-9a-f]{40}$/;

/** The task's current result, as its assignment reads it (with the saved evidence where the worker has it): the run and
 * the commit Toolroll recorded for it. Null without a finished result. */
function resultOf(store: Store, taskId: string, repo: string, now: Date, root: string | null) {
  const assignment = assignmentOf(store, taskId, now, { principal: "operator", repos: [repo] }, root ?? undefined);
  const receipt = assignment?.receipt ?? null;
  if (assignment === null || receipt === null || receipt.completionKind === null || receipt.completionKind === "research-report" || receipt.head === null || !SHA.test(receipt.head)) return null;
  return { assignment, receipt, head: receipt.head };
}

type Brought = { state: "copied" | "taken" | "missing" | "unsafe" | "retry"; note: string | null; digest?: string };

/** Why an agent's options file can't go to the hub as it stands, or null. Toolroll checks what makes it safe to copy
 * and this request's; youiyoux checks each option against the component's contract when it reads it. */
export function proposalProblem(text: string, proposal: string, request: string): string | null {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return "it isn't JSON"; }
  const parsed = readYouiyouxProposal(raw);
  if (!parsed.ok) { const issue = parsed.issues[0]; return `it isn't a youi.proposal/v1 file (${issue === undefined ? "unreadable" : `${issue.path}: ${issue.kind}`})`; }
  const doc = parsed.value;
  if (doc.id !== proposal) return `its id isn't ${proposal}`;
  if (doc.for !== request) return `it doesn't answer ${request}`;
  // An agent proposes; only a person decides, in the hub. A file that arrives decided would decide for them.
  if (doc.status !== "open" || doc.choice !== undefined || doc.decidedBy !== undefined || doc.decidedAt !== undefined || doc.request !== undefined || Object.hasOwn(raw as object, "seal")) return "it arrived already decided, and only a person decides";
  if (doc.author.kind !== "agent") return "its author isn't an agent";
  if (scanForSecrets(text).length > 0) return "it looked like it held a key or password";
  return null;
}

/** Read the options file from the result's commit (never the agent's checkout) and copy it to the hub. */
async function bringProposal(git: Git, repo: string, request: string, proposal: string, head: string): Promise<Brought> {
  const file = proposalFileOf(proposal);
  const listed = await git(repo, ["ls-tree", "-z", "--full-tree", head, "--", file]);
  if (listed.code !== 0) return { state: "retry", note: "git couldn't read the result" };
  const entries = listed.stdout.split("\0").filter(one => one !== "");
  if (entries.length === 0) return { state: "missing", note: null };
  const entry = /^(\d{6}) (\w+) ([0-9a-f]{40})\t(.*)$/s.exec(entries[0]!);
  if (entries.length !== 1 || entry === null || entry[4] !== file) return { state: "unsafe", note: "it isn't a plain file" };
  if (entry[1] === "120000") return { state: "unsafe", note: "it is a link" };
  if (entry[2] !== "blob" || (entry[1] !== "100644" && entry[1] !== "100755")) return { state: "unsafe", note: "it isn't a plain file" };
  const sized = await git(repo, ["cat-file", "-s", entry[3]!]);
  const size = Number(sized.stdout.trim());
  if (sized.code !== 0 || !Number.isSafeInteger(size)) return { state: "retry", note: "git couldn't read the result" };
  if (size > REQUEST_BYTES) return { state: "unsafe", note: "it is over 64 KB" };
  const blob = await git(repo, ["cat-file", "blob", entry[3]!]);
  if (blob.code !== 0) return { state: "retry", note: "git couldn't read the result" };
  if (Buffer.byteLength(blob.stdout, "utf8") !== size) return { state: "unsafe", note: "it isn't UTF-8 text" };
  const problem = proposalProblem(blob.stdout, proposal, request);
  if (problem !== null) return { state: "unsafe", note: problem };
  const wrote = writeProposalFile(repo, proposal, blob.stdout);
  if (!wrote.ok) return { state: "retry", note: wrote.problem.replace(/\.$/, "") };
  // Only Toolroll's own copy (written now, or byte for byte an earlier pass's) is ever read for a decision.
  if (wrote.made === "taken") return { state: "taken", note: "a file was already there; the task waits for its review" };
  return { state: "copied", note: null, digest: proposalIdentity(JSON.parse(blob.stdout))! };
}

export type Decision = { status: "chosen" | "dismissed"; choice: string | null; label: string | null; by: string | null; at: string | null };

/** What a person decided on the options in the hub, read from the copy in the main checkout; null while they are open or
 * the file can't be read as this request's. Who and the option's label are youiyoux's words: cleaned, and left out
 * when they look like a key. */
function decisionOf(repo: string, proposal: string, request: string, copied: string): Decision | null {
  const folder = youiFolder(repo, "proposals");
  if (folder === null || !folder.ok) return null;
  const file = readRequestFile(folder.dir, `${proposal}.json`);
  if (!file.ok) return null;
  let raw: unknown;
  try { raw = JSON.parse(file.text); } catch { return null; }
  const parsed = readYouiyouxProposal(raw);
  if (!parsed.ok || parsed.value.id !== proposal || parsed.value.for !== request) return null;
  // Still the proposal Toolroll copied: its options, ask, target and every other key, apart from what deciding changes.
  if (proposalIdentity(raw) !== copied) return null;
  const doc = parsed.value;
  if (doc.status === "open" || (doc.status === "chosen" && doc.choice === undefined)) return null;
  // A person's decision, at a time: an agent proposes, and never decides.
  if (doc.decidedBy?.kind !== "person" || doc.decidedAt === undefined) return null;
  const said = (text: string | undefined, max: number): string | null => {
    if (text === undefined) return null;
    const clean = line(text, max);
    return clean === "" || scanForSecrets(text).length > 0 || scanForSecrets(clean).length > 0 || hasDisguisedText(clean) ? null : clean;
  };
  return { status: doc.status as Decision["status"], choice: doc.choice ?? null, label: said(doc.options.find(one => one.id === doc.choice)?.label, 60),
    by: said(doc.decidedBy?.name, 100), at: doc.decidedAt ?? null };
}

/**
 * A person decided in the hub: mark the task complete as landed work is, bound to the exact result whose options were
 * copied, through every guard a person's completion passes, or leave it Ready for review and say why. Once per request,
 * in one transaction with the read. Waits (false) while the task isn't Ready, Complete or cancelled.
 */
export function actOnDecision(store: Store, repo: string, row: OptionsRow, decision: Decision, now: Date, root: string): boolean {
  return store.transact(() => {
    const current = store.handle.prepare("SELECT decided, proposal_run FROM youiyoux_request WHERE repo = ? AND request = ?").get(repo, row.request);
    if (current === undefined || current["decided"] !== null) return false;
    const assignment = assignmentOf(store, row.taskId, now, { principal: "operator", repos: [repo] }, root);
    if (assignment === null) return false;
    const receipt = assignment.receipt;
    const who = decision.by ?? "a person";
    const what = decision.status === "chosen" ? `option ${decision.choice}${decision.label === null ? "" : ` (“${decision.label}”)`}` : null;
    const words = what === null ? `${who} dismissed the options in youiyoux's hub` : `${who} picked ${what} in youiyoux's hub`;
    const picked = what === null ? "The options were dismissed in the hub" : `Option ${decision.choice} was picked in the hub`;
    let done: string, note: string, completes = false;
    if (assignment.state === "complete" || assignment.state === "cancelled") {
      done = `the task was already ${assignment.state}`;
      note = `${picked}.`;
    } else if (assignment.state !== "ready-to-check" || receipt === null) {
      return false;
    } else {
      const why = receipt.runId !== Number(current["proposal_run"]) ? "its newest result isn't the one whose options went to the hub" : completionProblem(store, assignment, root);
      if (why === null) {
        completes = true;
        done = "Toolroll marked the task complete without merging or publishing its branch";
        note = `${picked}, so the task is complete.`;
      } else {
        done = `the task stays ready for review in Toolroll: ${why}`;
        note = `${picked}; the task waits for review in Toolroll.`;
      }
    }
    const at = now.toISOString();
    if (completes) {
      store.recordAction({ at, actor: LANDED_ACTOR, repo, taskId: assignment.rootId, runId: receipt!.runId, action: COMPLETION_ACTION, outcome: receipt!.digest, source: "work",
        detail: `its options went to youiyoux, where ${words}` });
      const ref = store.lookupRef(assignment.rootId);
      if (ref !== null) store.noteTaskAct(ref.id, "completed", now, undefined, { account: LANDED_ACTOR, lead: false });
      store.bumpWake();
    }
    store.recordAction({ at, actor: YOUIYOUX_ACTOR, repo, taskId: assignment.rootId, runId: receipt?.runId ?? null, action: OPTIONS_DECIDED_ACTION, outcome: decision.status, source: "work",
      detail: `${words}${decision.at === null ? "" : ` (${decision.at})`}; ${done}` });
    store.handle.prepare("UPDATE youiyoux_request SET decided = ?, decided_at = ?, decided_note = ? WHERE repo = ? AND request = ?").run(decision.status, at, note, repo, row.request);
    if (completes) noteAssignmentStatus(store, assignmentOf(store, assignment.rootId, now, { principal: "operator", repos: [repo] }, root)!, now);
    return true;
  });
}

/** Each options request's options, both ways: a Ready result's file to the hub, and a decision in the hub back. */
async function optionsPass(store: Store, repo: string, now: Date, io: YouiyouxIo, pass: YouiyouxPass): Promise<void> {
  const root = io.evidenceRoot ?? null;
  if (io.git === undefined || root === null) return;
  const bring = store.handle.prepare(`SELECT request, task_id, proposal, proposal_state, proposal_run, proposal_digest FROM youiyoux_request WHERE repo = ? AND kind = 'options' AND task_id IS NOT NULL
    AND (proposal_state IS NULL OR proposal_state NOT IN ('copied','taken')) AND status IN ('ready','done') ORDER BY status_at LIMIT ?`).all(repo, OPTIONS_PER_PASS).map(optionsRow);
  for (const row of bring) {
    try {
      const result = resultOf(store, row.taskId, repo, now, root);
      if (result === null) continue;
      // Said once for each result: a newer one (a revision, a build again) is read again.
      if ((row.state === "missing" || row.state === "unsafe") && row.run === result.receipt.runId) continue;
      const brought = await bringProposal(io.git, repo, row.request, row.proposal, result.head);
      const at = now.toISOString();
      store.transact(() => {
        store.handle.prepare("UPDATE youiyoux_request SET proposal_state = ?, proposal_run = ?, proposal_note = ?, proposal_at = ?, proposal_digest = ? WHERE repo = ? AND request = ?")
          .run(brought.state, result.receipt.runId, brought.note, at, brought.digest ?? null, repo, row.request);
        if (brought.state !== "retry") store.recordAction({ at, actor: YOUIYOUX_ACTOR, repo, taskId: result.assignment.rootId, runId: result.receipt.runId, action: OPTIONS_COPIED_ACTION,
          outcome: brought.state === "copied" ? "copied" : brought.state === "taken" ? "left as it was" : "not copied", source: "work",
          detail: `${proposalFileOf(row.proposal)}${brought.state === "missing" ? ": not in the result" : brought.note === null ? "" : `: ${brought.note}`}` });
      });
      if (brought.state === "copied") pass.copied++;
      if (brought.state === "retry") pass.problems.push(`youiyoux ${row.request}: ${brought.note}`);
      if (writeStatus(store, repo, row.request, row.taskId, now, io, true)) pass.updated++;
    } catch (error) { pass.problems.push(`youiyoux ${row.request}: ${error instanceof Error ? error.message : "options unreadable"}`); }
  }
  // Only Toolroll's own copies: a file that was already there (`taken`) is never read for a decision.
  const watch = store.handle.prepare(`SELECT request, task_id, proposal, proposal_state, proposal_run, proposal_digest FROM youiyoux_request WHERE repo = ? AND kind = 'options' AND task_id IS NOT NULL
    AND proposal_state = 'copied' AND proposal_digest IS NOT NULL AND decided IS NULL ORDER BY proposal_at LIMIT ?`).all(repo, OPTIONS_PER_PASS).map(optionsRow);
  for (const row of watch) {
    try {
      const decision = decisionOf(repo, row.proposal, row.request, row.digest!);
      if (decision === null || !actOnDecision(store, repo, row, decision, now, root)) continue;
      pass.decided++;
      if (writeStatus(store, repo, row.request, row.taskId, now, io, true)) pass.updated++;
    } catch (error) { pass.problems.push(`youiyoux ${row.request}: ${error instanceof Error ? error.message : "decision unreadable"}`); }
  }
}
