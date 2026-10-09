/**
 * A time a person reads. A desk shows the full stamp, as before; a phone (760px and narrower) shows the short
 * one — "16:39" today, "Yesterday 16:39", "Sep 28" otherwise — and the full stamp stays in the title. Stamps are
 * UTC to the minute, so the server counts in UTC; in the browser `localizeTimes` rewords each of these with the same
 * formatter in the viewer's own zone, as the React views do. The CSS that picks one lives in the shared page
 * stylesheet (`.so-when-*` in serve.ts).
 */
import { html, type Html } from "./html.js";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 86_400_000;

/** One `Intl.DateTimeFormat` per zone: building one is the slow part, and every time on a page shares a few zones. */
const formats = new Map<string, Intl.DateTimeFormat>();
function formatIn(zone: string): Intl.DateTimeFormat {
  let format = formats.get(zone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    formats.set(zone, format);
  }
  return format;
}

/** A stamp's calendar day, clock and month in a time zone ("UTC" on the server, the viewer's own zone in a browser). */
function partsIn(at: Date, zone: string): { year: number; month: number; day: number; clock: string } {
  const read = (z: string) => Object.fromEntries(formatIn(z).formatToParts(at).map(part => [part.type, part.value]));
  let parts: Record<string, string>;
  try { parts = read(zone); } catch { parts = read("UTC"); }
  return { year: Number(parts["year"]), month: Number(parts["month"]), day: Number(parts["day"]), clock: `${parts["hour"]}:${parts["minute"]}` };
}
const dayNumber = (p: { year: number; month: number; day: number }) => Math.floor(Date.UTC(p.year, p.month - 1, p.day) / DAY_MS);

/** The viewer's own time zone (a browser's); UTC where there is none to read. */
export function viewerZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

/** The one formatter for a time a person reads, on every surface: "16:39" today, "Yesterday 16:39" /
 * "Tomorrow 16:39" beside it, "Sep 28" otherwise ("Sep 28 2025" in another year), counted in `zone`. With `clock`,
 * a date further out keeps its time of day too ("Sep 28 16:39"), for deadlines and histories where the hour matters. */
export function shortWhen(iso: string, now: Date = new Date(), zone = "UTC", clock = false): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const then = partsIn(at, zone), today = partsIn(now, zone);
  const days = dayNumber(then) - dayNumber(today);
  if (days === 0) return then.clock;
  if (days === -1) return `Yesterday ${then.clock}`;
  if (days === 1) return `Tomorrow ${then.clock}`;
  const date = `${MONTHS[then.month - 1]} ${then.day}`;
  return `${then.year === today.year ? date : `${date} ${then.year}`}${clock ? ` ${then.clock}` : ""}`;
}

/** A flow card's deadline in the viewer's zone, always with its time of day: "No reply by 16:30" today,
 * "No reply by Tomorrow 16:30", "Moves on Oct 2 16:30" further out (a label's trailing " at" reads wrong before a date). */
export function deadlineWords(deadline: { at: string; label: string }, now: Date = new Date(), zone: string = viewerZone()): string {
  if (Number.isNaN(new Date(deadline.at).getTime())) return deadline.label;
  const words = shortWhen(deadline.at, now, zone, true);
  return /^(?:\d|Tomorrow|Yesterday)/.test(words) ? `${deadline.label} ${words}` : `${deadline.label.replace(/ at$/, "")} ${words}`;
}

/** How long ago, in one short mark: "now", "4m", "2h", "3d". A future stamp reads "now"; an unreadable one, "". */
export function shortAge(iso: string, now: Date = new Date()): string {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return "";
  const minutes = Math.max(0, Math.floor((now.getTime() - at) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** The exact minute in `zone` ("2026-09-30 16:39", with " UTC" when it is UTC): a time's title, one hover away. */
export function fullWhen(iso: string, zone = "UTC"): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const p = partsIn(at, zone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")} ${p.clock}${zone === "UTC" ? " UTC" : ""}`;
}

/** Every server-rendered stamp (`whenHtml`'s `<time data-when>`) inside `root`, reworded by the one formatter in the
 * viewer's zone: the same words on a desk and a phone, the exact minute in the title. An exact stamp
 * (`exactWhenHtml`'s `data-when="exact"`, the ledger's seconds) keeps its seconds, in the viewer's zone, and its
 * ISO title. The server's UTC words stay only without script. Times React writes and relative ages ("3 min ago")
 * carry no `data-when` and are never touched. */
export function localizeTimes(root: ParentNode, now: Date = new Date(), zone: string = viewerZone()): void {
  root.querySelectorAll<HTMLTimeElement>("time[data-when][datetime]").forEach(node => {
    const iso = node.getAttribute("datetime") ?? "";
    if (iso === "" || Number.isNaN(new Date(iso).getTime())) return;
    if (node.getAttribute("data-when") === "exact") {
      const words = exactWhen(iso, zone);
      if (node.textContent !== words) node.textContent = words;
      return;
    }
    const words = shortWhen(iso, now, zone), full = fullWhen(iso, zone);
    if (node.title !== full) node.title = full;
    if (node.textContent !== words) node.textContent = words;
  });
}

/** The exact second in `zone` ("2026-09-30 16:39:12", with " UTC" when it is UTC): an audit record's stamp. */
export function exactWhen(iso: string, zone = "UTC"): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const seconds = String(at.getUTCSeconds()).padStart(2, "0");
  const minute = fullWhen(iso, zone);
  return zone === "UTC" ? minute.replace(/ UTC$/, `:${seconds} UTC`) : `${minute}:${seconds}`;
}

/** The `<time>` for an exact stamp: its seconds in UTC words on the server, the viewer's zone in a browser. */
export function exactWhenHtml(iso: string): Html {
  return html`<time data-when="exact" datetime="${iso}" title="${iso}">${exactWhen(iso)}</time>`;
}

/** The `<time>` for a stamp: `full` is the words a desk shows ("2026-09-30 16:39 UTC"). Empty for no stamp. */
export function whenHtml(iso: string | null, full: string, now: Date = new Date()): Html {
  if (iso === null || iso === "") return html``;
  return html`<time data-when datetime="${iso}" title="${full}"><span class="so-when-full">${full}</span><span class="so-when-short">${shortWhen(iso, now)}</span></time>`;
}

/** "2026-09-30 16:39 UTC" — the desk's words for a stamp. */
export const utcMinute = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

/** Both the desk and phone forms of a UTC stamp. */
export const whenUtc = (iso: string | null, now: Date = new Date()): Html => iso === null || iso === "" ? html`` : whenHtml(iso, utcMinute(iso), now);
