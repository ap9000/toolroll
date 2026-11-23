/**
 * The repositories GET /engine/projects offers to add (pages.ts foundRepos): the folder picker's own look, kept a short
 * while so a client that polls its project list never starts a folder look per request. In memory only, never written.
 */

/** How long one complete look is reused. */
export const FOUND_REPOS_TTL_MS = 60_000;
/** At most this many found repositories are sent. */
export const FOUND_REPOS_MAX = 40;
/** At most this many folders are looked in at once (the picker's places and projects folders); folder-look.ts allows 8
 * look processes in all, so a look of these always leaves room for the picker's own. */
export const FOUND_PLACES_MAX = 6;

/** What a look found, and whether it may be reused (false when a folder didn't answer: the next read tries again). */
export type FoundLook = { repos: readonly string[]; complete: boolean };

/**
 * One cached look, keyed by what it looked at (the places and the folders it kept out): a look under way is shared by
 * every read that arrives meanwhile; a complete one is reused until it is `ttlMs` old; an incomplete one is never kept.
 */
export function foundReposCache(clock: () => Date, ttlMs = FOUND_REPOS_TTL_MS) {
  let kept: { key: string; at: number; repos: readonly string[] } | null = null;
  let running: { key: string; answer: Promise<readonly string[]> } | null = null;
  return (key: string, look: () => Promise<FoundLook>): Promise<readonly string[]> => {
    const now = clock().getTime();
    if (kept !== null && kept.key === key && now >= kept.at && now - kept.at < ttlMs) return Promise.resolve(kept.repos);
    if (running !== null && running.key === key) return running.answer;
    const answer = look().then(found => {
      if (found.complete) kept = { key, at: clock().getTime(), repos: [...found.repos] };
      return found.repos;
    });
    const mine = { key, answer };
    running = mine;
    const forget = () => { if (running === mine) running = null; };
    answer.then(forget, forget);
    return answer;
  };
}
