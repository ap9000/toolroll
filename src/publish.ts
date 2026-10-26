/**
 * Publication (§M4): built work becomes a pushed branch and a pull request,
 * under a grant whose every term was shown before the yes, through a durable
 * intent that survives any crash between "done" and "opened".
 *
 * Two external writes, two named capabilities. Pushing a branch and opening
 * a PR hurt differently, so `push-branch` and `open-pr` are granted
 * separately, with the exact GitHub repository, remote, allowed head
 * prefix, and base branch fixed at grant time — the worker re-proves all of
 * them at publish time, because a grant revoked overnight must stop the
 * morning's pushes.
 *
 * The push names the exact SHA the fenced completion accepted —
 * `git push <remote> <sha>:refs/heads/<head>` — never "whatever the branch
 * points at now". The PR is adopt-or-create: the worker first asks GitHub
 * for an open PR on that head and adopts it, so a crash after `pr create`
 * and before the record lands cannot mint a twin. The body is generated
 * only from durable state (task, scope, run record, answered decisions),
 * with the agent's prose fenced in a quote block so `Fixes #…` or an
 * @-mention in its conclusion cannot acquire GitHub semantics.
 */

import { createHash } from "node:crypto";
import { protectedPublicationHold } from "./result-completion.js";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as execRun, type ExecResult, type RunOptions } from "./exec.js";
import { summarizeChecks } from "./pulls.js";
import type { Publication, PublicationGrant, Store } from "./store.js";
import { releasePublication } from "./store.js";
import { headWithin } from "./names.js";

export const BODY_TEMPLATE_VERSION = 2;
/** After this many failed attempts a publication stops retrying and pages instead. */
export const MAX_PUBLISH_ATTEMPTS = 5;
const EXEC_TIMEOUT_MS = 60_000;

/**
 * The one grant lookup for a task's publication: its project is the task's repo, and that project's live grant
 * governs it. The publisher, Complete → pull request and a flow's Pull request zone all ask here, so none of them
 * can judge a publication by another project's grant. `fallback`: the repo to assume for a task with none recorded.
 */
export function publicationGrantOf(store: Store, taskRef: number, fallback: string | null = null): { repo: string | null; grant: PublicationGrant | null } {
  const repo = store.refById(taskRef)?.repo ?? fallback;
  return { repo, grant: repo === null ? null : store.publicationGrantFor(repo) };
}

export type PublishExec = (
  file: string,
  args: readonly string[],
  options?: RunOptions,
) => Promise<ExecResult>;

/** The grant's terms, in the words the approver must be shown before agreeing. */
export function describePublicationGrant(grant: {
  repo: string;
  githubRepo: string;
  remote: string;
  headPrefix: string;
  base: string;
  capabilities: readonly string[];
  selector: "ours" | "all";
  draft: boolean;
}): string[] {
  return [
    `  repo         ${grant.repo}`,
    `  github       ${grant.githubRepo}`,
    `  remote       ${grant.remote}`,
    `  may push     branches under ${grant.headPrefix} — nothing else, ever`,
    `  base         PRs target ${grant.base}`,
    `  capabilities ${grant.capabilities.join(", ")}`,
    `  tasks        ${grant.selector === "ours" ? "only tasks Toolroll created or was given" : "any task"}`,
    `  mode         ${grant.draft ? "draft PRs" : "ready-for-review PRs"}`,
  ];
}

/**
 * The PR body, from durable state only — the same rows produce the same
 * bytes after any crash, which is what lets the intent carry a hash of it.
 */
/** One line of untrusted prose, kept inline: newlines flatten so no agent
 * text can START a Markdown line and gain semantics (audit IV-9) —
 * `Closes #123` at line start closes; mid-sentence it is words. */
function mdInline(text: string): string {
  return text.replace(/[\r\n\u2028\u2029]+/g, " ").trim();
}

/** Untrusted multi-line prose as an INDENTED code block: backticks cannot
 * terminate indentation, so no conclusion escapes its quoting (audit IV-9). */
function mdIndented(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split("\n").map(line => `    ${line}`);
}

export function publicationBody(store: Store, publication: Publication): string {
  const run = store.getRun(publication.run);
  const taskId = store.externalIdFor(publication.taskRef) ?? "?";
  const task = taskId === "?" ? null : store.getTask(taskId);
  const scope = taskId === "?" ? null : store.getScope(taskId);
  const answers = store.answersFor(publication.run);

  const lines: string[] = [
    `## ${mdInline(task?.title ?? taskId)}`,
    "",
    ...(scope === null ? [] : [`**Goal:** ${mdInline(scope.goal)}`, ""]),
    `Built unattended by Toolroll (task \`${taskId}\`, run #${publication.run}).`,
    `Base \`${run?.baseRevision ?? "?"}\` → head \`${publication.headSha}\`.`,
  ];

  if (answers.length > 0) {
    lines.push("", "**Decisions a person answered along the way:**");
    for (const answer of answers) {
      lines.push(
        `- ${mdInline(answer.decision.question)} → **${mdInline(answer.choice)}** (${mdInline(answer.decision.answeredBy ?? "?")})`,
      );
    }
  }

  // The agent's own words ride INDENTED: an indented code block has no
  // terminator an agent's text could supply, so prose stays prose.
  if (run?.handoff !== null && run?.handoff !== undefined) {
    lines.push("", "**The agent's conclusion, quoted:**", "", ...mdIndented(run.handoff));
  }

  lines.push("", `*Template v${BODY_TEMPLATE_VERSION} — generated from run records, reproducible.*`);
  return lines.join("\n");
}

export function bodyHashOf(body: string): string {
  return createHash("sha256").update(`v${BODY_TEMPLATE_VERSION}\n${body}`, "utf8").digest("hex");
}

export type PublishReport = {
  pushed: number;
  opened: number;
  adopted: number;
  failed: number;
  problems: string[];
};

/**
 * One pass over everything owed. Each phase re-proves the grant and moves
 * exactly one durable state — a crash at any point leaves a row the next
 * pass picks up where this one stopped.
 */
export async function publishPass(
  store: Store,
  options: {
    repo: string;
    clock?: () => Date;
    exec?: PublishExec;
    /** v102: where the builds' sealed diffs live, to hold a branch that changed protected files on a one-person approval. */
    evidenceRoot: string;
  },
): Promise<PublishReport> {
  const clock = options.clock ?? (() => new Date());
  const exec = options.exec ?? execRun;
  const report: PublishReport = { pushed: 0, opened: 0, adopted: 0, failed: 0, problems: [] };

  for (const publication of store.pendingPublications()) {
    // The secret gate (audit IV-7): a run whose accepted diff carried a
    // high-confidence secret shape publishes NOTHING — pushing the branch
    // would hand the credential to the remote. Fail closed, say why once,
    // and leave the person to rewrite the branch and requeue.
    if (store.hasRedactedTerminalDiff(publication.run)) {
      concede(store, publication, "the accepted diff carries a detected secret — rewrite the branch before anything publishes", report, clock);
      continue;
    }
    // Each project's watch publishes its own project's work: the push runs in
    // that checkout, under that project's grant. Another project's pass must
    // not touch it — judging it by the wrong grant once recorded "no live
    // grant" errors until it gave up, while its own pass opened the PR.
    // The grant is re-read per publication, live: revocation is immediate,
    // and an intent created under a grant that has since died goes nowhere.
    const { repo, grant } = publicationGrantOf(store, publication.taskRef, options.repo);
    if (repo !== options.repo) continue;
    const verdict = permitsPublication(grant, publication);
    if (!verdict.ok) {
      report.problems.push(`publication ${publication.id}: ${verdict.message}`);
      const attempts = store.recordPublicationError(publication.id, verdict.message, clock());
      if (attempts >= MAX_PUBLISH_ATTEMPTS) concede(store, publication, verdict.message, report, clock);
      continue;
    }

    // v102: separation of duties holds the push itself (so no PR and no merge follow) until a second person
    // has seen a result that changed protected files on a one-person approval.
    if (publication.state === "intended") {
      const held = protectedPublicationHold(store, publication.run, options.evidenceRoot);
      if (held !== null) { report.problems.push(`publication ${publication.id}: ${held}`); continue; }
    }

    if (publication.state === "intended") {
      // The exact SHA to the exact ref. A branch that moved since completion
      // is not what was accepted, and this push cannot be talked into it.
      const push = await exec(
        "git",
        ["push", publication.remote, `${publication.headSha}:refs/heads/${publication.head}`],
        { cwd: options.repo, timeoutMs: EXEC_TIMEOUT_MS },
      );
      if (push.code !== 0) {
        const why = push.notFound ? "git is not on PATH" : firstLine(push.stderr) || `git push exited ${push.code}`;
        const attempts = store.recordPublicationError(publication.id, why, clock());
        report.problems.push(`publication ${publication.id}: ${why}`);
        if (attempts >= MAX_PUBLISH_ATTEMPTS) concede(store, publication, why, report, clock);
        continue;
      }
      store.markPublicationPushed(publication.id, clock());
      report.pushed++;
      publication.state = "pushed";
    }

    if (publication.state === "pushed") {
      const outcome = await openOrAdopt(store, publication, grant as PublicationGrant, exec, clock);
      if (!outcome.ok) {
        const attempts = store.recordPublicationError(publication.id, outcome.why, clock());
        report.problems.push(`publication ${publication.id}: ${outcome.why}`);
        if (attempts >= MAX_PUBLISH_ATTEMPTS) concede(store, publication, outcome.why, report, clock);
        continue;
      }
      if (outcome.adopted) report.adopted++;
      else report.opened++;
    }
  }

  return report;
}

/** Why a publication may not proceed — checked against the whole grant, per phase. */
export function permitsPublication(
  grant: PublicationGrant | null,
  publication: Pick<Publication, "githubRepo" | "remote" | "base" | "head" | "state">,
): { ok: true } | { ok: false; message: string } {
  if (grant === null) return { ok: false, message: "no live publication grant — nothing may be pushed" };
  if (grant.githubRepo !== publication.githubRepo || grant.remote !== publication.remote || grant.base !== publication.base) {
    return { ok: false, message: "the intent's terms no longer match the live grant" };
  }
  if (!headWithin(publication.head, grant.headPrefix)) {
    return { ok: false, message: `head ${publication.head} is outside the granted prefix ${grant.headPrefix}` };
  }
  const needs = publication.state === "intended" ? "push-branch" : "open-pr";
  if (!grant.capabilities.includes(needs as PublicationGrant["capabilities"][number])) {
    return { ok: false, message: `the grant does not include ${needs}` };
  }
  return { ok: true };
}

async function openOrAdopt(
  store: Store,
  publication: Publication,
  grant: PublicationGrant,
  exec: PublishExec,
  clock: () => Date,
): Promise<{ ok: true; adopted: boolean } | { ok: false; why: string }> {
  // Adopt first: a PR this head already has — whoever opened it, including
  // a crashed earlier attempt — is the PR. Creating a second would be the
  // duplicate the durable intent exists to prevent.
  const listed = await exec(
    "gh",
    [
      "pr", "list",
      "--repo", publication.githubRepo,
      "--head", publication.head,
      // The base filter (merge-grant finding 21): a same-head PR aimed at
      // a DIFFERENT base is not this publication's PR and must never be
      // adopted under authority granted for another branch.
      "--base", publication.base,
      "--state", "open",
      "--json", "number,url",
    ],
    { timeoutMs: EXEC_TIMEOUT_MS },
  );
  if (listed.code !== 0) {
    return {
      ok: false,
      why: listed.notFound ? "gh is not on PATH" : firstLine(listed.stderr) || `gh pr list exited ${listed.code}`,
    };
  }
  let existing: { number: number; url: string }[];
  try {
    existing = JSON.parse(listed.stdout || "[]") as { number: number; url: string }[];
  } catch {
    return { ok: false, why: "gh pr list said something that is not JSON" };
  }
  const adopted = existing[0];
  if (adopted !== undefined) {
    store.markPublicationOpened(publication.id, adopted.number, adopted.url, clock());
    enqueueOpened(store, publication, adopted.url, clock);
    return { ok: true, adopted: true };
  }

  const body = publicationBody(store, publication);
  const taskId = store.externalIdFor(publication.taskRef) ?? publication.head;
  const title = store.getTask(taskId)?.title ?? taskId;
  // --body-file, not --body: the body quotes an agent and a shell must not
  // meet it. The file lives in a private temp dir for exactly one call.
  const dir = mkdtempSync(join(tmpdir(), "standing-orders-pr-"));
  try {
    const bodyFile = join(dir, "body.md");
    writeFileSync(bodyFile, body, { mode: 0o600 });
    const created = await exec(
      "gh",
      [
        "pr", "create",
        "--repo", publication.githubRepo,
        "--base", publication.base,
        "--head", publication.head,
        "--title", `${taskId}: ${title}`.slice(0, 200),
        "--body-file", bodyFile,
        ...(publication.draft ? ["--draft"] : []),
      ],
      { timeoutMs: EXEC_TIMEOUT_MS, env: { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" } },
    );
    if (created.code !== 0) {
      return { ok: false, why: firstLine(created.stderr) || `gh pr create exited ${created.code}` };
    }
    const url = firstLine(created.stdout);
    const number = Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? 0);
    if (number === 0) return { ok: false, why: "gh pr create returned no PR URL" };
    store.markPublicationOpened(publication.id, number, url, clock());
    enqueueOpened(store, publication, url, clock);
    return { ok: true, adopted: false };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A publication given up on whose pull request exists anyway — a pass that gave up while another opened it, or a
 * person who opened it by hand: the PR on its exact head and base, carrying its exact commit, is adopted as opened
 * (merged or closed ones too; the next observation records which). Whether one was found.
 */
export async function adoptPublishedPullRequest(store: Store, publication: Publication, exec: PublishExec, clock: () => Date): Promise<boolean> {
  if (publication.state !== "failed") return false;
  const listed = await exec(
    "gh",
    ["pr", "list", "--repo", publication.githubRepo, "--head", publication.head, "--base", publication.base, "--state", "all", "--json", "number,url,headRefOid"],
    { timeoutMs: EXEC_TIMEOUT_MS },
  );
  if (listed.code !== 0) return false;
  let found: { number?: unknown; url?: unknown; headRefOid?: unknown }[];
  try { found = JSON.parse(listed.stdout || "[]") as typeof found; } catch { return false; }
  const pr = Array.isArray(found) ? found.find(one => one.headRefOid === publication.headSha && typeof one.number === "number" && typeof one.url === "string") : undefined;
  if (pr === undefined) return false;
  store.markPublicationOpened(publication.id, pr.number as number, pr.url as string, clock());
  enqueueOpened(store, publication, pr.url as string, clock);
  return true;
}

export type CheckReport = {
  observed: number;
  failing: number;
  resolved: number;
  problems: string[];
  /** Every observation that won its settle, for the pull-request follower (CI revisions, Ready to merge). */
  seen: ObservedPullRequest[];
};

export type ObservedPullRequest = {
  publication: Publication;
  headOid: string;
  state: ReturnType<typeof summarizeChecks>;
  remoteState: "MERGED" | "CLOSED" | null;
  rollup: unknown;
  mergeCommit: string | null;
};

/**
 * Read CI for every PR this control plane opened — structured rollup and the
 * exact head OID, never a command's exit status (finding 18). Episodes are
 * keyed `ci:<pr>:<headOid>`: a red head pages once; the episode resolves
 * when that exact head turns green or a newer commit supersedes it. `none`,
 * `running`, and not-read are never called green — an unread rollup neither
 * pages nor resolves anything.
 */
export async function observeChecks(
  store: Store,
  options: { clock?: () => Date; exec?: PublishExec },
): Promise<CheckReport> {
  const clock = options.clock ?? (() => new Date());
  const exec = options.exec ?? execRun;
  const report: CheckReport = { observed: 0, failing: 0, resolved: 0, problems: [], seen: [] };

  for (const publication of store.openedPublications()) {
    if (publication.prNumber === null) continue;
    // The observation generation is RESERVED before the network call
    // (merge grant, findings 20/24): a stalled older response loses its
    // conditional settle, and a loser has NO effects — not the mirror
    // row, not remote_state, not check state, not an episode.
    const generation = store.reserveObservation(publication.githubRepo, publication.prNumber);
    const viewed = await exec(
      "gh",
      [
        "pr", "view", String(publication.prNumber),
        "--repo", publication.githubRepo,
        "--json", "statusCheckRollup,headRefOid,state,mergeCommit",
      ],
      { timeoutMs: EXEC_TIMEOUT_MS },
    );
    if (viewed.code !== 0) {
      report.problems.push(
        `PR #${publication.prNumber}: not read — ${viewed.notFound ? "gh is not on PATH" : firstLine(viewed.stderr) || `exit ${viewed.code}`}`,
      );
      continue;
    }
    let payload: { statusCheckRollup?: unknown; headRefOid?: unknown; state?: unknown; mergeCommit?: unknown };
    try {
      payload = JSON.parse(viewed.stdout) as typeof payload;
    } catch {
      report.problems.push(`PR #${publication.prNumber}: not read — gh said something that is not JSON`);
      continue;
    }
    const headOid = typeof payload.headRefOid === "string" ? payload.headRefOid : null;
    if (headOid === null) {
      report.problems.push(`PR #${publication.prNumber}: not read — no head OID in the answer`);
      continue;
    }

    report.observed++;

    // A merged or closed PR leaves the watch (Codex M5-M8 audit, C-6): its
    // remote state is recorded, its episodes resolve, and neither the
    // review queue nor the next observation pass carries it forever.
    const remoteState = typeof payload.state === "string" ? payload.state.toUpperCase() : null;
    const mergeCommit = typeof payload.mergeCommit === "object" && payload.mergeCommit !== null && typeof (payload.mergeCommit as { oid?: unknown }).oid === "string"
      ? (payload.mergeCommit as { oid: string }).oid : null;
    if (remoteState === "MERGED" || remoteState === "CLOSED") {
      let won = false;
      store.transact(() => {
        const settled = store.settleObservation(
          { githubRepo: publication.githubRepo, prNumber: publication.prNumber as number, headSha: headOid, state: "none", generation },
          clock(),
        );
        if (!settled.won) return;
        won = true;
        store.recordPublicationRemoteState(publication.id, remoteState, clock());
        report.resolved += store.resolveCiEpisodes(publication.githubRepo, publication.prNumber as number, null, clock());
        // A closed PR moots its merge blocker and supersedes its intent —
        // and its person-needed episode (arc 3 finding 23).
        store.liftMergeBlocker(publication.id, "the-remote", clock());
        store.resolveEpisodes(`merge-attn:${publication.id}`, clock());
        const intent = store.mergeIntentFor(publication.id);
        if (intent !== null && ["pending", "claimed", "waiting-human", "firing"].includes(intent.state)) {
          // The observer settles ANY nonterminal on an observed remote
          // terminal (E1/F1) - generation bumped so a live claim or
          // firing owner's later write loses to the observed truth.
          store.settleMergeIntent(intent.id, intent.generation, remoteState === "MERGED" ? "merged" : "superseded", clock(), {
            receipt: `observed ${remoteState.toLowerCase()} remotely`, bumpGeneration: true,
          });
        }
      });
      if (won) report.seen.push({ publication, headOid, state: "none", remoteState, rollup: payload.statusCheckRollup, mergeCommit });
      continue;
    }

    const state = summarizeChecks(payload.statusCheckRollup);
    const settled = store.settleObservation(
      { githubRepo: publication.githubRepo, prNumber: publication.prNumber, headSha: headOid, state, generation },
      clock(),
    );
    if (!settled.won) {
      // An out-of-order response: a newer observation already spoke.
      // Nothing persists from this one (round-4 findings 24/25).
      report.problems.push(`PR #${publication.prNumber}: superseded observation discarded`);
      continue;
    }
    store.recordPublicationCheckState(publication.id, state, clock());
    report.seen.push({ publication, headOid, state, remoteState: null, rollup: payload.statusCheckRollup, mergeCommit });
    // The episode identity carries the REPOSITORY (audit C-2): PR #55 in
    // repo A and PR #55 in repo B are different worlds, and one's failure
    // must never light the other's repair button.
    const key = `ci:${publication.githubRepo}:${publication.prNumber}:${headOid}`;
    const taskId = store.externalIdFor(publication.taskRef) ?? publication.head;

    if (state === "failing") {
      report.failing++;
      store.transact(() => {
        // Older heads' episodes die with their commits; this head's opens once.
        store.resolveCiEpisodes(publication.githubRepo, publication.prNumber as number, key, clock());
        store.enqueueNotification(
          {
            source: { run: publication.run },
            dedupeKey: key,
            kind: "ci-failing",
            subject: `CI failing: ${taskId} (PR #${publication.prNumber})`,
            body: `${publication.prUrl ?? publication.githubRepo} — head ${headOid.slice(0, 12)} is red.`,
          },
          clock(),
        );
      });
    } else if (state === "passing") {
      report.resolved += store.resolveCiEpisodes(publication.githubRepo, publication.prNumber, null, clock());
    } else {
      // running / none: not good news, not bad news — old episodes for
      // *other* heads still resolve (their commit is gone), this head's
      // verdict stays open.
      store.resolveCiEpisodes(publication.githubRepo, publication.prNumber, key, clock());
    }
  }

  return report;
}

/** Retries are over; say so durably and page a person — silence is the one failure mode ruled out. */
function concede(
  store: Store,
  publication: Publication,
  why: string,
  report: PublishReport,
  clock: () => Date,
): void {
  store.transact(() => {
    store.failPublication(publication.id, clock());
    store.enqueueNotification(
      {
        source: { run: publication.run },
        dedupeKey: `publication:${publication.id}:failed`,
        kind: "publication-failed",
        // A person is needed now (v4 review, finding 6): never a digest.
        pushClass: "attention",
        link: `/r/${publication.run}`,
        subject: `publication of run #${publication.run} gave up`,
        body: `After ${MAX_PUBLISH_ATTEMPTS} attempts: ${why}. The commit ${publication.headSha} is safe locally; nothing was lost, nothing more will be pushed.`,
      },
      clock(),
    );
  });
  report.failed++;
}

function enqueueOpened(store: Store, publication: Publication, url: string, clock: () => Date): void {
  store.enqueueNotification(
    {
      source: { run: publication.run },
      dedupeKey: `publication:${publication.id}:opened`,
      kind: "publication-opened",
      subject: `PR ready: ${store.externalIdFor(publication.taskRef) ?? publication.head}`,
      body: url,
    },
    clock(),
  );
}

function firstLine(text: string): string {
  return text.split("\n")[0]?.trim() ?? "";
}


// ---- the merge sweep (v21; four review rounds are the spec) ---------------

export const MERGE_LEASE_MS = 5 * 60_000;
// F1: a firing row is STALE only when this deadline passes - one sweep
// interval plus grace, stamped at the CAS, never a guess.
export const FIRING_GRACE_MS = 10 * 60_000;
export const MERGE_MAX_ATTEMPTS = 3;

/** The exact terms a merge intent binds - drift supersedes, never surprises. */
export function mergeTermsHash(grant: PublicationGrant): string {
  return createHash("sha256")
    .update(
      "merge-terms/v1 " + grant.githubRepo + " " + grant.base + " " + grant.headPrefix + " " + (grant.mergeMethod ?? "") + " " + (grant.mergeDeleteBranch === true ? 1 : 0),
    )
    .digest("hex");
}

export type MergeReport = { merged: number; refused: number; skipped: number; problems: string[] };

/** One fresh, WINNING observation - the only tuple that may authorize. */
async function observeOne(
  store: Store,
  exec: PublishExec,
  clock: () => Date,
  githubRepo: string,
  prNumber: number,
): Promise<{ ok: true; state: string; headSha: string } | { ok: false; why: string }> {
  const generation = store.reserveObservation(githubRepo, prNumber);
  const viewed = await exec(
    "gh",
    ["pr", "view", String(prNumber), "--repo", githubRepo, "--json", "statusCheckRollup,headRefOid,state,isDraft,baseRefName"],
    { timeoutMs: EXEC_TIMEOUT_MS },
  );
  if (viewed.code !== 0) return { ok: false, why: firstLine(viewed.stderr) || ("exit " + viewed.code) };
  let payload: { statusCheckRollup?: unknown; headRefOid?: unknown; state?: unknown; isDraft?: unknown; baseRefName?: unknown };
  try {
    payload = JSON.parse(viewed.stdout) as typeof payload;
  } catch {
    return { ok: false, why: "gh said something that is not JSON" };
  }
  const headSha = typeof payload.headRefOid === "string" ? payload.headRefOid : null;
  if (headSha === null) return { ok: false, why: "no head OID in the answer" };
  if (payload.isDraft === true) return { ok: false, why: "draft" };
  if (String(payload.state ?? "").toUpperCase() === "MERGED") return { ok: false, why: "pr-merged" };
  if (String(payload.state ?? "").toUpperCase() !== "OPEN") return { ok: false, why: "pr-" + String(payload.state ?? "gone").toLowerCase() };
  const state = summarizeChecks(payload.statusCheckRollup);
  const settled = store.settleObservation({ githubRepo, prNumber, headSha, state, generation }, clock());
  // A losing settle is NO observation (round-4 finding 24).
  if (!settled.won) return { ok: false, why: "stale-observation" };
  return { ok: true, state, headSha };
}

/** A COMPLETE negative proof that no merge queue governs the base - or no
 * merge (round-4 finding 22): every rules page, plus the classic-protection
 * probe with a STRUCTURED status; any classic protection at all, or any
 * unreadable answer, refuses merge-queue-unknown, fail closed. */
async function proveNoMergeQueue(
  exec: PublishExec,
  githubRepo: string,
  base: string,
): Promise<{ ok: true } | { ok: false; why: "merge-queue" | "merge-queue-unknown" }> {
  const rules = await exec(
    "gh",
    ["api", "--paginate", "--slurp", "repos/" + githubRepo + "/rules/branches/" + encodeURIComponent(base)],
    { timeoutMs: EXEC_TIMEOUT_MS },
  );
  if (rules.code !== 0) return { ok: false, why: "merge-queue-unknown" };
  try {
    const pages = JSON.parse(rules.stdout) as unknown;
    if (!Array.isArray(pages)) return { ok: false, why: "merge-queue-unknown" };
    const flat = (pages as unknown[]).flat();
    for (const rule of flat) {
      if (typeof rule === "object" && rule !== null && (rule as Record<string, unknown>)["type"] === "merge_queue") {
        return { ok: false, why: "merge-queue" };
      }
    }
  } catch {
    return { ok: false, why: "merge-queue-unknown" };
  }
  // Classic protection: the endpoint cannot PROVE queue absence, so any
  // 200 refuses conservatively; only a structured 404 is a readable "no".
  const classic = await exec(
    "gh",
    ["api", "--include", "repos/" + githubRepo + "/branches/" + encodeURIComponent(base) + "/protection"],
    { timeoutMs: EXEC_TIMEOUT_MS },
  );
  const statusLine = classic.stdout.split("\n")[0] ?? "";
  if (classic.code === 0 && /^HTTP\/[\d.]+ 200/.test(statusLine)) return { ok: false, why: "merge-queue-unknown" };
  if (/^HTTP\/[\d.]+ 404/.test(statusLine) || /HTTP 404/.test(firstLine(classic.stderr))) return { ok: true };
  return { ok: false, why: "merge-queue-unknown" };
}

/**
 * Merge what the grant allows and the evidence proves: this plane's own
 * publications, on this repo, whose PR was OBSERVED green on the exact
 * head - through a claim lease, a live-grant re-read, the queue proof,
 * and GitHub's own head CAS. Every refusal is typed and durable.
 */
export async function sweepMerges(
  store: Store,
  options: { repo: string; runner?: string; clock?: () => Date; exec?: PublishExec },
): Promise<MergeReport> {
  const clock = options.clock ?? (() => new Date());
  const exec = options.exec ?? execRun;
  const who = options.runner ?? "publish";
  const report: MergeReport = { merged: 0, refused: 0, skipped: 0, problems: [] };
  // Person-needed merge episodes are STAMPED and episodic (arc 3 findings
  // 14/22/23): one open episode per publication nags, resolution closes it,
  // and a recurrence after repair pages again. Success and plain status
  // pages stay classless — a merged PR needs nobody.
  const page = (publication: Publication, key: string, subject: string, body: string): void => {
    store.enqueueNotification({ source: { run: publication.run }, dedupeKey: key, kind: "merge", subject, body }, clock());
  };
  const pagePerson = (publication: Publication, suffix: string, subject: string, body: string): void => {
    store.enqueueEpisode(
      `merge-attn:${publication.id}`,
      { source: { run: publication.run }, kind: "merge", subject, body, pushClass: "merge", link: "/review" },
      suffix,
      clock(),
    );
  };

  const grant = store.publicationGrantFor(options.repo);
  if (grant === null || grant.merge !== true || grant.mergeMethod == null) return report;
  const method = grant.mergeMethod;
  const termsHash = mergeTermsHash(grant);

  for (const publication of store.openedPublications()) {
    // A release's result merges only through `toolroll release` (release-once.md): the sweep never takes it up.
    if (releasePublication(store, publication.id)) { report.skipped++; continue; }
    // One bad row never stops the rest of the sweep: every other publication, in every project, still merges.
    try {
      if (publication.prNumber === null || publication.headSha === null) continue;
      const prNumber = publication.prNumber;
      const headSha = publication.headSha;
      // The local-repo fence (finding 6): repo B's publication never rides
      // repo A's sweep, whatever the remote terms coincide on.
      const ref = store.refForId(publication.taskRef);
      if (ref === null || ref.repo !== options.repo) continue;
      if (publication.githubRepo !== grant.githubRepo) continue;

      const blocker = store.mergeBlockerFor(publication.id);
      if (blocker !== null) {
        report.skipped++;
        pagePerson(
          publication, "blocked",
          "PR #" + prNumber + " holds for a repair",
          "A CI repair (" + (blocker.taskId ?? "?") + ") is in flight. It merges nothing until you lift it: toolroll publish unblock " + prNumber + ".",
        );
        continue;
      }

      store.createMergeIntent(
        { publication: publication.id, repo: options.repo, grantTermsHash: termsHash, headSha, method, deleteBranch: grant.mergeDeleteBranch === true },
        clock(),
      );
      const intent = store.mergeIntentFor(publication.id);
      if (intent === null || intent.state === "merged" || intent.state === "refused" || intent.state === "superseded") continue;

      // WAITING-HUMAN never fires itself (E1): the person is paged once,
      // episodically, with the exact ceremony that releases it.
      if (intent.state === "waiting-human") {
        report.skipped++;
        pagePerson(
          publication, "waiting-human",
          "PR #" + prNumber + " waits for your go-ahead",
          "Merges wait for you while this posture holds. When you want it merged: toolroll publish merge " + prNumber + " --as <you> --token <t>. It still merges only when CI is seen green on the exact head.",
        );
        continue;
      }

      // FIRING is one-shot (E1): a live firing row belongs to its owner.
      // A STALE one (deadline passed) recovers by STRUCTURED REMOTE REREAD
      // (F1): an observed terminal settles it; an OPEN same-head PR is
      // NEVER auto-retried - the person gets the recovery ceremony.
      if (intent.state === "firing") {
        if (intent.firingDeadline !== null && intent.firingDeadline <= clock().toISOString()) {
          const reread = await observeOne(store, exec, clock, grant.githubRepo, prNumber);
          if (!reread.ok && reread.why === "pr-merged") {
            store.settleMergeIntent(intent.id, intent.generation, "merged", clock(), {
              receipt: "observed merged remotely after a stale firing claim", from: "firing", bumpGeneration: true,
            });
            report.merged++;
          } else if (!reread.ok && reread.why.startsWith("pr-")) {
            store.settleMergeIntent(intent.id, intent.generation, "superseded", clock(), {
              error: reread.why, from: "firing", bumpGeneration: true,
            });
          } else if (reread.ok && reread.headSha !== intent.headSha) {
            store.settleMergeIntent(intent.id, intent.generation, "superseded", clock(), {
              error: "the head moved while the firing claim was stale", from: "firing", bumpGeneration: true,
            });
          } else {
            report.skipped++;
            pagePerson(
              publication, "half-fired",
              "PR #" + prNumber + " may have half-merged",
              "A merge was issued and its owner went silent; the PR is still open on the same commit. Nothing retries by itself. If you want it fired again: toolroll publish refire " + prNumber + " --as <you> --token <t>.",
            );
          }
        } else {
          report.skipped++;
        }
        continue;
      }

      const claim = store.claimMergeIntent(intent.id, who, MERGE_LEASE_MS, clock());
      if (claim === null) continue; // someone else's live claim
      const settle = (state: "merged" | "refused" | "superseded" | "pending", detail: { error?: string | null; receipt?: string | null; countAttempt?: boolean; from?: "claimed" | "firing" } = {}) =>
        store.settleMergeIntent(intent.id, claim.generation, state, clock(), { from: "claimed", ...detail });

      // The live grant, re-read AFTER the claim (finding 7): revocation,
      // narrowing, or any term drift supersedes rather than merges.
      const live = store.publicationGrantFor(options.repo);
      if (live === null || live.merge !== true || mergeTermsHash(live) !== termsHash || intent.headSha !== headSha) {
        settle("superseded", { error: "the grant or the head moved since this intent was written" });
        continue;
      }

      const queue = await proveNoMergeQueue(exec, grant.githubRepo, grant.base);
      if (!queue.ok) {
        settle("refused", { error: queue.why });
        report.refused++;
        pagePerson(
          publication, queue.why,
          "PR #" + prNumber + " will not auto-merge",
          queue.why === "merge-queue"
            ? "The base branch requires a merge queue - out of this release's scope. Merge it on GitHub, or lift the queue and run: toolroll publish rearm " + prNumber + "."
            : "The branch's protection could not be READ well enough to prove no merge queue governs it - auto-merge stays paused. Check access, then run: toolroll publish rearm " + prNumber + ".",
        );
        continue;
      }

      // One fresh, winning observation - green on the EXACT publication head.
      const seen = await observeOne(store, exec, clock, grant.githubRepo, prNumber);
      if (!seen.ok) {
        if (seen.why === "draft") {
          settle("refused", { error: "draft" });
          report.refused++;
          pagePerson(
            publication, "draft",
            "PR #" + prNumber + " is a draft",
            "Drafts never merge themselves. Mark it ready on GitHub, then run: toolroll publish rearm " + prNumber + ".",
          );
        } else if (seen.why.startsWith("pr-")) {
          settle("superseded", { error: seen.why });
        } else {
          settle("pending");
          report.problems.push("PR #" + prNumber + ": " + seen.why);
        }
        continue;
      }
      if (seen.headSha !== headSha || seen.state !== "passing") {
        settle(seen.headSha !== headSha ? "superseded" : "pending", {
          error: seen.headSha !== headSha ? "the head moved" : "CI is " + seen.state + ", not green",
        });
        continue;
      }

      // The linearization point (E1): claimed -> firing as a DURABLE CAS
      // re-proving grant terms, head, and basis-specific authority in one
      // transaction. Before it commits, a revocation wins; after, the
      // issued call is one-shot and no revocation demotes it.
      const fired = store.fireMergeIntent(
        intent.id, claim.generation,
        { repo: options.repo, headSha, liveGrantTermsHash: mergeTermsHash(live), graceMs: FIRING_GRACE_MS },
        clock(),
      );
      if (!fired.ok) {
        if (fired.outcome === "waiting-human") {
          report.skipped++;
          pagePerson(
            publication, "waiting-human",
            "PR #" + prNumber + " waits for your go-ahead",
            fired.why + " - when you want it merged: toolroll publish merge " + prNumber + " --as <you> --token <t>.",
          );
        }
        continue;
      }

      const merged = await exec(
        "gh",
        [
          "pr", "merge", String(prNumber),
          "--repo", grant.githubRepo,
          "--" + method,
          "--match-head-commit", headSha,
          ...(grant.mergeDeleteBranch === true ? ["--delete-branch"] : []),
        ],
        { timeoutMs: EXEC_TIMEOUT_MS },
      );

      if (merged.code === 0) {
        store.transact(() => {
          settle("merged", { receipt: "merged " + headSha.slice(0, 12) + " at " + clock().toISOString(), countAttempt: true, from: "firing" });
          store.recordPublicationRemoteState(publication.id, "MERGED", clock());
          store.resolveCiEpisodes(grant.githubRepo, prNumber, null, clock());
        });
        report.merged++;
        store.resolveEpisodes(`merge-attn:${publication.id}`, clock());
        page(
          publication,
          "merge:" + publication.id + ":merged",
          "merged: PR #" + prNumber,
          (publication.prUrl ?? grant.githubRepo) + " - " + method + " of " + headSha.slice(0, 12) + ", under the merge terms you approved.",
        );
        continue;
      }

      // NEVER classify from the exit code alone (only auth=4 is distinct):
      // re-read structured state and let the PR say what happened.
      if (merged.code === 4) {
        settle("refused", { error: "credential", countAttempt: true, from: "firing" });
        report.refused++;
        pagePerson(
          publication, "credential",
          "PR #" + prNumber + ": gh is not signed in",
          "The merge acts as this machine's GitHub account, and it could not authenticate. Run gh auth login, then: toolroll publish rearm " + prNumber + ".",
        );
        continue;
      }
      const after = await observeOne(store, exec, clock, grant.githubRepo, prNumber);
      if (!after.ok && after.why === "pr-merged") {
        settle("merged", { receipt: "merged (confirmed by re-read after an ambiguous exit)", countAttempt: true, from: "firing" });
        report.merged++;
      } else if (!after.ok && (after.why === "draft" || after.why.startsWith("pr-"))) {
        settle(after.why === "draft" ? "refused" : "superseded", { error: after.why, countAttempt: true, from: "firing" });
        if (after.why === "draft") report.refused++;
      } else if (after.ok && after.headSha !== headSha) {
        settle("superseded", { error: "the head moved during the attempt", countAttempt: true, from: "firing" });
      } else if (intent.attempts + 1 >= MERGE_MAX_ATTEMPTS) {
        settle("refused", { error: firstLine(merged.stderr) || "the merge was rejected", countAttempt: true, from: "firing" });
        report.refused++;
        pagePerson(
          publication, "rejected",
          "PR #" + prNumber + " would not merge",
          (firstLine(merged.stderr) || "GitHub rejected the merge") + " - likely branch protection, required reviews, or a conflict. Fix the cause, then run: toolroll publish rearm " + prNumber + ".",
        );
      } else {
        settle("pending", { error: firstLine(merged.stderr) || "transport", countAttempt: true, from: "firing" });
      }
    } catch (error) {
      report.problems.push("publication " + publication.id + ": " + (error instanceof Error ? error.message : String(error)));
    }
  }
  return report;
}
