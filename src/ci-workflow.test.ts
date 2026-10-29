/**
 * The CI contract, read from the workflow files themselves: which jobs (by the check name GitHub shows) run for a pull
 * request, a push to main, the nightly schedule and a release tag. `toolroll release` waits for REQUIRED_PR_CHECKS and
 * RELEASE_TAG_CHECKS by exact name, so a renamed, conditional or missing job fails here rather than at a release.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import { RELEASE_TAG_CHECKS, REQUIRED_PR_CHECKS } from "./release.js";
import { GIT_FLOOR_WORDS } from "./git-floor.js";

type Step = { uses?: string; with?: Record<string, unknown>; name?: string; run?: string; if?: unknown; "continue-on-error"?: unknown };
type Job = {
  name?: string; "runs-on": string; container?: unknown; env?: Record<string, unknown>; if?: unknown; needs?: string | string[]; "continue-on-error"?: unknown;
  strategy?: { matrix?: Record<string, unknown[]> }; steps?: Step[];
};
type Workflow = { file: string; on: Record<string, unknown>; jobs: Record<string, Job> };
type Event = { kind: "pull_request"; paths: string[] } | { kind: "push"; branch?: string; tag?: string } | { kind: "schedule" };

const folder = join(import.meta.dirname, "..", ".github", "workflows");
const workflows: Workflow[] = readdirSync(folder).filter(file => /\.ya?ml$/.test(file)).map(file => {
  const raw = parse(readFileSync(join(folder, file), "utf8")) as { on: unknown; jobs: Record<string, Job> };
  const on = typeof raw.on === "string" ? { [raw.on]: null } : Array.isArray(raw.on) ? Object.fromEntries(raw.on.map(one => [one, null])) : raw.on as Record<string, unknown>;
  return { file, on, jobs: raw.jobs };
});

/** GitHub's filter globs as these files use them: `*` within a name. */
const matches = (patterns: unknown, value: string) => Array.isArray(patterns) && patterns.some(pattern => new RegExp(`^${String(pattern).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(value));

function triggered(workflow: Workflow, event: Event): boolean {
  const filter = workflow.on[event.kind];
  if (!(event.kind in workflow.on)) return false;
  const rules = (filter ?? {}) as Record<string, unknown>;
  if (event.kind === "pull_request") return rules["paths"] === undefined || event.paths.some(path => matches(rules["paths"], path));
  if (event.kind === "push") return event.branch !== undefined ? matches(rules["branches"], event.branch) : matches(rules["tags"], event.tag ?? "");
  return true;
}

/** Each job's check names: its name with every matrix combination filled in, and the runner each uses. */
function checks(job: Job, id: string): { name: string; runner: string }[] {
  const matrix = job.strategy?.matrix ?? {};
  let combos: Record<string, string>[] = [{}];
  for (const [key, values] of Object.entries(matrix)) combos = combos.flatMap(combo => values.map(value => ({ ...combo, [key]: String(value) })));
  const fill = (text: string, combo: Record<string, string>) => text.replace(/\$\{\{\s*matrix\.(\w+)\s*\}\}/g, (_, key: string) => combo[key] ?? "");
  return combos.map(combo => ({ name: fill(job.name ?? id, combo), runner: fill(job["runs-on"], combo) }));
}

const prChecks = () => [...REQUIRED_PR_CHECKS].sort();
/** The unit suite's shards (pipeline-speed.md, part A): they run beside the required checks; each Node version's join
 * job carries the required name. */
const SHARDS = 4;
const shardChecks = () => ["22", "24"].flatMap(node => Array.from({ length: SHARDS }, (_, at) => `node ${node} · shard ${at + 1}/${SHARDS}`)).sort();
const ciChecks = () => [...prChecks(), ...shardChecks()].sort();

const running = (event: Event) => workflows.filter(one => triggered(one, event)).flatMap(one => Object.entries(one.jobs).flatMap(([id, job]) => checks(job, id)));
const names = (event: Event) => running(event).map(one => one.name).sort();

describe("the CI workflows", () => {
  test("eval review 1 #1: every job's check name is fixed by the workflow and its matrix, never by an input or event", () => {
    // A name that varies between runs on one commit (a dispatch count, a branch) reads as another job, and an older
    // run's job under the old name would be history only. Only matrix values may appear in a name.
    const varying = workflows.flatMap(one => Object.entries(one.jobs).flatMap(([id, job]) => /\$\{\{(?!\s*matrix\.\w+\s*\}\})/.test(job.name ?? id) ? [`${one.file}: ${job.name}`] : []));
    expect(varying).toEqual([]);
  });

  test("a pull request runs Ubuntu on Node 22 and 24 plus the Linux and Windows containment jobs, and no macOS", () => {
    // No branch or path filter may omit required checks on a PR (including documentation-only changes).
    expect(workflows.find(one => one.file === "ci.yml")?.on["pull_request"]).toBeNull();
    const pr: Event = { kind: "pull_request", paths: ["src/release.ts"] };
    expect(names(pr)).toEqual(ciChecks());
    expect(running(pr).filter(one => /macos/.test(one.runner))).toEqual([]);
    expect(running(pr).filter(one => /ubuntu/.test(one.runner) && /^node \d+ · ubuntu-latest$/.test(one.name)).map(one => one.name).sort()).toEqual(["node 22 · ubuntu-latest", "node 24 · ubuntu-latest"]);
    expect(names({ kind: "pull_request", paths: ["README.md"] })).toEqual(ciChecks());
    expect(running(pr).find(one => one.name === "Windows Job Object containment")?.runner).toBe("windows-latest");
    expect(running(pr).find(one => one.name === "linux native containment · delegated cgroup v2")?.runner).toBe("ubuntu-latest");
    // The Windows repeat job only joins pull requests that touch Windows containment; it is never a required check.
    const windows = names({ kind: "pull_request", paths: ["src/containment.ts"] });
    expect(windows.filter(name => !ciChecks().includes(name))).toEqual(["Windows Job Object containment · c2 repeat"]);
  });

  test("a failed or skipped macOS leg prevents npm publication through the tag workflow dependency", () => {
    const workflow = workflows.find(one => one.file === "publish.yml")!;
    expect(triggered(workflow, { kind: "push", tag: "v0.9.52" })).toBe(true);
    const publisher = workflow.jobs["publish"]!;
    expect(publisher.needs).toBe("macos");
    const macos = workflow.jobs["macos"]!;
    expect(checks(macos, "macos")).toEqual([
      { name: "node 22 · macos-latest", runner: "macos-latest" },
      { name: "node 24 · macos-latest", runner: "macos-latest" },
    ]);
    // GitHub needs requires every matrix leg to succeed. Neither the job nor a test step may override failure:
    // https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-jobs
    for (const job of [macos, publisher]) {
      expect(job.if).toBeUndefined();
      expect(job["continue-on-error"] ?? false).toBe(false);
      for (const step of job.steps ?? []) {
        expect(step.if).toBeUndefined();
        expect(step["continue-on-error"] ?? false).toBe(false);
      }
    }
    expect(macos.steps?.filter(step => step.run).map(step => step.run)).toEqual(["npm ci", "npm run typecheck", "npm run build", "npm run test:all"]);
    // Every workflow runs both unit tiers (docs/TESTING.md); bare `npm test` skips the slow one.
    expect(workflows.flatMap(one => Object.values(one.jobs).flatMap(job => job.steps ?? [])).filter(step => step.run === "npm test")).toEqual([]);
    const publishers = workflows.flatMap(one => Object.entries(one.jobs).filter(([, job]) => job.steps?.some(step => /\bnpm publish\b/.test(step.run ?? ""))).map(([id]) => `${one.file}:${id}`));
    expect(publishers).toEqual(["publish.yml:publish"]);
    expect(publisher.steps?.some(step => step.run === "npm publish --access public")).toBe(true);
    expect(triggered(workflows.find(one => one.file === "macos.yml")!, { kind: "push", tag: "v0.9.52" })).toBe(false);
  });

  test("macOS runs nightly and on release tags, on Node 22 and 24", () => {
    const macos = (event: Event) => running(event).filter(one => /macos/.test(one.runner)).map(one => one.name).sort();
    expect(macos({ kind: "schedule" })).toEqual(["node 22 · macos-latest", "node 24 · macos-latest"]);
    expect(macos({ kind: "push", tag: "v0.9.52" })).toEqual(["node 22 · macos-latest", "node 24 · macos-latest"]);
    expect(macos({ kind: "push", branch: "main" })).toEqual([]);
    // Everything a release waits for on its tag runs there: macOS, and the npm publish.
    expect(names({ kind: "push", tag: "v0.9.52" })).toEqual([...RELEASE_TAG_CHECKS].sort());
    expect(workflows.find(one => one.file === "macos.yml")?.on["schedule"]).toEqual([{ cron: expect.stringMatching(/^\d+ \d+ \* \* \*$/) }]);
  });

  test("a push to main runs the pull-request jobs again", () => {
    expect(names({ kind: "push", branch: "main" })).toEqual(ciChecks());
    expect(names({ kind: "push", branch: "toolroll/simplify-release" })).toEqual([]);
  });

  test("every pull-request job tests the candidate's head commit, not GitHub's merge commit, and proves it", () => {
    const ci = workflows.find(one => one.file === "ci.yml")!;
    for (const [id, job] of Object.entries(ci.jobs)) {
      expect(job.env?.["TESTED_SHA"], id).toBe("${{ github.event.pull_request.head.sha || github.sha }}");
      const steps = job.steps ?? [];
      const checkout = steps.findIndex(step => step.uses?.startsWith("actions/checkout@"));
      expect(steps[checkout]?.with?.["ref"], id).toBe("${{ env.TESTED_SHA }}");
      // The proof runs before any other command: nothing is built or tested from an unproven tree.
      const proof = steps.findIndex(step => step.name === "Tested commit");
      expect(proof, id).toBeGreaterThan(checkout);
      expect(steps[proof]?.run, id).toContain("git rev-parse HEAD");
      expect(steps[proof]?.run, id).toContain("$TESTED_SHA");
      expect(steps.slice(checkout + 1, proof).filter(step => step.uses !== undefined || /\bnpm\b|vitest|scripts\//.test(step.run ?? "")), id).toEqual([]);
    }
    // The shards' migration tests read old releases from history.
    expect(ci.jobs["test-shard"]?.steps?.find(step => step.uses?.startsWith("actions/checkout@"))?.with?.["fetch-depth"]).toBe(0);
  });

  test("the git lanes run the git tests on the declared floor and on 2.47, unprivileged, and refuse a skip", () => {
    const job = workflows.find(one => one.file === "ci.yml")!.jobs["git"]!;
    expect(job.container).toEqual({ image: "node:22-trixie", options: "--init" });
    expect(job.strategy?.matrix?.["git"]).toEqual([GIT_FLOOR_WORDS, "2.47"]);
    const runs = (job.steps ?? []).map(step => step.run ?? "");
    expect(runs).toContain("scripts/ci-git.sh ${{ matrix.git }}");
    expect(runs.filter(run => /\bnpm (ci|run)\b|\bnode scripts\//.test(run)).every(run => run.startsWith("runuser -u node -- "))).toBe(true);
    expect(runs.some(run => run.includes("npm run test:git"))).toBe(true);
    expect(runs).toContain("runuser -u node -- node scripts/ci-no-skips.mjs git-lane.json");
    // The floor's git has no --no-lazy-fetch: its lane proves, by name, that a partial clone is refused there.
    const floor = (job.steps ?? []).find(step => (step.run ?? "").includes("checkout-git-partial-clone.test.ts"));
    expect(floor?.if).toBe(`matrix.git == '${GIT_FLOOR_WORDS}'`);
    expect(floor?.run).toMatch(/^runuser -u node -- /);
  });

  test("no job runs behind a condition, so a skipped job can't stand in for a passing required check", () => {
    // The one exception always runs: the shards' join, which a failed shard would otherwise skip into a pass.
    const conditional = workflows.flatMap(one => Object.entries(one.jobs).filter(([, job]) => job.if !== undefined).map(([id, job]) => `${one.file}: ${id} ${String(job.if)}`));
    expect(conditional).toEqual(["ci.yml: test ${{ always() }}"]);
  });

  test("pipeline-speed A: each required Node check joins every shard of the unit suite and fails unless all of them passed on the tested commit", () => {
    const ci = workflows.find(one => one.file === "ci.yml")!;
    const shard = ci.jobs["test-shard"]!, join = ci.jobs["test"]!;
    // Every shard of every Node version, never failing fast (a cancelled shard proves nothing), nothing tolerated.
    expect(shard.strategy?.matrix).toEqual({ node: ["22", "24"], shard: Array.from({ length: SHARDS }, (_, at) => at + 1) });
    expect((shard.strategy as { "fail-fast"?: unknown })["fail-fast"]).toBe(false);
    expect(join.strategy?.matrix).toEqual({ node: ["22", "24"] });
    expect(join.needs).toBe("test-shard");
    for (const job of [shard, join]) {
      expect(job["continue-on-error"] ?? false).toBe(false);
      for (const step of job.steps ?? []) { expect(step.if).toBeUndefined(); expect(step["continue-on-error"] ?? false).toBe(false); }
    }
    const runs = (job: Job) => (job.steps ?? []).map(step => step.run ?? "");
    // Each shard runs the whole suite's command on its slice, then records what it ran on the tested commit.
    expect(runs(shard)).toContain(`npm run test:all -- --shard=\${{ matrix.shard }}/${SHARDS} --reporter=default --reporter=json --outputFile.json=shard-report.json`);
    expect(runs(shard)).toContain(`node scripts/ci-shards.mjs summarize shard-report.json shard-summary.json --sha "$TESTED_SHA" --node \${{ matrix.node }} --shard \${{ matrix.shard }}/${SHARDS}`);
    expect(runs(shard)).toEqual(expect.arrayContaining(["npm ci", "npm run typecheck", "npm run build"]));
    // The join: the shards' own result first, then their summaries against Vitest's list of this commit's files.
    const steps = join.steps ?? [];
    const result = steps.findIndex(step => step.name === "Every shard passed");
    expect(result).toBeGreaterThan(steps.findIndex(step => step.name === "Tested commit"));
    expect((steps[result] as { env?: Record<string, string> }).env?.["SHARDS"]).toBe("${{ needs.test-shard.result }}");
    expect(steps[result]?.run).toMatch(/^test "\$SHARDS" = success \|\|/);
    expect(runs(join)).toContain("npx vitest list --filesOnly --json=listed-files.json");
    expect(runs(join).at(-1)).toBe(`node scripts/ci-shards.mjs verify shards listed-files.json --sha "$TESTED_SHA" --node \${{ matrix.node }} --shards ${SHARDS}`);
    expect(steps.find(step => step.uses?.startsWith("actions/download-artifact@"))?.with?.["pattern"]).toBe("shard-${{ matrix.node }}-*");
  });
});
