/**
 * A git incident: the plane's own git wrote through a view of a repository (teardown-git.ts gitView) while a folder of
 * that repository the view links to was swapped for a link elsewhere, or its git pointers changed (the residual the
 * view can't prevent: git takes paths, and a build that outlived its turn can still rename a folder of the shared
 * `.git` mid-command). Seen after git ran, it is:
 *
 * - recorded, one JSON line in `~/.toolroll/git-incidents.jsonl` (beside the fenced views folder, git-views.ts);
 * - told to every listener (the console's, when it registers one; otherwise the plane's stderr);
 * - and the command is reported refused, so no caller takes its result as done.
 *
 * Nothing is rolled back automatically: where a swapped folder leads is the agent's choice, and the plane never runs
 * git there on its say (a confused deputy); what git wrote is for a person, named in the record.
 */
import { appendFileSync, realpathSync } from "node:fs";
import { basename, dirname } from "node:path";

export type GitIncident = {
  at: string;
  checkout: string;
  repository: string;
  /** Folders of the repository found swapped, and where each now leads (null: its pointers changed instead). */
  swapped: { path: string; leadsTo: string | null }[];
};

type Listener = (incident: GitIncident) => void;
const listeners = new Set<Listener>();

/** Hear about every git incident (returns the unsubscribe). With none registered, incidents go to stderr. */
export function onGitIncident(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Record and tell one incident. */
export function gitIncident(input: { checkout: string; repository: string; swapped: GitIncident["swapped"]; record: string }): GitIncident {
  const incident: GitIncident = { at: new Date().toISOString(), checkout: input.checkout, repository: input.repository, swapped: input.swapped };
  try { appendFileSync(input.record, `${JSON.stringify(incident)}\n`, { mode: 0o600 }); } catch { /* still told */ }
  if (listeners.size === 0) process.stderr.write(`Toolroll git incident: ${JSON.stringify(incident)}\n`);
  for (const listener of listeners) { try { listener(incident); } catch { /* every listener hears it */ } }
  return incident;
}

/** What noticeGitIncidents needs of the store: its durable outbox, and its own project records. */
export type IncidentOutbox = {
  enqueueNotification(notification: { dedupeKey: string; kind: string; subject: string; body: string; pushClass?: "attention"; source?: { project: string } | { installation: true } }, now: Date): boolean;
  listProjects(): { path: string; name: string }[];
};
const noticed = new WeakSet<object>();

/**
 * Every git incident from now on raises an attention notification in `outbox` (the console and the background worker
 * register their store as they start; once per store): "Git incident in <project>: a folder of its repository changed
 * while Toolroll's git ran". Nothing the agent chose reaches the text (paths in an agent-written repository can carry
 * newlines and words of its own): the project is named only by the plane's own record of it (matched by real path,
 * else "a project"), and the person is pointed to the incident record file, where the paths are. Returns the
 * unsubscribe.
 */
export function noticeGitIncidents(outbox: IncidentOutbox, now: () => Date = () => new Date(), record = "~/.toolroll/git-incidents.jsonl"): () => void {
  if (noticed.has(outbox)) return () => {};
  noticed.add(outbox);
  const stop = onGitIncident(incident => {
    const main = basename(incident.repository) === ".git" ? dirname(incident.repository) : incident.repository;
    const real = (path: string): string | null => { try { return realpathSync(path); } catch { return null; } };
    const known = outbox.listProjects().find(project => real(project.path) !== null && real(project.path) === real(main)) ?? null;
    outbox.enqueueNotification({
      dedupeKey: `git-incident:${incident.at}:${known?.path ?? "unrecorded"}`, kind: "git-incident", pushClass: "attention",
      source: known === null ? { installation: true } : { project: known.path },
      subject: `Git incident in ${known === null ? "a project" : known.name}: a folder of its repository changed while Toolroll's git ran`,
      body: `Toolroll stopped trusting that git command and changed nothing more. Nothing was rolled back: check the repository by hand. The checkout and the folders that changed are in ${record}.`,
    }, now());
  });
  return () => { stop(); noticed.delete(outbox); };
}
