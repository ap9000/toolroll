/**
 * The one mark an integration shows wherever it appears: its logo
 * (brand-icons.ts) in a 32px tile, 28px once the tiles go to their phone
 * layout; a letter in the same tile when it has none (a custom tool, a service
 * without a logo). Ink when connected, muted otherwise. Where a row of plain
 * icons already stands (the Settings home), the logo is drawn as one of them:
 * brandIconHtml, or BrandIcon in React (browser/brand-mark.tsx).
 */
import { BRAND_ICONS, type BrandIcon, type BrandIconId } from "./brand-icons.js";
import { html, type Html } from "./html.js";

/** Service ids, catalog tool names and integration keys that differ from their icon's id. */
const ALIASES: Record<string, BrandIconId> = {
  atlassian: "jira", "chrome-devtools": "chrome", codex: "openai", "microsoft-teams": "teams", "better-stack": "betterstack",
};

/**
 * The icon for a service id, catalog tool name, chat app or integration key
 * ("telegram", "agent:codex", "mcp:<repo>:sentry"), or null for a letter.
 */
export function brandIconFor(name: string): BrandIconId | null {
  const key = name.toLowerCase().replace(/^agent:/, "").replace(/^mcp:.*:/, "");
  if (Object.hasOwn(BRAND_ICONS, key)) return key as BrandIconId;
  return ALIASES[key] ?? null;
}

/** The letter a mark without a logo shows. */
export function brandLetter(label: string): string {
  return (label.trim().match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase();
}

/** The logo alone, decorative: an svg its surroundings size and colour. */
export function brandIconHtml(id: BrandIconId): Html {
  const icon: BrandIcon = BRAND_ICONS[id];
  return html`<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true"><path fill="currentColor"${icon.evenodd && html` fill-rule="evenodd"`} d="${icon.path}"/></svg>`;
}

/**
 * The mark, decorative (the name always sits beside it). `name` null is a
 * letter whatever the label: a custom tool never borrows a logo by its name.
 */
export function brandMarkHtml(name: string | null, label: string, connected: boolean): Html {
  const icon = name === null ? null : brandIconFor(name);
  const inside = icon === null ? brandLetter(label) : brandIconHtml(icon);
  return html`<span class="brand-mark" data-connected="${String(connected)}"${icon === null && html` data-letter`} aria-hidden="true">${inside}</span>`;
}

/** Where the integration tiles (Settings → Tools) switch to their phone layout, and the mark with them. */
export const TILE_PHONE = "@media(max-width:600px)";

/** The mark's own sizes; `--brand-mark` is its side, for layouts that line up beside it. */
export const BRAND_MARK_CSS = `:root{--brand-mark:32px}${TILE_PHONE}{:root{--brand-mark:28px}}` +
  `.brand-mark{box-sizing:border-box;flex:0 0 auto;width:var(--brand-mark);height:var(--brand-mark);border-radius:8px;display:inline-grid;place-items:center;background:var(--so-neutral-soft);color:var(--so-muted);font-style:normal;font-weight:600;font-size:15px;line-height:1}` +
  `.brand-mark svg{display:block;width:calc(var(--brand-mark) * .625);height:calc(var(--brand-mark) * .625)}.brand-mark[data-connected="true"]{color:var(--so-ink)}` +
  `${TILE_PHONE}{.brand-mark{font-size:14px}}`;
