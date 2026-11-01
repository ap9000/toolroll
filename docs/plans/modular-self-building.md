# Modular, self-building Toolroll

Status: plan, agreed with the owner 2026-10-29. Sources: bb ("the agent IDE that builds itself",
github.com/get-bb/bb, MIT), read by Claude and by Codex independently; this plan merges both. Follows
docs/plans/eval-harness.md and depends on its phase 1 shipping first.

## What "builds itself" means, and what we take from it

bb is ordinary source development done inside bb: every feature is reachable from the app, the CLI and the SDK, so an
agent drives bb exactly as a person does; threads coordinate other threads; each checkout runs its own instance with its
own data and ports; ~50 features are plugins on the same API core uses. There is no autonomous self-improvement.

Toolroll already releases itself (src/release.ts), has leads that inspect and propose work (src/lead-tools.ts), flows
that file tasks (src/flow-starters.ts), and project lessons (src/project-learning.ts). The gap is not "can it build
itself" but **does it measurably get better**: fewer repeated failures, fewer owner interventions, lower cost per
successful task. That is what this plan aims at.

## Principles we adopt

1. **One implementation per action.** Console, CLI, lead tools and any extension call the same function for an action;
   one contract-case table runs against every surface. Parity means the same semantics and explicit refusals, not the
   same privileges (a lead is still refused what only a person may do). Precedents: src/result-actions.ts, the route
   policy in src/server/README.md.
2. **Label agent-callable surface.** New agent- or extension-callable functions are `experimental_` (or
   `internal_` for first-party-only plumbing) with a short entry in docs/agent-api-audit.md: callers, authority, failure
   behaviour, stabilisation criteria. Prefixes are bookkeeping, not security. Keep the file small; stabilise or delete.
3. **Simplicity red flags in review.** Added to the Codex review prompt and AGENTS.md: new registries, managers,
   coordinators or adapters with one caller; old and new paths kept alive together; file splits that add places to look
   without deleting an old path.
4. **Modular only when proven.** A module counts as separate when a CI job copies it out of the repo and it typechecks,
   tests and builds against the published contract alone (bb's forkable-plugin check). Folder structure alone proves
   nothing.
5. **Policy decides, execution enforces.** Trusted policy issues bounded grants; execution code checks them at use time.
   No new service or process split.

## What we do not copy

bb's local API is unauthenticated by design and its plugins run as trusted code inside the app. Toolroll treats agent
output and checkouts as untrusted, so: no marketplace, no general plugin manager, no unsandboxed extension code, no new
workflow language, no automatic review/repair loop, no big-bang monorepo split.

## Trust tiers for extensions

| Tier | What | How it is trusted |
|---|---|---|
| Core | Approvals and ceremony (src/scope.ts), the fence (src/agent-fence.ts), release authority and auto-approve (src/release-authority.ts, src/release-auto.ts), deploy (src/deploy-gate.ts), secrets, schema, git hardening, evidence sealing | Never an extension. Reviewed as core |
| Data | Templates and recipes: flow starters, check presets, lead skills, read-only card layouts | Validated as data against a schema; never executed |
| Code (later, on demand) | Provider dialects, integration transports | Run fenced like a build: no plane DB, keys or broad secrets; capabilities scoped to project, operation, network destinations and budget through src/tool-broker.ts; artifact digest and version pinned in a protected record and bound to the owner's approval; a new digest needs approval again |

Extension-reported success or authority is never trusted: the release check's "test code is trusted for coverage"
exception does not extend to extensions.

## Stages

1. **Ship eval-harness phase 1 (0.9.77).** In progress.
2. **Toolroll works on itself, measurably.** Run eval-harness phase 2 through Toolroll's own lead and tasks, with
   auto-approve on. Success measure: one recurring failure goes from detection to a regression case, a scoped fix and a
   verified release through Toolroll's own flows, with the owner notified rather than asked. Track owner interventions
   and cost per successful task before and after.
3. **First data module: flow starters.** Move the starter templates (src/flow-starters.ts, src/flow-gallery.ts) to
   schema-validated data files loaded through one loader that core's own starters also use. Grants, scheduling
   authority, task admission and release actions stay core. Add contract cases only for real surface gaps found.
4. **First code-side boundary: one provider dialect or one integration transport** (src/provider.ts / src/acp-agents.ts,
   or src/slack-api.ts / src/flow-triggers.ts): dialect, decoding and discovery move behind a typed contract; invocation
   admission, isolation, budgets and custody stay core. Add the copy-out CI check for it. An SDK appears only when a
   second consumer needs it.
5. **Per-worktree dev consoles.** `toolroll dev` starts a console for a checkout on ports and a data folder derived from
   its path, so agents verify console changes without touching the owner's live console.
6. **Outside code extensions:** only if there is real demand, and only on the Code tier above.

operate.ts (12k lines) and store.ts (25k lines) shrink as boundaries are extracted, never as a standalone refactor.

## Decisions

| Decision | Recommendation | Status |
|---|---|---|
| Extensions from outside the project | Not now; data-only first; core never becomes an extension | Recommended, awaiting owner |
| Stage 2 (Toolroll on itself, owner notified not asked) as the arc after 0.9.77 | Yes | Recommended, awaiting owner |
| First extraction | Flow starters (data), then one provider or integration | Agreed (Codex's ordering) |
| Adopt principles 1–5 in AGENTS.md and the review prompt | Yes, with stage 3 | Agreed |
