/** Check access per project (v132, check-access.ts): stored narrow by default, widened only by an instance operator. */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover, describeScope, propose } from "./scope.js";
import { runOperate, EXIT } from "./operate.js";
import { checkAccessOf, checkNetworkOf, narrowestAccess, narrowestNetwork, signInHostsMissing, widerThan } from "./check-access.js";
import { checkoutLaunchOf, checkoutRunner, ranAtLine, widestRan } from "./invoke.js";

const REPO = "/repo/main";
let dir: string, db: string, store: Store, lines: string[];
const tokens: Record<string, string> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "so-check-access-"));
  db = join(dir, "orders.db");
  store = openStore(db);
  const now = new Date();
  const alex = addApprover(store, "alex", now);
  if (!alex.ok) throw new Error("alex");
  tokens["alex"] = alex.token;
  const sam = addApprover(store, "sam", now, { name: "alex", token: alex.token });
  if (!sam.ok) throw new Error("sam");
  tokens["sam"] = sam.token;
  // sam approves on the project but isn't an instance operator.
  expect(store.setAccountProjects("sam", [REPO], "alex", now)).toEqual({ ok: true });
  const made = store.createConsoleTask({ title: "known", repo: REPO, filedVia: "console", filedBy: { name: "alex", kind: "person" } }, now);
  if (!made.ok) throw new Error(made.reason);
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const run = (argv: string[]) => { lines = []; return runOperate("project", ["check-access", ...argv], line => lines.push(line), { databaseFile: db }); };
const payload = () => JSON.parse(lines.join("\n"));
const as = (name: string) => ["--as", name, "--token", tokens[name]!];

test("levels: unknown or damaged values read as sandboxed; the narrowest of several wins", () => {
  expect(checkAccessOf("unsandboxed")).toBe("unsandboxed");
  expect(checkAccessOf("anything")).toBe("sandboxed");
  expect(checkAccessOf(null)).toBe("sandboxed");
  expect(narrowestAccess(["unsandboxed", "sign-ins"])).toBe("sign-ins");
  expect(narrowestAccess(["unsandboxed", "sandboxed", "sign-ins"])).toBe("sandboxed");
  expect(narrowestAccess([])).toBe("sandboxed");
  expect(widerThan("sign-ins", "sandboxed")).toBe(true);
  expect(widerThan("sandboxed", "unsandboxed")).toBe(false);
});

test("a project is sandboxed until changed; a damaged row never reads wider; the ledger keeps before → after", () => {
  expect(store.projectCheckAccess(REPO)).toBe("sandboxed");
  expect(store.projectCheckAccessChange(REPO)).toBeNull();
  expect(store.setProjectCheckAccess(REPO, "unsandboxed", "alex", new Date(), { may: "widen" })).toEqual({ before: "sandboxed", after: "unsandboxed" });
  expect(store.projectCheckAccessChange(REPO)?.by).toBe("alex");
  const ledger = store.handle.prepare("SELECT actor, detail FROM action_ledger WHERE action = 'check access'").all();
  expect(ledger.map(row => `${String(row["actor"])}: ${String(row["detail"])}`)).toEqual(["alex: sandboxed → unsandboxed"]);
  // The table's check refuses a wider word; a row that reads oddly anyway is the narrowest level.
  expect(() => store.handle.prepare("UPDATE project_check_access SET level = 'everything' WHERE repo = ?").run(REPO)).toThrow();
  store.handle.exec("PRAGMA ignore_check_constraints = ON");
  store.handle.prepare("UPDATE project_check_access SET level = 'everything' WHERE repo = ?").run(REPO);
  expect(store.projectCheckAccess(REPO)).toBe("sandboxed");
});

test("the CLI: shows the level; only an instance operator with a password widens; an approver narrows; others are refused", async () => {
  expect(await run(["--repo", REPO, "--json"])).toBe(EXIT.ok);
  expect(payload()).toMatchObject({ ok: true, checkAccess: "sandboxed" });

  // sam approves on the project but isn't an instance operator: may not widen.
  expect(await run(["sign-ins", "--repo", REPO, ...as("sam"), "--json"])).toBe(EXIT.refused);
  expect(payload()).toMatchObject({ ok: false, reason: "refused" });
  // A wrong password widens nothing.
  expect(await run(["unsandboxed", "--repo", REPO, "--as", "alex", "--token", "wrong", "--json"])).toBe(EXIT.refused);
  expect(store.projectCheckAccess(REPO)).toBe("sandboxed");

  expect(await run(["unsandboxed", "--repo", REPO, ...as("alex"), "--json"])).toBe(EXIT.ok);
  expect(payload()).toMatchObject({ ok: true, before: "sandboxed", checkAccess: "unsandboxed" });
  expect(store.projectCheckAccess(REPO)).toBe("unsandboxed");

  // Narrowing is any project approver's: sam may.
  expect(await run(["sandboxed", "--repo", REPO, ...as("sam"), "--json"])).toBe(EXIT.ok);
  expect(store.projectCheckAccess(REPO)).toBe("sandboxed");

  // Not a level, or not a project: usage and not-found.
  expect(await run(["everything", "--repo", REPO, ...as("alex"), "--json"])).toBe(EXIT.usage);
  expect(await run(["sandboxed", "--repo", "/nowhere", ...as("alex"), "--json"])).toBe(EXIT.refused);
  expect(payload()).toMatchObject({ reason: "not-found" });
});

test("the CLI says what a wider level means before anyone relies on it", async () => {
  store.setProjectCheckAccess(REPO, "sign-ins", "alex", new Date(), { may: "widen" });
  expect(await run(["--repo", REPO])).toBe(EXIT.ok);
  expect(lines.join("\n")).toMatch(/model and GitHub sign-ins[\s\S]*can read your Claude, Codex and GitHub sign-ins/);
});

test("the write compares again: a narrowing authority never widens, whatever changed while it was proved", () => {
  // An operator widened to unsandboxed; an approver's pending narrowing to sign-ins still narrows.
  expect(store.setProjectCheckAccess(REPO, "unsandboxed", "alex", new Date(), { may: "widen" })).toEqual({ before: "sandboxed", after: "unsandboxed" });
  expect(store.setProjectCheckAccess(REPO, "sign-ins", "sam", new Date(), { may: "narrow" })).toEqual({ before: "unsandboxed", after: "sign-ins" });
  // Meanwhile someone narrowed to sandboxed: the same narrowing authority asking for sign-ins would now widen. Refused.
  expect(store.setProjectCheckAccess(REPO, "sandboxed", "alex", new Date(), { may: "narrow" })).toEqual({ before: "sign-ins", after: "sandboxed" });
  expect(store.setProjectCheckAccess(REPO, "sign-ins", "sam", new Date(), { may: "narrow" })).toBeNull();
  expect(store.projectCheckAccess(REPO)).toBe("sandboxed");
  // The same level again is no widening.
  expect(store.setProjectCheckAccess(REPO, "sandboxed", "sam", new Date(), { may: "narrow" })).toEqual({ before: "sandboxed", after: "sandboxed" });
});


describe("sealing (v132): the level is part of what is approved", () => {
  const file = (id: string) => {
    store.createTask({ id, title: id }, new Date());
    store.placeTask(store.lookupRef(id)!.id, REPO);
    for (const phase of ["plan", "build", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "alex", new Date());
    return propose(store, { taskId: id, goal: "Do the thing", touches: ["a.ts"], acceptance: [{ id: "c1", statement: "It works", how: null, evidence: ["manual-review"] }], now: new Date() });
  };

  test("a scope seals a wider level, changes its digest for it, and says it; sandboxed seals nothing", () => {
    const narrow = file("t-narrow");
    expect(narrow.profile?.checkAccess).toBeUndefined();
    store.setProjectCheckAccess(REPO, "unsandboxed", "alex", new Date(), { may: "widen" });
    const wide = file("t-wide");
    expect(wide.profile?.checkAccess).toBe("unsandboxed");
    expect(describeScope(wide).join("\n")).toMatch(/checks\s+not sandboxed/);
    expect(describeScope(narrow).join("\n")).not.toMatch(/checks\s/);
    // The same words under the other level are another digest: an approval of one is never an approval of the other.
    store.setProjectCheckAccess(REPO, "sandboxed", "alex", new Date(), { may: "narrow" });
    const again = propose(store, { taskId: "t-wide", goal: "Do the thing", touches: ["a.ts"], acceptance: [{ id: "c1", statement: "It works", how: null, evidence: ["manual-review"] }], now: new Date() });
    expect(again.profile?.checkAccess).toBeUndefined();
    expect(again.digest).not.toBe(wide.digest);
  });

  test("a scope wider than sandboxed seals only on a person's password: never a mode, a grant, a chat confirmation", () => {
    store.setProjectCheckAccess(REPO, "sign-ins", "alex", new Date(), { may: "widen" });
    file("t-auto");
    for (const kind of ["mode", "grant", "chat"] as const) expect(store.sealScopeApproval("t-auto", "alex", new Date(), {}, { kind, modeDigest: "d" }, "person")).toBe(false);
    expect(store.getScope("t-auto")?.approvedAt).toBeNull();
    expect(store.sealScopeApproval("t-auto", "alex", new Date())).toBe(true);
    // A sandboxed scope keeps every road it had.
    store.setProjectCheckAccess(REPO, "sandboxed", "alex", new Date(), { may: "narrow" });
    file("t-mode");
    expect(store.sealScopeApproval("t-mode", "mode standard", new Date(), {}, { kind: "mode", modeDigest: "d" })).toBe(true);
  });

  test("a run's stamp: sandboxed until stamped; a check of its result never runs wider than it or than the project now", () => {
    store.createTask({ id: "t-run", title: "t-run" }, new Date());
    const ref = store.refFor("built-in", "t-run").id;
    const runId = store.startRun({ taskRef: ref, leaseId: "l", runner: "r", branch: "b", worktree: "/w", route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" }, now: new Date() });
    expect(store.runCheckAccess(runId)).toBe("sandboxed");
    store.stampRunCheckAccess(runId, "unsandboxed");
    expect(store.runCheckAccess(runId)).toBe("unsandboxed");
    // A damaged stamp is sandboxed.
    store.handle.prepare("UPDATE run SET sandbox_access = 'everything' WHERE id = ?").run(runId);
    expect(store.runCheckAccess(runId)).toBe("sandboxed");
    expect(narrowestAccess([store.projectCheckAccess(REPO), "unsandboxed"])).toBe("sandboxed");
  });
});

test("sign-ins never widens the network: the CLI names the hosts the sign-ins need and the separate command that adds them", async () => {
  expect(signInHostsMissing({ mode: "open", hosts: [], loopback: "proxy-only" })).toEqual([]);
  expect(signInHostsMissing({ mode: "allowlist", hosts: ["*.anthropic.com", "api.github.com"], loopback: "proxy-only" })).toEqual(
    ["platform.claude.com", "api.openai.com", "chatgpt.com", "auth.openai.com", "github.com"]);
  store.setProjectCheckAccess(REPO, "sign-ins", "alex", new Date(), { may: "widen" });
  expect(await run(["--repo", REPO])).toBe(EXIT.ok);
  expect(lines.join("\n")).toMatch(/Model sign-ins need these hosts in this project's network allowlist: api\.anthropic\.com, .*github\.com, api\.github\.com\. Add them with: toolroll project network --repo \/repo\/main --allow api\.anthropic\.com,/);
  // The setting itself never changed the network.
  expect(store.projectNetwork(REPO)).toEqual({ mode: "allowlist", hosts: [], loopback: "proxy-only" });
  store.setProjectNetwork(REPO, { mode: "open", hosts: [], loopback: "proxy-only" }, "alex", new Date());
  expect(await run(["--repo", REPO])).toBe(EXIT.ok);
  expect(lines.join("\n")).not.toMatch(/need these hosts/);
});

describe("review round: authority, networks and per-command levels", () => {
  test("the write proves who is acting again: an operator demoted (or an approver moved off the project) meanwhile changes nothing", () => {
    // sam is project-limited: never an operator, so a widen claimed for sam is refused inside the write.
    expect(store.setProjectCheckAccess(REPO, "unsandboxed", "sam", new Date(), { may: "widen" })).toBeNull();
    expect(store.setProjectCheckAccess(REPO, "unsandboxed", "alex", new Date(), { may: "widen" })).not.toBeNull();
    // Moved off the project: sam can't narrow it any more either.
    expect(store.setAccountProjects("sam", ["/elsewhere"], "alex", new Date())).toEqual({ ok: true });
    expect(store.setProjectCheckAccess(REPO, "sandboxed", "sam", new Date(), { may: "narrow" })).toBeNull();
    expect(store.projectCheckAccess(REPO)).toBe("unsandboxed");
  });

  test("a build's checks never get its agent's provider hosts; two networks narrow to what both allow", () => {
    const sealed = { version: 1 as const, mode: "allowlist" as const, hosts: ["api.anthropic.com", "console.anthropic.com", "platform.claude.com", "registry.npmjs.org", "api.stripe.com"], loopback: "proxy-only" as const };
    expect(checkNetworkOf(sealed, "claude").hosts).toEqual(["registry.npmjs.org", "api.stripe.com"]);
    expect(narrowestNetwork({ ...sealed, hosts: ["*.stripe.com", "registry.npmjs.org"] }, { ...sealed, hosts: ["api.stripe.com", "github.com"] }).hosts).toEqual(["api.stripe.com"]);
    expect(narrowestNetwork({ version: 1, mode: "open", hosts: [], loopback: "any" }, sealed)).toMatchObject({ mode: "allowlist", hosts: sealed.hosts, loopback: "proxy-only" });
  });

  test("a saved result's checks: worked out again before each command, never wider than the run or the project now; recorded as they ran", async () => {
    store.createTask({ id: "t-saved", title: "t" }, new Date());
    const ref = store.refFor("built-in", "t-saved").id;
    const runId = store.startRun({ taskRef: ref, leaseId: "l", runner: "r", branch: "b", worktree: "/w", route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" }, now: new Date() });
    const net = { version: 1 as const, mode: "allowlist" as const, hosts: ["api.stripe.com"], loopback: "proxy-only" as const };
    store.stampRunCheckAccess(runId, "sign-ins", net);
    store.setProjectCheckAccess(REPO, "unsandboxed", "alex", new Date(), { may: "widen" });
    expect(checkoutLaunchOf(store, REPO, [runId])).toMatchObject({ access: "sign-ins" });
    // The project's own network allows nothing extra: the result's sealed host isn't reachable.
    expect(checkoutLaunchOf(store, REPO, [runId]).network?.hosts).toEqual([]);
    // A run with sign-ins but no sealed network runs its checks sandboxed.
    store.stampRunCheckAccess(runId, "sign-ins", null);
    expect(checkoutLaunchOf(store, REPO, [runId]).access).toBe("sandboxed");
    store.stampRunCheckAccess(runId, "sign-ins", net);
    // The runner re-reads before each command: a narrowing between two commands applies to the second.
    const ranAt: Parameters<typeof checkoutRunner>[5] = [];
    const runner = checkoutRunner(store, REPO, "/w", async () => ({ code: 0, stdout: "", stderr: "", timedOut: false, notFound: false }), [runId], ranAt);
    await runner("/bin/true", [], {});
    store.setProjectCheckAccess(REPO, "sandboxed", "alex", new Date(), { may: "narrow" });
    await runner("/bin/true", [], {});
    expect(ranAt).toEqual(["sign-ins", "sandboxed"]);
    expect(widestRan(ranAt)).toBe("sign-ins");
    expect(ranAtLine("unsandboxed")).toMatch(/These commands ran without a sandbox/);
    expect(ranAtLine("sandboxed")).toBeNull();
  });
});
