/**
 * What the agent said on its way out of a failed attempt, kept short and safe (the stranger test, round 2): the last
 * few lines of its own output, so a person reads the agent's words, not only Toolroll's summary of them.
 *
 * At most AGENT_SAID_LINES lines of at most AGENT_SAID_CHARS characters each; terminal escape sequences and other
 * control characters stripped; a folder on this computer (any absolute path) said as "[path]", a key-shaped line
 * hidden, and anything the outbound privacy rule (outbound-privacy.ts) would still refuse dropped whole.
 */
import { redactSecretLines, scanForSecrets } from "./evidence.js";
import { privateWords } from "./outbound-privacy.js";

export const AGENT_SAID_LINES = 8;
export const AGENT_SAID_CHARS = 200;

/** CSI and OSC escape sequences, then every remaining control character but a newline or tab, and every bidi control
 * (the Arabic letter mark too). */
const ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-_]/g;
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g;
/**
 * A folder on this computer, said as "[path]" whole: an absolute path (a file at the root too, "/secret.txt"; a bare
 * "/login" command stays), a home-relative or named-home one ("~/x", "~sam/x"), a drive ("C:\x"), a network share
 * ("\\server\x"), a home named by its variable ("$HOME/x", "${HOME}/x", "%USERPROFILE%\x"; never expanded), and a
 * JSON-escaped one ("\/Users\/me"). A path runs to a space, a quote or `)>],:;` and keeps every other character
 * ("/opt/customer=Acme/ledger.txt" is one path); it splits only where another rooted path starts, and paths glued
 * together ("/a/b(C:\x") are one span, one "[path]".
 */
const START = String.raw`(^|[\s"'` + "`" + String.raw`(<[=:,])`;
/** Where another rooted path starts: a drive, a home, a share, a home variable. */
const NEW_ROOT = String.raw`(?![A-Za-z]:[\\/]|~[A-Za-z0-9._-]*\/|\\\\|\$\{?HOME\b|%(?:USERPROFILE|HOMEPATH)%|\$env:USERPROFILE\b)`;
const ENDS = String.raw`\s"'` + "`" + String.raw`)>\]:,;`;
const PART = `(?:${NEW_ROOT}[^${ENDS}/])`;
const TAIL = `(?:${NEW_ROOT}[^${ENDS}])`;
const ROOTED = [
  `(?:\\/${PART}+){2,}\\/?`,
  `\\/${PART}*\\.${PART}+`,
  `~[A-Za-z0-9._-]*\\/${TAIL}*`,
  `[A-Za-z]:[\\\\/]${TAIL}*`,
  `\\\\\\\\${TAIL}+`,
  `(?:\\$HOME|\\$\\{HOME\\}|%USERPROFILE%|%HOMEPATH%|\\$env:USERPROFILE)[\\\\/]${TAIL}*`,
  `(?:\\\\\\/(?:${NEW_ROOT}[^${ENDS}/\\\\])+){2,}`,
].join("|");
const PATHS = new RegExp(`${START}((?:${ROOTED})+)`, "g");
/** A file address is a folder on this computer too, never a web address kept whole. */
const FILE_URL = /\bfile:\/\/[^\s"'`<>]*/gi;
/** A run holding a percent escape ("%2FUsers%2Fme"): decoded once (bounded, never again) and said as "[path]" when the
 * decoded text names a folder. */
const ENCODED = /[^\s"'`<>]*%[0-9A-Fa-f]{2}[^\s"'`<>]*/g;
const ROOTED_ANYWHERE = new RegExp(`(?:^|[^A-Za-z0-9])(?:${ROOTED})`);
function encodedFolder(run: string): string {
  if (run.length > 2048) return run;
  const decoded = run.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  return ROOTED_ANYWHERE.test(` ${decoded}`) ? "[path]" : run;
}
/** Only the tail of a long output is read: its last lines are what is kept. */
const READ_AT_MOST = 64 * 1024;
/** A web address's userinfo ("https://user:pass@") and its query and fragment (where tokens ride): hidden. */
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@"'`<>]+@/gi;
const URL_QUERY = /\b([a-z][a-z0-9+.-]*:\/\/[^\s?#"'`<>]*)[?#][^\s"'`<>]*/gi;

/** A web address and its query or fragment (the second group), as the cleaning above leaves them. */
const ADDRESS_QUERY = /\b[a-z][a-z0-9+.-]*:\/\/[^\s?#"'`<>]*([?#][^\s"'`<>]*)?/gi;

/** A line cut to AGENT_SAID_CHARS with "…": never inside a web address's hidden query (cleaning the result again would
 * take the "…" for part of it), and never between the two halves of a character outside the BMP. */
function shortened(line: string): string {
  if (line.length <= AGENT_SAID_CHARS) return line;
  let end = AGENT_SAID_CHARS - 1;
  if (/[\ud800-\udbff]/.test(line[end - 1] ?? "")) end -= 1;
  let kept = line.slice(0, end).trimEnd();
  // A web address's query reaching the cut (cut inside it, or the cut's space trimmed): the cut moves before it.
  const last = [...kept.matchAll(ADDRESS_QUERY)].at(-1);
  if (last?.[1] !== undefined && last.index + last[0].length === kept.length) kept = kept.slice(0, kept.length - last[1].length).trimEnd();
  return `${kept}…`;
}

/** The cleaned tail of an agent's output: [] when nothing is left to say. */
export function agentSaidTail(text: string | null | undefined): string[] {
  if (text === null || text === undefined || text.trim() === "") return [];
  // A line cut by the read is dropped, never shown in part (half a path is not a path the rule would see).
  const tail = text.length <= READ_AT_MOST ? text : text.slice(-READ_AT_MOST).replace(/^[^\n]*\n?/, "");
  const plain = tail.replace(ESCAPES, "").replace(/\r\n?/g, "\n").replace(/\t/g, " ").replace(CONTROLS, "");
  // A web address's userinfo, query and fragment hidden first, so the address itself survives the key scan's line rule.
  const addresses = plain.split("\n").map(line => line.replace(URL_USERINFO, "$1[hidden]@").replace(URL_QUERY, "$1?[hidden]")).join("\n");
  const redacted = redactSecretLines(addresses, scanForSecrets(addresses));
  const lines = redacted.split("\n")
    // A web address is never a folder on this computer: kept whole (its secrets hidden above) while paths are said as [path].
    // It ends where its query does (a space, a quote or an angle bracket), so a path written right after it is still a path.
    // A file address is a path.
    .map(line => line.replace(FILE_URL, "[path]").split(/(\b(?!file:)[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>]*)/i)
      .map((part, at) => at % 2 === 1 ? part : part.replace(ENCODED, encodedFolder).replace(PATHS, "$1[path]")).join(""))
    .map(line => line.replace(/\s+/g, " ").trim()).filter(line => line !== "");
  return lines
    .map(shortened)
    .filter(line => !privateWords(line))
    .slice(-AGENT_SAID_LINES);
}
