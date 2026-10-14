# Toolroll: simple, elegant UI

Every UI change and UI review must include a simplicity pass before sign-off.

- Plain English: describe what happened and what the user can do. Avoid internal terms such as "proof disagrees" or "replace blocker" when a concrete explanation is clearer.
- Say it once. Remove duplicate status labels, instructional subtitles, and footer explanations. Use a short title, concise outcome, and one specific primary action.
- Show secondary detail on demand. Put advanced settings, diagnostics, provenance, and exact scope in the relevant disclosure; keep important risks and full approval terms visible before consent.
- Reduce unnecessary fields, choices, steps, and competing controls. Prefer familiar chat and form interactions. Do not add paragraphs to explain an overcomplicated flow.
- Preserve real functionality: truthful status, recoverable drafts, explicit approvals, keyboard access, readable contrast, and clear error recovery. Concision must not conceal a problem or weaken a safeguard.
- Verify actual desktop and phone viewports, including long content, empty states, and failures. Check alignment, overflow, fixed-control overlap, comfortable tap targets, and single-line short CTAs. Keep animations subtle and respect reduced motion.

Before finishing, ask: Can a first-time user understand the current state and next action without a paragraph? What text or step can be removed without losing useful information? Fix concrete findings and record concise before/after evidence, not an unsupported quality score.

Example: show **Plan ready**, a short outcome, and **Review plan**. Omit **Your next step**, **approve to start**, and a second sentence explaining the same action. Keep password and approval instructions inside the expanded review.

Carry this check into Toolroll task acceptance criteria and review feedback for UI work. Do not claim future agents followed it until their output has been inspected.

## Chat and UI consistency

- Treat chat as another way to use the same product, not a separate task system. Reuse the action that owns the change and the same saved state, history, permissions, and approvals.
- For every new user action, provide a chat proposal or a clearly labelled path to its existing control. A link is not a completed action; identify any remaining chat-only gap.
- Preserve task and result identity when revising. Show the exact feedback being submitted, reject stale cards, and prevent duplicate work.
- Verify both directions where affected: a chat action appears in the relevant screen, and changes made there are available to chat. Never ask for passwords or API keys in conversation.

## Lean verification

- Finished tasks expose a Ready status with their saved result, context and actual check status. There is no separate model-review stage or automatic review/repair/resubmission loop. The lead or user inspects the work and marks it complete or explicitly requests a revision. Missing or damaged saved material is a visible limitation, not a completion prerequisite; completing a task never rewrites check results. Deployment still requires the exact approved passing machine check and completion of the exact candidate.

- While working, run typecheck and the test files for what you changed (`npx vitest run src/foo.test.ts`, or `src/serve.*.test.ts` for `src/serve.ts`). Avoid `vitest related`: it follows imports, so a change to a core file like `src/store.ts` pulls in most of the suite. Add a small regression for each reproduced bug; reuse existing tests instead of adding overlapping suites.
- Don't run the whole unit suite. Toolroll's quick check (typecheck plus the tests named after your changed files) runs after the build, and the release check runs everything before a release.
- Keep tests deterministic and quick: wait for the event or inject a clock instead of a fixed time window, share fixtures through `test/` helper modules, and keep large test files split by area so related runs stay small.
- For UI work, use one end-to-end journey at desktop and one phone viewport: open the result, inspect changes, leave feedback, and create a revision. Include affected empty, long-content, and failure states. Add other viewport checks only for a concrete risk or explicit acceptance requirement.
- After a small copy or CSS repair, rerun the affected visual checks, not every browser script. Behavioral changes also require their focused tests.
- Let Toolroll run the unchanged approved verification command once at the final machine gate for the candidate. Do not repeat it in the lead inspection. A failed gate or changed candidate still needs fresh verification; never delete tests, add skips, or waive execution approvals or machine checks to save time.
- Reuse valid evidence for unchanged code and the same agent session where already supported. Do not build new orchestration just to reduce test overhead. No new agent time limits.
- Report the checks actually run, the exact candidate they cover, and any remaining gaps. Broaden checks only for a specific uncovered risk; say why.
- Screenshots and journey output go in the run's evidence folder, `evidence/` (ignored by Git), never anywhere else in the working tree. Never commit them: the handoff leaves images added under `evidence/` out of the commit and says so.

## Trust boundary (security work)

A build agent controls everything it can write: its checkout and `.git` (pointer file, config, hooks, refs, nested repos), `node_modules` and any note files in them, symlinks it creates, scripts it edits, and anything in the folders its fence allows. Treat all of it as attacker input.

- Never make a security decision from build-writable data. Take repositories, paths, owners, URLs, grants and digests from Toolroll's own records (the store, the plane's state folder, signed terms), and resolve them with `realpath` before comparing.
- Fail closed: when trusted state and what the checkout says disagree, or something can't be read, deny or refuse. Never widen a grant to make a case work.
- Never run `git` or a tool inside a build-controlled folder without the hardened environment (no system/global config, no includes, `core.hooksPath=/dev/null`, `core.fsmonitor=false`, `--ignore-submodules=all`, allowlisted env), and route every such call through the shared helper, not a direct spawn.
- Check at the moment of use, not only earlier: re-verify right before acting when a file can change in between.
- Every guard ships with a test that tries to get around it, run against the real sandbox where it applies (`sandbox-exec`, `codex sandbox`). Add each reproduced bypass to the attack suite so it stays fixed.

## Keep the installed tool current

- Always use the latest verified Toolroll build for new live work. Check the running UI, background worker and resolved CLI before dispatch; deploy an available newer verified build first. If the update is blocked, resolve the update instead of continuing ordinary tasks on the old runtime. A source commit, passing build or merge does not count as deployment.
- Deployment means the running UI and background worker use the same verified build and compatible database format, not merely that source was merged or a package was built.
- Check running build identity before real end-to-end work. Report version drift and update through the normal drain, backup, compatibility and health checks; never replace a runtime underneath active work.
- Prefer the latest verified candidate. Never bypass signing, approvals, process-exit checks or the passing native machine check to install a newer build. Report a blocked update plainly instead of claiming the installation is current.
- Use realistic sample feedback in user-facing screenshots. Keep long-content coverage, label synthetic journeys clearly, and do not present test filler as actual agent output.
- Before the first dispatch, verify the task branch starts at the intended verified base and required input documents are committed or supplied through a durable supported handoff. Toolroll itself moves a task branch to current main before an attempt only when it has no commits or changes of its own (fast-forward only, `git reset --keep`, recorded in `branch_base_move`); whole-task evidence then runs from the first base recorded after that move, and the task page shows the base. Never move a branch that has commits of its own by hand to shrink a review diff: its whole-task evidence stays pinned to its original base. Preserve that attempt and use an explicitly scoped corrective task with the right starting branch when needed.

## Operating Toolroll

This file is for changing Toolroll. To drive it as an agent (contract, skills, MCP, exit codes), see [docs/agents.md](docs/agents.md).
