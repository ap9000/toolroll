/**
 * Code in flows (v90): the project's scripts — shell, Python or Node, written
 * in the library or a file already in the project — run with no AI.
 *
 * - The script gets the card: as JSON on stdin and in the file $FLOW_INPUT
 *   (its title, details, email, note, owner, where it came from, and what
 *   every earlier zone produced), with a few plain variables beside it.
 *   Card text reaches it only as data, never as part of a command.
 * - What it prints is the step's result: later zones use it as
 *   {{stage.<zone>}}. A last line "goto: <answer>" picks the zone the card
 *   goes to next, from the zone's answers.
 * - Secrets the zone names come from the flow's saved secrets as
 *   environment variables; their values never reach the output or the log.
 * - It runs inside the same fence as agents (Toolroll's own state and
 *   keys are out of reach), under a time limit, with the setup's plain
 *   environment rather than this process's.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Runner } from "./backend.js";
import { buildCacheEnv, buildCacheFolder, checkLaunchRoot, fenceFor, linuxFenceAvailable, macosFenceAvailable, runFolders, taskBoundary, trustedWorktreeBinding, writeAllowlist, type FencePolicy, type LaunchFence } from "./agent-fence.js";
import type { FlowScriptRow, Store } from "./store.js";
import { readDenyPath } from "./project-sandbox.js";
import { poolRootOf } from "./worktree.js";
import { SETUP_ENV_ALLOWLIST, SETUP_ENV_DENYLIST } from "./builder.js";
import { redactSecretLines, scanForSecrets } from "./evidence.js";
import { scrubSecrets } from "./flow-secrets.js";
import { TEXT_LIMITS } from "./text-limits.js";
import { projectFile } from "./project-file.js";

export { projectFile };

import { LANGUAGE_WORDS, type ScriptLanguage } from "./flows.js";
export { LANGUAGE_WORDS, SCRIPT_LANGUAGES, type ScriptLanguage } from "./flows.js";
const EXTENSION: Record<ScriptLanguage, string> = { shell: "sh", python: "py", node: "mjs" };
/** A step's result on the card: what the script printed, up to what a step passes on (the end, when longer; the whole
 * is in the step's log). */
export const CODE_OUTPUT_CHARS = TEXT_LIMITS.stageOutput;
const LOG_CHARS = 64_000;

/** How a file runs in each language: sh, Python 3, and the Node this app runs on. */
function runtimeOf(language: ScriptLanguage, file: string): { file: string; args: string[] } {
  return language === "python" ? { file: "python3", args: [file] } : language === "node" ? { file: process.execPath, args: [file] } : { file: "/bin/sh", args: [file] };
}

export type CodeRun = {
  script: FlowScriptRow;
  /** Where it runs, and the project folder a file script is found in. */
  cwd: string; root: string;
  /** JSON on stdin and in $FLOW_INPUT. */
  input: unknown;
  env: Record<string, string>;
  secrets: Record<string, string>;
  scratch: string;
  shell: Runner;
  /** Where it runs from (flowLaunch): its fence, and the launch folder its input and an inline script are written to;
   * null only where there is nothing to fence (a store with no database file). */
  launch: FlowLaunch | null;
};
/** `printed`: everything it printed (secrets blanked), for a trigger to read items from; `output` is what a card keeps. */
export type CodeResult = { state: "passed" | "failed"; exitCode: number | null; output: string; printed: string; goTo: string | null; log: string; said: string };

/** What it printed, without key-shaped lines or saved secrets, and the goto line taken off the end. */
export function codeOutput(stdout: string, secrets: Record<string, string>): { output: string; goTo: string | null } {
  const clean = scrubSecrets(stdout.replace(/\r\n?/g, "\n"), secrets);
  const lines = clean.replace(/\s+$/, "").split("\n");
  const last = lines.at(-1) ?? "";
  const goto = /^goto:\s*(.{1,40})$/i.exec(last.trim());
  // Whole: the step passes it on whole up to CODE_OUTPUT_CHARS, and attaches longer to the card, linked (flow-steps settle).
  const body = (goto === null ? lines : lines.slice(0, -1)).join("\n").trim();
  return { output: redactSecretLines(body, scanForSecrets(body)), goTo: goto === null ? null : goto[1]!.trim() };
}

/** Run one script once, with the card as its input. */
export async function runCode(run: CodeRun): Promise<CodeResult> {
  const { script } = run;
  const language = script.language;
  const tag = randomBytes(6).toString("hex");
  mkdirSync(run.scratch, { recursive: true });
  // The input and an inline script live in the launch's own folder, the one place beside its working folder its fence
  // gives back (every other launch folder, and every other flow copy in the scratch pool, stay out of reach).
  const files = run.launch?.folder ?? run.scratch;
  const inputFile = join(files, `flow-input-${tag}.json`);
  let scriptFile: string | null = null;
  try {
    writeFileSync(inputFile, JSON.stringify(run.input), { mode: 0o600 });
    if (script.file !== null) {
      scriptFile = projectFile(run.root, script.file);
      if (scriptFile === null) return { state: "failed", exitCode: null, output: "", printed: "", goTo: null, log: "", said: `${script.name} runs ${script.file}, which isn't a file in the project.` };
    } else {
      const own = join(files, `flow-script-${tag}.${EXTENSION[language]}`);
      writeFileSync(own, `${script.body}\n`, { mode: 0o700 });
      chmodSync(own, 0o700);
      scriptFile = own;
    }
    const runtime = runtimeOf(language, scriptFile);
    // The card goes in on stdin from its file (never a pipe): a script that doesn't read it can finish
    // first without breaking anything. Only our own paths are in the command; the card is only data.
    const ran = await run.shell("/bin/sh", ["-c", 'exec "$@" < "$FLOW_INPUT"', "flow-script", runtime.file, ...runtime.args], {
      cwd: run.cwd, timeoutMs: script.timeoutMinutes * 60_000, envAllowlist: SETUP_ENV_ALLOWLIST, omitEnv: SETUP_ENV_DENYLIST, processGroup: true,
      env: { ...run.env, ...run.secrets, ...(run.launch?.env ?? {}), FLOW_INPUT: inputFile }, ...(run.launch?.fence ?? {}),
    });
    const printed = codeOutput(ran.stdout, run.secrets);
    const all = scrubSecrets(ran.stdout.slice(0, 1_000_000), run.secrets);
    const both = scrubSecrets(`${ran.stdout}${ran.stderr === "" ? "" : `\n${ran.stderr}`}`, run.secrets);
    const log = `$ ${script.name} (${LANGUAGE_WORDS[language]}, version ${script.version}${script.file === null ? "" : `, ${script.file}`})\n${both.length <= LOG_CHARS ? both : both.slice(-LOG_CHARS)}`;
    if (ran.timedOut) return { state: "failed", exitCode: null, output: printed.output, printed: all, goTo: null, log, said: `${script.name} ran out of time after ${script.timeoutMinutes} minute${script.timeoutMinutes === 1 ? "" : "s"}.` };
    if (ran.notFound) return { state: "failed", exitCode: null, output: "", printed: all, goTo: null, log, said: `${script.name} couldn't start: no shell was found.` };
    // 127: the shell couldn't find the language's program.
    if (ran.code === 127 && language === "python" && /python3/.test(ran.stderr)) return { state: "failed", exitCode: 127, output: "", printed: all, goTo: null, log, said: "Python 3 isn't installed on this computer, so the script couldn't run." };
    if (ran.code !== 0) {
      const end = scrubSecrets([ran.stdout.trim(), ran.stderr.trim()].filter(one => one !== "").join("\n"), run.secrets).slice(-600);
      return { state: "failed", exitCode: ran.code, output: printed.output, printed: all, goTo: null, log,
        said: `${script.name} failed (exit ${ran.code}).${end === "" ? "" : `\n${scanForSecrets(end).length > 0 ? "(Its output held something that looked like a key, so it isn't shown.)" : end}`}` };
    }
    return { state: "passed", exitCode: 0, output: printed.output, printed: all, goTo: printed.goTo, log, said: `${script.name} ran.` };
  } finally {
    rmSync(inputFile, { force: true });
    if (script.file === null && scriptFile !== null && existsSync(scriptFile)) rmSync(scriptFile, { force: true });
  }
}

/** A clean folder to run in, made fresh for one run. */
export function cleanFolder(scratch: string, name: string): string {
  const path = join(scratch, `${name}-${randomBytes(4).toString("hex")}`);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

/**
 * Cards from what a script printed (a Script trigger): a JSON list of
 * objects, JSON lines, or plain lines (each one a title). An object has a
 * title, and may have details, an email and its own key; otherwise the
 * words themselves are the key, so the same item never makes two cards.
 */
export function cardsFromOutput(stdout: string): { key: string; title: string; description: string | null }[] {
  const text = stdout.trim();
  if (text === "") return [];
  const asItem = (value: unknown): { key: string; title: string; description: string | null } | null => {
    if (typeof value === "string") return value.trim() === "" ? null : { key: `line:${value.trim()}`.slice(0, 200), title: value.trim(), description: null };
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    const title = typeof row["title"] === "string" ? row["title"].trim() : "";
    if (title === "") return null;
    const details = [typeof row["description"] === "string" ? row["description"].trim() : "", typeof row["email"] === "string" ? row["email"].trim() : ""].filter(one => one !== "").join("\n\n");
    const key = typeof row["key"] === "string" || typeof row["key"] === "number" ? `key:${String(row["key"])}` : `item:${title}\n${details}`;
    return { key: key.slice(0, 200), title, description: details === "" ? null : details };
  };
  try {
    const whole = JSON.parse(text) as unknown;
    if (Array.isArray(whole)) return whole.map(asItem).filter((one): one is NonNullable<typeof one> => one !== null);
    const one = asItem(whole);
    if (one !== null) return [one];
  } catch { /* JSON lines or plain lines */ }
  return text.split("\n").map(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith("{")) { try { return asItem(JSON.parse(trimmed)); } catch { return asItem(trimmed); } }
    return asItem(trimmed);
  }).filter((one): one is NonNullable<typeof one> => one !== null);
}

/**
 * Where one flow launch runs (docs/plans/sandbox-parity.md C1): the fence `fenceFor` makes for a flow's setup, script
 * or trigger, around `folder` (a copy of the card's work, bound to its project, or a clean folder), with a launch folder
 * of its own for its input, an inline script and its temp files; writes as the project's writes setting allows (its
 * folder, the copy's Git data, its project's caches); the scratch pool denied around its own folder; and its network
 * open, as flows' scripts have always had it (they reach the services their secrets are for; no approval seals a
 * network for them). The fence is required: where this machine can't confine it, it runs only when an instance operator
 * allowed unconfined agents, and otherwise nothing runs and the card says why.
 */
export type FlowLaunch = { folder: string; env: Record<string, string>; fence?: LaunchFence; dispose(): void };

export function flowLaunch(store: Store, options: { repo: string; folder: string; scratch: string; copy: boolean; available?: () => boolean; policy?: FencePolicy; home?: string }): FlowLaunch | null | { problem: string } {
  const databaseFile = store.databaseFile();
  if (databaseFile === null || databaseFile === "" || databaseFile === ":memory:") return null;
  const available = options.available ?? (() => macosFenceAvailable() || linuxFenceAvailable());
  const fenced = available();
  // Asked first: a launch with no fence of its own (an instance operator allowed it, as inside another sandbox) makes
  // its folder in the temp folder it was given, never among the fenced launches' (which an outer sandbox may hold).
  if (!fenced && !store.unfencedAgentsAllowed()) {
    return { problem: "This machine can't confine the flow's script (no macOS sandbox, no working bubblewrap), so it didn't run. Install bubblewrap, socat and ripgrep (Linux), or an instance operator allows unconfined agents with `toolroll config unconfined-agents allow`." };
  }
  let own: string;
  try { own = realpathSync(mkdtempSync(join(fenced ? checkLaunchRoot() : tmpdir(), "so-cmd-"))); }
  catch (error) { return { problem: `The flow's launch folder couldn't be made, so nothing ran: ${error instanceof Error ? error.message : String(error)}` }; }
  const dispose = () => rmSync(own, { recursive: true, force: true });
  const temp = join(own, "tmp");
  mkdirSync(temp, { mode: 0o700 });
  const env: Record<string, string> = { TMPDIR: temp, TMP: temp, TEMP: temp };
  if (!fenced) return { folder: own, env, dispose };
  try {
    const poolRoots = [join(dirname(databaseFile), "worktrees"), options.scratch, ...store.listWorktrees().map(record => poolRootOf(record.path, record.repo))];
    // Its scratch folder is a pool root (so another flow's copy is out of reach) and sealed: never read, at any policy.
    // A copy is held to its project by the plane's own record of the repository, never what the copy says.
    const binding = options.copy ? trustedWorktreeBinding(options.repo, options.folder, poolRoots) : null;
    // The policy its flow sealed; nothing sealed is v1 (the home configuration denied), never a wider one implicitly.
    const home = options.home ?? homedir();
    const boundary = taskBoundary({ worktree: options.folder, provider: "command", home, binding, policy: options.policy ?? 1 });
    const cache = buildCacheFolder(options.repo, home);
    const allowed = store.projectWrites(options.repo) !== "workspace" ? null : writeAllowlist({ provider: "command", home, worktree: options.folder, binding, launchFolder: own, cache });
    // The project's read denies apply to flows as to builds (read live: a flow seals no list, and these only narrow).
    const readDeny = store.projectSandbox(options.repo).readDeny.map(one => readDenyPath(one, home));
    const fence = fenceFor("flow", { databaseFile, worktree: options.folder, home, boundary, readDeny, policy: options.policy ?? 1, scratchRoots: [options.scratch], binding, runFolders: runFolders(own), poolRoots, extra: allowed?.deny ?? [],
      writes: allowed === null ? null : { writes: allowed.writes, readOnly: allowed.readOnly }, network: { mode: "open" } });
    return { folder: own, env: { ...env, ...(allowed === null ? {} : buildCacheEnv(cache)) }, fence, dispose };
  } catch {
    dispose();
    return { problem: "The flow's copy couldn't be bound to its project, so nothing ran." };
  }
}
