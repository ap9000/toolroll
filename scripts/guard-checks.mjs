#!/usr/bin/env node
/** Advisory source guards. Run the BASE revision's copy, never import candidate code.
 * node scripts/guard-checks.mjs check --root <checkout> --base <full sha> --head <full sha>
 * --all inventories HEAD without failing (no base/head required). Comparative rules need --base to show changes.
 * Matching is lexical, not a type checker: comments and literal text aren't executable code.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { readGit } from "./deploy-git.mjs";
import { parseChanges, parseTrailers, globMatches, TRAILERS_MAX } from "./gate-changes.mjs";

export const LINE_MAX = 4096;
export const FIXES = Object.freeze({
  1: "remove the leftover short-circuit or focused test; restore the real condition and run every test",
  2: "wait on a fact (state, event, file), never a fixed sleep — see AGENTS.md flaky-test rule",
  3: "wait on a fact (state, event, file), never a fixed sleep — see AGENTS.md flaky-test rule; fix the wait instead of raising its timeout",
  4: "pass the value explicitly or use a per-test env map; parallel Rust tests share the environment",
  5: "compare in the platform's own mode_t (u16 on macOS, u32 on Linux)",
  6: "lower the ceiling or disclose the increase with a Gate-change: <file> — <reason> trailer in the commit's final trailer block; disclosure is not approval",
  7: "append new top-level functions at the END; src/password-freshness.test.ts pins ordinals, so inserting before existing functions changes their identity",
  8: "print values through gate-changes.mjs printed() (the existing stop-commands wrapper) so untrusted text cannot become workflow commands",
});
const ORDINAL_FILES = new Set(["src/store.ts", "src/operate.ts", "src/server/tasks.ts"]);
const sourcePath = path => ["src/", "scripts/", "test/", "tui/"].some(prefix => path.startsWith(prefix));
const shellPath = path => path.endsWith(".sh") || path.endsWith(".bash") || path.endsWith(".zsh") || path.startsWith(".github/workflows/");
const rustTestsPath = path => path.startsWith("tui/") && path.split("/").includes("tests");
const testPath = path => path.endsWith(".test.ts") || rustTestsPath(path);
const ceilingPath = path => path === "test/click-path-ceilings.json" || (path.startsWith("test/perf/") && !path.slice(10).includes("/") && path.endsWith("ceilings.json"));
const ciPath = path => path === "scripts/gate-changes.mjs" || (path.startsWith("scripts/ci-") && path.endsWith(".mjs"));
const wordStart = c => c !== undefined && /[A-Za-z_$]/.test(c);
const word = c => c !== undefined && /[A-Za-z0-9_$]/.test(c);

/** Only run: scalar contents are shell, not a workflow's YAML conditions or metadata. */
function workflowShellLines(lines) {
  const out = new Set();
  let blockIndent = -1;
  lines.forEach((raw, at) => {
    if (Buffer.byteLength(raw) > LINE_MAX) return;
    const trimmed = raw.trimStart(), indent = raw.length - trimmed.length;
    if (trimmed === "") return;
    if (blockIndent >= 0 && indent > blockIndent) { out.add(at + 1); return; }
    blockIndent = -1;
    const field = trimmed.startsWith("- ") ? trimmed.slice(2) : trimmed;
    if (!field.startsWith("run:")) return;
    const value = field.slice(4).trim();
    if (value.startsWith("|") || value.startsWith(">")) blockIndent = indent + (trimmed.startsWith("- ") ? 2 : 0);
    else out.add(at + 1);
  });
  return out;
}

/** One forward pass, bounded lines before matching. No regex searches with ambiguous repetitions.
 * Strings retain their spelling for test identities, but never match executable rules. */
export function lex(text, rust = false) {
  const lines = text.split("\n"), oversized = [];
  const safe = lines.map((line, at) => {
    if (Buffer.byteLength(line, "utf8") <= LINE_MAX) return line;
    oversized.push(at + 1);
    return "";
  }).join("\n");
  const tokens = [];
  let i = 0, line = 1, braces = 0;
  const interpolations = [];
  const push = (value, kind = "code", at = line) => tokens.push({ value, kind, line: at });
  const templateChunk = opening => {
    const start = i, at = line;
    if (opening) i++;
    while (i < safe.length) {
      const one = safe[i++];
      if (one === "\n") line++;
      if (one === "\\") { if (safe[i] === "\n") line++; i++; }
      else if (one === "`") break;
      else if (one === "$" && safe[i] === "{") {
        i++;
        push(safe.slice(start, i), "string", at);
        push("{", "code", line);
        interpolations.push(++braces);
        return;
      }
    }
    push(safe.slice(start, i), "string", at);
  };
  while (i < safe.length) {
    const c = safe[i], next = safe[i + 1];
    if (c === "\n") { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === "/" && next === "/") { while (i < safe.length && safe[i] !== "\n") i++; continue; }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < safe.length && !(safe[i] === "*" && safe[i + 1] === "/")) { if (safe[i++] === "\n") line++; }
      i += 2; continue;
    }
    if (!rust && c === "}") {
      if (interpolations.at(-1) === braces) {
        push("}"); i++; braces--; interpolations.pop(); templateChunk(false); continue;
      }
    }
    if (!rust && c === "`") { templateChunk(true); continue; }
    // Rust lifetimes ('a) are identifiers; a closing quote still makes 'word' a JS string.
    let lifetimeEnd = i + 1;
    if (rust && c === "'" && wordStart(next)) while (word(safe[lifetimeEnd])) lifetimeEnd++;
    if (rust && c === "r" && (next === "#" || next === '"')) {
      let quote = i + 1;
      while (safe[quote] === "#") quote++;
      if (safe[quote] === '"') {
        const start = i, at = line, delimiter = '"' + "#".repeat(quote - i - 1);
        const close = safe.indexOf(delimiter, quote + 1);
        i = close < 0 ? safe.length : close + delimiter.length;
        const literal = safe.slice(start, i);
        for (const one of literal) if (one === "\n") line++;
        push(literal, "string", at); continue;
      }
    }
    if ((c === "'" && !(rust && wordStart(next) && safe[lifetimeEnd] !== "'")) || c === '"') {
      const start = i++, at = line;
      while (i < safe.length) {
        const one = safe[i++];
        if (one === "\n") line++;
        if (one === "\\") { if (safe[i] === "\n") line++; i++; }
        else if (one === c) break;
      }
      push(safe.slice(start, i), "string", at); continue;
    }
    // JS regex literals can contain quotes and braces. Skip them without interpreting the pattern.
    if (!rust && c === "/" && (!tokens.length || ["=", "(", ",", ":", "return", "=>", "!", "[", "&&", "||", "?"].includes(tokens.at(-1).value))) {
      const start = i++, at = line;
      let characterClass = false;
      while (i < safe.length && safe[i] !== "\n") {
        const one = safe[i++];
        if (one === "\\") i++;
        else if (one === "[") characterClass = true;
        else if (one === "]") characterClass = false;
        else if (one === "/" && !characterClass) break;
      }
      while (word(safe[i])) i++;
      push(safe.slice(start, i), "string", at); continue;
    }
    if (/[0-9]/.test(c)) {
      const start = i++;
      while (word(safe[i])) i++;
      if (safe[i] === "." && /[0-9]/.test(safe[i + 1] ?? "")) { i++; while (word(safe[i])) i++; }
      if (["e", "E"].includes(safe[i - 1]) && ["+", "-"].includes(safe[i])) { i++; while (word(safe[i])) i++; }
      push(safe.slice(start, i)); continue;
    }
    if (wordStart(c)) {
      const start = i++;
      while (word(safe[i])) i++;
      push(safe.slice(start, i)); continue;
    }
    const pair = safe.slice(i, i + 2);
    if (["||", "&&", "=>", "::"].includes(pair)) { push(pair); i += 2; }
    else {
      if (c === "{") braces++;
      else if (c === "}") braces = Math.max(0, braces - 1);
      push(c); i++;
    }
  }
  return { tokens, oversized, lines };
}

const isCode = token => token?.kind === "code";
function sequence(tokens, at, values) {
  return values.every((value, offset) => isCode(tokens[at + offset]) && tokens[at + offset].value === value);
}

/** Balanced delimiter mates, computed once. Used for multiline calls, test scopes and function declarations. */
function mates(tokens) {
  const out = new Map(), stack = [], closes = { ")": "(", "]": "[", "}": "{" };
  tokens.forEach((token, at) => {
    if (!isCode(token)) return;
    if (["(", "[", "{"].includes(token.value)) stack.push(at);
    else if (Object.hasOwn(closes, token.value)) {
      const start = stack.pop();
      if (start !== undefined && tokens[start].value === closes[token.value]) { out.set(start, at); out.set(at, start); }
    }
  });
  return out;
}

/** Numeric test configuration and third test/it argument, keyed by property or exact test title.
 * Only literal numbers count; expressions aren't interpreted or executed. */
function timeouts(tokens, pairs) {
  const out = new Map();
  const add = (key, token) => {
    if (token && isCode(token) && /^[0-9]/.test(token.value) && Number.isFinite(Number(token.value.replaceAll("_", "")))) {
      const list = out.get(key) ?? [];
      list.push({ number: Number(token.value.replaceAll("_", "")), line: token.line }); out.set(key, list);
    }
  };
  tokens.forEach((token, at) => {
    const key = token.kind === "string" ? token.value.slice(1, -1) : token.value;
    if (["testTimeout", "hookTimeout"].includes(key) && tokens[at + 1]?.value === ":") add(key, tokens[at + 2]);
    if (!isCode(token) || !["test", "it"].includes(token.value) || tokens[at + 1]?.value !== "(") return;
    const end = pairs.get(at + 1);
    if (end === undefined) return;
    let arg = 0;
    for (let j = at + 2; j < end; j++) {
      if (!isCode(tokens[j])) continue;
      if (["(", "[", "{"].includes(tokens[j].value) && pairs.has(j)) { j = pairs.get(j); continue; }
      if (tokens[j].value === "," && ++arg === 2 && (j + 2 === end || (j + 3 === end && tokens[j + 2].value === ","))) {
        const title = tokens[at + 2];
        add(`test:${title?.kind === "string" ? title.value.slice(1, -1) : title?.value}`, tokens[j + 1]);
      }
    }
  });
  return out;
}

function topFunctions(tokens, pairs) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!isCode(token)) continue;
    if (token.value === "function" && !["=", ":", "(", ","].includes(tokens[i - 1]?.value)
      && !(tokens[i - 1]?.value === "async" && tokens[i - 2]?.value === "=")) {
      const name = tokens[i + 1]?.value === "*" ? tokens[i + 2] : tokens[i + 1];
      if (name && wordStart(name.value[0])) out.push({ name: name.value, line: token.line });
    }
    // A top-level binding whose initializer is a function (including async arrows).
    if (["const", "let", "var"].includes(token.value)) {
      const name = tokens[i + 1];
      let assigned = false;
      let j = i + 2;
      for (; j < tokens.length; j++) {
        const value = tokens[j].value;
        if (value === ";") break;
        const functionExpression = value === "function" && (tokens[j - 1]?.value === "=" || (tokens[j - 1]?.value === "async" && tokens[j - 2]?.value === "="));
        // ASI declarations need no semicolon. Never rescan the remaining file for every const.
        if (["const", "let", "var", "export"].includes(value) || (value === "function" && !functionExpression)) break;
        if (value === "=") assigned = true;
        if (assigned && (value === "=>" || functionExpression)) { out.push({ name: name.value, line: token.line }); j++; break; }
        if (["(", "[", "{"].includes(value) && pairs.has(j)) j = pairs.get(j);
      }
      i = j - 1;
      continue;
    }
    if (["(", "[", "{"].includes(token.value) && pairs.has(i)) i = pairs.get(i);
  }
  return out;
}

/** Rust unit test modules and #[test]/#[tokio::test] bodies, including cfg(test) attributes. */
function rustTestRanges(tokens, pairs) {
  const ranges = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!sequence(tokens, i, ["#", "["])) continue;
    const end = pairs.get(i + 1);
    if (end === undefined) continue;
    const attr = tokens.slice(i + 2, end).map(t => t.value);
    if (!attr.includes("test")) continue;
    let j = end + 1;
    while (j < tokens.length && tokens[j].value !== "{" && tokens[j].value !== ";") j++;
    const close = pairs.get(j);
    if (close !== undefined) ranges.push([j, close]);
    i = end;
  }
  return ranges;
}

const jsPath = path => /\.(?:[cm]?[jt]sx?)$/.test(path);
/** Diff hunks only provide line membership; source comes from git blobs, so +++ inside a hunk is ordinary text. */
export function addedLines(diff) {
  const added = new Set();
  let line = 0, hunk = false;
  for (const raw of diff.split("\n")) {
    if (Buffer.byteLength(raw) > LINE_MAX + 1) { if (hunk && raw[0] === "+") added.add(line++); else if (hunk && raw[0] === " ") line++; continue; }
    if (raw.startsWith("@@ ")) {
      const plus = raw.indexOf("+");
      const digits = raw.slice(plus + 1).split(/[ ,]/, 1)[0];
      line = Number(digits); hunk = true; continue;
    }
    if (!hunk) continue;
    if (raw[0] === "+") added.add(line++);
    else if (raw[0] === " ") line++;
  }
  return added;
}

function raisedNumbers(before, after) {
  const raised = [], stack = [[before, after, "$"]];
  while (stack.length) {
    const [old, next, key] = stack.pop();
    if (typeof old === "number" && typeof next === "number" && next > old) raised.push(key);
    else if (old && next && typeof old === "object" && typeof next === "object") {
      for (const field of Object.keys(next)) if (Object.hasOwn(old, field)) stack.push([old[field], next[field], `${key}.${field}`]);
    }
  }
  return raised;
}

/** Pure rule contract. Files: {path,before,after,added:Set<number>}; messages: PR non-merge commits only.
 * all changes severity to report, never exit failure. Rules 3/6/7 need history even in inventory mode. */
export function checkFiles({ files, messages = [], all = false }) {
  const findings = [], trailers = [];
  for (const message of messages) {
    if (message.split("\n").some(line => Buffer.byteLength(line) > LINE_MAX)) continue;
    for (const trailer of parseTrailers(message).trailers) if (trailers.length < TRAILERS_MAX) trailers.push(trailer);
  }
  for (const file of files) {
    const { path, before = "", after = "", added = new Set() } = file;
    const now = lex(after, path.endsWith(".rs")), old = lex(before, path.endsWith(".rs")), ts = now.tokens, pairs = mates(ts);
    const workflowLines = path.startsWith(".github/workflows/") ? workflowShellLines(now.lines) : null;
    const shellAllowed = line => {
      if (!shellPath(path) || (workflowLines !== null && !workflowLines.has(line))) return false;
      const raw = now.lines[line - 1] ?? "", marker = raw.indexOf("# guard: allow ");
      return marker >= 0 && raw.slice(marker + 15).trim().length > 0;
    };
    const changed = line => all || added.has(line);
    // Constant-time changed-line lookup for nested calls; never rescan each enclosing call's full body.
    const nextChanged = new Int32Array(ts.length + 1);
    nextChanged[ts.length] = ts.length;
    for (let at = ts.length - 1; at >= 0; at--) nextChanged[at] = changed(ts[at].line) ? at : nextChanged[at + 1];
    const changedSpan = (start, end, fallback) => {
      const at = nextChanged[Math.max(0, start)] ?? ts.length;
      return at < end ? ts[at].line : fallback;
    };
    const seen = new Set();
    const emit = (rule, line, detail = "") => {
      if (!changed(line)) return;
      const key = `${rule}:${line}`;
      if (seen.has(key)) return;
      seen.add(key);
      findings.push({ rule, path, line, severity: all ? "report" : rule === 8 ? "warning" : "error", message: `${FIXES[rule]}${detail}` });
    };
    if (!(sourcePath(path) || shellPath(path) || ceilingPath(path) || path === "vitest.config.ts")) continue;
    for (const line of now.oversized) if (changed(line)) findings.push({ rule: 0, path, line, severity: all ? "report" : "error", message: "split this source line to at most 4 KiB so guard checks can inspect it whole" });
    const rustRanges = path.endsWith(".rs") ? rustTestRanges(ts, pairs) : [];
    const rustEvents = new Int32Array(ts.length + 1);
    for (const [start, end] of rustRanges) { rustEvents[start]++; rustEvents[end + 1]--; }
    const printEvents = new Int32Array(ts.length + 1);
    if (ciPath(path)) ts.forEach((token, at) => {
      const end = pairs.get(at + 1);
      if (sequence(ts, at, ["printed", "("]) && end !== undefined) { printEvents[at]++; printEvents[end + 1]--; }
    });
    let rustDepth = 0, printDepth = 0;
    ts.forEach((token, at) => {
      rustDepth += rustEvents[at];
      printDepth += printEvents[at];
      // CI scripts also carry shell commands as strings. A dynamic echo still prints untrusted values.
      if (ciPath(path) && printDepth === 0 && token.kind === "string" && /\becho\b/.test(token.value)
        && (token.value.includes("$") || ts[at + 1]?.value === "+")) emit(8, token.line);
      if (!isCode(token)) return;
      const line = token.line, value = token.value;
      let hitLine = line;
      const seq = (...values) => {
        const matched = sequence(ts, at, values);
        if (matched) hitLine = changedSpan(at, at + values.length, line);
        return matched;
      };
      if (sourcePath(path)) {
        const short = seq("if", "false") || seq("if", "(", "false", ")") || seq("&&", "false") || seq("debugger", ";")
          // Focused-test calls are JavaScript's; dbg!/todo! are Rust's. Each language's patterns only in its own files,
          // so a Rust helper named fit() is not a focused test.
          || (jsPath(path) && (seq(".", "only", "(") || (["fit", "fdescribe"].includes(value) && seq(value, "("))
            || (["describe", "it", "test"].includes(value) && seq(value, ".", "only"))))
          || (path.endsWith(".rs") && ["dbg", "todo"].includes(value) && seq(value, "!", "("));
        if (short) emit(1, hitLine);
      }
      if ((sourcePath(path) || shellPath(path)) && seq("||", "true")) {
        if (!shellAllowed(hitLine)) emit(1, hitLine, "; shell exceptions require # guard: allow <reason> on that shell command line");
      }
      if (testPath(path) && (["setTimeout", "sleep"].includes(value) && seq(value, "("))) {
        const raw = now.lines[hitLine - 1] ?? "", marker = raw.indexOf("// guard: bound ");
        if (!(marker >= 0 && raw.slice(marker + 16).trim().length > 0)) emit(2, hitLine);
      }
      if (path.endsWith(".rs")) {
        if ((path.startsWith("test/") || path.split("/").includes("tests") || rustDepth > 0)
          && (seq("std", "::", "env", "::", "set_var") || seq("std", "::", "env", "::", "remove_var"))) emit(4, hitLine);
        if (seq("libc", "::") && (ts[at + 2]?.value.startsWith("S_I") || ts[at + 2]?.value === "mode_t")) {
          let end = at + 3;
          while (ts[end]?.value === ")") end++;
          const directCast = sequence(ts, end, ["as", "u32"]), fromCast = sequence(ts, at - 4, ["u32", "::", "from", "("]);
          if (directCast || fromCast) {
            emit(5, changedSpan(fromCast ? at - 4 : at, directCast ? end + 2 : at + 3, line));
          }
        }
      }
      if (ciPath(path) && (seq("console", ".", "log", "(") || seq("echo", "("))) {
        const start = at + (value === "console" ? 4 : 2), end = pairs.get(start - 1);
        const argument = ts[start];
        const literal = argument?.kind === "string" && !argument.value.includes("${") && end === start + 1;
        const wrapped = sequence(ts, start, ["printed", "("]) && pairs.get(start + 1) === end - 1;
        if (!literal && !wrapped) emit(8, changedSpan(at, end === undefined ? at + 1 : end + 1, line));
      }
    });
    // Shell is deliberately line-based: its quoting/interpolation rules differ from TS and Rust.
    if (shellPath(path)) now.lines.forEach((raw, at) => {
      if (Buffer.byteLength(raw) > LINE_MAX) return;
      if (raw.includes("|| true")) {
        if (!shellAllowed(at + 1)) emit(1, at + 1, "; shell exceptions require # guard: allow <reason> on that shell command line");
      }
    });
    const previous = timeouts(old.tokens, mates(old.tokens)), current = timeouts(ts, pairs);
    for (const [key, values] of current) values.forEach((entry, at) => {
      const was = previous.get(key)?.[at];
      if (was && entry.number > was.number) emit(3, entry.line);
    });
    if (ceilingPath(path) && before !== "" && after !== "") {
      try {
        const raises = raisedNumbers(JSON.parse(before), JSON.parse(after));
        if (raises.length && !trailers.some(one => globMatches(one.pattern, path))) {
          const line = all ? 1 : [...added][0] ?? 1;
          emit(6, line, ` (${raises.join(", ")})`);
        }
      } catch { emit(6, all ? 1 : [...added][0] ?? 1, "; repair the ceiling JSON so its numeric changes can be compared"); }
    }
    if (ORDINAL_FILES.has(path)) {
      const previousFunctions = topFunctions(old.tokens, mates(old.tokens)), currentFunctions = topFunctions(ts, pairs);
      const names = new Set(previousFunctions.map(one => one.name));
      const last = currentFunctions.reduce((line, one) => names.has(one.name) ? Math.max(line, one.line) : line, 0);
      for (const one of currentFunctions) if (!names.has(one.name) && one.line < last) emit(7, one.line);
    }
  }
  return { ok: !findings.some(one => one.severity === "error"), findings };
}

/** Injectable read boundary lets the contract prove the head never supplies executable rules. */
export function readGuardInput(root, base, head, all = false, git = args => readGit(["-C", root], args, { PATH: process.env.PATH ?? "/usr/bin:/bin" })) {
  if (![base, head].every(sha => /^[0-9a-f]{40}$/.test(sha ?? ""))) throw Error("provide --base and --head as full commit ids");
  const from = git(["merge-base", base, head]).trim();
  if (!/^[0-9a-f]{40}$/.test(from)) throw Error("fetch the base and head history so their merge base can be read");
  const changes = parseChanges(git(["diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "--no-renames", "--name-status", "-z", from, head, "--"]));
  if (!changes) throw Error("fetch the complete diff so guard checks can inspect every changed file");
  const paths = all ? git(["ls-tree", "-r", "-z", "--name-only", head]).split("\0").filter(Boolean) : changes.filter(one => one.status !== "D").map(one => one.path);
  const exists = (rev, path) => git(["--literal-pathspecs", "ls-tree", "-z", "--name-only", rev, "--", path]) !== "";
  const files = [];
  for (const path of paths) {
    if (!(sourcePath(path) || shellPath(path) || ceilingPath(path) || path === "vitest.config.ts")) continue;
    const before = exists(from, path) ? git(["show", "--no-textconv", `${from}:${path}`]) : "";
    const after = git(["show", "--no-textconv", `${head}:${path}`]);
    const diff = all ? "" : git(["--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "--no-renames", "--unified=0", from, head, "--", path]);
    files.push({ path, before, after, added: addedLines(diff) });
  }
  const log = git(["log", "-z", "--no-merges", "--no-notes", "--no-show-signature", "--format=%B", `${base}..${head}`]);
  return { files, messages: log.split("\0").filter(Boolean), all };
}

/** All candidate-controlled paths and details are inside the command suppression block. */
export function printedGuards(verdict, token = randomBytes(16).toString("hex")) {
  const lines = verdict.findings.map(one => `${one.severity}: ${JSON.stringify(one.path)}:${one.line} rule ${one.rule}: ${one.message}`);
  return `::stop-commands::${token}\n${lines.join("\n") || "guard checks: no findings"}\n::${token}::\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), flag = name => { const at = args.indexOf(`--${name}`); return at < 0 ? undefined : args[at + 1]; };
  if (args[0] !== "check" && !args.includes("--all")) {
    process.stderr.write("usage: guard-checks.mjs check --root <checkout> --base <sha> --head <sha> [--all] [--summary <file>]\n"); process.exit(2);
  }
  try {
    const root = flag("root") ?? ".", all = args.includes("--all");
    const head = flag("head") ?? (all ? readGit(["-C", root], ["rev-parse", "--verify", "HEAD^{commit}"], { PATH: process.env.PATH ?? "/usr/bin:/bin" }).trim() : undefined);
    const base = flag("base") ?? (all ? head : undefined);
    const verdict = checkFiles(readGuardInput(root, base, head, all));
    const summary = flag("summary");
    if (summary) appendFileSync(summary, `### Guard checks\n\n${verdict.findings.length} findings; ${verdict.ok ? "advisory check passed" : "apply the fixes in the job log"}.\n`);
    process.stdout.write(printedGuards(verdict));
    process.exit(verdict.ok ? 0 : 1);
  } catch (error) {
    process.stdout.write(printedGuards({ findings: [{ severity: "error", path: "", line: 0, rule: 0, message: `restore readable base/head history and retry: ${String(error?.message ?? error).slice(0, 300)}` }] }));
    process.exit(1);
  }
}
