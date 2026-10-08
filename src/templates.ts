/**
 * The template library (adoption track, step 2) — common work shipped as
 * STATIC DATA that renders into editable, UNAPPROVED drafts.
 *
 * What a template is: a pre-filled form. What it is not: automation with
 * authority. Applying one produces exactly the rows a manual filing
 * produces — through the same one door (proposal.ts), with the same
 * validators, landing unapproved — and the apply output says so in
 * capitals, because `--file` must never read as a yes.
 *
 * The Codex adoption review (finding 10) drew the v1 line: templates may
 * express ONLY what a task proposal or a scheduled flow can carry today. A
 * repeating template (v115: what a routine template was) makes a scheduled
 * flow whose schedule starts paused, and whose every firing waits for
 * approval under the project's rules. The two
 * use cases that imply separate authenticated authority — GitHub issue
 * intake (a grant) and CI babysitting (publish + the repair button) —
 * ship as RECIPES: they display the existing ceremonies, and cannot be
 * applied, because a template must never create a grant, enable
 * autonomous repair, or touch provider configuration.
 *
 * Deliberately no versioning story: an applied draft is a COPY. Editing
 * this library later changes nothing anybody filed.
 */

import type { AcceptanceCriterion } from "./scope.js";

export type TaskTemplate = {
  kind: "task";
  name: string;
  purpose: string;
  title: string;
  goal: string;
  outOfScope: string | null;
  touches: string[];
  /** v39: baked in, like every other term — a template ships a signed
   * rubric because it ships a scope, and a scope-producing road never
   * gets to omit one. */
  acceptance: AcceptanceCriterion[];
  /** The fields most installations change — shown in `show` and preview. */
  edit: string[];
};

export type ScheduledTemplate = {
  kind: "scheduled";
  name: string;
  purpose: string;
  /** The flow's name. */
  title: string;
  goal: string;
  outOfScope: string | null;
  touches: string[];
  acceptance: AcceptanceCriterion[];
  requirements: string[];
  schedule: string;
  costCeilingUsd: number | null;
  edit: string[];
};

export type RecipeTemplate = {
  kind: "recipe";
  name: string;
  purpose: string;
  /** Why this cannot be applied — the authority it would need. */
  why: string;
  steps: { say: string; run: string }[];
};

export type Template = TaskTemplate | ScheduledTemplate | RecipeTemplate;

export const TEMPLATES: readonly Template[] = [
  {
    kind: "scheduled",
    name: "nightly-deps",
    purpose: "keep dependencies fresh without surprise majors",
    title: "Keep dependencies current",
    goal:
      "Update dependencies conservatively: refresh the lockfile within existing semver ranges, run the full test suite, and summarize what moved in the handoff — plus anything notable you saw (majors now available, security advisories, packages that look abandoned). If the suite fails after the refresh, park with the failure rather than pinning things until it passes.",
    outOfScope:
      "No major version bumps. No edits to application code beyond what the lockfile refresh itself forces. No changes to CI configuration.",
    touches: [],
    acceptance: [
      { id: "c1", statement: "The full test suite passes against the refreshed lockfile.", how: null, evidence: ["check"] },
    ],
    requirements: [],
    schedule: "daily:03:30",
    costCeilingUsd: null,
    edit: ["schedule", "goal (name your package manager if it is unusual)", "ceiling (a weekly dollar cap)"],
  },
  {
    kind: "scheduled",
    name: "test-coverage",
    purpose: "grow the test suite one module at a time",
    title: "Test one overlooked module",
    goal:
      "Pick ONE module that is under-tested — no tests at all beats thin tests — and write focused tests for its observable behavior: inputs, outputs, and failure paths, not implementation details. One module per firing, then stop. If the module cannot be tested without refactoring it, do not refactor: park with a note naming the obstacle so a human can decide.",
    outOfScope: "No refactoring of the code under test. No snapshot tests. No changes outside the chosen module's test file(s).",
    touches: [],
    acceptance: [
      { id: "c1", statement: "The chosen module's new tests pass and exercise inputs, outputs, and failure paths.", how: null, evidence: ["check", "changed-path"] },
    ],
    requirements: [],
    schedule: "daily:05:00",
    costCeilingUsd: null,
    edit: ["schedule", "touches (pin the test directory layout if yours is unusual)"],
  },
  {
    kind: "scheduled",
    name: "docs-drift",
    purpose: "keep the README and docs telling the truth weekly",
    title: "Keep documentation accurate",
    goal:
      "Read the README and any docs/ pages against the code as it is today. Fix what has drifted: commands that moved, flags that changed, features that shipped undocumented, claims that stopped being true. Prefer deleting a stale claim over guessing a new one. Summarize every correction in the handoff.",
    outOfScope: "No restructuring or rewriting for style. No new documentation pages. No changes to code.",
    touches: ["README.md", "docs/"],
    acceptance: [
      { id: "c1", statement: "Every correction made is named in the handoff.", how: null, evidence: ["manual-review"] },
    ],
    requirements: [],
    schedule: "every:10080",
    costCeilingUsd: null,
    edit: ["schedule (every:10080 is weekly)", "touches (add wherever else docs live)"],
  },
  {
    kind: "task",
    name: "lint-sweep",
    purpose: "one clean sweep of mechanical violations",
    title: "One lint-clean sweep",
    goal:
      "Run the project's linter and typechecker. Fix every mechanical violation — unused imports, obvious type narrowings, formatting the tools can prove — and nothing judgment-shaped: no renames for taste, no restructuring, no behavior changes. If a rule demands a behavioral fix, list it in the handoff instead of fixing it.",
    outOfScope: "No behavioral changes. No disabling or reconfiguring rules. No dependency changes.",
    touches: [],
    acceptance: [
      { id: "c1", statement: "The linter and typechecker report no mechanical violations left to fix.", how: null, evidence: ["check"] },
    ],
    edit: ["goal (name your lint command if it is not the obvious one)", "touches (fence off generated code)"],
  },
  {
    kind: "recipe",
    name: "issue-intake",
    purpose: "labeled GitHub issues become local proposals",
    why:
      "Intake needs a GRANT — an authenticated act binding a GitHub repo, a label, and who may be listened to. A template cannot and must not create one.",
    steps: [
      {
        say: "Grant intake for one repo + label (authenticated; restates its terms):",
        run: "toolroll intake grant --repo <path> --github owner/name --label agent-ok --as <you> --token <t>",
      },
      { say: "See what would be imported, creating nothing:", run: "toolroll intake preview --repo <path>" },
      {
        say: "Create the missing proposals — local, unapproved, deduped; bodies are never imported:",
        run: "toolroll intake run --repo <path>",
      },
    ],
  },
  {
    kind: "recipe",
    name: "ci-babysitter",
    purpose: "watch published PRs and draft repairs when CI goes red",
    why:
      "CI repair is deliberately a BUTTON on the run page while an observed red episode is open — one unapproved draft per PR, never an autonomous loop. A template cannot arm it.",
    steps: [
      { say: "Publication status and observed check states:", run: "toolroll publish status --repo <path>" },
      { say: "The ranked review queue (console): observed-passing first, silence labeled as silence:", run: "open /review" },
      {
        say: "When a PR's checks are observed red, the run page offers 'draft repair task' — one click files ONE unapproved draft bound to the failing head.",
        run: "open /r/<run-id>",
      },
    ],
  },
];

export function templateByName(name: string): Template | null {
  return TEMPLATES.find(one => one.name === name) ?? null;
}
