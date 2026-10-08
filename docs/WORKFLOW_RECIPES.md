# Workflow recipes

Open **Recipes** in the console to create a reusable recipe, use one you saved,
or customize a starter. Recipes use the same tasks, scope approval,
planning, evidence, review, scheduler, and recovery paths as other work.

<img src="media/ui/workflow-recipes.png" alt="Recipe library with six starters and a saved project recipe." width="920">

## Create a recipe for work you do often

Choose **Create a recipe**, give it a name, describe the instructions, and say
what success looks like. Keep a fixed scope for repeatable work, or open
**Ask something each time** to add questions for the parts that change.

For example, a regression-test recipe can use:

- Name: `Test {{module}}`
- Instructions: `Add regression tests for {{module}}, covering {{scenario}}.`
- Questions: key `module`, label “Which module?”; key `scenario`, label “Which
  behavior should the tests cover?” A default answer is optional.
- Success check: `The tests cover {{scenario}} in {{module}} and pass.`

**Insert into instructions** adds the question at your cursor so you do not
have to type the placeholder. Inputs can appear in the name, description,
instructions, exclusions, and success-check statements. Allowed paths and
check commands stay fixed. Questions are for work details, not passwords,
credentials, or executable snippets. Up to eight questions are supported.

Choose **Preview recipe**, review the reusable definition, then **Save recipe**.
Saving starts no work. You can also open a task's **Reuse this scope as a recipe**
link, adapt its existing instructions, add questions, and save a copy.

## Kick off familiar work

<img src="media/ui/recipe-creator-run-mobile.png" alt="A saved recipe asks only which module needs tests before previewing a run." width="280">

Saved recipes appear above the starters, with recently used recipes first and
a search field. **Use recipe** opens a short form containing only that recipe's
questions. Fill in what changes this time, **Preview this run**, and create
the task. A fixed recipe needs no answers. The new-task screen also links
directly to your saved recipes.

Each use freezes its answers into a fresh scope. Reusing the recipe with another
module creates independent work; retrying the same preview returns the same
task. Questions, answers, and saved scope never grant project access or bypass
the existing approval policy. Teammates answer the same recipe in their own
sessions, with their own current project permissions.

For repeating recipes, the chosen answers stay fixed for every scheduled
firing. **Use recipe** creates another scheduled flow; pause or resume an
existing one from its flow (**Resume** on the canvas, or
`toolroll flows trigger pause|resume`). **Edit a copy** changes a new recipe, leaving previous
copies and work intact.

## Your first workflow

1. Open a project. **Understand this project** is a useful first run: it asks
   for a source-backed report and excludes code changes. Other starters cover a
   small feature, dependencies, test coverage, documentation, and lint/types.
2. Describe the result you want, what to leave alone, and any allowed paths.
   Keep the supplied success checks or specify your own evidence. Code workflows
   can plan first; repeating work reuses a previously approved scope.
3. Choose **Run once** or a daily, weekly, or interval schedule. Repeating work
   becomes a scheduled flow: a Build task step and a schedule whose standing
   order carries the task's terms. It supports an optional rolling seven-day
   dollar cap and runs one at a time, skipping while the last task is
   unfinished. The schedule starts paused; nothing repeats until you turn it
   on.
4. **Preview workflow** shows the steps, scope, proof, schedule, and current
   project/agent/worker setup. Previewing starts no agents.
5. Create the task or scheduled workflow. A matching signed policy can approve
   a one-time task filed by its signed-in signer. Otherwise approve the scope
   on the task page. Each task a schedule files waits for approval under the
   project's approval rules, like any other proposal. Existing publication
   authority still applies separately.

Work can be created while a worker is offline; the preview explains that it
will wait. The created task or flow page remains the place to inspect evidence,
handle decisions, stop/resume work, or pause a schedule. The recipe library
links the twelve most recent workflows to those same durable records.

## Reuse and share

<img src="media/ui/workflow-recipe-mobile.png" alt="Phone recipe editor with a named workflow, goal, and preview action." width="280" align="right">

**Save as a project recipe** saves the exact preview without creating work.
People with access to that project can reuse it; viewers can browse but cannot
save or launch. Saved copies are immutable. To change one, customize it and
save a new copy. The library shows the newest 100 saved copies.

A task's **Reuse this scope as a recipe** link copies its goal, exclusions,
allowed paths, and acceptance criteria into the editor. This is a new work
definition: dependencies, credentials, approvals, provider settings, budgets,
and publication grants are not copied. Review the new project's policy before
creating work.

**Export recipe JSON** creates a portable work definition: version 1 for fixed
recipes and version 2 for recipes with questions. Paste it
under **Import a shared recipe** in another project to customize and preview
it there. Imports carry no project identity, permissions, credentials, or
approval authority; unsupported fields and versions are rejected. The text
you explicitly put in goals, checks, and exclusions is included in the export.

## Creation and recovery guarantees

Previews are stored on the server for 30 minutes and bound to the actor,
canonical project, and a digest of the exact definition. Editing makes a fresh
preview. Creating work atomically records the task or scheduled flow, optional existing
policy approval, launch receipt, and action-ledger event. Retrying the **same
preview** after a double click, lost response, or controller restart returns
the same work. Deliberately making a new preview can create another workflow.
An expired preview cannot create new work; existing receipts remain replayable.

Every mutation rechecks current project access. Cookie requests also require
CSRF and the current open-project revision. Unknown JSON fields, disguised
text, malformed schedules, unsupported evidence, oversized documents, and
excess success checks are refused. There are at most 30 unused, unexpired
previews per actor.

Recipes use schema 56's `workflow_recipe` and `workflow_preview` tables. Schema
57 adds an index for recently used recipes and fences older readers before
question-based recipes are saved. Existing version-1 documents, digests, and
launch receipts are preserved. A database already marked current but missing
its recipe/receipt tables is refused instead of silently recreating history.
Back up and follow the existing coordinated controller upgrade process; older
workers must not write a newer schema.

## Current boundaries

This is a guided layer over the existing work engine. It does not add arbitrary
conditional branches, external service triggers, credentials in templates, or
a second execution engine. Report recipes and workflows requiring a fresh
plan run once; repeating workflows produce code changes from approved scope.
Saved recipe editing creates a new copy rather than modifying running work.

Readiness is a current configuration summary, not an execution certificate.
The scheduler and worker recheck actual authority, availability, budget,
containment, and completion requirements at their existing boundaries.


## Install a prepared commit as the attempt (no agent)

When the change already exists as a commit, name it on the scope and the
machine does the rest: it proves the commit descends from the task's base,
brings the worktree to its tree, commits, seals the diff from the original
base, runs the approved gate and asks for the review. No agent is dispatched
and nothing is spent on one.

```
toolroll task scope <id> --repo <path> --goal "Install commit <sha>: …" --candidate <sha> --acceptance "…"
toolroll task approve <id> --yes --digest <shown> --as <you>
```

The commit must be reachable in the repository (fetch it first) and must
descend from the task's base. On a later attempt, re-scope with the new
commit and requeue; the branch keeps the earlier attempt underneath.

## Run the check again on the same commit

A gate that failed on a flaky or unrelated test does not need a rebuild:

```
toolroll task regate <id> --as <you>
```

The machine files a new attempt whose prepared candidate is the last
attempt's exact commit, checks it out without an agent, seals a fresh
receipt and proof, and asks for the review. Under a mode that allows
automatic repair, a failure the change did not cause (the whole check timing
out, or an untouched test's own timeout) reruns once on its own; a second
failure on the same commit goes to a person.

## Correct a rejected result on the same filing

A gate that failed, a review that contradicted, or a proof that read refuted
does not need a new task. Rewrite the scope if the candidate changed, approve
it, and requeue: the next attempt continues on the task's own branch, and the
sealed diff still spans from the original base.

```
toolroll task scope <id> --repo <path> --goal "Bring the tree to commit <sha> …" --acceptance "…"
toolroll task approve <id> --yes --digest <shown> --as <you>
toolroll task requeue <id> --as <you>
```

Write the goal for a continuing branch: "make the tree equal commit <sha>",
never "confirm the branch starts at the base" — the branch already carries the
earlier attempt. A result that was accepted or published is final for that
filing; change it through a revision or its pull request.

## Install a verified candidate (one action)

From the builder's worktree of a run whose proof reads verified and whose
independent review upheld every signed criterion:

```
node scripts/deploy-browser.mjs --run <builder run id>        # dry summary
node scripts/deploy-browser.mjs --run <builder run id> --yes  # drain, back up, rehearse, swap, finish
```

The script refuses anything less than that evidence, journals each phase in
`~/.config/toolroll/staged-upgrades/browser-<sha>-<id>/deployment.json`,
restores the previous service definition if the new one does not come up,
and resumes with `--stage <dir> --phase <name>`. Open the console and look at
a result page afterwards; the script checks that it answers, not how it looks.
