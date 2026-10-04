/**
 * A research report's items in a flow's message (flow-send.ts): after a report step, each item is listed under the
 * summary, numbered — its title in bold, its why in plain lines, and its link named by its source ("Mobbin", or the
 * site's name). Each screenshot of an item is captioned with the same number, its title and how it plugs in
 * (result-shots.ts), so "2." in the album is item 2 in the text.
 *
 * The message is written in reply-shape.ts's canonical form (`**bold**`, `[label](url)`), which every channel renders
 * in its own format. Fitted to a channel's limit, each why is shortened evenly first; then the summary, then the
 * titles. Links are never cut.
 */

export type FlowSendItem = {
  title: string;
  why: string;
  url: string;
  /** Where the link goes, by name: "Mobbin", "Linear", "Apple". */
  source: string;
  /** One line: how it plugs in (from the why, else the image's own caption). */
  plug: string;
  /** The item's screenshot (its evidence id in the report's run), when it has one. */
  shot: number | null;
};

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

function compose(message: FlowMessage, whyCap: number, summaryCap: number, titleCap: number): string {
  const items = message.items.map((item, index) => {
    const title = cutTo(oneLine(item.title).replace(/\*/g, ""), titleCap);
    const why = cutTo(whyLines(item.why).join("\n"), whyCap);
    return [`${index + 1}. ${title === "" ? "" : `**${title}**`}`.trimEnd(), ...(why === "" ? [] : [inert(why)]), `[${item.source.replace(/[[\]]/g, "")}](${linkable(item.url)})`].join("\n");
  });
  return [inert(message.head), inert(cutTo(message.summary, summaryCap)), ...items, ...message.tail.map(inert)].filter(one => one.trim() !== "").join("\n\n");
}

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

/**
 * The message in canonical form, within `limit` as `measure` counts it once the channel renders it: whole when it
 * fits; else every why shortened to the same length; then the summary; then the titles. Every link stays.
 */
export function fitFlowMessage(message: FlowMessage, limit: number, measure: (shaped: string) => number): string {
  const fits = (text: string) => measure(text) <= limit;
  const full = compose(message, Infinity, Infinity, Infinity);
  if (fits(full)) return full;
  const longest = Math.max(0, ...message.items.map(one => whyLines(one.why).join("\n").length));
  const why = largest(longest, n => fits(compose(message, n, Infinity, Infinity)));
  if (why >= 0) return compose(message, why, Infinity, Infinity);
  const summary = largest(message.summary.length, n => fits(compose(message, 0, n, Infinity)));
  if (summary >= 0) return compose(message, 0, summary, Infinity);
  const title = largest(Math.max(0, ...message.items.map(one => one.title.length)), n => fits(compose(message, 0, 0, n)));
  return compose(message, 0, 0, Math.max(0, title));
}

/** Items read back from a kept content; anything malformed is left out. */
export function readFlowItems(raw: unknown): FlowSendItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((one): FlowSendItem[] => {
    if (typeof one !== "object" || one === null) return [];
    const item = one as Record<string, unknown>;
    const text = (key: string) => typeof item[key] === "string" ? item[key] as string : null;
    const [title, why, url, source, plug] = [text("title"), text("why"), text("url"), text("source"), text("plug")];
    if (title === null || why === null || url === null || source === null || plug === null || !/^https?:\/\//.test(url)) return [];
    return [{ title, why, url, source, plug, shot: typeof item["shot"] === "number" && Number.isSafeInteger(item["shot"]) ? item["shot"] : null }];
  });
}
