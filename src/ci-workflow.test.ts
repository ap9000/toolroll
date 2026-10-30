/**
 * The CI contract, read from the workflow files themselves (docs/plans/test-matrix.md): which jobs (by the check name
 * GitHub shows) run, or report skipped, for a pull request, a release candidate, a push to main, the nightly schedule
 * and a release tag. `toolroll release` waits for REQUIRED_PR_CHECKS and RELEASE_TAG_CHECKS by exact name, and
 * publish.yml's release proof reads the same list, so a renamed, conditional or missing job fails here rather than at a
 * release. The documentation-only classifier (scripts/ci-scope.mjs) and the release proof (scripts/release-proof.mjs)
 * are held here too: each way to get around them is one row.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { parse } from "yaml";
import { areaLanes, diffEntries, docsPath, parseNameStatus } from "../scripts/ci-scope.mjs";
import { parseRequired, PROOF_EVENTS, proofProblem } from "../scripts/release-proof.mjs";
import { RELEASE_TAG_CHECKS, REQUIRED_PR_CHECKS, REQUIRED_PR_CHECKS_WORKFLOW } from "./release.js";
import { GIT_FLOOR_WORDS } from "./git-floor.js";

type Step = { uses?: string; with?: Record<string, unknown>; name?: string; run?: string; if?: unknown; env?: Record<string, unknown>; id?: string; "continue-on-error"?: unknown };
type Job = {
  name?: string; "runs-on"?: string; uses?: string; container?: unknown; env?: Record<string, unknown>; if?: unknown; needs?: string | string[]; "continue-on-error"?: unknown;
  permissions?: Record<string, string>; outputs?: Record<string, string>; strategy?: { matrix?: Record<string, unknown[]> }; steps?: Step[];
};
type Workflow = { file: string; on: Record<string, unknown>; jobs: Record<string, Job>; permissions?: unknown };
/** An event, as the workflows see it: a pull request (its changed paths and branch), a push, the schedule, a dispatch. */
type Event = { kind: "pull_request"; paths: string[]; branch: string } | { kind: "push"; branch?: string; tag?: string } | { kind: "schedule" } | { kind: "workflow_dispatch" };

const folder = join(import.meta.dirname, "..", ".github", "workflows");
const workflows: Workflow[] = readdirSync(folder).filter(file => /\.ya?ml$/.test(file)).map(file => {
  const raw = parse(readFileSync(join(folder, file), "utf8")) as { on: unknown; jobs: Record<string, Job>; permissions?: unknown };
  const on = typeof raw.on === "string" ? { [raw.on]: null } : Array.isArray(raw.on) ? Object.fromEntries(raw.on.map(one => [one, null])) : raw.on as Record<string, unknown>;
  return { file, on, jobs: raw.jobs, permissions: raw.permissions };
});
const workflow = (file: string) => workflows.find(one => one.file === file)!;
const CI = ".github/workflows/ci.yml", RC = ".github/workflows/release-candidate.yml";

/** GitHub's filter globs as these files use them: `*` within a name. */
const matches = (patterns: unknown, value: string) => Array.isArray(patterns) && patterns.some(pattern => new RegExp(`^${String(pattern).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(value));

function triggered(one: Workflow, event: Event): boolean {
  if (!(event.kind in one.on)) return false;
  const rules = (one.on[event.kind] ?? {}) as Record<string, unknown>;
  if (event.kind === "pull_request") return rules["paths"] === undefined || event.paths.some(path => matches(rules["paths"], path));
  if (event.kind === "push") return event.branch !== undefined ? matches(rules["branches"], event.branch) : matches(rules["tags"], event.tag ?? "");
  return true;
}

/**
 * The only job conditions these workflows may use, each with what it decides for an event. Any other `if:` fails the
 * "only the listed jobs carry a condition" test below.
 */
const RELEASE_BRANCH = "github.event_name != 'pull_request' || startsWith(github.head_ref, 'release-')";
const LANE = "${{ always() && !(needs.scope.result == 'success' && needs.scope.outputs.areas == 'docs-only') }}";
const UNPROVEN = "${{ always() && !(needs.proof.result == 'success' && needs.proof.outputs.proven == 'true') }}";
const CONDITIONS: Record<string, (event: Event) => boolean> = {
  "${{ always() }}": () => true,
  [`\${{ ${RELEASE_BRANCH} }}`]: event => event.kind !== "pull_request" || event.branch.startsWith("release-"),
  [`\${{ always() && (${RELEASE_BRANCH}) }}`]: event => event.kind !== "pull_request" || event.branch.startsWith("release-"),
  // ci-scope.mjs's own decision over the event's paths (as modifications); the lane runs unless it said docs-only.
  [LANE]: event => event.kind !== "pull_request" || areaLanes({ event: "pull_request", headRef: event.branch, entries: event.paths.map(path => ({ status: "M", paths: [path] })) }).run,
  // main-push.yml: the full CI whenever the merge commit isn't proven tested (these tests take it unproven).
  [UNPROVEN]: () => true,
};

type Check = { name: string; runner: string; runs: boolean; workflow: string };
/** Each job's check names: its name with every matrix combination filled in, its runner, and whether it runs or reports
 * skipped for `event`. A job calling a workflow of this repository reports that workflow's checks under its name. */
function checks(job: Job, id: string, event: Event, file: string): Check[] {
  const runs = job.if === undefined || (CONDITIONS[String(job.if)]?.(event) ?? true);
  if (job.uses !== undefined) {
    const called = workflow(job.uses.replace(/^\.\/\.github\/workflows\//, ""));
    return Object.entries(called.jobs).flatMap(([inner, one]) => checks(one, inner, event, called.file))
      .map(one => ({ ...one, name: `${job.name ?? id} / ${one.name}`, runs: runs && one.runs }));
  }
  // GitHub doesn't expand a matrix for a job its `if:` skips: it reports one check under the name as written.
  if (!runs && /\$\{\{\s*matrix\./.test(job.name ?? id)) return [{ name: job.name ?? id, runner: job["runs-on"] ?? "", runs, workflow: `.github/workflows/${file}` }];
  const matrix = job.strategy?.matrix ?? {};
  let combos: Record<string, string>[] = [{}];
  for (const [key, values] of Object.entries(matrix)) combos = combos.flatMap(combo => values.map(value => ({ ...combo, [key]: String(value) })));
  const fill = (text: string, combo: Record<string, string>) => text.replace(/\$\{\{\s*matrix\.(\w+)\s*\}\}/g, (_, key: string) => combo[key] ?? "");
  // A matrix job whose name mentions no matrix value gets GitHub's suffix: "name (v1, v2)".
  const suffix = (combo: Record<string, string>) => Object.keys(matrix).length > 0 && !/\$\{\{\s*matrix\./.test(job.name ?? id) ? ` (${Object.values(combo).join(", ")})` : "";
  return combos.map(combo => ({ name: fill(job.name ?? id, combo) + suffix(combo), runner: fill(job["runs-on"] ?? "", combo), runs, workflow: `.github/workflows/${file}` }));
}

const SHARDS = 4;
const shardNames = (node: string) => Array.from({ length: SHARDS }, (_, at) => [`node ${node} · shard ${at + 1}/${SHARDS}`, `node ${node} · macos shard ${at + 1}/${SHARDS}`]).flat();
const reported = (event: Event) => workflows.filter(one => triggered(one, event)).flatMap(one => Object.entries(one.jobs).flatMap(([id, job]) => checks(job, id, event, one.file)));
const names = (event: Event) => reported(event).map(one => one.name).sort();
const executed = (event: Event) => reported(event).filter(one => one.runs).map(one => one.name).sort();
const pr = (paths: string[], branch = "toolroll/some-change"): Event => ({ kind: "pull_request", paths, branch });
const AREA = ["linux native containment · delegated cgroup v2", "linux fence · sandbox-runtime", "Windows Job Object containment", "git 2.41 · debian trixie", "git 2.47 · debian trixie"];
const SCOPE = "area lanes · scope";
const REPEAT = "Windows Job Object containment · c2 repeat";
const runsOf = (job: Job) => (job.steps ?? []).map(step => step.run ?? "");

describe("the CI workflows", () => {
  test("every required check reports under its exact name on an ordinary pull request, run or skipped", () => {
    // 0.9.80: release-candidate.yml's skipped Node 22 jobs reported "node ${{ matrix.node }} · …", so main's protection
    // never saw "node 22 · ubuntu-latest" and blocked every pull request not from a release-* branch.
    for (const event of [pr(["src/release.ts"]), pr(["docs/plans/x.md"]), pr(["src/release.ts"], "release-9.9.9")]) {
      const all = names(event);
      expect(REQUIRED_PR_CHECKS.filter(name => !all.includes(name)), event.kind === "pull_request" ? event.branch : "").toEqual([]);
    }
  });

  test("Release candidate writes Node 22 out: no matrix carries it", () => {
    const rc = workflow("release-candidate.yml");
    for (const [id, job] of Object.entries(rc.jobs)) {
      expect(job.strategy?.matrix?.["node"], id).toBeUndefined();
      expect(job.name, id).toMatch(/^node 22 · /);
    }
    expect(JSON.stringify(rc)).not.toContain("matrix.node");
  });

  test("eval review 1 #1: every job's check name is fixed by the workflow and its matrix, never by an input or event", () => {
    // A name that varies between runs on one commit (a dispatch count, a branch) reads as another job, and an older
    // run's job under the old name would be history only. Only matrix values may appear in a name.
    const varying = workflows.flatMap(one => Object.entries(one.jobs).flatMap(([id, job]) => /\$\{\{(?!\s*matrix\.\w+\s*\}\})/.test(job.name ?? id) ? [`${one.file}: ${job.name}`] : []));
    expect(varying).toEqual([]);
  });

  test("every pull request reports every required check; Node 24 on Linux and macOS and the area lanes run, Node 22 only on a release-* branch", () => {
    expect(workflow("ci.yml").on["pull_request"]).toBeNull();
    expect(workflow("release-candidate.yml").on["pull_request"]).toBeNull();
    const all = [...REQUIRED_PR_CHECKS, ...shardNames("24"), ...shardNames("22"), SCOPE].sort();
    const change = pr(["src/release.ts"]);
    // Skipped, Node 22's shards report once each, unexpanded (GitHub skips a matrix job before expanding it); the
    // required names are written out, so they report exactly.
    const skippedShards = ["node 22 · shard ${{ matrix.shard }}/4", "node 22 · macos shard ${{ matrix.shard }}/4"];
    expect(names(change)).toEqual([...all.filter(name => !shardNames("22").includes(name)), ...skippedShards].sort());
    // An ordinary pull request: Node 22 reports skipped (main's protection reads that as passing a merge; a release never).
    expect(executed(change)).toEqual([...REQUIRED_PR_CHECKS.filter(name => !name.startsWith("node 22")), ...shardNames("24"), SCOPE].sort());
    // A release candidate's pull request runs everything.
    expect(executed(pr(["package.json", "CHANGELOG.md"], "release-0.9.80"))).toEqual(all);
    // The macOS suite runs on the candidate before it merges, sharded; its joins run on Linux.
    const macos = reported(change).filter(one => /macos/.test(one.runner));
    expect(macos.map(one => one.name).sort()).toEqual([...shardNames("24").filter(name => name.includes("macos shard")), skippedShards[1]!].sort());
    expect(reported(change).filter(one => /^node \d+ · macos-latest$/.test(one.name)).map(one => one.runner)).toEqual(["ubuntu-24.04", "ubuntu-24.04"]);
    expect(reported(change).find(one => one.name === "Windows Job Object containment")?.runner).toBe("windows-latest");
    expect(reported(change).find(one => one.name === "linux native containment · delegated cgroup v2")?.runner).toBe("ubuntu-latest");
    // The Windows repeat job only joins pull requests that touch Windows containment; it is never a required check.
    expect(names(pr(["src/containment.ts"])).filter(name => !all.includes(name) && !skippedShards.includes(name))).toEqual([REPEAT]);
  });

  test("test-matrix: a documentation-only pull request skips the area lanes and nothing else; anything more runs them", () => {
    const docs = pr(["docs/plans/test-matrix.md", "CHANGELOG.md", "README.md"]);
    expect(names(docs)).toEqual(names(pr(["src/release.ts"])));
    expect(executed(docs)).toEqual([...shardNames("24"), "node 24 · ubuntu-latest", "node 24 · macos-latest", SCOPE].sort());
    // One file beyond documentation, or a release branch, runs every lane.
    for (const event of [pr(["docs/a.md", "src/x.ts"]), pr(["docs/a.md"], "release-0.9.80"), pr(["docs/a.json"]), pr(["test/attacks/a.test.ts"])]) {
      expect(executed(event).filter(name => AREA.includes(name)).sort(), JSON.stringify(event)).toEqual([...AREA].sort());
    }
    // The lanes' condition is the fail-closed one: they run unless the scope job succeeded and said docs-only.
    const ci = workflow("ci.yml");
    for (const id of ["linux-native-containment", "linux-fence", "native-windows", "git-floor", "git-247"]) {
      expect(ci.jobs[id]?.needs, id).toBe("scope");
      expect(ci.jobs[id]?.if, id).toBe(LANE);
    }
    // The decision is the trusted base revision's classifier over the pull request's own diff, its untrusted inputs
    // passed through the environment (never into the script's text).
    const scope = ci.jobs["scope"]!;
    expect(scope.outputs).toEqual({ areas: "${{ steps.decide.outputs.areas }}" });
    expect(scope.steps?.find(step => step.uses?.startsWith("actions/checkout@") && step.with?.["ref"] === "${{ env.TESTED_SHA }}")?.with?.["fetch-depth"]).toBe(0);
    const decide = scope.steps?.find(step => step.id === "decide");
    expect(decide?.env).toEqual({ EVENT: "${{ github.event_name }}", HEAD_REF: "${{ github.head_ref }}", BASE_SHA: "${{ github.event.pull_request.base.sha }}" });
    expect(decide?.run).toContain("classifier=.trusted-base/scripts/ci-scope.mjs");
    expect(decide?.run).toContain(`node "$classifier" decide --event "$EVENT" --head-ref "$HEAD_REF" --base "$BASE_SHA" --head "$TESTED_SHA" --root "$GITHUB_WORKSPACE" | tee -a "$GITHUB_OUTPUT"`);
    expect(decide as unknown as { shell?: string }).toMatchObject({ shell: "bash" });
    expect(runsOf(scope).filter(run => /\$\{\{/.test(run))).toEqual([]);
    // Run the actual workflow step against a malicious candidate and no base classifier. It must run every lane.
    const scratch = mkdtempSync(join(tmpdir(), "scope-bootstrap-"));
    try {
      mkdirSync(join(scratch, "scripts"));
      writeFileSync(join(scratch, "scripts/ci-scope.mjs"), "console.log('areas=docs-only');\n");
      const output = join(scratch, "output");
      const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", String(decide?.run)], {
        cwd: scratch, encoding: "utf8", env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: scratch, XDG_CONFIG_HOME: scratch, GITHUB_OUTPUT: output, EVENT: "pull_request", HEAD_REF: "release-1", BASE_SHA: "a".repeat(40), TESTED_SHA: "b".repeat(40), GITHUB_WORKSPACE: scratch },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(output, "utf8").trim()).toBe("areas=run");
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });

  test("only the listed jobs carry a condition, each one these tests can read", () => {
    // GitHub reads a job skipped by `if:` as passing a required check in main's protection; `toolroll release` never
    // accepts a skipped check. The shards' joins always run; the area lanes and Node 22 skip only as described above.
    const conditional = workflows.flatMap(one => Object.entries(one.jobs).filter(([, job]) => job.if !== undefined).map(([id, job]) => `${one.file}: ${id} ${String(job.if)}`)).sort();
    expect(conditional).toEqual([
      `ci.yml: git-247 ${LANE}`, `ci.yml: git-floor ${LANE}`, `ci.yml: linux-fence ${LANE}`, `ci.yml: linux-native-containment ${LANE}`,
      "ci.yml: macos ${{ always() }}", `ci.yml: native-windows ${LANE}`, "ci.yml: test ${{ always() }}",
      `main-push.yml: full ${UNPROVEN}`,
      `release-candidate.yml: macos \${{ always() && (${RELEASE_BRANCH}) }}`, `release-candidate.yml: macos-shard \${{ ${RELEASE_BRANCH} }}`,
      `release-candidate.yml: test \${{ always() && (${RELEASE_BRANCH}) }}`, `release-candidate.yml: test-shard \${{ ${RELEASE_BRANCH} }}`,
    ].sort());
    for (const one of conditional) expect(Object.keys(CONDITIONS), one).toContain(one.slice(one.indexOf("${{")));
  });

  test("each required check comes from exactly the workflow the release gate maps it to, and no other workflow names it", () => {
    for (const file of ["ci.yml", "release-candidate.yml"]) {
      // Candidate code must not inherit a repository's permissive default GITHUB_TOKEN.
      expect(workflow(file).permissions, file).toEqual({ contents: "read" });
      expect(Object.values(workflow(file).jobs).flatMap(job => Object.values(job.permissions ?? {}))).not.toContain("write");
    }
    expect(Object.keys(REQUIRED_PR_CHECKS_WORKFLOW).sort()).toEqual([...REQUIRED_PR_CHECKS].sort());
    for (const event of [pr(["src/release.ts"], "release-1"), { kind: "push", branch: "main" } as Event, { kind: "schedule" } as Event, { kind: "workflow_dispatch" } as Event]) {
      for (const name of REQUIRED_PR_CHECKS) {
        const from = reported(event).filter(one => one.name === name).map(one => one.workflow);
        expect(from.every(file => file === REQUIRED_PR_CHECKS_WORKFLOW[name]), `${name} on ${event.kind}`).toBe(true);
      }
    }
    // Nothing run by hand reports a required name: the release gate binds a required check to a pull request's run, and
    // a run by hand on the candidate would report one it refuses. On demand, Nightly runs it all under its own names.
    expect(reported({ kind: "workflow_dispatch" }).filter(one => (REQUIRED_PR_CHECKS as readonly string[]).includes(one.name))).toEqual([]);
    expect(executed({ kind: "workflow_dispatch" }).filter(one => one.endsWith(" / node 22 · macos-latest"))).toEqual(["nightly floor / node 22 · macos-latest"]);
    expect(workflow("release-candidate.yml").on).toEqual({ pull_request: null, workflow_call: null });
  });

  test("test-matrix: the release tag runs no tests; npm publication needs the release proof, whose list is REQUIRED_PR_CHECKS", () => {
    const publish = workflow("publish.yml");
    expect(triggered(publish, { kind: "push", tag: "v0.9.80" })).toBe(true);
    expect(names({ kind: "push", tag: "v0.9.80" })).toEqual([...RELEASE_TAG_CHECKS].sort());
    const proof = publish.jobs["proof"]!, publisher = publish.jobs["publish"]!;
    expect(publisher.needs).toBe("proof");
    // Read-only token for the proof; only the publisher may write (the GitHub release) and mint npm's OIDC token.
    expect(publish.permissions).toEqual({ contents: "read" });
    expect(proof.permissions).toEqual({ contents: "read", actions: "read", "pull-requests": "read" });
    expect(publisher.permissions).toEqual({ contents: "write", "id-token": "write" });
    // The list the proof reads is exactly the release gate's, each name from the same workflow.
    expect(parseRequired(String(proof.env?.["REQUIRED_CHECKS"]))).toEqual({ ...REQUIRED_PR_CHECKS_WORKFLOW });
    expect(Object.keys(PROOF_EVENTS).sort()).toEqual([...new Set(Object.values(REQUIRED_PR_CHECKS_WORKFLOW))].sort());
    expect(runsOf(proof).at(-1)).toBe(`node scripts/release-proof.mjs verify --repo "$GITHUB_REPOSITORY" --sha "$GITHUB_SHA" --required "$REQUIRED_CHECKS" --tag "$GITHUB_REF_NAME"`);
    expect(proof.steps?.at(-1)?.env).toEqual({ GITHUB_TOKEN: "${{ github.token }}" });
    expect(runsOf(proof).some(run => run.includes(`git merge-base --is-ancestor "$GITHUB_SHA" origin/main`))).toBe(true);
    // Neither job nor any step may override failure, and the proof installs and runs nothing of the candidate's.
    for (const job of [proof, publisher]) {
      expect(job.if).toBeUndefined();
      expect(job["continue-on-error"] ?? false).toBe(false);
      for (const step of job.steps ?? []) { expect(step.if).toBeUndefined(); expect(step["continue-on-error"] ?? false).toBe(false); }
    }
    expect(runsOf(proof).filter(run => /\bnpm\b|\bnpx\b|vitest/.test(run))).toEqual([]);
    // Every workflow runs both unit tiers (docs/TESTING.md); bare `npm test` skips the slow one.
    expect(workflows.flatMap(one => Object.values(one.jobs).flatMap(job => job.steps ?? [])).filter(step => step.run === "npm test")).toEqual([]);
    const publishers = workflows.flatMap(one => Object.entries(one.jobs).filter(([, job]) => job.steps?.some(step => /\bnpm publish\b/.test(step.run ?? ""))).map(([id]) => `${one.file}:${id}`));
    expect(publishers).toEqual(["publish.yml:publish"]);
    for (const job of [proof, publisher]) expect(job.steps?.find(step => step.uses?.startsWith("actions/checkout@"))?.with).toMatchObject({ ref: "${{ github.sha }}", "persist-credentials": false });
    const publishStep = publisher.steps?.find(step => /\bnpm publish\b/.test(step.run ?? ""));
    const guard = `node scripts/release-proof.mjs tag --repo "$GITHUB_REPOSITORY" --sha "$GITHUB_SHA" --tag "$GITHUB_REF_NAME"`;
    expect(publishStep?.run?.trim()).toBe(`${guard}\nnpm publish --access public --ignore-scripts`);
    expect(publishStep?.env).toEqual({ GITHUB_TOKEN: "${{ github.token }}" });
    // Build first, then check the live tag immediately before the write; publish must not run the build again.
    expect(publisher.steps!.findIndex(step => step.run === "npm run prepublishOnly")).toBeLessThan(publisher.steps!.indexOf(publishStep!));
    expect(publisher.steps?.find(step => step.name === "GitHub release from the changelog")?.run).toContain(guard);
    expect(reported({ kind: "push", tag: "v0.9.80" }).some(one => /macos/.test(one.runner))).toBe(false);
  });

  test("test-matrix: a push to main builds, and runs the full CI unless its merge commit is proven tested on its pull request", () => {
    expect(triggered(workflow("ci.yml"), { kind: "push", branch: "main" })).toBe(false);
    const main = workflow("main-push.yml");
    expect(main.on).toEqual({ push: { branches: ["main"] } });
    expect(names({ kind: "push", branch: "toolroll/simplify-release" })).toEqual([]);
    // Its own names: a "main · full CI / …" job never reads as a pull request's required check.
    expect(reported({ kind: "push", branch: "main" }).filter(one => !one.name.startsWith("main · ")).map(one => one.name)).toEqual([]);
    expect(executed({ kind: "push", branch: "main" })).toEqual(expect.arrayContaining(["main · full CI / node 24 · ubuntu-latest", "main · full CI / git 2.41 · debian trixie"]));
    expect(main.jobs["full"]?.uses).toBe("./.github/workflows/ci.yml");
    expect(main.jobs["full"]?.needs).toBe("proof");
    expect(runsOf(main.jobs["build"]!).filter(run => run !== "")).toEqual(["npm ci", "npm run typecheck", "npm run build"]);
    const proof = main.jobs["proof"]!;
    expect(proof.permissions).toEqual({ contents: "read", actions: "read", "pull-requests": "read" });
    // The ci.yml part of the release gate's list.
    expect(parseRequired(String(proof.env?.["REQUIRED_CHECKS"]))).toEqual(Object.fromEntries(Object.entries(REQUIRED_PR_CHECKS_WORKFLOW).filter(([, file]) => file === CI)));
    expect(runsOf(proof).at(-1)).toContain(`if node scripts/release-proof.mjs verify --repo "$GITHUB_REPOSITORY" --sha "$GITHUB_SHA" --required "$REQUIRED_CHECKS"; then`);
    expect(proof.outputs).toEqual({ proven: "${{ steps.prove.outputs.proven }}" });
  });

  test("test-matrix: the nightly runs everything on main: both Node versions on Linux and macOS and every area lane", () => {
    const nightly = workflow("nightly.yml");
    expect(nightly.on["schedule"]).toEqual([{ cron: expect.stringMatching(/^\d+ \d+ \* \* \*$/) }]);
    const ran = executed({ kind: "schedule" });
    for (const name of [...REQUIRED_PR_CHECKS, ...shardNames("24"), ...shardNames("22")]) expect(ran.filter(one => one.endsWith(` / ${name}`)), name).toHaveLength(1);
    expect(ran.filter(one => !one.startsWith("nightly"))).toEqual([]);
    expect(reported({ kind: "schedule" }).filter(one => /macos/.test(one.runner)).map(one => one.name.replace(/^.* \/ /, "")).sort())
      .toEqual([...shardNames("24"), ...shardNames("22")].filter(name => name.includes("macos shard")).sort());
    expect(workflows.map(one => one.file)).not.toContain("macos.yml");
  });

  test("native attacks run or fail on every hosted unit shard: TOOLROLL_REQUIRE_NATIVE, and the join's verifier, by platform", () => {
    for (const file of ["ci.yml", "release-candidate.yml"]) {
      const one = workflow(file);
      for (const [shard, join, platform] of [["test-shard", "test", "linux"], ["macos-shard", "macos", "darwin"]] as const) {
        const suite = (one.jobs[shard]?.steps ?? []).find(step => (step.run ?? "").startsWith("npm run test:all"));
        expect(suite?.env, `${file} ${shard}`).toEqual({ CI: "true", TOOLROLL_REQUIRE_NATIVE: platform });
        expect(runsOf(one.jobs[join]!).at(-1)?.trimEnd(), `${file} ${join}`).toMatch(new RegExp(`--shards ${SHARDS} --native ${platform}$`));
      }
      expect(one.jobs["macos-shard"]?.["runs-on"]).toBe("macos-latest");
    }
    expect((workflow("ci.yml").jobs["linux-fence"]?.steps ?? []).find(step => step.run === "npm run test:attacks")?.env).toEqual({ CI: "true", TOOLROLL_REQUIRE_NATIVE: "linux" });
  });

  test("every pull-request job tests the candidate's head commit, not GitHub's merge commit, and proves it", () => {
    for (const file of ["ci.yml", "release-candidate.yml"]) {
      for (const [id, job] of Object.entries(workflow(file).jobs)) {
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
        // A trusted copy is the pull request's base, main on a dispatch, or the called commit (main's own, or the nightly's).
        for (const step of steps.filter(one => one.with?.["path"] === ".trusted-base")) {
          expect(step.with, `${file} ${id}`).toMatchObject({ ref: "${{ github.event.pull_request.base.sha || (github.event_name == 'workflow_dispatch' && 'main') || github.sha }}", "persist-credentials": false });
        }
      }
      // The shards' migration tests read old releases from history.
      expect(workflow(file).jobs["test-shard"]?.steps?.find(step => step.uses?.startsWith("actions/checkout@"))?.with?.["fetch-depth"]).toBe(0);
    }
  });

  test("the git lanes run the git tests on the declared floor and on 2.47, unprivileged, and refuse a skip", () => {
    // Two jobs with written-out names (a skipped matrix job reports its name unexpanded), otherwise identical.
    const lanes = workflow("ci.yml").jobs;
    expect(lanes["git-floor"]?.name).toBe(`git ${GIT_FLOOR_WORDS} · debian trixie`);
    expect(lanes["git-247"]?.name).toBe("git 2.47 · debian trixie");
    expect(lanes["git-floor"]?.strategy).toBeUndefined();
    expect(lanes["git-247"]?.strategy).toBeUndefined();
    // The same job but for its version and the floor's partial-clone step.
    const as247 = JSON.stringify({ ...lanes["git-floor"], name: "", steps: lanes["git-floor"]?.steps?.filter(step => !(step.run ?? "").includes("checkout-git-partial-clone"))}).replaceAll(GIT_FLOOR_WORDS, "2.47");
    expect(JSON.stringify({ ...lanes["git-247"], name: "" })).toBe(as247);
    expect(JSON.stringify(lanes["git-247"])).not.toContain("checkout-git-partial-clone");
    const job = lanes["git-floor"]!;
    expect(job.container).toEqual({ image: "node:22-trixie", options: "--init" });
    const runs = runsOf(job);
    expect(runs).toContain(`scripts/ci-git.sh ${GIT_FLOOR_WORDS}`);
    expect(runs.filter(run => /\bnpm (ci|run)\b|\bnode scripts\//.test(run)).every(run => run.startsWith("runuser -u node -- "))).toBe(true);
    expect(runs.some(run => run.includes("npm run test:git"))).toBe(true);
    expect(runs).toContain("runuser -u node -- node scripts/ci-no-skips.mjs git-lane.json");
    // The floor's git has no --no-lazy-fetch: its lane proves, by name, that a partial clone is refused there.
    const floor = (job.steps ?? []).find(step => (step.run ?? "").includes("checkout-git-partial-clone.test.ts"));
    expect(floor?.if).toBeUndefined();
    expect(floor?.run).toMatch(/^runuser -u node -- /);
  });

  test("pipeline-speed A: each required unit check joins every shard of its suite and fails unless all of them passed on the tested commit", () => {
    for (const [file, node] of [["ci.yml", "24"], ["release-candidate.yml", "22"]] as const) {
      const one = workflow(file);
      for (const [shardId, joinId, artifact, os] of [["test-shard", "test", "shard", "ubuntu"], ["macos-shard", "macos", "macos-shard", "macos"]] as const) {
        const shard = one.jobs[shardId]!, join = one.jobs[joinId]!;
        // ci.yml's Node comes from its matrix; Release candidate writes 22 out (a matrix value would be appended to the
        // join's required name, and a skipped matrix job reports its name unexpanded).
        const nodeRef = file === "ci.yml" ? "${{ matrix.node }}" : node;
        // Every shard, never failing fast (a cancelled shard proves nothing), nothing tolerated.
        expect(shard.strategy?.matrix, file).toEqual({ ...(file === "ci.yml" ? { node: [node] } : {}), shard: Array.from({ length: SHARDS }, (_, at) => at + 1) });
        expect((shard.strategy as { "fail-fast"?: unknown })["fail-fast"]).toBe(false);
        expect(join.strategy?.matrix).toEqual(file === "ci.yml" ? { node: [node] } : undefined);
        expect(join.needs).toBe(shardId);
        expect(checks(join, joinId, pr([]), file).map(check => check.name)).toEqual([`node ${node} · ${os}-latest`]);
        for (const job of [shard, join]) {
          expect(job["continue-on-error"] ?? false).toBe(false);
          for (const step of job.steps ?? []) { expect(step.if).toBeUndefined(); expect(step["continue-on-error"] ?? false).toBe(false); }
        }
        // Each shard runs the whole suite's command on its slice and uploads Vitest's own report, written outside the
        // checkout: no candidate script summarizes it (Codex review round 1, finding 1).
        expect(runsOf(shard)).toContain(`npm run test:all -- --shard=\${{ matrix.shard }}/${SHARDS} --reporter=default --reporter=json --outputFile.json="$RUNNER_TEMP/shard-report.json"`);
        expect(runsOf(shard)).toEqual(expect.arrayContaining(["npm ci", "npm run typecheck", "npm run build"]));
        expect(runsOf(shard).filter(run => run.includes("ci-shards"))).toEqual([]);
        expect(shard.steps?.find(step => step.uses?.startsWith("actions/upload-artifact@"))?.with).toMatchObject({ name: `${artifact}-${nodeRef}-\${{ matrix.shard }}`, path: "${{ runner.temp }}/shard-report.json", "if-no-files-found": "error" });
        expect(shard.steps?.find(step => step.uses?.startsWith("actions/checkout@"))?.with?.["fetch-depth"]).toBe(0);
        // The join: the shards' own result first, then their reports against the include policy, by the trusted base
        // revision's verifier. It installs and runs nothing of the candidate's.
        const steps = join.steps ?? [];
        const result = steps.findIndex(step => step.name === "Every shard passed");
        expect(result).toBeGreaterThan(steps.findIndex(step => step.name === "Tested commit"));
        expect(steps[result]?.env?.["SHARDS"]).toBe(`\${{ needs.${shardId}.result }}`);
        expect(steps[result]?.run).toMatch(/^test "\$SHARDS" = success \|\|/);
        expect(runsOf(join).filter(run => /\bnpm\b|\bnpx\b|vitest/.test(run))).toEqual([]);
        expect(steps.find(step => step.uses?.startsWith("actions/setup-node@"))?.with?.["cache"]).toBeUndefined();
        expect(steps.find(step => step.uses?.startsWith("actions/download-artifact@"))?.with?.["pattern"]).toBe(`${artifact}-${nodeRef}-*`);
        const verify = runsOf(join).at(-1)!;
        expect(verify).toContain("verifier=.trusted-base/scripts/ci-shards.mjs");
        expect(verify).toContain(`node "$verifier" verify "$RUNNER_TEMP/shards" --root "$GITHUB_WORKSPACE" --base "$GITHUB_WORKSPACE/.trusted-base" --sha "$TESTED_SHA" --node ${nodeRef} --shards ${SHARDS} --native`);
      }
      // macOS runs the same suite command as Linux.
      const suite = (job: Job) => runsOf(job).find(run => run.startsWith("npm run test:all"));
      expect(suite(one.jobs["macos-shard"]!)).toBe(suite(one.jobs["test-shard"]!));
    }
  });
});

describe("test-matrix: the documentation-only classifier (scripts/ci-scope.mjs)", () => {
  const entry = (status: string, ...paths: string[]) => ({ status, paths });
  test.each([
    // [what, event, branch, entries, lanes run]
    ["docs under docs/, the changelog and the readme", "pull_request", "fix-x", [entry("M", "docs/TESTING.md"), entry("A", "docs/plans/new.md"), entry("M", "CHANGELOG.md"), entry("M", "README.md")], false],
    ["a source file beside docs", "pull_request", "fix-x", [entry("M", "docs/a.md"), entry("M", "src/release.ts")], true],
    ["a non-Markdown file under docs/", "pull_request", "fix-x", [entry("A", "docs/diagram.svg")], true],
    ["a Markdown file outside docs/", "pull_request", "fix-x", [entry("M", "AGENTS.md")], true],
    ["a nested readme", "pull_request", "fix-x", [entry("M", "test/README.md")], true],
    ["a workflow", "pull_request", "fix-x", [entry("M", ".github/workflows/ci.yml")], true],
    ["a deleted doc", "pull_request", "fix-x", [entry("D", "docs/old.md")], true],
    ["a renamed doc, both names docs", "pull_request", "fix-x", [entry("R", "docs/a.md", "docs/b.md")], true],
    ["a copied doc", "pull_request", "fix-x", [entry("C", "docs/a.md", "docs/b.md")], true],
    ["a doc that changed type (a link)", "pull_request", "fix-x", [entry("T", "docs/a.md")], true],
    ["an unmerged doc", "pull_request", "fix-x", [entry("U", "docs/a.md")], true],
    ["a diff that couldn't be read", "pull_request", "fix-x", null, true],
    ["an empty diff", "pull_request", "fix-x", [], true],
    ["a release candidate's branch, docs only", "pull_request", "release-0.9.80", [entry("M", "CHANGELOG.md")], true],
    ["no branch name", "pull_request", "", [entry("M", "CHANGELOG.md")], true],
    ["a push", "push", "main", [entry("M", "CHANGELOG.md")], true],
    ["a schedule", "schedule", "", [entry("M", "CHANGELOG.md")], true],
    ["a dispatch", "workflow_dispatch", "fix-x", [entry("M", "CHANGELOG.md")], true],
  ] as const)("%s: lanes run = %s", (_, event, headRef, entries, runs) => {
    expect(areaLanes({ event, headRef, entries: entries === null ? null : entries.map(one => ({ ...one, paths: [...one.paths] })) }).run).toBe(runs);
  });

  test("documentation paths are exactly docs/**.md, CHANGELOG.md and README.md, with no dot segments", () => {
    for (const path of ["docs/a.md", "docs/plans/deep/b.md", "CHANGELOG.md", "README.md"]) expect(docsPath(path), path).toBe(true);
    for (const path of ["docs/../src/a.md", "docs/./a.md", "docs//a.md", "/docs/a.md", "Docs/a.md", "docs/a.MD", "docs/a.md.ts", "docs", "docs.md", "changelog.md", "src/README.md", "", "CHANGELOG.md/x"]) expect(docsPath(path), path).toBe(false);
  });

  test("git's name-status output parses whole or not at all", () => {
    expect(parseNameStatus("M\0docs/a.md\0R087\0docs/a.md\0docs/b.md\0D\0x\0")).toEqual([{ status: "M", paths: ["docs/a.md"] }, { status: "R", paths: ["docs/a.md", "docs/b.md"] }, { status: "D", paths: ["x"] }]);
    expect(parseNameStatus("")).toEqual([]);
    for (const raw of ["M\0docs/a.md", "R087\0docs/a.md\0", "Q\0docs/a.md\0", "M\0\0", "M docs/a.md\n", undefined]) expect(parseNameStatus(raw), JSON.stringify(raw)).toBeNull();
  });

  const dir = mkdtempSync(join(tmpdir(), "ci-scope-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  test("against real git: a rename, a deletion and a base it can't find run every lane; a doc edit doesn't", () => {
    const env = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    const git = (...args: string[]) => {
      const ran = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { cwd: dir, encoding: "utf8", env });
      if (ran.status !== 0) throw new Error(ran.stderr);
      return ran.stdout.trim();
    };
    git("init", "-q");
    writeFileSync(join(dir, "README.md"), "readme\n");
    const log = Array.from({ length: 40 }, (_, at) => `change ${at}\n`).join("");
    writeFileSync(join(dir, "CHANGELOG.md"), log);
    git("add", "-A"); git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    const decide = (head: string) => areaLanes({ event: "pull_request", headRef: "fix-x", entries: diffEntries(dir, base, head) });
    writeFileSync(join(dir, "CHANGELOG.md"), `${log}one more\n`);
    git("commit", "-qam", "docs");
    expect(decide(git("rev-parse", "HEAD"))).toMatchObject({ run: false });
    git("mv", "CHANGELOG.md", "README2.md"); git("commit", "-qm", "rename");
    expect(decide(git("rev-parse", "HEAD"))).toMatchObject({ run: true, why: expect.stringContaining("renamed") });
    git("reset", "-q", "--hard", base);
    git("rm", "-q", "README.md"); git("commit", "-qm", "delete");
    expect(decide(git("rev-parse", "HEAD"))).toMatchObject({ run: true, why: expect.stringContaining("deleted") });
    expect(areaLanes({ event: "pull_request", headRef: "fix-x", entries: diffEntries(dir, "f".repeat(40), git("rev-parse", "HEAD")) })).toMatchObject({ run: true, why: "the diff couldn't be read whole" });
    expect(diffEntries(dir, "not-a-sha", base)).toBeNull();
    // A plain copy must be identified even when its source was not edited.
    git("reset", "-q", "--hard", base);
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "docs/copied.md"), log);
    git("add", "-A"); git("commit", "-qm", "copy");
    expect.soft(decide(git("rev-parse", "HEAD"))).toMatchObject({ run: true, why: expect.stringContaining("copied") });
    // A real code edit cannot become docs-only through a replacement commit in the checkout's Git metadata.
    git("reset", "-q", "--hard", base);
    writeFileSync(join(dir, "code.js"), "export const changed = true;\n");
    git("add", "-A"); git("commit", "-qm", "code");
    const code = git("rev-parse", "HEAD");
    expect(decide(code)).toMatchObject({ run: true });
    git("reset", "-q", "--hard", base);
    writeFileSync(join(dir, "README.md"), "documentation only\n");
    git("commit", "-qam", "replacement");
    git("replace", code, git("rev-parse", "HEAD"));
    expect(decide(code)).toMatchObject({ run: true });
  });
});

describe("test-matrix: the release proof (scripts/release-proof.mjs)", () => {
  const REPO = "ap9000/toolroll", TAG = "a".repeat(40), HEAD = "b".repeat(40), TREE = "c".repeat(40), BRANCH = "release-0.9.80";
  const required = { ...REQUIRED_PR_CHECKS_WORKFLOW } as Record<string, string>;
  const binding = () => ({ number: 258, base: { ref: "main", repo: { url: `https://api.github.com/repos/${REPO}` } }, head: { sha: HEAD, ref: BRANCH, repo: { url: `https://api.github.com/repos/${REPO}` } } });
  type Run = { id: number; path: string; head_sha: string; head_branch: string; event: string; status: string; run_attempt: number; repository: { full_name: string }; head_repository: { full_name: string }; pull_requests: ReturnType<typeof binding>[] };
  const run = (id: number, path: string, extra: Partial<Run> = {}): Run => ({ id, path, head_sha: HEAD, head_branch: BRANCH, event: "pull_request", status: "completed", run_attempt: 1,
    repository: { full_name: REPO }, head_repository: { full_name: REPO }, pull_requests: [binding()], ...extra });
  type JobRecord = { name: string; run_id: number; head_sha: string; status: string; conclusion: string | null; completed_at?: string | null };
  const jobsFor = (id: number, path: string): JobRecord[] => Object.entries(required).filter(([, file]) => file === path).map(([name]) => ({ name, run_id: id, head_sha: HEAD, status: "completed", conclusion: "success", completed_at: "2026-10-29T23:59:00Z" }));
  const world = () => {
    const runs = [run(10, CI), run(11, RC)];
    return {
      repo: REPO, sha: TAG, required,
      commit: { sha: TAG, tree: { sha: TREE }, parents: [{ sha: "d".repeat(40) }] },
      pulls: [{ number: 258, merged_at: "2026-10-30T00:00:00Z" as string | null, merge_commit_sha: TAG, base: { ref: "main", repo: { full_name: REPO } }, head: { sha: HEAD, ref: BRANCH, repo: { full_name: REPO } } }],
      headCommit: { sha: HEAD, tree: { sha: TREE } },
      runs, runsTotal: runs.length,
      branchPulls: [{ number: 258, base: { ref: "main", repo: { full_name: REPO } }, head: { ref: BRANCH, repo: { full_name: REPO } } }],
      jobs: new Map<number, JobRecord[]>([[10, [...jobsFor(10, CI), { name: SCOPE, run_id: 10, head_sha: HEAD, status: "completed", conclusion: "success" }]], [11, jobsFor(11, RC)]]),
    };
  };
  type World = ReturnType<typeof world>;
  const setJob = (w: World, id: number, name: string, change: Partial<JobRecord>) => { w.jobs.set(id, w.jobs.get(id)!.map(job => job.name === name ? { ...job, ...change } : job)); };
  const addRun = (w: World, one: Run, jobs?: JobRecord[]) => { w.runs.push(one); w.runsTotal = w.runs.length; if (jobs !== undefined) w.jobs.set(one.id, jobs); };

  test("the tagged commit, squash-merged from a pull request whose head tree it is and on which every required check passed, is proven", () => {
    expect(proofProblem(world())).toBeNull();
  });

  test("after the merge GitHub empties each run's PR binding; the branch's one PR into main still binds it", () => {
    const w = world();
    for (const one of w.runs) one.pull_requests = [];
    expect(proofProblem(w)).toBeNull();
  });

  test.each([
    ["a run belongs to another PR on the same head and branch", (w: World) => { w.runs[0]!.pull_requests[0]!.number = 259; }, /pull request binding/],
    ["a run has no PR binding and its branch had another PR", (w: World) => { w.runs[0]!.pull_requests = []; w.branchPulls.push({ ...w.branchPulls[0]!, number: 259 }); }, /pull request binding/],
    ["a run has no PR binding and its branch's only PR went elsewhere", (w: World) => { w.runs[0]!.pull_requests = []; w.branchPulls[0]!.base.ref = "attacker-base"; }, /pull request binding/],
    ["a run has no PR binding and its branch's only PR is another", (w: World) => { w.runs[0]!.pull_requests = []; w.branchPulls[0]!.number = 259; }, /pull request binding/],
    ["a run has no PR binding and the branch's PRs can't be read", (w: World) => { w.runs[0]!.pull_requests = []; (w as { branchPulls: unknown }).branchPulls = undefined; }, /pull request binding/],
    ["a run has no PR binding and the branch's PRs are none", (w: World) => { w.runs[0]!.pull_requests = []; w.branchPulls = []; }, /pull request binding/],
    ["a run binds two PRs", (w: World) => { w.runs[0]!.pull_requests.push(binding()); }, /pull request binding/],
    ["a run belongs to a PR into an untrusted base", (w: World) => { w.runs[0]!.pull_requests[0]!.base.ref = "attacker-base"; }, /pull request binding/],
    ["a run's PR binding names another repository", (w: World) => { w.runs[0]!.pull_requests[0]!.base.repo.url = "https://api.github.com/repos/evil/toolroll"; }, /pull request binding/],
    ["a run's PR binding names another head", (w: World) => { w.runs[0]!.pull_requests[0]!.head.sha = "9".repeat(40); }, /pull request binding/],
    ["newest run has an invalid PR binding; older green must not stand", (w: World) => { addRun(w, run(20, CI, { pull_requests: [{ ...binding(), number: 259 }] }), jobsFor(20, CI)); }, /pull request binding/],
    ["checks first passed after an unchecked merge", (w: World) => { setJob(w, 10, "node 24 · ubuntu-latest", { completed_at: "2026-10-30T00:00:01Z" }); }, /before.*merged/],
    ["GitHub omitted when a check passed", (w: World) => { setJob(w, 10, "node 24 · ubuntu-latest", { completed_at: null }); }, /before.*merged/],
    ["no valid merge time", (w: World) => { w.pulls[0]!.merged_at = "not a date"; }, /merge time/],
    ["an empty required map", (w: World) => { w.required = {}; }, /no list/],
    ["duplicate run ids hide an incomplete list", (w: World) => { w.runs.push({ ...w.runs[0]! }); w.runsTotal++; }, /can't be read whole/],
    ["a malformed newest workflow run", (w: World) => { addRun(w, run(Number.NaN, CI), jobsFor(20, CI)); }, /can't be read whole/],
    ["no latest attempt number", (w: World) => { w.runs[0]!.run_attempt = 0; }, /attempt/],
    ["the tag isn't a squash merge", (w: World) => { w.commit.parents.push({ sha: "e".repeat(40) }); }, /isn't a squash merge/],
    ["GitHub describes another commit", (w: World) => { w.commit.sha = HEAD; }, /doesn't describe/],
    ["no merged pull request made it", (w: World) => { w.pulls = []; }, /no merged pull request/],
    ["the pull request isn't merged", (w: World) => { w.pulls[0]!.merged_at = null; }, /no merged pull request/],
    ["the pull request merged into another branch", (w: World) => { w.pulls[0]!.base.ref = "next"; }, /no merged pull request/],
    ["the pull request merged in another repository", (w: World) => { w.pulls[0]!.base.repo.full_name = "evil/toolroll"; }, /no merged pull request/],
    ["another commit is its merge", (w: World) => { w.pulls[0]!.merge_commit_sha = "f".repeat(40); }, /no merged pull request/],
    ["two pull requests claim it", (w: World) => { w.pulls.push({ ...w.pulls[0]!, number: 259 }); }, /2 merged pull requests/],
    ["the head is from a fork", (w: World) => { w.pulls[0]!.head.repo.full_name = "fork/toolroll"; }, /no head commit/],
    ["the head tree differs", (w: World) => { w.headCommit.tree.sha = "9".repeat(40); }, /isn't pull request #258's head tree/],
    ["the run list is cut short", (w: World) => { w.runsTotal = 101; }, /can't be read whole/],
    ["no ci.yml run", (w: World) => { w.runs = w.runs.filter(one => one.path !== CI); w.runsTotal = w.runs.length; }, /no \.github\/workflows\/ci\.yml run/],
    ["a ci.yml run on another commit only", (w: World) => { w.runs[0]!.head_sha = "9".repeat(40); }, /can't be read whole/],
    ["a ci.yml run for another branch only", (w: World) => { w.runs[0]!.head_branch = "elsewhere"; }, /no \.github\/workflows\/ci\.yml run/],
    ["a ci.yml run from a push only", (w: World) => { w.runs[0]!.event = "push"; }, /no \.github\/workflows\/ci\.yml run/],
    ["a ci.yml run by hand", (w: World) => { w.runs[0]!.event = "workflow_dispatch"; }, /no \.github\/workflows\/ci\.yml run/],
    ["a lookalike workflow's run", (w: World) => { w.runs[0]!.path = ".github/workflows/ci-copy.yml"; }, /no \.github\/workflows\/ci\.yml run/],
    ["a run in another repository", (w: World) => { w.runs[0]!.repository = { full_name: "evil/toolroll" }; }, /no \.github\/workflows\/ci\.yml run/],
    ["the newest ci.yml run is still going", (w: World) => { addRun(w, run(20, CI, { status: "in_progress" })); }, /hasn't finished/],
    ["the newest ci.yml run's jobs can't be read", (w: World) => { addRun(w, run(20, CI)); }, /jobs can't be read/],
    ["a newer ci.yml run failed what an older one passed", (w: World) => { addRun(w, run(20, CI), jobsFor(20, CI).map(job => job.name === "git 2.41 · debian trixie" ? { ...job, conclusion: "failure" } : job)); }, /git 2\.41 · debian trixie: failure/],
    ["a required check skipped (documentation-only lanes)", (w: World) => { setJob(w, 10, "Windows Job Object containment", { conclusion: "skipped" }); }, /Windows Job Object containment: skipped .*not a tested one/],
    ["Node 22 skipped (not a release-* branch)", (w: World) => { setJob(w, 11, "node 22 · macos-latest", { conclusion: "skipped" }); }, /node 22 · macos-latest: skipped/],
    ["Node 22 skipped on the pull request, then passed in a newer run by hand", (w: World) => { setJob(w, 11, "node 22 · ubuntu-latest", { conclusion: "skipped" }); addRun(w, run(12, RC, { event: "workflow_dispatch" }), jobsFor(12, RC)); }, /node 22 · ubuntu-latest: skipped/],
    ["a required check failed", (w: World) => { setJob(w, 10, "node 24 · macos-latest", { conclusion: "failure" }); }, /node 24 · macos-latest: failure/],
    ["a required check cancelled", (w: World) => { setJob(w, 10, "node 24 · ubuntu-latest", { conclusion: "cancelled" }); }, /cancelled/],
    ["a required check still running", (w: World) => { setJob(w, 10, "node 24 · ubuntu-latest", { status: "in_progress", conclusion: null }); }, /in_progress/],
    ["a required check missing", (w: World) => { w.jobs.set(10, w.jobs.get(10)!.filter(job => job.name !== "linux fence · sandbox-runtime")); }, /linux fence · sandbox-runtime: no jobs/],
    ["a required check twice", (w: World) => { w.jobs.set(10, [...w.jobs.get(10)!, { ...w.jobs.get(10)![0]! }]); }, /2 jobs of that name/],
    ["a job filed under another commit", (w: World) => { setJob(w, 10, "node 24 · ubuntu-latest", { head_sha: "9".repeat(40) }); }, /isn't on/],
    ["a job from another run", (w: World) => { setJob(w, 10, "node 24 · ubuntu-latest", { run_id: 99 }); }, /isn't on/],
    ["Node 22 from ci.yml instead of its own workflow", (w: World) => { w.runs = w.runs.filter(one => one.path !== RC); w.runsTotal = 1; w.jobs.set(10, [...w.jobs.get(10)!, ...jobsFor(10, RC)]); }, /no \.github\/workflows\/release-candidate\.yml run/],
  ] as const)("%s: not proven", (_, change, problem) => {
    const w = world();
    change(w);
    expect(proofProblem(w)).toMatch(problem);
  });

  // Exercise the real CLI and HTTP adapter, without a token, network or the person's GitHub setup.
  const apiScratch = mkdtempSync(join(tmpdir(), "release-proof-api-"));
  afterAll(() => rmSync(apiScratch, { recursive: true, force: true }));
  type Reply = { body?: unknown; status?: number; error?: string };
  type Replies = Record<string, Reply[]>;
  const apiWorld = (): Replies => {
    const w = world();
    return {
      [`git/commits/${TAG}`]: [{ body: w.commit }],
      [`commits/${TAG}/pulls?page=1`]: [{ body: w.pulls }],
      [`git/commits/${HEAD}`]: [{ body: w.headCommit }],
      [`compare/${HEAD}...${TAG}`]: [{ body: { base_commit: { sha: HEAD }, merge_base_commit: { sha: w.commit.parents[0]!.sha }, ahead_by: 1, commits: [{ sha: TAG }] } }],
      ["issues/258/timeline?page=1"]: [{ body: [] }],
      ["pulls?page=1"]: [{ body: w.branchPulls }],
      [`actions/runs?page=1`]: [{ body: { total_count: w.runs.length, workflow_runs: w.runs } }],
      ...Object.fromEntries([...w.jobs].map(([id, jobs]) => [`actions/runs/${id}/attempts/1/jobs?page=1`, [{ body: { total_count: jobs.length, jobs: jobs.map((job, at) => ({ id: id * 100 + at, ...job })) } }]])),
    };
  };
  const cli = (replies: Replies, command = "verify", extra: string[] = []) => {
    const fixture = join(apiScratch, "replies.json"), loader = join(apiScratch, "fetch.mjs");
    writeFileSync(fixture, JSON.stringify(replies));
    writeFileSync(loader, `import { readFileSync } from 'node:fs';
const replies = JSON.parse(readFileSync(process.env.PROOF_FIXTURE, 'utf8'));
globalThis.fetch = async (url, options) => {
  const u = new URL(url);
  if (u.origin !== 'https://api.github.com' || options.redirect !== 'error') throw new Error('unsafe API request');
  let key = u.pathname.replace('/repos/ap9000/toolroll/', '');
  if (u.searchParams.has('per_page')) key += '?page=' + (u.searchParams.get('page') || '1');
  const queue = replies[key];
  if (!queue?.length) throw new Error('unexpected API request: ' + key);
  const reply = queue.length > 1 ? queue.shift() : queue[0];
  if (reply.error) throw new Error(reply.error);
  return new Response(JSON.stringify(reply.body), { status: reply.status || 200, headers: { 'content-type': 'application/json' } });
};`);
    return spawnSync(process.execPath, ["--import", loader, "scripts/release-proof.mjs", command, "--repo", REPO, "--sha", TAG, "--required", JSON.stringify(required), ...extra], {
      cwd: join(import.meta.dirname, ".."), encoding: "utf8", env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: apiScratch, XDG_CONFIG_HOME: apiScratch, PROOF_FIXTURE: fixture, GITHUB_TOKEN: "synthetic-token" },
    });
  };
  test.each([
    ["all required jobs on the newest attempt", (_: Replies) => {}, true],
    ["after the merge: runs unbound, the branch's one PR into main", (r: Replies) => {
      r["actions/runs?page=1"] = [{ body: { total_count: 2, workflow_runs: world().runs.map(one => ({ ...one, pull_requests: [] })) } }];
    }, true],
    ["after the merge: runs unbound, the branch had a second PR", (r: Replies) => {
      r["actions/runs?page=1"] = [{ body: { total_count: 2, workflow_runs: world().runs.map(one => ({ ...one, pull_requests: [] })) } }];
      r["pulls?page=1"] = [{ body: [...world().branchPulls, { ...world().branchPulls[0]!, number: 259 }] }];
    }, false],
    ["the branch's pull requests can't be read", (r: Replies) => { r["pulls?page=1"] = [{ status: 500 }]; }, false],
    ["a rebase introduced several commits on main, not one squash", (r: Replies) => {
      r[`compare/${HEAD}...${TAG}`] = [{ body: { base_commit: { sha: HEAD }, merge_base_commit: { sha: "d".repeat(40) }, ahead_by: 2, commits: [{ sha: TREE }, { sha: TAG }] } }];
    }, false],
    ["the tested head did not contain the merge's parent", (r: Replies) => {
      r[`compare/${HEAD}...${TAG}`] = [{ body: { base_commit: { sha: HEAD }, merge_base_commit: { sha: TREE }, ahead_by: 1, commits: [{ sha: TAG }] } }];
    }, false],
    ["the ancestry API errors", (r: Replies) => { r[`compare/${HEAD}...${TAG}`] = [{ status: 500 }]; }, false],
    ["a retargeted PR can expose a weaker base verifier", (r: Replies) => { r["issues/258/timeline?page=1"] = [{ body: [{ event: "base_ref_changed" }] }]; }, false],
    ["the PR timeline is unreadable", (r: Replies) => { r["issues/258/timeline?page=1"] = [{ status: 403 }]; }, false],
    ["the run list errors", (r: Replies) => { r["actions/runs?page=1"] = [{ status: 500 }]; }, false],
    ["jobs cannot be read", (r: Replies) => { r["actions/runs/10/attempts/1/jobs?page=1"] = [{ error: "network unavailable" }]; }, false],
    ["a retry starts while jobs are read", (r: Replies) => {
      r["actions/runs?page=1"]!.push({ body: { total_count: 2, workflow_runs: [run(10, CI, { run_attempt: 2, status: "in_progress" }), run(11, RC)] } });
    }, false],
    ["a newer run starts while jobs are read", (r: Replies) => {
      r["actions/runs?page=1"]!.push({ body: { total_count: 3, workflow_runs: [...world().runs, run(12, CI, { status: "queued" })] } });
    }, false],
    ["an ambiguous merge hidden on page two", (r: Replies) => {
      const pull = world().pulls[0]!;
      r[`commits/${TAG}/pulls?page=1`] = [{ body: [pull, ...Array.from({ length: 99 }, (_, i) => ({ ...pull, number: 1000 + i, merge_commit_sha: HEAD }))] }];
      r[`commits/${TAG}/pulls?page=2`] = [{ body: [{ ...pull, number: 259 }] }];
    }, false],
    ["multiple pages of runs", (r: Replies) => {
      const runs = [...Array.from({ length: 99 }, (_, i) => run(1000 + i, ".github/workflows/other.yml")), ...world().runs];
      for (const page of [1, 2]) r[`actions/runs?page=${page}`] = [{ body: { total_count: runs.length, workflow_runs: runs.slice((page - 1) * 100, page * 100) } }];
    }, true],
    ["multiple pages of jobs", (r: Replies) => {
      const jobs = [...jobsFor(10, CI), ...Array.from({ length: 100 }, (_, i) => ({ ...jobsFor(10, CI)[0]!, name: `extra ${i}` }))].map((job, i) => ({ ...job, id: 1000 + i }));
      for (const page of [1, 2]) r[`actions/runs/10/attempts/1/jobs?page=${page}`] = [{ body: { total_count: jobs.length, jobs: jobs.slice((page - 1) * 100, page * 100) } }];
    }, true],
    ["a duplicate page cannot replace missing runs", (r: Replies) => {
      const runs = Array.from({ length: 100 }, (_, i) => run(1000 + i, CI));
      for (const page of [1, 2]) r[`actions/runs?page=${page}`] = [{ body: { total_count: 200, workflow_runs: runs } }];
    }, false],
  ] as const)("HTTP proof: %s", (_, change, passes) => {
    const replies = apiWorld(); change(replies);
    const result = cli(replies);
    expect(result.status === 0, result.stderr).toBe(passes);
  });

  test.each([
    ["lightweight tag", { type: "commit", sha: TAG }, {}, true],
    ["annotated tag", { type: "tag", sha: TREE }, { [`git/tags/${TREE}`]: [{ body: { sha: TREE, object: { type: "commit", sha: TAG } } }] }, true],
    ["moved tag, even to a commit with the same tree", { type: "commit", sha: HEAD }, {}, false],
    ["moved annotated tag", { type: "tag", sha: TREE }, { [`git/tags/${TREE}`]: [{ body: { sha: TREE, object: { type: "commit", sha: HEAD } } }] }, false],
    ["tag points at a tree", { type: "tree", sha: TAG }, {}, false],
    ["unreadable annotated tag", { type: "tag", sha: TREE }, { [`git/tags/${TREE}`]: [{ status: 403 }] }, false],
    ["tag cycle", { type: "tag", sha: TREE }, { [`git/tags/${TREE}`]: [{ body: { sha: TREE, object: { type: "tag", sha: TREE } } }] }, false],
  ] as const)("live tag: %s", (_, object, more, passes) => {
    const replies: Replies = { "git/ref/tags/v0.9.80": [{ body: { ref: "refs/tags/v0.9.80", object } }], ...more };
    const result = cli(replies, "tag", ["--tag", "v0.9.80"]);
    expect(result.status === 0, result.stderr).toBe(passes);
  });
  test.each([404, 403, 500])("a missing tag or API error (%s) refuses publication", status => {
    expect(cli({ "git/ref/tags/v0.9.80": [{ status }] }, "tag", ["--tag", "v0.9.80"]).status).not.toBe(0);
  });

  test("the required list must name only workflows the proof knows, and be whole", () => {
    expect(parseRequired(JSON.stringify(required))).toEqual(required);
    for (const text of ["", "[]", "{}", "null", JSON.stringify({ "node 24 · ubuntu-latest": ".github/workflows/other.yml" }), JSON.stringify({ " ": CI }), JSON.stringify({ x: 1 })]) expect(parseRequired(text), text).toBeNull();
    expect(proofProblem({ ...world(), required: null as unknown as Record<string, string> })).toMatch(/no list/);
    expect(proofProblem({ ...world(), sha: "nope" })).toMatch(/no repository or commit/);
  });

  test.each(["@evil.yml", "@evil.yaml", "@evil.yml@main", "@evil.yml@refs/pull/258/merge", "@"])("GitHub's workflow path may include its ref; reject ambiguous filename suffix %s", suffix => {
    const w = world();
    w.runs[0]!.path += "@refs/pull/258/merge";
    expect(proofProblem(w)).toBeNull();
    w.runs[0]!.path = `${CI}${suffix}`;
    expect(proofProblem(w)).not.toBeNull();
  });
});
