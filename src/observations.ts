/** Focused observations are new evidence about an unchanged candidate. They
 * never replace the original gate or give an agent a new shell authority. */
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { Runner } from "./builder.js";
import type { Store } from "./store.js";
import { canonicalAcceptance } from "./scope.js";
import { readVerifiedArtifact, scanForSecrets, storeEvidence } from "./evidence.js";
import { readObservationRequest, type ObservationCase } from "./contracts/observation-request.js";

export const OBSERVATION_MAILBOX = "STANDING-ORDERS-OBSERVATIONS.json";
export const OBSERVATION_CAPTURE = "machine focused observations v1";
export const OBSERVATION_FILE = "REVIEW-OBSERVATIONS.json";
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const revision = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{40,64}$/.test(value);
const pathOkay = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 500 &&
  !value.startsWith("-") && !/[\\\u0000-\u0020\u007f:*?\[\]]/.test(value) && value.split("/").every(p => p !== "" && p !== "." && p !== "..");

export type ObservationBrief = {
  kind: "evidence-observation"; sourceTask: string; sourceRun: number; sourceScopeDigest: string;
  head: string; originalBase: string; unresolved: { id: string; statement: string; detail: string[] }[];
  gateDigest: string;
};
export function focusedTestCommandSupported(command: string): boolean {
  const parts = command.trim().split(/\s*&&\s*/);
  // Only simple argv joined by && can establish this narrower authority.
  // Quotes, expansion, substitutions, redirects and other shell syntax need
  // explicit support; text inside an echo/printf argument is not a command.
  if (parts.some(c => !/^[A-Za-z0-9_./=:-]+(?: +[A-Za-z0-9_./=:-]+)*$/.test(c))) return false;
  return parts.some(c => /^npm (?:test|run test)(?: -- (?:--run|--reporter=\w+|--no-file-parallelism)(?: (?:--run|--reporter=\w+|--no-file-parallelism))*)?$/.test(c));
}

export type { ObservationCase };

export function originalTaskBase(store: Store, taskId: string): string | null {
  const lineage = store.repairLineageOf(taskId);
  if (lineage.problem) return null;
  const ref = store.lookupRef(lineage.rootTask);
  const first = ref && store.runsFor(ref.id).filter(r => r.role === "builder" && r.branch && r.baseRevision).sort((a, b) => a.id - b.id)[0];
  return first?.branch ? store.firstBuilderBase(first.taskRef, first.branch) ?? first.baseRevision : null;
}

/** The existing sealed revision brief identifies this narrower kind of work.
 * A title, agent-authored mailbox, or handoff can never elect gate reuse. */
export function observationBrief(store: Store, root: string, taskRef: number): ObservationBrief | null {
  const ref = store.refById(taskRef);
  const source = store.revisionSourceOf(taskRef);
  if (!ref || !source) return null;
  const full = store.lookupRef(ref.externalId);
  const artifact = full?.revisionBriefArtifact ? store.getArtifact(full.revisionBriefArtifact) : null;
  if (!artifact) return null;
  const read = readVerifiedArtifact(root, artifact);
  if (!read.ok) throw Error("The observation brief no longer verifies.");
  const brief = JSON.parse(read.content.toString("utf8"));
  if (brief.kind !== "evidence-observation") return null;
  const parent = store.getRun(source.sourceRun), parentScope = store.getScope(source.sourceTask), scope = store.getScope(ref.externalId);
  if (!parent || !parentScope || !scope || brief.sourceRun !== parent.id || brief.sourceTask !== source.sourceTask ||
      brief.sourceScopeDigest !== parent.scopeDigest || parentScope.digest !== parent.scopeDigest ||
      !revision(brief.head) || brief.head !== parent.headRevision || !revision(brief.originalBase) ||
      brief.originalBase !== originalTaskBase(store, source.sourceTask) || !/^[0-9a-f]{64}$/.test(brief.gateDigest) ||
      JSON.stringify(canonicalAcceptance(scope.acceptance)) !== JSON.stringify(canonicalAcceptance(parentScope.acceptance)) ||
      !Array.isArray(brief.unresolved) || brief.unresolved.length === 0 ||
      brief.unresolved.some((row: { id: string }) => !parentScope.acceptance.some(c => c.id === row.id))) throw Error("The observation source, candidate or signed criteria changed.");
  return brief as ObservationBrief;
}

export function parseObservationCases(raw: string, ids: readonly string[]): ObservationCase[] {
  if (Buffer.byteLength(raw) > 16 * 1024) throw Error("The observation request is too large.");
  const parsed: unknown = JSON.parse(raw);
  const read = readObservationRequest(parsed);
  // A problem inside one observation is that observation's; anything else is the request's shape.
  if (!read.ok && read.issues.some(issue => !/^observations\[\d+\]/.test(issue.path))) throw Error("Use one to four focused test observations.");
  const bad = () => Error("An observation must name a requested criterion, base/head, one test file and one test name. Shell commands are not accepted.");
  if (!read.ok) throw bad();
  for (const item of read.value.observations) {
    if (!ids.includes(item.criterion) || !pathOkay(item.testPath) || !/\.(test|spec)\.[cm]?[jt]sx?$/.test(item.testPath) ||
        item.testName.trim() === "" || item.testName.length > 500 || /[\u0000-\u001f\u007f]/.test(item.testName)) throw bad();
  }
  // The cases as written: their key order is the receipt's, and two written in different orders are distinct, as before.
  const cases = (parsed as { observations: ObservationCase[] }).observations;
  if (new Set(cases.map(c => JSON.stringify(c))).size !== cases.length || ids.some(id => !cases.some(c => c.criterion === id))) throw Error("Every requested criterion needs a distinct observation.");
  return cases;
}

type TreeFile = { path: string; blob: string; executable: boolean };
function parseTree(text: string): TreeFile[] {
  if (!text.endsWith("\0") || Buffer.byteLength(text) > 4 * 1024 * 1024) throw Error("The complete source inventory is unavailable.");
  return text.slice(0, -1).split("\0").map(line => {
    const m = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/.exec(line);
    if (!m || !pathOkay(m[3])) throw Error("Observation snapshots require regular, normalized source files; links and submodules need separate setup.");
    return { path: m[3]!, blob: m[2]!, executable: m[1] === "100755" };
  });
}
function gitBlob(bytes: Buffer): string { return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"); }

export type ObservationEvidence = { artifact: number; sha256: string; content: string };
export function readObservationEvidence(store: Store, root: string, runId: number): ObservationEvidence | null {
  const found = store.artifactsFor(runId).filter(a => a.kind === "structured-output" && a.capture === OBSERVATION_CAPTURE);
  if (found.length === 0) return null;
  const artifact = found[0]!;
  if (found.length !== 1 || artifact.truncated || artifact.redacted || artifact.captureStatus !== "ok") throw Error("The focused observation inventory is incomplete.");
  const read = readVerifiedArtifact(root, artifact);
  if (!read.ok) throw Error("The focused observations no longer verify.");
  const receipt = JSON.parse(read.content.toString("utf8")), run = store.getRun(runId), brief = run ? observationBrief(store, root, run.taskRef) : null;
  if (!run || !brief || receipt.version !== 1 || receipt.run !== runId || receipt.head !== run.headRevision || receipt.head !== brief.head ||
      receipt.scopeDigest !== run.scopeDigest || receipt.sourceRun !== brief.sourceRun || receipt.originalBase !== brief.originalBase ||
      !Array.isArray(receipt.observations) || receipt.observations.length < 1 || receipt.observations.length > 4) throw Error("The observations no longer match this exact candidate and scope.");
  return { artifact: artifact.id, sha256: artifact.sha256, content: read.content.toString("utf8") };
}

/** The supplied runner applies the build's existing stop, custody, environment
 * and approved command timeout. Only fixed argv is constructed here. */
export async function collectObservations(store: Store, root: string, runId: number, worktree: string, brief: ObservationBrief,
  cases: readonly ObservationCase[], execute: Runner, now: () => Date): Promise<void> {
  const source = store.getRun(runId), ref = source && store.refById(source.taskRef);
  const command = ref?.repo ? store.liveVerifyCommand(ref.repo) : null;
  // This is deliberately a narrow first collector. Approval for npm test
  // does not authorize arbitrary shell text supplied by an agent or review.
  if (!source || !command || !focusedTestCommandSupported(command.command)) {
    throw Error("Focused collection requires an already approved npm test command.");
  }
  const call = async (file: string, args: string[], cwd: string) => {
    const result = await execute(file, args, { cwd, timeoutMs: command.timeoutMs, maxBuffer: 4 * 1024 * 1024 });
    if (result.notFound || result.timedOut || result.code !== 0) throw Error(`Observation preparation failed: ${file} (${result.code}).`);
    return result.stdout;
  };
  const headTree = parseTree(await call("git", ["ls-tree", "-rz", brief.head], worktree));
  const baseTree = parseTree(await call("git", ["ls-tree", "-rz", brief.originalBase], worktree));
  const changed = new Set((await call("git", ["diff", "--name-only", "-z", brief.originalBase, brief.head], worktree)).split("\0").filter(Boolean));
  const packageAt = async (rev: string) => JSON.parse(await call("git", ["show", `${rev}:package.json`], worktree));
  for (const rev of [brief.originalBase, brief.head]) {
    const pkg = await packageAt(rev);
    if (!/^vitest(?: run)?$/.test(pkg.scripts?.test ?? "") || pkg.scripts?.pretest || pkg.scripts?.posttest) throw Error("This project needs a supported focused test command; only a direct Vitest test script is currently supported.");
  }
  const headLock = headTree.find(f => f.path === "package-lock.json"), baseLock = baseTree.find(f => f.path === "package-lock.json");
  if (!headLock || headLock.blob !== baseLock?.blob || gitBlob(readFileSync(join(worktree, headLock.path))) !== headLock.blob) throw Error("The original and candidate dependency locks must match for this focused comparison.");
  const dependencyPath = realpathSync(join(worktree, "node_modules"));
  if (!lstatSync(join(dependencyPath, "vitest", "vitest.mjs")).isFile()) throw Error("The project's installed Vitest runner is unavailable.");
  const parent = join(root, String(runId)); mkdirSync(parent, { recursive: true });
  const scratch = mkdtempSync(join(parent, "observation-"));
  const observations: unknown[] = [];
  try {
    for (const [index, item] of cases.entries()) {
      const at = item.at === "base" ? brief.originalBase : brief.head, tree = item.at === "base" ? baseTree : headTree;
      const test = headTree.find(f => f.path === item.testPath);
      if (!test || (item.at === "base" && !changed.has(item.testPath))) throw Error("The baseline test overlay must be a test in the candidate's whole-task change set.");
      const snapshot = join(scratch, String(index)); mkdirSync(snapshot);
      const archive = join(scratch, `${index}.tar`);
      await call("git", ["archive", "--format=tar", `--output=${archive}`, at], worktree);
      await call("tar", ["-xf", archive, "-C", snapshot], worktree);
      if (item.at === "base") {
        const bytes = await call("git", ["show", `${brief.head}:${item.testPath}`], worktree);
        if (gitBlob(Buffer.from(bytes)) !== test.blob) throw Error("The complete candidate test bytes are unavailable.");
        mkdirSync(dirname(join(snapshot, item.testPath)), { recursive: true }); writeFileSync(join(snapshot, item.testPath), bytes);
      }
      const verifySnapshot = () => {
        for (const file of tree) {
          const path = join(snapshot, file.path), expected = file.path === item.testPath ? test.blob : file.blob;
          if (!lstatSync(path).isFile() || gitBlob(readFileSync(path)) !== expected) throw Error("The observation changed or lost a source file: " + file.path);
        }
        if (gitBlob(readFileSync(join(snapshot, item.testPath))) !== test.blob) throw Error("The observation test changed.");
      };
      verifySnapshot(); symlinkSync(dependencyPath, join(snapshot, "node_modules"), "junction");
      // Vitest treats its name filter as a regular expression. The manifest
      // supplies a literal name; also verify the actual selected identity so
      // a suffix, duplicate name or another matching file cannot stand in.
      const pattern = `(?:^| )${item.testName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
      const reportPath = join(scratch, `${index}.json`);
      const argv = [join(dependencyPath, "vitest", "vitest.mjs"), "run", item.testPath, "--testNamePattern", pattern,
        "--reporter=verbose", "--reporter=json", `--outputFile.json=${reportPath}`];
      const startedAt = now().toISOString();
      const result = await execute(process.execPath, argv, { cwd: snapshot, timeoutMs: command.timeoutMs, maxBuffer: 64 * 1024 });
      verifySnapshot();
      if (result.notFound || result.timedOut || result.code < 0 || result.code > 1 || Buffer.byteLength(result.stdout + result.stderr) > 48 * 1024) throw Error("The focused test did not produce complete bounded output.");
      const summary = stripVTControlCharacters(result.stdout + "\n" + result.stderr);
      if (!/Tests\s+[1-9]\d* (?:passed|failed)/.test(summary) || /No test files found|No tests found/.test(summary)) throw Error("The focused command did not execute a test.");
      if (!lstatSync(reportPath).isFile() || lstatSync(reportPath).size > 1024 * 1024) throw Error("The focused test identity report is unavailable or too large.");
      const report = JSON.parse(readFileSync(reportPath, "utf8"));
      type Selected = { path: string; title: string; fullName: string; status: string };
      const selected: Selected[] = (report.testResults ?? []).flatMap((file: { name: string; assertionResults: Omit<Selected, "path">[] }) =>
        (file.assertionResults ?? []).filter(test => test.status === "passed" || test.status === "failed").map(test =>
          ({ path: file.name, title: test.title, fullName: test.fullName, status: test.status })));
      const selectedTest = selected[0];
      if (selected.length !== 1 || !selectedTest || realpathSync(selectedTest.path) !== realpathSync(join(snapshot, item.testPath)) ||
          (selectedTest.title !== item.testName && selectedTest.fullName !== item.testName) ||
          (selectedTest.status === "passed" ? result.code !== 0 : result.code !== 1)) throw Error("The focused command did not execute exactly the requested test.");
      observations.push({ ...item, revision: at, testBlob: test.blob, testSha256: sha(readFileSync(join(snapshot, item.testPath))),
        selectedTest: { ...selectedTest, path: item.testPath },
        overlay: item.at === "base" ? [item.testPath] : [], lockBlob: headLock.blob, command: [process.execPath, ...argv],
        approvedCommand: { id: command.id, digest: command.digest }, startedAt, finishedAt: now().toISOString(),
        exitCode: result.code, stdout: result.stdout, stderr: result.stderr, sourceFilesVerified: tree.length });
    }
    const bytes = JSON.stringify({ version: 1, run: runId, head: brief.head, originalBase: brief.originalBase,
      sourceRun: brief.sourceRun, scopeDigest: source.scopeDigest, observations }, null, 1);
    if (Buffer.byteLength(bytes) > 64 * 1024 || scanForSecrets(bytes).length) throw Error("The observations exceed storage limits or contain sensitive output; no incomplete evidence was accepted.");
    storeEvidence(store, root, runId, "structured-output", "observations.json", Buffer.from(bytes), OBSERVATION_CAPTURE, now(), { captureStatus: "ok" });
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
