/**
 * Put away old tasks (docs/plans/task-tidy.md). Tidy finds tasks nobody needs to see any more, says why for each, and
 * puts them away (v144 `task_archive`): old routine runs a newer run replaces, release tasks for versions already
 * published or replaced, and "Checks failed" notices main has since fixed. A person can also put away finished tasks
 * older than N days from the same preview. Deterministic and explainable: the same records give the same list, every
 * item carries its rule and one plain reason, and the preview's digest binds exactly what a person saw.
 *
 * Never touched: a task with a live attempt, a task asked of a named person (`task ask`), a task with feedback or a
 * steering note still pending, a task already Complete, and (automatically) a task a person filed or restored.
 */
import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync, constants } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { archiveTaskFamily, type Store } from "./store.js";
import { workTidyRows, type WorkTidyRow } from "./work-index.js";
import type { WorkSummaryAccess } from "./work-summary.js";

export type TidyRule = "release" | "routine" | "ci" | "finished";
/** The preview's groups, in order. "finished" is a person's own choice only; tidy never applies it on its own. */
export const TIDY_GROUPS: readonly { rule: TidyRule; label: string }[] = [
  { rule: "release", label: "Old releases" },
  { rule: "routine", label: "Old routine runs" },
  { rule: "ci", label: "Resolved CI notices" },
  { rule: "finished", label: "Finished more than {days} days ago" },
];
export const TIDY_DEFAULT_DAYS = 14;
/** At most this many tasks are put away automatically per pass. */
export const TIDY_PASS_LIMIT = 25;

/** One task tidy would put away: its family's current task, every version that goes with it (`members`, task_ref ids),
 * why, and under which rule. */
export type TidyItem = { rule: TidyRule; taskId: string; title: string; repo: string | null; reason: string; updatedAt: string; members: number[] };

/** What the release journals say about one release task (release.ts writes them; read only). */
export type ReleaseFact = { taskId: string; version: string; product: string; candidate: string; superseded: boolean; done: boolean; published: boolean; stopped: boolean };
/** Every release journal's facts, or why they can't be trusted: one unreadable journal leaves the release rule out. */
export type ReleaseFacts = { facts: ReleaseFact[]; problem: string | null };

const MAX_JOURNALS = 2000;
const MAX_JOURNAL_BYTES = 1 << 20;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,64})?$/;

/** Reads `releases/*.json` under the plane's state folder (the database's folder), written only by `toolroll release`.
 * A symlink, a non-file, an oversized or unreadable journal makes the whole answer untrusted (`problem`), so the
 * release rule then puts nothing away: a journal it can't read might be the one that says a release is in flight. */
export function readReleaseFacts(stateDir: string): ReleaseFacts {
  const dir = join(stateDir, "releases");
  let names: string[];
  try {
    const st = lstatSync(dir);
    if (!st.isDirectory()) return { facts: [], problem: `${dir} isn't a folder` };
    names = readdirSync(dir).filter(name => name.endsWith(".json")).sort();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { facts: [], problem: null } : { facts: [], problem: `${dir} can't be read` };
  }
  if (names.length > MAX_JOURNALS) return { facts: [], problem: `more than ${MAX_JOURNALS} release journals` };
  const facts: ReleaseFact[] = [];
  for (const name of names) {
    const file = join(dir, name);
    const read = readJournalFile(file);
    if (read === null) return { facts: [], problem: `${file} can't be read` };
    const journal = read as Record<string, unknown>;
    const task = journal["task"] as Record<string, unknown> | null | undefined;
    const taskId = typeof task?.["id"] === "string" ? task["id"] : null;
    const version = typeof journal["packageVersion"] === "string" ? journal["packageVersion"] : null;
    if (journal["version"] !== 1 || typeof journal["step"] !== "string" || taskId === null || !TASK_ID.test(taskId) || version === null || !VERSION.test(version)) {
      return { facts: [], problem: `${file} isn't a release journal this version reads` };
    }
    const published = journal["published"];
    const candidate = (journal["candidate"] as Record<string, unknown> | null | undefined)?.["sha"];
    const product = `${typeof journal["github"] === "string" ? journal["github"].toLowerCase() : ""}\u0000${typeof journal["packageName"] === "string" ? journal["packageName"] : ""}`;
    if (typeof candidate !== "string" || !/^[0-9a-f]{40}$/.test(candidate)) return { facts: [], problem: `${file} has no candidate commit` };
    facts.push({ taskId, version, product, candidate, superseded: /\.superseded-[^/]*\.json$/.test(name), done: journal["step"] === "done",
      published: published !== null && typeof published === "object", stopped: journal["stopped"] !== null && journal["stopped"] !== undefined });
  }
  return { facts, problem: null };
}

/** The release journals beside this database (its folder is the plane's state folder). An in-memory or relative
 * database has no state folder, so the release rule stays off rather than reading whatever folder it runs in. */
export function releaseFactsFor(databaseFile: string): ReleaseFacts {
  return isAbsolute(databaseFile) ? readReleaseFacts(dirname(databaseFile)) : { facts: [], problem: "this database has no state folder" };
}

/** One journal's JSON, never through a symlink, bounded; null when it can't be read. */
function readJournalFile(file: string): unknown {
  let fd: number | null = null;
  try {
    const st = lstatSync(file);
    if (!st.isFile() || st.size > MAX_JOURNAL_BYTES) return null;
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const size = fstatSync(fd).size;
    if (size > MAX_JOURNAL_BYTES) return null;
    const buffer = Buffer.alloc(size);
    let at = 0;
    while (at < size) { const got = readSync(fd, buffer, at, size - at, at); if (got <= 0) break; at += got; }
    return JSON.parse(buffer.subarray(0, at).toString("utf8")) as unknown;
  } catch { return null; } finally { if (fd !== null) closeSync(fd); }
}

/** A journal's task is the release task Toolroll filed for it: its id is the gate id for that version and commit
 * (release.ts gateTaskId, maybe with a fresh-approval suffix), the task exists, and its scope's candidate, when it has
 * one, is the journal's commit. */
function releaseTaskMatches(store: Store, fact: ReleaseFact): boolean {
  const base = `release-${fact.version.replace(/[^0-9A-Za-z.-]/g, "-")}-${fact.candidate.slice(0, 7)}`;
  if (fact.taskId !== base && !(fact.taskId.startsWith(`${base}-`) && /^\d{1,3}$/.test(fact.taskId.slice(base.length + 1)))) return false;
  const row = store.handle.prepare(`SELECT s.candidate FROM task t JOIN task_ref r ON r.backend = 'built-in' AND r.external_id = t.id
    LEFT JOIN task_scope s ON s.task_id = t.id WHERE t.id = ?`).get(fact.taskId);
  return row !== undefined && (row["candidate"] == null || row["candidate"] === fact.candidate);
}

/** -1, 0 or 1: numeric parts first, then a release above any of its pre-releases. */
export function compareVersions(a: string, b: string): number {
  const [ma, pa = ""] = a.split("-", 2) as [string, string?];
  const [mb, pb = ""] = b.split("-", 2) as [string, string?];
  const na = ma.split(".").map(Number), nb = mb.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((na[i] ?? 0) !== (nb[i] ?? 0)) return (na[i] ?? 0) < (nb[i] ?? 0) ? -1 : 1;
  if (pa === pb) return 0;
  if (pa === "") return 1;
  if (pb === "") return -1;
  return pa < pb ? -1 : 1;
}

type Exclusions = { asked: Set<number>; feedback: Set<number>; proposals: Set<string>; restored: Set<string> };

/** Everything that keeps a task out of tidy, read once. */
function exclusionsOf(store: Store): Exclusions {
  const refs = (sql: string) => new Set(store.handle.prepare(sql).all().map(row => Number(row["ref"])));
  const ids = (sql: string) => new Set(store.handle.prepare(sql).all().map(row => String(row["id"])));
  return {
    asked: refs("SELECT DISTINCT task_ref ref FROM task_act WHERE act = 'asked'"),
    feedback: refs(`SELECT r.task_ref ref FROM diff_comment d JOIN run r ON r.id = d.run WHERE d.superseded_by IS NULL AND d.consumed_by IS NULL AND d.reviewer_run IS NULL
      UNION SELECT task_ref ref FROM task_steer WHERE delivered_at IS NULL AND superseded_at IS NULL
      UNION SELECT r.task_ref ref FROM review_request q JOIN run r ON r.id = q.run WHERE q.consumed_at IS NULL`),
    proposals: ids(`SELECT DISTINCT json_extract(payload_json, '$.task') id FROM lead_proposal
      WHERE state IN ('drafting','pending','confirming') AND json_valid(payload_json) AND json_type(payload_json, '$.task') = 'text'`),
    restored: ids("SELECT DISTINCT task_id id FROM action_ledger WHERE action = 'task restored' AND task_id IS NOT NULL"),
  };
}

/** Why this family is never put away by tidy, or null. `auto`: tidy on its own (a restored family stays). */
function excluded(row: WorkTidyRow, ex: Exclusions, auto: boolean): boolean {
  if (row.archived || row.live || row.broken || row.code === "complete") return true;
  if (row.members.some(ref => ex.asked.has(ref) || ex.feedback.has(ref))) return true;
  if (row.memberIds.some(id => ex.proposals.has(id))) return true;
  return auto && row.memberIds.some(id => ex.restored.has(id));
}

type Firing = { family: string; tasks: string[]; all: string[]; title: string };

/** Labels an automation's card files under (flow-triggers.ts makeCard), from before cards kept their kind (v126). */
const AUTOMATION_FILERS = new Set(["Schedule", "Plane review", "GitHub"]);

/** Whether this task was filed by the trigger's own automation, proven from Toolroll's records: a standing order's
 * firing names its task once and forever (`flow_trigger_event.task`); otherwise the flow engine filed it for this very
 * flow (`filed_via`), as the automation the card was made by (its kind, or an automation's label from before kinds).
 * Unknown provenance is never automation. */
function automationFiled(store: Store, taskId: string, flow: number, card: { createdBy: string | null; createdKind: string | null }, eventTask: string | null): boolean {
  if (eventTask === taskId) return true;
  const row = store.handle.prepare("SELECT filed_via, filed_by, filed_by_kind FROM task_ref WHERE backend = 'built-in' AND external_id = ?").get(taskId);
  if (row === undefined || row["filed_via"] !== `flow:${flow}`) return false;
  if (row["filed_by_kind"] === "automation") return card.createdKind === "automation" || card.createdKind === null;
  return card.createdKind === null && row["filed_by_kind"] === "person" && typeof row["filed_by"] === "string" && row["filed_by"] === card.createdBy && AUTOMATION_FILERS.has(row["filed_by"]);
}

/** (a) Every schedule's own clock firings (a slot, a scripted slot, or a plane review's scheduled daily problem; never a
 * person's Run now, never a skipped or held firing), each with the automation-filed tasks it made, grouped by trigger (a
 * plane review: by trigger and problem). */
function routineFirings(store: Store): Map<string, Firing[]> {
  const rows = store.handle.prepare(`SELECT e.trigger, e.key, e.at, e.on_time, e.state, e.task event_task, c.task card_task, c.primary_task, c.title,
      c.created_by, c.created_kind, t.flow
    FROM flow_trigger_event e JOIN flow_trigger t ON t.id = e.trigger LEFT JOIN flow_card c ON c.id = e.card
    WHERE t.kind = 'schedule' AND (e.card IS NOT NULL OR e.task IS NOT NULL) AND (e.state IS NULL OR e.state = 'accepted')
    ORDER BY e.trigger, e.at, e.rowid`).all();
  const families = new Map<string, Firing[]>();
  for (const row of rows) {
    const key = String(row["key"]);
    if (row["created_kind"] === "person") continue;
    const plane = /^plane:(.+):\d{4}-\d{2}-\d{2}$/.exec(key);
    // A plane review's key is the same for Run now; only the clock's own firing (on_time) is a routine run.
    if (!/^(?:script:)?slot:/.test(key) && !(plane !== null && Number(row["on_time"]) === 1)) continue;
    const family = `${Number(row["trigger"])}:${plane === null ? "" : plane[1]}`;
    const eventTask = typeof row["event_task"] === "string" ? row["event_task"] : null;
    const card = { createdBy: row["created_by"] == null ? null : String(row["created_by"]), createdKind: row["created_kind"] == null ? null : String(row["created_kind"]) };
    const all = [...new Set([row["event_task"], row["card_task"], row["primary_task"]].filter((one): one is string => typeof one === "string" && one !== ""))];
    const tasks = all.filter(task => automationFiled(store, task, Number(row["flow"]), card, eventTask));
    const list = families.get(family) ?? [];
    // Every firing counts toward which is newest, even one whose tasks can't be proven: its tasks are kept, never taken.
    list.push({ family, tasks, all, title: String(row["title"] ?? eventTask ?? "the newest run") });
    families.set(family, list);
  }
  return families;
}

type Notice = { trigger: number; workflow: string; sha: string; at: string; tasks: string[]; repo: string; branch: string };

/** (c) Every "Checks failed on <branch>: <workflow>" notice a checks trigger made, with its commit, its workflow and the
 * automation-filed tasks it made. */
function ciNotices(store: Store): Notice[] {
  const rows = store.handle.prepare(`SELECT e.trigger, e.key, e.at, c.title, c.task, c.primary_task, c.created_by, c.created_kind, c.source_json, t.config_json, t.flow
    FROM flow_trigger_event e JOIN flow_trigger t ON t.id = e.trigger JOIN flow_card c ON c.id = e.card
    WHERE t.kind = 'github' AND e.key LIKE 'checks:%' AND (e.state IS NULL OR e.state = 'accepted') ORDER BY e.trigger, e.at, e.rowid`).all();
  const notices: Notice[] = [];
  for (const row of rows) {
    if (row["created_kind"] === "person") continue;
    let config: Record<string, unknown>;
    try { config = JSON.parse(String(row["config_json"])) as Record<string, unknown>; } catch { continue; }
    if (config["watch"] !== "checks" || typeof config["repo"] !== "string" || typeof config["branch"] !== "string") continue;
    // Where the failure was, as the card recorded it when it was made (GitHub's own run link, never rewritten), not
    // where the trigger points now: a trigger re-pointed later never lends its new repository's runs to old notices.
    let made: { url?: unknown } | null = null;
    try { made = JSON.parse(String(row["source_json"] ?? "null")) as { url?: unknown } | null; } catch { made = null; }
    const at = typeof made?.url === "string" ? /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/actions\/runs\/\d+(?:\/|$)/.exec(made.url) : null;
    if (at === null || at[1]!.toLowerCase() !== config["repo"].toLowerCase()) continue;
    const branch = config["branch"], prefix = `Checks failed on ${branch}: `, title = String(row["title"] ?? "");
    const sha = String(row["key"]).slice("checks:".length);
    if (!title.startsWith(prefix) || !/^[0-9a-f]{40}$/.test(sha)) continue;
    const card = { createdBy: row["created_by"] == null ? null : String(row["created_by"]), createdKind: row["created_kind"] == null ? null : String(row["created_kind"]) };
    const tasks = [...new Set([row["task"], row["primary_task"]].filter((one): one is string => typeof one === "string" && one !== ""))]
      .filter(task => automationFiled(store, task, Number(row["flow"]), card, null));
    notices.push({ trigger: Number(row["trigger"]), workflow: title.slice(prefix.length), sha, at: String(row["at"]), tasks, repo: config["repo"], branch });
  }
  return notices;
}

type Observation = { workflow: string; sha: string; conclusion: "success" | "failure"; createdAt: string };

/** Every completed run the checks trigger saw on this repository's branch, oldest first. */
function observationsOf(store: Store, repo: string, branch: string): Observation[] {
  return store.handle.prepare(`SELECT workflow, head_sha, conclusion, run_created_at FROM branch_check_run
    WHERE lower(repo) = lower(?) AND branch = ? ORDER BY run_created_at, run_id`).all(repo, branch)
    .map(row => ({ workflow: String(row["workflow"]), sha: String(row["head_sha"]), conclusion: row["conclusion"] === "success" ? "success" as const : "failure" as const, createdAt: String(row["run_created_at"]) }));
}

/** A completed workflow run on the watched branch, as the checks trigger read it from GitHub (its poll through the
 * person's own gh login, or its signed webhook): kept once per run. Only a push to the watched branch of the watched
 * repository counts (a pull request from a fork whose branch is also called main does not). */
export function recordBranchCheckRun(store: Store, watched: { repo: string; branch: string }, run: { id?: number | undefined; name?: string | undefined; head_sha?: string | undefined;
  head_branch?: string | undefined; conclusion?: string | undefined; created_at?: string | undefined; event?: string | undefined; head_repository?: { full_name?: string | undefined } | undefined }, now: Date): boolean {
  const workflow = run.name ?? "", sha = run.head_sha ?? "", created = Date.parse(run.created_at ?? "");
  if (run.id === undefined || !Number.isSafeInteger(run.id) || run.id <= 0 || workflow === "" || workflow.length > 200 || !/^[0-9a-f]{40}$/.test(sha) || Number.isNaN(created)) return false;
  if (run.conclusion !== "success" && run.conclusion !== "failure") return false;
  if (run.event !== "push" || run.head_branch !== watched.branch || (run.head_repository?.full_name ?? "").toLowerCase() !== watched.repo.toLowerCase()) return false;
  const changed = store.handle.prepare(`INSERT OR IGNORE INTO branch_check_run (repo, run_id, branch, workflow, head_sha, conclusion, run_created_at, observed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(watched.repo, run.id, watched.branch, workflow, sha, run.conclusion, new Date(created).toISOString(), now.toISOString());
  return Number(changed.changes) > 0;
}

/** What tidy would put away now, in group order, oldest first within a group. `days`: also offer finished tasks
 * untouched that long (a person's preview only); null is tidy's own automatic rules. `access`: whose lists. */
export function tidyPreview(store: Store, now: Date, input: { releases: ReleaseFacts; days: number | null; access?: WorkSummaryAccess }): TidyItem[] {
  const auto = input.days === null;
  const rows = workTidyRows(store, now, input.access ?? { principal: "operator", repos: null, includeUnplaced: true });
  const byId = new Map<string, WorkTidyRow>();
  for (const row of rows) for (const id of row.memberIds) byId.set(id, row);
  const ex = exclusionsOf(store);
  const taken = new Map<string, TidyItem>();
  // Every task each schedule's newest firing touched, whoever filed it: no family holding one is ever put away.
  const firings = routineFirings(store);
  const keepAll = new Set([...firings.values()].flatMap(list => list.at(-1)!.all));
  // `proven`: for a rule's own producer, every version of the family must be one it can prove it made (a person's
  // later revision of a scheduled run keeps the whole family out); null for a person's own choice (finished tasks).
  const offer = (row: WorkTidyRow | undefined, rule: TidyRule, reason: string, proven: ReadonlySet<string> | null) => {
    if (row === undefined || taken.has(row.rootId) || excluded(row, ex, auto)) return;
    if (proven !== null && !row.memberIds.every(id => proven.has(id))) return;
    if (rule !== "release" && row.memberIds.some(id => keepAll.has(id))) return;
    taken.set(row.rootId, { rule, taskId: row.currentId, title: row.title, repo: row.repo, reason, updatedAt: row.updatedAt, members: [...row.members].sort((a, b) => a - b) });
  };

  // (b) Old releases: only when every journal reads, and only a task whose journals agree with its own records.
  if (input.releases.problem === null) {
    const facts = input.releases.facts.filter(one => releaseTaskMatches(store, one));
    // The newest published version of each package (its GitHub repository and npm name).
    const latestOf = new Map<string, string>();
    for (const one of facts) if (one.published && (latestOf.get(one.product) === undefined || compareVersions(one.version, latestOf.get(one.product)!) > 0)) latestOf.set(one.product, one.version);
    const byTask = new Map<string, ReleaseFact[]>();
    for (const fact of input.releases.facts) byTask.set(fact.taskId, [...(byTask.get(fact.taskId) ?? []), fact]);
    const journalNamed = new Set(byTask.keys());
    for (const [taskId, named] of byTask) {
      // Every journal naming it must check out, for one package and one version.
      if (named.some(one => !facts.includes(one)) || new Set(named.map(one => `${one.product}\u0000${one.version}`)).size !== 1) continue;
      const current = named.filter(one => !one.superseded);
      // In flight: its current journal is neither done nor stopped (running, or waiting for an approval).
      if (current.some(one => !one.done && !one.stopped)) continue;
      const version = named[0]!.version, latest = latestOf.get(named[0]!.product) ?? null;
      const reason = named.some(one => one.published) ? `Release ${version} is published.`
        : current.length === 0 ? `A newer attempt of release ${version} replaced it.`
        : latest !== null && compareVersions(version, latest) < 0 ? `Release ${latest} is already published.` : null;
      if (reason !== null) offer(byId.get(taskId), "release", reason, journalNamed);
    }
  }

  // (a) Old routine runs: everything but each schedule's newest firing.
  const routineMade = new Set([...firings.values()].flatMap(list => list.flatMap(one => one.tasks)));
  for (const list of firings.values()) {
    const newest = list.at(-1)!;
    for (const firing of list.slice(0, -1)) {
      for (const task of firing.tasks) offer(byId.get(task), "routine", `A newer run, “${newest.title}”, replaces it.`, routineMade);
    }
  }

  // (c) Resolved CI notices: every workflow that failed on its commit was fixed by a later commit's green run, or a
  // newer notice carries that workflow's failure while the branch stays red.
  const notices = ciNotices(store);
  const ciMade = new Set(notices.flatMap(one => one.tasks));
  const seen = new Map<string, Observation[]>();
  for (const notice of notices) {
    const key = `${notice.repo.toLowerCase()}\u0000${notice.branch}`;
    const observed = seen.get(key) ?? observationsOf(store, notice.repo, notice.branch);
    seen.set(key, observed);
    // What failed on its commit: the workflow it names, and any other the trigger saw fail on that commit.
    const failed = new Map<string, string>([[notice.workflow, notice.at]]);
    for (const one of observed) if (one.sha === notice.sha && one.conclusion === "failure") failed.set(one.workflow, failed.has(one.workflow) && failed.get(one.workflow)! < one.createdAt ? failed.get(one.workflow)! : one.createdAt);
    const words: string[] = [];
    let settled = true;
    for (const [workflow, since] of failed) {
      const pass = observed.find(one => one.workflow === workflow && one.conclusion === "success" && one.sha !== notice.sha && one.createdAt > since);
      if (pass !== undefined) { words.push(`“${workflow}” passed on ${notice.branch} at ${pass.sha.slice(0, 7)}`); continue; }
      const newer = notices.find(other => other !== notice && other.trigger === notice.trigger && other.repo.toLowerCase() === notice.repo.toLowerCase() && other.branch === notice.branch
        && other.at > notice.at && other.sha !== notice.sha
        && (other.workflow === workflow || observed.some(one => one.sha === other.sha && one.workflow === workflow && one.conclusion === "failure")));
      if (newer !== undefined) { words.push(`a newer “${workflow}” failure on ${notice.branch} replaces it`); continue; }
      settled = false;
    }
    if (!settled) continue;
    const reason = `${words.join("; ")}.`.replace(/^./, first => first.toUpperCase());
    for (const task of notice.tasks) offer(byId.get(task), "ci", reason, ciMade);
  }

  // Finished more than N days ago (a person's preview only): done, failed or stopped, untouched since.
  if (input.days !== null) {
    const before = new Date(now.getTime() - input.days * 86_400_000).toISOString();
    for (const row of rows) {
      if ((row.state === "done" || row.state === "failed" || row.state === "cancelled") && row.updatedAt !== "" && row.updatedAt < before) {
        offer(row, "finished", `Finished ${row.updatedAt.slice(0, 10)}, untouched for more than ${input.days} days.`, null);
      }
    }
  }
  const order = (rule: TidyRule) => TIDY_GROUPS.findIndex(one => one.rule === rule);
  return [...taken.values()].sort((a, b) => order(a.rule) - order(b.rule) || a.updatedAt.localeCompare(b.updatedAt) || a.taskId.localeCompare(b.taskId));
}

/** The preview's identity: exactly which tasks under which rules, for how many days. A person's confirmation names it. */
export function tidyDigest(items: readonly TidyItem[], days: number | null): string {
  // Each family exactly: its task, every version that goes with it, its project, its rule and the reason shown.
  const set = items.map(one => [one.taskId, one.members.join(","), one.repo ?? "", one.rule, one.reason]).sort((a, b) => a[0]!.localeCompare(b[0]!));
  return createHash("sha256").update(JSON.stringify({ days, set }), "utf8").digest("hex").slice(0, 32);
}

/** The preview in its groups (empty ones left out), with each group's label. */
export function tidyGroups(items: readonly TidyItem[], days: number): { rule: TidyRule; label: string; items: TidyItem[] }[] {
  return TIDY_GROUPS.map(group => ({ rule: group.rule, label: group.label.replace("{days}", String(days)), items: items.filter(one => one.rule === group.rule) }))
    .filter(group => group.items.length > 0);
}

/** A day count from a person (1–365), or the default. */
export function tidyDays(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === "") return TIDY_DEFAULT_DAYS;
  if (!/^\d{1,3}$/.test(raw)) return null;
  const days = Number(raw);
  return days >= 1 && days <= 365 ? days : null;
}

export type TidyApply = { ok: true; archived: TidyItem[]; skipped: { taskId: string; message: string }[] }
  | { ok: false; reason: "changed" | "outside" | "empty"; message: string; items: TidyItem[]; digest: string };

/** A person puts away exactly what they previewed (or the ticked part of it), in one write transaction that recomputes
 * the preview and refuses when its digest moved or a ticked task isn't in it. */
export function applyTidy(store: Store, now: Date, input: { by: string; days: number; digest: string; only: readonly string[] | null; releases: ReleaseFacts; access?: WorkSummaryAccess }): TidyApply {
  return store.transact(() => {
    const items = tidyPreview(store, now, { releases: input.releases, days: input.days, ...(input.access === undefined ? {} : { access: input.access }) });
    const digest = tidyDigest(items, input.days);
    if (input.digest !== digest) return { ok: false as const, reason: "changed" as const, message: "The list changed since you looked. Check it again.", items, digest };
    const shown = new Map(items.map(one => [one.taskId, one]));
    const only = input.only === null ? null : [...new Set(input.only)];
    if (only !== null && only.some(id => !shown.has(id))) return { ok: false as const, reason: "outside" as const, message: "Only tasks in the list can be put away. Check it again.", items, digest };
    const targets = only === null ? items : only.map(id => shown.get(id)!);
    if (targets.length === 0) return { ok: false as const, reason: "empty" as const, message: "Nothing was chosen to put away.", items, digest };
    const archived: TidyItem[] = [], skipped: { taskId: string; message: string }[] = [];
    for (const item of targets) {
      const done = archiveTaskFamily(store, item.taskId, { by: input.by, byKind: "person", rule: item.rule, reason: item.reason }, now, { expect: item.members, guard: () => approverStandsNow(store, input.by, item.repo) });
      if (done.ok) archived.push(item); else skipped.push({ taskId: item.taskId, message: done.message });
    }
    return { ok: true as const, archived, skipped };
  });
}

/** Tidy on its own (the worker's reconcile pass): its automatic rules only, at most `limit` tasks, in one write
 * transaction. Idempotent: what is put away is skipped next time, and a restored task is never put away again. */
export function runTidy(store: Store, now: Date, releases: ReleaseFacts, limit = TIDY_PASS_LIMIT, access?: WorkSummaryAccess): TidyItem[] {
  return store.transact(() => {
    const archived: TidyItem[] = [];
    for (const item of tidyPreview(store, now, { releases, days: null, ...(access === undefined ? {} : { access }) }).slice(0, limit)) {
      const done = archiveTaskFamily(store, item.taskId, { by: "tidy", byKind: "tidy", rule: item.rule, reason: item.reason }, now, { expect: item.members });
      if (done.ok) archived.push(item);
    }
    return archived;
  });
}

/** Whether this person may still put away or restore work in this project, read under the write lock (check and write
 * together): an active approver who can see it. Null when they may; otherwise why not. */
export function approverStandsNow(store: Store, name: string, repo: string | null): string | null {
  const account = store.accountOf(name);
  if (account === null || account.revokedAt !== null || account.role !== "approver" || !store.accountCanAccess(name, repo)) return `${name} can't put away or restore tasks in this project.`;
  return null;
}

/** The repository of a task's family, from its first version (all versions share it). */
export function familyRepoOf(store: Store, refs: readonly number[]): string | null {
  return refs.length === 0 ? null : store.refById(refs[0]!)?.repo ?? null;
}

/** "Archived by tidy: <reason>" or "Archived by <person>: <reason>": the one sentence every surface shows. */
export function archivedWords(archived: { by: string; byKind: "person" | "tidy"; reason: string }): string {
  return `Archived by ${archived.byKind === "tidy" ? "tidy" : archived.by}: ${archived.reason}`;
}

/** The release journals beside the store's own database file (none for an in-memory one). */
export function releaseFactsOf(store: Store): ReleaseFacts {
  const file = store.databaseFile();
  return file === null ? { facts: [], problem: "this database has no state folder" } : releaseFactsFor(file);
}

/** The lists one person sees, for tidy: every project for an unrestricted account, otherwise exactly theirs. The CLI's
 * preview (`--as <name>`) and its apply read the same scope, so the same records give the same digest. */
export function accessOf(store: Store, name: string): WorkSummaryAccess {
  const account = store.accountOf(name);
  if (account === null || account.revokedAt !== null) return { principal: "operator", repos: [], includeUnplaced: false };
  return account.projects === null ? { principal: "operator", repos: null, includeUnplaced: true }
    : { principal: "operator", repos: [...account.projects], includeUnplaced: store.accountCanAccess(name, null) };
}

/** Narrows `access` to the caller's own lens (a remote person's project limit): never wider. No lens: unchanged. */
export function withinLens(access: WorkSummaryAccess, lens: readonly string[] | null): WorkSummaryAccess {
  if (lens === null || access.principal !== "operator") return access;
  const repos = access.repos === null ? [...lens] : access.repos.filter(repo => lens.includes(repo));
  return { ...access, repos, includeUnplaced: false };
}
