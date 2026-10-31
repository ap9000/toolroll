/**
 * Project identities as the console uses them, without touching a person's folders on its thread.
 *
 * A project's identity is its real path (project.ts canonicalProject). Resolving one reads the folder, and a folder can
 * stop answering (folder-look.ts), so the console never resolves one on a page or at startup on its own thread, and
 * never waits for one before it answers:
 *
 * - `hot` (display and grouping only): the last answer, else the path as saved. Nothing is started by asking.
 * - `strict` (visibility and authorization): only a resolved identity; an unknown one fails closed until the next
 *   refresh resolves it, so a stored path that leads outside its root never passes on its spelling.
 * - `vouched` (a path a request names): only a path whose identity is known, or one that is exactly a saved identity.
 *   Anything else is refused this time and resolved by the next background pass, never resolved inline.
 * - `resolveNow` (an action that needs a path checked now, a POST): resolved off the thread under the look's deadline.
 * - `refresh` (the console's background pass, the first started right after it listens): resolves what was asked about
 *   and what has gone stale. The console answers before any of it does; until a path answers it fails closed.
 *
 * An embedder or test that passes no identities gets `syncProjectIdentities`: the old synchronous reads, unchanged.
 */

import { resolve } from "node:path";
import { lookIdentities, type FolderLookOptions } from "./folder-look.js";
import { canonicalProject } from "./project.js";

export type ProjectIdentities = {
  /** For display and grouping only: the last known identity, else the path as saved (resolved lexically). Reads
   * nothing. Never an authorization answer: use `strict`. */
  hot: (path: string) => string;
  /** For authorization: the known real folder path, else null (unknown or not a folder: fail closed until resolved).
   * Reads nothing; an unknown path is asked about on the next refresh. */
  strict: (path: string) => string | null;
  /** The known identity: a real folder path, null (not a folder), or undefined (never answered). Reads nothing. */
  known: (path: string) => string | null | undefined;
  /** A request's path: its known identity, or the path itself when it is exactly one of `saved` (projects the plane
   * itself proved and admitted); else undefined. */
  vouched: (path: string, saved: () => Iterable<string>) => string | undefined;
  /** This path's identity now, off the thread: a real folder path, null, or "no-answer" past the deadline. */
  resolveNow: (path: string) => Promise<string | null | "no-answer">;
  /** Resolve `paths`, everything asked about since, and answers older than a minute. False when some didn't answer. */
  refresh: (paths: Iterable<string>) => Promise<boolean>;
};

/** How long an answer stands before the background pass resolves the path again. */
const STALE_MS = 60_000;

/** How many folders a pass looks at side by side when they're looked at one by one (within FOLDER_LOOK_CHILDREN). */
export const IDENTITY_LOOKS = 4;

export function projectIdentities(look: FolderLookOptions = {}, now: () => number = Date.now): ProjectIdentities {
  const answers = new Map<string, { real: string | null; at: number }>();
  const wanted = new Set<string>();
  const known = (path: string): string | null | undefined => answers.get(resolve(path))?.real;
  const store = (found: Map<string, string | null>): void => {
    const at = now();
    for (const [path, real] of found) {
      answers.set(resolve(path), { real, at });
      wanted.delete(resolve(path));
      // A real path is its own identity.
      if (real !== null) answers.set(real, { real, at });
    }
  };
  const resolveNow = async (path: string): Promise<string | null | "no-answer"> => {
    const looked = await lookIdentities([resolve(path)], look);
    if (!looked.ok) return "no-answer";
    store(looked.value);
    return looked.value.get(resolve(path)) ?? null;
  };
  const refreshNow = async (paths: readonly string[]): Promise<boolean> => {
    const at = now();
    const due = new Set<string>(wanted);
    for (const one of paths) {
      const key = resolve(one);
      const answer = answers.get(key);
      if (answer === undefined || at - answer.at >= STALE_MS) due.add(key);
    }
    for (const [key, answer] of answers) if (at - answer.at >= STALE_MS) due.add(key);
    if (due.size === 0) return true;
    const batch = await lookIdentities([...due], look);
    if (batch.ok) { store(batch.value); return true; }
    // One folder that doesn't answer mustn't hold the others: each on its own, a few at a time (inside the looks'
    // child cap, leaving room for a person's actions), each under its deadline, each stored as soon as it answers.
    const queue = [...due];
    let missed = false;
    const worker = async (): Promise<void> => {
      for (let one = queue.shift(); one !== undefined; one = queue.shift()) if (await resolveNow(one) === "no-answer") missed = true;
    };
    await Promise.all(Array.from({ length: Math.min(IDENTITY_LOOKS, queue.length) }, worker));
    return !missed;
  };
  let passes: Promise<void> = Promise.resolve();
  return {
    hot: path => {
      const key = resolve(path);
      const answer = answers.get(key);
      if (answer === undefined) wanted.add(key);
      return answer?.real ?? key;
    },
    known,
    strict: path => {
      const key = resolve(path);
      const answer = answers.get(key);
      if (answer === undefined) wanted.add(key);
      return answer?.real ?? null;
    },
    vouched: (path, saved) => {
      const key = resolve(path);
      const answer = answers.get(key);
      if (answer !== undefined && answer.real !== null) return answer.real;
      for (const one of saved()) if (one === key) return key;
      wanted.add(key);
      return undefined;
    },
    resolveNow,
    refresh: paths => {
      // One pass at a time: a pass asked for while another runs waits for it, then resolves only what is still due.
      const asked = [...paths];
      const pass = passes.then(() => refreshNow(asked));
      passes = pass.then(() => undefined, () => undefined);
      return pass;
    },
  };
}

/** The synchronous reads, as before: for embedders and tests that pass no identities. */
export function syncProjectIdentities(): ProjectIdentities {
  return {
    hot: path => canonicalProject(path) ?? path,
    known: path => canonicalProject(path),
    strict: path => canonicalProject(path),
    vouched: path => canonicalProject(path) ?? undefined,
    resolveNow: async path => canonicalProject(path),
    refresh: async () => true,
  };
}
