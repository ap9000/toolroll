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

type Step = { run?: string; if?: unknown; "continue-on-error"?: unknown };
type Job = {
  name?: string; "runs-on": string; if?: unknown; needs?: string | string[]; "continue-on-error"?: unknown;
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

const running = (event: Event) => workflows.filter(one => triggered(one, event)).flatMap(one => Object.entries(one.jobs).flatMap(([id, job]) => checks(job, id)));
const names = (event: Event) => running(event).map(one => one.name).sort();

describe("the CI workflows", () => {
  test("a pull request runs Ubuntu on Node 22 and 24 plus the Linux and Windows containment jobs, and no macOS", () => {
    // No branch or path filter may omit required checks on a PR (including documentation-only changes).
    expect(workflows.find(one => one.file === "ci.yml")?.on["pull_request"]).toBeNull();
    const pr: Event = { kind: "pull_request", paths: ["src/release.ts"] };
    expect(names(pr)).toEqual([...REQUIRED_PR_CHECKS].sort());
    expect(running(pr).filter(one => /macos/.test(one.runner))).toEqual([]);
    expect(running(pr).filter(one => /ubuntu/.test(one.runner) && /^node /.test(one.name)).map(one => one.name).sort()).toEqual(["node 22 · ubuntu-latest", "node 24 · ubuntu-latest"]);
    expect(names({ kind: "pull_request", paths: ["README.md"] })).toEqual([...REQUIRED_PR_CHECKS].sort());
    expect(running(pr).find(one => one.name === "Windows Job Object containment")?.runner).toBe("windows-latest");
    expect(running(pr).find(one => one.name === "linux native containment · delegated cgroup v2")?.runner).toBe("ubuntu-latest");
    // The Windows repeat job only joins pull requests that touch Windows containment; it is never a required check.
    const windows = names({ kind: "pull_request", paths: ["src/containment.ts"] });
    expect(windows.filter(name => !(REQUIRED_PR_CHECKS as readonly string[]).includes(name))).toEqual(["Windows Job Object containment · c2 × ${{ inputs.runs || 20 }}"]);
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
    expect(macos.steps?.filter(step => step.run).map(step => step.run)).toEqual(["npm ci", "npm run typecheck", "npm run build", "npm test"]);
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
    expect(names({ kind: "push", branch: "main" })).toEqual([...REQUIRED_PR_CHECKS].sort());
    expect(names({ kind: "push", branch: "toolroll/simplify-release" })).toEqual([]);
  });

  test("no job runs behind a condition, so a skipped job can't stand in for a passing required check", () => {
    const conditional = workflows.flatMap(one => Object.entries(one.jobs).filter(([, job]) => job.if !== undefined).map(([id]) => `${one.file}: ${id}`));
    expect(conditional).toEqual([]);
  });
});
