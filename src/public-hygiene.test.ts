/**
 * The public tree names no real person's computer (docs/plans/public-release.md, slice 2). Every tracked text file is
 * read against a short rule table: home folders, macOS possessive computer names, `-localdomain` worker names and real
 * tailnet names. Git history keeps what it has; this guard holds the current tree. A path a fixture needs uses one of
 * the placeholder names below (or `~/`, `<you>`), never someone's real account.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The account names a home path may use. Generic placeholders and fixture people, plus three real system accounts:
 * `runner` (GitHub's macOS runners), `linuxbrew` (Homebrew on Linux) and `toolroll` (the team-server service user the
 * docs create). Anything else under /Users, /home or C:\Users is someone's real folder. */
const PLACEHOLDER_ACCOUNTS = new Set([
  "a", "b", "o", "me", "you", "someone", "nobody", "example", "fixture", "private", "check", "owner", "operator",
  "alex", "sam", "rosa",
  "runner", "linuxbrew", "toolroll",
]);
/** Fixture tailnets: these suffixes are made up. */
const PLACEHOLDER_TAILNETS = new Set(["tail1234", "tail0000"]);

type Rule = { name: string; pattern: RegExp; allowed?: (match: RegExpExecArray) => boolean };
const RULES: Rule[] = [
  { name: "home folder", pattern: /(?:\/(?:Users|home)\/|\b[A-Za-z]:\\{1,2}Users\\{1,2})([A-Za-z0-9._-]+)/g,
    allowed: match => PLACEHOLDER_ACCOUNTS.has(match[1]!) },
  { name: "computer name", pattern: /\b[A-Za-z]+s-?(?:mac-?(?:book|studio|mini|pro)|imac)\b/gi },
  // macOS's own spelling of a computer name, as Settings shows it: "Jane’s MacBook Pro", "Jane's Mac Studio".
  { name: "computer name", pattern: /\b[A-Za-z]+['’]s (?:MacBook|iMac|Mac (?:Studio|mini|Pro))\b/g },
  { name: "worker name", pattern: /\b[a-z0-9][a-z0-9-]*-localdomain\b/gi },
  { name: "tailnet name", pattern: /\b(tail[0-9a-f]{3,})\.ts\.net\b/gi, allowed: match => PLACEHOLDER_TAILNETS.has(match[1]!.toLowerCase()) },
];

function findings(text: string): string[] {
  return RULES.flatMap(rule => [...text.matchAll(rule.pattern)].filter(match => !(rule.allowed?.(match) ?? false)).map(match => `${rule.name}: ${match[0]}`));
}

/** Tracked text files: git's index, minus anything with a NUL byte near the start (images, archives, fonts). */
function trackedText(): { path: string; text: string }[] {
  const paths = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);
  return paths.flatMap(path => {
    let bytes: Buffer;
    try { bytes = readFileSync(join(ROOT, path)); } catch { return []; } // deleted in the working tree, not yet staged
    return bytes.subarray(0, 8000).includes(0) ? [] : [{ path, text: bytes.toString("utf8") }];
  });
}

test.each([
  ["/Users/jdoe/Developer/app", ["home folder: /Users/jdoe"]],
  ["HOME=/home/jdoe", ["home folder: /home/jdoe"]],
  ["C:\\\\Users\\\\jdoe\\\\app", ["home folder: C:\\\\Users\\\\jdoe"]],
  ["Janes-MacBook-Pro.local and janesmacstudio", ["computer name: Janes-MacBook", "computer name: janesmacstudio"]],
  ["Jane’s MacBook Pro and Jane's Mac Studio", ["computer name: Jane’s MacBook", "computer name: Jane's Mac Studio"]],
  ["worker janesmac-localdomain claimed it", ["worker name: janesmac-localdomain"]],
  ["https://box.tail9f3e2.ts.net", ["tailnet name: tail9f3e2.ts.net"]],
  // Placeholders, system accounts and fixture tailnets pass; so do a runner named after a product.
  ["/Users/someone/code /home/linuxbrew/.linuxbrew /Users/runner/work C:\\Users\\a ~/Projects <your-mac>", []],
  ["mac.tail1234.ts.net mac-studio studio-a.localdomain", []],
  // A person's Mac in prose is not a computer name.
  ["it runs on Alex's Mac, a Mac Studio", []],
])("the rule table on %j", (text, expected) => {
  expect(findings(text)).toEqual(expected);
});

test("no tracked text file names a real home folder, computer or tailnet", () => {
  const self = "src/public-hygiene.test.ts";
  const hits = trackedText().filter(file => file.path !== self).flatMap(file =>
    file.text.split("\n").flatMap((line, index) => findings(line).map(found => `${file.path}:${index + 1} ${found}`)));
  expect(hits).toEqual([]);
});
