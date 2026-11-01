# Background

How Toolroll got here: early milestones, the 0.4.0 status note, what it is
not competing with, and credits. The current release notes are in the
[CHANGELOG](../../CHANGELOG.md).

## Status at 0.4.0

**0.4.0 — schema v29, suite 1,369.** The M4 loop plus tournaments, the
live peek and live transcript, chains and queue ordering, per-worker
queue columns, external dispatch, merge grants with observed-green CI
and a fourteen-transition merge machine (per-merge human authorization
by default; a signed automerge mode may substitute for exactly that
yes, re-proved at the moment of firing), the phone PWA with
zero-dependency push, the attended core (governed live sessions:
signed terms, mid-session conversation, crash custody, continuation,
N parallel sessions per worker), the attested runtime (four providers
— Claude, Codex, OpenRouter, Gemini — the last admitted by versioned
conformance, never a registry row), labeled cross-runtime comparisons
with honest per-lane money, operating modes with their daily rails,
the artifact-only reviewer, and multi-user instances with invite
links, roles, and a People screen. Project access now supports viewer/operator
invitations restricted to selected repositories, with an action ledger for
people and unattended work. See [Project access and action ledger v1](../PROJECT_ACCESS_LEDGER.md)
for its permissions, history coverage, and migration behavior.

[Automatic approvals](../AUTO_APPROVAL.md) explains the signed project policy for scope filings, unchanged plans, reviews, repairs, and merges.
Earlier arcs shipped behind their own adversarial review rounds;
docs/PROGRESS.md records those findings.

**M4 built.** The whole loop runs: `toolroll watch` (or `daemon
install` — no crontab) dispatches approved work, spends nothing while idle,
survives crashes by recovering exactly its own predecessor's claims, and
stops taking work on the first signal. Failures are typed — strikes,
doubling backoff, three-strike stalls a person exits with `task requeue` —
and every provider spawn is stamped before it spends, so cost is measured,
never asserted. CI on published PRs is watched as episodes that never call
silence green. The whole unattended stretch is one test,
[`src/unattended.slow.test.ts`](../../src/unattended.slow.test.ts): queue twelve, walk
away, come back to PRs. Architecture: [`docs/DESIGN.md`](../DESIGN.md);
the item-by-item ledger: [`docs/PROGRESS.md`](../PROGRESS.md).

## Milestones

| | | |
|---|---|---|
| M0 | discovery, graph adapters, leases, CLI | `npx toolroll` shows what is in flight — **useful before it is autonomous** |
| M1 | runners, worktrees, first builder | one task goes queued → branch → commit unattended |
| M2 | capability probes, secrets, briefing | fill one gap, three tasks start |
| M3 | decisions, evidence, web view | a park renders as one screen, answerable on a phone — **and it does, executably** |
| M4 | the loop | **queue twelve, sleep, wake to PRs — with near-zero idle spend** |

Deferred until M4 earns them: the spatial board, multiplayer, in-browser terminals, Postgres, RBAC.

M4 is the product. M0 is what makes anyone install it long enough to reach M4.

## Not competing with

[**agor**](https://github.com/preset-io/agor) owns the execution-plane category and does it well — browser UI, six runtimes, multiplayer, a spatial board. It optimizes for a team steering agents *live*; we optimize for nobody being awake. It is BSL 1.1; this is MIT.

[**firstmate**](https://github.com/kunchenguid/firstmate) proves the orchestrator role works as conventions plus tmux, with no UI and no schema. Its event-driven bash watcher is where the zero-token supervision rule came from. Our bet is that the same role is better with a typed decision record and a browser you can answer from.

## Credits

Every sandbox Toolroll runs is [Anthropic's sandbox-runtime](https://github.com/anthropics/sandbox-runtime) (Apache-2.0), used as a dependency; see [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).

The workflow this formalizes comes from [Jason Ku's agentic engineering session](https://youtu.be/Ukju3maxbEQ) and his [`agents-md-snippets`](https://github.com/jasonku09/agents-md-snippets), plus Kun Chen's `treehouse`, `no-mistakes`, `gnhf`, `tasks-axi`, and `axi`. The design was reviewed adversarially by Codex; the appendix in `docs/DESIGN.md` lists every claim that review falsified, because the corrections are more useful than a clean spec would have been.
