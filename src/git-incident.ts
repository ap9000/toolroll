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
import { appendFileSync } from "node:fs";
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

/** What noticeGitIncidents needs of the store: its durable outbox. */
export type IncidentOutbox = {
  enqueueNotification(notification: { dedupeKey: string; kind: string; subject: string; body: string; pushClass?: "attention"; source?: { project: string } }, now: Date): boolean;
};
const noticed = new WeakSet<object>();

/**
 * Every git incident from now on raises an attention notification in `outbox` (the console and the background worker
 * register their store as they start; once per store): "Git incident in <project>: a folder of its repository changed
 * while Toolroll's git ran", for a person to look at, with the folders found changed. Returns the unsubscribe.
 */
export function noticeGitIncidents(outbox: IncidentOutbox, now: () => Date = () => new Date()): () => void {
  if (noticed.has(outbox)) return () => {};
  noticed.add(outbox);
  const stop = onGitIncident(incident => {
    const project = basename(incident.repository) === ".git" ? dirname(incident.repository) : incident.repository;
    const where = incident.swapped.map(one => one.leadsTo === null ? one.path : `${one.path} → ${one.leadsTo}`).slice(0, 5).join("; ");
    outbox.enqueueNotification({
      dedupeKey: `git-incident:${incident.at}:${incident.checkout}`, kind: "git-incident", pushClass: "attention", source: { project },
      subject: `Git incident in ${basename(project)}: a folder of its repository changed while Toolroll's git ran`,
      body: `Toolroll stopped trusting that git command and changed nothing more. Checkout: ${incident.checkout}. Changed: ${where}. Nothing was rolled back: check the repository by hand.`,
    }, now());
  });
  return () => { stop(); noticed.delete(outbox); };
}
