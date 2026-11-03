/**
 * Vitest's sequencer with timing-balanced shards (scripts/ci-timings.mjs, docs/plans/ci-speed.md): `--shard=i/K` takes
 * the files test/timings.json's plan gives shard i, instead of Vitest's hash split, and every run starts its longest
 * files first, so the last worker isn't left with a slow file at the end. It changes which files run where and when,
 * never which files run: the shards' join (scripts/ci-shards.mjs) still checks every file ran exactly once.
 */
import { relative, sep } from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";
// @ts-expect-error plain ESM script without declarations
import { planShards, readTimings, weightOf } from "../scripts/ci-timings.mjs";

const timings = readTimings();
const platform = process.platform === "darwin" ? "darwin" : "linux";

export default class TimedSequencer extends BaseSequencer {
  private file(spec: TestSpecification): string {
    return relative(this.ctx.config.root, spec.moduleId).split(sep).join("/");
  }

  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { index, count } = this.ctx.config.shard!;
    const { plan } = planShards(files.map(spec => this.file(spec)), timings, count, { platform }) as { plan: Map<string, number> };
    return files.filter(spec => plan.get(this.file(spec)) === index - 1);
  }

  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const weight = (spec: TestSpecification): number => weightOf(this.file(spec), timings, platform);
    return [...files].sort((a, b) => weight(b) - weight(a) || (this.file(a) < this.file(b) ? -1 : this.file(a) > this.file(b) ? 1 : 0));
  }
}
