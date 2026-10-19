/**
 * ACP agents as providers (docs/plans/acp-adapter.md § Identity, Profile, Admission): each is its own provider id,
 * nothing outside the one spawning gateway ever runs one, an agent with no check on this computer is refused, and its
 * only posture is full access inside the fence — so it builds and repairs, and never plans, reviews or researches.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ACP_AGENTS, ACP_PROVIDER_IDS, isAcpProfile } from "./acp-agents.js";
import { inspectAcpAgent } from "./acp-inspect.js";
import { launchFromJson } from "./acp-attest.js";
import { taskBoundary } from "./agent-fence.js";
import { attestProvider } from "./attest.js";
import { readAuthMode, readAuthModeStrict } from "./keys.js";
import { levelOfProfile, OPEN_POLICY, underCeiling } from "./policy.js";
import { createConnectionChecker } from "./provider-connection.js";
import { adapterFor, auditOf, MONEY_CAPABILITIES, PROVIDER_IDS, validateSpec } from "./provider.js";
import { recommendRoute, type RouteCandidates } from "./phase-routing.js";
import { observeProviderReadiness } from "./runner.js";
import { canonicalProfileJson, profileDigestOf, profileFromJson, type AcpProfile } from "./scope.js";

let dir: string | undefined;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

const OPENCODE: AcpProfile = {
  provider: "opencode", model: "opencode/big-pickle", permission: "full", maxTurns: "unsupported", repairMaxTurns: "unsupported",
  timeoutSeconds: 3600, idleTimeoutSeconds: 900, repairTimeoutSeconds: 900, repairIdleTimeoutSeconds: 300, repairModel: "inherit",
};

describe("nothing outside the gateway runs an ACP agent", () => {
  const binaries = new Set(ACP_PROVIDER_IDS.map(id => ACP_AGENTS[id].binary));

  test("readiness looks at each agent and never runs it, and says it isn't checked", async () => {
    const ran: string[] = [];
    const observed = await observeProviderReadiness(async file => { ran.push(file); return { code: 0, stdout: "1.0.0\n", stderr: "", notFound: false, timedOut: false }; }, { PATH: "" });
    expect(ran.filter(file => binaries.has(file))).toEqual([]);
    for (const id of ACP_PROVIDER_IDS) {
      expect(observed.find(one => one.provider === id)).toMatchObject({ state: "unavailable", reason: expect.stringMatching(/not installed/) });
    }
  });

  test("a sign-in check never runs it", async () => {
    const check = createConnectionChecker({ probe: async () => { throw new Error("an ACP agent must not be run here"); } });
    for (const id of ACP_PROVIDER_IDS) expect(await check(id)).toMatchObject({ state: "unverified", mode: "agent-login" });
  });

  test("the gateway's attestation refuses an unchecked agent without running it", async () => {
    for (const id of ACP_PROVIDER_IDS) {
      const verdict = await attestProvider(id, adapterFor(id).binary, async () => { throw new Error("an ACP agent must not be run here"); });
      expect(verdict).toMatchObject({ ok: false, version: null, problem: expect.stringContaining(`toolroll agents check ${id}`) });
    }
  });

  test("inspection reads a script launcher's package and never executes it", () => {
    dir = mkdtempSync(join(tmpdir(), "so-acp-inspect-"));
    const pkg = join(dir, "lib", "node_modules", "opencode-ai");
    mkdirSync(join(pkg, "bin"), { recursive: true });
    const marker = join(dir, "ran");
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "opencode-ai", version: "1.18.18" }));
    writeFileSync(join(pkg, "bin", "opencode"), `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(join(pkg, "bin", "opencode"), 0o755);
    const seen = inspectAcpAgent("opencode", { PATH: join(pkg, "bin") });
    expect(seen).toMatchObject({ found: true, kind: "script", package: { name: "opencode-ai", version: "1.18.18" } });
    expect(existsSync(marker)).toBe(false);
    expect(inspectAcpAgent("cursor", { PATH: join(pkg, "bin") })).toEqual({ found: false, binary: "cursor-agent" });
  });
});

describe("an ACP agent's sign-in is fenced from every other build", () => {
  test("each agent's home is denied to every build but that agent's own", () => {
    dir = mkdtempSync(join(tmpdir(), "so-acp-home-"));
    const home = join(dir, "home");
    for (const folder of [".local/share/opencode", ".config/opencode", ".cursor", ".claude"]) mkdirSync(join(home, folder), { recursive: true });
    writeFileSync(join(home, ".local/share/opencode/auth.json"), "{}");
    const worktree = join(dir, "work", "task");
    mkdirSync(worktree, { recursive: true });
    const shell = (provider: string) => taskBoundary({ worktree, provider, home }).shell;
    const at = (folder: string) => realpathSync(join(home, folder));
    for (const provider of ["claude", "codex", "gemini", "cursor"]) {
      expect(shell(provider)).toEqual(expect.arrayContaining([at(".local/share/opencode"), at(".config/opencode")]));
    }
    expect(shell("claude")).toContain(at(".cursor"));
    expect(shell("opencode")).not.toContain(at(".local/share/opencode"));
    expect(shell("opencode")).not.toContain(at(".config/opencode"));
    expect(shell("opencode")).toEqual(expect.arrayContaining([at(".cursor"), at(".claude")]));
  });
});

describe("an ACP agent's stored launch", () => {
  const sha = "a".repeat(64);
  const bound = (role: string, path: string) => ({ role, path, sha256: sha, dev: 1, ino: 2, ctimeMs: 3, size: 4 });
  test("executes only a bound file: the launcher, or the bound interpreter with the launcher as its script", () => {
    const native = { file: "/opt/agent", prefix: [], bindings: [bound("launcher", "/opt/agent")] };
    expect(launchFromJson(JSON.stringify(native))).toEqual(native);
    const script = { file: "/usr/local/bin/node", prefix: ["/opt/agent.js"], bindings: [bound("launcher", "/opt/agent.js"), bound("interpreter", "/usr/local/bin/node")] };
    expect(launchFromJson(JSON.stringify(script))).toEqual(script);
    for (const bad of [
      { ...native, file: "/bin/sh" },
      { ...native, prefix: ["-c", "evil"] },
      { ...script, file: "/bin/sh" },
      { ...script, prefix: ["/tmp/other.js"] },
      { ...script, bindings: [bound("launcher", "/opt/agent.js")] },
      { ...native, bindings: [bound("interpreter", "/opt/agent")] },
      { ...native, bindings: [{ ...bound("launcher", "/opt/agent"), sha256: "nope" }] },
    ]) expect(launchFromJson(JSON.stringify(bad))).toBeNull();
  });

  test("an ACP launch sheds every known key and whatever makes an interpreter load other code", () => {
    for (const id of ACP_PROVIDER_IDS) {
      expect(adapterFor(id).extraOmitEnv).toEqual(expect.arrayContaining(["NODE_OPTIONS", "PYTHONPATH", "DYLD_INSERT_LIBRARIES", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY"]));
    }
  });
});

describe("an ACP agent's identity and terms", () => {
  test("each agent is its own provider, signed in its own way, with a required terminal and no priced usage", () => {
    for (const id of ACP_PROVIDER_IDS) {
      expect(PROVIDER_IDS).toContain(id);
      expect(readAuthMode(id)).toBe("agent-login");
      expect(readAuthModeStrict(id)).toEqual({ ok: true, mode: "agent-login" });
      expect(auditOf(id)).toMatchObject({ transport: "acp-jsonrpc", terminalContract: "required", resume: "none", sessionIdentity: "announced" });
      expect(MONEY_CAPABILITIES[id]).toEqual({ incrementalUsage: false, nativeDollarCapFlag: null, usageSemantics: "per-invocation" });
      expect(validateSpec({ provider: id, model: null })).toMatchObject({ ok: false, problem: expect.stringMatching(/explicit model/) });
      expect(validateSpec({ provider: id, model: "some/model" })).toEqual({ ok: true });
    }
  });

  test("the profile reads back exactly, and anything this code never writes reads as nothing", () => {
    const json = canonicalProfileJson(OPENCODE);
    expect(profileFromJson(json)).toEqual(OPENCODE);
    expect(isAcpProfile(OPENCODE)).toBe(true);
    const wrap = (profile: Record<string, unknown>) => JSON.stringify({ digestVersion: 2, profile });
    for (const bad of [
      { ...OPENCODE, permission: "auto" },
      { ...OPENCODE, maxTurns: 100 },
      { ...OPENCODE, idleTimeoutSeconds: -1 },
      { ...OPENCODE, extra: true },
      { ...OPENCODE, provider: "aider" },
      { ...OPENCODE, model: "--yolo" },
      Object.fromEntries(Object.entries(OPENCODE).filter(([key]) => key !== "repairIdleTimeoutSeconds")),
    ]) expect(profileFromJson(wrap(bad))).toBeNull();
    // Every field is sealed: changing either clock changes the digest.
    expect(profileDigestOf({ ...OPENCODE, idleTimeoutSeconds: 901 })).not.toBe(profileDigestOf(OPENCODE));
  });

  test("its posture is full access, and nothing lower exists: a lower ceiling refuses it rather than pretend", () => {
    expect(levelOfProfile(OPENCODE)).toBe("escalated");
    expect(underCeiling(OPEN_POLICY, OPENCODE)).toMatchObject({ ok: true, lowered: null });
    expect(underCeiling({ ...OPEN_POLICY, ceiling: "standard" }, OPENCODE)).toMatchObject({ ok: false });
  });

  test("it builds and repairs only: a plan or review leg on it carries a problem", () => {
    const c = (provider: string, model: string) => ({ provider, model, source: "installation" }) as never;
    const candidates: RouteCandidates = {
      plan: { routine: c("opencode", "opencode/big-pickle"), strong: null },
      build: { routine: c("opencode", "opencode/big-pickle"), strong: null },
      repair: { routine: null, strong: null },
      review: { routine: c("cursor", "auto"), strong: null },
    };
    const route = recommendRoute({ qualityMode: "default", evidence: ["check"], publication: "none", candidates, overrides: [] });
    const leg = (phase: string) => route.legs.find(one => one.phase === phase)!;
    expect(leg("plan").problem).toMatch(/OpenCode builds and repairs only/);
    expect(leg("review").problem).toMatch(/Cursor builds and repairs only/);
    expect(leg("build").problem).toBeNull();
  });
});
