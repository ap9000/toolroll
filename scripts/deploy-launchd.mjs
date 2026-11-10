// What deploy recovery reads from launchd and the process list before it stops a new service that never started
// completely (docs/plans/recovery-stops-silent-service.md). Readers and comparisons only: nothing here runs, stops or
// signals anything. deploy-phases.mjs makes the one act (`launchctl bootout gui/<uid>/<label>`) after these facts hold.
import { existsSync } from "node:fs";
import { basename, join, sep } from "node:path";

/** A state folder is Toolroll's own by the same name test the agent fence uses (src/agent-fence.ts `dedicated`): only
 * then is every top-level entry in it, staged-upgrades/ included, denied to fenced agents. */
export const OWN_FOLDER_NAME = /standing[\s_-]?orders|toolroll|nightorders/i;

/** The fence's "Toolroll's own" test for a real (realpath'd) state folder and real home folder. */
export function ownStateFolder(state, home) {
  return typeof state === "string" && state !== "" && state !== home && state !== sep && !existsSync(join(state, ".git")) && OWN_FOLDER_NAME.test(basename(state));
}

/** Bounds on each subprocess the stop runs (plan §8): 10 s for print, ps, pgrep and curl; 75 s for bootout, past
 * launchd's own 60 s exit timeout. */
export const CALL_MS = 10_000;
export const BOOTOUT_MS = 75_000;
/** How long the stop waits, after its bootout, for the service to be proved gone. */
export const ABSENCE_MS = 75_000;
/** A fixed PATH and locale for every call, never the caller's environment. */
export const CALL_ENV = Object.freeze({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" });

/** Runs one bounded call through `spawnSync`. A throw from spawnSync itself comes back as a spawn error. */
export function boundedRunner(spawnSync) {
  return (command, args, ms = CALL_MS) => {
    try { return spawnSync(command, args, { encoding: "utf8", timeout: ms, env: { ...CALL_ENV }, maxBuffer: 32 * 1024 * 1024 }); }
    catch (error) { return { status: null, signal: null, error, stdout: "", stderr: "" }; }
  };
}

/** A call whose outcome is not known: a timeout, a signal, a spawn error, or no numeric exit status. */
export function uncertain(out) {
  return out === null || typeof out !== "object" || (out.error !== undefined && out.error !== null) || (out.signal !== undefined && out.signal !== null) || typeof out.status !== "number";
}

const WATCHED = new Set(["pid", "path", "state", "arguments"]);

/**
 * `launchctl print <target>` output, read strictly: `{ state, pid, path, arguments }` with pid null when no pid line is
 * printed, or null when the text is not exactly one well-formed block for `target`. Refused: a first line other than
 * `<target> = {`; indentation that is not exactly one tab per level; trailing whitespace; an unbalanced or truncated
 * block; anything after it; a top-level `pid`, `path`, `state` or `arguments` field given twice; a missing `path`,
 * `state` or `arguments`; those fields out of launchd's order (path, state, arguments, pid); a pid that is not a plain
 * number above 1; an empty argument list. Only the job's own fields, one tab deep, are read: a field of the same name
 * inside a nested block (launchd prints `state = active` inside `resource coalition` and `jetsam coalition`) belongs
 * to that block and is never taken for the job's.
 */
export function parseLaunchdPrint(text, target) {
  if (typeof text !== "string" || typeof target !== "string" || target === "") return null;
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines[0] !== `${target} = {`) return null;
  const found = {}, order = [];
  let depth = 1, args = null, argsDepth = -1;
  for (let at = 1; at < lines.length; at++) {
    const line = lines[at];
    if (depth === 0) return null;
    if (line === "") continue;
    const tabs = /^\t*/.exec(line)[0].length, rest = line.slice(tabs);
    if (rest === "" || /^\s/.test(rest) || /\s$/.test(rest)) return null;
    if (rest === "}") {
      if (tabs !== depth - 1) return null;
      if (depth === argsDepth) argsDepth = -1;
      depth--;
      continue;
    }
    if (tabs !== depth) return null;
    if (depth === argsDepth) {
      if (rest.endsWith(" = {")) return null;
      args.push(rest);
      continue;
    }
    const split = rest.indexOf(" = ");
    const key = split > 0 ? rest.slice(0, split) : null;
    const value = split > 0 ? rest.slice(split + 3) : null;
    if (key !== null && depth === 1 && WATCHED.has(key)) {
      if (Object.hasOwn(found, key)) return null;
      if (key === "arguments") { if (value !== "{") return null; args = []; found.arguments = args; argsDepth = depth + 1; depth++; order.push(key); continue; }
      if (value === "{" || value === "") return null;
      found[key] = value;
      order.push(key);
      continue;
    }
    if (rest.endsWith(" = {")) depth++;
  }
  if (depth !== 0) return null;
  if (found.path === undefined || found.state === undefined || found.arguments === undefined || found.arguments.length === 0) return null;
  const expected = ["path", "state", "arguments", "pid"].filter(key => order.includes(key));
  if (order.join() !== expected.join()) return null;
  let pid = null;
  if (found.pid !== undefined) {
    if (!/^[1-9][0-9]*$/.test(found.pid)) return null;
    pid = Number(found.pid);
    if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  }
  return { state: found.state, pid, path: found.path, arguments: [...found.arguments] };
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };

/** The `ProgramArguments` of a launchd definition, read strictly, or null: the key exactly once, followed by one array
 * of plain `<string>` entries (the five XML entities only, no line breaks, no nested array or other element). */
export function programArguments(plist) {
  if (typeof plist !== "string") return null;
  const key = "<key>ProgramArguments</key>";
  const at = plist.indexOf(key);
  if (at < 0 || plist.indexOf(key, at + key.length) >= 0) return null;
  let rest = plist.slice(at + key.length);
  const open = /^\s*<array>/.exec(rest);
  if (open === null) return null;
  rest = rest.slice(open[0].length);
  const out = [];
  for (;;) {
    rest = rest.replace(/^\s+/, "");
    if (rest.startsWith("</array>")) break;
    const one = /^<string>([^<]*)<\/string>/.exec(rest);
    if (one === null) return null;
    const raw = one[1];
    if (/[\r\n]/.test(raw)) return null;
    let bad = false;
    const value = raw.replace(/&([^;&]*);?/g, (match, name) => { if (!match.endsWith(";") || !Object.hasOwn(ENTITIES, name)) bad = true; return ENTITIES[name] ?? ""; });
    if (bad || value === "") return null;
    out.push(value);
    rest = rest.slice(one[0].length);
  }
  return out.length > 0 ? out : null;
}

/** `root` and its descendants in one process listing, by parent links, each as `{ pid, start }`: at most three levels
 * below the root (the depth deploy-phases.mjs processTree allows: supervisor, `up`, its roles and theirs). Null when
 * the root is not listed or the tree goes deeper. */
export function treeOf(rows, root) {
  if (!Array.isArray(rows)) return null;
  const top = rows.find(row => row.pid === root);
  if (top === undefined) return null;
  const all = [{ pid: top.pid, start: top.start }], seen = new Set([top.pid]);
  let level = [top.pid];
  for (let depth = 0; depth < 4 && level.length > 0; depth++) {
    const next = [];
    for (const row of rows) if (level.includes(row.ppid) && !seen.has(row.pid)) { seen.add(row.pid); next.push(row.pid); all.push({ pid: row.pid, start: row.start }); }
    level = next;
    if (depth === 3 && level.length > 0) return null;
  }
  return all;
}

/** A recorded `{ pid, start }` the listing still holds: the same pid with the same start time. A pid now held by a
 * process with another start time is gone (the recorded process exited). An entry that is not a pid and a start time
 * never proves anything, so it is always left. Returns what is left, as words. */
export function recordedLeft(rows, pids) {
  if (!Array.isArray(rows)) return ["the process list could not be read"];
  if (!Array.isArray(pids)) return ["the recorded processes are unreadable"];
  const left = [];
  for (const one of pids) {
    const valid = one !== null && typeof one === "object" && Number.isSafeInteger(one.pid) && one.pid > 1 && typeof one.start === "string" && one.start !== "";
    if (!valid) { left.push("an unreadable recorded process"); continue; }
    if (rows.some(row => row.pid === one.pid && row.start === one.start)) left.push(`process ${one.pid}`);
  }
  return left;
}

/** Two `{ pid, start }` lists as one, each entry once, in order. */
export function mergeRecorded(...lists) {
  const out = [];
  for (const list of lists) for (const one of Array.isArray(list) ? list : []) {
    if (!out.some(kept => JSON.stringify(kept) === JSON.stringify(one))) out.push(one);
  }
  return out;
}
