/**
 * The one mark an integration shows wherever it appears: its logo
 * (brand-icons.ts) in a 32px tile, 28px on a phone; a letter in the same tile
 * when it has none (a custom tool, a service without a logo). Ink when
 * connected, muted otherwise. Server pages use brandMarkHtml; React uses
 * BrandMark (browser/brand-mark.tsx) with the same markup and BRAND_MARK_CSS.
 */
import { BRAND_ICONS, type BrandIconId } from "./brand-icons.js";

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

const e = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The mark, decorative (the name always sits beside it). */
export function brandMarkHtml(name: string, label: string, connected: boolean): string {
  const icon = brandIconFor(name);
  const inside = icon === null ? e(brandLetter(label))
    : `<svg viewBox="0 0 24 24" focusable="false"><path fill="currentColor" d="${BRAND_ICONS[icon].path}"/></svg>`;
  return `<span class="brand-mark" data-connected="${connected}"${icon === null ? " data-letter" : ""} aria-hidden="true">${inside}</span>`;
}

export const BRAND_MARK_CSS = `.brand-mark{box-sizing:border-box;flex:0 0 auto;width:32px;height:32px;border-radius:8px;display:inline-grid;place-items:center;background:var(--so-neutral-soft);color:var(--so-muted);font-style:normal;font-weight:600;font-size:15px;line-height:1}` +
  `.brand-mark svg{display:block;width:20px;height:20px}.brand-mark[data-connected="true"]{color:var(--so-ink)}` +
  `@media(max-width:760px){.brand-mark{width:28px;height:28px;font-size:14px}.brand-mark svg{width:18px;height:18px}}`;
