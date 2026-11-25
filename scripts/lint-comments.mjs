#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const SUPPORTED_EXTS = new Set([".swift", ".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const ALLOWED_DIRECTIVE = /^\s*\/\/\s*(?:swift-tools-version:|@ts-expect-error|@ts-nocheck|guard:\s*allow\b)/i;

function walk(target, out = []) {
  const full = resolve(target);
  const st = statSync(full, { throwIfNoEntry: false });
  if (!st) return out;
  if (st.isFile()) {
    if (SUPPORTED_EXTS.has(extname(full))) out.push(full);
    return out;
  }
  if (!st.isDirectory()) return out;
  for (const entry of readdirSync(full, { withFileTypes: true })) {
    if (entry.name === ".build" || entry.name === "node_modules" || entry.name === "dist" || entry.name === "build" || entry.name === ".git") {
      continue;
    }
    walk(join(full, entry.name), out);
  }
  return out;
}

export function scanComments(source, isSwift) {
  const comments = [];
  let i = 0;
  let line = 1;
  const n = source.length;

  const advance = count => {
    for (let k = 0; k < count && i < n; k++) {
      if (source[i] === "\n") line++;
      i++;
    }
  };

  function scanString(delim, hashes, multiline) {
    const esc = "\\" + "#".repeat(hashes);
    const interp = esc + "(";
    while (i < n) {
      if (source.startsWith(delim, i)) {
        advance(delim.length);
        return;
      }
      if (!multiline && source[i] === "\n") {
        advance(1);
        return;
      }
      if (isSwift && source.startsWith(interp, i)) {
        advance(interp.length);
        scanCode(")");
        continue;
      }
      if (source.startsWith(esc, i)) {
        advance(esc.length + 1);
        continue;
      }
      advance(1);
    }
  }

  function scanTemplateLiteral() {
    while (i < n) {
      if (source[i] === "`") {
        advance(1);
        return;
      }
      if (source[i] === "\\") {
        advance(2);
        continue;
      }
      if (source[i] === "$" && source[i + 1] === "{") {
        advance(2);
        scanCode("}");
        continue;
      }
      advance(1);
    }
  }

  function scanCode(stopChar) {
    let parenDepth = 0;
    let braceDepth = 0;

    while (i < n) {
      const ch = source[i];
      const next = source[i + 1];

      if (stopChar === ")") {
        if (ch === "(") {
          parenDepth++;
          advance(1);
          continue;
        }
        if (ch === ")") {
          if (parenDepth === 0) {
            advance(1);
            return;
          }
          parenDepth--;
          advance(1);
          continue;
        }
      }

      if (stopChar === "}") {
        if (ch === "{") {
          braceDepth++;
          advance(1);
          continue;
        }
        if (ch === "}") {
          if (braceDepth === 0) {
            advance(1);
            return;
          }
          braceDepth--;
          advance(1);
          continue;
        }
      }

      if (isSwift && ch === "#") {
        let hashes = 0;
        while (i + hashes < n && source[i + hashes] === "#") hashes++;
        if (source[i + hashes] === '"') {
          const triple = source[i + hashes + 1] === '"' && source[i + hashes + 2] === '"';
          const delim = (triple ? '"""' : '"') + "#".repeat(hashes);
          advance(hashes + (triple ? 3 : 1));
          scanString(delim, hashes, triple);
          continue;
        }
      }

      if (isSwift && ch === '"' && next === '"' && source[i + 2] === '"') {
        advance(3);
        scanString('"""', 0, true);
        continue;
      }

      if (ch === '"') {
        advance(1);
        scanString('"', 0, false);
        continue;
      }

      if (!isSwift && ch === "'") {
        advance(1);
        while (i < n && source[i] !== "'" && source[i] !== "\n") {
          if (source[i] === "\\") advance(2);
          else advance(1);
        }
        if (i < n && source[i] === "'") advance(1);
        continue;
      }

      if (!isSwift && ch === "`") {
        advance(1);
        scanTemplateLiteral();
        continue;
      }

      if (ch === "/" && next === "/") {
        const start = i;
        const startLine = line;
        while (i < n && source[i] !== "\n") i++;
        const text = source.slice(start, i);
        if (!ALLOWED_DIRECTIVE.test(text)) {
          comments.push({ start, end: i, line: startLine, text, kind: "line" });
        }
        continue;
      }

      if (ch === "/" && next === "*") {
        const start = i;
        const startLine = line;
        advance(2);
        let depth = 1;
        while (i < n && depth > 0) {
          if (isSwift && source[i] === "/" && source[i + 1] === "*") {
            depth++;
            advance(2);
          } else if (source[i] === "*" && source[i + 1] === "/") {
            depth--;
            advance(2);
          } else {
            advance(1);
          }
        }
        const text = source.slice(start, i);
        comments.push({ start, end: i, line: startLine, text, kind: "block" });
        continue;
      }

      advance(1);
    }
  }

  scanCode(null);
  return comments;
}

export function stripComments(source, isSwift) {
  const comments = scanComments(source, isSwift);
  if (comments.length === 0) return source;

  let out = "";
  let cursor = 0;
  for (const c of comments) {
    let start = c.start;
    let end = c.end;

    let lineStart = start;
    while (lineStart > cursor && (source[lineStart - 1] === " " || source[lineStart - 1] === "\t")) {
      lineStart--;
    }
    const atLineStart = lineStart === 0 || source[lineStart - 1] === "\n";
    let afterEnd = end;
    while (afterEnd < source.length && (source[afterEnd] === " " || source[afterEnd] === "\t")) {
      afterEnd++;
    }
    const atLineEnd = afterEnd >= source.length || source[afterEnd] === "\n";

    if (atLineStart && atLineEnd) {
      out += source.slice(cursor, lineStart);
      cursor = afterEnd < source.length && source[afterEnd] === "\n" ? afterEnd + 1 : afterEnd;
    } else if (c.kind === "line") {
      out += source.slice(cursor, lineStart);
      cursor = end;
    } else {
      out += source.slice(cursor, start);
      const needsSpace =
        start > 0 &&
        end < source.length &&
        /[A-Za-z0-9_$]/.test(source[start - 1]) &&
        /[A-Za-z0-9_$]/.test(source[end]);
      if (needsSpace) out += " ";
      cursor = end;
    }
  }
  out += source.slice(cursor);

  const lines = out.split("\n");
  const cleaned = [];
  let blankRun = 0;
  for (const raw of lines) {
    const trimmed = raw.replace(/[ \t]+$/g, "");
    if (trimmed === "") {
      if (cleaned.length === 0) continue;
      blankRun++;
      if (blankRun <= 1) cleaned.push("");
    } else {
      blankRun = 0;
      cleaned.push(trimmed);
    }
  }
  while (cleaned.length > 0 && cleaned[cleaned.length - 1] === "") cleaned.pop();
  return cleaned.join("\n") + (cleaned.length > 0 ? "\n" : "");
}

function lintDiff(baseRef, root) {
  const diff = execFileSync("git", ["diff", "--unified=0", `${baseRef}...HEAD`], { cwd: root, encoding: "utf8" });
  const findings = [];
  let currentFile = null;
  let newLine = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice(6);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (!currentFile || !SUPPORTED_EXTS.has(extname(currentFile))) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      const text = line.slice(1);
      const isSwift = extname(currentFile) === ".swift";
      const hits = scanComments(text, isSwift);
      for (const hit of hits) {
        findings.push({ file: currentFile, line: newLine, snippet: hit.text.slice(0, 80) });
      }
      newLine++;
    } else if (!line.startsWith("-")) {
      newLine++;
    }
  }
  return findings;
}

const args = process.argv.slice(2);
const fix = args.includes("--fix");
const diffIndex = args.indexOf("--diff");
const root = process.cwd();

if (diffIndex !== -1) {
  const baseRef = args[diffIndex + 1];
  if (!baseRef) {
    console.error("usage: node scripts/lint-comments.mjs --diff <git-ref>");
    process.exit(2);
  }
  const findings = lintDiff(baseRef, root);
  if (findings.length > 0) {
    for (const f of findings) {
      console.error(`${f.file}:${f.line}: comment not allowed: ${f.snippet}`);
    }
    console.error(`comment lint: ${findings.length} finding(s) in diff against ${baseRef}`);
    process.exit(1);
  }
  console.log(`comment lint: clean diff against ${baseRef}`);
  process.exit(0);
}

const targets = args.filter(a => a !== "--fix");
const paths = targets.length > 0 ? targets : ["mac/Sources", "mac/Tests"];
const files = paths.flatMap(p => walk(p));

let totalFindings = 0;
let fixedFiles = 0;

for (const file of files) {
  const src = readFileSync(file, "utf8");
  const isSwift = extname(file) === ".swift";
  if (fix) {
    const next = stripComments(src, isSwift);
    if (next !== src) {
      writeFileSync(file, next, "utf8");
      fixedFiles++;
    }
  } else {
    const hits = scanComments(src, isSwift);
    for (const hit of hits) {
      const rel = relative(root, file);
      const snippet = hit.text.replace(/\s+/g, " ").slice(0, 90);
      console.error(`${rel}:${hit.line}: comment not allowed: ${snippet}`);
      totalFindings++;
    }
  }
}

if (fix) {
  console.log(`comment lint: stripped comments in ${fixedFiles} of ${files.length} files`);
  process.exit(0);
}

if (totalFindings > 0) {
  console.error(`comment lint: ${totalFindings} comment(s) found across ${files.length} files (run \`npm run lint:comments:fix\` to remove)`);
  process.exit(1);
}

console.log(`comment lint: clean (${files.length} files)`);
