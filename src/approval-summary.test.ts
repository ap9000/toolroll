/** The approval summary (the terms diet, approval-summary.ts): short and plain on every surface, and still exact — every
 * bound field is shown or named, risks are never folded, and a change to what it says between display and press refuses. */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover, canonicalChainJson, LIVE_CHAIN_VERSION, liveChainFromJson, propose, type Scope } from "./scope.js";
import { runOperate } from "./operate.js";
import { approvalSummaryFor, approvalSummaryOf, boundFieldsOf, describeScope, limitChanges, revisionWords, summaryContextOf, summaryFields, summaryLines, summaryText, type SummaryContext } from "./approval-summary.js";
import { approvalFormDigest, approvalSheetParts, revisionLineageWords, type ApprovalSheetInput } from "./server/render-tasks.js";
import { planCardText } from "./chat-decide.js";
import { htmlString } from "./html.js";
import { stepCardsOf } from "./engine-reads.js";
import { stepCardsSchema } from "./contracts/engine-api.js";

const REPO = "/repo/main";
let dir: string, db: string, store: Store, token: string;
const at = new Date("2026-11-14T12:00:00Z");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "so-approval-summary-"));
  db = join(dir, "orders.db");
  store = openStore(db);
  const alex = addApprover(store, "alex", at);
  if (!alex.ok) throw new Error("alex");
  token = alex.token;
  for (const phase of ["plan", "build", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "alex", at);
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const criterion = (id: string, statement: string, evidence: ("check" | "manual-review")[] = ["manual-review"]) => ({ id, statement, how: null, evidence });
function file(id: string, input: { goal?: string; touches?: string[]; outOfScope?: string; budgetMicrousd?: number; pin?: [string, string] } = {}): Scope {
  store.createTask({ id, title: id }, at);
  store.placeTask(store.lookupRef(id)!.id, REPO);
  if (input.pin !== undefined) store.pinTaskAgent(store.lookupRef(id)!.id, input.pin[0], input.pin[1]);
  return propose(store, { taskId: id, goal: input.goal ?? "Add a per-account guard to the payout limiter.", touches: input.touches ?? [],
    outOfScope: input.outOfScope ?? null, ...(input.budgetMicrousd === undefined ? {} : { budgetMicrousd: input.budgetMicrousd }),
    acceptance: [criterion("c1", "Two settlements can't both pass the limiter."), criterion("c2", "The limiter tests pass.", ["check"])], now: at });
}
const contextOf = (scope: Scope): SummaryContext => summaryContextOf(store, scope.taskId, scope, at);
const linesOf = (scope: Scope, extra: Partial<SummaryContext> = {}): string => summaryLines(approvalSummaryOf(scope, { ...contextOf(scope), ...extra })).join("\n");

/** Words the old terms used that a person shouldn't have to decode. */
const BANNED = /re-resolved|inherited terms|repair chain|attempt cap|exclusions|\broute\b|digest/i;

/** Every representative scope, filed for real, with the context it is shown with, read when it was filed. */
function representative(): { name: string; scope: Scope; context: SummaryContext }[] {
  const made: { name: string; scope: Scope; context: SummaryContext }[] = [];
  const add = (name: string, scope: Scope, extra: Partial<SummaryContext> = {}) => made.push({ name, scope, context: { ...contextOf(scope), ...extra } });
  add("plain", file("plain"));
  add("revision", file("revision", { goal: "Add a per-account guard to the payout limiter. — repair exactly the unmet criteria named below; a comment cannot widen the scope. Unmet: c1." }),
    { revision: { sourceTask: "plain", sourceRun: 9, hadPlan: true, changed: [], problem: null, repair: { cap: null, remaining: null } } });
  add("custom model", file("custom", { pin: ["codex", "gpt-5-codex"] }));
  add("path limits", file("paths", { touches: ["src/payout-limiter.ts", "src/settle.ts"], outOfScope: "No changes to the limiter's public API." }));
  add("budget", file("budget", { budgetMicrousd: 2_500_000 }));
  store.setProjectNetwork(REPO, { mode: "open", hosts: [], loopback: "proxy-only" }, "alex", at);
  add("network", file("network"));
  store.setProjectNetwork(REPO, { mode: "allowlist", hosts: [], loopback: "proxy-only" }, "alex", at);
  store.setApprovalRules(REPO, { notRequester: false, protectProject: true, protectedPaths: [] }, "alex", at);
  add("team rule", file("rule"));
  store.setApprovalRules(REPO, { notRequester: false, protectProject: false, protectedPaths: [] }, "alex", at);
  return made;
}

describe("the summary, short and plain", () => {
  test("representative scopes read as their decisions, what differs, every risk, and the usual settings by name", () => {
    const shown = Object.fromEntries(representative().map(one => [one.name, summaryLines(approvalSummaryOf(one.scope, one.context)).join("\n")]));
    expect(shown["plain"]).toMatchInlineSnapshot(`
      "  Goal         Add a per-account guard to the payout limiter.
        Done when    Two settlements can't both pass the limiter. (you review it)
                     The limiter tests pass. (runs automatically)
        Agent        Claude Sonnet plans, builds, fixes and reviews
        Files        any file in the project
        Network      the agent's provider
        Tools        file edits and routine commands; anything risky stops
        May cost     no cap: an attempt runs until it finishes or reaches its time limit
        Usual        Your usual project settings: checks Default · writes only its checkout, its caches and its temp folder · reads your home folder, as in Anthropic's sandbox runtime; never Toolroll's own folders; other tasks' work read, never written · time limit stops after 1000 turns or 20 min without progress · fixes on the same model, up to 4 turns and 5 min · project checks sandboxed"
    `);
    expect(shown["revision"]).toMatchInlineSnapshot(`
      "  Revision     This revises build #9. It keeps the same limits. Each extra attempt asks you first.
        Goal         Add a per-account guard to the payout limiter. — repair exactly the unmet criteria named below; a comment cannot widen the scope. Unmet: c1.
        Done when    Two settlements can't both pass the limiter. (you review it)
                     The limiter tests pass. (runs automatically)
        Agent        Claude Sonnet plans, builds, fixes and reviews
        Files        any file in the project
        Network      the agent's provider
        Tools        file edits and routine commands; anything risky stops
        May cost     no cap: an attempt runs until it finishes or reaches its time limit
        Usual        Your usual project settings: checks Default · writes only its checkout, its caches and its temp folder · reads your home folder, as in Anthropic's sandbox runtime; never Toolroll's own folders; other tasks' work read, never written · time limit stops after 1000 turns or 20 min without progress · fixes on the same model, up to 4 turns and 5 min · project checks sandboxed"
    `);
    expect(shown["custom model"]).toMatchInlineSnapshot(`
      "  Goal         Add a per-account guard to the payout limiter.
        Done when    Two settlements can't both pass the limiter. (you review it)
                     The limiter tests pass. (runs automatically)
        Agent        Claude Sonnet plans and reviews; Codex · gpt-5-codex builds and fixes
        Files        any file in the project
        Network      the agent's provider
        Tools        file edits and commands inside the project only
        May cost     no cap: an attempt runs until it finishes or reaches its time limit
        Your pick    builder Codex · gpt-5-codex, not the project’s usual pick
        Usual        Your usual project settings: checks Default · writes only its checkout, its caches and its temp folder · reads your home folder, as in Anthropic's sandbox runtime; never Toolroll's own folders; other tasks' work read, never written · time limit stops after 20 min without progress · fixes on the same model, up to 5 min · project checks sandboxed"
    `);
    expect(shown["path limits"]).toMatchInlineSnapshot(`
      "  Goal         Add a per-account guard to the payout limiter.
        Won’t touch  No changes to the limiter's public API.
        Done when    Two settlements can't both pass the limiter. (you review it)
                     The limiter tests pass. (runs automatically)
        Agent        Claude Sonnet plans, builds, fixes and reviews
        Files        only src/payout-limiter.ts, src/settle.ts
        Network      the agent's provider
        Tools        file edits and routine commands; anything risky stops
        May cost     no cap: an attempt runs until it finishes or reaches its time limit
        Usual        Your usual project settings: checks Default · writes only its checkout, its caches and its temp folder · reads your home folder, as in Anthropic's sandbox runtime; never Toolroll's own folders; other tasks' work read, never written · time limit stops after 1000 turns or 20 min without progress · fixes on the same model, up to 4 turns and 5 min · project checks sandboxed"
    `);
    expect(shown["budget"]).toMatchInlineSnapshot(`
      "  Goal         Add a per-account guard to the payout limiter.
        Done when    Two settlements can't both pass the limiter. (you review it)
                     The limiter tests pass. (runs automatically)
        Agent        Claude Sonnet plans, builds, fixes and reviews
        Files        any file in the project
        Network      the agent's provider
        Tools        file edits and routine commands; anything risky stops
        May cost     up to $2.50 per attempt; the agent is stopped there
        Usual        Your usual project settings: checks Default · writes only its checkout, its caches and its temp folder · reads your home folder, as in Anthropic's sandbox runtime; never Toolroll's own folders; other tasks' work read, never written · time limit stops after 1000 turns or 20 min without progress · fixes on the same model, up to 4 turns and 5 min · project checks sandboxed"
    `);
    expect(shown["network"]).toMatchInlineSnapshot(`
      "  Goal         Add a per-account guard to the payout limiter.
        Done when    Two settlements can't both pass the limiter. (you review it)
                     The limiter tests pass. (runs automatically)
        Agent        Claude Sonnet plans, builds, fixes and reviews
        Files        any file in the project
        Network      open — any host
        Tools        file edits and routine commands; anything risky stops
        May cost     no cap: an attempt runs until it finishes or reaches its time limit
        Usual        Your usual project settings: checks Default · writes only its checkout, its caches and its temp folder · reads your home folder, as in Anthropic's sandbox runtime; never Toolroll's own folders; other tasks' work read, never written · time limit stops after 1000 turns or 20 min without progress · fixes on the same model, up to 4 turns and 5 min · project checks sandboxed"
    `);
    expect(shown["team rule"]).toMatchInlineSnapshot(`
      "  Goal         Add a per-account guard to the payout limiter.
        Done when    Two settlements can't both pass the limiter. (you review it)
                     The limiter tests pass. (runs automatically)
        Agent        Claude Sonnet plans, builds, fixes and reviews
        Files        any file in the project
        Network      the agent's provider
        Tools        file edits and routine commands; anything risky stops
        May cost     no cap: an attempt runs until it finishes or reaches its time limit
        Note         This project protects this work: two people must approve it.
        Usual        Your usual project settings: checks Default · writes only its checkout, its caches and its temp folder · reads your home folder, as in Anthropic's sandbox runtime; never Toolroll's own folders; other tasks' work read, never written · time limit stops after 1000 turns or 20 min without progress · fixes on the same model, up to 4 turns and 5 min · project checks sandboxed"
    `);
  });

  test("a setting that differs from the project's usual one is said in the open, with what is usual", () => {
    const scope = file("writes");
    expect(linesOf(scope)).not.toMatch(/^ {2}Writes/m);
    // The project now writes anywhere: this scope's sealed "only its checkout" is no longer the usual setting.
    store.setProjectWrites(REPO, "anywhere", "alex", at);
    expect(linesOf(scope)).toMatch(/^ {2}Writes {7}only its checkout, its caches and its temp folder \(usually anywhere outside/m);
    // Without the project's settings to compare, nothing claims to be usual.
    expect(summaryLines(approvalSummaryOf(scope)).join("\n")).toMatch(/Other settings:/);
  });
});

describe("exact consent", () => {
  test("every bound field — each route leg and the whole goal included — is in the summary or the usual settings", () => {
    for (const one of representative()) {
      const summary = approvalSummaryOf(one.scope, one.context);
      const covered = summaryFields(summary);
      const bound = boundFieldsOf(one.scope);
      // Each leg the route binds, the reviewer's too, is a bound field of its own.
      expect(bound).toEqual(expect.arrayContaining(["route.plan", "route.build", "route.repair", "route.review"]));
      for (const field of bound) expect(covered.has(field), `${one.name}: ${field}`).toBe(true);
      // The goal is shown whole, never cut at a repair's brief.
      expect(summary.decisions.find(row => row.fields.includes("goal"))?.words).toBe(one.scope.goal);
      expect(summaryLines(summary).join("\n")).toContain(one.scope.goal);
      // Every leg is named: the reviewer here is the configured one.
      expect(summary.decisions.find(row => row.label === "Agent")?.words).toMatch(/reviews/);
    }
  });

  test("risks are never folded into the usual settings", () => {
    store.setProjectCheckAccess(REPO, "unsandboxed", "alex", at, { may: "widen" });
    store.setProjectSandbox(REPO, { readDeny: [], machLookup: ["com.apple.trustd.agent"] }, "alex", at);
    store.setApprovalRules(REPO, { notRequester: true, protectProject: true, protectedPaths: [] }, "alex", at);
    const scope = file("risky");
    const summary = approvalSummaryOf(scope, contextOf(scope));
    const warnings = summary.warnings.map(one => one.words).join("\n");
    expect(warnings).toContain("Project checks: not sandboxed.");
    expect(warnings).toContain("also reaches these macOS services: com.apple.trustd.agent");
    expect(warnings).toContain("two people must approve it");
    expect(warnings).toContain("can’t approve it");
    expect(summary.usual.map(one => one.words).join("\n")).not.toMatch(/not sandboxed|macOS services/);
  });

  // Nested fields, each checked by the words a person reads, never by the rows' own field labels (Codex r1 finding 7).
  test("a fallback's own access and limits are said where they differ from the first agent's", () => {
    const scope = file("t-chain");
    const base = scope.profile!;
    const wide = { ...base, network: { version: 1, mode: "open", hosts: [], loopback: "any" }, writes: "anywhere", checkAccess: "unsandboxed", machLookup: ["com.apple.trustd.agent"], timeoutSeconds: 7200 } as typeof base;
    const chained = { ...scope, proposedChainJson: canonicalChainJson([{ profile: base, authMode: "subscription" }, { profile: wide, authMode: "api-key" }], LIVE_CHAIN_VERSION) } as Scope;
    const text = summaryLines(approvalSummaryOf(chained, contextOf(scope))).join("\n");
    expect(text).toContain("Fallback 2 differs from the first: network: open — any host, and every local service on this Mac (the first: the agent's provider)");
    expect(text).toContain("writes: anywhere outside Toolroll's fenced folders");
    expect(text).toContain("project checks: not sandboxed");
    expect(text).toContain("macOS services: also reaches these macOS services: com.apple.trustd.agent");
    expect(text).toContain("time limit: stops after 1000 turns or 120 min without progress");
    // Compared raw, never through rounded words: one second more reads as the same "20 min", so the values are said.
    const closer = { ...base, timeoutSeconds: base.timeoutSeconds + 1 } as typeof base;
    expect(Math.round(closer.timeoutSeconds / 60)).toBe(Math.round(base.timeoutSeconds / 60));
    const near = { ...scope, proposedChainJson: canonicalChainJson([{ profile: base, authMode: "subscription" }, { profile: closer, authMode: "subscription" }], LIVE_CHAIN_VERSION) } as Scope;
    expect(summaryLines(approvalSummaryOf(near, contextOf(scope))).join("\n")).toContain(`Fallback 2 differs from the first: time limit: timeoutSeconds ${base.timeoutSeconds + 1} (the first: timeoutSeconds ${base.timeoutSeconds})`);
    // Said in the open, never in the usual settings' line.
    expect(text.split("\n").find(line => line.startsWith("  Usual"))).not.toMatch(/Fallback|not sandboxed/);
  });

  test("every host is said exactly unless it is this agent's own provider or a whole registry", () => {
    const scope = file("t-hosts");
    const hosts = [...scope.profile!.network!.hosts, "api.openai.com", "files.pythonhosted.org"];
    const wider = { ...scope, profile: { ...scope.profile!, network: { ...scope.profile!.network!, hosts } } } as Scope;
    const network = approvalSummaryOf(wider, contextOf(scope)).decisions.find(row => row.label === "Network")!;
    expect(network.words).toBe("the agent's provider, and api.openai.com, files.pythonhosted.org");
    // A host beyond this agent's own provider is risky access: said in the open, never folded.
    expect(network.risky).toBe(true);
  });

  test("a release's repository, branch, grant and check access are said whether or not it carries", () => {
    const scope = file("t-release");
    const terms = { v: 1, repo: "/work/shop", packageVersion: "1.4.0", branch: "release-1.4.0", pr: 12, base: "main", approvedSha: "a".repeat(40), approvedTree: "b".repeat(40),
      policy: { v: 1, rules: 1, carry: false, protectProject: false, protectedPaths: [], limits: { lines: 400, files: 20, churn: 800 } },
      grant: { id: 3, digest: "g".repeat(16) }, access: "unsandboxed", expiresAt: "2026-11-13T09:00:00.000Z" } as unknown as NonNullable<Scope["releaseTerms"]>;
    for (const carry of [false, true]) {
      const text = summaryLines(approvalSummaryOf({ ...scope, releaseTerms: { ...terms, policy: { ...terms.policy, carry } } } as Scope, contextOf(scope))).join("\n");
      expect(text, String(carry)).toContain("Repository /work/shop, branch release-1.4.0 into main, check grant 3");
      expect(text, String(carry)).toContain("outside the sandbox (unsandboxed)");
    }
    const purpose = { v: 1, purpose: "release-check", repo: "/work/shop", packageVersion: "1.4.0", branch: "release-1.4.0", pr: 12, base: "main", approvedSha: "a".repeat(40),
      approvedTree: "b".repeat(40), grant: { id: 4, digest: "g".repeat(16) }, access: "sandboxed" } as unknown as NonNullable<Scope["releaseCheck"]>;
    expect(summaryLines(approvalSummaryOf({ ...scope, releaseCheck: purpose } as Scope, contextOf(scope))).join("\n")).toContain("Repository /work/shop, branch release-1.4.0 into main, check grant 4, checks in the sandbox.");
  });

  test("risky access stays in the open even when it is the project's usual setting", () => {
    store.setProjectWrites(REPO, "anywhere", "alex", at);
    const scope = file("t-anywhere");
    const summary = approvalSummaryOf(scope, contextOf(scope));
    expect(summary.usual.map(row => row.label)).not.toContain("Writes");
    expect(summaryLines(summary).join("\n")).toMatch(/^ {2}Writes {7}anywhere outside Toolroll's fenced folders/m);
    // And the baseline is bound: the usual network changing alone is another key.
    const before = summary.key;
    store.setProjectNetwork(REPO, { mode: "allowlist", hosts: ["api.stripe.com"], loopback: "proxy-only" }, "alex", at);
    expect(approvalSummaryOf(scope, contextOf(scope)).key).not.toBe(before);
  });

  // One case per effective limit, compared raw (Codex r2 findings 6 and 7): never through field labels or rounded words.
  test("a revision says exactly which limits changed from the build it revises: every effective limit, on its raw value", () => {
    const source = file("t-source");
    const p = source.profile!;
    const changed = (next: Partial<Scope> & { profile?: typeof p }) => limitChanges(source, { ...source, ...next } as Scope);
    const as = (profile: Partial<typeof p>) => ({ profile: { ...p, ...profile } as typeof p });
    expect(limitChanges(source, source)).toEqual([]);
    const cases: [string, Partial<Scope> & { profile?: typeof p }, { label: string; now: RegExp }][] = [
      ["network", as({ network: { ...p.network!, hosts: [...p.network!.hosts, "api.stripe.com"] } }), { label: "network", now: /api\.stripe\.com/ }],
      ["writes", as({ writes: "anywhere" }), { label: "writes", now: /^anywhere outside/ }],
      ["read denies", as({ readDeny: ["~/.ssh"] }), { label: "reads", now: /except ~\/\.ssh/ }],
      ["services", as({ machLookup: ["com.apple.trustd.agent"] }), { label: "macOS services", now: /com\.apple\.trustd\.agent/ }],
      ["runtime", as({ timeoutSeconds: 7200 }), { label: "time limit", now: /120 min/ }],
      ["repair", as({ repairModel: "opus" }), { label: "fixes", now: /^on opus/ }],
      ["budget", { budgetMicrousd: 3_000_000 }, { label: "cost", now: /\$3\.00/ }],
      ["checks level", { qualityMode: "strict" }, { label: "checks level", now: /Strict/ }],
      ["check access", as({ checkAccess: "unsandboxed" }), { label: "project checks", now: /^not sandboxed$/ }],
      ["tools", as({ permissionArgv: "bypassPermissions" } as Partial<typeof p>), { label: "tools", now: /full access/ }],
    ];
    for (const [name, next, want] of cases) {
      const got = changed(next);
      expect(got.map(one => one.label), name).toEqual([want.label]);
      expect(got[0]!.now, name).toMatch(want.now);
      expect(got[0]!.was, name).not.toBe(got[0]!.now);
    }
    // The exact boundary: 1200 and 1201 seconds read alike in words, so the exact values are said.
    const at1200 = { ...source, profile: { ...p, timeoutSeconds: 1200 } } as Scope;
    expect(limitChanges(at1200, { ...source, profile: { ...p, timeoutSeconds: 1201 } } as Scope)).toEqual([{ label: "time limit", was: "timeoutSeconds 1200", now: "timeoutSeconds 1201" }]);
    // Each fallback entry's own effective profile, by its place: widened, added, or gone.
    const chain = (second: typeof p | null) => ({ proposedChainJson: second === null ? null : canonicalChainJson([{ profile: p, authMode: "subscription" }, { profile: second, authMode: "subscription" }], LIVE_CHAIN_VERSION) });
    const second = { ...p, model: "haiku" } as typeof p;
    const withChain = { ...source, ...chain(second) } as Scope;
    expect(liveChainFromJson(withChain.proposedChainJson ?? null)).not.toBeNull();
    expect(limitChanges(withChain, withChain)).toEqual([]);
    const widened = limitChanges(withChain, { ...source, ...chain({ ...second, writes: "anywhere", network: { version: 1, mode: "open", hosts: [], loopback: "proxy-only" } } as typeof p) } as Scope);
    expect(widened.map(one => one.label)).toEqual(["fallback 2 network", "fallback 2 writes"]);
    expect(widened[1]!.now).toMatch(/^anywhere outside/);
    const fewer = limitChanges(withChain, source);
    expect(fewer).toHaveLength(1);
    expect(fewer[0]).toMatchObject({ label: "fallback 2", now: "none" });
    // Said as one sentence and one row per limit: "Writes: was …, now …".
    store.setProjectWrites(REPO, "anywhere", "alex", at);
    const child = file("t-child");
    const facts = { sourceTask: "t-source", sourceRun: 9, hadPlan: true, changed: limitChanges(source, child), problem: null, repair: null };
    expect(revisionWords(facts)).toBe("This revises build #9. One limit changes from that build: writes.");
    expect(summaryLines(approvalSummaryOf(child, { ...contextOf(child), revision: facts })).join("\n"))
      .toContain("  Changed      writes: was only its checkout, its caches and its temp folder, now anywhere outside Toolroll's fenced folders (an approver's choice)");
  });

  test("a scripted CLI yes without --terms approves nothing, and says the terms and the key to run it with", async () => {
    file("t-script");
    const digest = store.getScope("t-script")!.digest;
    const key = approvalSummaryFor(store, "t-script", new Date())!.key;
    store.close();
    const lines: string[] = [];
    const code = await runOperate("task", ["approve", "t-script", "--yes", "--digest", digest, "--as", "alex", "--token", token], line => lines.push(line), { databaseFile: db });
    store = openStore(db);
    expect(code).toBe(3);
    expect(lines.join("\n")).toContain("Name the terms you read. Nothing was approved.");
    expect(lines.join("\n")).toContain(`--terms ${key}`);
    expect(lines.join("\n")).toMatch(/^ {2}Files {8}any file in the project$/m);
    expect(store.getScope("t-script")!.approvedAt).toBeNull();
  });

  test("a change to the usual settings between display and press refuses the CLI's yes; unchanged, the same yes stands", async () => {
    const run = async (argv: string[]) => { const lines: string[] = []; const code = await runOperate("task", argv, line => lines.push(line), { databaseFile: db }); return { code, text: lines.join("\n") }; };
    file("t-stale");
    file("t-kept");
    const keyOf = (id: string) => approvalSummaryFor(store, id, new Date())!.key;
    const shownStale = keyOf("t-stale"), shownKept = keyOf("t-kept");
    // Shown, then the installation's checks level changes: what was "usual" is now a difference.
    store.setQualityDefault("strict", "alex", new Date());
    expect(keyOf("t-stale")).not.toBe(shownStale);
    const staleDigest = store.getScope("t-stale")!.digest;
    store.close();
    const stale = await run(["approve", "t-stale", "--yes", "--digest", staleDigest, "--terms", shownStale, "--as", "alex", "--token", token]);
    expect(stale.text).toMatch(/changed since you read it/);
    store = openStore(db);
    expect(store.getScope("t-stale")!.approvedDigest).toBeNull();
    // Read again under today's settings, the yes is to what is now shown, and stands.
    const kept = keyOf("t-kept");
    expect(kept).not.toBe(shownKept);
    const digest = store.getScope("t-kept")!.digest;
    store.close();
    const ok = await run(["approve", "t-kept", "--yes", "--digest", digest, "--terms", kept, "--as", "alex", "--token", token]);
    store = openStore(db);
    expect(ok.text).toMatch(/Approved/);
    expect(store.getScope("t-kept")!.approvedDigest).toBe(digest);
  });

  test("the browser's form digest pins the summary: a change to the usual settings is a stale form", () => {
    const scope = file("t-form");
    const before = approvalFormDigest(scope.digest, null, approvalSummaryFor(store, "t-form", at)!.key);
    expect(approvalFormDigest(scope.digest, null, approvalSummaryFor(store, "t-form", at)!.key)).toBe(before);
    store.setProjectWrites(REPO, "anywhere", "alex", at);
    expect(approvalFormDigest(scope.digest, null, approvalSummaryFor(store, "t-form", at)!.key)).not.toBe(before);
    // A plan changed is stale too, as before; and with neither a plan nor a summary the form is the scope's own digest.
    expect(approvalFormDigest(scope.digest, "a".repeat(64), approvalSummaryFor(store, "t-form", at)!.key)).not.toBe(before);
    expect(approvalFormDigest(scope.digest, null)).toBe(scope.digest);
  });
});

describe("the engine API's Approval step", () => {
  test("carries the same summary and the key a yes pins, only while the approval waits", () => {
    file("t-steps");
    const steps = () => stepCardsOf({ store, family: store.taskFamilyOf("t-steps", null, true)!, now: at, access: { principal: "operator", repos: null }, evidenceRoot: dir });
    const approveCard = steps().cards?.find(one => one.key === "approve");
    expect(approveCard?.terms?.key).toBe(approvalSummaryFor(store, "t-steps", at)!.key);
    expect(approveCard?.terms?.rows.map(one => one.label)).toEqual(["Goal", "Done when", "Agent", "Files", "Network", "Tools", "May cost"]);
    expect(approveCard?.terms?.usualLabel).toBe("Your usual project settings");
    expect(stepCardsSchema.parse(steps())).toEqual(steps());
    expect(steps().cards?.filter(one => one.terms !== undefined).map(one => one.key)).toEqual(["approve"]);
  });
});

describe("one vocabulary on every surface", () => {
  test("no surface that asks for a yes uses the old words", () => {
    for (const one of representative()) {
      const context = one.context;
      const summary = approvalSummaryOf(one.scope, context);
      const input: ApprovalSheetInput = { surface: "task", action: "/t/x/approve", csrf: "c", nonce: "n", digest: one.scope.digest, returnTo: null, scope: one.scope, summary,
        planDocument: null, planContract: null, revision: null, revisionSourceHref: "", repairChain: null, route: null, coordinator: null, deliverable: "branch",
        editHref: "#scope", notNowHref: "/", sticky: false, earlier: { active: 1, running: 1 }, edit: null };
      const parts = approvalSheetParts(input);
      const surfaces = {
        cli: describeScope(one.scope, undefined, null, context).join("\n"),
        text: summaryText(summary),
        sheet: htmlString(parts.sheet), rows: htmlString(parts.rows), details: htmlString(parts.details),
        chatApp: planCardText(store, one.scope.taskId, one.scope),
        lineage: revisionLineageWords({ sourceTask: "plain", sourceRun: 9, ancestors: ["plain"], root: "plain", terms: null, sourceHadScope: true,
          repair: { rootTask: "plain", attemptsUsed: 1, cap: null, remaining: null, thisAttempt: 1, via: null } }).join("\n"),
      };
      for (const [name, words] of Object.entries(surfaces)) expect(words, `${one.name} · ${name}`).not.toMatch(BANNED);
      // The usual settings are a disclosure on the web, and named on the text surfaces.
      expect(htmlString(parts.sheet)).toContain("data-terms-usual");
      expect(surfaces.cli).toContain("Your usual project settings:");
    }
  });
});
