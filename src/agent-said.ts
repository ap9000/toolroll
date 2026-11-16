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

/** CSI and OSC escape sequences, then every remaining control character but a newline or tab. */
const ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-_]/g;
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g;
/** An absolute path (a file at the root too, "/secret.txt"; a bare "/login" command stays), a home-relative or named-home
 * one ("~/x", "~sam/x"), or a drive path. */
const PATHS = /(^|[\s"'`(<[=:,])(?:(?:\/[^\s"'`)>\]/:,;]+){2,}\/?|\/[^\s"'`)>\]/:,;]*\.[^\s"'`)>\]/:,;]+|~[A-Za-z0-9._-]*\/[^\s"'`)>\]:,;]*|[A-Za-z]:[\\/][^\s"'`)>\]:,;]*)/g;
/** A web address's userinfo ("https://user:pass@") and its query and fragment (where tokens ride): hidden. */
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@"'`<>]+@/gi;
const URL_QUERY = /\b([a-z][a-z0-9+.-]*:\/\/[^\s?#"'`<>]*)[?#][^\s"'`<>]*/gi;

/** The cleaned tail of an agent's output: [] when nothing is left to say. */
export function agentSaidTail(text: string | null | undefined): string[] {
  if (text === null || text === undefined || text.trim() === "") return [];
  const plain = text.replace(ESCAPES, "").replace(/\r\n?/g, "\n").replace(/\t/g, " ").replace(CONTROLS, "");
  // A web address's userinfo, query and fragment hidden first, so the address itself survives the key scan's line rule.
  const addresses = plain.split("\n").map(line => line.replace(URL_USERINFO, "$1[hidden]@").replace(URL_QUERY, "$1?[hidden]")).join("\n");
  const redacted = redactSecretLines(addresses, scanForSecrets(addresses));
  const lines = redacted.split("\n")
    // A web address is never a folder on this computer: kept whole (its secrets hidden above) while paths are said as [path].
    .map(line => line.split(/(\b[a-z][a-z0-9+.-]*:\/\/\S*)/i).map((part, at) => at % 2 === 1 ? part : part.replace(PATHS, "$1[path]")).join(""))
    .map(line => line.replace(/\s+/g, " ").trim()).filter(line => line !== "");
  return lines
    .map(line => line.length <= AGENT_SAID_CHARS ? line : `${line.slice(0, AGENT_SAID_CHARS - 1).trimEnd()}…`)
    .filter(line => !privateWords(line))
    .slice(-AGENT_SAID_LINES);
}
