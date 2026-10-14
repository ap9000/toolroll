# Fleets and trackers

## See what is in flight

**Sixty seconds to first value.** No init, no daemon start, no wizard, no OAuth app.

```sh
npx toolroll ~/code     # or: git clone … && npm install && npm run dev -- ~/code
```

It walks the filesystem for `.git` and reads every repo through the `git` credentials already on your machine, then shows what is in flight:

```
10 branches in flight across 24 repositories

vamarketplacenew                   main
  feat/wise-payouts                upstream gone       4d ago
  feature/public-api-v1            ahead 17            1mo ago
  api-pricing-impl                 behind 84           2mo ago

oddcircle                          redesign/instrumentation-cash-flag
  main                             ahead 3, behind 56  23d ago
```

No agent has run. Nothing has been configured, written, or installed. Every other tool in this space starts from an empty database it expects you to fill. `--json` emits the same thing as `{ scannedAt, roots, repos }`, because half the intended audience is an agent.

Reads are priced before they are made. Listing refs is O(refs) and finishes in milliseconds; `git status` is O(working tree) and was measured at over two minutes on a real repo, so it is off by default behind `--dirty`. Computing ahead/behind walks history — 22s cold on a 304MB repo — so it is bounded at 5s and degrades to a branch list that says what it withheld. Every call goes through `--no-optional-locks`, so a scan never takes the index lock from an editor you have open.

`toolroll pulls` answers the narrower question of what is waiting on a person, and `toolroll graph` says which work graph is already here:

```
Work graph — detected in your repos

▸ beads          2 repos · 47 ready · native deps · runtime ok (1.4.0)
  GitHub Issues  112 open · native deps · 2.67.0 too old, needs 2.94.0

Suggested: beads — the only work graph in your repos, and its runtime answers.
Nothing is enrolled, and detection grants nothing.
```

Backends are chosen by looking rather than asking, but **detection is not authorization** — finding a populated tracker says it exists, not that anyone wants an agent scheduling or closing what is in it. Data and runtime are detected separately, so a tracker whose binary is missing is reported as real work this machine cannot dispatch, which is a visible gap at 9am instead of a dead loop at 3am. Two populated trackers means neither is chosen: task count is not authority, and the biggest one may be the abandoned one. Where a fact is not established — Backlog.md's dependency edges, for instance — it is marked unverified and **fails closed**, because a private dependency graph other tools cannot see is shadow data.

**Nothing is ever installed for you.** `bd init` stages files, edits agent integrations, and can create a commit, so Toolroll prints the command and its side effects and lets you run it.

## Steering a fleet, not just a task

Everything below ships in 0.4.0:

- **The queue screen** — every worker's up-next list as columns, like a
  music queue: drag to reorder, drag into a worker's column to reserve a
  task for it (each column wears an editable theme note), top is taken
  first. A worker drains its own column, then the shared queue. The
  reservation is enforced in the claim primitive itself — the wrong
  worker's claim gets a typed `reserved` refusal, however it asks.
- **Chains and "this one first"** — `task block/unblock` wires
  dependencies (cycles refused), "starts after" on the filing form,
  `task next` moves work to the front of its own queue. Scheduling,
  never authority: approvals are untouched by any of it.
- **The live peek** — a running build's page shows what is changing in
  its checkout right now (names and counts, never contents), through a
  native reader that executes nothing — no git command ever runs
  against an agent-controlled worktree.
- **External dispatch** — enroll a GitHub repository with an explicit
  dispatch grant and its labeled issues become ordinary local tasks:
  scoped and approved HERE (issue bodies are never imported — a tracker
  anyone can write to is a prompt-injection surface), built unattended,
  answered back with a PR-link comment under exactly the write classes
  you granted. An issue closed mid-build can never publish: the
  completion transaction disowns it, keeps the branch as evidence, and
  says so. Done stays done — remote closure never regresses a completed
  dependency. Revisions ride review comments: mark up the finished
  diff (or let granted reviewers do it from the PR) and seal the batch
  into one new approval-bound task.
- **Operating modes** — a per-repository, password-signed, expiring
  envelope that pre-authorizes the SIGNER'S OWN future acts: your
  filings approve themselves the moment you file them, merges fire themselves when CI
  is seen green on the exact authorized commit (only through a merge
  grant, never around one), and daily run/dollar rails bound the spend.
  Every term renders in words at the signing ceremony — including the
  sentence "your signed-in browser session becomes a spend credential
  for this repository" — and ending it all is one click, for any
  approver, at any moment. No mode signed means nothing changes: every
  act keeps its own ceremony, the default forever.
- **The reviewer** — an agent pass over a finished build's sealed diff,
  and nothing else: no worktree, no repository access — the patch is
  re-verified against its recorded hash, comments are proven
  patch-local, and they land beside your own for YOU to prune and seal
  into a revision task. A revision keeps the source's contract — its
  goal, exclusions, touches, exact rubric, quality,
  permission posture, and budget ceiling — however the installation's
  defaults have changed since, re-resolves its agents for a fresh
  approval, and inherits no approval, session, publication, or merge
  grant (the policy is [docs/REVISION_TERMS.md](../REVISION_TERMS.md)).
  One successful review per build, ever; a mode
  can run one on every finished build automatically. A review that
  fails or is interrupted may be retried EXPLICITLY — `task review
  <run>` again, or the task/result page's **Retry review** — at most
  twice (three root attempts in all). Each retry is a fresh request and
  a fresh reviewer admitted under the build's current sealed route with
  every sealed input re-verified; the failed attempts stay on record;
  a review that succeeded, or one still queued or running, is never
  retried; nothing retries by itself, and the source build is never
  rerun. A retry is an operator's act only: the mode's and the Strict /
  release scope's automatic review asks are one shot per build, and a
  replayed one is refused at request and again at admission, before any
  money.
- **People** — invite someone with a single-use link that pins their
  powers at mint (watch everything, or approve and act), see who is
  doing what, and remove access with one ceremony that actually severs:
  sessions, invites, and every mode they signed end together, while
  history stays attributed forever.
- **Scout tasks** — `task add … --report` (or the "scout" checkbox, or
  the lead's `propose_task` with `report: true`) files a task whose
  deliverable is a report, never a branch: once its scope is approved,
  a read-only session investigates the goal as a question and hands
  back a title, a summary, a document, and up to five follow-ups, each
  of which files as a task with one tap. The workspace is proven
  untouched before a byte of the report is read; a scout that changed
  anything gets nothing ingested.

## Writing to a tracker you already have

Detection tells you what is there; a grant is what lets anything be written to it.

```sh
toolroll enroll . --backend github-issues --paths owner/name   # shows the terms
toolroll enroll . --backend github-issues --paths owner/name --yes
toolroll grants          # what has been granted, and to what
toolroll revoke .        # take it back

toolroll ready --backend github-issues     # reads need no grant
toolroll task add "..." --backend beads    # writes do
```

The grant is not a boolean. It records which paths or repositories may be touched, which mutation classes are allowed, which tasks are covered, which credential scope applies, and whether the writes will turn up in `git status` — that last one asked of `git check-ignore` rather than assumed. Two defaults carry weight: only tasks Toolroll created or was given, because enrolling a repo with four hundred open issues is not volunteering all four hundred; and `close` is withheld, because closing what somebody else filed is not the same act as transitioning your own task.

Every backend goes through the same contract, and the authorization wraps it rather than living inside each adapter — an adapter written later inherits the check instead of having to remember it.

**Edges are never emulated.** beads has native dependencies and they are used. This GitHub adapter has not confirmed the dependency endpoint against a live repository, so `addEdge` refuses rather than storing a graph only Toolroll can see — one that would read as ready to every human on the repo. That is the design's rule, and the refusal says so.

The beads adapter is built to beads' own documentation and exercised against a stubbed runner; it has never run against a real installation, because `bd` was not present on the machine it was written on. Commands whose flags could not be established — a general status update, in particular — refuse rather than guess.

The materialised snapshot M0 promised shipped as **external dispatch**: a `sync` pass mirrors a tracker's nominated issues into the queue as ordinary local tasks (titles only, validated; bodies never), so the scheduler's hot path never touches the network — see below.
