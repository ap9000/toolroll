/**
 * A research report's items in a flow's message (flow-send.ts): after a report step, each item is listed under the
 * summary, numbered — its title in bold, its why in plain lines, and its link named by its source ("Mobbin", or the
 * site's name). Each screenshot of an item is captioned with the same number, its title and how it plugs in
 * (result-shots.ts), so "2." in the album is item 2 in the text.
 *
 * The message is written in reply-shape.ts's canonical form (`**bold**`, `[label](url)`), which every channel renders
 * in its own format. Its words go through the channel's own cleaner first. Fitted to a channel's limit, each why is
 * shortened evenly first; then the summary, then the titles; past that it is split into parts. Links are never cut.
 */

import type { FlowSendItem } from "./contracts/flow-send.js";

/** One item as the message lists it, and kept items read back (src/contracts/flow-send.ts). */
export type { FlowSendItem };
export { readFlowItems } from "./contracts/flow-send.js";

const PLUG_CHARS = 160;
const NAMES: Record<string, string> = {
  "mobbin.com": "Mobbin", "github.com": "GitHub", "figma.com": "Figma", "dribbble.com": "Dribbble", "behance.net": "Behance",
  "youtube.com": "YouTube", "linkedin.com": "LinkedIn", "producthunt.com": "Product Hunt", "pageflows.com": "Page Flows",
};

const cutTo = (text: string, cap: number) => cap <= 0 ? "" : text.length <= cap ? text : `${text.slice(0, Math.max(0, cap - 1)).trimEnd()}…`;
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** A link's source by name: a few known sites as they write themselves, else the site's own name from its address. */
export function itemSource(url: string): string {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return "Link"; }
  for (const [site, name] of Object.entries(NAMES)) if (host === site || host.endsWith(`.${site}`)) return name;
  const labels = host.split(".");
  if (labels.length < 2 || /^[0-9.]+$/.test(host) || host.includes(":")) return host;
  // "bbc.co.uk" is the BBC's; "developer.apple.com" is Apple's.
  const short = labels.length >= 3 && labels[labels.length - 1]!.length === 2 && labels[labels.length - 2]!.length <= 3;
  const name = labels[labels.length - (short ? 3 : 2)]!;
  return name === "" ? host : `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

/** A why as plain lines: its own lines, or "the pattern; why it fits us; how it plugs in" one to a line. */
export function whyLines(why: string): string[] {
  const lines = why.split(/\n+/).map(one => one.trim()).filter(one => one !== "");
  if (lines.length !== 1) return lines;
  const parts = lines[0]!.split(/;\s+/).map(one => one.trim()).filter(one => one !== "");
  return parts.length >= 2 && parts.length <= 4 ? parts.map(one => `${one.charAt(0).toUpperCase()}${one.slice(1)}`) : lines;
}

/** How an item plugs in, in one line: the why's last line when it has several, else the image's caption, else the why. */
export function itemPlug(why: string, imageCaption: string | null): string {
  const lines = whyLines(why);
  const words = lines.length >= 2 ? lines[lines.length - 1]! : imageCaption !== null && imageCaption.trim() !== "" ? imageCaption : lines.join(" ");
  return cutTo(oneLine(words), PLUG_CHARS);
}

/** A screenshot's caption: its item's number, title and how it plugs in. */
export function itemCaption(number: number, item: Pick<FlowSendItem, "title" | "plug">): string {
  return item.plug === "" ? `${number}. ${item.title}` : `${number}. ${item.title} · ${item.plug}`;
}

/** Plain words can't become bold or a link by accident. */
const inert = (text: string) => text.replace(/\*\*/g, "*").replace(/\]\(/g, "] (");
/** A link the canonical form keeps whole: the characters it stops at are written percent-encoded, as browsers read them. */
const linkable = (url: string) => url.replace(/[()[\]<>"'`\s]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);

export type FlowMessage = { head: string; summary: string; items: readonly FlowSendItem[]; tail: readonly string[] };

/** The message's own words through a channel's cleaner — head, summary, each title and why, and tail — before it is fitted. */
export function cleanFlowMessage(message: FlowMessage, clean: (text: string) => string): FlowMessage {
  return { head: clean(message.head), summary: clean(message.summary), items: message.items.map(item => ({ ...item, title: clean(item.title), why: clean(item.why) })),
    tail: message.tail.map(clean) };
}

function blocks(message: FlowMessage, whyCap: number, summaryCap: number, titleCap: number): string[] {
  const items = message.items.map((item, index) => {
    const title = cutTo(oneLine(item.title).replace(/\*/g, ""), titleCap);
    const why = cutTo(whyLines(item.why).join("\n"), whyCap);
    return [`${index + 1}. ${title === "" ? "" : `**${title}**`}`.trimEnd(), ...(why === "" ? [] : [inert(why)]), `[${item.source.replace(/[[\]]/g, "")}](${linkable(item.url)})`].join("\n");
  });
  return [inert(message.head), inert(cutTo(message.summary, summaryCap)), ...items, ...message.tail.map(inert)].filter(one => one.trim() !== "");
}

const compose = (message: FlowMessage, whyCap: number, summaryCap: number, titleCap: number) => blocks(message, whyCap, summaryCap, titleCap).join("\n\n");

/** The largest n in [0, high] that fits, or -1. */
function largest(high: number, fits: (n: number) => boolean): number {
  if (!fits(0)) return -1;
  let low = 0;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(mid)) low = mid; else high = mid - 1;
  }
  return low;
}

/** Whole pieces packed into as few parts as fit, joined by `glue`; a piece too long alone is broken by `smaller`. */
function pack(pieces: readonly string[], glue: string, fits: (text: string) => boolean, smaller: (piece: string) => string[]): string[] {
  const parts: string[] = [];
  let open = "";
  for (const piece of pieces.flatMap(one => fits(one) ? [one] : smaller(one))) {
    const joined = open === "" ? piece : `${open}${glue}${piece}`;
    if (open === "" || fits(joined)) open = joined;
    else { parts.push(open); open = piece; }
  }
  return open === "" ? parts : [...parts, open];
}

/** A line longer than a whole part, in the longest prefixes that fit (never splitting a surrogate pair). */
function chop(line: string, fits: (text: string) => boolean): string[] {
  const out: string[] = [];
  for (let rest = line; rest !== "";) {
    let at = Math.max(1, largest(rest.length, n => fits(rest.slice(0, n))));
    if (at < rest.length && /[\uD800-\uDBFF]/.test(rest[at - 1]!)) at = at > 1 ? at - 1 : at + 1;
    out.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  return out;
}

/**
 * The message in canonical form, as parts within `limit` as `measure` counts each once the channel renders it: one
 * whole part when it fits; else every why shortened to the same length; then the summary; then the titles. When the
 * head, links and tail alone are over the limit, the whole message goes in several parts instead, split between
 * blocks (else between lines). Every link stays.
 */
export function fitFlowMessage(message: FlowMessage, limit: number, measure: (shaped: string) => number): string[] {
  const fits = (text: string) => measure(text) <= limit;
  const full = compose(message, Infinity, Infinity, Infinity);
  if (fits(full)) return [full];
  const longest = Math.max(0, ...message.items.map(one => whyLines(one.why).join("\n").length));
  const why = largest(longest, n => fits(compose(message, n, Infinity, Infinity)));
  if (why >= 0) return [compose(message, why, Infinity, Infinity)];
  const summary = largest(message.summary.length, n => fits(compose(message, 0, n, Infinity)));
  if (summary >= 0) return [compose(message, 0, summary, Infinity)];
  const title = largest(Math.max(0, ...message.items.map(one => one.title.length)), n => fits(compose(message, 0, 0, n)));
  if (title >= 0) return [compose(message, 0, 0, title)];
  return pack(blocks(message, Infinity, Infinity, Infinity), "\n\n", fits, block => pack(block.split("\n"), "\n", fits, line => chop(line, fits)));
}

