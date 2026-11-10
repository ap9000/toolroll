// @vitest-environment happy-dom
/** The plan sheet's content parity (docs/plans/task-page-steps.md "Content parity, enumerated"): the task page's plan
 * sheet is the approval sheet's own parts re-ordered, so every term the old sheet shows — its rows and everything in
 * its "Plan details" fold — is in the new sheet, outside any <details> or hidden element. One case per shape a
 * person approves: plain, repair, amended, fallback chain, several agents, a report. */
import { expect, test } from "vitest";
import { htmlString } from "../html.js";
import { withFormToken } from "./request-context.js";
import { renderExecutionPlanDocument } from "../plan.js";
import { canonicalChainJson, chainTermsLines, LIVE_CHAIN_VERSION, releaseAsksAgainWords, releaseCheckSentence, releaseTermsSentence, type ChainEntry, type Scope } from "../scope.js";
import { RELEASE_CI_RUNNING_WORDS } from "../release-ci-hold.js";
import { approvalSheetParts, EVIDENCE_SHEET, planSheetHtml, type ApprovalSheetInput, type PlanContractView, type RouteView } from "./render-tasks.js";

const gemini = (model: string) => ({ provider: "gemini", model, approvalArgv: "auto_edit", maxTurns: "unsupported", repairMaxTurns: "unsupported",
  timeoutSeconds: 1800, repairTimeoutSeconds: 900, repairModel: "inherit" }) as unknown as ChainEntry["profile"];

const scopeOf = (extra: Partial<Scope> = {}): Scope => ({
  taskId: "t-1", goal: "Add subtract(a, b) next to add in src/math.js, with a test.", outOfScope: "The README and the build scripts",
  touches: ["src/math.js", "test/math.test.js", "/Users/someone/outside-the-project/notes.md"],
  acceptance: [
    { id: "c1", statement: "subtract(a, b) returns a minus b", evidence: ["check"], how: null },
    { id: "c2", statement: "The new function is shown working", evidence: ["screenshot", "manual-review"], how: null },
    { id: "c3", statement: "Only src/math.js and its test change", evidence: ["changed-path"], how: null },
  ],
  budgetMicrousd: 2_500_000, proposedAt: "2026-11-10T09:00:00.000Z", digest: "d".repeat(32), approvedAt: null, approvedBy: null, approvedDigest: null,
  qualityMode: "default", ...extra,
} as Scope);

const planDocument = renderExecutionPlanDocument({
  approach: "Add subtract right under add. Then cover it with one focused test, keeping the module's style.",
  milestones: ["Add subtract(a, b) to src/math.js, under add.", "Add a test for it in test/math.test.js.", "Run the project's checks."],
  dependencies: ["The existing test runner"], risks: ["add has no test of its own yet; this plan does not add one"],
  proof: ["subtract(a, b) returns a minus b", "The coverage report shows the new lines", "Only src/math.js and its test change, and no dependency is added"],
});

const route = (legs: { phase: "plan" | "build" | "repair" | "review"; provider: string; model: string }[]): RouteView => ({
  kind: "route", source: "proposed", legacy: null, problem: null, overrides: [], editable: false, editableWhy: null, replanOnPlanChange: false, digest: "r".repeat(32),
  choices: { plan: [], build: [], repair: [], review: [] },
  projection: { digest: "p".repeat(32), risk: "low", riskTitle: "Low risk", posture: "default", postureWords: "the default agents", demands: ["Touches tests"],
    legs: legs.map(one => ({ ...one, chosen: "recommended", tier: "standard", reasons: [`${one.phase} reason for ${one.model}`], problem: null,
      readiness: "ready", readinessReason: null, readinessRunner: null, observedAt: null, words: `${one.provider} · ${one.model}` })),
    summary: "Planner and builder chosen for a small change", halted: false, problems: [], size: null, sizeWords: null, sizeReason: null },
} as unknown as RouteView);

const amended: PlanContractView = { run: 41, sourceDigest: "s".repeat(32), filed: true, amendment: "The test file did not exist yet", current: true, changeWords: [],
  changes: [{ field: "touches", kind: "added", path: "test/math.test.js" }, { field: "goal", kind: "changed", before: "Add subtract", after: "Add subtract(a, b) next to add in src/math.js, with a test." }] };

const inputOf = (extra: Partial<ApprovalSheetInput> = {}): ApprovalSheetInput => ({
  surface: "task", action: "/t/t-1/approve", csrf: "c", nonce: "n", digest: "d".repeat(32), returnTo: null, scope: scopeOf(), planDocument, planContract: null,
  revision: null, revisionSourceHref: "", repairChain: null, route: null, coordinator: null, origin: null, deliverable: "branch", editHref: "#", notNowHref: "#",
  sticky: false, earlier: { active: 0, running: 0 }, edit: null, ...extra,
});

const chain = canonicalChainJson([{ profile: gemini("gemini-2.5-pro"), authMode: "subscription" }, { profile: gemini("gemini-2.5-flash"), authMode: "api-key" }], LIVE_CHAIN_VERSION);

const CASES: Record<string, ApprovalSheetInput> = {
  plain: inputOf(),
  repair: inputOf({ scope: scopeOf({ goal: "Add subtract(a, b) next to add. — repair exactly the unmet criteria named below; a comment cannot widen the scope. Unmet: c1." }),
    revision: { sourceTask: "t-0", sourceRun: 12, kind: "criterion-repair", lineage: null,
      comments: [{ path: "src/math.js", line: 3, note: "Unmet: c1. It returned a plus b.", author: "alex" }] },
    revisionSourceHref: "/r/12", earlier: { active: 1, running: 1 } }),
  amended: inputOf({ planContract: amended }),
  fallback: inputOf({ scope: scopeOf({ proposedChainJson: chain, candidate: "a".repeat(40) } as Partial<Scope>) }),
  agents: inputOf({ route: route([{ phase: "plan", provider: "claude", model: "opus" }, { phase: "build", provider: "claude", model: "sonnet" }, { phase: "review", provider: "codex", model: "gpt-5" }]),
    coordinator: { label: "ops-lead", filedAgo: "at 09:12" } }),
  report: inputOf({ deliverable: "report", planDocument: null }),
};

/** The old sheet's own labels that the sheet says as a heading instead ("Will change"). */
const RELABELLED = new Set(["Only in these paths:"]);
const CLAUSE = "clause:";
const said = (shown: string, term: string): boolean => term.startsWith(CLAUSE) ? shown.toLowerCase().includes(term.slice(CLAUSE.length).toLowerCase()) : shown.includes(term);

/** A fragment's visible text pieces: each text node, its whitespace collapsed, minus what the new sheet re-labels on
 * purpose — headings, row labels and fold summaries (the sheet has its own), a criterion's internal id, and the old
 * "shown by …" evidence words (the sheet says the same kinds in its own words, checked below). The "You're allowing"
 * line is compared clause by clause: the sheet says its warnings under Worth knowing. */
function termsOf(markup: string): string[] {
  const host = document.createElement("div");
  host.innerHTML = markup;
  host.querySelectorAll("h2, h3, dt, summary, .approval-signed-criteria code, .approval-signed-criteria .meta").forEach(one => one.remove());
  const out: string[] = [];
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text === "" || RELABELLED.has(text)) continue;
    // A clause the sheet says as its own sentence starts with a capital there.
    if (text.startsWith("You’re allowing: ")) out.push(...text.slice("You’re allowing: ".length).split(" · ").map(one => `${CLAUSE}${one}`));
    else out.push(text);
  }
  return out;
}

/** The new sheet's text a person can see: no <details>, nothing hidden. */
function visibleText(markup: string): string {
  const host = document.createElement("div");
  host.innerHTML = markup;
  host.querySelectorAll("details, [hidden], [aria-hidden='true']").forEach(one => one.remove());
  return (host.textContent ?? "").replace(/\s+/g, " ");
}

for (const [name, input] of Object.entries(CASES)) {
  test(`plan sheet parity, ${name}: every term the approval sheet shows is in the plan sheet, nothing folded`, () => {
    const parts = withFormToken("c", () => approvalSheetParts(input));
    const old = htmlString(parts.lead) + htmlString(parts.rows) + htmlString(parts.details);
    const sheet = withFormToken("c", () => htmlString(planSheetHtml(input)));
    expect(sheet).not.toContain("<details");
    const shown = visibleText(sheet);
    const terms = termsOf(old);
    expect(terms.length).toBeGreaterThan(5);
    expect(terms.filter(term => !said(shown, term)), `missing from the ${name} plan sheet`).toEqual([]);
    // Each requirement says how it is proven, in the sheet's words, and no internal id shows.
    for (const one of input.scope.acceptance) for (const kind of one.evidence) expect(shown).toContain(EVIDENCE_SHEET[kind]!);
    // (A signed goal or a person's note may name one; the sheet itself never prints a criterion's id.)
    expect(sheet).not.toMatch(/<code>c[0-9]+<\/code>/);
    expect(shown).not.toContain("[requires:");
    // Exact signed grants as signed, even a path outside the project.
    for (const path of input.scope.touches) expect(shown).toContain(path);
  });
}

test("the fixtures carry what they are named for", () => {
  expect(chainTermsLines(CASES["fallback"]!.scope).length).toBeGreaterThan(1);
  const fallback = visibleText(withFormToken("c", () => htmlString(planSheetHtml(CASES["fallback"]!))));
  // The paid fallback and an earlier running version are warnings: said under Worth knowing.
  expect(fallback).toMatch(/Worth knowing.*which spends money/);
  expect(visibleText(htmlString(planSheetHtml(CASES["repair"]!)))).toMatch(/Worth knowing.*An earlier version is still running/);
  expect(visibleText(htmlString(planSheetHtml(CASES["amended"]!)))).toMatch(/Worth knowing.*The plan makes 2 changes to what you filed/);
  // The lead is the approach's first sentence; the rest of the approach follows; the goal shows because it differs.
  const plain = visibleText(htmlString(planSheetHtml(CASES["plain"]!)));
  expect(plain).toContain("Add subtract right under add.");
  expect(plain).toContain("Then cover it with one focused test");
  expect(plain).toContain("Steps");
  // A plan proof line no requirement already says follows Done when; one a requirement says isn't repeated.
  expect(plain).toContain("The coverage report shows the new lines");
  expect(plain.split("subtract(a, b) returns a minus b").length - 1).toBe(1);
  // A proof line that adds a condition to a requirement is its own line: only a word-for-word repeat is dropped.
  expect(plain).toContain("Only src/math.js and its test change, and no dependency is added");
  // No plan document: the goal leads and isn't said twice.
  const report = visibleText(htmlString(planSheetHtml(CASES["report"]!)));
  expect(report.split("Add subtract(a, b) next to add in src/math.js, with a test.").length - 1).toBe(1);
  expect(report).toContain("Read-only: it reports back");
});

test("an older plan that doesn't parse keeps its text, as written", () => {
  const sheet = visibleText(htmlString(planSheetHtml(inputOf({ planDocument: "Just do it carefully.\nNo headings here." }))));
  expect(sheet).toContain("Just do it carefully.");
});

test("a release's terms are in the plan sheet, whole: what later ships without asking, and what asks again, never folded", () => {
  const terms = { v: 1, repo: "/work/shop", packageVersion: "1.4.0", branch: "release-1.4.0", pr: 12, base: "main", approvedSha: "a".repeat(40), approvedTree: "b".repeat(40),
    policy: { v: 1, rules: 1, carry: true, protectProject: false, protectedPaths: ["src/billing"], limits: { lines: 400, files: 20, churn: 800 } },
    grant: { id: 3, digest: "g".repeat(16) }, access: "sandboxed", expiresAt: "2026-11-13T09:00:00.000Z" } as unknown as NonNullable<Scope["releaseTerms"]>;
  const markup = htmlString(planSheetHtml(inputOf({ scope: scopeOf({ releaseTerms: terms } as Partial<Scope>), releaseCiRunning: true })));
  expect(markup).not.toContain("<details");
  const sheet = visibleText(markup);
  expect(sheet).toContain(releaseTermsSentence(terms));
  expect(sheet).toContain("ship without asking you again");
  for (const line of releaseAsksAgainWords(terms)) expect(sheet).toContain(line);
  expect(sheet).toContain("src/billing");
  expect(sheet).toContain(RELEASE_CI_RUNNING_WORDS);
  // A release that asks for every commit says so, with no carry rules to list.
  const every = visibleText(htmlString(planSheetHtml(inputOf({ scope: scopeOf({ releaseTerms: { ...terms, policy: { ...terms.policy, carry: false } } } as Partial<Scope>) }))));
  expect(every).toContain("Every later commit asks for your approval again.");
  expect(every).not.toContain("What asks again");
  // A release check's purpose is said too (it reruns the same commit's check).
  const purpose = { v: 1, purpose: "release-check", repo: "/work/shop", packageVersion: "1.4.0", branch: "release-1.4.0", pr: 12, base: "main", approvedSha: "a".repeat(40),
    approvedTree: "b".repeat(40), grant: { id: 3, digest: "g".repeat(16) }, access: "sandboxed" } as unknown as NonNullable<Scope["releaseCheck"]>;
  expect(visibleText(htmlString(planSheetHtml(inputOf({ scope: scopeOf({ releaseCheck: purpose } as Partial<Scope>) }))))).toContain(releaseCheckSentence(purpose));
  // An ordinary task's sheet has no Release part.
  expect(htmlString(planSheetHtml(CASES["plain"]!))).not.toContain("data-plan-release");
});
