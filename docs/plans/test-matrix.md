# The test matrix: each test once, where it adds something

Status: plan, approved by the owner 2026-10-30 ("no unnecessary tests"). To be critiqued by Codex, then built as 0.9.80.

## Why

A normal product change ran the full unit suite about seven times: PR CI (Linux Node 22/24, macOS Node 22/24), the Mac
release check, the tag's Publish workflow (macOS Node 22/24, 20–45+ min, twice over the 45-minute publish limit), and
main's push CI again. Each run proves nothing the previous one didn't when the tree is identical.

## Stages

| Stage | Runs | Doesn't run |
|---|---|---|
| Pull request (GitHub) | Lint, typecheck, build; unit shards on Linux Node 24; unit shards on macOS Node 24. Area lanes only when their files change: Windows containment; Linux fence + cgroup; git lanes (floor + 2.47). Node 22 lanes for dependency/migration changes | Node 22 otherwise (nightly). Area lanes when untouched report "skipped — not affected" as success for the required name |
| Release check (owner's Mac) | Scripted browser/flow journeys; real-model journeys only when model-facing code changed (existing rule); upgrade path only when runtime/migrations/dependencies changed (existing version-only rule) | The unit suite, when the PR's macOS unit shards passed on the exact head tree, with matching execution context (Node major, OS), selected by the plane from GitHub (Actions app, ci.yml, main-triggered run rules) — person-approved road only until report provenance is protected (isolated-checks stage 3) |
| Tag / Publish | Tag tree == merged tree == tested tree verification; npm publish with provenance; GitHub release | The tag macOS test legs |
| Push to main | Typecheck + build when the merge commit's tree equals the PR head tree that passed | The full CI rerun |
| Nightly (main) | Everything: both Node versions on Linux and macOS, all area lanes, the full release check | — |

## By kind of change

| Change | Pull request | Release check |
|---|---|---|
| Docs/CHANGELOG only | Docs lint | Nothing to test |
| Tests only | Unit (Linux + macOS) | Only the affected journeys (existing targeted recheck) |
| Product code | Unit (Linux + macOS) + touched area lanes | Journeys; real-model if model-facing |
| Migration / dependencies | + Node 22 lanes | + upgrade path |
| CI / release scripts / test infrastructure | Everything | Everything; always a person's approval |

## Rules that keep it safe

- Path rules live in the workflow; changing them is a CI change, which auto-approval refuses and a person approves.
- A lane skipped by path rules still reports its required check name, and only with a "not affected" decision computed
  from the PR's diff against its base by the workflow (never from candidate test output).
- Reuse requires identical trees and identical execution context, decided by the plane.
- Nightly runs everything, so anything a path rule skipped runs within a day; a red nightly holds releases (existing).

## Owner decisions

- Node 22 moves to nightly except dependency/migration changes: yes.
- Area lanes only when their code changes, nightly as backstop: yes.
- Drop the tag's macOS test legs: yes.
