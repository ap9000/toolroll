/**
 * The flow gallery: ready-made flows grouped by what they're for (Ship code, Keep it healthy, Hear from users,
 * Operations). Each says in one line what it promises, what it needs, and asks only what it must (a project,
 * a label, a schedule, a branch, a test command). A preview says in plain words what it will do and never do;
 * using one makes an ordinary flow (its zones), its triggers and any script it runs, together or not at all.
 *
 * A template is data — steps in the lead's vocabulary, trigger settings and scripts, with `{{ask.<key>}}`
 * where an answer goes and `{{script.<name>}}` where its script's name goes — so it can be written out as a
 * shared flow file later. Every one is built only from existing zone and trigger kinds, and none merges:
 * a pull request it opens waits for a person.
 *
 * A template that puts a connected tool to work names it (`tools`): a one-click service (ONE_CLICK) or the Figma
 * desktop app. Its research steps read that tool and only read; a build gets the project's tools as any build does.
 *
 * Every template without its own send zone can end with "Send me the result" (a "Send to me" zone before its end),
 * off unless asked for (`send-result: yes`): what the flow did reaches the person in their chat apps.
 */
import { createHash } from "node:crypto";
import { scanForSecrets } from "./evidence.js";
import { flowDefinitionOf } from "./flow-engine.js";
import { saveScript, validateScript } from "./flow-scripts.js";
import { isToolrollRepo, planeReviewSteps } from "./flow-starters.js";
import { addFlowTriggerTo, describeTrigger, githubRepoOf, scheduleFromWords, validateTriggerConfig } from "./flow-triggers.js";
import { choiceTargets, clockTime, flowFromSteps, flowTerms, FLOW_TEMPLATES, ISSUE_LABEL, type FlowDefinition, type FlowStage, type FlowStepInput } from "./flows.js";
import { connectionsOf, localConnectOf, oneClickOf } from "./mcp-connect.js";
import { publishingOf } from "./pull-request-flow.js";
import type { FlowRow, Store } from "./store.js";

export const GALLERY_GROUPS = [
  { id: "ship", label: "Ship code" },
  { id: "health", label: "Keep it healthy" },
  { id: "users", label: "Hear from users" },
  { id: "ops", label: "Operations" },
] as const;
export type GalleryGroup = (typeof GALLERY_GROUPS)[number]["id"];

/** What a template may ask, besides the project. */
export type AskKey = "label" | "branch" | "schedule" | "time" | "command" | "outdated" | "team";
export type GalleryAsk = { key: AskKey; default: string; label: string; hint?: string };

/** Weekly upkeep's package managers: what each runs. A script that fails (exits non-zero) when something is out of date. */
export const OUTDATED_COMMANDS: Record<"npm" | "pip" | "cargo", { label: string; command: string }> = {
  npm: { label: "npm (npm outdated)", command: "npm outdated" },
  pip: { label: "pip (pip list --outdated)", command: "out=\"$(python3 -m pip list --outdated 2>/dev/null | tail -n +3)\"\nif [ -n \"$out\" ]; then echo \"$out\"; exit 1; fi" },
  cargo: { label: "cargo (cargo outdated)", command: "cargo outdated --root-deps-only --exit-code 1" },
};

export type GalleryTemplate = {
  id: string;
  /** The flow's name, and the card's title. */
  name: string;
  group: GalleryGroup;
  /** One line: what it promises. */
  promise: string;
  /** What it needs to work, in a word or two each. */
  needs: string[];
  /** The project tools it puts to work: one-click service ids (ONE_CLICK) or "figma-desktop". */
  tools?: readonly string[];
  /** Watches a GitHub repository, so the project must be on GitHub. */
  github?: boolean;
  asks: GalleryAsk[];
  /** Its zones, as steps (laid out for it) or as a drawn flow. */
  steps?: FlowStepInput[];
  /** The steps in Toolroll's own repository, when they differ. */
  ownSteps?: FlowStepInput[];
  definition?: FlowDefinition;
  triggers: Record<string, unknown>[];
  scripts?: { name: string; about: string; body: string; timeoutMinutes?: number }[];
  /** What it will do, in order; `{{github}}` is the project's GitHub repository. */
  does: string[];
  never: string;
};

/** The card's Linear issue key, read from its source as the Linear trigger stored it ("Linear ENG-123"); "none" skips the comment. */
export const LINEAR_KEY = `key="$(sed -n 's/.*"source":{"kind":"linear","label":"Linear \\([A-Z][A-Z0-9]*-[0-9][0-9]*\\)".*/\\1/p' | head -n 1)"
if [ -n "$key" ]; then echo "$key"; echo "goto: Found"; else echo none; echo "goto: None"; fi`;
const NEVER_MERGES = "Never merges. Each pull request waits for you.";
const work = (text: string) => `${text}\n\nChanges asked for (if any): {{note}}`;
const research = (text: string) => `${text}\n\nFeedback to address (if any): {{note}}`;
const owner = (id: string, title: string): FlowStepInput => ({ id, title, kind: "approval", decider: "owner" });
const pr: FlowStepInput = { id: "pull-request", title: "Pull request", kind: "pull-request" };
const drawn = (id: string) => structuredClone(FLOW_TEMPLATES.find(one => one.id === id)!.definition);
const about = (id: string) => FLOW_TEMPLATES.find(one => one.id === id)!.about;
const SORTS = "OpenRouter (Jev sorts)";
const WEEKLY: GalleryAsk = { key: "schedule", default: "monday 09:00", label: "When", hint: "Like “monday 09:00”." };
const weekly = (title: string) => ({ kind: "schedule", schedule: "{{ask.schedule}}", title });
const send = (title: string): FlowStepInput => ({ id: "send", title, kind: "send" });
/** A person's choice: build it, or end there. A reply goes to the build as its note. */
const choose = (title: string, yes: string, build: string): FlowStepInput => ({ id: "choose", title, kind: "choose", options: [{ label: yes, goesTo: build }, { label: "Ignore", goesTo: "end" }], ifReplied: build });

export const GALLERY: readonly GalleryTemplate[] = [
  // ---------------------------------------------------------------- Ship code
  {
    id: "overnight-bug-bash", name: "Overnight bug bash", group: "ship",
    promise: "Bugs filed during the day are fixed overnight; the results wait for you in the morning.",
    needs: ["GitHub"], github: true,
    asks: [{ key: "label", default: "bug", label: "Issue label" }, { key: "time", default: "22:00", label: "Start building at", hint: "Builds run from then until 06:00." }],
    steps: [
      { id: "tonight", title: "Tonight", kind: "wait", waitFor: "hours", from: "{{ask.time}}", until: "06:00" },
      { id: "fix", title: "Fix it", kind: "task", instructions: work("Fix this bug, with a regression check where one fits: {{card.title}}\n\n{{card.description}}") },
      owner("morning", "Morning review"),
      pr,
      { id: "comment", title: "Comment on the issue", kind: "update", message: "A fix is ready for review: {{stage.pull-request}}", close: false },
    ],
    triggers: [{ kind: "github", watch: "issues", label: "{{ask.label}}" }],
    does: ["Watches issues labelled “{{ask.label}}” in {{github}}, from people with write access.", "Holds each one until {{ask.time}}, then builds a fix as a task, under your usual approvals.",
      "In the morning every result waits in Morning review for you.", "What you approve opens a pull request, and the issue gets a comment."],
    never: NEVER_MERGES,
  },
  {
    id: "dependency-babysitter", name: "Dependency PR babysitter", group: "ship",
    promise: "Dependabot and Renovate pull requests with red CI get a fix.",
    needs: ["GitHub", "CI", "Dependabot or Renovate"], github: true,
    asks: [{ key: "label", default: "dependencies", label: "Pull request label", hint: "Dependabot adds “dependencies”." }],
    steps: [
      { id: "why-red", title: "Why is CI red?", kind: "report", instructions: research("A dependency update pull request: {{card.title}}\n\n{{card.description}}\n\nLook at its checks with gh pr checks. If they pass, start the report with “CI is green” and stop. Otherwise say which check fails and what in the update breaks it.") },
      { id: "fix", title: "Fix it", kind: "task", instructions: work("Make the project work with this dependency update so CI passes, starting from the update's changes. If the report starts with “CI is green”, change nothing and say so.\n\nThe report:\n{{stage.why-red}}") },
      owner("review", "Review the fix"),
      pr,
      { id: "comment", title: "Comment on the update", kind: "update", message: "A fix for this update is ready: {{stage.pull-request}}", close: false },
    ],
    triggers: [{ kind: "github", watch: "pulls", label: "{{ask.label}}", from: "anyone" }],
    does: ["Watches pull requests labelled “{{ask.label}}” in {{github}}, from anyone (bots included).", "Finds out why CI is red, then builds a fix as a task, under your usual approvals.",
      "What you approve opens a pull request with the fix, and the update gets a comment linking it."],
    never: "Never merges or pushes to the update's branch. You decide what ships.",
  },
  {
    id: "release-notes", name: "Release notes writer", group: "ship",
    promise: "Press a button for a release; get notes drafted from the merged pull requests.",
    needs: ["GitHub"], github: true, asks: [],
    steps: [
      { id: "draft", title: "Draft the notes", kind: "report", instructions: research("Write release notes for {{card.title}}.\n\n{{card.description}}\n\nList the pull requests merged since the last tag, or the tag named above, with gh pr list --state merged. Group them as New, Improved and Fixed, one plain line each with its number. End with a short changelog entry in this project's style.") },
      owner("check", "Check the notes"),
      { id: "post", title: "Post them", kind: "notify", message: "Release notes for {{card.title}}:\n\n{{stage.draft}}" },
    ],
    triggers: [{ kind: "button", label: "Write release notes", questions: ["Which version?", "Since which tag? (blank for the last one)"] }],
    does: ["Adds a “Write release notes” button that asks for the version.", "Drafts the notes from the pull requests merged since the last tag.", "You check them, then they're posted to the project's chat."],
    never: "Never tags, publishes or merges anything.",
  },
  {
    id: "docs-follow-code", name: "Docs follow the code", group: "ship",
    promise: "A pull request that changes a public API or CLI gets a docs update.",
    needs: ["GitHub", SORTS], github: true, asks: [],
    steps: [
      { id: "changes-docs", title: "Changes the docs?", kind: "sort", question: "Does this pull request change something people use directly: a public API, a CLI command or flag, a config option or documented behaviour?",
        answers: [
          { answer: "Yes", means: "It adds, removes or changes something people call, type or configure", goesTo: "update-docs" },
          { answer: "No", means: "Only internal code, tests, refactors or fixes that don't change how it's used", goesTo: "Done" },
        ], ifNotSure: "update-docs" },
      { id: "update-docs", title: "Update the docs", kind: "task", instructions: work("This pull request changes how the project is used: {{card.title}}\n\n{{card.description}}\n\nRead it with gh pr diff. Update the README, docs, help text and examples to match. Change only documentation.") },
      owner("review", "Review the docs"),
      pr,
    ],
    triggers: [{ kind: "github", watch: "pulls" }],
    does: ["Watches new pull requests in {{github}}, from people with write access.", "Jev decides whether each changes a public API, CLI or config; when unsure, it treats it as yes.",
      "Writes the docs update as a task, under your usual approvals.", "What you approve opens a docs pull request."],
    never: NEVER_MERGES,
  },
  {
    id: "pr-second-opinion", name: "PR second opinion", group: "ship",
    promise: "Every pull request gets a careful review of risks and missing tests.",
    needs: ["GitHub"], github: true, asks: [],
    steps: [
      { id: "review", title: "Write a review", kind: "report", instructions: research("Review this pull request as a careful second reader: {{card.title}}\n\n{{card.description}}\n\nRead the diff with gh pr diff. Write a short review: risks, missing tests and anything unclear, most important first, citing files and lines. Say “Looks good” if there's nothing worth raising.") },
      owner("check", "Post it?"),
      { id: "comment", title: "Comment on the pull request", kind: "update", message: "A second opinion:\n\n{{stage.review}}", close: false },
    ],
    triggers: [{ kind: "github", watch: "pulls" }],
    does: ["Watches pull requests opened by people with write access in {{github}}.", "Writes a review: risks, missing tests, anything unclear.", "You read it; what you approve is posted as a comment."],
    never: "Never approves, changes or merges a pull request.",
  },
  {
    id: "coding", name: "Coding flow", group: "ship", promise: about("coding"), needs: [], asks: [], definition: drawn("coding"), triggers: [],
    does: ["Researches each request and writes a short triage.", "You decide whether to go ahead; then it's built as a task, under your usual approvals.", "You review the result, then the team hears it shipped."],
    never: "Never ships anything you haven't reviewed.",
  },
  {
    id: "issues-to-prs", name: "Issues to PRs", group: "ship", promise: "Labelled GitHub issues are built and opened as pull requests.", needs: ["GitHub", "CI"], github: true,
    asks: [{ key: "label", default: ISSUE_LABEL, label: "Issue label" }], definition: drawn("issues-to-prs"),
    triggers: [{ kind: "github", watch: "issues", label: "{{ask.label}}" }],
    does: ["Watches issues labelled “{{ask.label}}” in {{github}}, from people with write access.", "Builds each one as a task, under your usual approvals.", "What you approve opens a pull request and waits for CI; then the issue gets a comment and is closed."],
    never: NEVER_MERGES,
  },
  {
    id: "effort-routing", name: "Effort routing", group: "ship", promise: "Small changes go straight to a build; big ones get a plan and a person first.", needs: [SORTS], asks: [], definition: drawn("effort-routing"), triggers: [],
    does: [about("effort-routing")], never: "Never builds a big change before you approve its plan.",
  },
  {
    id: "ui-inspiration", name: "UI inspiration", group: "ship", tools: ["mobbin"],
    promise: "Each week, three real app examples for one part of your UI, ready to build.",
    needs: ["GitHub"], asks: [WEEKLY],
    steps: [
      { id: "find", title: "Find examples", kind: "report", instructions: research("Pick one surface of this project (a screen or a flow) that no recent commit or earlier inspiration covered.\n\nWith Mobbin, read only: find 3 real app examples for it. For each: the pattern, why it fits here, how it plugs into this code (files and components), and a Mobbin screenshot.") },
      choose("Implement, remix or ignore?", "Implement", "build"),
      { id: "build", title: "Build it", kind: "task", instructions: work("Build the chosen example from the report into this project with its own components. A note below is a remix: follow it.\n\nThe report:\n{{stage.find}}") },
      pr,
      send("Send the result"),
    ],
    triggers: [weekly("UI inspiration")],
    does: ["Picks one part of your UI {{ask.schedule-words}} and finds 3 Mobbin examples for it, each with a screenshot.", "You choose Implement or Ignore, or reply with a remix note.", "What you choose is built as a task, under your usual approvals, and opens a pull request.", "The result is sent to you."],
    never: NEVER_MERGES,
  },
  {
    id: "figma-to-pr", name: "Figma frame to pull request", group: "ship", tools: ["figma-desktop"],
    promise: "Paste a Figma frame link; get it built in your own components.",
    needs: ["GitHub"], asks: [],
    steps: [
      { id: "build", title: "Build the frame", kind: "task", instructions: work("Build this Figma frame in the project's own components and styles: {{card.title}}\n\n{{card.description}}\n\nRead the frame with the Figma desktop app's tools (its code, screenshot and variables). Reuse existing components; add one only where none fits. Take screenshots before and after, on desktop and phone.") },
      pr,
      send("Send before and after"),
    ],
    triggers: [{ kind: "button", label: "Build a Figma frame", questions: ["Figma frame link", "Notes (optional)"] }],
    does: ["Adds a “Build a Figma frame” button that asks for the frame link.", "Builds the frame in your components as a task, under your usual approvals, with desktop and phone screenshots.", "Opens a pull request and sends you before and after."],
    never: NEVER_MERGES,
  },
  {
    id: "linear-to-prs", name: "Linear issues to PRs", group: "ship", tools: ["linear"],
    promise: "Labelled Linear issues are built, and the issue gets the pull request link.",
    needs: ["GitHub", "A Linear API key"], asks: [{ key: "team", default: "ENG", label: "Linear team", hint: "Its short key, like ENG." }, { key: "label", default: ISSUE_LABEL, label: "Issue label" }],
    // The issue's key comes from the card's source ("Linear ENG-123"), as the trigger stored it, never from a model.
    scripts: [{ name: "linear-issue-key", about: "Prints the Linear issue the card came from, or none.", body: LINEAR_KEY, timeoutMinutes: 1 }],
    steps: [
      { id: "build", title: "Build it", kind: "task", instructions: work("Build this issue: {{card.title}}\n\n{{card.description}}") },
      pr,
      { id: "issue-key", title: "Find the issue key", kind: "check", script: "{{script.linear-issue-key}}", runIn: "folder", routes: [{ answer: "Found", goesTo: "comment" }, { answer: "None", goesTo: "Done" }] },
      { id: "comment", title: "Comment on the issue", kind: "tool", server: "linear", tool: "create_comment", args: { issueId: "{{stage.issue-key}}", body: "A pull request is ready: {{stage.pull-request}}" } },
    ],
    triggers: [{ kind: "linear", team: "{{ask.team}}", label: "{{ask.label}}" }],
    does: ["Watches {{ask.team}} issues labelled “{{ask.label}}” in Linear.", "Builds each one as a task, under your usual approvals, and opens a pull request.", "Comments the pull request link on the issue, through Linear."],
    never: NEVER_MERGES,
  },
  // ---------------------------------------------------------- Keep it healthy
  {
    id: "fix-ci", name: "Fix failing CI", group: "health",
    promise: "When CI fails on your main branch, a fix is built and opened for review.",
    needs: ["GitHub", "CI"], github: true,
    asks: [{ key: "branch", default: "main", label: "Branch" }],
    steps: [
      { id: "fix", title: "Fix it", kind: "task", instructions: work("CI failed on {{ask.branch}}: {{card.title}}\n\n{{card.description}}\n\nFind the cause and make the failing check pass without weakening it.") },
      owner("review", "Review the fix"),
      pr,
    ],
    triggers: [{ kind: "github", watch: "checks", branch: "{{ask.branch}}" }],
    does: ["Watches checks on {{ask.branch}} in {{github}}.", "Builds a fix for each failure as a task, under your usual approvals.", "What you approve opens a pull request."],
    never: "Never merges or pushes to your branch. You decide what ships.",
  },
  {
    id: "flaky-test-hunter", name: "Flaky test hunter", group: "health",
    promise: "A test that fails, then passes on rerun, gets found, explained and fixed or quarantined.",
    needs: ["GitHub", "CI"], github: true,
    asks: [{ key: "branch", default: "main", label: "Branch" }],
    steps: [
      { id: "hunt", title: "Is it flaky?", kind: "report", instructions: research("A check failed on {{ask.branch}}: {{card.title}}\n\n{{card.description}}\n\nRerun the failing tests a few times. If one passes on rerun, name it and say why it's flaky (timing, order, shared state, network) and whether to fix or quarantine it. If it fails every time, start the report with “Not flaky” and say what broke.") },
      { id: "fix", title: "Fix or quarantine", kind: "task", instructions: work("Make this flaky test reliable. If the cause can't be fixed safely, quarantine it instead: skip it with a comment saying why. If the report starts with “Not flaky”, change nothing and say so.\n\nThe report:\n{{stage.hunt}}") },
      owner("review", "Review the fix"),
      pr,
    ],
    triggers: [{ kind: "github", watch: "checks", branch: "{{ask.branch}}" }],
    does: ["Watches failed checks on {{ask.branch}} in {{github}}.", "Reruns the failing tests to find the flaky one, and says why it's flaky.", "Fixes it or quarantines it as a task, under your usual approvals.", "What you approve opens a pull request."],
    never: NEVER_MERGES,
  },
  {
    id: "morning-plane-review", name: "Morning plane review", group: "health",
    promise: "What went wrong in Toolroll yesterday becomes cards, researched and fixed.",
    needs: [], asks: [{ key: "time", default: "07:30", label: "Review at" }],
    steps: planeReviewSteps(false), ownSteps: planeReviewSteps(true),
    triggers: [{ kind: "plane-review", at: "{{ask.time}}" }],
    does: ["Every day at {{ask.time}}, looks at failed runs, waiting tasks, sign-ins, plan limits, chat, integrations and checks.", "One card per problem. A clean day adds nothing.",
      "Finds the cause; one in this project gets a fix under your usual approvals and a pull request.", "Anything that fails waits in Needs a look."],
    never: "Never merges or ships anything without you. Each fix waits for your approval.",
  },
  {
    id: "nightly-journeys", name: "Nightly real-model journeys", group: "health",
    promise: "Your end-to-end tests run every night; a failure becomes a researched fix.",
    needs: ["A test command"],
    asks: [{ key: "command", default: "npm run e2e", label: "Test command", hint: "Runs in a copy of the project. It fails when the command does." }, { key: "schedule", default: "daily 02:00", label: "When", hint: "Like “daily 02:00” or “weekdays 03:00”." }],
    scripts: [{ name: "nightly-journeys", about: "Runs the project's end-to-end journeys.", body: "{{ask.command}}", timeoutMinutes: 60 }],
    steps: [
      { id: "run", title: "Run the journeys", kind: "check", script: "{{script.nightly-journeys}}", next: "Done", ifFails: "find-cause" },
      { id: "find-cause", title: "Find the cause", kind: "report", instructions: research("The nightly journeys failed. What the run printed:\n{{stage.run}}\n\nFind which journey failed and why: the code, the test or the model provider. Cite files and lines, and say what change fixes it.") },
      { id: "fix", title: "Fix it", kind: "task", instructions: work("Fix the cause of the failed nightly journey without weakening the test.\n\nThe report:\n{{stage.find-cause}}") },
      owner("review", "Review the fix"),
      pr,
    ],
    triggers: [{ kind: "schedule", schedule: "{{ask.schedule}}", title: "Nightly journeys" }],
    does: ["Runs “{{ask.command}}” {{ask.schedule-words}}, with no AI.", "A pass adds nothing to review. A failure is researched, then fixed as a task, under your usual approvals.", "What you approve opens a pull request."],
    never: NEVER_MERGES,
  },
  {
    id: "weekly-upkeep", name: "Weekly upkeep", group: "health",
    promise: "Outdated dependencies are updated each week, with major upgrades kept apart.",
    needs: ["A script (npm, pip or cargo outdated)"],
    asks: [{ key: "outdated", default: "npm", label: "Packages" }, { key: "schedule", default: "monday 09:00", label: "When", hint: "Like “monday 09:00”." }],
    scripts: [{ name: "outdated", about: "Lists outdated dependencies; fails when there are any.", body: "{{ask.outdated-command}}" }],
    steps: [
      { id: "outdated", title: "Anything outdated?", kind: "check", script: "{{script.outdated}}", next: "Done", ifFails: "update" },
      { id: "update", title: "Update them", kind: "task", instructions: work("Update the outdated dependencies below. Keep major upgrades in their own commits and note any breaking changes. Run the tests.\n\nWhat's outdated:\n{{stage.outdated}}") },
      owner("review", "Review the updates"),
      pr,
    ],
    triggers: [{ kind: "schedule", schedule: "{{ask.schedule}}", title: "Weekly upkeep" }],
    does: ["Checks for outdated {{ask.outdated}} packages {{ask.schedule-words}}, with no AI.", "When some are out of date, updates them as a task, under your usual approvals.", "What you approve opens a pull request."],
    never: NEVER_MERGES,
  },
  {
    id: "error-to-fix", name: "Error to fix", group: "health", tools: ["sentry"],
    promise: "New errors from Sentry or any error tracker are sorted, researched and fixed.",
    needs: ["A webhook from Sentry or another tracker", SORTS], asks: [],
    steps: [
      { id: "worth-fixing", title: "Worth fixing?", kind: "sort", question: "Is this error in our own code, and new or frequent enough to fix now?",
        answers: [
          { answer: "Fix it", means: "It comes from our code and is new, frequent, or hurts people", goesTo: "find-cause" },
          { answer: "Ignore", means: "Noise: bots, browser extensions, a third party's outage, or something known and expected", goesTo: "ignored" },
        ], ifNotSure: "by-hand" },
      { id: "find-cause", title: "Find the cause", kind: "report", instructions: research("An error came in: {{card.title}}\n\n{{card.description}}\n\nWith Sentry, read the issue's stack trace and latest events. Read only. Find the cause in this code: cite the files and lines, say why it happens and what change fixes it.") },
      { id: "fix", title: "Fix it", kind: "task", instructions: work("Fix this error, with a regression check where one fits: {{card.title}}\n\nThe report:\n{{stage.find-cause}}") },
      owner("review", "Review the fix"),
      { ...pr, next: "Done" },
      { id: "by-hand", title: "Check by hand", kind: "inbox", next: "find-cause" },
      { id: "done", title: "Done", kind: "done" },
      { id: "ignored", title: "Ignored", kind: "done" },
    ],
    triggers: [{ kind: "webhook", title: "Error", titleField: "data.issue.title", bodyField: "data.issue.culprit" }],
    does: ["Adds a webhook. Once the flow is made, open its Triggers and choose New address, then paste that into Sentry or another error tracker.", "Jev keeps errors in your code that are new or frequent, and drops noise; ones it isn't sure about wait for you.",
      "Each kept error is researched, then fixed as a task, under your usual approvals.", "What you approve opens a pull request."],
    never: NEVER_MERGES,
  },
  {
    id: "outage-to-cause", name: "Outage to cause", group: "health", tools: ["betterstack"],
    promise: "A Better Stack incident gets its likely cause, and a fix if you want one.",
    needs: ["A webhook from Better Stack", "GitHub"], asks: [],
    steps: [
      { id: "find-cause", title: "Find the cause", kind: "report", instructions: research("A Better Stack incident: {{card.title}}\n\n{{card.description}}\n\nWith Better Stack, read the incident and its monitor's recent history. Read this project's commits and deploys from before it started. Read only. Say the likely cause, with times, and what change fixes it.") },
      choose("Fix or ignore?", "Fix", "fix"),
      { id: "fix", title: "Fix it", kind: "task", instructions: work("Fix the cause of this outage, with a regression check where one fits.\n\nThe report:\n{{stage.find-cause}}") },
      pr,
    ],
    triggers: [{ kind: "webhook", title: "Incident", titleField: "data.attributes.name" }],
    does: ["Adds a webhook. Once the flow is made, open its Triggers and choose New address, then paste that into Better Stack.", "Reads the incident, its monitor's history and your recent commits and deploys, and sends you the likely cause.", "You choose Fix or Ignore; a fix is built as a task, under your usual approvals, and opens a pull request."],
    never: NEVER_MERGES,
  },
  {
    id: "worker-errors", name: "Worker errors to fix", group: "health", tools: ["cloudflare"],
    promise: "Each week, Cloudflare Workers and Pages errors worth fixing get a fix.",
    needs: ["GitHub", SORTS], asks: [WEEKLY],
    steps: [
      { id: "read", title: "Read the errors", kind: "report", instructions: research("With Cloudflare, read this week's Workers and Pages errors and analytics. Read only. List each error with its count, its Worker or Pages project, and when it started. Say “No errors” if there are none.") },
      { id: "worth-fixing", title: "Worth fixing?", kind: "sort", question: "Do these errors come from this project's code, often enough to fix now?",
        answers: [
          { answer: "Fix it", means: "Errors from our own code that are new, frequent or hurt people", goesTo: "find-cause" },
          { answer: "Ignore", means: "No errors, or only noise: bots, a provider's outage, something known", goesTo: "ignored" },
        ], ifNotSure: "find-cause" },
      { id: "find-cause", title: "Find the cause", kind: "report", instructions: research("Errors worth fixing:\n{{stage.read}}\n\nWith Cloudflare, read the worst one's logs. Read only. Find the cause in this code, citing files and lines, and say what change fixes it.") },
      choose("Fix or ignore?", "Fix", "fix"),
      { id: "fix", title: "Fix it", kind: "task", instructions: work("Fix this error, with a regression check where one fits.\n\nThe report:\n{{stage.find-cause}}") },
      { ...pr, next: "Done" },
      { id: "done", title: "Done", kind: "done" },
      { id: "ignored", title: "Ignored", kind: "done" },
    ],
    triggers: [weekly("Worker errors")],
    does: ["Reads your Cloudflare Workers and Pages errors and analytics {{ask.schedule-words}}.", "Jev decides whether they're worth fixing; if so, finds the cause and sends you a report.", "You choose Fix or Ignore; a fix is built as a task, under your usual approvals, and opens a pull request."],
    never: NEVER_MERGES,
  },
  {
    id: "failed-deploy", name: "Failed deploy to fix", group: "health", tools: ["vercel"],
    promise: "A failed Vercel deployment gets its cause found and a fix opened.",
    needs: ["A webhook from Vercel", "GitHub"], asks: [],
    steps: [
      { id: "find-cause", title: "Find the cause", kind: "report", instructions: research("A Vercel deployment failed: {{card.title}}\n\n{{card.description}}\n\nWith Vercel, read the deployment's build log. Read only. Find the cause in this code, citing files and lines, and say what change fixes it.") },
      { id: "fix", title: "Fix it", kind: "task", instructions: work("Fix this failed deployment without weakening any check.\n\nThe report:\n{{stage.find-cause}}") },
      pr,
      send("Send the fix"),
    ],
    triggers: [{ kind: "webhook", title: "Failed deployment", titleField: "payload.deployment.name" }],
    does: ["Adds a webhook. Once the flow is made, open its Triggers and choose New address, then paste that into Vercel for failed deployments.", "Reads the build log and finds the cause.", "Builds a fix as a task, under your usual approvals, opens a pull request and sends it to you."],
    never: NEVER_MERGES,
  },
  // ---------------------------------------------------------- Hear from users
  {
    id: "feedback-to-feature", name: "Feedback to feature", group: "users",
    promise: "Feedback is sorted into bugs, ideas and questions; ideas get a short spec for you to decide.",
    needs: [SORTS, "A Slack or Discord channel (optional)"], asks: [],
    steps: [
      { id: "sort", title: "Sort it", kind: "sort", question: "What kind of feedback is this?",
        answers: [
          { answer: "Bug", means: "Something is broken or behaves wrongly", goesTo: "fix" },
          { answer: "Idea", means: "A request for something new, or to change how something works", goesTo: "spec" },
          { answer: "Question", means: "Someone asking how to do something", goesTo: "reply" },
        ], ifNotSure: "by-hand" },
      { id: "fix", title: "Fix it", kind: "task", instructions: work("Fix this reported problem: {{card.title}}\n\n{{card.description}}") },
      owner("review", "Review the fix"),
      { ...pr, next: "Done" },
      { id: "spec", title: "Write a short spec", kind: "report", instructions: research("Someone suggested this: {{card.title}}\n\n{{card.description}}\n\nWrite a short spec: the problem, who it helps, the smallest useful version, where it lands in the code, and a rough size.") },
      owner("decide", "Build it?"),
      { id: "planned", title: "Planned", kind: "inbox", next: "Done" },
      { id: "reply", title: "Write a reply", kind: "draft", instructions: "Write a short, friendly answer to this question in plain words, saying what to do next if anything." },
      { ...owner("check-reply", "Check the reply"), ifFails: "reply" },
      { id: "answer", title: "Answer them", kind: "update", message: "{{stage.reply}}", close: false, next: "Done" },
      { id: "by-hand", title: "Sort by hand", kind: "inbox", next: "Done" },
    ],
    triggers: [{ kind: "button", label: "Share feedback", questions: ["What's your feedback?", "Details"] }],
    does: ["Adds a “Share feedback” button. You can also connect a Slack or Discord channel to it from that channel.", "Jev sorts each piece of feedback: bug, idea or question.",
      "Bugs are fixed as tasks under your usual approvals; ideas get a short spec for you to decide; questions get a reply you check before it's sent."],
    never: "Never builds an idea or sends a reply without you. " + NEVER_MERGES,
  },
  {
    id: "triage", name: "Issue triage", group: "users", promise: "Jev sorts new issues into bugs, ideas and questions, and says how urgent each is.", needs: [SORTS], asks: [], definition: drawn("triage"), triggers: [],
    does: [about("triage")], never: "Never closes an issue or replies without your approval.",
  },
  {
    id: "metrics-digest", name: "Metrics digest", group: "users", tools: ["posthog"],
    promise: "Each week, this week against last: signups, activation, retention and top events.",
    needs: [], asks: [WEEKLY],
    steps: [
      { id: "read", title: "Read the numbers", kind: "report", instructions: research("With PostHog, compare this week with last week. Read only. Give signups, activation, retention and the top 10 events, each with its change. Name the biggest change and its likely cause (a release, a campaign, a broken step), citing this week's commits where they fit.") },
      send("Send the digest"),
    ],
    triggers: [weekly("Metrics digest")],
    does: ["Compares this week's PostHog numbers with last week's, {{ask.schedule-words}}.", "Names the biggest change and its likely cause.", "Sends you the digest."],
    never: "Never changes PostHog or your code.",
  },
  {
    id: "fix-drop-off", name: "Fix the biggest drop-off", group: "users", tools: ["posthog"],
    promise: "Each week, the funnel step losing the most people gets a proposed fix.",
    needs: ["GitHub"], asks: [WEEKLY],
    steps: [
      { id: "find", title: "Find the drop-off", kind: "report", instructions: research("With PostHog, find the funnel step that lost the most people this week. Read only. Give the funnel, the step, how many reached it and how many left. Propose one fix in this code, citing files.") },
      choose("Implement or ignore?", "Implement", "build"),
      { id: "build", title: "Build the fix", kind: "task", instructions: work("Build the proposed fix for this drop-off.\n\nThe report:\n{{stage.find}}") },
      pr,
      send("Send the result"),
    ],
    triggers: [weekly("Biggest drop-off")],
    does: ["Finds the PostHog funnel step losing the most people {{ask.schedule-words}}, with the numbers and one proposed fix.", "You choose Implement or Ignore.", "A fix is built as a task, under your usual approvals, opens a pull request and is sent to you."],
    never: NEVER_MERGES,
  },
  {
    id: "support-to-fix", name: "Support to bug fix", group: "users", tools: ["intercom"],
    promise: "Each week, the bugs your customers hit most, ranked, with a fix for the one you pick.",
    needs: ["GitHub"], asks: [WEEKLY],
    steps: [
      { id: "group", title: "Rank the bugs", kind: "report", instructions: research("With Intercom, read this week's conversations. Read only. Group the bug reports by problem, rank them by how many people hit each, and number them, with a count and one example conversation each.") },
      { id: "choose", title: "Which to fix?", kind: "choose", options: [{ label: "Fix the top one", goesTo: "fix" }, { label: "Ignore", goesTo: "end" }], ifReplied: "fix" },
      { id: "fix", title: "Fix it", kind: "task", instructions: work("Fix the bug chosen from this ranking: the top one, unless the note names another by number. Add a regression check where one fits.\n\nThe ranking:\n{{stage.group}}") },
      pr,
      send("Send the result"),
    ],
    triggers: [weekly("Support bugs")],
    does: ["Reads your Intercom conversations {{ask.schedule-words}} and ranks the bug reports by how many people hit each.", "You fix the top one, reply with the number of another, or ignore them.", "The fix is built as a task, under your usual approvals, opens a pull request and is sent to you."],
    never: NEVER_MERGES,
  },
  // ------------------------------------------------------------------ Operations
  ...([
    ["research", "Research a question, have a person check it, then share it.", [], "Never shares an answer you haven't checked."],
    ["spam-filter", "Jev screens what a public form or webhook brings in.", [SORTS], "Never deletes anything; filtered cards are kept."],
    ["lead-routing", "Jev sorts new enquiries by what they want and how ready they are.", [SORTS], "Never replies to anyone."],
    ["exception-routing", "Customer problems go to the team that owns them.", [SORTS], "Never replies or refunds."],
    ["email-replies", "Claude drafts a reply to each question; you approve it before it's emailed.", ["Email (Settings → Email)"], "Never sends an email you haven't approved."],
    ["follow-up", "A reply goes out, and a short nudge follows if nobody answers.", ["Email inbox (Settings → Email)"], "Never sends the first reply without your approval."],
    ["stalled-decisions", "Decisions that wait too long are passed to anyone who can approve.", [], "Never decides for you."],
  ] as const).map(([id, promise, needs, never]): GalleryTemplate => ({
    id, name: FLOW_TEMPLATES.find(one => one.id === id)!.label, group: "ops", promise, needs: [...needs], asks: [], definition: drawn(id), triggers: [], does: [about(id)], never,
  })),
];

/** The blank flow, for starting from nothing. */
export const BLANK: GalleryTemplate = { id: "blank", name: "Blank flow", group: "ops", promise: about("blank"), needs: [], asks: [], definition: drawn("blank"), triggers: [], does: [about("blank")], never: "Does nothing until you add zones." };

export const galleryTemplateOf = (id: string): GalleryTemplate | null => id === BLANK.id ? BLANK : GALLERY.find(one => one.id === id) ?? null;

/** A tool a template uses: where the chosen project stands with it (null with no project), and the zones that use it. */
export type GalleryTool = { id: string; label: string; state: "connected" | "open" | "taken" | null; zones: string[] };

/** A tool's name ("Mobbin", "Figma (desktop app)"); null for an id that's neither a one-click service nor an app on this computer. */
export const galleryToolLabel = (id: string): string | null => oneClickOf(id)?.label ?? localConnectOf(id)?.label ?? null;

/** The zones that use a tool: a tool step on it, or a research or build step that names it ("With Mobbin, …"). */
export function zonesUsing(definition: FlowDefinition, id: string): string[] {
  const label = galleryToolLabel(id);
  if (label === null) return [];
  const word = new RegExp(`\\b${label.replace(/\s*\(.*\)$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  return definition.stages.filter(one => one.tool?.server === id || ((one.kind === "report" || one.kind === "task") && word.test(one.instructions ?? ""))).map(one => one.title);
}

/** A template's tools, each with its state in a project's connections (connectionsOf), or none without a project. */
export function galleryToolsOf(template: GalleryTemplate, definition: FlowDefinition, connections: readonly { id: string; state: "connected" | "open" | "taken" }[] | null): GalleryTool[] {
  return (template.tools ?? []).map(id => ({ id, label: galleryToolLabel(id) ?? id, state: connections === null ? null : connections.find(one => one.id === id)?.state ?? "open", zones: zonesUsing(definition, id) }));
}

export type GalleryAnswers = Record<string, string>;

/** Each question's default for a project: the branch pull requests go to, when that's set up. */
export function galleryDefaults(store: Store, template: GalleryTemplate, repo: string | null): GalleryAnswers {
  const publishing = repo === null ? { on: false as const } : publishingOf(store, repo);
  return Object.fromEntries(template.asks.map(ask => [ask.key, ask.key === "branch" && publishing.on ? publishing.base : ask.default]));
}

const oneLine = (value: string, cap: number, what: string) => {
  const said = value.replace(/\s+/g, " ").trim();
  if (said === "" || said.length > cap || /[\u0000-\u001f\u007f]/.test(said)) throw new Error(`Say the ${what} in one short line.`);
  if (scanForSecrets(said).length > 0) throw new Error(`That ${what} looks like it holds a key or password. Keep secrets out of it.`);
  return said;
};

/** The optional last step every template offers, and the answer that turns it on. */
export const SEND_RESULT = { key: "send-result", title: "Send me the result", does: "When a card finishes, sends you what was done (its summary, links and screenshots) in your chat apps." } as const;

/** A template that already sends its result to the person: it isn't offered "Send me the result" again. */
export const sendsAlready = (template: GalleryTemplate) => galleryDiagram(template).stages.some(one => one.kind === "send");

/** A flow with "Send me the result" before its end: every path into its main Done zone passes through it first.
 * A flow that already has a send zone is left as it is, so nobody gets the result twice. */
export function withSendResult(definition: FlowDefinition): FlowDefinition {
  if (definition.stages.some(one => one.kind === "send")) return definition;
  // Its main end: Done, else an end that isn't a filtered-out one (drawn in rose), else any end.
  const ends = definition.stages.filter(one => one.kind === "done");
  const end = ends.find(one => one.id === "done") ?? ends.find(one => one.zone.color !== "rose") ?? ends[0];
  if (end === undefined) return definition;
  let id = "send-result";
  for (let n = 2; definition.stages.some(one => one.id === id); n++) id = `send-result-${n}`;
  const into = (to: string) => to === end.id ? id : to;
  const stages: FlowStage[] = definition.stages.map(one => ({
    ...one, next: one.next === null ? null : into(one.next), onFail: one.onFail === null ? null : into(one.onFail),
    ...(one.limit === undefined ? {} : { limit: { ...one.limit, to: one.limit.to === null ? null : into(one.limit.to) } }),
    sort: one.sort === null ? null : { ...one.sort, answers: one.sort.answers.map(answer => ({ ...answer, to: into(answer.to) })) },
    ...(one.routes === undefined ? {} : { routes: one.routes.map(route => ({ ...route, to: into(route.to) })) }),
    ...(one.options === undefined || choiceTargets(one).length === 0 ? {} : { options: one.options.map(option => ({ ...option, to: into(option.to) })) }),
  }));
  // Where the end was, and the end moves along to make room.
  const send: FlowStage = { id, title: SEND_RESULT.title, kind: "send", zone: { ...end.zone, color: "green", h: 220 }, instructions: null, planning: null, approver: null,
    message: null, close: null, script: null, sort: null, next: end.id, onFail: null };
  const moved = stages.map(one => one.id === end.id ? { ...one, zone: { ...one.zone, x: one.zone.x + Math.max(300, one.zone.w + 40) } } : one);
  return { ...definition, ...(definition.start === end.id ? { start: id } : {}), stages: [...moved.filter(one => one.id !== end.id), send, moved.find(one => one.id === end.id)!] };
}

/** The answers, checked in plain words, with what they fill in. Throws. */
export function checkAnswers(template: GalleryTemplate, given: GalleryAnswers): GalleryAnswers {
  const answers: GalleryAnswers = {};
  // Off unless asked for; only said when on, so a template's answers read as before.
  if (given[SEND_RESULT.key] === "yes") answers[SEND_RESULT.key] = "yes";
  for (const ask of template.asks) {
    const value = String(given[ask.key] ?? ask.default).trim();
    if (ask.key === "label") answers["label"] = oneLine(value, 50, "label");
    else if (ask.key === "branch") {
      if (!/^[A-Za-z0-9._/-]{1,100}$/.test(value)) throw new Error("That branch name isn't valid.");
      answers["branch"] = value;
    } else if (ask.key === "time") {
      const time = clockTime(value);
      if (time === null) throw new Error("Say the time as HH:MM, like 22:00.");
      answers["time"] = time;
    } else if (ask.key === "schedule") {
      const said = oneLine(value, 80, "schedule");
      if (scheduleFromWords(said) === null) throw new Error("Say when like “daily 02:00”, “weekdays 09:00” or “monday 09:00”.");
      // Said without a time zone, it runs in this computer's, like the plane review.
      const zoned = /@/.test(scheduleFromWords(said)!) || /^every \d/i.test(said) ? null : scheduleFromWords(`${said} ${localTimeZone()}`);
      answers["schedule"] = zoned === null ? said : `${said} ${localTimeZone()}`;
      answers["schedule-words"] = scheduleWords(said);
    } else if (ask.key === "command") answers["command"] = oneLine(value, 500, "test command");
    else if (ask.key === "team") {
      if (!/^[A-Za-z0-9]{1,12}$/.test(value)) throw new Error("Say the Linear team as its short key, like ENG.");
      answers["team"] = value.toUpperCase();
    } else if (ask.key === "outdated") {
      const manager = OUTDATED_COMMANDS[value as keyof typeof OUTDATED_COMMANDS];
      if (manager === undefined) throw new Error("Choose npm, pip or cargo.");
      answers["outdated"] = value;
      answers["outdated-command"] = manager.command;
    }
  }
  return answers;
}

function localTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

/** "daily 02:00" as "every day at 02:00", the way a sentence says it. */
function scheduleWords(said: string): string {
  const daily = /^(?:every day|daily)(?: at)? (\d{1,2}:\d{2})/i.exec(said);
  if (daily !== null) return `every day at ${daily[1]}`;
  const weekdays = /^(?:every )?weekdays?(?: at)? (\d{1,2}:\d{2})/i.exec(said);
  if (weekdays !== null) return `every weekday at ${weekdays[1]}`;
  const weekly = /^(?:every |weekly on |weekly |on )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?(?: at)? (\d{1,2}:\d{2})/i.exec(said);
  if (weekly !== null) return `every ${weekly[1]!.charAt(0).toUpperCase()}${weekly[1]!.slice(1).toLowerCase()} at ${weekly[2]}`;
  return said;
}

/** Fill `{{ask.<key>}}` and `{{script.<name>}}` through a template's data; the card's own fill-ins stay. */
function fill<T>(value: T, answers: GalleryAnswers, scripts: Record<string, string>, github: string | null): T {
  if (typeof value === "string") return value.replace(/\{\{(ask|script)\.([a-z-]+)\}\}|\{\{github\}\}/g, (whole, kind: string | undefined, key: string | undefined) =>
    kind === undefined ? github ?? "your GitHub repository" : (kind === "ask" ? answers[key!] : scripts[key!]) ?? whole) as T;
  if (Array.isArray(value)) return value.map(one => fill(one, answers, scripts, github)) as T;
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, one]) => [key, fill(one, answers, scripts, github)])) as T;
  return value;
}

export type GalleryBuilt = {
  template: GalleryTemplate; repo: string; answers: GalleryAnswers;
  definition: FlowDefinition; triggers: Record<string, unknown>[];
  scripts: { name: string; about: string; body: string; timeoutMinutes: number; existing: boolean }[];
  does: string[]; never: string;
};

/** A template made concrete for a project and its answers: its zones, triggers and scripts, checked. Throws in plain words. */
export function buildFromGallery(store: Store, template: GalleryTemplate, repo: string, given: GalleryAnswers): GalleryBuilt {
  if (template.github === true && githubRepoOf(repo) === null) throw new Error("This project isn't on GitHub, so this can't watch it.");
  const answers = checkAnswers(template, given);
  // A script keeps its name unless the project already has a different one by that name; then it gets a free one.
  const names: Record<string, string> = {};
  const scripts = (template.scripts ?? []).map(script => {
    const body = fill(script.body, answers, {}, null);
    const draft = validateScript({ name: script.name, about: script.about, body, timeoutMinutes: script.timeoutMinutes ?? 15 });
    let name = draft.name, existing = false;
    for (let n = 2; ; n++) {
      const there = store.flowScript(repo, name);
      if (there === null) break;
      if (there.body === draft.body && there.language === "shell" && there.file === null) { existing = true; break; }
      name = `${draft.name}-${n}`;
    }
    names[script.name] = name;
    return { name, about: draft.about, body: draft.body, timeoutMinutes: draft.timeoutMinutes, existing };
  });
  const github = githubRepoOf(repo);
  const drawn = template.definition !== undefined ? structuredClone(template.definition)
    : flowFromSteps(fill(template.ownSteps !== undefined && isToolrollRepo(repo) ? template.ownSteps : template.steps!, answers, names, github), null);
  // One that already sends doesn't take the answer, so it reads as it was asked.
  if (drawn.stages.some(one => one.kind === "send")) delete answers[SEND_RESULT.key];
  const sends = answers[SEND_RESULT.key] === "yes";
  const definition = sends ? withSendResult(drawn) : drawn;
  return { template, repo, answers, definition, triggers: fill(template.triggers, answers, names, github), scripts,
    does: [...fill(template.does, answers, names, github), ...(sends && definition !== drawn ? [SEND_RESULT.does] : [])], never: template.never };
}

/** A template's zones as its defaults draw them, for the gallery's small drawing; no project needed. */
export function galleryDiagram(template: GalleryTemplate): FlowDefinition {
  if (template.definition !== undefined) return template.definition;
  const names = Object.fromEntries((template.scripts ?? []).map(one => [one.name, one.name]));
  return flowFromSteps(fill(template.steps!, checkAnswers(template, {}), names, null), null);
}

export type GalleryPreview = { built: GalleryBuilt; startsFrom: string[]; steps: string[]; tools: GalleryTool[]; digest: string };

/** What using a template will do, in words, before anything is made: its triggers checked as the flow will have them. Throws. */
export function previewGallery(store: Store, template: GalleryTemplate, repo: string, given: GalleryAnswers, actor: string, now: Date): GalleryPreview {
  const built = buildFromGallery(store, template, repo, given);
  const draft: FlowRow = { id: 0, repo, name: template.name, definitionJson: JSON.stringify(built.definition), revision: 1, state: "active", createdBy: actor, createdAt: now.toISOString(), updatedBy: actor, updatedAt: now.toISOString(), owner: actor };
  const startsFrom = built.triggers.map(trigger => describeTrigger(validateTriggerConfig({ ...trigger, zone: trigger["zone"] ?? built.definition.start }, { store, flow: draft, definition: built.definition, actor }), store));
  const steps = flowTerms(built.definition, null);
  if (built.scripts.some(one => !one.existing)) steps.push(...built.scripts.filter(one => !one.existing).map(one => `Adds the ${one.name} script to this project: ${one.body.split("\n")[0]}${one.body.includes("\n") ? " …" : ""}`));
  return { built, startsFrom, steps, tools: galleryToolsOf(template, built.definition, connectionsOf(store, repo)), digest: galleryDigest(template.id, repo, built.answers) };
}

/** What a preview showed: the template, the project and the answers. Creating checks the person saw these. */
export function galleryDigest(id: string, repo: string, answers: GalleryAnswers): string {
  return createHash("sha256").update(JSON.stringify([id, repo, Object.entries(answers).sort(([a], [b]) => a.localeCompare(b))])).digest("hex").slice(0, 24);
}

export type GalleryUsed = { ok: true; flow: number; said: string } | { ok: false; said: string };

/** Use a template in a project: its scripts, its flow and its triggers, together or not at all. */
export function useGalleryTemplate(store: Store, template: GalleryTemplate, repo: string, given: GalleryAnswers, input: { name?: string | null; by: string; now: Date; dir: string | null }): GalleryUsed {
  try {
    const built = buildFromGallery(store, template, repo, given);
    const name = (input.name ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80) || template.name;
    let hook = false;
    const flow = store.transact(() => {
      for (const script of built.scripts) if (!script.existing) {
        const saved = saveScript(store, repo, { name: script.name, about: script.about, body: script.body, timeoutMinutes: script.timeoutMinutes }, input.by, input.now);
        if (!saved.ok) throw new Error(saved.message);
      }
      const id = store.createFlow({ repo, name, definitionJson: JSON.stringify(built.definition), by: input.by }, input.now);
      const made = store.getFlow(id)!;
      for (const trigger of built.triggers) {
        const added = addFlowTriggerTo(store, made, { ...trigger, zone: trigger["zone"] ?? flowDefinitionOf(made)!.start }, input.by, input.now, input.dir);
        if (!added.ok) throw new Error(added.message);
        if (added.reveal !== null) hook = true;
      }
      return id;
    });
    // A webhook's address is a secret shown once: it's made on the flow's Triggers panel, where it can be copied.
    return { ok: true, flow, said: hook ? `${name} is ready. To get its webhook address, open Triggers and choose New address.` : `${name} is ready.` };
  } catch (error) {
    return { ok: false, said: `${template.name} couldn't be made: ${error instanceof Error ? error.message : "unknown"}` };
  }
}
