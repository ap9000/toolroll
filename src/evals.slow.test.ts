/**
 * The eval runner against real processes (docs/plans/evals-nightly.md, part C1): two admissions racing from two
 * processes, a world's process tree that outlives its child or its time limit, and what the package ships. Worlds are
 * test-made (test/eval-worlds.ts); no provider is ever called and nothing is spent.
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const month = () => ({ ...store.handle.prepare("SELECT reserved_microusd, settled_microusd FROM eval_spend_month WHERE month = '2026-10'").get() });

const attempt = async (spec: WorldSpec, script: string, one: EvalCase, over: Partial<AttemptDeps> = {}) => {
  const admitted = admitEvalCampaign(store, { kind: "eval", canonical: false, manifestDigest: SET.manifestDigest, buildDigest: "b", version: "v", k: 1, sealed: {}, reservedMicrousd: 10_000_000, as: "alex", token: password, now: NOW });
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
  test("two campaigns admitted at the same moment from two processes: exactly one gets the ceiling", async () => {
    const script = join(dir, "admit.mts");
    writeFileSync(script, `import { openStore } from ${JSON.stringify(join(REPO_ROOT, "src", "store.ts"))};
import { admitEvalCampaign } from ${JSON.stringify(join(REPO_ROOT, "src", "evals.ts"))};
const store = openStore(process.argv[2]);
const answer = admitEvalCampaign(store, { kind: "eval", canonical: false, manifestDigest: "m", buildDigest: "b", version: "v", k: 1, sealed: {}, reservedMicrousd: 130000000,
  as: "alex", token: process.argv[3], now: new Date("2026-10-30T12:00:00.000Z"), id: process.argv[4] });
store.close();
process.stdout.write(JSON.stringify(answer));\n`);
    const tsx = join(REPO_ROOT, "node_modules", ".bin", "tsx");
    const race = (id: string) => new Promise<{ ok: boolean; reason?: string }>((done, fail) => execFile(tsx, [script, join(dir, "plane.db"), password, id], { encoding: "utf8" }, (error, stdout) => error ? fail(error) : done(JSON.parse(stdout))));
    const answers = await Promise.all([race("ev-a"), race("ev-b")]);
    expect(answers.filter(one => one.ok)).toHaveLength(1);
    expect(answers.find(one => !one.ok)?.reason).toMatch(/^(already-running|over-ceiling)$/);
    expect(month()).toEqual({ reserved_microusd: 130_000_000, settled_microusd: 0 });
  }, 60_000);
});

describe("a world's whole process tree", () => {
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

  test("a grandchild that never ends: the attempt is an error, never graded, and the world's group is stopped", async () => {
    const pidFile = join(dir, "stuck.pid");
    const ran = await attempt({ runs: [{}] },
      `const g = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(g.pid)); process.exit(0);`,
      paginate(), { settleMs: 800 });
    expect(ran.result).toMatchObject({ outcome: "error", why: expect.stringMatching(/processes didn't end/) });
    expect(ran.graded).toEqual([]);
    expect(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0)).toThrow();
  }, 20_000);
});
