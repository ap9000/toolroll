# Workbench feature map

[feature-map.json](feature-map.json) describes the workbench from a person's
point of view: a stable feature id, screen, how to reach it, expected screen
text (a regular expression), optional saved-state evidence, and a stand-in
scenario. Use ids with `verify.mjs --features welcome,new-task,help`.

`actions` and `keys` refer to the default bindings in
`tui/crates/toolroll-tui/src/keys.rs`. Palette-only actions have no key;
`r` sends a result back but retries a failed task. `x` stops retries or resumes
a task whose retries you stopped. Approval's `f`, help's `s`, and confirmation's
Enter are dialog keys, declared separately because the keymap deliberately
does not remap them. Never invent a shortcut for a palette-only action.

`intentionallyUnmapped` lists the remaining actions, their real keys and the
coverage gap. These entries are discoverable inventory, **not runtime passes**.
The contract test rejects a new action without either a feature or an explicit
exclusion, unknown actions, changed excluded bindings, and keys that do not
belong to a feature's actions. Rust tests still own custom presets and remaps.

Scenarios use the existing scripted-provider fixture. `success` writes a small
subtraction change; `agent-error` initializes then errors; `never-initialized`
passes auth detection but exits before a turn initializes. The latter exercises
automatic retry waiting and stop/resume. An agent error instead requires a
person to retry. Codex is signed out in every scenario. `smoke` and `signed-out`
file no tasks; `narrow` starts a real 60-column PTY.

Selecting a feature runs its prerequisites as needed; only requested features
receive verdicts. `dependsOn` declares same-scenario prerequisites. A failed prerequisite fails only
its dependents; independent features still run. Each exercised feature returns to
the base workbench screen first. JSON and Markdown
reports retain the actual screen evidence, elapsed time, launch timings,
outbound-table scan and cleanup errors. A failed or unavailable check is a
failure, never an implied pass. These are synthetic journeys, not agent output
from real work. Screen evidence is text; there is no terminal PNG renderer in
this harness.

**Open build shell** keeps the stable `take-over` action id and `t` binding for
existing keymaps. It opens a separate build copy, never the running agent.
**Watch running tasks** (`watch-running`, palette only) opens a grid with up
to four running/retry-waiting tasks, clearing old pinned results and list filters.
It is listed as a runtime harness gap; Rust tests cover its layout contract.
