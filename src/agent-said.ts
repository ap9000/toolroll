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
 * ("\\server\x"), a home named by its variable ("$HOME/x", "${HOME}/x", "%USERPROFILE%\x", "%HOMEPATH%\x",
 * "$env:USERPROFILE\x"; never expanded), and a JSON-escaped one ("\/Users\/me"). A path runs to a space, a quote or
 * `)>],:;` and keeps every other character ("/opt/customer=Acme/ledger.txt" is one path); it splits only where another
 * rooted path starts, and paths glued together ("/a/b(C:\x") are one span, one "[path]".
 */
/** Where a path may start: the start of a line, or after one of these. */
const STARTS = String.raw`\s"'` + "`" + String.raw`(<[=:,`;
const START = `(^|[${STARTS}])`;
const ENDS = String.raw`\s"'` + "`" + String.raw`)>\]:,;`;
/** A home named by its variable, then a slash. */
const HOME_VARIABLE = String.raw`(?:\$HOME|\$\{HOME\}|%USERPROFILE%|%HOMEPATH%|\$env:USERPROFILE)[\\/]`;
/**
 * Where another rooted path starts inside one: a drive, a named home, a share with a name, or a home variable after a
 * character a path may start after (inside "customer$HOME.txt" it is only letters). Each is exactly a ROOTED form below,
 * so a path never stops where nothing takes over.
 */
const NEW_ROOT = String.raw`(?![A-Za-z]:[\\/]|~[A-Za-z0-9._-]*\/|\\\\(?![\\${ENDS}])|(?<=[${STARTS}])${HOME_VARIABLE})`;
const PART = `(?:${NEW_ROOT}[^${ENDS}/])`;
const TAIL = `(?:${NEW_ROOT}[^${ENDS}])`;
const ROOTED = [
  `(?:\\/${PART}+){2,}\\/?`,
  `\\/${PART}*\\.${PART}+`,
  `~[A-Za-z0-9._-]*\\/${TAIL}*`,
  `[A-Za-z]:[\\\\/]${TAIL}*`,
  `\\\\\\\\(?![\\\\${ENDS}])${TAIL}+`,
  `${HOME_VARIABLE}${TAIL}*`,
  `(?:\\\\\\/(?:${NEW_ROOT}[^${ENDS}/\\\\])+){2,}`,
].join("|");
const PATHS = new RegExp(`${START}((?:${ROOTED})+)`, "g");
const ROOTED_ANYWHERE = new RegExp(`(?:^|[^A-Za-z0-9])(?:${ROOTED})`);

/** The web addresses kept whole (their userinfo, query and fragment hidden): the network's own schemes. */
const NETWORK = /(\b(?:https?|wss?|ftp|ssh|git):\/\/[^\s"'`<>]*)/i;
/** Any other address ("file://", "vscode://", "s3://") names a folder on this computer as often as not: said as "[path]"
 * when anything after its scheme's "//" has a slash ("vscode:///Users/me/x", an empty host, is a local path). */
const OTHER_ADDRESS = /\b(?!(?:https?|wss?|ftp|ssh|git):\/\/)[a-z][a-z0-9+.-]*:\/\/([^\s"'`<>]*)/gi;
const otherAddress = (whole: string, rest: string): string => /[\\/]/.test(rest) ? "[path]" : whole;

/** What splits a line into words for the percent-escape check: a space, a quote, a backtick, an angle bracket. */
const WORDS = /([\s"'`<>]+)/;
const ESCAPED = /%[0-9A-Fa-f]{2}/;
/** The longest word whose percent escapes are decoded; a longer one holding an escape is said as "[path]", unread. */
const DECODE_AT_MOST = 2048;
/** A word holding a percent escape ("%2FUsers%2Fme"): decoded once (never again) and said as "[path]" when the decoded
 * text names a folder. Each word is tested on its own: no pattern rescans the line. */
function encodedWords(text: string): string {
  return text.split(WORDS).map((word, at) => {
    if (at % 2 === 1 || !ESCAPED.test(word)) return word;
    if (word.length > DECODE_AT_MOST) return "[path]";
    const decoded = word.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
    return ROOTED_ANYWHERE.test(` ${decoded}`) ? "[path]" : word;
  }).join("");
}

/** Only the tail of a long output is read: its last lines are what is kept. */
const READ_AT_MOST = 64 * 1024;
/** The longest line any pattern reads: a longer one keeps its end, after "… ". */
const LINE_AT_MOST = 4096;
/** A line whose start was cut: its first, partial word goes too (half a path is not a path the rule would see), and
 * "… " says something came before. Never empty. */
const cutStart = (line: string): string => `… ${line.replace(/^[^\s"'`<>]*[\s"'`<>]?/, "")}`;
const capped = (line: string): string => line.length <= LINE_AT_MOST ? line : cutStart(line.slice(-(LINE_AT_MOST - 2)));
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
  // The last READ_AT_MOST characters; a first line the read began inside keeps its end, after "… ".
  const sliced = text.length > READ_AT_MOST && text[text.length - READ_AT_MOST - 1] !== "\n";
  const tail = text.length <= READ_AT_MOST ? text : text.slice(-READ_AT_MOST);
  const plain = tail.replace(ESCAPES, "").replace(/\r\n?/g, "\n").replace(/\t/g, " ").replace(CONTROLS, "");
  // Every line at most LINE_AT_MOST before any pattern reads it.
  const bounded = plain.split("\n").map((line, at) => capped(at === 0 && sliced ? cutStart(line) : line));
  // A web address's userinfo, query and fragment hidden first, so the address itself survives the key scan's line rule.
  const addresses = bounded.map(line => line.replace(URL_USERINFO, "$1[hidden]@").replace(URL_QUERY, "$1?[hidden]")).join("\n");
  const redacted = redactSecretLines(addresses, scanForSecrets(addresses));
  const lines = redacted.split("\n")
    // A network address is never a folder on this computer: kept whole (its secrets hidden above) while paths are said
    // as [path]. It ends where its query does (a space, a quote or an angle bracket), so a path written right after it
    // is still a path. Any other scheme's address is path-checked.
    .map(line => line.replace(OTHER_ADDRESS, otherAddress).split(NETWORK)
      .map((part, at) => at % 2 === 1 ? part : encodedWords(part).replace(PATHS, "$1[path]")).join(""))
    .map(line => line.replace(/\s+/g, " ").trim()).filter(line => line !== "");
  return lines
    .map(shortened)
    .filter(line => !privateWords(line))
    .slice(-AGENT_SAID_LINES);
}
