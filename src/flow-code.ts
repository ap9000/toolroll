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
import { chmodSync, existsSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { isAbsolute, join, relative } from "node:path";
import type { Runner } from "./backend.js";
import { SETUP_ENV_ALLOWLIST, SETUP_ENV_DENYLIST } from "./builder.js";
import { redactSecretLines, scanForSecrets } from "./evidence.js";
import { scrubSecrets } from "./flow-secrets.js";
import type { FlowScriptRow } from "./store.js";
import { TEXT_LIMITS } from "./text-limits.js";

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

/** A project file a script names, if it is one: inside the project, and there. */
export function projectFile(root: string, path: string): string | null {
  if (path === "" || isAbsolute(path) || path.split(/[\\/]/).includes("..")) return null;
  try {
    const base = realpathSync(root), full = realpathSync(join(root, path));
    const inside = relative(base, full);
    return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside) && statSync(full).isFile() ? full : null;
  } catch { return null; }
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
  fence: readonly string[];
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
  const inputFile = join(run.scratch, `flow-input-${tag}.json`);
  let scriptFile: string | null = null;
  try {
    writeFileSync(inputFile, JSON.stringify(run.input), { mode: 0o600 });
    if (script.file !== null) {
      scriptFile = projectFile(run.root, script.file);
      if (scriptFile === null) return { state: "failed", exitCode: null, output: "", printed: "", goTo: null, log: "", said: `${script.name} runs ${script.file}, which isn't a file in the project.` };
    } else {
      const own = join(run.scratch, `flow-script-${tag}.${EXTENSION[language]}`);
      writeFileSync(own, `${script.body}\n`, { mode: 0o700 });
      chmodSync(own, 0o700);
      scriptFile = own;
    }
    const runtime = runtimeOf(language, scriptFile);
    // The card goes in on stdin from its file (never a pipe): a script that doesn't read it can finish
    // first without breaking anything. Only our own paths are in the command; the card is only data.
    const ran = await run.shell("/bin/sh", ["-c", 'exec "$@" < "$FLOW_INPUT"', "flow-script", runtime.file, ...runtime.args], {
      cwd: run.cwd, timeoutMs: script.timeoutMinutes * 60_000, envAllowlist: SETUP_ENV_ALLOWLIST, omitEnv: SETUP_ENV_DENYLIST, processGroup: true,
      env: { ...run.env, ...run.secrets, FLOW_INPUT: inputFile }, fence: run.fence,
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
