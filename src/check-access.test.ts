/** Check access per project (v132, check-access.ts): stored narrow by default, widened only by an instance operator. */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store.js";
import { addApprover, describeScope, propose } from "./scope.js";
import { runOperate, EXIT } from "./operate.js";
import { checkAccessHere, checkAccessOf, checkNetworkOf, narrowestAccess, narrowestNetwork, signInHostsMissing, signInsAvailable, signInsUnavailableWords, widerThan } from "./check-access.js";
import { resolveScopeProfile } from "./agentconfig.js";
import { checkLaunchOf } from "./builder.js";
import { checkoutLaunchOf, checkoutRunner, ranAtLine, signInsLaunch, widestRan } from "./invoke.js";

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

// A Mac unless a test says Linux (sign-ins aren't available there yet): the same answers on every CI machine.
const run = (argv: string[], platform: NodeJS.Platform = "darwin", fenceAvailable: () => boolean = () => true) => { lines = []; return runOperate("project", ["check-access", ...argv], line => lines.push(line), { databaseFile: db, platform, fenceAvailable }); };
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
  store.setProjectCheckAccess(REPO, "unsandboxed", "alex", new Date(), { may: "widen" });
  expect(await run(["--repo", REPO])).toBe(EXIT.ok);
  expect(lines.join("\n")).toMatch(/not sandboxed[\s\S]*full access to this machine/);
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
    // Sign-ins where this machine has them (on Linux they seal as sandboxed: see "Linux" below).
    store.setProjectCheckAccess(REPO, signInsAvailable() ? "sign-ins" : "unsandboxed", "alex", new Date(), { may: "widen" });
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

test("sign-ins never widens the network: the hosts the sign-ins would need are named, never added", () => {
  expect(signInHostsMissing({ mode: "open", hosts: [], loopback: "proxy-only" })).toEqual([]);
  expect(signInHostsMissing({ mode: "allowlist", hosts: ["*.anthropic.com", "api.github.com"], loopback: "proxy-only" })).toEqual(
    ["platform.claude.com", "api.openai.com", "chatgpt.com", "auth.openai.com", "github.com"]);
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
    expect(checkNetworkOf(sealed, "claude", { mode: "allowlist", hosts: [], loopback: "proxy-only" }).hosts).toEqual(["registry.npmjs.org", "api.stripe.com"]);
    // A provider host the project lists itself (added for its sign-ins) stays its checks' too.
    expect(checkNetworkOf(sealed, "claude", { mode: "allowlist", hosts: ["api.anthropic.com"], loopback: "proxy-only" }).hosts).toEqual(["api.anthropic.com", "registry.npmjs.org", "api.stripe.com"]);
    expect(narrowestNetwork({ ...sealed, hosts: ["*.stripe.com", "registry.npmjs.org"] }, { ...sealed, hosts: ["api.stripe.com", "github.com"] }).hosts).toEqual(["api.stripe.com"]);
    expect(narrowestNetwork({ version: 1, mode: "open", hosts: [], loopback: "any" }, sealed)).toMatchObject({ mode: "allowlist", hosts: sealed.hosts, loopback: "proxy-only" });
  });

  test("a saved result's checks: worked out again before each command, never wider than the run or the project now; recorded as they ran", async () => {
    store.createTask({ id: "t-saved", title: "t" }, new Date());
    const ref = store.refFor("built-in", "t-saved").id;
    const runId = store.startRun({ taskRef: ref, leaseId: "l", runner: "r", branch: "b", worktree: "/w", route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" }, now: new Date() });
    store.stampRunCheckAccess(runId, "unsandboxed");
    store.setProjectCheckAccess(REPO, "unsandboxed", "alex", new Date(), { may: "widen" });
    expect(checkoutLaunchOf(store, REPO, [runId])).toEqual({ access: "unsandboxed", network: undefined });
    // The runner re-reads before each command: a narrowing between two commands applies to the second.
    const ranAt: string[] = [];
    const runner = checkoutRunner(store, REPO, "/w", async () => ({ code: 0, stdout: "", stderr: "", timedOut: false, notFound: false }), [runId], level => ranAt.push(level));
    await runner("/bin/true", [], {});
    store.setProjectCheckAccess(REPO, "sandboxed", "alex", new Date(), { may: "narrow" });
    await runner("/bin/true", [], {});
    expect(ranAt).toEqual(["unsandboxed", "sandboxed"]);
    expect(widestRan(ranAt as Parameters<typeof widestRan>[0])).toBe("unsandboxed");
    expect(ranAtLine("unsandboxed")).toMatch(/These commands ran without a sandbox/);
    expect(ranAtLine("sandboxed")).toBeNull();
  });
});

describe("sign-ins: on wherever the OS fence is (0.9.70, sandbox parity C10: the check reads its own sign-in files through its sandbox)", () => {
  const PLATFORMS = ["darwin", "linux", "win32"] as const;
  const ranRun = (id: string) => {
    store.createTask({ id, title: id }, new Date());
    return store.startRun({ taskRef: store.refFor("built-in", id).id, leaseId: "l", runner: "r", branch: "b", worktree: "/w", route: { routeDigest: "legacy", phase: "build", provider: "claude", model: null, chosen: "legacy" }, now: new Date() });
  };
  const ledger = () => store.handle.prepare("SELECT detail FROM action_ledger WHERE action = 'check access'").all().map(row => String(row["detail"]));

  test("the level: sign-ins is available on every platform; the other levels unchanged", () => {
    for (const platform of PLATFORMS) {
      expect(signInsAvailable(platform)).toBe(true);
      expect(checkAccessHere("sign-ins", platform)).toBe("sign-ins");
      expect(checkAccessHere("unsandboxed", platform)).toBe("unsandboxed");
      expect(signInsUnavailableWords(platform)).toBeNull();
    }
  });

  test("the CLI widens to sign-ins only for an instance operator with a password; the ledger keeps it", async () => {
    expect(await run(["sign-ins", "--repo", REPO, ...as("sam"), "--json"])).toBe(EXIT.refused);
    expect(store.projectCheckAccess(REPO)).toBe("sandboxed");
    expect(await run(["sign-ins", "--repo", REPO, ...as("alex"), "--json"])).toBe(EXIT.ok);
    expect(store.projectCheckAccess(REPO)).toBe("sign-ins");
    expect(ledger()).toHaveLength(1);
  });

  test("a scope filed with sign-ins saved seals sign-ins (its digest says so)", () => {
    store.createTask({ id: "t-seal", title: "t" }, new Date());
    store.placeTask(store.lookupRef("t-seal")!.id, REPO);
    for (const phase of ["plan", "build", "review"] as const) store.setPhaseConfig("installation", phase, "claude", "sonnet", "alex", new Date());
    store.setProjectCheckAccess(REPO, "sign-ins", "alex", new Date(), { may: "widen" });
    for (const platform of PLATFORMS) {
      const resolved = resolveScopeProfile(store, REPO, undefined, { provider: "claude", model: "sonnet" }, platform);
      expect(resolved.ok && resolved.profile.checkAccess).toBe("sign-ins");
    }
  });

  test("a saved result stamped sign-ins with a sealed network runs sign-ins", async () => {
    const result = ranRun("t-result");
    const net = { version: 1 as const, mode: "allowlist" as const, hosts: ["api.github.com"], loopback: "proxy-only" as const };
    store.stampRunCheckAccess(result, "sign-ins", net);
    store.setProjectCheckAccess(REPO, "sign-ins", "alex", new Date(), { may: "widen" });
    expect(checkoutLaunchOf(store, REPO, [result])).toMatchObject({ access: "sign-ins" });
  });

  test("the launch grants the sign-in files by name, points Codex and gh at their real folders, and copies nothing", async () => {
    const { mkdirSync, readdirSync } = await import("node:fs");
    const own = join(dir, "launch");
    mkdirSync(join(own, "tmp"), { recursive: true });
    // A home of the test's own: the grants make the checkout's transcript folder and Codex's session folders.
    const savedHome = process.env["HOME"];
    process.env["HOME"] = join(dir, "home");
    mkdirSync(join(dir, "home", ".codex"), { recursive: true });
    (await import("node:fs")).writeFileSync(join(dir, "home", ".codex", "auth.json"), "{}");
    try {
    const result = await signInsLaunch(store, own, join(own, "tmp"), dir, { version: 1, mode: "open", hosts: [], loopback: "proxy-only" }, []);
    if ("problem" in result) throw new Error(result.problem);
    const { homedir } = await import("node:os");
    const { realpathSync } = await import("node:fs");
    expect(result.env).toMatchObject({ CODEX_HOME: join(homedir(), ".codex"), GH_CONFIG_DIR: join(homedir(), ".config", "gh") });
    expect(result.grants.read).toContain(join(realpathSync(homedir()), ".codex", "auth.json"));
    expect(readdirSync(own)).toEqual(["tmp"]);
    await result.close();
    } finally { if (savedHome === undefined) delete process.env["HOME"]; else process.env["HOME"] = savedHome; }
  });

  test("with no OS sandbox here and unconfined running allowed, the CLI says checks run without one: never sandboxed", async () => {
    store.setProjectCheckAccess(REPO, "sign-ins", "alex", new Date(), { may: "widen" });
    const none = () => false;
    // Unconfined running not allowed: nothing runs unsandboxed, so the saved level stands.
    expect(await run(["--repo", REPO, "--json"], "linux", none)).toBe(EXIT.ok);
    expect(payload()).toMatchObject({ checkAccess: "sign-ins" });
    expect(payload().runsAs).toBeUndefined();
    store.setUnfencedAgentsAllowed(true, "alex", new Date());
    expect(await run(["--repo", REPO, "--json"], "linux", none)).toBe(EXIT.ok);
    expect(payload()).toMatchObject({ checkAccess: "sign-ins", runsAs: "unsandboxed" });
    expect(await run(["--repo", REPO], "linux", none)).toBe(EXIT.ok);
    expect(lines.join("\n")).toMatch(/this machine can't sandbox checks, so they run without a sandbox/);
    expect(lines.join("\n")).not.toMatch(/run sandboxed/);
    // A sandboxed project on a Mac with no sandbox likewise.
    store.setProjectCheckAccess(REPO, "sandboxed", "alex", new Date(), { may: "narrow" });
    expect(await run(["--repo", REPO, "--json"], "darwin", none)).toBe(EXIT.ok);
    expect(payload()).toMatchObject({ checkAccess: "sandboxed", runsAs: "unsandboxed" });
    // With a fence, nothing extra is said.
    expect(await run(["--repo", REPO, "--json"], "darwin")).toBe(EXIT.ok);
    expect(payload().runsAs).toBeUndefined();
  });
});
