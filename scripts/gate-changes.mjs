#!/usr/bin/env node
/**
 * Protect the judges: a pull request that changes a file that judges other changes (a check list, a ceiling, an
 * inventory, a workflow; scripts/gate-files.json names them) must say so, in one of its own commits, with a trailer
 * line for each such file. A trailer is a disclosure, never an approval: it makes the change to a judge visible to the
 * person reviewing it, and passes nothing by itself.
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
 * config, no hooks, no replacement objects, no text conversion. Everything the pull request wrote is printed between
 * `::stop-commands::<random token>` and `::<token>::`, so none of it is read as a workflow command; the only commands
 * this prints are its own, from words it chose.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { readGit } from "./deploy-git.mjs";

export const GATE_LIST = "scripts/gate-files.json";
const SHA = /^[0-9a-f]{40}$/;

/** The longest trailer pattern read, and the most trailers read from one pull request. */
export const PATTERN_MAX = 200;
export const TRAILERS_MAX = 50;

/** One path part against one pattern part, `*` any run within it: iterative, at most (pattern × part) steps. */
function partMatches(pattern, part) {
  let p = 0, s = 0, star = -1, mark = 0;
  while (s < part.length) {
    if (p < pattern.length && pattern[p] === "*") { star = p++; mark = s; }
    else if (p < pattern.length && pattern[p] === part[s]) { p++; s++; }
    else if (star !== -1) { p = star + 1; s = ++mark; }
    else return false;
  }
  while (p < pattern.length && pattern[p] === "*") p++;
  return p === pattern.length;
}

/**
 * Whether `path` matches `glob`: `*` any run within one path part, `**` (a whole part) any number of parts, every
 * other character itself. The same iterative walk over parts as within one: no regular expression, no recursion, so a
 * pattern can't make it backtrack without end.
 */
export function globMatches(glob, path) {
  const want = glob.split("/"), have = path.split("/");
  let p = 0, s = 0, star = -1, mark = 0;
  while (s < have.length) {
    if (p < want.length && want[p] === "**") { star = p++; mark = s; }
    else if (p < want.length && partMatches(want[p], have[s])) { p++; s++; }
    else if (star !== -1) { p = star + 1; s = ++mark; }
    else return false;
  }
  while (p < want.length && want[p] === "**") p++;
  return p === want.length;
}

/** A pattern that names something: at least one character besides `*` and `/` (never "**", which says nothing). */
const names = pattern => /[^*/]/.test(pattern);

/** The gate list's text as gates, or null when it isn't exactly the shape it must be (then nothing passes). */
export function parseGateList(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { return null; }
  if (raw === null || typeof raw !== "object" || !Array.isArray(raw.gates)) return null;
  const gates = [];
  for (const one of raw.gates) {
    if (one === null || typeof one !== "object" || typeof one.path !== "string" || !names(one.path) || one.path.startsWith("/")) return null;
    if (Object.keys(one).some(key => !["path", "report", "why"].includes(key))) return null;
    if (one.report !== undefined && typeof one.report !== "boolean") return null;
    gates.push({ path: one.path, report: one.report === true, why: typeof one.why === "string" ? one.why : "" });
  }
  return gates;
}

/** A trailer: `Key: value`, the key letters, digits and dashes. */
const TRAILER_LINE = /^[A-Za-z0-9][A-Za-z0-9-]*:[ \t]*\S/;
/** A Gate-change trailer's value: a pattern with no spaces, a dash (— – -- -) between spaces, and a reason. */
const GATE_CHANGE = /^gate-change:[ \t]*(\S+)[ \t]+(?:—|–|--|-)[ \t]+([^\n]*\S[^\n]*)$/i;

/** A commit message's trailer block, as git reads one: its last paragraph, when every line of it is `Key: value`. */
export function trailerBlock(message) {
  const paragraphs = String(message).replace(/\r\n?/g, "\n").trim().split(/\n[ \t]*\n/);
  const last = paragraphs.length > 1 ? paragraphs.at(-1).split("\n") : [];
  return last.length > 0 && last.every(line => TRAILER_LINE.test(line)) ? last : [];
}

/** The Gate-change trailers in a commit message's trailer block: the ones that read, and the ones that don't (named,
 * never used). A Gate-change line anywhere else in the message is not a trailer. */
export function parseTrailers(message) {
  const trailers = [], unreadable = [];
  for (const line of trailerBlock(message)) {
    if (!/^gate-change:/i.test(line)) continue;
    const got = GATE_CHANGE.exec(line);
    if (got === null || got[2].trim().length < 3 || !names(got[1]) || got[1].length > PATTERN_MAX) unreadable.push(line);
    else trailers.push({ pattern: got[1], reason: got[2].trim() });
  }
  return { trailers, unreadable };
}

/**
 * The verdict. `gates`: the base's list. `changes`: [{ status, path }] from the merge base to the head (renames
 * split into a deletion and an addition). `messages`: the pull request's own commit messages (merges left out). At
 * most TRAILERS_MAX trailers are read; the rest are named as unread.
 */
export function judge({ gates, changes, messages }) {
  const trailers = [], unreadable = [];
  for (const message of messages) {
    const read = parseTrailers(message);
    unreadable.push(...read.unreadable);
    for (const one of read.trailers) {
      if (trailers.length < TRAILERS_MAX) trailers.push(one);
      else unreadable.push(`Gate-change: ${one.pattern} — (more than ${TRAILERS_MAX} trailers; not read)`);
    }
  }
  const required = [], report = [];
  const seen = new Set();
  for (const { path } of changes) {
    if (seen.has(path)) continue;
    const gate = gates.find(one => globMatches(one.path, path));
    if (gate === undefined) continue;
    seen.add(path);
    if (gate.report) { report.push({ path, why: gate.why }); continue; }
    const by = trailers.find(one => globMatches(one.pattern, path));
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
 * the merge base, and the messages of its own commits (`base..head`, merges left out). Throws when any of it can't be
 * read.
 */
export function readPullRequest(root, base, head) {
  if (!SHA.test(base ?? "") || !SHA.test(head ?? "")) throw Error("--base and --head must be full commit ids");
  const git = args => readGit(["-C", root], args, { PATH: process.env.PATH ?? "/usr/bin:/bin" });
  // A path is a name, never a pattern.
  const exists = (rev, path) => git(["--literal-pathspecs", "ls-tree", "-z", "--name-only", rev, "--", path]) !== "";
  const from = git(["merge-base", base, head]).trim();
  if (!SHA.test(from)) throw Error("no merge base");
  const changes = parseChanges(git(["diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", "--no-renames", "--name-status", "-z", from, head, "--"]));
  if (changes === null) throw Error("the diff couldn't be read whole");
  const log = git(["log", "-z", "--no-merges", "--no-notes", "--no-show-signature", "--format=%B", `${base}..${head}`]);
  const messages = log === "" ? [] : log.replace(/\0$/, "").split("\0");
  const gatesText = exists(base, GATE_LIST) ? git(["show", "--no-textconv", `${base}:${GATE_LIST}`]) : null;
  return { gatesText, changes, messages };
}

/** Words from the pull request (a path, a pattern, a reason) as one line of Markdown text: no control character, no
 * backtick, and every Markdown character escaped, so it reads as the words it is. */
export const plain = text => String(text).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "?").slice(0, 200)
  .replace(/[\\`*_{}[\]()<>#+\-.!|~]/g, "\\$&");

/** The verdict in Markdown, for the job's summary. */
export function summary(verdict) {
  const lines = ["### Gate changes", ""];
  if (verdict.required.length === 0 && verdict.report.length === 0) lines.push("No gate file changed.");
  for (const one of verdict.required) {
    lines.push(one.covered ? `- ${plain(one.path)}: disclosed by Gate-change: ${plain(one.pattern)}, ${plain(one.reason)}` : `- ${plain(one.path)} (${one.why}): **no Gate-change trailer discloses it**`);
  }
  for (const one of verdict.report) lines.push(`- ${plain(one.path)} (${one.why}): changed; reported only`);
  for (const line of verdict.unreadable) lines.push(`- not read: ${plain(line)}`);
  if (!verdict.ok) lines.push("", "Add `Gate-change: <file or glob> — <reason>` to the trailer block (the last paragraph) of one of this pull request's commits for each file above. It discloses the change to the person reviewing it; it approves nothing.");
  return `${lines.join("\n")}\n`;
}

/** A path safe to name in a workflow command of this script's own: plain path characters only, else none. */
const commandSafe = path => /^[A-Za-z0-9._/-]{1,200}$/.test(path) ? path : null;

/**
 * What the job prints: the pull request's words between `::stop-commands::<token>` and `::<token>::` (a token from
 * crypto randomness, which nothing the pull request wrote can know), then this script's own annotations, built from
 * its own words and plain paths only.
 */
export function printed(verdict, token = randomBytes(16).toString("hex")) {
  const out = [`::stop-commands::${token}`, summary(verdict).trimEnd(), `::${token}::`];
  for (const one of verdict.required.filter(one => !one.covered)) {
    const path = commandSafe(one.path);
    out.push(path === null ? "::error::gate changes: a changed gate file has no Gate-change trailer (see the summary)" : `::error file=${path}::gate changes: ${path} judges other changes; no Gate-change trailer discloses it`);
  }
  return `${out.join("\n")}\n`;
}

const flag = (args, name) => { const at = args.indexOf(`--${name}`); return at === -1 ? undefined : args[at + 1]; };

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [command, ...args] = process.argv.slice(2);
  if (command !== "check") { console.error("usage: gate-changes.mjs check --root <checkout> --base <sha> --head <sha> [--summary <file>]"); process.exit(2); }
  const summaryFile = flag(args, "summary");
  let pull;
  try { pull = readPullRequest(flag(args, "root") ?? ".", flag(args, "base"), flag(args, "head")); } catch (error) {
    // Git's words can carry the pull request's: printed inside a stop-commands block, never as a command.
    const token = randomBytes(16).toString("hex");
    process.stdout.write(`::stop-commands::${token}\n${String(error?.message ?? error).slice(0, 300)}\n::${token}::\n::error::gate changes: the pull request couldn't be read whole\n`);
    process.exit(1);
  }
  if (pull.gatesText === null) {
    const words = `### Gate changes\n\nThe base has no ${GATE_LIST} yet, so no file is a gate for this pull request.\n`;
    if (summaryFile) appendFileSync(summaryFile, words);
    process.stdout.write(words);
    process.exit(0);
  }
  const gates = parseGateList(pull.gatesText);
  if (gates === null) { process.stdout.write(`::error::gate changes: the base's ${GATE_LIST} doesn't read\n`); process.exit(1); }
  const verdict = judge({ gates, changes: pull.changes, messages: pull.messages });
  if (summaryFile) appendFileSync(summaryFile, summary(verdict));
  process.stdout.write(printed(verdict));
  process.exit(verdict.ok ? 0 : 1);
}
