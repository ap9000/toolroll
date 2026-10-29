/** Live facts extracted from the approved check's ordinary output. */
export const CHECK_SUITES = ["unit", "flows", "app"] as const;
export type CheckSuiteName = (typeof CHECK_SUITES)[number];
export type CheckSuiteState = "pending" | "running" | "passed" | "failed" | "unknown";

export type CheckSuiteProgress = {
  state: CheckSuiteState;
  passed: number;
  failed: number;
  skipped: number;
  total: number | null;
  /** Only when the journeys run in parallel groups: how many groups have passed or failed, of how many. */
  groups?: CheckGroupsProgress;
};

export type CheckGroupsProgress = { passed: number; failed: number; total: number };

export type CheckProgressSnapshot = {
  version: 1;
  final: boolean;
  line: string;
  suites: Record<CheckSuiteName, CheckSuiteProgress>;
};

const emptySuite = (): CheckSuiteProgress => ({ state: "pending", passed: 0, failed: 0, skipped: 0, total: null });

function cleanLine(value: string): string {
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "")
    .trim();
}

function safeCount(raw: string | undefined): number | null {
  if (raw === undefined || !/^[0-9]{1,9}$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function suiteWords(name: CheckSuiteName, suite: CheckSuiteProgress): string {
  const words = countWords(name, suite);
  return suite.groups === undefined ? words : `${words} · ${suite.groups.passed}/${suite.groups.total} groups`;
}

function countWords(name: CheckSuiteName, suite: CheckSuiteProgress): string {
  const completed = suite.passed + suite.failed + suite.skipped;
  if (suite.state === "passed") {
    const count = suite.total !== null && suite.skipped > 0 ? `${suite.passed}/${suite.total}` : String(suite.passed);
    return `${name} ✓ ${count}`;
  }
  if (suite.state === "failed") {
    return `${name} ✕ ${suite.failed}${suite.total === null ? "" : `/${suite.total}`}`;
  }
  if (suite.state === "running") return `${name} ${completed}${suite.total === null ? "" : `/${suite.total}`}`;
  if (suite.state === "unknown") return `${name} ?${completed === 0 ? "" : ` ${completed}`}`;
  return `${name} …`;
}

export function checkProgressLine(suites: Record<CheckSuiteName, CheckSuiteProgress>): string {
  return CHECK_SUITES.map(name => suiteWords(name, suites[name])).join(" · ");
}

/** A machine-only count line that is safe to send through a push provider. */
export function isCheckProgressLine(value: string): boolean {
  const suite = String.raw`(?:unit|flows|app) (?:…|\?(?: [0-9]{1,9})?|[0-9]{1,9}(?:\/[0-9]{1,9})?|✓ [0-9]{1,9}(?:\/[0-9]{1,9})?|✕ [0-9]{1,9}(?:\/[0-9]{1,9})?)(?: · [0-9]{1,9}\/[0-9]{1,9} groups)?`;
  return new RegExp(`^${suite}(?: · ${suite}){2}$`).test(value);
}

export function parseCheckProgressSnapshot(raw: string): CheckProgressSnapshot | null {
  try {
    const value = JSON.parse(raw) as Partial<CheckProgressSnapshot>;
    if (value.version !== 1 || typeof value.final !== "boolean" || typeof value.line !== "string" || !isCheckProgressLine(value.line) || value.suites === null || typeof value.suites !== "object") return null;
    const suites = {} as Record<CheckSuiteName, CheckSuiteProgress>;
    for (const name of CHECK_SUITES) {
      const suite = value.suites[name] as Partial<CheckSuiteProgress> | undefined;
      if (suite === undefined || !["pending", "running", "passed", "failed", "unknown"].includes(String(suite.state))) return null;
      if (![suite.passed, suite.failed, suite.skipped].every(one => Number.isSafeInteger(one) && Number(one) >= 0)) return null;
      if (suite.total !== null && (!Number.isSafeInteger(suite.total) || Number(suite.total) < 0)) return null;
      const completed = Number(suite.passed) + Number(suite.failed) + Number(suite.skipped);
      if (suite.total !== null && completed > Number(suite.total)) return null;
      if (value.final && (suite.state === "pending" || suite.state === "running")) return null;
      suites[name] = { state: suite.state as CheckSuiteState, passed: Number(suite.passed), failed: Number(suite.failed), skipped: Number(suite.skipped), total: suite.total === null ? null : Number(suite.total) };
      if (suite.groups !== undefined) {
        const groups = suite.groups as Partial<CheckGroupsProgress> | null;
        if (groups === null || typeof groups !== "object" || ![groups.passed, groups.failed, groups.total].every(one => Number.isSafeInteger(one) && Number(one) >= 0)) return null;
        if (Number(groups.passed) + Number(groups.failed) > Number(groups.total)) return null;
        suites[name].groups = { passed: Number(groups.passed), failed: Number(groups.failed), total: Number(groups.total) };
      }
    }
    if (checkProgressLine(suites) !== value.line) return null;
    return { version: 1, final: value.final, line: value.line, suites };
  } catch {
    return null;
  }
}

/**
 * Incrementally reads stdout and stderr. Each stream keeps its own partial
 * line so simultaneous journey output cannot splice two records together.
 */
export class CheckProgressTracker {
  private readonly suites: Record<CheckSuiteName, CheckSuiteProgress> = {
    unit: emptySuite(),
    flows: emptySuite(),
    app: emptySuite(),
  };
  private readonly buffers = { stdout: "", stderr: "" };
  private readonly events = new Set<string>();
  private last = "";
  private recognized = false;
  /** Each part's parallel journey run (scripts/e2e-parallel.mjs), by its release-check tag ("" for untagged output):
   * the scripted flows and app parts run at once, so one shared run would mix their groups. */
  private readonly parallels = new Map<string, ParallelRun>();

  constructor(private readonly update: (snapshot: CheckProgressSnapshot) => void) {}

  feed(chunk: string, stream: "stdout" | "stderr" = "stdout"): void {
    const joined = this.buffers[stream] + chunk;
    const lines = joined.split(/\n/);
    this.buffers[stream] = lines.pop() ?? "";
    for (const line of lines) this.read(line);
  }

  finish(): CheckProgressSnapshot | null {
    for (const stream of ["stdout", "stderr"] as const) {
      if (this.buffers[stream] !== "") this.read(this.buffers[stream]);
      this.buffers[stream] = "";
    }
    if (!this.recognized) return null;
    for (const name of CHECK_SUITES) {
      if (this.suites[name].state === "pending" || this.suites[name].state === "running") {
        this.suites[name].state = "unknown";
      }
    }
    return this.emit(true, true);
  }

  snapshot(final = false): CheckProgressSnapshot {
    const suites = Object.fromEntries(CHECK_SUITES.map(name => {
      const suite = { ...this.suites[name] };
      if (suite.groups !== undefined) suite.groups = { ...suite.groups };
      return [name, suite];
    })) as Record<CheckSuiteName, CheckSuiteProgress>;
    return { version: 1, final, line: checkProgressLine(suites), suites };
  }

  private emit(final = false, force = false): CheckProgressSnapshot {
    const snapshot = this.snapshot(final);
    const identity = JSON.stringify(snapshot);
    // Live progress is advisory: a snapshot the store would refuse (output read in a way that counted past a total) is
    // never handed on, so reading output can't break the check that prints it (release check 3264).
    if ((force || identity !== this.last) && parseCheckProgressSnapshot(identity) !== null) {
      this.last = identity;
      this.update(snapshot);
    }
    return snapshot;
  }

  private read(raw: string): void {
    const cleaned = cleanLine(raw);
    if (cleaned === "") return;
    // scripts/release-check.mjs streams each part's lines as they come, tagged `<part> | ` (partTag). The unit part and
    // the scripted journeys are read as their own output; the other parts (the build, the real-model journeys, the
    // upgrade path) count toward no suite here.
    const tagged = /^(typecheck|build|unit|flows|app|flows-real|app-real|upgrade) \| ?(.*)$/.exec(cleaned);
    if (tagged !== null && !["unit", "flows", "app"].includes(tagged[1]!)) return;
    const key = tagged === null ? "" : tagged[1]!;
    const line = tagged === null ? cleaned : tagged[2]!.trim();
    if (line === "") return;

    const testFiles = /\bTest Files\b(.+)$/.exec(line);
    if (testFiles !== null) {
      const tail = testFiles[1] ?? "";
      const passed = safeCount(/\b([0-9]+)\s+passed\b/.exec(tail)?.[1]) ?? 0;
      const failed = safeCount(/\b([0-9]+)\s+failed\b/.exec(tail)?.[1]) ?? 0;
      const total = safeCount(/\(([0-9]+)\)\s*$/.exec(tail)?.[1]) ?? passed + failed;
      if (passed + failed > 0 || total > 0) {
        this.recognized = true;
        this.suites.unit = { state: failed > 0 ? "failed" : "passed", passed, failed, skipped: Math.max(0, total - passed - failed), total };
        this.emit();
      }
      return;
    }
    // The unit part speaks only through its Vitest summary; a test's own print is never a journey's.
    if (key === "unit") return;

    // scripts/e2e-parallel.mjs: "Running 7 groups, at most 4 at once (12.0 GB available, about 400 MB each): console,
    // task, …" (before: "Running 7 groups at once: …"), then every group's lines as "[group] [app] …", then
    // "✅ group  3.1 min" per group and "N of M groups passed …".
    const starting = /^Running ([0-9]+) groups(?:, at most [0-9]+)? at once(?: \([^)]*\))?: (.+)$/.exec(line);
    if (starting !== null) {
      const total = safeCount(starting[1]);
      const names = starting[2]!.split(",").map(one => one.trim()).filter(one => one !== "");
      if (total !== null && names.length === total) this.parallels.set(key, { suite: null, total, groups: new Map(names.map(one => [one, emptyGroup()])) });
      return;
    }
    const parallel = this.parallels.get(key) ?? null;
    if (parallel !== null) {
      const exited = /^(✅|❌)\s+(\S+)\s+[0-9.]+ min$/.exec(line);
      const group = exited === null ? undefined : parallel.groups.get(exited[2]!);
      if (group !== undefined && parallel.suite !== null) {
        group.result = exited![1] === "✅" ? "passed" : "failed";
        this.summarize(parallel);
        return;
      }
      const summary = /^([0-9]+) of ([0-9]+) groups passed\b/.exec(line);
      if (summary !== null && parallel.suite !== null && safeCount(summary[2]) === parallel.total) {
        const passed = safeCount(summary[1]) ?? 0;
        this.summarize(parallel, passed === parallel.total);
        this.parallels.delete(key);
        return;
      }
    }
    const grouped = /^\[\s*([A-Za-z0-9_.-]+)\s*\]\s*\[(flows|app)\]\s*(.*)$/i.exec(line);
    if (grouped !== null && parallel !== null && parallel.groups.has(grouped[1]!)) {
      this.readGroup(parallel, grouped[1]!, grouped[2]!.toLowerCase() as "flows" | "app", grouped[3] ?? "");
      return;
    }

    const labeled = /^\s*\[(flows|app)\]\s*(.*)$/i.exec(line) ?? /^\s*(flows|app)\s*:\s*(.*)$/i.exec(line);
    if (labeled === null) return;
    this.recognized = true;
    const name = labeled[1]!.toLowerCase() as "flows" | "app";
    const body = labeled[2] ?? "";
    const totals = /\b([0-9]+)\s+passed\s*,\s*([0-9]+)\s+failed(?:\s*,\s*([0-9]+)\s+skipped)?\b/i.exec(body);
    if (totals !== null) {
      const passed = safeCount(totals[1]) ?? 0;
      const failed = safeCount(totals[2]) ?? 0;
      const skipped = safeCount(totals[3]) ?? 0;
      this.suites[name] = { state: failed > 0 ? "failed" : "passed", passed, failed, skipped, total: passed + failed + skipped };
      this.emit();
      return;
    }
    const fraction = /\b([0-9]+)\s*\/\s*([0-9]+)\b/.exec(body);
    if (fraction !== null) {
      const completed = safeCount(fraction[1]);
      const total = safeCount(fraction[2]);
      if (completed !== null && total !== null && completed <= total) {
        const current = this.suites[name];
        const passed = Math.max(current.passed, completed);
        if (passed + current.failed + current.skipped <= total) {
          this.suites[name] = { ...current, state: "running", passed, total };
          this.emit();
        }
      }
      return;
    }
    const event = /\b(PASS|FAIL|SKIP)\b/i.exec(body)?.[1]?.toUpperCase();
    if (event === undefined) return;
    const identity = `${name}:${event}:${body}`;
    if (this.events.has(identity)) return;
    this.events.add(identity);
    const current = this.suites[name];
    this.suites[name] = {
      ...current,
      state: event === "FAIL" ? "failed" : current.state === "failed" ? "failed" : "running",
      passed: current.passed + (event === "PASS" ? 1 : 0),
      failed: current.failed + (event === "FAIL" ? 1 : 0),
      skipped: current.skipped + (event === "SKIP" ? 1 : 0),
    };
    this.emit();
  }

  /** One group's journey line: count its events, and take its own totals line as that group's result. */
  private readGroup(parallel: ParallelRun, name: string, suite: "flows" | "app", body: string): void {
    if (parallel.suite !== null && parallel.suite !== suite) return;
    parallel.suite = suite;
    this.recognized = true;
    const group = parallel.groups.get(name)!;
    const totals = /\b([0-9]+)\s+passed\s*,\s*([0-9]+)\s+failed(?:\s*,\s*([0-9]+)\s+skipped)?\b/i.exec(body);
    if (totals !== null) {
      group.passed = safeCount(totals[1]) ?? 0;
      group.failed = safeCount(totals[2]) ?? 0;
      group.skipped = safeCount(totals[3]) ?? 0;
      group.total = group.passed + group.failed + group.skipped;
      group.result ??= group.failed > 0 ? "failed" : "passed";
      this.summarize(parallel);
      return;
    }
    const event = /^\s*(?:[0-9]+s\s+)?(PASS|FAIL|SKIP)\b/i.exec(body)?.[1]?.toUpperCase();
    if (event === undefined || group.total !== null) return;
    const identity = `${suite}:${name}:${event}:${body}`;
    if (this.events.has(identity)) return;
    this.events.add(identity);
    if (event === "PASS") group.passed += 1;
    else if (event === "FAIL") group.failed += 1;
    else group.skipped += 1;
    this.summarize(parallel);
  }

  /** The suite is the sum of its groups; its total is known once every group has reported one. */
  private summarize(parallel: ParallelRun, allPassed?: boolean): void {
    const name = parallel.suite;
    if (name === null) return;
    const groups = [...parallel.groups.values()];
    const sum = (pick: (group: GroupRun) => number) => groups.reduce((total, group) => total + pick(group), 0);
    const passedGroups = groups.filter(group => group.result === "passed").length;
    const failedGroups = groups.filter(group => group.result === "failed").length;
    const failed = sum(group => group.failed);
    const total = groups.every(group => group.total !== null) ? sum(group => group.total ?? 0) : null;
    const state: CheckSuiteState = allPassed === false || failed > 0 || failedGroups > 0 ? "failed"
      : allPassed === true || passedGroups === parallel.total ? "passed" : "running";
    this.suites[name] = {
      state,
      passed: sum(group => group.passed),
      failed,
      skipped: sum(group => group.skipped),
      total,
      groups: { passed: passedGroups, failed: failedGroups, total: parallel.total },
    };
    this.emit();
  }
}

type GroupRun = { passed: number; failed: number; skipped: number; total: number | null; result: "passed" | "failed" | null };
type ParallelRun = { suite: "flows" | "app" | null; total: number; groups: Map<string, GroupRun> };

const emptyGroup = (): GroupRun => ({ passed: 0, failed: 0, skipped: 0, total: null, result: null });
