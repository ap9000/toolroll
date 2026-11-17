#!/usr/bin/env node
/**
 * Protect the judges: a pull request that changes a file that judges other changes (a check list, a ceiling, an
 * inventory, a workflow; scripts/gate-files.json names them) must say so, in one of its own commits, with a trailer
 * line for each such file:
 *
 *   Gate-change: <file or glob> — <reason>
 *
 *   node <trusted copy>/scripts/gate-changes.mjs check --root <checkout> --base <sha> --head <sha> [--summary <file>]
 *
 * exits 0 when every changed gate file is covered (report-only gates are listed, never failed), 1 when one isn't or
 * the pull request can't be read whole, 2 on a usage error. The summary (Markdown) is appended to --summary.
 *
 * Trust: the rules come from the base, never from the pull request. .github/workflows/gate-changes.yml runs the base
 * revision's copy of this file, and this file reads the gate list with `git show <base>:scripts/gate-files.json`, so a
 * pull request that edits the list (or this script) is still judged by the base's. Only the trailers, the pull
 * request's own words, come from its commits. Git runs through deploy-git.mjs's view: no repository, system or global
 * config, no hooks, no replacement objects, no text conversion.
 */
import { appendFileSync } from "node:fs";
import { readGit } from "./deploy-git.mjs";

export const GATE_LIST = "scripts/gate-files.json";
const SHA = /^[0-9a-f]{40}$/;

/** A glob as a whole-path RegExp: `**` any run of characters (before a slash, also no folder at all), `*` and `?`
 * within one path part. */
export function globRegExp(glob) {
  let out = "";
  for (let at = 0; at < glob.length; at++) {
    const char = glob[at];
    if (char === "*" && glob[at + 1] === "*") {
      if (glob[at + 2] === "/") { out += "(?:.*/)?"; at += 2; } else { out += ".*"; at += 1; }
    } else if (char === "*") out += "[^/]*";
    else if (char === "?") out += "[^/]";
    else out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/** A pattern that names something: at least one character besides `*`, `?` and `/` (never "**", which says nothing). */
const names = pattern => /[^*?/]/.test(pattern);

/** The gate list's text as gates, or null when it isn't exactly the shape it must be (then nothing passes). */
export function parseGateList(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { return null; }
  if (raw === null || typeof raw !== "object" || !Array.isArray(raw.gates)) return null;
  const gates = [];
  for (const one of raw.gates) {
    if (one === null || typeof one !== "object" || typeof one.path !== "string" || !names(one.path) || one.path.startsWith("/")) return null;
    if (one.report !== undefined && typeof one.report !== "boolean") return null;
    let regions;
    if (one.regions !== undefined) {
      if (!Array.isArray(one.regions) || one.regions.length === 0) return null;
      regions = [];
      for (const region of one.regions) {
        if (region === null || typeof region !== "object" || typeof region.from !== "string" || region.from.trim() === "") return null;
        if (region.to !== undefined && (typeof region.to !== "string" || region.to.trim() === "")) return null;
        regions.push({ from: region.from, ...(region.to === undefined ? {} : { to: region.to }) });
      }
    }
    gates.push({ path: one.path, report: one.report === true, why: typeof one.why === "string" ? one.why : "", ...(regions === undefined ? {} : { regions }) });
  }
  return gates;
}

/** A trailer line: the key (any case), a pattern with no spaces, a dash (— – -- -) between spaces, and a reason. */
const TRAILER = /^gate-change:[ \t]*(\S+)[ \t]+(?:—|–|--|-)[ \t]+(.*\S.*)$/i;

/** Every `Gate-change:` line in a commit message: the ones that read, and the ones that don't (named, never used). */
export function parseTrailers(message) {
  const trailers = [], unreadable = [];
  for (const line of String(message).split(/\r?\n/)) {
    if (!/^gate-change:/i.test(line)) continue;
    const got = TRAILER.exec(line);
    if (got === null || got[2].trim().length < 3) unreadable.push(line);
    else if (!names(got[1])) unreadable.push(line);
    else trailers.push({ pattern: got[1], reason: got[2].trim() });
  }
  return { trailers, unreadable };
}

/** The judged part of a file's text: each region's lines, or null when a region's anchors aren't there. */
export function regionsOf(text, regions) {
  if (text === null) return null;
  const lines = text.split("\n");
  const parts = [];
  for (const { from, to } of regions) {
    const start = lines.findIndex(line => line.trimStart().startsWith(from));
    if (start === -1) return null;
    let end = start;
    if (to !== undefined) {
      end = lines.findIndex((line, at) => at >= start && line.trim() === to);
      if (end === -1) return null;
    }
    parts.push(lines.slice(start, end + 1).join("\n"));
  }
  return parts.join("\n\0\n");
}

/**
 * The verdict. `gates`: the base's list. `changes`: [{ status, path }] from the merge base to the head (renames
 * split into a deletion and an addition). `before`/`after`: a path's text at the merge base and the head (null: not
 * there). `messages`: every commit message of the pull request. A region gate counts as changed only when its regions
 * differ (or either side's can't be found).
 */
export function judge({ gates, changes, before, after, messages }) {
  const trailers = [], unreadable = [];
  for (const message of messages) { const read = parseTrailers(message); trailers.push(...read.trailers); unreadable.push(...read.unreadable); }
  const compiled = trailers.map(one => ({ ...one, test: globRegExp(one.pattern) }));
  const required = [], report = [];
  const seen = new Set();
  for (const { path } of changes) {
    if (seen.has(path)) continue;
    const gate = gates.find(one => globRegExp(one.path).test(path));
    if (gate === undefined) continue;
    if (gate.regions !== undefined) {
      const was = regionsOf(before(path), gate.regions), now = regionsOf(after(path), gate.regions);
      if (was !== null && now !== null && was === now) continue;
    }
    seen.add(path);
    if (gate.report) { report.push({ path, why: gate.why }); continue; }
    const by = compiled.find(one => one.test.test(path));
    required.push({ path, why: gate.why, covered: by !== undefined, ...(by === undefined ? {} : { pattern: by.pattern, reason: by.reason }) });
  }
  return { ok: required.every(one => one.covered), required, report, unreadable };
}

/** `git diff --name-status -z --no-renames` output as [{ status, path }], or null when it isn't exactly that. */
export function parseChanges(raw) {
  if (typeof raw !== "string") return null;
  if (raw === "") return [];
  if (!raw.endsWith("\0")) return null;
  const words = raw.slice(0, -1).split("\0");
  if (words.length % 2 !== 0) return null;
  const out = [];
  for (let at = 0; at < words.length; at += 2) {
    if (!/^[ADMTUXB]$/.test(words[at]) || words[at + 1] === "") return null;
    out.push({ status: words[at], path: words[at + 1] });
  }
  return out;
}

/**
 * The pull request as git has it, read through views (no repository config): the base's gate list, the changes from
 * the merge base, each commit's message, and a reader for a path's text at the merge base or the head. Throws when
 * any of it can't be read.
 */
export function readPullRequest(root, base, head) {
  if (!SHA.test(base ?? "") || !SHA.test(head ?? "")) throw Error("--base and --head must be full commit ids");
  const git = args => readGit(["-C", root], args, { PATH: process.env.PATH ?? "/usr/bin:/bin" });
  // A path from the diff is a name, never a pattern (a file called "*" names only itself).
  const exists = (rev, path) => git(["--literal-pathspecs", "ls-tree", "-z", "--name-only", rev, "--", path]) !== "";
  const show = (rev, path) => exists(rev, path) ? git(["show", "--no-textconv", `${rev}:${path}`]) : null;
  const from = git(["merge-base", base, head]).trim();
  if (!SHA.test(from)) throw Error("no merge base");
  const changes = parseChanges(git(["diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", "--no-renames", "--name-status", "-z", from, head, "--"]));
  if (changes === null) throw Error("the diff couldn't be read whole");
  const log = git(["log", "-z", "--no-notes", "--no-show-signature", "--format=%B", `${from}..${head}`]);
  const messages = log === "" ? [] : log.replace(/\0$/, "").split("\0");
  return { gatesText: show(base, GATE_LIST), changes, messages, before: path => show(from, path), after: path => show(head, path) };
}

/** Words from the pull request (a path, a trailer) as one printable line: no control character survives, so nothing
 * it says can start a line of its own, where the runner would read it as a workflow command. */
export const plain = text => String(text).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029`]/g, "?").slice(0, 200);

/** The verdict in Markdown, for the job's summary. */
export function summary(verdict) {
  const lines = ["### Gate changes", ""];
  if (verdict.required.length === 0 && verdict.report.length === 0) lines.push("No gate file changed.");
  for (const one of verdict.required) {
    lines.push(one.covered ? `- \`${plain(one.path)}\`: declared by \`Gate-change: ${plain(one.pattern)}\` — ${plain(one.reason)}` : `- \`${plain(one.path)}\` (${one.why}): **no Gate-change trailer covers it**`);
  }
  for (const one of verdict.report) lines.push(`- \`${plain(one.path)}\` (${one.why}): changed; reported only`);
  for (const line of verdict.unreadable) lines.push(`- ignored, unreadable: \`${plain(line)}\` (write \`Gate-change: <file or glob> — <reason>\`)`);
  if (!verdict.ok) lines.push("", "Add a commit whose message carries `Gate-change: <file or glob> — <reason>` for each file above, so a reviewer sees the judge moved and why.");
  return `${lines.join("\n")}\n`;
}

const flag = (args, name) => { const at = args.indexOf(`--${name}`); return at === -1 ? undefined : args[at + 1]; };

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [command, ...args] = process.argv.slice(2);
  if (command !== "check") { console.error("usage: gate-changes.mjs check --root <checkout> --base <sha> --head <sha> [--summary <file>]"); process.exit(2); }
  const write = text => { const file = flag(args, "summary"); if (file) appendFileSync(file, text); process.stdout.write(text); };
  let pull;
  try { pull = readPullRequest(flag(args, "root") ?? ".", flag(args, "base"), flag(args, "head")); } catch (error) {
    console.error(`::error::gate changes: the pull request couldn't be read whole (${String(error?.message ?? error).slice(0, 300)})`);
    process.exit(1);
  }
  if (pull.gatesText === null) {
    write(`### Gate changes\n\nThe base has no ${GATE_LIST} yet, so no file is a gate for this pull request.\n`);
    process.exit(0);
  }
  const gates = parseGateList(pull.gatesText);
  if (gates === null) { console.error(`::error::gate changes: the base's ${GATE_LIST} doesn't read`); process.exit(1); }
  const verdict = judge({ gates, changes: pull.changes, before: pull.before, after: pull.after, messages: pull.messages });
  write(summary(verdict));
  // A workflow command's property escaped as the runner reads it (%, CR, LF, colon, comma).
  const property = text => plain(text).replace(/%/g, "%25").replace(/:/g, "%3A").replace(/,/g, "%2C");
  for (const one of verdict.required.filter(one => !one.covered)) console.error(`::error file=${property(one.path)}::${plain(one.path)} judges other changes (${one.why}); a commit must carry "Gate-change: ${plain(one.path)} — <reason>"`);
  process.exit(verdict.ok ? 0 : 1);
}
