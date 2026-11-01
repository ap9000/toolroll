/**
 * Permission to write to somebody else's tracker.
 *
 * Everything up to here reads. This is the line, and it is drawn deliberately
 * wide of where it needs to be: discovery indexes everything it can see, and
 * Toolroll drives only what has been handed over, one repository and one
 * backend at a time, by a person, in an act that shows its own consequences
 * first.
 *
 * The grant is not a boolean. A yes/no flag would answer "may I write here"
 * and leave every interesting question — write *what*, to *which* tasks, with
 * *whose* credentials, visible to *whom* — to whatever the agent decided at
 * 3am. So the record carries all of them, and the check is against the whole
 * thing.
 *
 * Two defaults are load-bearing.
 *
 * **Only tasks we created or were given.** An operator enrolling a repository
 * with four hundred open issues is not volunteering all four hundred to an
 * unattended agent, and reading enrollment that way is how a tool ends up
 * closing somebody's backlog overnight.
 *
 * **Closing is not included.** Creating a task is additive and reversible;
 * transitioning one we own is ours to do; closing work somebody else filed is
 * neither, so it is off unless explicitly granted. Widening takes another
 * human action, which is the design's rule and not a nicety.
 *
 * Absence of a grant is denial. There is no implicit, inherited, or default
 * permission anywhere in this module — an unknown repository is refused for
 * the same reason an unknown lease is: silence is not consent.
 */

import { run, type ExecResult, type RunOptions } from "./exec.js";
import { lazyFetchSafeGit, noLazyFetch } from "./teardown-git.js";

/**
 * What a write actually does, split by how much it can hurt.
 *
 * `close` is separate from `transition` because "mark the task I am working on
 * as done" and "close the issue somebody filed in March" are the same verb to
 * a database and completely different acts to a person.
 */
export type MutationClass = "create" | "transition" | "edge" | "hold" | "close" | "comment";

export const MUTATION_CLASSES: readonly MutationClass[] = [
  "create",
  "transition",
  "edge",
  "hold",
  "close",
  "comment",
];

/** Granted unless asked otherwise; `close` is the deliberate omission. */
export const DEFAULT_MUTATIONS: readonly MutationClass[] = ["create", "transition", "edge", "hold"];

/**
 * Which tasks the grant covers. `ours` means the ones Toolroll created or
 * was explicitly given — the design's default, and the one that keeps an
 * enrolment from becoming an amnesty over an entire backlog.
 */
export type TaskSelector = "ours" | "all";

export type BackendGrant = {
  repo: string;
  backend: string;
  /** Exact paths, or `owner/name` for a GitHub tracker. Never a wildcard. */
  paths: string[];
  mutations: MutationClass[];
  selector: TaskSelector;
  /** Named, never held: the value lives on the runner. */
  credentialScope: string | null;
  /** Whether these writes will show up in `git status` and in history. */
  observedByGit: boolean;
  grantedAt: string;
  grantedBy: string;
  /** External dispatch (v20): a SEPARATE authority from tracker writes —
   * "this plane will BUILD what this tracker nominates, under scopes
   * approved here". Never in any default; its own explicit yes. */
  dispatch?: boolean;
  /** The one exact owner/name this dispatch grant binds. Required when
   * dispatch is true (enforced in saveGrant). */
  remoteRepo?: string | null;
  /** This plane's identity for the tracker-side marker — detection of a
   * second plane, never a distributed lease. Minted at grant creation. */
  planeId?: string | null;
  /** Fail-closed dispatch block: set by marker verification and sync
   * failures; null = clear. Admission refuses while set. */
  dispatchBlocked?: "pending-marker" | "unreachable" | "foreign" | "missing" | "multiple-or-malformed" | null;
  dispatchBlockedAt?: string | null;
  dispatchBlockedDetail?: string | null;
};

/** Where a task came from, which is what `selector` discriminates on. */
export type TaskOrigin = "ours" | "theirs";

export type WriteRequest = {
  repo: string;
  backend: string;
  mutation: MutationClass;
  origin: TaskOrigin;
  /** The file or repository being written, when the backend has one. */
  path?: string;
};

export type Verdict = { ok: true } | { ok: false; reason: DenialReason; message: string };

/** Stable tokens: an agent branches on these, a person reads the message. */
export type DenialReason = "no-grant" | "mutation" | "selector" | "path";

/**
 * Whether this write is inside the grant.
 *
 * Written as a pure function over the whole grant so the policy can be read in
 * one place and tested without a database, a repository, or a network — the
 * three things that make a permission check hard to trust.
 */
export function permits(
  grant: BackendGrant | null,
  request: WriteRequest,
): Verdict {
  if (grant === null) {
    return {
      ok: false,
      reason: "no-grant",
      message: `${request.repo} is not enrolled for ${request.backend} — \`toolroll enroll\` grants write access`,
    };
  }

  // The grant has to be *this* grant. Callers look one up and pass it in, and
  // a caller that looks up the wrong one — or reuses a handle across
  // repositories in a loop — would otherwise have repo A's permission applied
  // to repo B. Re-checking here costs a string compare and removes a class of
  // confused-deputy bug that no amount of care at the call site can rule out.
  if (grant.repo !== request.repo || grant.backend !== request.backend) {
    return {
      ok: false,
      reason: "no-grant",
      message: `that grant is for ${grant.backend} in ${grant.repo}, not ${request.backend} in ${request.repo}`,
    };
  }

  if (!grant.mutations.includes(request.mutation)) {
    return {
      ok: false,
      reason: "mutation",
      message: `the grant on ${request.repo} does not allow \`${request.mutation}\` (it allows ${grant.mutations.join(", ")})`,
    };
  }

  if (grant.selector === "ours" && request.origin === "theirs") {
    return {
      ok: false,
      reason: "selector",
      message: `the grant on ${request.repo} covers only tasks Toolroll created or was given`,
    };
  }

  // A path outside the declared set is the case this is really for: a grant
  // over `.beads/` must not become a licence to edit the working tree.
  if (request.path !== undefined && !grant.paths.some(allowed => within(request.path as string, allowed))) {
    return {
      ok: false,
      reason: "path",
      message: `${request.path} is outside the grant on ${request.repo} (${grant.paths.join(", ")})`,
    };
  }

  return { ok: true };
}

/**
 * Whether `path` is the granted scope or sits inside it.
 *
 * Segment-aware, so `.beads-backup` is not inside `.beads`, and `..` is
 * resolved before comparing — without that, `.beads/../src/index.ts` starts
 * with `.beads/` and a grant over a tracker's data directory becomes a licence
 * to rewrite the working tree.
 *
 * This is a lexical check and says so. A symlink inside the granted directory
 * still points wherever it points, and no amount of string handling will catch
 * that; the boundary for it is the worktree the runner is confined to, which
 * is M1's problem and not this function's.
 */
function within(path: string, allowed: string): boolean {
  const target = resolveSegments(path);
  const scope = resolveSegments(allowed);
  if (target === null || scope === null) return false;
  return target === scope || target.startsWith(`${scope}/`);
}

/** null when the path climbs above its own root, which is never inside anything. */
function resolveSegments(path: string): string | null {
  const out: string[] = [];
  for (const segment of normalise(path).split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") {
      out.push(segment);
      continue;
    }
    if (out.length === 0) return null;
    out.pop();
  }
  return out.join("/");
}

function normalise(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

export type Runner = (
  file: string,
  args: readonly string[],
  options?: RunOptions,
) => Promise<ExecResult>;

export type ProposeOptions = {
  repo: string;
  backend: string;
  paths: string[];
  mutations?: readonly MutationClass[];
  selector?: TaskSelector;
  credentialScope?: string | null;
  grantedBy?: string;
  now: Date;
  runner?: Runner;
};

/**
 * Build the grant that would be created, including the one fact an operator
 * cannot easily check for themselves: whether these writes will be visible.
 *
 * A backend that stores its data in a tracked directory means every task
 * transition shows up in `git status` and eventually in history — which is
 * either exactly what somebody wants, or a nasty surprise on their next
 * commit. It is asked of git rather than assumed, because the answer differs
 * per repository and the guess would be wrong half the time.
 */
export async function proposeGrant(options: ProposeOptions): Promise<BackendGrant> {
  const {
    repo,
    backend,
    paths,
    mutations = DEFAULT_MUTATIONS,
    selector = "ours",
    credentialScope = null,
    grantedBy = "operator",
    now,
    runner = run,
  } = options;

  return {
    repo,
    backend,
    paths: [...paths],
    mutations: [...mutations],
    selector,
    credentialScope,
    observedByGit: await observedByGit(repo, paths, runner),
    grantedAt: now.toISOString(),
    grantedBy,
  };
}

/**
 * True when at least one granted path is not ignored by git.
 *
 * `git check-ignore` exits 0 when a path *is* ignored and 1 when it is not, so
 * the interesting answer is the failure. Anything else — no git, an unreadable
 * repository — is reported as observed, because claiming writes are invisible
 * when we could not establish it is the wrong way to be wrong.
 *
 * Each path is asked about twice, bare and with a trailing slash, and that is
 * not belt-and-braces. A `.gitignore` rule written `.beads/` matches only
 * directories, and git cannot tell that a path *is* a directory when it does
 * not exist yet — which is precisely the state at enrolment, before the
 * tracker has been initialised. Asked bare, git says "not ignored" and the
 * grant would tell somebody their writes are about to show up in every commit
 * when they are not.
 */
async function observedByGit(repo: string, paths: readonly string[], runner: Runner): Promise<boolean> {
  const local = paths.filter(path => !isRemoteRef(path));
  if (local.length === 0) return false;
  // On a git without --no-lazy-fetch, through a frozen read view (teardown-git.ts lazyFetchSafeGit): a partial clone is
  // refused there, and a refusal reads as "not ignored", so observed.
  const git = lazyFetchSafeGit(runner);

  for (const path of local) {
    const asked = [path, `${normalise(path)}/`];
    const ignored = await Promise.all(
      asked.map(async candidate => {
        // check-ignore reads the index, so a planted fsmonitor would run: off (and hooks, lazy fetch) on the command line,
        // which wins over any config the repository's builds can write.
        const result = await git("git", ["--no-optional-locks", ...noLazyFetch(), "-c", "protocol.allow=never", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "check-ignore", "-q", candidate], {
          cwd: repo,
        });
        return result.code === 0;
      }),
    );
    if (!ignored.some(Boolean)) return true;
  }
  return false;
}

/** `owner/name` is a GitHub tracker, not a file in the working tree. */
function isRemoteRef(path: string): boolean {
  return /^[^/\\]+\/[^/\\]+$/.test(path) && !path.startsWith(".");
}

/**
 * The grant, in the words an operator needs before agreeing to it — what may
 * be touched, what may be done, to which tasks, and whether anyone else will
 * see it happen.
 */
export function describeGrant(grant: BackendGrant): string[] {
  return [
    `  repository   ${grant.repo}`,
    `  backend      ${grant.backend}`,
    `  may touch    ${grant.paths.join(", ")}`,
    `  may do       ${grant.mutations.join(", ")}`,
    `  on tasks     ${grant.selector === "ours" ? "only those Toolroll created or was given" : "every task in the tracker"}`,
    `  credentials  ${grant.credentialScope ?? "none of its own — it uses the ones already on this machine"}`,
    `  visibility   ${describeVisibility(grant)}`,
  ];
}

/**
 * Who will see these writes.
 *
 * Careful about what git can actually tell us. `check-ignore` answers whether
 * a path would show up in `git status` — it does not decide what lands in
 * history, since nothing lands there until somebody commits. Saying "these
 * will be in your history" would be a claim this program is in no position to
 * make; saying they will turn up in `git status`, staged by whoever commits
 * next, is exactly true and is the thing an operator needs to know.
 *
 * A remote tracker is a different question entirely: nothing about git governs
 * it, and the writes are visible to everyone with access the moment they land.
 */
function describeVisibility(grant: BackendGrant): string {
  const remote = grant.paths.every(isRemoteRef);
  if (remote) return "these writes are visible to anyone with access to the tracker, immediately";
  return grant.observedByGit
    ? "these writes turn up in `git status` — whoever commits next will pick them up"
    : "git ignores these paths, so they stay out of `git status` and out of commits";
}

/** What is not granted, which is the half people forget to read. */
export function describeWithheld(grant: BackendGrant): string[] {
  const withheld = MUTATION_CLASSES.filter(one => !grant.mutations.includes(one));
  if (withheld.length === 0) return [];
  return [`  will not     ${withheld.join(", ")} — widening takes another \`enroll\``];
}
