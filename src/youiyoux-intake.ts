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
 * the status changes, and once more when that address changes. That is the only file it writes in the checkout: written whole (a temporary
 * file in the same folder, then renamed over), refused when the folder or the target is a link, never the request
 * itself. The status is also kept in the store; nothing Toolroll decides reads the file back.
 *
 * Status words (task-status.ts headline → youiyoux): Queued → queued; Planning, Building and Waiting (work going on
 * by itself) → building; Needs you → needs-you; Ready for review → ready; Complete → done; Failed → failed;
 * Stopped → stopped.
 *
 * An options request (`kind: "options"`) asks an agent for two to four options for one component, which youiyoux shows
 * on its Screens canvas. It is filed the same way, once, waiting for a person, and only as youiyoux's contract has it:
 * its offer names `p-<its own hex>`, that proposal's file `.youi/proposals/p-<hex>.json`, and the task may touch that
 * one file (anything else is counted as a file that couldn't be read, and never filed). The proposal it names is kept
 * when filed; the request is never read for it again.
 */

import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readdirSync, readSync, realpathSync, renameSync, unlinkSync, writeSync, type Stats } from "node:fs";
import { join } from "node:path";
import type { Store } from "./store.js";
import { fileTaskProposal } from "./proposal.js";
import { canonicalProject } from "./project.js";
import { scanForSecrets } from "./evidence.js";
import { hasDisguisedText } from "./decision.js";
import { storedTaskStatus } from "./flow-card-task.js";
import { loadConsoleUrl, localConsoleUrl } from "./webhooks.js";
import type { Headline } from "./task-status.js";
import { optionsProblem, proposalIdOf, readYouiyouxRequest, readYouiyouxRequestTask, YOUIYOUX_CARD_KIND, YOUIYOUX_FILED_VIA, YOUIYOUX_HOME_PATH,
  type YouiyouxRequest, type YouiyouxRequestTask, type YouiyouxTaskStatus } from "./contracts/youiyoux-request.js";

export { YOUIYOUX_FILED_VIA };
/** Who files the tasks: an automation, like a flow trigger. */
export const YOUIYOUX_ACTOR = "youiyoux";
export const REQUEST_BYTES = 64 * 1024;
export const REQUESTS_PER_PASS = 200;
export const FILED_PER_PASS = 10;
const STATUS_PER_PASS = 50;
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

/** The requests folder of a recorded project, checked now: null when there is none. Links are refused, never followed. */
function requestsFolder(repo: string): Folder {
  let root: string;
  try { root = realpathSync(repo); } catch { return { ok: false, problem: "The project folder can't be read." }; }
  if (root !== repo) return { ok: false, problem: "The project folder moved or is a link, so its requests aren't read." };
  let dir = root;
  for (const part of [".youi", "requests"]) {
    dir = join(dir, part);
    let stats: Stats;
    try { stats = lstatSync(dir); } catch (error) { return isMissing(error) ? null : { ok: false, problem: `${part} can't be read.` }; }
    if (stats.isSymbolicLink()) return { ok: false, problem: `${dir.slice(root.length + 1)} is a link, so its requests aren't read. Make it a real folder.` };
    if (!stats.isDirectory()) return { ok: false, problem: `${dir.slice(root.length + 1)} isn't a folder.` };
  }
  try { if (realpathSync(dir) !== dir) return { ok: false, problem: ".youi/requests resolves outside the project." }; } catch { return { ok: false, problem: ".youi/requests can't be read." }; }
  return { ok: true, dir };
}

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

function statusOf(store: Store, taskId: string, repo: string, now: Date): { status: YouiyouxTaskStatus; detail: string } | null {
  const read = storedTaskStatus(store, taskId, repo, now);
  return read === null ? null : { status: STATUS_OF_HEADLINE[read.status.headline], detail: read.status.headline };
}

/** Write a filed task's status where it changed, where its last write failed, or where the console its links name
 * changed since (`written_base`: '' for none), so a file written before a console address existed gets its links. */
function writeStatus(store: Store, repo: string, request: string, taskId: string, now: Date, io: YouiyouxIo, force: boolean): boolean {
  const known = store.handle.prepare("SELECT status, written_at, written_base FROM youiyoux_request WHERE repo = ? AND request = ?").get(repo, request);
  const status = statusOf(store, taskId, repo, now);
  if (status === null) return false;
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

export type YouiyouxIo = { dir: string | null; env: Record<string, string | undefined> };
export type YouiyouxPass = { filed: number; skipped: number; invalid: number; updated: number; problems: string[] };
const NOTHING = (): YouiyouxPass => ({ filed: 0, skipped: 0, invalid: 0, updated: 0, problems: [] });

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
 * One project's pass: read new change requests and file them, then write each filed task's status where it changed.
 * The folder read is the project in Toolroll's records that `given` resolves to; anything else is left alone.
 */
export function runYouiyouxIntake(store: Store, given: string, now: Date, io: YouiyouxIo, options: { force?: boolean } = {}): YouiyouxPass {
  const pass = NOTHING();
  // The project as Toolroll recorded it, resolved: a folder that isn't one of its projects is never read.
  const repo = canonicalProject(given);
  if (repo === null || !store.listProjects().some(one => one.path === repo)) return pass;
  const row = intakeRow(store, repo);
  if (row.enabled === false) return pass;
  if (options.force !== true && row.checkedAt !== null && now.getTime() - Date.parse(row.checkedAt) < INTAKE_EVERY_MS) return pass;
  if (!usesYouiyoux(repo)) { if (row.uses) recordPass(store, repo, now, false, 0, null); return pass; }
  const folder = requestsFolder(repo);
  if (folder === null) { recordPass(store, repo, now, true, 0, null); return pass; }
  if (!folder.ok) { recordPass(store, repo, now, true, 0, folder.problem); pass.problems.push(`youiyoux: ${folder.problem}`); return pass; }

  const taken = new Set(store.handle.prepare("SELECT request FROM youiyoux_request WHERE repo = ?").all(repo).map(one => String(one["request"])));
  let read: Read;
  try { read = readRequests(folder.dir, taken); } catch {
    recordPass(store, repo, now, true, 0, ".youi/requests can't be read.");
    pass.problems.push("youiyoux: .youi/requests can't be read.");
    return pass;
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
  return pass;
}
