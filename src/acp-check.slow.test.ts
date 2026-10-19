/**
 * An ACP agent's conformance check, end to end (src/acp-check.ts): asked for, claimed by a watch, run as two real
 * runs through the gateway inside the fence, graded on plane evidence, and published with its attestation — or failed
 * in words, admitting nothing. The agent is the stand-in (test/fixtures/fake-acp-agent.mjs), found on PATH as opencode.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runAcpChecks } from "./acp-check.js";
import { linuxFenceAvailable, macosFenceAvailable } from "./agent-fence.js";
import { register } from "./runner.js";
import { openStore, type Store } from "./store.js";
import { WorktreePool } from "./worktree.js";

const FENCED = macosFenceAvailable() || linuxFenceAvailable();
const FIXTURE = join(import.meta.dirname, "..", "test", "fixtures", "fake-acp-agent.mjs");
const RUNNER = "mac";
let dir: string;
let repo: string;
let store: Store;
let pool: WorktreePool;
let env: Record<string, string | undefined>;
let home: string;
const saved = process.env["FAKE_ACP"];

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-acp-check-")));
  home = join(dir, "home");
  mkdirSync(home);
  repo = join(dir, "project");
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "hi\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  copyFileSync(FIXTURE, join(bin, "opencode"));
  execFileSync("chmod", ["+x", join(bin, "opencode")]);
  env = { ...process.env, PATH: `${bin}${delimiter}${process.env["PATH"] ?? ""}` };
  store = openStore(join(dir, "state.db"));
  register(store, { name: RUNNER, host: "test", capacity: 9, repos: [repo], now: new Date(), newToken: () => "tok" });
  const leased = store.acquireWatchLease(RUNNER, repo, "watch-1", 60 * 60_000, new Date());
  if (!leased.ok) throw new Error("watch");
  pool = new WorktreePool(store, { root: join(dir, "worktrees") });
});
afterEach(() => {
  if (saved === undefined) delete process.env["FAKE_ACP"]; else process.env["FAKE_ACP"] = saved;
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const job = () => ({ store, runner: RUNNER, token: "tok", watch: { repo, owner: "watch-1" }, pool, env, keyHome: home });

describe.skipIf(!FENCED)("an ACP agent's check", () => {
  test("an agent that does what it's asked passes, and only then is it admitted", async () => {
    const id = store.requestAcpCheck({ provider: "opencode", runner: RUNNER, model: "fake/model", by: "alex" }, new Date());
    expect(store.acpAttestationFor("opencode", RUNNER)).toBeNull();
    await runAcpChecks(job());
    const request = store.acpCheck(id)!;
    expect(request, request.result ?? "").toMatchObject({ state: "passed", step1Passed: true, step2Passed: true });
    expect(store.acpAttestationFor("opencode", RUNNER)).toMatchObject({ agent: { name: "FakeCode", version: "1.0.0" }, models: ["fake/default", "fake/model"] });
    // Its task is done; its checkout and branch are gone.
    expect(store.getTask(`agent-check-${id}`)?.state).toBe("done");
    expect(store.listWorktrees().filter(one => one.branch === `toolroll/agent-check-${id}`)).toEqual([]);
  }, 120_000);

  test("an agent that doesn't do the work fails its check, in words, and is never admitted", async () => {
    process.env["FAKE_ACP"] = "quiet-exit";
    const id = store.requestAcpCheck({ provider: "opencode", runner: RUNNER, model: "fake/model", by: "alex" }, new Date());
    await runAcpChecks(job());
    expect(store.acpCheck(id)).toMatchObject({ state: "failed", result: expect.stringContaining("session-ok") });
    expect(store.acpAttestationFor("opencode", RUNNER)).toBeNull();
    expect(store.getTask(`agent-check-${id}`)?.state).toBe("failed");
  }, 120_000);

  test("a cancel with nothing the plane saw alive is not a pass", async () => {
    // The stop step's agent claims a running command but starts none.
    process.env["FAKE_ACP"] = "slow-no-child";
    const id = store.requestAcpCheck({ provider: "opencode", runner: RUNNER, model: "fake/model", by: "alex" }, new Date());
    await runAcpChecks(job());
    expect(store.acpCheck(id)).toMatchObject({ state: "failed" });
    expect(store.acpAttestationFor("opencode", RUNNER)).toBeNull();
  }, 180_000);
});
