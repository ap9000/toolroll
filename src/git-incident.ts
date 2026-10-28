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
