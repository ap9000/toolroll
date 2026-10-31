/**
 * The eval runner against real processes (docs/plans/evals-nightly.md, part C1): two admissions racing from two
 * processes, a world's process tree that outlives its child or its time limit, and what the package ships. Worlds are
 * test-made (test/eval-worlds.ts); no provider is ever called and nothing is spent.
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { admitEvalCampaign, EVALS_ROOT, runEvalAttempt, type AttemptDeps, type EvalCase } from "./evals.js";
import { addApprover } from "./scope.js";
import { openStore, type Store } from "./store.js";
import { NOW, paginate, SET, worldDeps, type WorldSpec } from "../test/eval-worlds.js";

const REPO_ROOT = realpathSync(join(EVALS_ROOT, ".."));
let dir: string;
let store: Store;
let password: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "so-evals-slow-")));
  store = openStore(join(dir, "plane.db"));
  const added = addApprover(store, "alex", NOW);
  if (!added.ok) throw new Error("no approver");
  password = added.token;
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const attempt = async (spec: WorldSpec, script: string, one: EvalCase, over: Partial<AttemptDeps> = {}) => {
  const admitted = admitEvalCampaign(store, { kind: "eval", canonical: false, manifestDigest: SET.manifestDigest, buildDigest: "b", version: "v", k: 1, sealed: {}, as: "alex", token: password, now: NOW });
  if (!admitted.ok) throw new Error(admitted.message);
  const d = worldDeps(dir, spec, script, over);
  const ran = await runEvalAttempt(store, { campaign: admitted.id, one, n: 1, replaces: 0 }, d);
  if (ran.attempt === null) throw new Error(ran.why);
  return { ...ran, graded: d.graded };
};

describe("the package", () => {
  test("the package ships evals/ (manifest and every case file)", () => {
    const packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 })) as { files: { path: string }[] }[];
    const files = new Set(packed[0]!.files.map(one => one.path));
    expect(files.has("evals/manifest.json")).toBe(true);
    for (const one of SET.cases) for (const name of ["case.json", "source.md", ...(one.kind === "build" ? ["oracle.mjs", "probe.mjs"] : []), ...Object.keys(one.fixture).map(path => `fixture/${path}`)]) {
      expect(files.has(`evals/cases/${one.id}/${name}`), `${one.id}/${name}`).toBe(true);
    }
    // The provider-gate logic the runner needs ships in dist; the script stays out.
    expect(files.has("scripts/provider-gate.mjs")).toBe(false);
  }, 60_000);
});

describe("admission across processes", () => {
  test("two canonical campaigns admitted at the same moment from two processes: exactly one runs", async () => {
    const script = join(dir, "admit.mts");
    writeFileSync(script, `import { openStore } from ${JSON.stringify(join(REPO_ROOT, "src", "store.ts"))};
import { admitEvalCampaign } from ${JSON.stringify(join(REPO_ROOT, "src", "evals.ts"))};
const store = openStore(process.argv[2]);
const answer = admitEvalCampaign(store, { kind: "eval", canonical: true, manifestDigest: "m", buildDigest: "b", version: "v", k: 1, sealed: {},
  as: "alex", token: process.argv[3], now: new Date("2026-10-30T12:00:00.000Z"), id: process.argv[4] });
store.close();
process.stdout.write(JSON.stringify(answer));\n`);
    const tsx = join(REPO_ROOT, "node_modules", ".bin", "tsx");
    const race = (id: string) => new Promise<{ ok: boolean; reason?: string }>((done, fail) => execFile(tsx, [script, join(dir, "plane.db"), password, id], { encoding: "utf8" }, (error, stdout) => error ? fail(error) : done(JSON.parse(stdout))));
    const answers = await Promise.all([race("ev-a"), race("ev-b")]);
    expect(answers.filter(one => one.ok)).toHaveLength(1);
    expect(answers.find(one => !one.ok)?.reason).toBe("already-running");
    expect(store.handle.prepare("SELECT COUNT(*) AS n FROM eval_campaign WHERE canonical = 1 AND state = 'running'").get()).toMatchObject({ n: 1 });
  }, 60_000);
});

describe("a world's whole process tree", () => {
  test("a scripted provider completes the real world setup, build, collection and oracle", async () => {
    const { scriptedProvider } = await import(pathToFileURL(join(REPO_ROOT, "scripts/fixtures/scripted-provider.mjs")).href);
    const scripted = scriptedProvider(join(dir, "provider"));
    scripted.add("eval world", { role: "builder", when: [/paginate/], answer: {
      files: { "paginate.js": "export const paginate = (items, offset = 0, limit = 10) => { const from = Math.max(0, offset); return items.slice(from, from + limit); };\n" },
      conclusion: "Fixed pagination without changing the input.",
    } });
    const one = paginate({ pin: { provider: "claude", model: "claude-scripted" }, timeoutMinutes: 1 });
    const ran = await attempt({}, "", one, { command: input => ({
      file: process.execPath,
      args: ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e",
        `import { runEvalWorld } from ${JSON.stringify(pathToFileURL(join(REPO_ROOT, "src/eval-world.ts")).href)};
         console.log(JSON.stringify(await runEvalWorld(${JSON.stringify(one)}, ${JSON.stringify({ worldDir: input.worldDir, databaseFile: input.databaseFile, deny: [], timeoutMs: 55_000 })})));`],
      env: { ...process.env, PATH: `${scripted.bin}:${process.env["PATH"]}` } as Record<string, string>,
    }) });
    expect(ran.result).toMatchObject({ outcome: "pass", modelReported: "claude-scripted" });
    expect(scripted.journal().some((entry: { role: string }) => entry.role === "builder")).toBe(true);
  }, 90_000);

  test("a world that runs past its time limit fails, and its whole process group is stopped", async () => {
    const marker = join(dir, "late-write");
    const ran = await attempt({ runs: [{}] }, `require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => require('fs').writeFileSync('${marker}', 'x'), 2000)"], { stdio: "ignore" }); setInterval(() => {}, 1000);`,
      paginate({ timeoutMinutes: 1 / 60 }));
    expect(ran.result).toMatchObject({ outcome: "fail", why: expect.stringMatching(/past its/) });
    // Past when the stopped grandchild would have written, had it lived.
    await new Promise(done => setTimeout(done, 1_500));
    expect(existsSync(marker)).toBe(false);
  }, 20_000);

  test("a lingering grandchild: the oracle runs only after the whole process group is gone", async () => {
    const pidFile = join(dir, "grandchild.pid"), marker = join(dir, "grandchild.done");
    const goneAt: boolean[] = [];
    const ran = await attempt({ runs: [{}] },
      `const g = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => require('fs').writeFileSync('${marker}', 'done'), 1500)"], { stdio: "ignore" }); require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(g.pid)); process.exit(0);`,
      paginate(), { onTreeGone: () => { goneAt.push(existsSync(marker)); } });
    // The child exited at once; the runner waited for its grandchild (same group) to finish before reading or grading.
    expect(goneAt).toEqual([true]);
    expect(ran.result.outcome).toBe("pass");
    expect(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0)).toThrow();
  }, 20_000);

  test("a detached group whose leader exits while a member writes on: graded only after the whole group is gone (Codex round 1 #2)", async () => {
    // The child starts a leader in a group of its own (observed as a group), which starts a member and exits; the member
    // is born after the last observation, so only the leader's group witness can say it is still there.
    const marker = join(dir, "member.done");
    const member = `setTimeout(() => require('fs').writeFileSync('${marker}', 'done'), 1500)`;
    const leader = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(member)}], { stdio: 'ignore' }).unref(); setTimeout(() => process.exit(0), 40)`;
    const goneAt: boolean[] = [];
    const ran = await attempt({ runs: [{}] },
      `const l = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(`setTimeout(() => { ${leader} }, 650)`)}], { stdio: "ignore", detached: true }); l.unref(); setTimeout(() => process.exit(0), 660);`,
      paginate(), { onTreeGone: () => { goneAt.push(existsSync(marker)); } });
    expect(goneAt).toEqual([true]);
    expect(ran.result.outcome).toBe("pass");
  }, 20_000);

  test("a grandchild that never ends: the attempt is an error, never graded, and the world's group is stopped", async () => {
    const pidFile = join(dir, "stuck.pid");
    const ran = await attempt({ runs: [{}] },
      `const g = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(g.pid)); process.exit(0);`,
      paginate(), { settleMs: 800 });
    expect(ran.result).toMatchObject({ outcome: "error", why: expect.stringMatching(/processes didn't end/) });
    expect(ran.graded).toEqual([]);
    // What the world dispatched is still recorded (Codex round 1 #1): its records were read once the tree was stopped.
    expect(ran.result).toMatchObject({ apiMicrousd: 300_000, invocations: [expect.objectContaining({ worldRef: expect.stringMatching(/^run:/), recorded: true })] });
    expect(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0)).toThrow();
  }, 20_000);
});
