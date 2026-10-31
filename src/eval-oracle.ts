/**
 * The eval set's trusted oracle (docs/plans/evals-nightly.md, part C, "Grading: a trusted oracle outside the fence").
 *
 * The plane's runner starts the oracle as a separate process from the installed release (`runOracle`, which spawns
 * eval-oracle-main.js), only after the attempt's whole process tree is gone, and hands it two folders: the installed
 * case (`evals/cases/<id>/`, from the plane's own package) and the graded files the runner extracted from the built
 * commit's verified Git objects. The oracle owns the grading (`gradeCase`):
 *
 *   1. It copies only the case's named files from the graded folder into a fresh grading folder, reading each with
 *      O_NOFOLLOW and refusing links and anything but a regular file; then the case's own `probe.mjs` from the
 *      installed case (an edited launcher in the build is never the one run).
 *   2. It starts the probe with the installed node and a fixed argv inside the native fence (the release check's:
 *      Seatbelt or bubblewrap via the agent fence), writing only the grading folder, with no network and the installed
 *      eval set and the plane's state unreadable, under a time limit.
 *   3. It sends a fresh nonce and inputs it chose from that nonce, reads at most 64 KiB of output, and passes the
 *      attempt only when the output names that nonce with the values it computed itself (`oracle.mjs` `expected`).
 *      An exit code alone never passes: an early `process.exit(0)` leaves no answer.
 *
 * The build's code never runs in the oracle's own process, and nothing the build wrote (a result file, a verdict) is
 * ever read as one: the verdict travels from the oracle to the runner over the oracle's own pipe.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, lstatSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkLaunchRoot, fenceFor, linuxFenceAvailable, macosFenceAvailable, runFolders, type NetworkFence } from "./agent-fence.js";
import { startEgressProxy, proxyEnv } from "./egress.js";
import { run, OVERFLOW_CODE } from "./exec.js";
import { readNoFollow } from "./eval-gate.js";

export type OracleVerdict = { outcome: "pass" | "fail" | "error"; why: string | null };
/** A case's hidden check (`oracle.mjs`): the files it grades, inputs chosen from a seeded random source, and the
 * answer it computes itself for each. */
export type CaseOracle = { files: readonly string[]; inputs: (random: () => number) => unknown[]; expected: (input: unknown) => unknown };

/** The most a graded program may print, and the most of each graded file the oracle copies. */
export const ORACLE_OUTPUT_BYTES = 64 * 1024;
const GRADED_FILE_BYTES = 256 * 1024;
const EVALS_ROOT = fileURLToPath(new URL("../evals/", import.meta.url));

/** A random source seeded by the nonce (mulberry32 over its digest): the inputs are fresh for every grading. */
export function seededRandom(nonce: string): () => number {
  let state = createHash("sha256").update(nonce).digest().readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One value in a canonical form (object keys sorted), so two answers compare by content. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => inner !== null && typeof inner === "object" && !Array.isArray(inner)
    ? Object.fromEntries(Object.keys(inner as Record<string, unknown>).sort().map(key => [key, (inner as Record<string, unknown>)[key]]))
    : inner);
}

/** How the graded program is started: inside the native fence by default; a test may only ever narrow it. */
export type GradeRunner = (input: { cwd: string; stdin: string; timeoutMs: number; deny: readonly string[] }) => Promise<{ code: number; stdout: string; timedOut: boolean }>;

/** The default: the installed node, `probe.mjs`, inside the release check's fence — writes only the grading folder, no
 * network (a proxy of its own that allows no host), the installed eval set and whatever else `deny` names unreadable. No
 * fence on this machine: nothing is graded (the attempt is an error, never a pass). */
export const fencedGradeRunner: GradeRunner = async ({ cwd, stdin, timeoutMs, deny }) => {
  if (!macosFenceAvailable() && !linuxFenceAvailable()) throw new Error("this machine can't fence the graded program");
  const egress = await startEgressProxy({ hosts: [] });
  try {
    const network: NetworkFence = { mode: "allowlist", proxyPort: egress.port, brokerPorts: [], loopback: "proxy-only", socketRoots: [cwd], token: egress.secret };
    const launch = fenceFor("check", { databaseFile: null, worktree: cwd, boundary: null, binding: null, runFolders: runFolders(null), poolRoots: [], extra: [...deny],
      writes: { writes: { subpaths: [cwd], prefixes: [] }, readOnly: [] }, network });
    const result = await run(process.execPath, ["probe.mjs"], { cwd, stdin, timeoutMs, maxBuffer: ORACLE_OUTPUT_BYTES, processGroup: true, envAllowlist: ["PATH"],
      env: { ...proxyEnv(egress, "proxy-only"), HOME: cwd, TMPDIR: cwd }, fence: launch.fence, fenceGrants: launch.fenceGrants, confinement: "required" });
    return { code: result.code, stdout: result.stdout, timedOut: result.timedOut };
  } finally { await egress.close(); }
};

/** Copy a file the oracle trusts nothing about: a regular file, never through a link, bounded; into a path that must
 * not exist yet. */
function copyIn(from: string, to: string, maxBytes: number): string | null {
  const bytes = readNoFollow(from, maxBytes);
  if (bytes === null) {
    try { return lstatSync(from).isSymbolicLink() ? "is a link, not a file" : "isn't a regular file it can read"; } catch { return "is missing"; }
  }
  mkdirSync(dirname(to), { recursive: true });
  const fd = openSync(to, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeSync(fd, bytes); } finally { closeSync(fd); }
  return null;
}

const inside = (root: string, path: string): boolean => { const rel = relative(root, path); return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel); };

/** Grade one attempt, in the oracle's own process. `caseDir` must be a case of the installed eval set (`evalsRoot`). */
export async function gradeCase(input: { caseDir: string; inputDir: string; timeoutMs: number; evalsRoot?: string; runner?: GradeRunner; deny?: readonly string[] }): Promise<OracleVerdict> {
  const evalsRoot = realpathSync(input.evalsRoot ?? EVALS_ROOT);
  let caseDir: string, inputDir: string;
  try {
    caseDir = realpathSync(input.caseDir);
    inputDir = realpathSync(input.inputDir);
    if (!inside(evalsRoot, caseDir) || lstatSync(input.caseDir).isSymbolicLink()) return { outcome: "error", why: "the case isn't one of the installed eval set" };
    if (lstatSync(input.inputDir).isSymbolicLink() || !lstatSync(inputDir).isDirectory()) return { outcome: "error", why: "the graded folder isn't a folder" };
  } catch { return { outcome: "error", why: "the case or the graded folder can't be read" }; }
  for (const name of ["oracle.mjs", "probe.mjs"]) {
    try { if (!lstatSync(join(caseDir, name)).isFile()) return { outcome: "error", why: `the case's ${name} isn't a file` }; } catch { return { outcome: "error", why: `the case has no ${name}` }; }
  }
  let oracle: CaseOracle;
  try { oracle = await import(pathToFileURL(join(caseDir, "oracle.mjs")).href) as CaseOracle; } catch { return { outcome: "error", why: "the case's oracle can't be loaded" }; }
  if (!Array.isArray(oracle.files) || typeof oracle.inputs !== "function" || typeof oracle.expected !== "function") return { outcome: "error", why: "the case's oracle is malformed" };
  const grading = realpathSync(mkdtempSync(join(checkLaunchRoot(), "so-eval-grade-")));
  try {
    for (const file of oracle.files) {
      if (typeof file !== "string" || file === "probe.mjs" || file.split("/").some(part => part === "" || part === "." || part === "..") || isAbsolute(file)) return { outcome: "error", why: "the case's oracle names a file it can't grade" };
      const problem = copyIn(join(inputDir, ...file.split("/")), join(grading, ...file.split("/")), GRADED_FILE_BYTES);
      if (problem !== null) return { outcome: "fail", why: `the build's ${file} ${problem}` };
    }
    const probeProblem = copyIn(join(caseDir, "probe.mjs"), join(grading, "probe.mjs"), GRADED_FILE_BYTES);
    if (probeProblem !== null) return { outcome: "error", why: `the case's probe ${probeProblem}` };
    const nonce = randomBytes(16).toString("hex");
    let inputs: unknown[], expected: string[];
    try {
      inputs = oracle.inputs(seededRandom(nonce));
      expected = inputs.map(one => canonical(oracle.expected(structuredClone(one))));
    } catch { return { outcome: "error", why: "the case's oracle failed to work out its answers" }; }
    let ran: Awaited<ReturnType<GradeRunner>>;
    try {
      ran = await (input.runner ?? fencedGradeRunner)({ cwd: grading, stdin: `${JSON.stringify({ nonce, inputs })}\n`, timeoutMs: input.timeoutMs,
        deny: [evalsRoot, inputDir, ...(input.deny ?? [])] });
    } catch (error) { return { outcome: "error", why: `the graded program couldn't be started: ${error instanceof Error ? error.message.slice(0, 160) : String(error)}` }; }
    if (ran.timedOut) return { outcome: "fail", why: "the graded program timed out" };
    if (ran.code === OVERFLOW_CODE) return { outcome: "fail", why: `the graded program printed more than ${ORACLE_OUTPUT_BYTES} bytes` };
    // The answer: a line naming this grading's nonce, with one output per input. The last such line counts.
    let outputs: unknown[] | null = null;
    for (const line of ran.stdout.slice(0, ORACLE_OUTPUT_BYTES).split("\n")) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed !== null && parsed["nonce"] === nonce && Array.isArray(parsed["outputs"])) outputs = parsed["outputs"] as unknown[];
      } catch { /* not the answer */ }
    }
    if (outputs === null) return { outcome: "fail", why: ran.code === 0 ? "the graded program exited without an answer (an exit code alone never passes)" : "the graded program crashed without an answer" };
    if (outputs.length !== expected.length) return { outcome: "fail", why: "the graded program answered a different number of inputs" };
    const wrong = expected.findIndex((one, index) => canonical(outputs![index]) !== one);
    return wrong === -1 ? { outcome: "pass", why: null } : { outcome: "fail", why: `wrong answer for input ${wrong + 1} of ${expected.length}` };
  } finally { rmSync(grading, { recursive: true, force: true }); }
}

/** The oracle process's entry file, from the installed release (the sources under a test). */
export function oracleEntry(): { file: string; args: string[] } {
  const source = import.meta.url.endsWith(".ts");
  const entry = fileURLToPath(new URL(source ? "./eval-oracle-main.ts" : "./eval-oracle-main.js", import.meta.url));
  return { file: process.execPath, args: [...(source ? ["--import", import.meta.resolve("tsx")] : []), entry] };
}

/**
 * Grade in a separate process from the installed release (the plane's runner calls this once the attempt's process
 * tree is gone). Its verdict comes back over its own stdout; anything else — it crashed, timed out, said nothing
 * readable — is an error the plane recorded, never a pass.
 */
export async function runOracle(input: { caseDir: string; inputDir: string; timeoutMs: number; deny?: readonly string[] }, entry: { file: string; args: string[] } = oracleEntry()): Promise<OracleVerdict> {
  const child = spawn(entry.file, entry.args, { stdio: ["pipe", "pipe", "ignore"], env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: process.env["HOME"] ?? "/" }, detached: true });
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => { if (stdout.length < 16 * 1024) stdout += chunk.toString("utf8"); });
  child.stdin.end(`${JSON.stringify({ caseDir: input.caseDir, inputDir: input.inputDir, timeoutMs: input.timeoutMs, deny: input.deny ?? [] })}\n`);
  const code = await new Promise<number | null>(done => {
    const timer = setTimeout(() => { try { process.kill(-(child.pid ?? 0), "SIGKILL"); } catch { /* gone */ } }, input.timeoutMs + 60_000);
    child.once("error", () => { clearTimeout(timer); done(null); });
    child.once("close", exit => { clearTimeout(timer); done(exit); });
  });
  try {
    const parsed = JSON.parse(stdout.trim().split("\n").pop() ?? "") as Record<string, unknown>;
    const outcome = parsed["outcome"];
    if (code === 0 && (outcome === "pass" || outcome === "fail" || outcome === "error")) return { outcome, why: typeof parsed["why"] === "string" ? parsed["why"].slice(0, 300) : null };
  } catch { /* below */ }
  return { outcome: "error", why: "the oracle process failed" };
}
