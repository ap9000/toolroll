/**
 * The lead's voice, enforced: every chat surface (console, terminal, Telegram, Slack, Discord, Teams) runs a reply
 * through here before it is sent. The contract asks for plain text; this makes it so, without changing what the reply
 * says. Shaping is channel-neutral and idempotent — it yields a small canonical form (`**anchor**`, `[label](url)`,
 * `code`) — and each channel renders that form in its own format.
 *
 * - Markdown headers become plain lines.
 * - Bold stays on at most three short anchors; the rest is plain.
 * - Bare URLs become labelled links, named from their target: "the task", "the result", "Settings → Lead", else the host.
 * - Internal ids (run #12, digests, r1-style project ids) are removed unless the owner asked for them. When a reply names
 *   several of one kind (two runs, two projects), they stay: two items must never read the same.
 * - Runs of blank lines collapse to one.
 * Code (inline or fenced) is left exactly as written.
 */
import { html, joinHtml, type Html } from "./html.js";

export type ReplyChannel = "console" | "terminal" | "telegram" | "slack" | "discord" | "teams";
export type ShapeOptions = {
  /** The owner's message this reply answers: when it asks for ids, the ids stay. */
  asked?: string;
  /** This app's own origin (or origins: the console's address and its public one). Only a link there is named as the
   * app's page ("the task"); every other link is named by its real host, whatever label the model wrote, so a reply can
   * never dress a foreign link up as ours. */
  appOrigin?: string | readonly (string | null)[] | null;
};

export const BOLD_ANCHORS = 3;
/** A bold anchor is a few words, not a sentence. */
export const BOLD_ANCHOR_CHARS = 40;

const URL_CHARS = String.raw`https?:\/\/[^\s<>()\[\]"'\`]+`;
const LINK = new RegExp(String.raw`\[([^\]\n]{1,120})\]\((${URL_CHARS})\)`, "g");
const PROTECTED = new RegExp(String.raw`\x60\x60\x60[\s\S]*?(?:\x60\x60\x60|$)|\x60[^\x60\n]+\x60|\[[^\]\n]{1,120}\]\(${URL_CHARS}\)|<${URL_CHARS}>|${URL_CHARS}`, "g");
const HOLD = (index: number): string => `\u0000${index}\u0000`;

/** Did the owner ask for ids (an id, a digest, a hash, a run number or a project's r-number)? */
export function askedForIds(asked: string | undefined): boolean {
  if (asked === undefined) return false;
  return /\b(?:ids?|identifiers?|digests?|sha(?:256)?|hash(?:es)?|commit|turn\s*(?:#|number)|run\s*(?:#|numbers?|ids?)|r\d{1,3})\b|#\d+/i.test(asked);
}

/** Is this link on the app's own origin? Without a known origin, nothing is. */
function ownLink(url: string, appOrigin: ShapeOptions["appOrigin"]): boolean {
  if (appOrigin === null || appOrigin === undefined) return false;
  const origins = typeof appOrigin === "string" ? [appOrigin] : appOrigin;
  let target: string;
  try { target = new URL(url).origin; } catch { return false; }
  return origins.some(origin => {
    if (origin === null || origin === "") return false;
    try { return new URL(origin).origin === target; } catch { return false; }
  });
}

/** What a link is called, from where it goes: the app's own task, result and settings pages by name (only on `appOrigin`); anything else by host. */
export function linkLabel(url: string, appOrigin?: ShapeOptions["appOrigin"]): string {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return url; }
  if (!ownLink(url, appOrigin)) return parsed.hostname.replace(/^www\./, "");
  const path = parsed.pathname.replace(/\/+$/, "") || "/";
  const query = parsed.searchParams;
  if (query.has("result") || path === "/review" || /^\/results?(?:\/|$)/.test(path)) return "the result";
  if (/^\/t\/[^/]+$/.test(path) || (path === "/chat" && query.has("task")) || /^\/tasks?\/[^/]+$/.test(path)) return "the task";
  const settings = /^\/settings(?:\/([a-z-]+))?$/.exec(path);
  if (settings !== null) {
    const page = settings[1];
    if (page === undefined) return "Settings";
    return `Settings → ${page.split("-").map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(" ")}`;
  }
  return parsed.hostname.replace(/^www\./, "");
}

/** Trailing sentence punctuation (and an unmatched closing bracket) belongs to the prose, not the URL. */
function splitUrl(raw: string): { url: string; rest: string } {
  const match = /[.,;:!?'"]+$/.exec(raw);
  return match === null ? { url: raw, rest: "" } : { url: raw.slice(0, match.index), rest: match[0] };
}

/** One sentence-cased "the run" for an id-bearing mention of it. */
function theRun(match: string): string {
  return /^[A-Z]/.test(match) ? "The run" : "the run";
}

type IdKind = "run" | "project" | "digest";
const RUN_ID = /\b(run|turn)\s*#\s*(\d+)\b/gi;
const PROJECT_ID = /(?:^|[\s(])(r\d{1,3})\b(?![-\w/]|\.\w)/g;
const NAMED_DIGEST = /\b(?:digest|sha(?:256)?|hash|commit|revision|build)\b[ \t:=]*\b((?=[0-9a-f]*\d)[0-9a-f]{7,64})\b/gi;
const BARE_DIGEST = /\b((?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{16,64})\b/g;

/** The kinds of id a reply names more than one of: those stay, so two runs (or projects, or digests) never read the same. */
function severalIds(text: string): Set<IdKind> {
  const distinct = (pattern: RegExp, key: (match: RegExpMatchArray) => string): number =>
    new Set([...text.matchAll(pattern)].map(key)).size;
  const several = new Set<IdKind>();
  if (distinct(RUN_ID, one => `${one[1]!.toLowerCase()}${one[2]}`) > 1) several.add("run");
  if (distinct(PROJECT_ID, one => one[1]!.toLowerCase()) > 1) several.add("project");
  const digests = new Set([...text.matchAll(NAMED_DIGEST), ...text.matchAll(BARE_DIGEST)].map(one => one[1]!.toLowerCase()));
  if (digests.size > 1) several.add("digest");
  return several;
}

function dropIds(text: string, keep: Set<IdKind>): string {
  let body = text;
  // "(run #12)", "(r1)", "(digest 4f2a…)" — an aside that only carries the id goes entirely.
  if (!keep.has("run")) body = body
    .replace(/[ \t]*\((?:run|turn)\s*#\s*\d+\)/gi, "")
    // "the run #12", "run #12" → "the run".
    .replace(/\b(?:the\s+)?run\s*#\s*\d+\b/gi, theRun);
  if (!keep.has("digest")) body = body
    .replace(/[ \t]*\((?:(?:digest|sha(?:256)?|hash)?[\s:=]*[0-9a-f]{12,64})\)/gi, "")
    // "digest 4f2a…", "commit 4f2a…" — the thing stays named, its value goes: "the digest".
    .replace(/\b(?:the\s+)?(digest|sha(?:256)?|hash|commit|revision|build)\b[ \t:=]*\b(?=[0-9a-f]*\d)[0-9a-f]{7,64}\b/gi,
      (match: string, noun: string) => `${/^[A-Z]/.test(match) ? "The" : "the"} ${noun.toLowerCase()}`)
    // A bare long hex value with digits and letters is a digest.
    .replace(/[ \t]*\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{16,64}\b/g, "");
  if (!keep.has("project")) body = body
    .replace(/[ \t]*\(r\d{1,3}\)/gi, "")
    // "project r1", "r1" → "the project".
    .replace(/\b(?:the\s+)?project\s+r\d{1,3}\b(?![-\w/]|\.\w)/gi, match => /^[A-Z]/.test(match) ? "The project" : "the project")
    .replace(/(^|[\s(])r\d{1,3}\b(?![-\w/]|\.\w)/g, (_, before: string) => `${before}the project`);
  // Tidy what a removal left behind.
  return body
    .replace(/[ \t]+([,.;:!?)])/g, "$1")
    .replace(/[ \t]{2,}/g, " ");
}

/** What shaping one part of a reply shares with the rest: the bold anchors left, and which ids the whole reply keeps. */
type ShapeState = { boldLeft: number; keepIds: Set<IdKind> | "all" };

function limitBold(text: string, state: ShapeState): string {
  const anchor = (inner: string): string => {
    const words = inner.trim();
    if (words !== "" && words.length <= BOLD_ANCHOR_CHARS && state.boldLeft > 0) {
      state.boldLeft--;
      return `**${words}**`;
    }
    return inner;
  };
  return text
    .replace(/\*\*([^*\n]+?)\*\*/g, (_, inner: string) => anchor(inner))
    // Single-asterisk emphasis reads as bold in some apps: plain here.
    .replace(/(^|[^*\w])\*(?![\s*])([^*\n]*?[^\s*])\*(?![*\w])/g, "$1$2");
}

/** Code and links held aside so no rule rewrites inside them; a bare URL is labelled as it is held. */
function holdAside(text: string, options: ShapeOptions): { body: string; held: string[] } {
  const held: string[] = [];
  const body = text.replace(/\r\n?/g, "\n").replace(PROTECTED, (match: string) => {
    if (match.startsWith("`")) { held.push(match); return HOLD(held.length - 1); }
    if (match.startsWith("[")) {
      LINK.lastIndex = 0;
      const link = LINK.exec(match);
      if (link === null) { held.push(match); return HOLD(held.length - 1); }
      const { url, rest } = splitUrl(link[2]!);
      // The model's own words may name only our own pages; a foreign link always shows its real host.
      const label = /^https?:\/\//.test(link[1]!.trim()) || !ownLink(url, options.appOrigin) ? linkLabel(url, options.appOrigin) : link[1]!.trim();
      held.push(`[${label}](${url})`);
      return HOLD(held.length - 1) + rest;
    }
    const { url, rest } = splitUrl(match.startsWith("<") ? match.slice(1, -1) : match);
    held.push(`[${linkLabel(url, options.appOrigin)}](${url})`);
    return HOLD(held.length - 1) + rest;
  });
  return { body, held };
}

function stateFor(text: string, options: ShapeOptions): ShapeState {
  return { boldLeft: BOLD_ANCHORS, keepIds: askedForIds(options.asked) ? "all" : severalIds(holdAside(text, options).body) };
}

function shapeWith(text: string, options: ShapeOptions, state: ShapeState): string {
  const aside = holdAside(text, options);
  const held = aside.held;
  let body = aside.body;
  // Headers become plain lines: ATX ("## Next steps") and setext underlines.
  body = body
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/gm, "$1")
    .replace(/^[ \t]{0,3}#{1,6}[ \t]*$/gm, "")
    .replace(/^([^\n]*\S[^\n]*)\n[ \t]{0,3}=+[ \t]*$/gm, "$1")
    // A "* " bullet reads the same as "- ", and never as emphasis.
    .replace(/^([ \t]*)\*[ \t]+/gm, "$1- ");
  body = limitBold(body, state);
  if (state.keepIds !== "all") body = dropIds(body, state.keepIds);
  body = body
    .split("\n").map(line => line.replace(/[ \t]+$/, "")).join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return body.replace(/\u0000(\d+)\u0000/g, (_, index: string) => held[Number(index)] ?? "");
}

/**
 * The canonical shaped reply: plain lines, at most three bold anchors, labelled links, no internal ids unless asked
 * (or unless several of a kind would otherwise read the same), single blank lines. Idempotent: shaping a shaped reply
 * changes nothing.
 */
export function shapeReply(text: string, options: ShapeOptions = {}): string {
  return shapeWith(text, options, stateFor(text, options));
}

/** Where a long reply may be cut: never inside code, a link, a URL or a bold anchor; best at a paragraph, then a line,
 * then a space. Always past `from`, and never between the two halves of an emoji. */
function cutAt(text: string, from: number, size: number): number {
  const limit = from + Math.max(1, size);
  if (limit >= text.length) return text.length;
  const flags = PROTECTED.flags.includes("g") ? PROTECTED.flags : `${PROTECTED.flags}g`;
  const tokens = [...text.matchAll(new RegExp(String.raw`${PROTECTED.source}|\*\*[^*\n]+?\*\*`, flags))]
    .map(one => ({ start: one.index ?? 0, end: (one.index ?? 0) + one[0].length, url: !one[0].startsWith("`") && !one[0].startsWith("**") }));
  const inside = (at: number): boolean => tokens.some(token => token.start < at && at < token.end);
  for (const gap of [/\n\n/g, /\n/g, /[ \t]/g]) {
    let best = -1;
    for (const one of text.slice(from, limit).matchAll(gap)) {
      const at = from + (one.index ?? 0) + one[0].length;
      if (at > from && at <= limit && !inside(at)) best = at;
    }
    if (best > from) return best;
  }
  // No gap: cut before the token that crosses the limit. A link or URL longer than a whole part stays whole (cut, it
  // would no longer go where it says); only code or plain text longer than a part is cut at the limit itself.
  const crossing = tokens.find(token => token.start < limit && limit < token.end);
  if (crossing !== undefined && crossing.start > from) return crossing.start;
  if (crossing !== undefined && crossing.url) return crossing.end;
  let end = limit;
  if (/[\uD800-\uDBFF]/.test(text[end - 1]!)) end = end - 1 > from ? end - 1 : end + 1;
  return end;
}

/**
 * A long reply split into parts of at most `size` characters, then each part shaped: the cut is made on the reply as
 * written, at a paragraph or line where possible and never inside code, a link or a bold anchor, so no part carries
 * half of one. The parts share one bold budget and one rule for ids, as if the reply were shaped whole. `measure` is
 * how long a shaped part is once the channel renders it (its own link and escape format): a part that renders past
 * `size` is cut again, smaller. Only a single link longer than a part can exceed it, and it is never cut.
 */
export function shapeReplyParts(text: string, size: number, options: ShapeOptions = {}, measure: (shaped: string) => number = shaped => shaped.length): string[] {
  const state = stateFor(text, options);
  const normal = text.replace(/\r\n?/g, "\n");
  const pieces = (part: string, at: number): string[] => {
    const out: string[] = [];
    for (let from = 0; from < part.length;) { const end = cutAt(part, from, at); out.push(part.slice(from, end)); from = end; }
    return out;
  };
  const raw = pieces(normal, size);
  const parts: string[] = [];
  while (raw.length > 0) {
    const part = raw.shift()!;
    const before = state.boldLeft;
    const shaped = shapeWith(part, options, state);
    const length = measure(shaped);
    // A labelled link or the channel's escapes can lengthen a part: cut that part again, smaller, and shape the pieces.
    if (length > size && part.length > 1) {
      const smaller = pieces(part, Math.max(1, Math.floor(part.length * size / length) - 1));
      if (smaller.length > 1) {
        state.boldLeft = before;
        raw.unshift(...smaller);
        continue;
      }
    }
    if (shaped !== "") parts.push(shaped);
  }
  return parts;
}

export type ReplyPiece =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; label: string; url: string };

/** A shaped reply as pieces: plain text, bold anchors, inline code and labelled links. Fenced code stays text. */
export function replyPieces(shaped: string): ReplyPiece[] {
  const pieces: ReplyPiece[] = [];
  const pattern = new RegExp(String.raw`(\x60\x60\x60[\s\S]*?(?:\x60\x60\x60|$))|\x60([^\x60\n]+)\x60|\*\*([^*\n]+?)\*\*|\[([^\]\n]{1,120})\]\((${URL_CHARS})\)`, "g");
  let at = 0;
  for (const match of shaped.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > at) pieces.push({ kind: "text", text: shaped.slice(at, start) });
    if (match[1] !== undefined) pieces.push({ kind: "text", text: match[1] });
    else if (match[2] !== undefined) pieces.push({ kind: "code", text: match[2] });
    else if (match[3] !== undefined) pieces.push({ kind: "bold", text: match[3] });
    else pieces.push({ kind: "link", label: match[4]!, url: match[5]! });
    at = start + match[0].length;
  }
  if (at < shaped.length) pieces.push({ kind: "text", text: shaped.slice(at) });
  return pieces;
}

const slack = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
/** Discord's presentation syntax, escaped; mentions are broken so nothing pings. */
export const discordPlain = (text: string): string =>
  text.replace(/([\\`*_~|>#\[\]])/g, "\\$1").replace(/@/g, "@\u200b");
const teams = (value: string): string => value.replace(/([\\`*_\[\]<>#])/g, "\\$1");

/** One line of a shaped reply as console HTML (the console lays out paragraphs and lists itself). */
export function replyHtmlInline(shapedLine: string): Html {
  return joinHtml(replyPieces(shapedLine).map(piece =>
    piece.kind === "text" ? piece.text
      : piece.kind === "bold" ? html`<strong>${piece.text}</strong>`
        : piece.kind === "code" ? html`<code>${piece.text}</code>`
          : html`<a href="${piece.url}" rel="noopener noreferrer" target="_blank">${piece.label}</a>`));
}

/** A shaped reply in a channel's own text format (Telegram's formatting rides entities: see `telegramReply`). */
export function renderReply(shaped: string, channel: ReplyChannel): string {
  const pieces = replyPieces(shaped);
  switch (channel) {
    case "console":
      return pieces.map(piece => piece.kind === "link" ? `[${piece.label}](${piece.url})` : piece.kind === "bold" ? `**${piece.text}**` : piece.kind === "code" ? `\`${piece.text}\`` : piece.text).join("");
    case "slack":
      return pieces.map(piece =>
        piece.kind === "text" ? slack(piece.text)
          : piece.kind === "bold" ? `*${slack(piece.text)}*`
            : piece.kind === "code" ? `\`${slack(piece.text)}\``
              : `<${piece.url}|${slack(piece.label).replaceAll("|", "/")}>`).join("");
    case "discord":
      return pieces.map(piece =>
        piece.kind === "text" ? discordPlain(piece.text)
          : piece.kind === "bold" ? `**${discordPlain(piece.text)}**`
            : piece.kind === "code" ? `\`${piece.text}\``
              : `[${discordPlain(piece.label)}](${piece.url})`).join("");
    case "teams":
      // Teams' markdown keeps a single newline only as a paragraph break.
      return pieces.map(piece =>
        piece.kind === "text" ? teams(piece.text).replace(/\n+/g, "\n\n")
          : piece.kind === "bold" ? `**${teams(piece.text)}**`
            : piece.kind === "code" ? `\`${piece.text}\``
              : `[${teams(piece.label)}](${piece.url})`).join("");
    case "telegram":
    case "terminal":
      return pieces.map(piece => piece.kind === "link" ? `${piece.label} (${piece.url})` : piece.kind === "code" ? `\`${piece.text}\`` : piece.text).join("");
  }
}

export type TelegramEntity =
  | { type: "bold" | "code"; offset: number; length: number }
  | { type: "text_link"; offset: number; length: number; url: string };

/** A shaped reply for Telegram: plain text plus entities (bold anchors, code, labelled links). Offsets are UTF-16, as JS strings are. */
export function telegramReply(shaped: string): { text: string; entities: TelegramEntity[] } {
  let text = "";
  const entities: TelegramEntity[] = [];
  for (const piece of replyPieces(shaped)) {
    const offset = text.length;
    if (piece.kind === "text") { text += piece.text; continue; }
    const shown = piece.kind === "link" ? piece.label : piece.text;
    text += shown;
    entities.push(piece.kind === "link" ? { type: "text_link", offset, length: shown.length, url: piece.url } : { type: piece.kind, offset, length: shown.length });
  }
  return { text, entities };
}

/** Shape and render in one step, for a surface that sends the reply as text. */
export function voiceReply(text: string, channel: ReplyChannel, options: ShapeOptions = {}): string {
  return renderReply(shapeReply(text, options), channel);
}

// ---- deliverables: a reply never claims an attachment the turn did not attach ----------------------------------

const DETERMINER = String.raw`(?:(?:the|a|an|your|my|this|that|these|those|both|two|three|\d+|new|latest|full|updated|requested|fresh|final)\s+){0,2}`;
/** Things that can only arrive attached: a reply's text can never be them. */
const ATTACHMENT_ONLY = String.raw`(?:screenshots?|screen\s?shots?|images?|pictures?|photos?|recordings?|videos?|pdfs?|zips?|attachments?|spreadsheets?|csvs?)`;
/** Things a reply can also list in its text (file names, log lines, a report's points). */
const LISTABLE = String.raw`(?:files?|logs?|reports?|diffs?|documents?|links?)`;
const NOUN = String.raw`(?:${ATTACHMENT_ONLY}|${LISTABLE})`;
/** Presented ("here's the …") these need an attachment or a link: a reply's text can never be one. */
const PRESENTED = String.raw`(?:${ATTACHMENT_ONLY}|links?|files?)`;
const SEND = String.raw`(?:\bi(?:'ve|’ve|\s+have)\s+(?:just\s+)?(?:attached|included|shared|uploaded|sent|enclosed)|\bi(?:'m|’m|\s+am)\s+(?:now\s+)?(?:attaching|sending|sharing|uploading|enclosing)|\bi(?:'ll|’ll|\s+will)\s+(?:now\s+)?(?:attach|send|share|upload|enclose)|^\s*(?:attaching|sending|sharing|uploading|enclosing))\s+(?:you\s+)?`;
/** A claim is an attachment noun plus a send verb, in one sentence. */
const CLAIMS = [
  // "I've attached the report", "I'm sending you the log", "I'll share the link", "Sending the file now".
  new RegExp(String.raw`${SEND}${DETERMINER}(${NOUN})\b`, "i"),
  // "The screenshot is attached", "Logs attached", "the report is enclosed".
  new RegExp(String.raw`\b(${NOUN})\s+(?:(?:is|are|was|were)\s+)?(?:attached|enclosed|uploaded|included\s+below)\b`, "i"),
  // "Here's the screenshot (of the payout page).", "Here's the link to the result.", "Below is the log file." — presenting
  // something only a link or attachment can carry, with nothing listed after it. A bare "Here's the report." can be the
  // reply's own text, so it is not one.
  new RegExp(String.raw`^\s*(?:here(?:'s|’s|\s+is|\s+are)|(?:attached|below)\s+(?:is|are))\s+${DETERMINER}(?:[\w-]+\s+)?(${PRESENTED})(?:\s+(?:of|for|to|from|showing)\s+[^:]+?)?[.!:]?\s*$`, "i"),
];

const SENTENCE = /(?<=[.!?])\s+/;
const LIST_LINE = /^\s*(?:[-*•]|\d{1,3}[.)])\s+\S|^\s*```/;

/** One sentence's claim, if it makes one: the words, and whether its noun is something the text could list. */
function claimOf(sentence: string): { words: string; listable: boolean; tail: string } | null {
  for (const claim of CLAIMS) {
    const found = claim.exec(sentence);
    if (found === null) continue;
    const end = (found.index ?? 0) + found[0].length;
    return { words: found[0].trim(), listable: new RegExp(String.raw`^${LISTABLE}$`, "i").test(found[1]!), tail: sentence.slice(end) };
  }
  return null;
}

/** The content a claim sentence lists itself: text after its colon ("…the files I changed: a.ts, b.ts"). */
function listedAfterColon(tail: string): string | null {
  const colon = /:\s*(\S[\s\S]*)$/.exec(tail);
  return colon === null ? null : colon[1]!;
}

type ClaimAt = { line: number; sentence: number; words: string; listed: boolean; tail: string };

/** Every claim in a reply, with whether the reply lists what it names (after a colon, or as the list that follows). */
function claimsIn(text: string): ClaimAt[] {
  const lines = text.split("\n");
  const out: ClaimAt[] = [];
  lines.forEach((line, lineIndex) => {
    const next = lines.slice(lineIndex + 1).find(one => one.trim() !== "");
    line.split(SENTENCE).forEach((sentence, sentenceIndex, sentences) => {
      const claim = claimOf(sentence);
      if (claim === null) return;
      const last = sentenceIndex === sentences.length - 1;
      const listed = claim.listable && (listedAfterColon(claim.tail) !== null || (last && /:\s*$/.test(sentence) && next !== undefined && LIST_LINE.test(next)));
      out.push({ line: lineIndex, sentence: sentenceIndex, words: claim.words, listed, tail: claim.tail });
    });
  });
  return out;
}

/**
 * The words in a reply that say something is being sent or attached ("I've attached the log", "here's the
 * screenshot"), or null. A claim needs an attachment noun and a send verb; one whose content the reply lists itself
 * ("I've included the files I changed: a.ts") is not a claim.
 */
export function deliverableClaim(text: string): string | null {
  return claimsIn(text).find(one => !one.listed)?.words ?? null;
}

/** Does the reply carry the thing itself: a link, or content quoted in a code block? */
export function replyCarriesDeliverable(text: string): boolean {
  return new RegExp(URL_CHARS).test(text) || /```[\s\S]+?```/.test(text);
}

export const NOTHING_ATTACHED = "I couldn't attach that to this reply.";

/** The reply without its claims of an attachment, said plainly once; whatever a claim listed stays; never the claim alone. */
export function dropDeliverableClaims(text: string): string {
  const claims = claimsIn(text).filter(one => !one.listed);
  let said = false;
  const lines = text.split("\n").map((line, lineIndex) => line.split(SENTENCE).map((sentence, sentenceIndex) => {
    const claim = claims.find(one => one.line === lineIndex && one.sentence === sentenceIndex);
    if (claim === undefined) return sentence;
    // Listed content is never dropped: it follows the plain words instead of the claim.
    const listed = listedAfterColon(claim.tail);
    if (listed !== null) { said = true; return `${NOTHING_ATTACHED.slice(0, -1)}: ${listed}`; }
    if (/:\s*$/.test(sentence)) { said = true; return `${NOTHING_ATTACHED.slice(0, -1)}:`; }
    if (said) return "";
    said = true;
    return NOTHING_ATTACHED;
  }).filter(sentence => sentence !== "").join(" "));
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() || NOTHING_ATTACHED;
}

/** The one repair step's words to the lead: attach it, or drop the claim. */
export function deliverableRepair(claim: string): string {
  return `Check before sending: your reply says "${claim.slice(0, 80)}", but nothing is attached or linked this turn. Attach it now with the right tool (get_result_images for screenshots, show_control for a page), or rewrite the reply without saying it is attached. Reply with the corrected message.`;
}
