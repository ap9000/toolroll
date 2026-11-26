/**
 * The first terminal start's preflight (easy-start.ts), besides the sandbox (its own seam): everything else that would
 * stop Toolroll here, found at once before anything is made, each with its fix — the same checks `toolroll doctor`
 * reports (git-floor.ts, process-identity.ts). A browser that can't open is advice, never a blocker: the terminal
 * workbench needs none. Nothing here decides security: every condition is checked again where it is used.
 */
import { noBrowserReason } from "./browser-open.js";
import { installedGitFloorProblem } from "./git-floor.js";
import { processIdentityProblem } from "./process-identity.js";

/** Each blocker as its lines (what, then how to fix it); advisories as one line each. */
export type Prerequisites = { blockers: string[][]; advisories: string[] };

export function startPrerequisites(deps: { gitFloorProblem?: () => string | null; processIdentityProblem?: () => string | null; noBrowser?: () => string | null } = {}): Prerequisites {
  const blockers: string[][] = [];
  const git = (deps.gitFloorProblem ?? installedGitFloorProblem)();
  if (git !== null) blockers.push([git]);
  const identity = (deps.processIdentityProblem ?? processIdentityProblem)();
  if (identity !== null) blockers.push([`${identity}.`]);
  const browser = (deps.noBrowser ?? (() => noBrowserReason()))();
  return { blockers, advisories: browser === null ? [] : [`No browser opens here (${browser}): the terminal workbench doesn't need one, and Toolroll prints its address.`] };
}
