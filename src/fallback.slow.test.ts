/**
 * Fallback chains, end to end against real git and the real tick: an agent that runs out of its plan hands its task to
 * the next approved agent, and every way that could go wrong spends nothing. Only the agents are stubs, speaking the
 * exact terminal a real exhausted run produced (test/fixtures/fallback). docs/plans/fallback-chains.md.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const login = vi.hoisted(() => ({ codex: "subscription" as "subscription" | "api-key" | null }));
vi.mock("./codex-login.js", () => ({ codexLoginBilling: async () => login.codex }));
vi.mock("./attest.js", async original => ({ ...await original<typeof import("./attest.js")>(), reportedVersion: async () => "2.1.319 (Claude Code)" }));

import { runOperate } from "./operate.js";
import { run as exec } from "./exec.js";
import { openStore, type Store } from "./store.js";
import type { Runner } from "./builder.js";
import { withActor } from "./actor.js";
import { bindRunToWalk, chainCustodyProblem, clearFallbackChain, setFallbackChain, setPaidGrant, chainJsonOf, chainSealProblem, dispatchEntryOf, fallbackBriefFor, fallbackSettingOf, moveOnIfExhausted, pinnedEntryOf, ranOutOnChain, reconcileWalks } from "./fallback.js";
import { canonicalChainJson, chainFromJson, chainTermsLines, describeScope, liveChainFromJson, scopeAuthorityOf } from "./scope.js";
import { scopeTermsText, shownTermsDigest } from "./chat-terms.js";
import { planCardText } from "./chat-decide.js";
import { approvalSheetHtml, approveKitOf } from "./server/render-tasks.js";
import { htmlString } from "./html.js";
import { withFormToken } from "./server/request-context.js";
import { OK, T0, AGENT_SAID, registerRunner, concludeDone } from "../test/tick-kit.js";

const FIXTURE = JSON.parse(readFileSync(new URL("../test/fixtures/fallback/claude-subscription-weekly-limit.json", import.meta.url), "utf8")) as { terminal: { text: string } };
const PARK = { urgency: "blocking", recap: "The guard needs a policy call: the payout path can fail open or fail closed.", question: "Fail open or fail closed on timeout?",
  options: [{ id: "open", label: "Fail open", consequence: "Payouts continue; bad ones slip through.", reversible: true }, { id: "closed", label: "Fail closed", consequence: "Payouts pause; support tickets.", reversible: true }], recommendation: "closed" };
const later = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

describe("a chain, against real git", () => {
  let base = "", repo = "", db = "", pool = "", lines: string[] = [], token = "", approver = "";
  let runs: { model: string | null; prompt: string; head: string }[] = [];

  const git = async (args: string[], cwd = repo) => (await exec("git", args, { cwd })).stdout.trim();
  const say = (argv: string[], runner?: Runner, now: Date = T0) => {
    const [command = "", ...rest] = argv;
    lines = [];
    return runOperate(command, rest, line => lines.push(line), { databaseFile: db, now, ...(runner === undefined ? {} : { agentRunner: runner }) });
  };
  const payload = () => JSON.parse(lines.join("\n"));
  const seen = async (args: readonly string[], cwd: string) => {
    runs.push({ model: args[args.indexOf("--model") + 1] ?? null, prompt: args[args.indexOf("-p") + 1] ?? "", head: await git(["rev-parse", "HEAD"], cwd) });
  };
  /** What the real run printed: the session's init, then its structural failure result, exit 1. */
  const exhausted = (midTask = true): Runner => async (_file, args, options) => {
    const cwd = options?.cwd ?? "";
    await seen(args, cwd);
    if (midTask) await writeFile(join(cwd, "half-done.ts"), "export const half = true;\n");
    const result = { type: "result", subtype: "success", is_error: true, result: FIXTURE.terminal.text, usage: { input_tokens: 0, output_tokens: 0 } };
    return { ...OK, code: 1, stdout: [JSON.stringify({ type: "system", subtype: "init", session_id: "s-1" }), JSON.stringify(result)].join("\n") };
  };
  const finishes: Runner = async (_file, args, options) => {
    const cwd = options?.cwd ?? "";
    await seen(args, cwd);
    await writeFile(join(cwd, "guard.ts"), "export const guarded = true;\n");
    await concludeDone(cwd, args);
    return { ...OK, stdout: AGENT_SAID };
  };
  const byModel = (table: Record<string, Runner>): Runner => (file, args, options) => table[args[args.indexOf("--model") + 1] ?? ""]!(file, args, options);
  const tick = (runner: Runner, now: Date) => say(["tick", "--runner", "builder-1", "--token", token, "--repo", repo, "--pool", pool, "--json"], runner, now);
  const withStore = <T>(use: (store: Store) => T): T => { const store = openStore(db); try { return use(store); } finally { store.close(); } };

  const setUp = async (agents: string, paid = false) => {
    token = registerRunner(db, "builder-1", repo);
    await say(["approver", "add", "alex", "--json"]);
    approver = payload().token as string;
    for (const phase of ["build", "plan", "review"]) await say(["config", "set", phase, "--provider", "claude", "--model", "sonnet", "--as", "alex", "--token", approver, "--json"]);
    await say(["task", "add", "seed", "--id", "seed", "--repo", repo]);
    await say(["project", "fallback", "--repo", repo, "--agents", agents, ...(paid ? ["--allow-paid"] : []), "--as", "alex", "--token", approver, "--json"]);
    expect(payload().ok, lines.join("\n")).toBe(true);
    // This machine has seen Claude bill on its plan (a plan entry with no live probe needs that evidence).
    withStore(store => store.recordProviderBilling("claude", "subscription", T0));
  };
  const file = async (id: string) => {
    await say(["task", "add", "the work", "--id", id, "--repo", repo]);
    await say(["task", "scope", id, "--goal", "add a guard on the payout path", "--acceptance", "It is fixed and verified.|manual-review"]);
  };
  const approve = async (id: string) => {
    await say(["task", "approve", id, "--json"]);
    await say(["task", "approve", id, "--yes", "--digest", payload().scope.digest as string, "--as", "alex", "--token", approver]);
  };
  const outcomeOf = (id: string) => (payload().dispatched as { id: string; outcome: string; reason?: string }[]).find(one => one.id === id)!;
  const refOf = (id: string) => withStore(store => store.lookupRef(id)!.id);
  const walks = () => withStore(store => store.handle.prepare("SELECT cursor, state, closed_reason FROM fallback_walk ORDER BY id").all());

  beforeEach(async () => {
    login.codex = "subscription";
    base = realpathSync(await mkdtemp(join(tmpdir(), "toolroll-fallback-")));
    repo = join(base, "repo"); db = join(base, "queue.db"); pool = join(base, "pool"); runs = [];
    await mkdir(repo, { recursive: true });
    await git(["init", "-q", "-b", "main"]);
    await git(["config", "user.email", "test@example.com"]);
    await git(["config", "user.name", "Test"]);
    await writeFile(join(repo, "README.md"), "hello\n");
    await git(["add", "README.md"]);
    await git(["commit", "-qm", "README"]);
  });
  afterEach(async () => { await rm(base, { recursive: true, force: true }); });

  test("an agent runs out mid-task: its work is kept, the next approved agent continues it, no strike, and the walk closes", async () => {
    await setUp("claude:opus:plan");
    await file("t-1");
    expect(withStore(store => chainTermsLines(store.getScope("t-1")!)).join("\n")).toContain("Claude opus");
    await approve("t-1");
    await tick(byModel({ sonnet: exhausted(), opus: finishes }), T0);
    expect(outcomeOf("t-1"), lines.join("\n")).toMatchObject({ outcome: "failed", reason: "out of plan — moved to the next approved agent" });
    expect(withStore(store => store.lookupRef("t-1")!.strikes)).toBe(0);
    expect(withStore(store => store.getTask("t-1")!.state)).toBe("queued");
    expect(walks()).toMatchObject([{ cursor: 1, state: "open" }]);

    await tick(byModel({ sonnet: exhausted(), opus: finishes }), later(1));
    expect(runs.map(one => one.model)).toEqual(["sonnet", "opus"]);
    // The next agent starts from the first one's work, and is told so.
    expect(await git(["log", "-1", "--format=%B", runs[1]!.head])).toContain("Work in progress");
    expect(await git(["show", `${runs[1]!.head}:half-done.ts`])).toContain("half");
    expect(runs[1]!.prompt).toContain("ran out of its plan");
    expect(outcomeOf("t-1").outcome, lines.join("\n")).toBe("built");
    const stamped = withStore(store => store.handle.prepare("SELECT r.role, r.chain_index, r.model, r.outcome, r.reason, x.chosen FROM run r LEFT JOIN run_route x ON x.run = r.id WHERE r.chain_cycle IS NOT NULL ORDER BY r.id").all());
    expect(stamped).toMatchObject([{ chain_index: 0, model: "sonnet", outcome: "failed", reason: "usage-exhausted" }, { chain_index: 1, model: "opus", outcome: "built", chosen: "fallback" }]);
    await tick(finishes, later(2));
    expect(walks()).toMatchObject([{ cursor: 1, state: "closed", closed_reason: "succeeded" }]);
  });

  test("the move crosses providers: Codex takes over under its own sealed terms, on its own plan", async () => {
    await setUp("codex:gpt-5.5:plan");
    await file("t-1"); await approve("t-1");
    const codex: Runner = async (file, args, options) => {
      const cwd = options?.cwd ?? "";
      const stdin = String((options as { stdin?: string } | undefined)?.stdin ?? "");
      runs.push({ model: args[args.indexOf("--model") + 1] ?? null, prompt: `${args.join(" ")}\n${stdin}`, head: await git(["rev-parse", "HEAD"], cwd) });
      expect(file).toContain("codex");
      const name = /STANDING-ORDERS-DONE-[0-9a-f]{16}\.json/.exec(`${args.join(" ")}\n${stdin}`)?.[0];
      await writeFile(join(cwd, "guard.ts"), "export const guarded = true;\n");
      if (name !== undefined) await writeFile(join(cwd, name), JSON.stringify({ version: 1, status: "completed", conclusion: "Finished the guard." }));
      return { ...OK, stdout: [{ type: "thread.started", thread_id: "019a0000-0000-7000-8000-000000000000" }, { type: "item.completed", item: { type: "agent_message", text: "Finished the guard." } }, { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }].map(one => JSON.stringify(one)).join("\n") };
    };
    const either: Runner = (file, args, options) => (/codex/.test(file) ? codex : exhausted())(file, args, options);
    await tick(either, T0);
    await tick(either, later(1));
    expect(outcomeOf("t-1").outcome, lines.join("\n")).toBe("built");
    expect(runs.length).toBe(2);
    expect(withStore(store => store.handle.prepare("SELECT provider, auth_mode, chain_index FROM run WHERE chain_cycle IS NOT NULL ORDER BY id").all())).toMatchObject([{ provider: "claude", auth_mode: "subscription", chain_index: 0 }, { provider: "codex", auth_mode: "subscription", chain_index: 1 }]);
  });

  test("a parked fallback agent resumes as itself: the same place in the walk, no new edge, and never the base", async () => {
    await setUp("claude:opus:plan");
    await file("t-1"); await approve("t-1");
    const parks: Runner = async (_file, args, options) => {
      const cwd = options?.cwd ?? "";
      await seen(args, cwd);
      const name = /STANDING-ORDERS-PARK-[0-9a-f]{16}\.json/.exec(args[args.indexOf("-p") + 1] ?? "")?.[0];
      await writeFile(join(cwd, name!), JSON.stringify(PARK));
      return { ...OK, stdout: JSON.stringify({ result: "parked it" }) };
    };
    await tick(byModel({ sonnet: exhausted(false), opus: parks }), T0);
    await tick(byModel({ sonnet: exhausted(false), opus: parks }), later(1));
    expect(outcomeOf("t-1").outcome, lines.join("\n")).toBe("parked");
    await say(["decide", "1", "--choose", "closed", "--as", "alex", "--token", approver, "--json"], undefined, later(2));
    expect(payload().ok, lines.join("\n")).toBe(true);
    await tick(byModel({ sonnet: exhausted(false), opus: finishes }), later(3));
    expect(outcomeOf("t-1").outcome, lines.join("\n")).toBe("built");
    expect(runs.map(one => one.model)).toEqual(["sonnet", "opus", "opus"]);
    expect(withStore(store => store.handle.prepare("SELECT COUNT(*) AS n FROM fallback_move").get()!["n"])).toBe(1);
    expect(withStore(store => store.handle.prepare("SELECT chain_index FROM run WHERE chain_cycle IS NOT NULL ORDER BY id").all())).toEqual([{ chain_index: 0 }, { chain_index: 1 }, { chain_index: 1 }]);
  });

  test("a plan entry whose saved login is an API key never runs, never reads as paid, takes no strike, and doesn't loop", async () => {
    await setUp("codex:gpt-5.5:plan");
    await file("t-1"); await approve("t-1");
    login.codex = "api-key";
    const codexRan: string[] = [];
    const either: Runner = async (file, args, options) => { if (/codex/.test(file)) { codexRan.push(file); return { ...OK, code: 1 }; } return exhausted(false)(file, args, options); };
    await tick(either, T0);
    await tick(either, later(1));
    expect(codexRan).toEqual([]);
    expect(withStore(store => store.handle.prepare("SELECT provider, outcome, reason, provider_started_at FROM run WHERE provider = 'codex'").all())).toMatchObject([{ outcome: "refused", reason: "auth-mode", provider_started_at: null }]);
    expect(walks()).toMatchObject([{ cursor: 1, state: "closed", closed_reason: "entry-signed-out" }]);
    expect(withStore(store => store.lookupRef("t-1")!.strikes)).toBe(0);
    // The base runs out again within the window: the ordinary road, a strike, and no second move to the same agent.
    await tick(either, later(2));
    expect(walks()).toMatchObject([{ closed_reason: "entry-signed-out" }, { cursor: 0, state: "closed", closed_reason: "entry-signed-out" }]);
    expect(withStore(store => store.lookupRef("t-1")!.strikes)).toBe(1);
    expect(codexRan).toEqual([]);
  });

  test("a Claude plan entry runs only where Claude was seen billing on its plan", async () => {
    await setUp("claude:opus:plan");
    await file("t-1"); await approve("t-1");
    await tick(byModel({ sonnet: exhausted(false), opus: finishes }), T0);
    withStore(store => store.recordProviderBilling("claude", "api-key", later(1)));
    await tick(byModel({ sonnet: exhausted(false), opus: finishes }), later(1));
    expect(runs.map(one => one.model)).toEqual(["sonnet"]);
    expect(walks()).toMatchObject([{ cursor: 1, closed_reason: "entry-signed-out" }]);
  });

  test("an agent that commits for itself and then runs out keeps nothing and moves nowhere: the HEAD law holds", async () => {
    await setUp("claude:opus:plan");
    await file("t-1"); await approve("t-1");
    const commitsThenRunsOut: Runner = async (file, args, options) => {
      const cwd = options?.cwd ?? "";
      await writeFile(join(cwd, "sneaky.ts"), "export const sneaky = true;\n");
      await git(["add", "sneaky.ts"], cwd);
      await git(["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "agent-made"], cwd);
      await writeFile(join(cwd, "half-done.ts"), "export const half = true;\n");
      return exhausted(false)(file, args, options);
    };
    await tick(byModel({ sonnet: commitsThenRunsOut, opus: finishes }), T0);
    expect(withStore(store => store.handle.prepare("SELECT reason FROM run ORDER BY id DESC LIMIT 1").get())).toMatchObject({ reason: "no-op" });
    expect(await git(["log", "--format=%B", "-3", "toolroll/t-1"])).not.toContain("Work in progress");
    expect(walks()).toMatchObject([{ cursor: 0 }]);
    expect(withStore(store => store.lookupRef("t-1")!.strikes)).toBe(1);
  });

  test("running out during a repair turn stops the repairs and moves the owning attempt, with no strike", async () => {
    await setUp("claude:opus:plan");
    await file("t-1"); await approve("t-1");
    let sonnetCalls = 0;
    const stopsThenRunsOut: Runner = async (file, args, options) => {
      const cwd = options?.cwd ?? "";
      await seen(args, cwd);
      sonnetCalls++;
      const session = args[args.indexOf("--session-id") + 1] ?? args[args.indexOf("--resume") + 1] ?? "s-1";
      if (sonnetCalls === 1) {
        // Changes and no handoff: Toolroll resumes its own session for a short turn.
        await writeFile(join(cwd, "half-done.ts"), "export const half = true;\n");
        return { ...OK, stdout: [JSON.stringify({ type: "system", subtype: "init", session_id: session }), JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "stopped", session_id: session })].join("\n") };
      }
      const result = { type: "result", subtype: "success", is_error: true, result: FIXTURE.terminal.text, session_id: session };
      return { ...OK, code: 1, stdout: [JSON.stringify({ type: "system", subtype: "init", session_id: session }), JSON.stringify(result)].join("\n") };
    };
    await tick(byModel({ sonnet: stopsThenRunsOut, opus: finishes }), T0);
    const rows = withStore(store => store.handle.prepare("SELECT role, terminal_class, chain_index FROM run ORDER BY id").all());
    expect(rows.filter(one => one["role"] === "repair"), lines.join("\n")).toHaveLength(1);
    expect(rows.filter(one => one["role"] === "repair")[0]).toMatchObject({ terminal_class: "usage-exhausted", chain_index: 0 });
    expect(walks()).toMatchObject([{ cursor: 1, state: "open" }]);
    expect(withStore(store => store.lookupRef("t-1")!.strikes)).toBe(0);
    await tick(byModel({ sonnet: stopsThenRunsOut, opus: finishes }), later(1));
    expect(outcomeOf("t-1").outcome, lines.join("\n")).toBe("built");
  });

  test("an unrecognised failure never moves: the ordinary road runs, with a strike", async () => {
    await setUp("claude:opus:plan");
    await file("t-1"); await approve("t-1");
    const broken: Runner = async (_f, args, options) => { await seen(args, options?.cwd ?? ""); return { ...OK, code: 1, stdout: JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "You've hit your monthly spend limit · resets 12am" }) }; };
    await tick(broken, T0);
    expect(withStore(store => store.lookupRef("t-1")!.strikes)).toBe(1);
    await tick(broken, later(2));
    expect(runs.length).toBe(2);
    expect(runs.every(one => one.model === "sonnet")).toBe(true);
    expect(walks()).toMatchObject([{ cursor: 0, state: "closed", closed_reason: "entry-ended" }, { cursor: 0, state: "open" }]);
  });

  test("the last agent running out closes the walk and takes the ordinary road", async () => {
    await setUp("claude:opus:plan");
    await file("t-1"); await approve("t-1");
    await tick(exhausted(false), T0);
    await tick(exhausted(false), later(1));
    expect(runs.map(one => one.model)).toEqual(["sonnet", "opus"]);
    expect(walks()).toMatchObject([{ state: "closed", closed_reason: "chain-ended" }]);
    expect(withStore(store => store.lookupRef("t-1")!.strikes)).toBe(1);
  });

  test("a paid entry never runs without the live grant: not at the move, not after it is revoked", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test-not-real");
    await setUp("claude:opus:api-key");
    await file("t-1"); await approve("t-1");
    await tick(byModel({ sonnet: exhausted(false), opus: finishes }), T0);
    expect(walks()).toMatchObject([{ cursor: 0, state: "closed", closed_reason: "grant-withheld" }]);
    expect(withStore(store => store.lookupRef("t-1")!.strikes)).toBe(1);
    expect(runs.map(one => one.model)).toEqual(["sonnet"]);

    // Granted, moved, then revoked before the next agent starts: it never starts.
    await say(["project", "fallback", "--repo", repo, "--allow-paid", "--as", "alex", "--token", approver, "--json"]);
    await tick(byModel({ sonnet: exhausted(false), opus: finishes }), later(5));
    expect(walks()).toMatchObject([{ state: "closed" }, { cursor: 1, state: "open" }]);
    await say(["project", "fallback", "--repo", repo, "--no-paid", "--as", "alex", "--token", approver, "--json"]);
    const ran = runs.length;
    const next = withStore(store => dispatchEntryOf(store, store.lookupRef("t-1")!.id, "t-1", later(6)));
    expect(next).toBeNull();
    expect(walks()).toMatchObject([{ state: "closed" }, { state: "closed", closed_reason: "grant-withheld" }]);
    expect(runs.length).toBe(ran);
    vi.unstubAllEnvs();
  });

  test("a machine can't change the chain or the grant, or approve a paid one; a chain approved earlier keeps its own terms", async () => {
    await setUp("claude:opus:plan");
    await file("t-1"); await approve("t-1");
    withStore(store => withActor({ account: "alex", lead: true }, () => {
      expect(setFallbackChain(store, repo, [{ provider: "codex", model: "gpt-5.5", authMode: "api-key" }], "alex", T0).ok).toBe(false);
      expect(setPaidGrant(store, repo, true, "alex", T0).ok).toBe(false);
      expect(clearFallbackChain(store, repo, "alex", T0).ok).toBe(false);
      expect(fallbackSettingOf(store, repo)?.paidGrant).toBeNull();
    }));
    await say(["project", "fallback", "--repo", repo, "--agents", "claude:haiku:plan", "--json"]);
    expect(payload().ok).toBe(false);
    await say(["project", "fallback", "--repo", repo, "--agents", "claude:haiku:plan", "--as", "alex", "--token", approver, "--json"]);
    expect(payload().ok).toBe(true);
    expect(withStore(store => chainTermsLines({ proposedChainJson: store.getScope("t-1")!.approvedChainJson ?? null })).join("\n")).toContain("opus");
  });

  test("a move can't be admitted twice, and a run with no place in the walk spends nothing", async () => {
    await setUp("claude:opus:plan");
    await file("t-1"); await approve("t-1");
    await tick(byModel({ sonnet: exhausted(false), opus: finishes }), T0);
    const ref = refOf("t-1");
    withStore(store => {
      // The base's run already finished: its place is gone.
      const first = Number(store.handle.prepare("SELECT id FROM run WHERE task_ref = ? ORDER BY id LIMIT 1").get(ref)!["id"]);
      expect(chainCustodyProblem(store, first)).toContain("no longer holds");
      // Replaying the move finds nothing to do.
      expect(moveOnIfExhausted(store, first, "t-1", later(1))).toBeNull();
      expect(store.handle.prepare("SELECT COUNT(*) AS n FROM fallback_move").get()!["n"]).toBe(1);
    });
  });

  test("a crash leaves a walk the reconciler closes: its tail ended with nothing pending", async () => {
    await setUp("claude:opus:plan");
    await file("t-1"); await approve("t-1");
    const dies: Runner = async (_f, args, options) => { await seen(args, options?.cwd ?? ""); return { ...OK, code: 1, stdout: "" }; };
    await tick(dies, T0);
    withStore(store => reconcileWalks(store, later(1)));
    expect(walks()).toMatchObject([{ cursor: 0, state: "closed", closed_reason: "entry-ended" }]);
  });

  test("the seal: a paid chain takes a person's own yes, and every chat card shows the chain in full", async () => {
    await setUp("claude:opus:api-key");
    await file("t-1");
    withStore(store => {
      const scope = store.getScope("t-1")!;
      expect(shownTermsDigest(scope)).not.toBe(shownTermsDigest({ ...scope, proposedChainJson: null }));
      for (const card of [scopeTermsText(scope), planCardText(store, "t-1", scope), planCardText(store, "t-1", scope, undefined, "telegram"), describeScope(scope).join("\n")]) {
        for (const line of chainTermsLines(scope)) expect(card).toContain(line);
      }
      // The web approval sheet, and the task page's approve box built from the same parts: the chain, and the paid
      // agent named before the yes.
      const input = { surface: "task" as const, action: "/t/t-1/approve", csrf: "c", nonce: "n", digest: scope.digest, returnTo: null, scope, planDocument: null, planContract: null,
        revision: null, revisionSourceHref: "", repairChain: null, route: null, coordinator: null, origin: null, deliverable: "branch" as const, editHref: "#", notNowHref: "#", sticky: false, earlier: { active: 0, running: 0 }, edit: null };
      const sheet = withFormToken("c", () => htmlString(approvalSheetHtml(input)));
      expect(sheet).toContain("data-approval-fallback");
      expect(sheet).toContain("opus");
      const allowing = /data-approval-allowing>([^<]*)</.exec(sheet)?.[1] ?? "";
      expect(allowing, sheet.slice(sheet.indexOf("approval-allowing") - 20, sheet.indexOf("approval-allowing") + 400)).toMatch(/opus/i);
      expect(allowing).toContain("which spends money");
      const kit = withFormToken("c", () => approveKitOf(input, null));
      expect(JSON.stringify(kit)).toContain("on an API key, which spends money");
      expect(chainTermsLines(scope).join("\n")).toContain("this spends money");
      expect(chainSealProblem(store, scope, undefined)).toBeNull();
      expect(chainSealProblem(store, scope, { kind: "chat" })).toBeNull();
      for (const kind of ["mode", "grant", "schedule", "lead", "auto-green"]) expect(chainSealProblem(store, scope, { kind }), kind).not.toBeNull();
      expect(withActor({ account: "alex", lead: true }, () => chainSealProblem(store, scope, undefined))).not.toBeNull();
      expect(withActor({ account: "alex", lead: true }, () => store.sealScopeApproval("t-1", "alex", T0))).toBe(false);
    });
  });

  test("a chain from before v115 holds no authority: it decodes, and nothing dispatches on it", async () => {
    await setUp("claude:opus:plan");
    await file("t-1");
    const scope = withStore(store => store.getScope("t-1")!);
    const entries = liveChainFromJson(scope.proposedChainJson ?? null)!;
    expect(chainFromJson(canonicalChainJson(entries))).not.toBeNull();
    expect(liveChainFromJson(canonicalChainJson(entries))).toBeNull();
    const authority = scopeAuthorityOf({ ...scope, proposedChainJson: canonicalChainJson(entries) });
    expect(authority).toMatchObject({ ok: false, reason: "chain" });
  });

  test("an edited chain breaks the seal: the digest covers it", async () => {
    await setUp("claude:opus:plan");
    await file("t-1");
    const scope = withStore(store => store.getScope("t-1")!);
    const entries = liveChainFromJson(scope.proposedChainJson ?? null)!;
    const swapped = chainJsonOf([entries[0]!, { ...entries[1]!, authMode: "api-key" }]);
    expect(scopeAuthorityOf({ ...scope, proposedChainJson: swapped })).toMatchObject({ ok: false, reason: "digest" });
  });
});

test("every read tolerates a database an older build holds: no tables, no chain, no error", () => {
  const store = openStore(":memory:");
  store.handle.exec("DROP TABLE fallback_move; DROP TABLE fallback_walk; DROP TABLE fallback_setting;");
  expect(fallbackSettingOf(store, "/x")).toBeNull();
  expect(dispatchEntryOf(store, 1, "t", T0)).toBeNull();
  expect(pinnedEntryOf(store, 1)).toBeNull();
  expect(chainCustodyProblem(store, 1)).toBeNull();
  expect(bindRunToWalk(store, 1, T0)).toBeNull();
  expect(moveOnIfExhausted(store, 1, "t", T0)).toBeNull();
  expect(ranOutOnChain(store, 1)).toBe(false);
  expect(fallbackBriefFor(store, 1)).toBeNull();
  reconcileWalks(store, T0);
  store.close();
});
